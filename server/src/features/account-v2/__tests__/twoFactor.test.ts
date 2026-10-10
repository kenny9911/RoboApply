// @vitest-environment node
//
// Two-step sign-in service, readiness and the sign-in gate (WP-79).
// Acceptance: "2FA bypass impossible on login" — the gate revokes the
// minted session, only a valid second factor mints a new one, codes cannot be
// replayed, challenges are single-use, bound to their brand, limited to 5
// wrong tries and fail closed when the check itself breaks; enrolment stays
// closed while any sign-in path skips the check.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../../platform/brand/registry.js';
import { HttpError } from '../../../platform/http.js';
import { LOGIN_CHALLENGE_MAX_ATTEMPTS } from '../contract.js';
import {
  completeLoginChallenge,
  createMemoryChallengeStore,
  gateSessionForSignIn,
  type LoginChallengeDeps,
} from '../loginChallenge.js';
import { GATE_COVERAGE, SIGN_IN_PATHS, gateCoverage, totpAvailability, type SignInPath } from '../readiness.js';
import { createMemoryTwoFactorStore, createPrismaTwoFactorStore } from '../store.js';
import { totpAt } from '../totp.js';
import { TwoFactorService, type TwoFactorDeps } from '../twoFactor.js';

const ROBO = getBrand('roboapply');
const GO = getBrand('goapply');
const ENV = { TOTP_ENCRYPTION_KEY: 'b'.repeat(64) };
const ALL_GATED: SignInPath[] = SIGN_IN_PATHS.map((p) => ({ ...p, gated: true }));
const START = new Date('2026-10-10T12:00:05Z');

function reason(err: unknown): string | undefined {
  return ((err as HttpError).details as { reason?: string } | undefined)?.reason;
}

async function rejectsWith(promise: Promise<unknown>, code: string, why?: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe(code);
  if (why) expect(reason(err)).toBe(why);
}

function setup(overrides: Partial<TwoFactorDeps> = {}) {
  let now = START;
  const store = createMemoryTwoFactorStore();
  const revokeOtherSessions = vi.fn(async () => undefined);
  const svc = new TwoFactorService({
    store,
    env: () => ENV,
    now: () => now,
    revokeOtherSessions,
    qrDataUrl: async () => 'data:image/png;base64,QR',
    signInPaths: ALL_GATED,
    ...overrides,
  });
  return {
    svc,
    store,
    revokeOtherSessions,
    setNow: (d: Date) => {
      now = d;
    },
    tick: (sec: number) => {
      now = new Date(now.getTime() + sec * 1000);
    },
    now: () => now,
  };
}

async function enrolled(t: ReturnType<typeof setup>, userId = 'u1') {
  const { secret } = await t.svc.enrol(userId, ROBO, 'u@example.test');
  const { recoveryCodes } = await t.svc.verify(userId, ROBO, totpAt(secret, t.now()), 'sess_current');
  t.tick(30);
  return { secret, recoveryCodes };
}

