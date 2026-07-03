import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import { isValidPhoneNumber } from 'libphonenumber-js';
import prisma from '../lib/prisma.js';
import { parseDurationSeconds } from '../lib/parseDuration.js';
import { resolveUserUsageLimits, type UsageLimitSnapshot } from '../middleware/usageMeter.js';
import { marketFromAcceptLanguage } from './CurrencyService.js';
import { computeTierPeriod } from '../lib/tierPeriod.js';
import { getActiveBrand } from '../lib/brand.js';
import { renderVerificationEmail } from '../lib/verificationEmail.js';
import { assertBusinessEmail } from '../lib/emailDomainPolicy.js';
import { logger } from './LoggerService.js';

// User type matching Prisma schema
export interface User {
  id: string;
  email: string;
  passwordHash: string | null;
  name: string | null;
  phone: string | null;
  jobTitle: string | null;
  company: string | null;
  avatar: string | null;
  role: string;
  provider: string | null;
  providerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Subscription
  stripeCustomerId: string | null;
  subscriptionTier: string;
  subscriptionStatus: string;
  subscriptionId: string | null;
  currentPeriodEnd: Date | null;
  billingInterval: string | null;
  trialEnd: Date | null;
  interviewsUsed: number;
  resumeMatchesUsed: number;
  topUpBalance: number;
  // Per-user grace-period override (days). Null = global default. See
  // lib/subscriptionGraceConfig.ts. Optional here so demo/literal users
  // don't need to set it.
  subscriptionGraceDays?: number | null;
  customMaxInterviews?: number | null;
  customMaxMatches?: number | null;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

// Public user type (without password hash)
export type PublicUser = Omit<User, 'passwordHash' | 'customMaxInterviews' | 'customMaxMatches'> & Partial<UsageLimitSnapshot>;

// Types
export interface SignupData {
  email: string;
  password: string;
  name?: string;
  jobTitle?: string;
  company?: string;
  phone: string;
  // Raw Accept-Language header. Used only to derive `user.market` at
  // signup so per-market pricing (resume match / interview / agent run
  // overage) applies in the user's currency. See CurrencyService.
  acceptLanguage?: string | null;
}

export interface LoginData {
  email: string;
  password: string;
}

export interface OAuthProfile {
  provider: 'google' | 'github' | 'linkedin';
  providerId: string;
  email: string;
  name?: string;
  avatar?: string;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
  sessionToken: string;
  isNewUser?: boolean;
}

/** Returned by signup() when email verification is required: NO session, NO
 *  JWT, NO cookie are issued — the account is inert until the user proves inbox
 *  control via the confirmation link. The route must NOT set a cookie/token. */
export interface SignupVerificationPending {
  verificationRequired: true;
  email: string;
}

export type SignupResult = AuthResult | SignupVerificationPending;

export type VerifyEmailStatus = 'success' | 'already_verified' | 'invalid' | 'expired';

export interface VerifyEmailResult {
  status: VerifyEmailStatus;
  email?: string;
}

export interface TokenPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-in-production';
const JWT_EXPIRES_IN = parseDurationSeconds(process.env.JWT_EXPIRES_IN, 604800); // 7 days
const SESSION_EXPIRES_IN = parseDurationSeconds(process.env.SESSION_EXPIRES_IN, 2592000); // 30 days
const SALT_ROUNDS = 12;

// ── Email verification (signup confirmation) ─────────────────
// Per-recipient cooldown: refuse to regenerate+resend a confirmation email if
// the live token was issued less than this ago. Bounds inbox mailbombing by
// TARGET email regardless of source IP (the per-IP rate-limit is a coarse
// backstop). Persisted via emailVerificationExpiry on the row, not in memory.
const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

/** Read per-call so the kill switch applies without a restart. Fail-safe:
 *  ONLY the literal string 'false' disables the gate; unset/typo stays ENABLED. */
function emailVerificationEnabled(): boolean {
  return process.env.EMAIL_VERIFICATION_ENABLED !== 'false';
}

/** Confirmation-link lifetime in hours. Default 24h, clamped to [1, 168]. */
function emailVerificationTtlHours(): number {
  const raw = parseInt(process.env.EMAIL_VERIFICATION_TTL_HOURS || '24', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 24;
  return Math.min(raw, 168);
}

// Demo account for testing without database
const DEMO_USER: PublicUser = {
  id: 'demo-user-id',
  email: 'demo@robohire.io',
  name: 'Demo User',
  phone: null,
  jobTitle: null,
  company: 'RoboHire Demo',
  avatar: null,
  role: 'user',
  provider: 'email',
  providerId: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  stripeCustomerId: null,
  subscriptionTier: 'free',
  subscriptionStatus: 'active',
  subscriptionId: null,
  currentPeriodEnd: null,
  billingInterval: null,
  trialEnd: null,
  interviewsUsed: 0,
  resumeMatchesUsed: 0,
  topUpBalance: 0,
};
const DEMO_PASSWORD = 'demo1234';

// ── Password reset email i18n ───────────────────────────────
interface ResetEmailText {
  subject: string;
  heading: string;
  body: string;
  button: string;
  expiry: string;
}

const resetEmailTexts: Record<string, ResetEmailText> = {
  en: {
    subject: 'Reset your RoboHire password',
    heading: 'Reset Your Password',
    body: 'We received a request to reset the password for your RoboHire account. Click the button below to set a new password:',
    button: 'Reset Password',
    expiry: "This link expires in 1 hour. If you didn't request this, you can safely ignore this email.",
  },
  zh: {
    subject: '重置您的 RoboHire 密码',
    heading: '重置密码',
    body: '我们收到了重置您 RoboHire 帐户密码的请求。请点击下方按钮设置新密码：',
    button: '重置密码',
    expiry: '此链接将在 1 小时后失效。如果您没有发起此请求，可以放心忽略这封邮件。',
  },
  'zh-TW': {
    subject: '重設您的 RoboHire 密碼',
    heading: '重設密碼',
    body: '我們收到了重設您 RoboHire 帳戶密碼的請求。請點擊下方按鈕設定新密碼：',
    button: '重設密碼',
    expiry: '此連結將在 1 小時後失效。如果您沒有發起此請求，可以放心忽略這封郵件。',
  },
  ja: {
    subject: 'RoboHire パスワードのリセット',
    heading: 'パスワードをリセット',
    body: 'RoboHire アカウントのパスワードリセットリクエストを受け付けました。以下のボタンをクリックして新しいパスワードを設定してください：',
    button: 'パスワードをリセット',
    expiry: 'このリンクは 1 時間後に無効になります。リクエストした覚えがない場合は、このメールを無視してください。',
  },
  es: {
    subject: 'Restablece tu contraseña de RoboHire',
    heading: 'Restablece tu contraseña',
    body: 'Recibimos una solicitud para restablecer la contraseña de tu cuenta de RoboHire. Haz clic en el botón de abajo para establecer una nueva contraseña:',
    button: 'Restablecer contraseña',
    expiry: 'Este enlace caduca en 1 hora. Si no solicitaste esto, puedes ignorar este correo.',
  },
  fr: {
    subject: 'Réinitialisez votre mot de passe RoboHire',
    heading: 'Réinitialisez votre mot de passe',
    body: 'Nous avons reçu une demande de réinitialisation du mot de passe de votre compte RoboHire. Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe :',
    button: 'Réinitialiser le mot de passe',
    expiry: "Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, vous pouvez ignorer cet e-mail.",
  },
  pt: {
    subject: 'Redefina sua senha do RoboHire',
    heading: 'Redefinir senha',
    body: 'Recebemos uma solicitação para redefinir a senha da sua conta RoboHire. Clique no botão abaixo para definir uma nova senha:',
    button: 'Redefinir senha',
    expiry: 'Este link expira em 1 hora. Se você não solicitou isso, pode ignorar este e-mail com segurança.',
  },
  de: {
    subject: 'Setzen Sie Ihr RoboHire-Passwort zurück',
    heading: 'Passwort zurücksetzen',
    body: 'Wir haben eine Anfrage zum Zurücksetzen des Passworts für Ihr RoboHire-Konto erhalten. Klicken Sie auf die Schaltfläche unten, um ein neues Passwort festzulegen:',
    button: 'Passwort zurücksetzen',
    expiry: 'Dieser Link läuft in 1 Stunde ab. Wenn Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren.',
  },
};

function getResetEmailText(lang?: string): ResetEmailText {
  if (lang && resetEmailTexts[lang]) return resetEmailTexts[lang];
  // Handle variants like "zh-CN" → "zh", "pt-BR" → "pt"
  const base = lang?.split('-')[0];
  if (base && resetEmailTexts[base]) return resetEmailTexts[base];
  return resetEmailTexts.en;
}

class AuthService {
  // Short-TTL in-memory cache for getUserById to avoid DB round-trip on every request.
  // 30s TTL is safe: user profile data changes infrequently, and usage limits are
  // separately fetched by withUserUsageLimits in auth middleware.
  private userCache = new Map<string, { user: PublicUser; expiresAt: number }>();
  private static readonly USER_CACHE_TTL_MS = 30_000;

  /** Invalidate cached user entry (call after profile/subscription updates). */
  invalidateUserCache(userId: string): void {
    this.userCache.delete(userId);
  }

  private async buildPublicUser(user: User | PublicUser): Promise<PublicUser> {
    const usageLimits = await resolveUserUsageLimits(user);
    const {
      passwordHash: _passwordHash,
      customMaxInterviews: _customMaxInterviews,
      customMaxMatches: _customMaxMatches,
      ...userWithoutPrivateFields
    } = user as User;

    return {
      ...userWithoutPrivateFields,
      ...usageLimits,
    } as PublicUser;
  }

  /**
   * Hash a password
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Verify a password against a hash
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate a JWT token
   */
  generateToken(user: User): string {
    const payload: TokenPayload = {
      userId: user.id,
      email: user.email,
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Verify a JWT token
   */
  verifyToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
      return null;
    }
  }

  /**
   * Generate a random session token
   */
  generateSessionToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Create a session for a user
   */
  async createSession(userId: string): Promise<Session> {
    const token = this.generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN * 1000);

    return prisma.session.create({
      data: {
        userId,
        token,
        expiresAt,
      },
    });
  }

  /**
   * Validate a session token and return the user
   */
  async validateSession(sessionToken: string): Promise<User | null> {
    const session = await prisma.session.findUnique({
      where: { token: sessionToken },
      include: { user: true },
    });

    if (!session) {
      return null;
    }

    // Check if session has expired
    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { id: session.id } });
      return null;
    }

    return session.user;
  }

  /**
   * Invalidate a session
   */
  async invalidateSession(sessionToken: string): Promise<void> {
    await prisma.session.deleteMany({
      where: { token: sessionToken },
    });
  }

  /**
   * Invalidate all sessions for a user
   */
  async invalidateAllSessions(userId: string): Promise<void> {
    await prisma.session.deleteMany({
      where: { userId },
    });
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const result = await prisma.session.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });
    return result.count;
  }

  /**
   * Sign up a new user with email and password.
   *
   * When email verification is enabled (default), this creates the account as
   * `emailVerified=false`, sends a confirmation email, and returns
   * `{ verificationRequired: true }` WITHOUT issuing a session/JWT/cookie — the
   * account is inert until the user clicks the link, which is what blocks
   * throwaway/malicious signups. When the kill switch is off, it falls back to
   * the legacy auto-login behavior (creates the user already verified + a
   * session). See docs/design-spec-signup-email-verification.md.
   */
  async signup(data: SignupData): Promise<SignupResult> {
    const { email, password, name, jobTitle, company, phone, acceptLanguage } = data;
    const normalizedEmail = email.toLowerCase().trim();
    const verifyEnabled = emailVerificationEnabled();

    // Validate password strength
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters long');
    }

    // Validate phone number (server-side re-validation of the E.164 value)
    if (!phone || !isValidPhoneNumber(phone)) {
      throw new Error('Please enter a valid phone number');
    }

    // Company is required (was optional). Trim to reject whitespace-only.
    if (!company || !company.trim()) {
      throw new Error('Company is required');
    }

    // Business-email-only gate: reject free/personal/disposable providers
    // (no-op when BUSINESS_EMAIL_ONLY=false). Throws BUSINESS_EMAIL_REQUIRED.
    assertBusinessEmail(normalizedEmail);

    // Check if user already exists.
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      // Idempotent re-signup: if the existing account is an UNVERIFIED
      // email/password account, treat a repeat signup as "resend the link"
      // rather than a hard dead-end (the user likely lost the first email).
      // This also means the duplicate-email error below only fires for accounts
      // that can actually be signed into — so the UI's "sign in instead" works.
      if (verifyEnabled && existingUser.provider === 'email' && existingUser.emailVerified === false) {
        // The account is still inert (unverified), so let the most-recent
        // pre-verification signup win — persist the freshly typed password so a
        // user who re-signed up with a different password isn't silently stuck
        // with the original one after they confirm.
        await prisma.user.update({
          where: { id: existingUser.id },
          data: { passwordHash: await this.hashPassword(password) },
        });
        await this.issueVerification(existingUser.id, normalizedEmail, acceptLanguage ?? undefined);
        return { verificationRequired: true, email: normalizedEmail };
      }
      throw new Error('User with this email already exists');
    }

    // Create user
    const passwordHash = await this.hashPassword(password);
    // Derive the initial pricing market from the Accept-Language header
    // (CN/TW/JP/other). Admin can correct later; users can't self-switch
    // to prevent rate-arbitrage — see
    // docs/prd-multicurrency-overage-billing.md §6.3.
    const market = marketFromAcceptLanguage(acceptLanguage ?? null);
    // New users start a 14-day free trial with coherent period dates.
    const trial = computeTierPeriod('free', null);

    let user;
    try {
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          name,
          jobTitle,
          company,
          phone,
          provider: 'email',
          market,
          // When verification is enabled, the account is born unverified and
          // must confirm. When the kill switch is OFF, create it ALREADY
          // verified so re-enabling the gate later doesn't lock out the
          // off-window cohort (the @default(true) only grandfathers PRE-column
          // rows, not off-window signups).
          emailVerified: !verifyEnabled,
          subscriptionStatus: trial.subscriptionStatus,
          currentPeriodStart: trial.currentPeriodStart,
          currentPeriodEnd: trial.currentPeriodEnd,
          trialEnd: trial.trialEnd,
        },
      });
    } catch (err) {
      // Concurrent-signup race: two requests pass the existence check, one wins
      // the email @unique constraint (P2002). Map to the friendly message so the
      // duplicate-email UX is consistent under race.
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
        throw new Error('User with this email already exists');
      }
      throw err;
    }

    if (verifyEnabled) {
      // Send the confirmation email. NO session / JWT / cookie is issued.
      await this.issueVerification(user.id, normalizedEmail, acceptLanguage ?? undefined);
      return { verificationRequired: true, email: normalizedEmail };
    }

    // Kill switch OFF → legacy auto-login behavior.
    const session = await this.createSession(user.id);
    const token = this.generateToken(user);
    return {
      user: await this.buildPublicUser(user),
      token,
      sessionToken: session.token,
    };
  }

  /**
   * Generate + persist a fresh single-use verification token and send the
   * confirmation email. Per-recipient cooldown bounds inbox mailbombing.
   * Best-effort: a failed email send is logged but does not throw (the user can
   * resend). Issuing a new token invalidates any prior one (single live token).
   */
  private async issueVerification(userId: string, email: string, lang?: string): Promise<void> {
    const ttlHours = emailVerificationTtlHours();

    // Per-recipient cooldown: if a token was issued < cooldown ago, skip
    // regeneration + resend (caller still returns success → no enumeration, no
    // way to hammer a victim's inbox). Read the EXPLICIT issued-at so the bound
    // is independent of EMAIL_VERIFICATION_TTL_HOURS, which an admin can change.
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerificationIssuedAt: true },
    });
    if (
      current?.emailVerificationIssuedAt &&
      Date.now() - current.emailVerificationIssuedAt.getTime() < EMAIL_VERIFICATION_RESEND_COOLDOWN_MS
    ) {
      logger.info('AUTH', 'verification_email_cooldown', { email });
      return;
    }

    const now = Date.now();
    const raw = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationToken: hash,
        emailVerificationIssuedAt: new Date(now),
        emailVerificationExpiry: new Date(now + ttlHours * 60 * 60 * 1000),
      },
    });

    await this.sendVerificationEmail(email, raw, lang);
  }

  /** Render + send the brand-aware confirmation email. Dev fallback: when
   *  Resend isn't configured, log the link so the flow is testable locally. */
  private async sendVerificationEmail(email: string, rawToken: string, lang?: string): Promise<void> {
    const brand = getActiveBrand();
    // URL precedence APP_URL > PUBLIC_APP_URL > FRONTEND_URL > brand.canonicalHost.
    // Terminate at the per-brand canonicalHost (never a hardcoded robohire.io) so
    // a GoHire deploy with FRONTEND_URL unset can't mis-brand the link.
    const base = (
      process.env.APP_URL ||
      process.env.PUBLIC_APP_URL ||
      process.env.FRONTEND_URL ||
      brand.canonicalHost
    ).replace(/\/$/, '');
    const verifyUrl = `${base}/verify-email?token=${rawToken}`;
    const ttlHours = emailVerificationTtlHours();
    const rendered = renderVerificationEmail({ brand, verifyUrl, lang, ttlHours });

    const { emailService } = await import('./EmailService.js');
    if (!emailService.isConfigured) {
      logger.info('AUTH', 'verification_email_dev_link', { email, verifyUrl });
      return;
    }
    // Brand-aware From: keep the Resend-verified address, swap the display name.
    const configuredFrom = emailService.defaultFrom;
    const match = configuredFrom.match(/<([^>]+)>/);
    const address = match ? match[1].trim() : configuredFrom.trim();
    const from = address ? `${brand.emailFromName} <${address}>` : configuredFrom;

    const ok = await emailService.send({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from,
    });
    logger.info('AUTH', ok ? 'verification_email_sent' : 'verification_email_failed', { email });
  }

  /**
   * Redeem a confirmation token. Idempotent-friendly: an unknown token returns
   * `invalid` (the UI tells the user to just sign in if already verified); an
   * expired token returns `expired` (the UI offers resend). On success the token
   * is cleared (single-use). NO session is issued here — per product decision
   * the user is sent to the login page, which also means an email-scanner that
   * prefetches the link can only mark the account verified, never obtain a
   * session.
   */
  async verifyEmail(rawToken: string): Promise<VerifyEmailResult> {
    if (!rawToken || typeof rawToken !== 'string') return { status: 'invalid' };
    const hash = createHash('sha256').update(rawToken).digest('hex');

    const user = await prisma.user.findFirst({
      where: { emailVerificationToken: hash },
      select: { id: true, email: true, emailVerificationExpiry: true, emailVerified: true },
    });

    if (!user) return { status: 'invalid' };
    if (user.emailVerified) {
      return { status: 'already_verified', email: user.email };
    }
    if (!user.emailVerificationExpiry || user.emailVerificationExpiry.getTime() < Date.now()) {
      return { status: 'expired', email: user.email };
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
        emailVerificationExpiry: null,
        emailVerificationIssuedAt: null,
      },
    });
    this.invalidateUserCache(user.id);
    return { status: 'success', email: user.email };
  }

  /**
   * Resend the confirmation email. ALWAYS resolves without revealing whether the
   * email exists (no enumeration). Only sends for an existing UNVERIFIED
   * email/password account, subject to the per-recipient cooldown.
   */
  async resendVerification(email: string, lang?: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail) return;
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, provider: true, emailVerified: true },
    });
    if (!user || user.provider !== 'email' || user.emailVerified) return;
    await this.issueVerification(user.id, normalizedEmail, lang);
  }

  /**
   * Log in a user with email and password
   */
  async login(data: LoginData): Promise<AuthResult> {
    const { email, password } = data;

    // Find user in database
    let user;
    try {
      user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });
    } catch (dbError) {
      // Database not available, allow demo user fallback
      if (email.toLowerCase() === DEMO_USER.email && password === DEMO_PASSWORD) {
        const token = this.generateToken({ ...DEMO_USER, passwordHash: null } as any);
        const sessionToken = this.generateSessionToken();
        return { user: await this.buildPublicUser(DEMO_USER), token, sessionToken };
      }
      throw new Error('Invalid email or password');
    }

    if (!user) {
      throw new Error('Invalid email or password');
    }

    // Hard admin-disable gate. Reject before even checking the password
    // so a disabled user can't enumerate password validity. Frontend
    // catches the message and shows a generic suspended notice.
    if ((user as { isActive?: boolean }).isActive === false) {
      const err = new Error('Account suspended') as Error & { code?: string };
      err.code = 'ACCOUNT_DISABLED';
      throw err;
    }

    // Check if user has a password (might be OAuth user)
    if (!user.passwordHash) {
      throw new Error('This account uses social login. Please sign in with Google, GitHub, or LinkedIn.');
    }

    // Verify password
    const isValid = await this.verifyPassword(password, user.passwordHash);
    if (!isValid) {
      throw new Error('Invalid email or password');
    }

    // Email-verification gate. Placed AFTER successful password verification on
    // purpose: an attacker with a wrong password still gets the generic
    // "Invalid email or password" and cannot distinguish an unverified-existing
    // account from a nonexistent one (no enumeration / state oracle). Only
    // email/password accounts are gated — OAuth identities are auto-verified.
    if (
      emailVerificationEnabled() &&
      (user as { provider?: string | null }).provider === 'email' &&
      (user as { emailVerified?: boolean }).emailVerified === false
    ) {
      const err = new Error('Please verify your email address before signing in.') as Error & {
        code?: string;
        email?: string;
      };
      err.code = 'EMAIL_NOT_VERIFIED';
      err.email = user.email;
      throw err;
    }

    // Create session
    const session = await this.createSession(user.id);

    // Generate JWT
    const token = this.generateToken(user as any);

    return {
      user: await this.buildPublicUser(user as User),
      token,
      sessionToken: session.token,
    };
  }

  /**
   * Sign in or sign up with OAuth
   */
  async oauthLogin(profile: OAuthProfile): Promise<AuthResult> {
    const { provider, providerId, email, name, avatar } = profile;

    // Try to find existing user by provider ID
    let user = await prisma.user.findFirst({
      where: {
        provider,
        providerId,
      },
    });

    // If not found, try to find by email
    if (!user && email) {
      user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      // If user exists with no linked provider, link the OAuth identity onto it.
      if (user && !user.providerId) {
        // Security: OAuth proves control of this email, so mark it verified and
        // clear any pending token. CRITICAL — if the row was a pre-existing
        // UNVERIFIED email/password account, null out its passwordHash: an
        // attacker could have pre-seeded `victim@corp.com` with a known password
        // before the real owner ever OAuth'd in; the pre-set password must not
        // survive the merge (account-takeover primitive). The owner can later add
        // a password via "forgot password" (which accepts provider-linked,
        // null-hash accounts — see forgotPassword).
        const wasUnverifiedPasswordRow = user.emailVerified === false && !!user.passwordHash;
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            provider,
            providerId,
            avatar: avatar || user.avatar,
            name: name || user.name,
            emailVerified: true,
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            emailVerificationToken: null,
            emailVerificationExpiry: null,
            emailVerificationIssuedAt: null,
            ...(wasUnverifiedPasswordRow ? { passwordHash: null } : {}),
          },
        });
      }
    }

    // If still not found, create new user (OAuth → email is already verified).
    let isNewUser = false;
    if (!user) {
      // Business-email-only gate applies to NEW accounts only — a personal
      // Gmail via "Continue with Google" is still a personal email. Existing
      // users (found above) are grandfathered and never re-checked.
      assertBusinessEmail(email);
      const trial = computeTierPeriod('free', null);
      user = await prisma.user.create({
        data: {
          email: email.toLowerCase(),
          name,
          avatar,
          provider,
          providerId,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          subscriptionStatus: trial.subscriptionStatus,
          currentPeriodStart: trial.currentPeriodStart,
          currentPeriodEnd: trial.currentPeriodEnd,
          trialEnd: trial.trialEnd,
        },
      });
      isNewUser = true;
    }

    if ((user as { isActive?: boolean }).isActive === false) {
      const err = new Error('Account suspended') as Error & { code?: string };
      err.code = 'ACCOUNT_DISABLED';
      throw err;
    }

    // Create session
    const session = await this.createSession(user.id);

    // Generate JWT
    const token = this.generateToken(user);

    return {
      user: await this.buildPublicUser(user as User),
      token,
      sessionToken: session.token,
      isNewUser,
    };
  }

  /**
   * Get user by ID (with short-TTL in-memory cache to avoid DB round-trip per request)
   */
  async getUserById(id: string): Promise<PublicUser | null> {
    // Check cache first
    const cached = this.userCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.user;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id },
      });

      if (!user) {
        // Fallback to demo user if DB has no match
        if (id === DEMO_USER.id) return this.buildPublicUser(DEMO_USER);
        return null;
      }

      const publicUser = await this.buildPublicUser(user as User);
      this.userCache.set(id, {
        user: publicUser,
        expiresAt: Date.now() + AuthService.USER_CACHE_TTL_MS,
      });
      return publicUser;
    } catch {
      // Database not available, fallback to demo user
      if (id === DEMO_USER.id) return this.buildPublicUser(DEMO_USER);
      return null;
    }
  }

  /**
   * Update user profile
   */
  async updateProfile(
    userId: string,
    data: { name?: string; company?: string; avatar?: string; email?: string; phone?: string; jobTitle?: string }
  ): Promise<PublicUser> {
    const updateData: typeof data & {
      emailVerified?: boolean;
      emailVerifiedAt?: Date | null;
    } = { ...data };
    let reissueTo: string | null = null;

    // Email-of-record change must re-prove inbox control — otherwise the signup
    // verification gate is trivially bypassed (sign up + verify a throwaway, then
    // change the email to a victim's address while staying "verified"). For an
    // email/password account changing its email while the gate is on: normalize,
    // reset emailVerified=false, and re-issue a confirmation to the NEW address.
    if (typeof data.email === 'string') {
      const normalized = data.email.toLowerCase().trim();
      updateData.email = normalized;
      const existing = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, provider: true },
      });
      if (existing && normalized !== existing.email) {
        // Can't switch the email-of-record to a free/personal/disposable address.
        assertBusinessEmail(normalized);
        if (existing.provider === 'email' && emailVerificationEnabled()) {
          updateData.emailVerified = false;
          updateData.emailVerifiedAt = null;
          reissueTo = normalized;
        }
      }
    }

    let user;
    try {
      user = await prisma.user.update({ where: { id: userId }, data: updateData });
    } catch (err) {
      // Email @unique collision with another account.
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
        throw new Error('That email address is already in use.');
      }
      throw err;
    }

    if (reissueTo) {
      await this.issueVerification(userId, reissueTo);
    }

    this.invalidateUserCache(userId);
    return this.buildPublicUser(user as User);
  }

  /**
   * Change user password
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.passwordHash) {
      throw new Error('Cannot change password for this account');
    }

    const isValid = await this.verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    if (newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters long');
    }

    const passwordHash = await this.hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    // Invalidate all other sessions
    await this.invalidateAllSessions(userId);
  }

  /**
   * Initiate password reset — sends email with reset link
   * Always returns void to prevent email enumeration
   */
  async forgotPassword(email: string, lang?: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // Always return success to prevent email enumeration. Proceed for any real
    // account that CAN hold a password: one that already has a passwordHash, OR
    // an OAuth-linked account (providerId set) that currently has none — this
    // doubles as a "set a password" path, and is the documented recovery for an
    // account whose pre-seeded password was nulled during an OAuth merge.
    if (!user) return;
    if (!user.passwordHash && !user.providerId) return;

    // Generate a secure random token
    const { randomBytes: rb, createHash } = await import('node:crypto');
    const rawToken = rb(32).toString('hex');
    const hashedToken = createHash('sha256').update(rawToken).digest('hex');

    // Save hashed token + expiry (1 hour)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashedToken,
        passwordResetExpiry: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    // Send email with raw token (user receives unhashed version)
    const resetUrl = `${process.env.FRONTEND_URL || 'https://robohire.io'}/reset-password?token=${rawToken}`;
    const t = getResetEmailText(lang);
    const { emailService } = await import('./EmailService.js');
    await emailService.send({
      to: user.email,
      subject: t.subject,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #33465B; margin-bottom: 16px;">${t.heading}</h2>
          <p style="color: #46556A; line-height: 1.6;">${t.body}</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #3B84E2, #2F63E1); color: white; text-decoration: none; padding: 14px 32px; border-radius: 9999px; font-weight: 600; font-size: 15px;">${t.button}</a>
          </div>
          <p style="color: #46556A; font-size: 14px; line-height: 1.6;">${t.expiry}</p>
          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
          <p style="color: #9CA3AF; font-size: 12px;">RoboHire — AI-Powered Recruitment</p>
        </div>
      `,
    });
  }

  /**
   * Reset password using a token from the reset email
   */
  async resetPassword(token: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    if (!token || !newPassword || newPassword.length < 6) {
      return { success: false, error: 'Invalid token or password too short (minimum 6 characters)' };
    }

    const { createHash } = await import('node:crypto');
    const hashedToken = createHash('sha256').update(token).digest('hex');

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return { success: false, error: 'Invalid or expired reset token' };
    }

    const passwordHash = await this.hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpiry: null,
      },
    });

    return { success: true };
  }
}

export const authService = new AuthService();
export default authService;
