// @vitest-environment node
//
// WP-11 acceptance (accounts): one flow sign-in/sign-up; new accounts need the
// signup consents (pipl_cross_border whenever data leaves the mainland → 422
// without it). Sign-up is open by default in every environment (D5); an
// invite is needed only with CN_SIGNUP_MODE=invite and CN_SIGNUP_MODE=closed
// refuses new accounts. Placeholder email never receives mail; bind + merge;
// phone change needs both proofs and revokes the other sessions.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { classifyAddress } from '../../platform/email/EmailService.js';
import { HttpError } from '../../platform/http.js';
import { AuthCnError } from './errors.js';
import { hashInviteCode } from './inviteService.js';
import { sha256 } from './phoneAuthService.js';
import { CONSENT_PROSE_VERSION, listConsents, type ConsentDb } from '../compliance/index.js';
import { crossBorderConsentRequired } from './signupPolicy.js';
import { BASE_ENV, buildServices, clock, cn0Consents, CN0_CONSENTS, CN0_CONSENTS_NO_HASH, CN_OWN_STACK_ENV, fakeDb, recordingSms } from './__tests__/testkit.js';

const goapply = getBrand('goapply');
const PHONE = '+8613812345678';
const NEW_PHONE = '+8613912345678';

beforeAll(() => setFlagOverrideLoader(async () => []));
afterAll(() => setFlagOverrideLoader(null));

async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AuthCnError || err instanceof HttpError) return err.code;
    throw err;
  }
  return 'resolved';
}