describe('readiness', () => {
  it('keeps enrolment closed while any sign-in path skips the check', () => {
    const r = totpAvailability(ROBO, { env: ENV, storeAvailable: true });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('sign_in_paths_ungated');
    expect(r.ungated).toContain('auth.passwordReset');
    expect(r.ungated).not.toContain('authCn.sessions'); // cn-only path
    expect(totpAvailability(GO, { env: ENV, storeAvailable: true }).ungated).toContain('authCn.sessions');
  });

  it('needs the storage and the brand key', () => {
    expect(totpAvailability(ROBO, { env: ENV, storeAvailable: false, paths: ALL_GATED }).reason).toBe('storage_unavailable');
    expect(totpAvailability(ROBO, { env: {}, storeAvailable: true, paths: ALL_GATED }).reason).toBe('key_missing');
    expect(totpAvailability(GO, { env: ENV, storeAvailable: true, paths: ALL_GATED }).reason).toBe('key_missing');
    expect(totpAvailability(ROBO, { env: ENV, storeAvailable: true, paths: ALL_GATED })).toEqual({ available: true, reason: null, ungated: [] });
  });

  it('marks a path gated only when its file carries that path\'s own marker', () => {
    for (const p of SIGN_IN_PATHS.filter((x) => x.gated)) {
      const src = readFileSync(join(process.cwd(), p.file), 'utf8');
      expect(src, `${p.id} in ${p.file}`).toContain(p.marker);
    }
  });

  it('gives every sign-in path a marker no other path shares', () => {
    const markers = SIGN_IN_PATHS.map((p) => p.marker);
    expect(new Set(markers).size).toBe(markers.length);
    // One entry per session-issuing call in features/auth/routes.ts.
    const routes = GATE_COVERAGE.find((r) => r.file.endsWith('features/auth/routes.ts'))!;
    const src = readFileSync(join(process.cwd(), routes.file), 'utf8');
    const entries = SIGN_IN_PATHS.filter((p) => p.file === routes.file);
    expect(entries.length).toBeGreaterThanOrEqual(gateCoverage(src, routes).issuers);
  });

  it('allows a gated entry only when every session-issuing call in its file has a gate call', () => {
    for (const rule of GATE_COVERAGE) {
      if (!SIGN_IN_PATHS.some((p) => p.file === rule.file && p.gated)) continue;
      const src = readFileSync(join(process.cwd(), rule.file), 'utf8');
      const c = gateCoverage(src, rule);
      expect(c.covered, `${rule.file}: ${c.issuers} session calls, ${c.gates} gate calls`).toBe(true);
    }
  });

  it('counts session calls against gate calls (a reset-only wiring does not cover the OAuth calls)', () => {
    const rule = GATE_COVERAGE.find((r) => r.file.endsWith('features/auth/routes.ts'))!;
    const resetOnly = [
      'function setSession(req, res, token) {}',
      '// 2fa-gate:password-reset',
      'const g = await gateSessionForSignIn(deps, input); setSession(req, res, g.token);',
      'setSession(req, res, oauth.token);',
      'setSession(req, res, complete.token);',
    ].join('\n');
    expect(gateCoverage(resetOnly, rule)).toEqual({ issuers: 3, gates: 1, covered: false });
    const real = readFileSync(join(process.cwd(), rule.file), 'utf8');
    expect(gateCoverage(real, rule).issuers).toBe(6);
  });

  it('keeps enrolment closed until bearer JWTs from before the change are rejected', () => {
    const allButJwt = SIGN_IN_PATHS.map((p) => ({ ...p, gated: p.id !== 'auth.bearerJwt' }));
    expect(totpAvailability(ROBO, { env: ENV, storeAvailable: true, paths: allButJwt })).toMatchObject({
      available: false,
      reason: 'sign_in_paths_ungated',
      ungated: ['auth.bearerJwt'],
    });
  });

  it('closes enrolment on the real path list today', async () => {
    const t = setup({ signInPaths: undefined });
    const status = await t.svc.status('u1', ROBO);
    expect(status.available).toBe(false);
    await rejectsWith(t.svc.enrol('u1', ROBO, 'u@example.test'), 'provider_not_configured', 'totp_not_available');
  });
});

