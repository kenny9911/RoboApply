// @vitest-environment node
//
// WP-10 acceptance on the LEGACY routes it owns (roboapply/routes/auth.ts)
// with the real SeekerAuthService on an in-memory Prisma:
//   - signup without `age_16_plus` → 422; new signup has onboardingStep
//     'account', brand + market stamped, consent rows, the session cookie,
//     a verification email, no V1 mission;
//   - signup with an other-brand email → the normal "check your email"
//     answer + a notice email (no 409);
//   - GoApply email signup (INT-01): invite mode needs a redeemable invite,
//     spent with the account; the agreement, the age confirmation and the
//     CN-0 cross-border consent are required and stored with the prose hash;
//   - login on the wrong brand → 409 with otherBrandUrl only after the
//     password matches, else invalid_credentials;
//   - /auth/me contract (additions present, `mission` dropped);
//   - frontend/backend session cookie names aligned; new-device email.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const h = vi.hoisted(() => ({ db: null as unknown, emails: [] as Array<{ template: string; to: string; brand: unknown }> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  const db = createFakePrisma({
    uniqueFields: { user: ['email'], rAAuthToken: ['tokenHash'], rABrandInvite: ['codeHash'] },
    defaults: { rABrandInvite: { uses: 0, expiresAt: null, note: null } },
  });
  h.db = db;
  return { default: db, prisma: db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../platform/email/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/email/index.js')>()),
  sendEmail: vi.fn(async (input: { template: string; to: string; brand: unknown }) => {
    h.emails.push({ template: String(input.template), to: input.to, brand: input.brand });
    return { status: 'sent' };
  }),
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: { cookies?: Record<string, string>; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    const db = h.db as { $rows: (m: string) => Array<Record<string, unknown>> };
    const session = db.$rows('session').find((s) => s.token === req.cookies?.ra_session_token);
    if (!session) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
    const user = db.$rows('user').find((u) => u.id === session.userId)!;
    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../roboapply/engine/middleware/seekerAuth.js', () => ({
  requireSeekerProfile: (_req: unknown, _res: unknown, next: () => void) => next(),
  seekerAuth: [],
}));
vi.mock('../../roboapply/engine/services/SeekerProfileService.js', () => ({ default: { getByUserId: vi.fn(async () => ({ id: 'p' })) } }));

import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { SESSION_COOKIE_NAME as FRONTEND_SESSION_COOKIE_NAME } from '../../../../lib/config.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import type { createFakePrisma } from '../../test/fakePrisma.js';
import { hashInviteCode } from '../auth-cn/inviteService.js';
import { CONSENT_PROSE_VERSION, consentProseHash } from '../compliance/consents.js';
import { getBrand } from '../../platform/brand/registry.js';
import { buildSignupPolicy } from '../auth-cn/signupPolicy.js';

type Fake = ReturnType<typeof createFakePrisma>;
const db = () => h.db as Fake;

const GO = 'goapply.localhost:3621';
const ROBO = 'localhost:3621';
const AGE = [{ type: 'age_16_plus', granted: true, proseVersion: 'v1' }];
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129.0 Safari/537.36';
const WIN = 'Mozilla/5.0 (Windows NT 10.0) Firefox/131.0';

let harness: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const router = (await import('../../roboapply/routes/auth.js')).default;
  harness = await startRouteHarness({ env: { NODE_ENV: 'development' }, mounts: [['/api/v1/roboapply/auth', router]] });
});

afterAll(async () => {
  setFlagOverrideLoader(null);
  await harness.close();
});

beforeEach(() => {
  for (const t of ['user', 'seekerProfile', 'seekerConsentRecord', 'session', 'rAAuthToken', 'roboApplyMission', 'userActivity', 'rABrandInvite', 'rAAttribution', 'rAProductEvent']) {
    db().$rows(t).length = 0;
  }
  h.emails.length = 0;
});

function signup(body: Record<string, unknown>, host = ROBO, headers: Record<string, string> = {}) {
  return harness.request<{ success: boolean; code?: string; data?: Record<string, unknown> }>('POST', '/api/v1/roboapply/auth/signup', {
    host,
    headers: { 'user-agent': MAC, ...headers },
    body,
  });
}

