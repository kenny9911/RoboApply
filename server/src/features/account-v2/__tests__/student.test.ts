// @vitest-environment node
//
// Student verification by school email (F-ACCT-02, V2) and the account-v2
// routes (auth → capability → handler), plus the student-code email.

import { mkdtempSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../../platform/brand/registry.js';
import { HttpError } from '../../../platform/http.js';
import { createEmailTranslator, resetEmailI18nCache, setEmailI18nDirForTests } from '../../../platform/email/i18n.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { setFlagOverrideLoader } from '../../../platform/flags.js';
import { createStudentRouter, createTwoFactorRouter } from '../routes.js';
import { SIGN_IN_PATHS } from '../readiness.js';
import { createMemoryStudentStore, createMemoryTwoFactorStore, createPrismaStudentStore } from '../store.js';
import { StudentService, eligibleSchoolDomain, hashSchoolEmail, type StudentDeps } from '../student.js';
import { studentCodeEmail } from '../emails.js';
import { totpAt } from '../totp.js';
import { TwoFactorService } from '../twoFactor.js';

const ROBO = getBrand('roboapply');
const START = new Date('2026-10-10T12:00:00Z');

function reason(err: unknown): string | undefined {
  return ((err as HttpError).details as { reason?: string } | undefined)?.reason;
}

describe('eligibleSchoolDomain', () => {
  it.each([
    ['s@stanford.edu', 'stanford.edu'],
    ['s@cs.stanford.edu', 'cs.stanford.edu'],
    ['s@ntu.edu.tw', 'ntu.edu.tw'],
    ['s@ox.ac.uk', 'ox.ac.uk'],
    ['s@u-tokyo.ac.jp', 'u-tokyo.ac.jp'],
  ])('%s → %s', (email, domain) => {
    expect(eligibleSchoolDomain(email)).toBe(domain);
  });

  it.each(['s@gmail.com', 's@company.com', 's@alumni.stanford.edu', 's@alum.mit.edu', 'not-an-email', 's@edu', 's@ethz.ch'])('%s is not eligible', (email) => {
    expect(eligibleSchoolDomain(email)).toBeNull();
  });

  it('accepts schools on the allowlist, including their subdomains', () => {
    const env = { STUDENT_EMAIL_DOMAINS: 'ethz.ch, @tum.de, bad domain' };
    expect(eligibleSchoolDomain('s@ethz.ch', env)).toBe('ethz.ch');
    expect(eligibleSchoolDomain('s@student.ethz.ch', env)).toBe('ethz.ch');
    expect(eligibleSchoolDomain('s@tum.de', env)).toBe('tum.de');
    expect(eligibleSchoolDomain('s@notethz.ch', env)).toBeNull();
  });
});

function setup(overrides: Partial<StudentDeps> = {}) {
  let now = START;
  const store = createMemoryStudentStore();
  const sent: Array<{ to: string; code: string }> = [];
  let sendStatus = 'sent';
  let allowed = true;
  const svc = new StudentService({
    store,
    env: () => ({}),
    now: () => now,
    sendCode: async ({ to, code }) => {
      sent.push({ to, code });
      return sendStatus;
    },
    sendAllowed: async () => allowed,
    ...overrides,
  });
  return {
    svc,
    store,
    sent,
    setSendStatus: (s: string) => {
      sendStatus = s;
    },
    setAllowed: (a: boolean) => {
      allowed = a;
    },
    tick: (sec: number) => {
      now = new Date(now.getTime() + sec * 1000);
    },
  };
}

async function rejects(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe('StudentService', () => {
  it('reports "not available" without the table (SR-79-2) and never verifies', async () => {
    const svc = new StudentService({
      store: createPrismaStudentStore({}),
      env: () => ({}),
      now: () => START,
      sendCode: async () => 'sent',
      sendAllowed: async () => true,
    });
    await expect(svc.status('u1')).resolves.toMatchObject({ verified: false, available: false });
    await expect(svc.isVerified('u1')).resolves.toBe(false);
    expect((await rejects(svc.sendCode('u1', ROBO, 's@stanford.edu', null))).code).toBe('storage_unavailable');
  });

  it('sends a code to the school address, stores only its hash, and verifies for 12 months', async () => {
    const t = setup();
    const sent = await t.svc.sendCode('u1', ROBO, 'S@Stanford.edu', 'en');
    expect(sent.schoolDomain).toBe('stanford.edu');
    expect(t.sent[0]!.to).toBe('S@Stanford.edu');
    const row = t.store.rows.get('u1')!;
    expect(JSON.stringify(row)).not.toContain('Stanford');
    expect(row.schoolEmailHash).toBe(hashSchoolEmail('s@stanford.edu'));
    expect(JSON.stringify(row)).not.toContain(t.sent[0]!.code);
    expect(await t.svc.status('u1')).toMatchObject({ verified: false, pendingDomain: 'stanford.edu' });

    const status = await t.svc.confirm('u1', t.sent[0]!.code);
    expect(status).toMatchObject({ verified: true, schoolDomain: 'stanford.edu', pendingDomain: null, verifiedAt: START.toISOString(), expiresAt: '2027-10-10T12:00:00.000Z' });
    expect(await t.svc.isVerified('u1')).toBe(true);
    t.tick(366 * 86_400);
    expect(await t.svc.isVerified('u1')).toBe(false);
  });

  it('refuses ineligible domains and over-limit sends; an address verified elsewhere is refused only at confirm', async () => {
    const t = setup();
    expect(reason(await rejects(t.svc.sendCode('u1', ROBO, 's@gmail.com', null)))).toBe('school_domain_not_eligible');
    await t.svc.sendCode('u1', ROBO, 's@stanford.edu', null);
    await t.svc.confirm('u1', t.sent[0]!.code);
    // The send step does not reveal that the address is taken...
    await expect(t.svc.sendCode('u2', ROBO, 's@stanford.edu', null)).resolves.toMatchObject({ schoolDomain: 'stanford.edu' });
    // ...only the inbox owner, holding the code, learns it.
    expect(reason(await rejects(t.svc.confirm('u2', t.sent[1]!.code)))).toBe('school_email_in_use');
    expect(await t.svc.isVerified('u2')).toBe(false);
    expect(await t.svc.isVerified('u1')).toBe(true);
    t.setAllowed(false);
    expect((await rejects(t.svc.sendCode('u2', ROBO, 'x@stanford.edu', null))).code).toBe('rate_limited');
  });

  it('counts every send before any lookup, so address probing is rate-limited', async () => {
    let used = 0;
    const t = setup({ sendAllowed: async () => ++used <= 10 });
    await t.svc.sendCode('owner', ROBO, 'taken@stanford.edu', null);
    await t.svc.confirm('owner', t.sent[0]!.code);
    used = 0;
    const results: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const out = await t.svc.sendCode('prober', ROBO, i % 2 ? 'taken@stanford.edu' : `free${i}@stanford.edu`, null).then(
        () => 'sent',
        (e: HttpError) => e.code as string,
      );
      results.push(out);
    }
    // Taken and free addresses answer the same; the 11th probe is refused.
    expect(results.slice(0, 10)).toEqual(Array(10).fill('sent'));
    expect(results[10]).toBe('rate_limited');
    expect(used).toBe(11);
  });

  it('says so when the email could not be sent', async () => {
    const t = setup();
    t.setSendStatus('suppressed');
    expect(reason(await rejects(t.svc.sendCode('u1', ROBO, 's@stanford.edu', null)))).toBe('email_unavailable');
  });

  it('wrong codes count down; after 5, or after 15 minutes, the code is dead', async () => {
    const t = setup();
    await t.svc.sendCode('u1', ROBO, 's@stanford.edu', null);
    const code = t.sent[0]!.code;
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await rejects(t.svc.confirm('u1', wrong));
    expect(first.details).toMatchObject({ reason: 'student_code_invalid', attemptsLeft: 4 });
    for (let i = 0; i < 4; i += 1) await rejects(t.svc.confirm('u1', wrong));
    expect(reason(await rejects(t.svc.confirm('u1', code)))).toBe('student_code_expired');

    await t.svc.sendCode('u1', ROBO, 's@stanford.edu', null);
    t.tick(15 * 60 + 1);
    expect(reason(await rejects(t.svc.confirm('u1', t.sent[1]!.code)))).toBe('student_code_expired');
    expect(reason(await rejects(setup().svc.confirm('nobody', '123456')))).toBe('student_code_expired');
  });

  it('keeps a live verification while a code for another address is pending; the switch happens at confirm', async () => {
    const t = setup();
    await t.svc.sendCode('u1', ROBO, 's@stanford.edu', null);
    await t.svc.confirm('u1', t.sent[0]!.code);
    await t.svc.sendCode('u1', ROBO, 's@stanford.edu', null);
    expect(await t.svc.isVerified('u1')).toBe(true);

    // A new address (mistyped, or the email fails): the old verification stays.
    t.setSendStatus('failed');
    expect(reason(await rejects(t.svc.sendCode('u1', ROBO, 'typo@ox.ac.uk', null)))).toBe('email_unavailable');
    expect(await t.svc.isVerified('u1')).toBe(true);
    t.setSendStatus('sent');
    await t.svc.sendCode('u1', ROBO, 'other@ox.ac.uk', null);
    expect(await t.svc.isVerified('u1')).toBe(true);
    expect(await t.svc.status('u1')).toMatchObject({ verified: true, schoolDomain: 'stanford.edu', pendingDomain: 'ox.ac.uk' });

    // Confirming moves the verification to the new address and frees the old one.
    await t.svc.confirm('u1', t.sent[t.sent.length - 1]!.code);
    expect(await t.svc.status('u1')).toMatchObject({ verified: true, schoolDomain: 'ox.ac.uk', pendingDomain: null });
    await t.svc.sendCode('u2', ROBO, 's@stanford.edu', null);
    await expect(t.svc.confirm('u2', t.sent[t.sent.length - 1]!.code)).resolves.toMatchObject({ verified: true, schoolDomain: 'stanford.edu' });
  });
});

describe('student-code email', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wp79-email-'));
    mkdirSync(join(dir, 'staging'));
    const root = join(process.cwd(), 'server/src/i18n/email');
    copyFileSync(join(root, 'en.json'), join(dir, 'en.json'));
    copyFileSync(join(root, 'staging/billing.en.json'), join(dir, 'staging/billing.en.json'));
    copyFileSync(join(process.cwd(), 'server/src/i18n/email/staging/accountV2.en.json'), join(dir, 'staging/accountV2.en.json'));
    setEmailI18nDirForTests(dir);
    resetEmailI18nCache();
  });
  afterAll(() => {
    setEmailI18nDirForTests(null);
    resetEmailI18nCache();
  });

  it('renders the code with the brand name and no raw keys', () => {
    for (const brand of [getBrand('roboapply'), getBrand('goapply')]) {
      const out = studentCodeEmail.render({ brand, t: createEmailTranslator(brand, 'en'), params: { code: '123456', minutes: 15 }, origin: 'https://x.test' });
      expect(out.subject).toContain('123456');
      expect(out.subject).toContain(brand.name);
      expect(out.bodyText).toContain('15 minutes');
      expect(out.bodyText).not.toMatch(/accountV2\./);
    }
  });
});