describe('TwoFactorService', () => {
  it('reports "not available" without throwing when the table is missing (SR-79-1)', async () => {
    const t = setup({ store: createPrismaTwoFactorStore({}) });
    await expect(t.svc.status('u1', ROBO)).resolves.toMatchObject({ enabled: false, available: false, pending: false });
    await expect(t.svc.requiresChallenge('u1')).resolves.toBe(false);
    await rejectsWith(t.svc.enrol('u1', ROBO, 'u@example.test'), 'storage_unavailable');
  });

  it('enrols with a sealed secret, confirms with the first code and returns 10 recovery codes once', async () => {
    const t = setup();
    const enrol = await t.svc.enrol('u1', ROBO, 'u@example.test');
    expect(enrol.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrol.otpauthUri).toContain(`secret=${enrol.secret}`);
    expect(enrol.otpauthUri).toContain('issuer=RoboApply');
    expect(enrol.qrDataUrl).toBe('data:image/png;base64,QR');
    expect(t.store.rows.get('u1')!.secretSealed).not.toContain(enrol.secret);
    expect(await t.svc.status('u1', ROBO)).toMatchObject({ enabled: false, pending: true, available: true });
    expect(await t.svc.requiresChallenge('u1')).toBe(false); // pending is not on

    await rejectsWith(t.svc.verify('u1', ROBO, '000000', 'sess'), 'invalid_request', 'totp_invalid');
    const { recoveryCodes } = await t.svc.verify('u1', ROBO, totpAt(enrol.secret, t.now()), 'sess_current');
    expect(recoveryCodes).toHaveLength(10);
    expect(t.store.rows.get('u1')!.recoveryCodeHashes.join()).not.toContain(recoveryCodes[0]);
    expect(t.revokeOtherSessions).toHaveBeenCalledWith('u1', 'sess_current');
    expect(await t.svc.status('u1', ROBO)).toMatchObject({ enabled: true, pending: false, recoveryCodesLeft: 10 });
    expect(await t.svc.requiresChallenge('u1')).toBe(true);
    await rejectsWith(t.svc.enrol('u1', ROBO, 'u@example.test'), 'conflict', 'totp_already_enabled');
  });

  it('does not let the confirming code be used again to sign in', async () => {
    const t = setup();
    const { secret } = await t.svc.enrol('u1', ROBO, 'u@example.test');
    const code = totpAt(secret, t.now());
    await t.svc.verify('u1', ROBO, code, null);
    expect(await t.svc.checkSecondFactor('u1', ROBO, { code })).toEqual({ ok: false });
  });

  it('checks codes replay-safe and spends recovery codes once', async () => {
    const t = setup();
    const { secret, recoveryCodes } = await enrolled(t);
    const code = totpAt(secret, t.now());
    expect(await t.svc.checkSecondFactor('u1', ROBO, { code })).toMatchObject({ ok: true, method: 'totp' });
    expect(await t.svc.checkSecondFactor('u1', ROBO, { code })).toEqual({ ok: false });
    expect(await t.svc.checkSecondFactor('u1', ROBO, { recoveryCode: recoveryCodes[0]!.toUpperCase() })).toEqual({ ok: true, method: 'recovery', recoveryCodesLeft: 9 });
    expect(await t.svc.checkSecondFactor('u1', ROBO, { recoveryCode: recoveryCodes[0]! })).toEqual({ ok: false });
    expect(await t.svc.checkSecondFactor('u2', ROBO, { code })).toEqual({ ok: false });
  });

  it('keeps recovery codes working when the sealing key is gone; codes then fail loudly', async () => {
    const t = setup();
    const { secret, recoveryCodes } = await enrolled(t);
    const noKey = new TwoFactorService({ store: t.store, env: () => ({}), now: t.now, revokeOtherSessions: vi.fn(), qrDataUrl: async () => null });
    expect(await noKey.requiresChallenge('u1')).toBe(true); // never switches itself off
    await rejectsWith(noKey.checkSecondFactor('u1', ROBO, { code: totpAt(secret, t.now()) }), 'provider_not_configured', 'totp_key_missing');
    expect(await noKey.checkSecondFactor('u1', ROBO, { recoveryCode: recoveryCodes[1]! })).toMatchObject({ ok: true });
  });

  it('disables only with a valid factor and signs other sessions out', async () => {
    const t = setup();
    const { secret, recoveryCodes } = await enrolled(t);
    await rejectsWith(t.svc.disable('u1', ROBO, { code: '000000' }, 'sess'), 'invalid_request', 'totp_invalid');
    expect(await t.svc.requiresChallenge('u1')).toBe(true);
    t.revokeOtherSessions.mockClear();
    await t.svc.disable('u1', ROBO, { recoveryCode: recoveryCodes[2]! }, 'sess_keep');
    expect(await t.svc.requiresChallenge('u1')).toBe(false);
    expect(t.revokeOtherSessions).toHaveBeenCalledWith('u1', 'sess_keep');
    await rejectsWith(t.svc.disable('u1', ROBO, { code: totpAt(secret, t.now()) }, null), 'conflict', 'totp_not_enrolled');
  });

  it('regenerates recovery codes with a current code; the old ones stop working', async () => {
    const t = setup();
    const { secret, recoveryCodes } = await enrolled(t);
    await rejectsWith(t.svc.regenerateRecoveryCodes('u1', ROBO, '000000'), 'invalid_request', 'totp_invalid');
    const fresh = await t.svc.regenerateRecoveryCodes('u1', ROBO, totpAt(secret, t.now()));
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(await t.svc.checkSecondFactor('u1', ROBO, { recoveryCode: recoveryCodes[0]! })).toEqual({ ok: false });
    expect(await t.svc.checkSecondFactor('u1', ROBO, { recoveryCode: fresh.recoveryCodes[0]! })).toMatchObject({ ok: true });
  });
});