async function seedAccount(brand: string, password = 'right-pass-1') {
  db().$rows('user').push({
    id: `u-${brand}`,
    email: 'ana@example.test',
    brand,
    role: 'seeker',
    roles: ['seeker'],
    isActive: true,
    passwordHash: await bcrypt.hash(password, 4),
    subscriptionTier: 'free',
    market: 'other',
    name: null,
    emailVerified: true,
    seekerProfile: { id: 'p1', source: 'organic', readinessScore: 0, locale: 'en', deletedAt: null },
  });
  db().$rows('seekerProfile').push({ id: 'p1', userId: `u-${brand}`, locale: 'en', deletedAt: null, onboardingStep: 'done' });
}

describe('POST /auth/signup (WP-10)', () => {
  it('requires the age agreement: 422 and nothing written', async () => {
    const res = await signup({ email: 'new@example.test', password: 'abcdefg1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('age_consent_required');
    expect(db().$rows('user')).toEqual([]);
  });

  it('requires the PDPA notice for zh-TW and a password with a letter and a digit', async () => {
    expect((await signup({ email: 'n@example.test', password: 'abcdefg1', locale: 'zh-TW', consents: AGE })).body.code).toBe('pdpa_consent_required');
    expect((await signup({ email: 'n@example.test', password: 'abcdefgh', consents: AGE })).body.code).toBe('weak_password');
    expect((await signup({ email: 'n@example.test', password: 'abcdefg1', consents: AGE }, ROBO, { 'x-vercel-ip-country': 'TW' })).body.code).toBe(
      'pdpa_consent_required',
    );
  });

  it('creates the account at the account stage, brand-stamped, with consents, cookie and a verification email', async () => {
    const res = await signup(
      {
        email: 'New@Example.test',
        password: 'abcdefg1',
        locale: 'ja',
        timezone: 'Asia/Tokyo',
        marketingOptIn: false,
        consents: AGE,
        attribution: { from: 'job', jobId: 'cm1', action: 'apply', utmSource: 'newsletter' },
      },
      ROBO,
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ user: { email: 'new@example.test' } });
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    const user = db().$rows('user')[0]!;
    expect(user).toMatchObject({ brand: 'roboapply', role: 'seeker', roles: ['seeker'], emailVerified: false });
    expect(user.market).not.toBe('cn');
    expect(db().$rows('seekerProfile')[0]).toMatchObject({
      onboardingStep: 'account',
      onboardingVersion: 'v6-jobright',
      timezone: 'Asia/Tokyo',
      onboardingEntry: { from: 'job', jobId: 'cm1', action: 'apply', utmSource: 'newsletter' },
    });
    const consents = db().$rows('seekerConsentRecord').map((c) => [c.consentType, c.granted]);
    expect(consents).toEqual(expect.arrayContaining([['seeker_app_optin', true], ['age_16_plus', true], ['marketing_email', false]]));
    expect(db().$rows('roboApplyMission')).toEqual([]);
    expect(h.emails).toEqual([expect.objectContaining({ template: 'auth.email_verify', to: 'new@example.test' })]);
    // The first device is recorded silently.
    expect(db().$rows('rAAuthToken').filter((t) => t.kind === 'known_device')).toHaveLength(1);
  });

  // NOTE (H34, open owner decision): this answer (200 check_email, no session)
  // still differs from a new signup (201 + session) and from a same-brand
  // email (409), so cross-brand membership remains probable. Fully closing it
  // needs verify-before-create email signup. The acceptance criterion
  // "normal response" is therefore NOT met yet; this test pins today's
  // behaviour (no 409, no session, a notice to the inbox).
  it('an email held by the other brand: 200 check_email, no session, a notice to that inbox (no 409)', async () => {
    await seedAccount('goapply');
    const res = await signup({ email: 'ana@example.test', password: 'abcdefg1', consents: AGE }, ROBO);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'check_email' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(h.emails).toEqual([expect.objectContaining({ template: 'auth.other_brand_notice', to: 'ana@example.test' })]);
    expect(db().$rows('user')).toHaveLength(1);
  });

  it('an email already on this brand → 409 email_taken', async () => {
    await seedAccount('roboapply');
    const res = await signup({ email: 'ana@example.test', password: 'abcdefg1', consents: AGE }, ROBO);
    expect([res.status, res.body.code]).toEqual([409, 'email_taken']);
  });
});

describe('signup attribution and region through the route (INT-01)', () => {
  const ATTRIBUTION = { from: 'job', jobId: 'cm1', utmSource: 'newsletter', utmCampaign: 'spring', landingPath: '/signup' };
  const attributionOf = (email: string) => {
    const user = db().$rows('user').find((u) => u.email === email)!;
    return db().$rows('rAAttribution').find((r) => r.userId === user.id);
  };

  it('keeps the marketing fields and links the visitor id where linking is allowed (a visitor outside the EEA/UK/CH)', async () => {
    const res = await harness.request('POST', '/api/v1/roboapply/auth/signup', {
      host: ROBO,
      headers: { 'user-agent': MAC, 'x-vercel-ip-country': 'US' },
      cookies: { ra_anon: 'anon_visitor_0001' },
      body: { email: 'us@example.test', password: 'abcdefg1', consents: AGE, attribution: ATTRIBUTION },
    });
    expect(res.status).toBe(201);
    const row = attributionOf('us@example.test')!;
    expect(row.firstTouch).toMatchObject({ from: 'job', jobId: 'cm1', utmSource: 'newsletter', utmCampaign: 'spring', landingPath: '/signup' });
    expect(row.anonId).toBe('anon_visitor_0001');
  });

  it('drops them, and links nothing, before consent in the EEA; the job the visitor came for is kept', async () => {
    const res = await harness.request('POST', '/api/v1/roboapply/auth/signup', {
      host: ROBO,
      headers: { 'user-agent': MAC, 'x-vercel-ip-country': 'DE' },
      cookies: { ra_anon: 'anon_visitor_0002' },
      body: { email: 'de@example.test', password: 'abcdefg1', consents: AGE, attribution: ATTRIBUTION },
    });
    expect(res.status).toBe(201);
    const row = attributionOf('de@example.test')!;
    expect(Object.keys(row.firstTouch as object).sort()).toEqual(['at', 'jobId']);
    expect(row.anonId ?? null).toBeNull();
    // A body field can no longer name the visitor id: only the cookie, and only where allowed.
    const spoof = await harness.request('POST', '/api/v1/roboapply/auth/signup', {
      host: ROBO,
      headers: { 'user-agent': MAC, 'x-vercel-ip-country': 'DE' },
      body: { email: 'de2@example.test', password: 'abcdefg1', consents: AGE, attribution: { ...ATTRIBUTION, anonId: 'anon_spoofed_0003' } },
    });
    expect(spoof.status).toBe(201);
    expect(attributionOf('de2@example.test')!.anonId ?? null).toBeNull();
  });

  it("reads the client's stored first and last touch (`getAttribution()`) next to the page's own parameters", async () => {
    const earlier = new Date(Date.now() - 3 * 864e5).toISOString();
    const res = await harness.request('POST', '/api/v1/roboapply/auth/signup', {
      host: ROBO,
      headers: { 'user-agent': MAC, 'x-vercel-ip-country': 'US' },
      body: {
        email: 'touch@example.test',
        password: 'abcdefg1',
        consents: AGE,
        attribution: { from: 'job', jobId: 'cm1', firstTouch: { utmSource: 'google', landingPath: '/', at: earlier }, lastTouch: { from: 'job', jobId: 'cm1', at: new Date().toISOString() } },
      },
    });
    expect(res.status).toBe(201);
    const row = attributionOf('touch@example.test')!;
    expect(row.firstTouch).toMatchObject({ utmSource: 'google', landingPath: '/', at: earlier });
    expect(row.lastTouch).toMatchObject({ from: 'job', jobId: 'cm1' });
    // The entry stored on the profile is still this page's own parameters.
    expect(db().$rows('seekerProfile').at(-1)!.onboardingEntry).toEqual({ from: 'job', jobId: 'cm1' });
  });

  it('stores the edge country for the tips default at signup (once)', async () => {
    const res = await harness.request('POST', '/api/v1/roboapply/auth/signup', {
      host: ROBO,
      headers: { 'user-agent': MAC, 'x-vercel-ip-country': 'JP' },
      body: { email: 'jp@example.test', password: 'abcdefg1', consents: AGE },
    });
    expect(res.status).toBe(201);
    const profile = db().$rows('seekerProfile').at(-1)!;
    expect(JSON.stringify(profile.notificationPreferences)).toContain('"regionCountry":"JP"');
  });
});

describe('POST /auth/signup on GoApply (invite mode, CN-0 consents)', () => {
  // The test process has no CN_SIGNUP_MODE (→ invite, the default), no
  // DEPLOY_REGION (→ data is processed outside the mainland: CN-0) and is not
  // production (→ signup open).
  // What the form sends: every required consent of the sign-up policy with
  // the hash of the text shown beside its box (GET /auth/phone/policy).
  type Shown = Awaited<ReturnType<typeof buildSignupPolicy>>['requiredConsents'];
  const sentFrom = (shown: Shown) => shown.map((c) => ({ type: c.type, granted: true, proseVersion: 'whatever-the-client-says', proseHash: c.prose!.hash }));
  let SHOWN_ZH: Shown = [];
  let CN0: ReturnType<typeof sentFrom> = [];
  beforeAll(async () => {
    SHOWN_ZH = (await buildSignupPolicy(getBrand('goapply'), process.env, 'zh')).requiredConsents;
    CN0 = sentFrom(SHOWN_ZH);
  });
  const CODE = 'ABCDE-FGHJK';

  function seedInvite(over: Record<string, unknown> = {}) {
    db().$rows('rABrandInvite').push({ id: 'inv1', brand: 'goapply', codeHash: hashInviteCode(CODE), maxUses: 1, uses: 0, expiresAt: null, note: null, createdAt: new Date(), ...over });
  }
  const invite = () => db().$rows('rABrandInvite')[0]!;
  const go = (body: Record<string, unknown>) => signup({ email: 'xin@example.test', password: 'abcdefg1', locale: 'zh', ...body }, GO);

  it('no invite code → 422 invite_invalid (missing), nothing written', async () => {
    seedInvite();
    const res = await go({ consents: CN0 });
    expect([res.status, res.body.code]).toEqual([422, 'invite_invalid']);
    expect((res.body as { details?: { missing?: boolean } }).details).toEqual({ missing: true });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(db().$rows('user')).toEqual([]);
    expect(invite().uses).toBe(0);
  });

  it('a used, expired, unknown or other-brand invite → 422 invite_invalid, nothing written', async () => {
    seedInvite({ uses: 1 });
    expect((await go({ consents: CN0, inviteCode: CODE })).body.code).toBe('invite_invalid');
    invite().uses = 0;
    invite().expiresAt = new Date(Date.now() - 1000);
    expect((await go({ consents: CN0, inviteCode: CODE })).body.code).toBe('invite_invalid');
    invite().expiresAt = null;
    invite().brand = 'roboapply';
    expect((await go({ consents: CN0, inviteCode: CODE })).body.code).toBe('invite_invalid');
    expect((await go({ consents: CN0, inviteCode: 'ZZZZZ-ZZZZZ' })).body.code).toBe('invite_invalid');
    expect(db().$rows('user')).toEqual([]);
    expect(h.emails).toEqual([]);
  });

  it('a missing required consent → 422 consent_required naming it; the invite is not spent', async () => {
    seedInvite();
    const withoutCrossBorder = CN0.filter((c) => c.type !== 'pipl_cross_border');
    const res = await go({ consents: withoutCrossBorder, inviteCode: CODE });
    expect([res.status, res.body.code]).toEqual([422, 'consent_required']);
    expect((res.body as { details?: { missing?: string[] } }).details).toEqual({ missing: ['pipl_cross_border'] });
    // RoboApply's agreement alone is not enough either.
    const ageOnly = await go({ consents: AGE, inviteCode: CODE });
    expect((ageOnly.body as { details?: { missing?: string[] } }).details?.missing?.sort()).toEqual(['pipl_basic_processing', 'pipl_cross_border']);
    // A declined box counts as missing.
    const declined = await go({ consents: CN0.map((c) => (c.type === 'pipl_basic_processing' ? { ...c, granted: false } : c)), inviteCode: CODE });
    expect(declined.body.code).toBe('consent_required');
    expect(db().$rows('user')).toEqual([]);
    expect(invite().uses).toBe(0);
  });

  it('consents without the hash of the shown text, or with a stale one → 422 consent_required (outdated); nothing written, the invite is not spent', async () => {
    seedInvite();
    const bare = CN0.map(({ proseHash: _proseHash, ...c }) => c);
    const res = await go({ consents: bare, inviteCode: CODE });
    expect([res.status, res.body.code]).toEqual([422, 'consent_required']);
    expect((res.body as { details?: unknown }).details).toEqual({
      outdated: ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'],
      proseVersion: CONSENT_PROSE_VERSION,
    });
    const stale = CN0.map((c) => (c.type === 'pipl_cross_border' ? { ...c, proseHash: 'f'.repeat(64) } : c));
    expect((await go({ consents: stale, inviteCode: CODE })).body).toMatchObject({ code: 'consent_required', details: { outdated: ['pipl_cross_border'] } });
    // Not a hash at all: read as absent.
    const junk = CN0.map((c) => ({ ...c, proseHash: '<script>' }));
    expect((await go({ consents: junk, inviteCode: CODE })).body.code).toBe('consent_required');
    expect(db().$rows('user')).toEqual([]);
    expect(db().$rows('seekerConsentRecord')).toEqual([]);
    expect(invite().uses).toBe(0);
  });

  it('the English form: the records carry the hash of the English text that was shown', async () => {
    seedInvite();
    const shownEn = (await buildSignupPolicy(getBrand('goapply'), process.env, 'en')).requiredConsents;
    const res = await go({ consents: sentFrom(shownEn), inviteCode: CODE, locale: 'en' });
    expect(res.status).toBe(201);
    const rows = db().$rows('seekerConsentRecord');
    for (const shown of shownEn) {
      expect(shown.prose!.locale).toBe('en');
      expect(rows.find((r) => r.consentType === shown.type)!.proseHash).toBe(shown.prose!.hash);
      expect(shown.prose!.hash).not.toBe(SHOWN_ZH.find((c) => c.type === shown.type)!.prose!.hash);
    }
  });

  it('a valid invite and every required consent → 201: GoApply account, consent rows with the prose hash, invite spent', async () => {
    seedInvite();
    const res = await go({ consents: CN0, inviteCode: ' abcde-fghjk ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ user: { email: 'xin@example.test' }, next: '/onboarding/consent' });
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(db().$rows('user')[0]).toMatchObject({ brand: 'goapply', market: 'cn', role: 'seeker', emailVerified: false });
    expect(db().$rows('seekerProfile')[0]).toMatchObject({ onboardingStep: 'account', locale: 'zh', market: 'cn' });
    expect(invite().uses).toBe(1);

    const rows = db().$rows('seekerConsentRecord');
    const required = rows.filter((r) => ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'].includes(String(r.consentType)));
    expect(required.map((r) => r.consentType).sort()).toEqual(['age_16_plus', 'pipl_basic_processing', 'pipl_cross_border']);
    for (const r of required) {
      expect(r.granted).toBe(true);
      // The version and hash of the text the form showed; never the client's version string.
      expect(r.proseVersion).toBe(CONSENT_PROSE_VERSION);
      expect(String(r.proseHash)).toMatch(/^[0-9a-f]{64}$/);
      // The stored hash is the hash of the very string rendered beside the box.
      const shown = SHOWN_ZH.find((c) => c.type === r.consentType)!.prose!;
      expect(r.proseHash).toBe(consentProseHash({ brand: 'goapply', type: String(r.consentType), version: shown.version, locale: shown.locale, text: shown.text }));
    }
    // No marketing row was invented: GoApply's form has no such box.
    expect(rows.some((r) => r.consentType === 'marketing_email')).toBe(false);
    expect(h.emails).toEqual([expect.objectContaining({ template: 'auth.email_verify', to: 'xin@example.test' })]);

    // The single use is gone: a second person with the same code is refused.
    const second = await signup({ email: 'two@example.test', password: 'abcdefg1', consents: CN0, inviteCode: CODE }, GO);
    expect([second.status, second.body.code]).toEqual([422, 'invite_invalid']);
    expect(db().$rows('user')).toHaveLength(1);
  });

  it('an invite that stops being redeemable inside the transaction rolls the signup back (no account without an invite)', async () => {
    seedInvite();
    const { authCnService } = await import('../auth-cn/index.js');
    // Another signup spends the last use between the early check and the transaction.
    const spy = vi.spyOn(authCnService, 'isInviteRedeemable').mockImplementationOnce(async () => {
      invite().uses = 1;
      return true;
    });
    const res = await go({ consents: CN0, inviteCode: CODE });
    spy.mockRestore();
    expect([res.status, res.body.code]).toEqual([422, 'invite_invalid']);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(db().$rows('user')).toEqual([]);
    expect(db().$rows('session')).toEqual([]);
  });

  it('an email held by RoboApply still gets the "check your email" answer, and the invite is not spent', async () => {
    seedInvite();
    await seedAccount('roboapply');
    const res = await signup({ email: 'ana@example.test', password: 'abcdefg1', consents: CN0, inviteCode: CODE }, GO);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'check_email' });
    expect(invite().uses).toBe(0);
    expect(db().$rows('user')).toHaveLength(1);
  });

  it('login and /auth/me on the GoApply host: the legacy shapes, GoApply brand and its first onboarding screen', async () => {
    seedInvite();
    const created = await go({ consents: CN0, inviteCode: CODE });
    expect(created.status).toBe(201);
    // The in-memory database does not join relations: give the login read the profile it selects.
    const profileRow = db().$rows('seekerProfile')[0]!;
    db().$rows('user')[0]!.seekerProfile = { id: profileRow.id, source: 'organic', readinessScore: 0, locale: profileRow.locale, deletedAt: null };
    const login = await harness.request<{ success: boolean; data: Record<string, unknown> }>('POST', '/api/v1/roboapply/auth/login', {
      host: GO,
      headers: { 'user-agent': MAC, 'x-vercel-ip-country': 'CN' },
      body: { email: 'xin@example.test', password: 'abcdefg1' },
    });
    expect(login.status).toBe(200);
    // The legacy login response: exactly these keys.
    expect(Object.keys(login.body.data).sort()).toEqual(['seekerProfile', 'token', 'user']);
    expect(login.body.data.user).toMatchObject({ email: 'xin@example.test', role: 'seeker', market: 'cn' });
    const cookie = /ra_session_token=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]!;
    const me = await harness.request<{ data: Record<string, unknown> }>('GET', '/api/v1/roboapply/auth/me', {
      host: GO,
      cookies: { [SESSION_COOKIE_NAME]: decodeURIComponent(cookie) },
    });
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({
      user: { email: 'xin@example.test' },
      brand: { id: 'goapply', name: 'GoApply', market: 'cn' },
      onboarding: { step: 'account', completed: false, nextRoute: '/onboarding/consent' },
      onboardingState: { completed: false, completedSteps: [], skippedAt: null, autoOpens: 0 },
      emailVerified: false,
      // From the message centre (this brand's rows): a number, never a guess.
      unreadCount: 0,
    });
    expect(me.body.data).not.toHaveProperty('mission');
    // The same account is not usable on the RoboApply host.
    const other = await harness.request<{ code: string }>('POST', '/api/v1/roboapply/auth/login', { host: ROBO, body: { email: 'xin@example.test', password: 'abcdefg1' } });
    expect([other.status, other.body.code]).toEqual([409, 'account_other_brand']);
  }, 30_000);

  it('RoboApply signup is unchanged: no invite, no GoApply consents, no prose hash required', async () => {
    const res = await signup({ email: 'robo@example.test', password: 'abcdefg1', consents: AGE }, ROBO);
    expect(res.status).toBe(201);
    expect(db().$rows('user')[0]).toMatchObject({ brand: 'roboapply' });
    expect(db().$rows('seekerConsentRecord').map((c) => c.consentType).sort()).toEqual(['age_16_plus', 'marketing_email', 'seeker_app_optin']);
  });
});

describe('POST /auth/login', () => {
  it('other brand: 409 with otherBrandUrl only when the password matches', async () => {
    await seedAccount('roboapply');
    const wrong = await harness.request<{ code: string }>('POST', '/api/v1/roboapply/auth/login', { host: GO, body: { email: 'ana@example.test', password: 'nope-1234' } });
    expect([wrong.status, wrong.body.code]).toEqual([401, 'invalid_credentials']);
    const right = await harness.request<{ code: string; details: { otherBrandUrl: string } }>('POST', '/api/v1/roboapply/auth/login', {
      host: GO,
      body: { email: 'ana@example.test', password: 'right-pass-1' },
    });
    expect([right.status, right.body.code, right.body.details.otherBrandUrl]).toEqual([409, 'account_other_brand', 'https://www.roboapply.io/login']);
    expect(right.headers.get('set-cookie')).toBeNull();
  });

  it('emails on a new device, not on the first or a known one', async () => {
    await seedAccount('roboapply');
    const login = (ua: string) =>
      harness.request('POST', '/api/v1/roboapply/auth/login', { host: ROBO, headers: { 'user-agent': ua }, body: { email: 'ana@example.test', password: 'right-pass-1' } });
    expect((await login(MAC)).status).toBe(200);
    expect((await login(MAC)).status).toBe(200);
    expect(h.emails).toEqual([]);
    expect((await login(WIN)).status).toBe(200);
    expect(h.emails).toEqual([expect.objectContaining({ template: 'auth.new_device', to: 'ana@example.test' })]);
  });
});

describe('GET /auth/me contract', () => {
  it('returns the WP-10 additions and no V1 mission', async () => {
    const res = await signup({ email: 'me@example.test', password: 'abcdefg1', consents: AGE });
    const cookie = /ra_session_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
    const me = await harness.request<{ data: Record<string, unknown> }>('GET', '/api/v1/roboapply/auth/me', {
      host: ROBO,
      cookies: { [SESSION_COOKIE_NAME]: decodeURIComponent(cookie) },
    });
    expect(me.status).toBe(200);
    const data = me.body.data;
    expect(data).not.toHaveProperty('mission');
    expect(data).toMatchObject({
      user: { email: 'me@example.test' },
      brand: { id: 'roboapply', name: 'RoboApply', market: 'intl' },
      onboarding: { step: 'account', completed: false, nextRoute: '/onboarding/situation', path: null },
      emailVerified: false,
    });
    expect(data).toHaveProperty('entitlements');
    // The message centre's count for this brand (0 for a new account), not a raw row count.
    expect(data.unreadCount).toBe(0);
    // The legacy block keeps its shape without the V1 mission read.
    expect(data.onboardingState).toEqual({ completed: false, completedSteps: [], skippedAt: null, autoOpens: 0 });
    expect((data.flags as Record<string, unknown>)['auth.google']).toBe(false);
    expect((data.flags as Record<string, unknown>).hiringContacts).toBeDefined();
    expect((await harness.request('GET', '/api/v1/roboapply/auth/me', { host: ROBO })).status).toBe(401);
    // The first /auth/me loads the entitlement stack; allow for a busy machine.
  }, 30_000);

  it('frontend and backend session cookie names are aligned', () => {
    expect(SESSION_COOKIE_NAME).toBe('ra_session_token');
    expect(FRONTEND_SESSION_COOKIE_NAME).toBe(SESSION_COOKIE_NAME);
  });
});
