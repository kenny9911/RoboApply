// @vitest-environment node
//
// WP-10 acceptance on the LEGACY routes it owns (roboapply/routes/auth.ts)
// with the real SeekerAuthService on an in-memory Prisma:
//   - signup without `age_16_plus` → 422; new signup has onboardingStep
//     'account', brand + market stamped, consent rows, the session cookie,
//     a verification email, no V1 mission;
//   - signup with an other-brand email → the normal "check your email"
//     answer + a notice email (no 409);
//   - login on the wrong brand → 409 with otherBrandUrl only after the
//     password matches, else invalid_credentials;
//   - /auth/me contract (additions present, `mission` dropped);
//   - frontend/backend session cookie names aligned; new-device email.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const h = vi.hoisted(() => ({ db: null as unknown, emails: [] as Array<{ template: string; to: string; brand: unknown }> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  const db = createFakePrisma({ uniqueFields: { user: ['email'], rAAuthToken: ['tokenHash'] } });
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
vi.mock('../../roboapply/services/RoboApplyMissionService.js', () => ({ getMissionForUser: vi.fn(async () => null) }));

import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { SESSION_COOKIE_NAME as FRONTEND_SESSION_COOKIE_NAME } from '../../../../lib/config.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import type { createFakePrisma } from '../../test/fakePrisma.js';

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
  for (const t of ['user', 'seekerProfile', 'seekerConsentRecord', 'session', 'rAAuthToken', 'roboApplyMission', 'userActivity']) db().$rows(t).length = 0;
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
  it('GoApply email signup is closed until WP-93: 403 signup_closed, nothing written, no email', async () => {
    // Interim gate (Wave 2 integration): no invite redemption and no CN-0
    // pipl_cross_border consent on this path yet. Same answer whether or not
    // the email exists on either brand.
    for (const seeded of [false, true]) {
      if (seeded) await seedAccount('roboapply');
      const res = await signup(
        { email: seeded ? 'ana@example.test' : 'new@example.test', password: 'abcdefg1', consents: AGE },
        GO,
      );
      expect([res.status, res.body.code]).toEqual([403, 'signup_closed']);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(db().$rows('user')).toHaveLength(1);
    expect(db().$rows('seekerConsentRecord')).toEqual([]);
    expect(h.emails).toEqual([]);
  });

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
    expect(data).toHaveProperty('unreadCount');
    expect((data.flags as Record<string, unknown>)['auth.google']).toBe(false);
    expect((data.flags as Record<string, unknown>).hiringContacts).toBeDefined();
    expect((await harness.request('GET', '/api/v1/roboapply/auth/me', { host: ROBO })).status).toBe(401);
  });

  it('frontend and backend session cookie names are aligned', () => {
    expect(SESSION_COOKIE_NAME).toBe('ra_session_token');
    expect(FRONTEND_SESSION_COOKIE_NAME).toBe(SESSION_COOKIE_NAME);
  });
});