describe('sign-in gate', () => {
  let t: ReturnType<typeof setup>;
  let deps: LoginChallengeDeps & { invalidateSession: ReturnType<typeof vi.fn>; createSession: ReturnType<typeof vi.fn> };
  let challenges: ReturnType<typeof createMemoryChallengeStore>;
  let allowed: boolean;
  let attemptsAllowed: boolean;

  beforeEach(() => {
    t = setup();
    challenges = createMemoryChallengeStore();
    allowed = true;
    attemptsAllowed = true;
    let n = 0;
    deps = {
      twoFactor: t.svc,
      challenges,
      now: t.now,
      invalidateSession: vi.fn(async () => undefined),
      createSession: vi.fn(async () => {
        n += 1;
        return { token: `new_session_${n}` };
      }),
      accountAllowed: async () => allowed,
      userAttemptAllowed: async () => attemptsAllowed,
    };
  });

  it('keeps the session when two-step sign-in is off', async () => {
    const out = await gateSessionForSignIn(deps, { userId: 'u1', brand: ROBO, sessionToken: 'minted' });
    expect(out).toEqual({ kind: 'session' });
    expect(deps.invalidateSession).not.toHaveBeenCalled();
  });

  it('revokes the minted session and issues a single-use challenge when it is on', async () => {
    const { secret } = await enrolled(t);
    const out = await gateSessionForSignIn(deps, { userId: 'u1', brand: ROBO, sessionToken: 'minted', login: { user: { id: 'u1' } } });
    expect(out.kind).toBe('challenge');
    expect(deps.invalidateSession).toHaveBeenCalledWith('minted');
    const token = (out as { token: string }).token;
    expect([...challenges.rows.values()][0]!.tokenHash).not.toBe(token);

    const done = await completeLoginChallenge(deps, { token, brand: ROBO, factor: { code: totpAt(secret, t.now()) } });
    expect(done).toMatchObject({ userId: 'u1', sessionToken: 'new_session_1', method: 'totp', login: { user: { id: 'u1' } } });
    // Single use: the same challenge cannot mint a second session.
    t.tick(30);
    await rejectsWith(completeLoginChallenge(deps, { token, brand: ROBO, factor: { code: totpAt(secret, t.now()) } }), 'unauthorized', 'two_factor_challenge_invalid');
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a broken check revokes the session and propagates', async () => {
    const broken = { ...deps, twoFactor: { ...t.svc, requiresChallenge: async () => Promise.reject(new Error('db down')), checkSecondFactor: t.svc.checkSecondFactor.bind(t.svc) } };
    await expect(gateSessionForSignIn(broken, { userId: 'u1', brand: ROBO, sessionToken: 'minted' })).rejects.toThrow('db down');
    expect(deps.invalidateSession).toHaveBeenCalledWith('minted');
  });

  it('refuses wrong codes, replayed codes and gives up after 5 tries', async () => {
    const { secret } = await enrolled(t);
    const used = totpAt(secret, t.now());
    expect((await t.svc.checkSecondFactor('u1', ROBO, { code: used })).ok).toBe(true);
    const out = (await gateSessionForSignIn(deps, { userId: 'u1', brand: ROBO, sessionToken: 'm' })) as { token: string };
    // The code already used once (e.g. read over a shoulder) does not work again.
    const replay = await completeLoginChallenge(deps, { token: out.token, brand: ROBO, factor: { code: used } }).catch((e) => e);
    expect(reason(replay)).toBe('totp_invalid');
    expect((replay as HttpError).details).toMatchObject({ attemptsLeft: LOGIN_CHALLENGE_MAX_ATTEMPTS - 1 });
    for (let i = 1; i < LOGIN_CHALLENGE_MAX_ATTEMPTS; i += 1) {
      await rejectsWith(completeLoginChallenge(deps, { token: out.token, brand: ROBO, factor: { code: '000000' } }), 'unauthorized', 'totp_invalid');
    }
    t.tick(30);
    await rejectsWith(
      completeLoginChallenge(deps, { token: out.token, brand: ROBO, factor: { code: totpAt(secret, t.now()) } }),
      'unauthorized',
      'two_factor_challenge_invalid',
    );
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('expires after 5 minutes and is bound to the issuing brand', async () => {
    const { secret } = await enrolled(t);
    const a = (await gateSessionForSignIn(deps, { userId: 'u1', brand: ROBO, sessionToken: 'm' })) as { token: string };
    await rejectsWith(completeLoginChallenge(deps, { token: a.token, brand: GO, factor: { code: totpAt(secret, t.now()) } }), 'unauthorized', 'two_factor_challenge_invalid');
    t.tick(5 * 60 + 1);
    await rejectsWith(completeLoginChallenge(deps, { token: a.token, brand: ROBO, factor: { code: totpAt(secret, t.now()) } }), 'unauthorized', 'two_factor_challenge_invalid');
    await rejectsWith(completeLoginChallenge(deps, { token: 'never-issued-token-xxxxxxxx', brand: ROBO, factor: { code: '123456' } }), 'unauthorized', 'two_factor_challenge_invalid');
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('stops a disabled account and over-limit guessing', async () => {
    const { secret } = await enrolled(t);
    const a = (await gateSessionForSignIn(deps, { userId: 'u1', brand: ROBO, sessionToken: 'm' })) as { token: string };
    attemptsAllowed = false;
    await rejectsWith(completeLoginChallenge(deps, { token: a.token, brand: ROBO, factor: { code: totpAt(secret, t.now()) } }), 'rate_limited');
    attemptsAllowed = true;
    allowed = false;
    await rejectsWith(completeLoginChallenge(deps, { token: a.token, brand: ROBO, factor: { code: totpAt(secret, t.now()) } }), 'unauthorized', 'two_factor_challenge_invalid');
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('accepts a recovery code as the second factor', async () => {
    const { recoveryCodes } = await enrolled(t);
    const a = (await gateSessionForSignIn(deps, { userId: 'u1', brand: ROBO, sessionToken: 'm' })) as { token: string };
    const done = await completeLoginChallenge(deps, { token: a.token, brand: ROBO, factor: { recoveryCode: recoveryCodes[0]! } });
    expect(done).toMatchObject({ method: 'recovery', recoveryCodesLeft: 9 });
  });
});