function setup(env = BASE_ENV, seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const { fake, db } = fakeDb(seed);
  const c = clock();
  const sms = recordingSms();
  const s = buildServices({ db, env, now: c.now, sms });
  const send = async (phoneE164: string, purpose: 'login' | 'bind' | 'change_old' | 'change_new', code: string) => {
    await s.otp.sendCode({ brand: 'goapply', phoneE164, purpose, ip: `9.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, code });
  };
  return { fake, db, c, sms, s, send };
}

describe('verifyAndSignIn — new number', () => {
  it('creates a brand-stamped account with a placeholder email that can never receive mail', async () => {
    const { s, send, fake } = setup();
    await send(PHONE, 'login', '111111');
    const r = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1.1.1.1' });
    expect(r.isNewUser).toBe(true);
    expect(r.nextRoute).toBe('/onboarding/consent');
    const user = fake.$rows('user')[0]!;
    expect(user).toMatchObject({ brand: 'goapply', market: 'cn', phoneE164: PHONE, emailIsPlaceholder: true, provider: 'phone', role: 'seeker' });
    expect(user.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(String(user.email)).toMatch(/^u-[0-9a-f]{24}@users\.goapply\.invalid$/);
    expect(classifyAddress(String(user.email))).toBe('placeholder_address');
    const profile = fake.$rows('seekerProfile')[0]!;
    expect(profile).toMatchObject({ userId: user.id, onboardingStep: 'account', locale: 'zh', market: 'cn' });
    expect(fake.$rows('seekerConsentRecord').map((r) => [r.consentType, r.granted])).toEqual([
      ['pipl_basic_processing', true],
      ['age_16_plus', true],
      ['pipl_cross_border', true],
    ]);
    // The client sent proseVersion 'v1'; the record names the text the form showed: its catalog version and hash.
    expect(fake.$rows('seekerConsentRecord').map((r) => r.proseVersion)).toEqual([CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION]);
    expect(fake.$rows('seekerConsentRecord').map((r) => r.proseHash)).toEqual(CN0_CONSENTS.map((c) => c.proseHash));
  });

  it('records the version and hash of the shown text, whatever version string the client sent (CN_LEGAL_DOCS_VERSION set or not)', async () => {
    const env = { ...BASE_ENV, CN_LEGAL_DOCS_VERSION: 'legal-2026-11' };
    const { s, send, fake } = setup(env);
    await send(PHONE, 'login', '111111');
    // The form read in English: the record names the English text.
    const forged = cn0Consents(env, 'en').map((c) => ({ ...c, proseVersion: 'x' }));
    await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: forged, ip: '1.1.1.1' });
    expect(fake.$rows('seekerConsentRecord').map((r) => r.proseVersion)).toEqual([CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION]);
    expect(fake.$rows('seekerConsentRecord').map((r) => r.proseHash)).toEqual(forged.map((c) => c.proseHash));
  });

  // Wave FIX gate: phone sign-up stored no hash, so G1 and Settings said "you agreed to an earlier
  // version of this text" a minute after the person agreed to exactly this text.
  it('a consent given at phone sign-up is known to be for the text served now (the ledger does not ask again)', async () => {
    const { s, send, fake } = setup();
    await send(PHONE, 'login', '111111');
    const r = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1.1.1.1' });
    for (const locale of ['zh', 'en']) {
      const items = await listConsents(r.userId, goapply, { env: BASE_ENV, locale }, { db: fake as unknown as ConsentDb, env: BASE_ENV });
      for (const type of ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border']) {
        expect(items.find((i) => i.type === type), `${type} ${locale}`).toMatchObject({ granted: true, answeredProseVersion: CONSENT_PROSE_VERSION, answeredTextCurrent: true });
      }
    }
  });

  it('refuses a consent that does not name the text shown (no hash, or the hash of a text no longer served) and keeps the code usable', async () => {
    const { s, send, fake } = setup();
    await send(PHONE, 'login', '111111');
    const noHash = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS_NO_HASH, ip: '1.1.1.1' }).catch((e) => e);
    expect(noHash).toBeInstanceOf(AuthCnError);
    expect(noHash).toMatchObject({ code: 'consent_required', status: 422 });
    expect(noHash.details).toEqual({ outdated: ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'], proseVersion: CONSENT_PROSE_VERSION });
    // The cross-border text was reworded while the form was open: only that one is asked again.
    const stale = CN0_CONSENTS.map((c) => (c.type === 'pipl_cross_border' ? { ...c, proseHash: 'd'.repeat(64) } : c));
    const old = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: stale, ip: '1.1.1.1' }).catch((e) => e);
    expect(old.details).toEqual({ outdated: ['pipl_cross_border'], proseVersion: CONSENT_PROSE_VERSION });
    expect(fake.$rows('user')).toHaveLength(0);
    expect(fake.$rows('seekerConsentRecord')).toHaveLength(0);
    // Same code, with the text now served.
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1.1.1.1' })).resolves.toMatchObject({ isNewUser: true });
  });

  it('CN-0: refuses signup without pipl_cross_border (422) and keeps the code usable', async () => {
    const { s, send, fake } = setup();
    await send(PHONE, 'login', '111111');
    const without = CN0_CONSENTS.filter((c) => c.type !== 'pipl_cross_border');
    const err = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: without, ip: '1.1.1.1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthCnError);
    expect(err.code).toBe('consent_required');
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ missing: ['pipl_cross_border'] });
    expect(fake.$rows('user')).toHaveLength(0);
    // Same code, now with the consent.
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1.1.1.1' })).resolves.toMatchObject({
      isNewUser: true,
    });
  });

  it('a mainland deployment on the shared stack still asks for the cross-border consent (data leaves the mainland)', async () => {
    // DEPLOY_REGION alone does not keep the data in the mainland: with no CN_ provider GoApply runs on the shared stack.
    const env = { ...BASE_ENV, DEPLOY_REGION: 'cn-mainland' };
    expect(crossBorderConsentRequired(env)).toBe(true);
    const { s, send, fake } = setup(env);
    await send(PHONE, 'login', '111111');
    const without = cn0Consents(env).filter((c) => c.type !== 'pipl_cross_border');
    const err = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: without, ip: '1.1.1.1' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'consent_required', status: 422, details: { missing: ['pipl_cross_border'] } });
    expect(fake.$rows('user')).toHaveLength(0);
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: cn0Consents(env), ip: '1.1.1.1' })).resolves.toMatchObject({
      isNewUser: true,
    });
  });

  it('a mainland deployment where every GoApply stack is its own does not ask for the cross-border consent', async () => {
    const env = { ...BASE_ENV, ...CN_OWN_STACK_ENV };
    expect(crossBorderConsentRequired(env)).toBe(false);
    const { s, send } = setup(env);
    await send(PHONE, 'login', '111111');
    const consents = cn0Consents(env).filter((c) => c.type !== 'pipl_cross_border');
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents, ip: '1.1.1.1' })).resolves.toMatchObject({
      isNewUser: true,
    });
  });

  it('rejects unknown consent types', async () => {
    const { s, send } = setup();
    await send(PHONE, 'login', '111111');
    await expect(
      errCode(
        s.phone.verifyAndSignIn({
          brand: goapply,
          phoneE164: PHONE,
          code: '111111',
          consents: [...CN0_CONSENTS, { type: 'sell_my_data', granted: true, proseVersion: 'v1' }],
          ip: '1.1.1.1',
        }),
      ),
    ).resolves.toBe('consent_required');
  });

  it('production with no legal-documents version: sign-up is open, with no invite code', async () => {
    const env = { ...BASE_ENV, NODE_ENV: 'production', SMS_DEV_CONSOLE: '' };
    expect(env).not.toHaveProperty('CN_LEGAL_DOCS_VERSION');
    expect(env).not.toHaveProperty('CN_SIGNUP_MODE');
    const { s, send } = setup(env);
    await send(PHONE, 'login', '111111');
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: cn0Consents(env), ip: '1.1.1.1' })).resolves.toMatchObject({
      isNewUser: true,
    });
  });

  it('CN_SIGNUP_MODE=closed: no new account (signup_closed, the code stays usable); existing accounts still sign in', async () => {
    const env = { ...BASE_ENV, CN_SIGNUP_MODE: 'closed' };
    const seed = {
      user: [{ id: 'u_old', email: 'x@users.goapply.invalid', brand: 'goapply', phoneE164: NEW_PHONE, phoneVerifiedAt: new Date(), isActive: true }],
      seekerProfile: [{ id: 'p_old', userId: 'u_old', onboardingStep: 'done', deletedAt: null }],
    };
    const { s, send, fake } = setup(env, seed);
    await send(PHONE, 'login', '111111');
    const refused = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: cn0Consents(env), ip: '1.1.1.1' }).catch((e) => e);
    expect(refused).toMatchObject({ code: 'signup_closed', status: 403 });
    expect(fake.$rows('user')).toHaveLength(1);
    await send(NEW_PHONE, 'login', '222222');
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: NEW_PHONE, code: '222222', ip: '1.1.1.1' })).resolves.toMatchObject({
      userId: 'u_old',
      isNewUser: false,
    });
  });
});

describe('verifyAndSignIn — invite mode (CN_SIGNUP_MODE=invite)', () => {
  const env = { ...BASE_ENV, CN_SIGNUP_MODE: 'invite' };
  const invite = (over: Record<string, unknown> = {}) => ({
    id: 'inv1',
    brand: 'goapply',
    codeHash: hashInviteCode('ABCDE-FGHJK'),
    maxUses: 1,
    uses: 0,
    expiresAt: null,
    note: null,
    createdAt: new Date('2026-10-01'),
    ...over,
  });

  it('requires a code for a new account and spends one use', async () => {
    const { s, send, fake } = setup(env, { rABrandInvite: [invite()] });
    await send(PHONE, 'login', '111111');
    await expect(errCode(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1' }))).resolves.toBe(
      'invite_invalid',
    );
    await expect(
      errCode(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, inviteCode: 'WRONG-CODE1', ip: '1' })),
    ).resolves.toBe('invite_invalid');
    await expect(
      s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, inviteCode: 'abcde fghjk', ip: '1' }),
    ).resolves.toMatchObject({ isNewUser: true });
    expect(fake.$rows('rABrandInvite')[0]!.uses).toBe(1);

    // The code is used up now.
    await send(NEW_PHONE, 'login', '222222');
    await expect(
      errCode(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: NEW_PHONE, code: '222222', consents: CN0_CONSENTS, inviteCode: 'ABCDEFGHJK', ip: '1' })),
    ).resolves.toBe('invite_invalid');
  });

  it('rejects expired codes and codes of the other brand', async () => {
    const { s, send } = setup(env, {
      rABrandInvite: [invite({ expiresAt: new Date('2026-10-09') }), invite({ id: 'inv2', brand: 'roboapply', codeHash: hashInviteCode('ROBOA-PPLY2') })],
    });
    await send(PHONE, 'login', '111111');
    for (const code of ['ABCDE-FGHJK', 'ROBOA-PPLY2']) {
      await expect(
        errCode(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, inviteCode: code, ip: '1' })),
      ).resolves.toBe('invite_invalid');
    }
  });
});

describe('verifyAndSignIn — known number', () => {
  it('signs in without consents and routes to the unfinished onboarding stage', async () => {
    const { s, send } = setup(BASE_ENV, {
      user: [{ id: 'u1', email: 'a@users.goapply.invalid', brand: 'goapply', phoneE164: PHONE, phoneVerifiedAt: new Date(), isActive: true }],
      seekerProfile: [{ id: 'p1', userId: 'u1', onboardingStep: 'intent', deletedAt: null }],
    });
    await send(PHONE, 'login', '111111');
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', ip: '1' })).resolves.toEqual({
      userId: 'u1',
      isNewUser: false,
      nextRoute: '/onboarding/intent',
    });
  });

  it('honours a same-site next once onboarding is done, never an absolute one', async () => {
    const seed = {
      user: [{ id: 'u1', email: 'a@users.goapply.invalid', brand: 'goapply', phoneE164: PHONE, phoneVerifiedAt: new Date(), isActive: true }],
      seekerProfile: [{ id: 'p1', userId: 'u1', onboardingStep: 'done', deletedAt: null }],
    };
    const { s, send, c } = setup(BASE_ENV, seed);
    await send(PHONE, 'login', '111111');
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', next: '/resume', ip: '1' })).resolves.toMatchObject({
      nextRoute: '/resume',
    });
    c.advance(61_000);
    await send(PHONE, 'login', '222222');
    const r = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '222222', next: '//evil.example', ip: '1' });
    expect(r.nextRoute.startsWith('/') && !r.nextRoute.startsWith('//')).toBe(true);
  });

  it('refuses suspended and deleted accounts', async () => {
    const { s, send } = setup(BASE_ENV, {
      user: [{ id: 'u1', email: 'a@x.invalid', brand: 'goapply', phoneE164: PHONE, phoneVerifiedAt: new Date(), isActive: false }],
      seekerProfile: [{ id: 'p1', userId: 'u1', onboardingStep: 'done', deletedAt: null }],
    });
    await send(PHONE, 'login', '111111');
    await expect(errCode(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', ip: '1' }))).resolves.toBe('forbidden');
  });

  it('a wrong code reveals nothing about the number', async () => {
    const { s, send } = setup();
    await send(PHONE, 'login', '111111');
    await expect(errCode(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '000000', ip: '1' }))).resolves.toBe('otp_invalid');
  });
});

describe('bind', () => {
  const wechatOnly = (over: Record<string, unknown> = {}) => ({
    id: 'w1',
    email: 'u-w@users.goapply.invalid',
    emailIsPlaceholder: true,
    brand: 'goapply',
    phoneE164: null,
    passwordHash: null,
    isActive: true,
    createdAt: new Date('2026-10-10T07:00:00Z'),
    ...over,
  });

  it('adds a verified number', async () => {
    const { s, send, fake } = setup(BASE_ENV, { user: [wechatOnly()], seekerProfile: [{ id: 'pw', userId: 'w1', onboardingStep: 'consent' }] });
    await send(PHONE, 'bind', '333333');
    await expect(s.phone.bind({ brand: goapply, userId: 'w1', phoneE164: PHONE, code: '333333', ip: '1' })).resolves.toEqual({
      userId: 'w1',
      merged: false,
      nextRoute: '/onboarding/consent',
    });
    expect(fake.$rows('user')[0]).toMatchObject({ phoneE164: PHONE, phoneVerifiedAt: expect.any(Date) });
  });

  it('a login code cannot bind', async () => {
    const { s, send } = setup(BASE_ENV, { user: [wechatOnly()], seekerProfile: [{ id: 'pw', userId: 'w1', onboardingStep: 'consent' }] });
    await send(PHONE, 'login', '333333');
    await expect(errCode(s.phone.bind({ brand: goapply, userId: 'w1', phoneE164: PHONE, code: '333333', ip: '1' }))).resolves.toBe('otp_invalid');
  });

  it('merges a fresh WeChat-only account into the account that owns the number', async () => {
    const { s, send, fake } = setup(BASE_ENV, {
      user: [wechatOnly(), { id: 'owner', email: 'o@users.goapply.invalid', brand: 'goapply', phoneE164: PHONE, phoneVerifiedAt: new Date(), isActive: true }],
      seekerProfile: [
        { id: 'pw', userId: 'w1', onboardingStep: 'account' },
        { id: 'po', userId: 'owner', onboardingStep: 'done' },
      ],
      rAAuthIdentity: [{ id: 'i1', userId: 'w1', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'openid1' }],
      session: [{ id: 's1', userId: 'w1', token: 't1' }],
    });
    await send(PHONE, 'bind', '333333');
    const r = await s.phone.bind({ brand: goapply, userId: 'w1', phoneE164: PHONE, code: '333333', ip: '1', next: '/resume' });
    expect(r).toMatchObject({ userId: 'owner', merged: true, nextRoute: '/resume' });
    expect(fake.$rows('user').map((u) => u.id)).toEqual(['owner']);
    expect(fake.$rows('rAAuthIdentity')[0]!.userId).toBe('owner');
    expect(fake.$rows('session')).toHaveLength(0);
  });

  it('refuses a number owned by another account when this account is not a fresh WeChat-only one', async () => {
    const { s, send } = setup(BASE_ENV, {
      user: [wechatOnly({ passwordHash: 'x' }), { id: 'owner', email: 'o@x.invalid', brand: 'goapply', phoneE164: PHONE, isActive: true }],
      seekerProfile: [{ id: 'pw', userId: 'w1', onboardingStep: 'account' }],
    });
    await send(PHONE, 'bind', '333333');
    const err = await s.phone.bind({ brand: goapply, userId: 'w1', phoneE164: PHONE, code: '333333', ip: '1' }).catch((e) => e);
    expect(err.code).toBe('phone_taken');
    expect(err.status).toBe(409);
  });

  it('never merges into a deleted account: refused before anything moves', async () => {
    const { s, send, fake } = setup(BASE_ENV, {
      user: [wechatOnly(), { id: 'owner', email: 'o@users.goapply.invalid', brand: 'goapply', phoneE164: PHONE, phoneVerifiedAt: new Date(), isActive: true }],
      seekerProfile: [
        { id: 'pw', userId: 'w1', onboardingStep: 'account' },
        { id: 'po', userId: 'owner', onboardingStep: 'done', deletedAt: new Date('2026-10-01T00:00:00Z') },
      ],
      rAAuthIdentity: [{ id: 'i1', userId: 'w1', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'openid1' }],
      session: [{ id: 's1', userId: 'w1', token: 't1' }],
    });
    await send(PHONE, 'bind', '333333');
    await expect(errCode(s.phone.bind({ brand: goapply, userId: 'w1', phoneE164: PHONE, code: '333333', ip: '1' }))).resolves.toBe('phone_taken');
    expect(fake.$rows('user').map((u) => u.id).sort()).toEqual(['owner', 'w1']);
    expect(fake.$rows('rAAuthIdentity')[0]!.userId).toBe('w1');
    expect(fake.$rows('session')).toHaveLength(1);
  });

  it('refuses when the account already has a number', async () => {
    const { s } = setup(BASE_ENV, { user: [wechatOnly({ phoneE164: NEW_PHONE })] });
    await expect(errCode(s.phone.bind({ brand: goapply, userId: 'w1', phoneE164: PHONE, code: '333333', ip: '1' }))).resolves.toBe('conflict');
  });
});

describe('change', () => {
  const seed = () => ({
    user: [
      {
        id: 'u1',
        email: 'a@users.goapply.invalid',
        brand: 'goapply',
        phoneE164: PHONE,
        phoneVerifiedAt: new Date(),
        isActive: true,
        passwordHash: null as string | null,
      },
    ],
    session: [
      { id: 's_mine', userId: 'u1', token: 'mine' },
      { id: 's_other', userId: 'u1', token: 'other' },
    ],
  });

  it('needs the old-number code AND the new-number code, then signs out other sessions', async () => {
    const { s, send, fake, c } = setup(BASE_ENV, seed());
    await send(PHONE, 'change_old', '444444');
    c.advance(61_000);
    await send(NEW_PHONE, 'change_new', '555555');
    // Wrong new code: nothing changes, and the old-number code is NOT spent.
    await expect(
      errCode(s.phone.change({ brand: goapply, userId: 'u1', oldCode: '444444', newPhoneE164: NEW_PHONE, newCode: '000000', keepSessionToken: 'mine', ip: '1' })),
    ).resolves.toBe('otp_invalid');
    expect(fake.$rows('user')[0]!.phoneE164).toBe(PHONE);
    expect(fake.$rows('rAPhoneOtp').every((r) => (r.consumedAt ?? null) === null)).toBe(true);

    // Retyped new code, same old code: done; both codes are now spent.
    await expect(
      s.phone.change({ brand: goapply, userId: 'u1', oldCode: '444444', newPhoneE164: NEW_PHONE, newCode: '555555', keepSessionToken: 'mine', ip: '1' }),
    ).resolves.toEqual({ phoneMasked: '139****5678', sessionsRevoked: 1 });
    expect(fake.$rows('user')[0]!.phoneE164).toBe(NEW_PHONE);
    expect(fake.$rows('session').map((x) => x.token)).toEqual(['mine']);
    expect(fake.$rows('rAPhoneOtp').every((r) => r.consumedAt instanceof Date)).toBe(true);
  });

  it('limits password re-verification to 5 tries per user per 15 minutes (429)', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const data = seed();
    data.user[0]!.passwordHash = await bcrypt.hash('correct horse', 4);
    const { s, send, c } = setup(BASE_ENV, data);
    await send(NEW_PHONE, 'change_new', '555555');
    const attempt = (value: string) =>
      errCode(
        s.phone.change({
          brand: goapply,
          userId: 'u1',
          identityProof: { method: 'password', value },
          newPhoneE164: NEW_PHONE,
          newCode: '555555',
          keepSessionToken: null,
          ip: '1',
        }),
      );
    for (let i = 0; i < 5; i++) await expect(attempt(`guess-${i}`)).resolves.toBe('identity_proof_invalid');
    // Even the right password is refused until the window passes.
    await expect(attempt('correct horse')).resolves.toBe('rate_limited');
    c.advance(15 * 60 * 1000);
    await send(NEW_PHONE, 'change_new', '555555'); // the first code expired meanwhile
    await expect(attempt('correct horse')).resolves.toBe('resolved');
  });

  it('a mistyped new code does not spend the WeChat re-verification token', async () => {
    const data = {
      ...seed(),
      rAAuthToken: [
        { id: 't1', brand: 'goapply', kind: 'wechat_reverify', tokenHash: sha256('raw-token'), userId: 'u1', expiresAt: new Date('2026-10-10T08:05:00Z') },
      ],
    };
    const { s, send, fake } = setup(BASE_ENV, data);
    await send(NEW_PHONE, 'change_new', '555555');
    const input = {
      brand: goapply,
      userId: 'u1',
      identityProof: { method: 'wechat' as const, value: 'raw-token' },
      newPhoneE164: NEW_PHONE,
      keepSessionToken: 'mine',
      ip: '1',
    };
    await expect(errCode(s.phone.change({ ...input, newCode: '000000' }))).resolves.toBe('otp_invalid');
    expect(fake.$rows('rAAuthToken')[0]!.consumedAt ?? null).toBeNull();
    await expect(s.phone.change({ ...input, newCode: '555555' })).resolves.toMatchObject({ phoneMasked: '139****5678' });
    expect(fake.$rows('rAAuthToken')[0]!.consumedAt).toBeInstanceOf(Date);
  });

  it('an old-number code alone is not enough', async () => {
    const { s, send } = setup(BASE_ENV, seed());
    await send(PHONE, 'change_old', '444444');
    await expect(
      errCode(s.phone.change({ brand: goapply, userId: 'u1', oldCode: '444444', newPhoneE164: NEW_PHONE, newCode: '555555', keepSessionToken: null, ip: '1' })),
    ).resolves.toBe('otp_invalid');
  });

  it('accepts the password when the old number is lost, and rejects a wrong one', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const data = seed();
    data.user[0]!.passwordHash = await bcrypt.hash('correct horse', 4);
    const { s, send } = setup(BASE_ENV, data);
    await send(NEW_PHONE, 'change_new', '555555');
    await expect(
      errCode(
        s.phone.change({
          brand: goapply,
          userId: 'u1',
          identityProof: { method: 'password', value: 'wrong' },
          newPhoneE164: NEW_PHONE,
          newCode: '555555',
          keepSessionToken: null,
          ip: '1',
        }),
      ),
    ).resolves.toBe('identity_proof_invalid');
    await expect(
      s.phone.change({
        brand: goapply,
        userId: 'u1',
        identityProof: { method: 'password', value: 'correct horse' },
        newPhoneE164: NEW_PHONE,
        newCode: '555555',
        keepSessionToken: null,
        ip: '1',
      }),
    ).resolves.toMatchObject({ sessionsRevoked: 2 });
  });

  it('accepts a single-use WeChat re-verification token', async () => {
    const data = {
      ...seed(),
      rAAuthToken: [
        { id: 't1', brand: 'goapply', kind: 'wechat_reverify', tokenHash: sha256('raw-token'), userId: 'u1', expiresAt: new Date('2026-10-10T08:05:00Z') },
      ],
    };
    const { s, send, c } = setup(BASE_ENV, data);
    await send(NEW_PHONE, 'change_new', '555555');
    const input = {
      brand: goapply,
      userId: 'u1',
      identityProof: { method: 'wechat' as const, value: 'raw-token' },
      newPhoneE164: NEW_PHONE,
      newCode: '555555',
      keepSessionToken: 'mine',
      ip: '1',
    };
    await expect(s.phone.change(input)).resolves.toMatchObject({ phoneMasked: '139****5678' });
    c.advance(61_000);
    await send('+8613700000000', 'change_new', '666666');
    await expect(errCode(s.phone.change({ ...input, newPhoneE164: '+8613700000000', newCode: '666666' }))).resolves.toBe('identity_proof_invalid');
  });

  it('refuses a new number that belongs to another account', async () => {
    const data = seed();
    data.user.push({ id: 'u2', email: 'b@x.invalid', brand: 'goapply', phoneE164: NEW_PHONE, phoneVerifiedAt: new Date(), isActive: true, passwordHash: null });
    const { s, send } = setup(BASE_ENV, data);
    await send(PHONE, 'change_old', '444444');
    await expect(
      errCode(s.phone.change({ brand: goapply, userId: 'u1', oldCode: '444444', newPhoneE164: NEW_PHONE, newCode: '555555', keepSessionToken: null, ip: '1' })),
    ).resolves.toBe('phone_taken');
  });
});

describe('assertSendAllowed', () => {
  const seed = {
    user: [
      { id: 'u1', email: 'a@x.invalid', brand: 'goapply', phoneE164: PHONE },
      { id: 'u2', email: 'b@x.invalid', brand: 'goapply', phoneE164: NEW_PHONE },
    ],
  };

  it('login needs no session; bind/change need one', async () => {
    const { s } = setup(BASE_ENV, seed);
    await expect(s.phone.assertSendAllowed(goapply, 'login', PHONE, null)).resolves.toBeUndefined();
    await expect(errCode(s.phone.assertSendAllowed(goapply, 'bind', PHONE, null))).resolves.toBe('unauthorized');
  });

  it('change_old only to the account number; change_new never to a taken number', async () => {
    const { s } = setup(BASE_ENV, seed);
    await expect(errCode(s.phone.assertSendAllowed(goapply, 'change_old', '+8613000000000', 'u1'))).resolves.toBe('phone_mismatch');
    await expect(s.phone.assertSendAllowed(goapply, 'change_old', PHONE, 'u1')).resolves.toBeUndefined();
    await expect(errCode(s.phone.assertSendAllowed(goapply, 'change_new', NEW_PHONE, 'u1'))).resolves.toBe('phone_taken');
    await expect(s.phone.assertSendAllowed(goapply, 'change_new', '+8613000000000', 'u1')).resolves.toBeUndefined();
  });
});