describe('account-v2 routes', () => {
  let h: RouteHarness;
  let signedIn: boolean;
  const twoFactorStore = createMemoryTwoFactorStore();
  const revokeOtherSessions = vi.fn(async (_userId: string, _keep: string | null) => undefined);
  const cutOffBearerTokens = vi.fn(async (_userId: string, _at: Date) => undefined);
  // The REAL sign-in path list (no override): every path is gated since INT-01,
  // so the status endpoint reports that two-step sign-in can be turned on.
  const twoFactor = new TwoFactorService({
    store: twoFactorStore,
    env: () => ({ TOTP_ENCRYPTION_KEY: 'd'.repeat(64) }),
    now: () => START,
    revokeOtherSessions,
    cutOffBearerTokens,
    qrDataUrl: async () => null,
  });
  const studentT = setup();

  beforeAll(async () => {
    // No per-user flag overrides (the default loader reads the database).
    setFlagOverrideLoader(async () => []);
    const auth = [fakeAuth(() => (signedIn ? { id: 'u1', email: 'u@example.test' } : null))];
    const env = { NODE_ENV: 'development' };
    const offEnv = { NODE_ENV: 'development', FLAG_ROBOAPPLY_TOTP: 'false', FLAG_ROBOAPPLY_STUDENT: 'false' };
    h = await startRouteHarness({
      env,
      mounts: [
        ['/a/2fa', createTwoFactorRouter({ seekerAuth: auth, env, twoFactor, rateLimits: false })],
        ['/a/student', createStudentRouter({ seekerAuth: auth, env, student: studentT.svc, rateLimits: false })],
        ['/off/2fa', createTwoFactorRouter({ seekerAuth: auth, env: offEnv, twoFactor, rateLimits: false })],
        ['/off/student', createStudentRouter({ seekerAuth: auth, env: offEnv, student: studentT.svc, rateLimits: false })],
      ],
    });
  });
  afterAll(async () => {
    setFlagOverrideLoader(null);
    await h.close();
  });
  beforeEach(() => {
    signedIn = true;
  });

  it('401 signed out, 404 feature_disabled with the capability off', async () => {
    signedIn = false;
    expect((await h.request('GET', '/a/2fa')).status).toBe(401);
    expect((await h.request('POST', '/a/student/verify-email/send', { body: { schoolEmail: 's@stanford.edu' } })).status).toBe(401);
    signedIn = true;
    const off = await h.request<{ code: string }>('GET', '/off/2fa');
    expect([off.status, off.body.code]).toEqual([404, 'feature_disabled']);
    expect((await h.request('GET', '/off/student')).status).toBe(404);
  });

  it('runs enrolment end to end and validates bodies', async () => {
    // Enrolment is open on the real path list (readiness: every entry gated).
    expect(SIGN_IN_PATHS.every((p) => p.gated)).toBe(true);
    expect((await h.request<{ data: { available: boolean } }>('GET', '/a/2fa')).body.data.available).toBe(true);
    const enrol = await h.request<{ data: { secret: string; otpauthUri: string } }>('POST', '/a/2fa/enrol');
    expect(enrol.status).toBe(200);
    expect(enrol.body.data.otpauthUri).toContain(encodeURIComponent('u@example.test'));
    expect((await h.request('POST', '/a/2fa/verify', { body: { code: '12' } })).status).toBe(422);
    // The browser that turns it on stays signed in: its session cookie is the
    // one kept, also when the request itself was authenticated another way
    // (a bearer JWT, which is cut off at the same moment).
    const verify = await h.request<{ data: { recoveryCodes: string[] } }>('POST', '/a/2fa/verify', {
      body: { code: totpAt(enrol.body.data.secret, START) },
      cookies: { ra_session_token: 'this-browser' },
    });
    expect(verify.body.data.recoveryCodes).toHaveLength(10);
    expect(revokeOtherSessions).toHaveBeenLastCalledWith('u1', 'this-browser');
    expect(cutOffBearerTokens).toHaveBeenLastCalledWith('u1', START);
    expect((await h.request<{ data: { enabled: boolean } }>('GET', '/a/2fa')).body.data.enabled).toBe(true);
    const bad = await h.request<{ details: { reason: string } }>('POST', '/a/2fa/disable', { body: { code: '000000' } });
    expect([bad.status, bad.body.details.reason]).toEqual([422, 'totp_invalid']);
    expect((await h.request('POST', '/a/2fa/disable', { body: {} })).status).toBe(422);
    expect((await h.request('POST', '/a/2fa/disable', { body: { recoveryCode: verify.body.data.recoveryCodes[0] } })).status).toBe(204);
  });

  it('runs student verification end to end', async () => {
    const bad = await h.request<{ details: { reason: string } }>('POST', '/a/student/verify-email/send', { body: { schoolEmail: 's@gmail.com' } });
    expect([bad.status, bad.body.details.reason]).toEqual([422, 'school_domain_not_eligible']);
    const sent = await h.request<{ data: { schoolDomain: string } }>('POST', '/a/student/verify-email/send', { body: { schoolEmail: 's@ntu.edu.tw' } });
    expect(sent.body.data.schoolDomain).toBe('ntu.edu.tw');
    const ok = await h.request<{ data: { verified: boolean } }>('POST', '/a/student/verify-email/confirm', { body: { code: studentT.sent.at(-1)!.code } });
    expect(ok.body.data.verified).toBe(true);
    expect((await h.request<{ data: { verified: boolean } }>('GET', '/a/student')).body.data.verified).toBe(true);
  });
});
