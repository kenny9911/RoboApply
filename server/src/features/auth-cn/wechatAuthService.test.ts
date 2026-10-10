// @vitest-environment node
//
// WP-11 acceptance (WeChat): single-use, brand-bound OAuth state; unionId
// merges identities across the web/公众号/mini apps; a new WeChat account
// needs the G0 agreement and is sent to bind a phone; WeChat re-verification
// for a phone change; the mini-program API seam; and the AI gate
// (403 phone_binding_required) for WeChat accounts without a phone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { AuthCnError } from './errors.js';
import { assertPhoneBound, hasBoundPhone, phoneBindingRequired } from './phoneBinding.js';
import { sha256 } from './phoneAuthService.js';
import { returnLocation } from './wechatAuthService.js';
import { CONSENT_PROSE_VERSION, listConsents, type ConsentDb } from '../compliance/index.js';
import { BASE_ENV, buildServices, clock, cn0Consents, CN0_CONSENTS, CN0_CONSENTS_NO_HASH, fakeDb, fakeWechatFetch } from './__tests__/testkit.js';

const goapply = getBrand('goapply');

beforeAll(() => setFlagOverrideLoader(async () => []));
afterAll(() => setFlagOverrideLoader(null));

function setup(opts: { env?: typeof BASE_ENV; seed?: Record<string, Array<Record<string, unknown>>>; codes?: Parameters<typeof fakeWechatFetch>[0]; phones?: Record<string, string> } = {}) {
  const { fake, db } = fakeDb(opts.seed ?? {});
  const c = clock();
  const wx = fakeWechatFetch(opts.codes ?? {}, opts.phones ?? {});
  const s = buildServices({ db, env: opts.env ?? BASE_ENV, now: c.now, fetch: wx.fetch });
  return { fake, db, c, s, wx };
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

type Services = ReturnType<typeof setup>['s'];
type StartInput = Parameters<Services['wechat']['startUrl']>[0];
type CallbackInput = Parameters<Services['wechat']['callback']>[0];

/** state → the browser-binding nonce the start route would put in the cookie. */
const nonces = new Map<string, string>();

async function begin(s: Services, input: StartInput): Promise<string> {
  const { url, nonce } = await s.wechat.startUrl(input);
  const state = stateOf(url);
  nonces.set(state, nonce);
  return state;
}

/** The callback as the starting browser makes it (cookie present). */
function cb(s: Services, input: CallbackInput) {
  return s.wechat.callback({ nonce: nonces.get(input.state ?? ''), ...input });
}

describe('startUrl', () => {
  it('web: QR sign-in with the canonical callback and a hashed single-use state', async () => {
    const { s, fake } = setup();
    const { url, nonce } = await s.wechat.startUrl({ brand: goapply, flow: 'web', next: '/resume', consents: CN0_CONSENTS });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://open.weixin.qq.com/connect/qrconnect');
    expect(u.searchParams.get('appid')).toBe('wx_open');
    expect(u.searchParams.get('scope')).toBe('snsapi_login');
    expect(u.searchParams.get('redirect_uri')).toBe('https://www.goapply.top/api/v1/roboapply/auth/wechat/callback');
    expect(u.hash).toBe('#wechat_redirect');
    const row = fake.$rows('rAAuthToken')[0]!;
    expect(row).toMatchObject({ kind: 'oauth_state', brand: 'goapply', tokenHash: sha256(stateOf(url)) });
    expect(JSON.stringify(row)).not.toContain(stateOf(url));
    expect(JSON.stringify(row)).not.toContain(nonce);
    expect((row.payload as { nonceHash: string }).nonceHash).toBe(sha256(nonce));
  });

  it('validates consents before the round trip (422) and never trusts the client prose version', async () => {
    const { s, fake } = setup();
    await expect(s.wechat.startUrl({ brand: goapply, flow: 'web', consents: CN0_CONSENTS.slice(0, 2) })).rejects.toMatchObject({ code: 'consent_required' });
    expect(fake.$rows('rAAuthToken')).toHaveLength(0);
    // A consent that does not name the text shown (no hash) is refused before the round trip, too.
    await expect(s.wechat.startUrl({ brand: goapply, flow: 'web', consents: CN0_CONSENTS_NO_HASH })).rejects.toMatchObject({
      code: 'consent_required',
      details: { outdated: ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'], proseVersion: CONSENT_PROSE_VERSION },
    });
    expect(fake.$rows('rAAuthToken')).toHaveLength(0);
    await s.wechat.startUrl({ brand: goapply, flow: 'web', consents: CN0_CONSENTS.map((c) => ({ ...c, proseVersion: 'x' })) });
    // The pending sign-in keeps the catalog version and hash of the shown text, never the client's version string.
    const payload = fake.$rows('rAAuthToken')[0]!.payload as { consents: Array<{ proseVersion: string; proseHash: string }> };
    expect(payload.consents.map((c) => c.proseVersion)).toEqual([CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION]);
    expect(payload.consents.map((c) => c.proseHash)).toEqual(CN0_CONSENTS.map((c) => c.proseHash));
  });

  it('mp: 公众号 OAuth with snsapi_userinfo (returns unionid)', async () => {
    const { s } = setup();
    const u = new URL((await s.wechat.startUrl({ brand: goapply, flow: 'mp' })).url);
    expect(u.origin + u.pathname).toBe('https://open.weixin.qq.com/connect/oauth2/authorize');
    expect(u.searchParams.get('appid')).toBe('wx_mp');
    expect(u.searchParams.get('scope')).toBe('snsapi_userinfo');
    expect(u.searchParams.get('redirect_uri')).toBe('https://www.goapply.top/api/v1/roboapply/auth/wechat/mp/callback');
  });

  it('reverify needs a signed-in user', async () => {
    const { s } = setup();
    await expect(s.wechat.startUrl({ brand: goapply, flow: 'web', purpose: 'reverify' })).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('callback', () => {
  it('creates a new account (agreement checked) that must bind a phone', async () => {
    const { s, fake } = setup({ codes: { c1: { openid: 'o_web', unionid: 'U1' } } });
    const state = (await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS }));
    const out = await cb(s, { brand: goapply, flow: 'web', code: 'c1', state });
    expect(out).toMatchObject({ kind: 'session', isNew: true, phoneBound: false, nextRoute: '/onboarding/consent' });
    const user = fake.$rows('user')[0]!;
    expect(user).toMatchObject({ brand: 'goapply', provider: 'wechat', emailIsPlaceholder: true, phoneE164: null });
    expect(fake.$rows('rAAuthIdentity')[0]).toMatchObject({ provider: 'wechat', appId: 'wx_open', subject: 'o_web', unionId: 'U1', userId: user.id });
    expect(fake.$rows('seekerConsentRecord').map((r) => r.consentType)).toEqual(['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border']);
    if (out.kind === 'session') await expect(phoneBindingRequired(out.userId, fake as never)).resolves.toBe(true);
  });

  it('is bound to the browser that started it: no or another nonce → oauth_state_invalid, state not spent', async () => {
    const { s, fake } = setup({ codes: { c1: { openid: 'o_web' } } });
    // The attacker starts a sign-in and sends the callback URL to a victim.
    const state = await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS });
    await expect(s.wechat.callback({ brand: goapply, flow: 'web', code: 'c1', state })).resolves.toEqual({ kind: 'error', code: 'oauth_state_invalid' });
    await expect(s.wechat.callback({ brand: goapply, flow: 'web', code: 'c1', state, nonce: 'someone-elses' })).resolves.toEqual({
      kind: 'error',
      code: 'oauth_state_invalid',
    });
    expect(fake.$rows('user')).toHaveLength(0);
    // The browser holding the cookie still completes.
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c1', state })).resolves.toMatchObject({ kind: 'session', isNew: true });
  });

  // Wave FIX gate: WeChat sign-up stored no hash, so G1 and Settings said "you agreed to an earlier
  // version of this text" right after the person agreed to exactly this text.
  it('records the version and hash of the shown text on the new account, so the ledger knows the answer is for the text served now', async () => {
    const env = { ...BASE_ENV, CN_LEGAL_DOCS_VERSION: 'legal-2026-11' };
    const { s, fake } = setup({ env, codes: { c1: { openid: 'o_web' } } });
    const sent = cn0Consents(env);
    const state = await begin(s, { brand: goapply, flow: 'web', consents: sent });
    const out = await cb(s, { brand: goapply, flow: 'web', code: 'c1', state });
    expect(fake.$rows('seekerConsentRecord').map((r) => r.proseVersion)).toEqual([CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION, CONSENT_PROSE_VERSION]);
    expect(fake.$rows('seekerConsentRecord').map((r) => r.proseHash)).toEqual(sent.map((c) => c.proseHash));
    if (out.kind !== 'session') throw new Error('expected a session');
    const items = await listConsents(out.userId, goapply, { env, locale: 'zh' }, { db: fake as unknown as ConsentDb, env });
    for (const type of ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border']) {
      expect(items.find((i) => i.type === type), type).toMatchObject({ granted: true, answeredTextCurrent: true });
    }
  });

  it('refuses a new account when the sign-in did not carry the consents (GET start / crafted link)', async () => {
    const { s, fake } = setup({ codes: { c1: { openid: 'o_web' } } });
    const state = (await begin(s, { brand: goapply, flow: 'web' }));
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c1', state })).resolves.toEqual({ kind: 'error', code: 'consent_required' });
    expect(fake.$rows('user')).toHaveLength(0);
  });

  it('invite mode: a new WeChat account needs a valid invite', async () => {
    const { s } = setup({ env: { ...BASE_ENV, CN_SIGNUP_MODE: 'invite' }, codes: { c1: { openid: 'o_web' } } });
    const state = (await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS }));
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c1', state })).resolves.toEqual({ kind: 'error', code: 'invite_invalid' });
  });

  it('state is single use, brand-bound, flow-bound and expires', async () => {
    const { s, c } = setup({ codes: { c1: { openid: 'o1' }, c2: { openid: 'o2' } } });
    const state = (await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS }));
    await expect(cb(s, { brand: getBrand('roboapply'), flow: 'web', code: 'c1', state })).resolves.toEqual({
      kind: 'error',
      code: 'oauth_state_invalid',
    });
    await expect(cb(s, { brand: goapply, flow: 'mp', code: 'c1', state })).resolves.toEqual({ kind: 'error', code: 'oauth_state_invalid' });
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c1', state })).resolves.toMatchObject({ kind: 'session' });
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c1', state })).resolves.toEqual({ kind: 'error', code: 'oauth_state_invalid' });
    const late = (await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS }));
    c.advance(10 * 60 * 1000 + 1);
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c2', state: late })).resolves.toEqual({ kind: 'error', code: 'oauth_state_invalid' });
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c2' })).resolves.toEqual({ kind: 'error', code: 'oauth_state_invalid' });
  });

  it('a denied authorization or a bad code ends with an error, no account', async () => {
    const { s, fake } = setup();
    const st1 = (await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS }));
    await expect(cb(s, { brand: goapply, flow: 'web', state: st1 })).resolves.toEqual({ kind: 'error', code: 'wechat_denied' });
    const st2 = (await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS }));
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'bogus', state: st2 })).resolves.toEqual({ kind: 'error', code: 'wechat_failed' });
    expect(fake.$rows('user')).toHaveLength(0);
  });

  it('unionId merges identities: the 公众号 sign-in of a web-QR account reaches the same account', async () => {
    const { s, fake } = setup({ codes: { web: { openid: 'o_web', unionid: 'U1' }, mp: { openid: 'o_mp', unionid: 'U1' } } });
    const s1 = (await begin(s, { brand: goapply, flow: 'web', consents: CN0_CONSENTS }));
    const first = await cb(s, { brand: goapply, flow: 'web', code: 'web', state: s1 });
    const s2 = (await begin(s, { brand: goapply, flow: 'mp' }));
    const second = await cb(s, { brand: goapply, flow: 'mp', code: 'mp', state: s2 });
    expect(second).toMatchObject({ kind: 'session', isNew: false });
    expect(first.kind === 'session' && second.kind === 'session' && first.userId === second.userId).toBe(true);
    expect(fake.$rows('user')).toHaveLength(1);
    expect(fake.$rows('rAAuthIdentity').map((i) => [i.appId, i.subject, i.unionId])).toEqual([
      ['wx_open', 'o_web', 'U1'],
      ['wx_mp', 'o_mp', 'U1'],
    ]);
  });

  it('a known WeChat identity with a bound phone needs no bind and lands per onboarding', async () => {
    const { s } = setup({
      codes: { c1: { openid: 'o_web' } },
      seed: {
        user: [{ id: 'u1', email: 'a@users.goapply.invalid', brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date(), isActive: true }],
        seekerProfile: [{ id: 'p1', userId: 'u1', onboardingStep: 'done' }],
        rAAuthIdentity: [{ id: 'i1', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'o_web' }],
      },
    });
    const st = (await begin(s, { brand: goapply, flow: 'web', next: '/resume' }));
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c1', state: st })).resolves.toEqual({
      kind: 'session',
      userId: 'u1',
      isNew: false,
      phoneBound: true,
      nextRoute: '/resume',
    });
  });

  it('reverify issues a single-use token only for the signed-in owner of the identity', async () => {
    const seed = {
      user: [{ id: 'u1', email: 'a@x.invalid', brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date(), isActive: true }],
      rAAuthIdentity: [{ id: 'i1', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'o_web' }],
    };
    const { s, fake } = setup({ codes: { c1: { openid: 'o_web' } }, seed });
    const ok = (await begin(s, { brand: goapply, flow: 'web', purpose: 'reverify', userId: 'u1' }));
    const out = await cb(s, { brand: goapply, flow: 'web', code: 'c1', state: ok });
    expect(out.kind).toBe('reverify');
    const token = out.kind === 'reverify' ? out.token : '';
    expect(fake.$rows('rAAuthToken').find((r) => r.kind === 'wechat_reverify')).toMatchObject({ userId: 'u1', tokenHash: sha256(token) });

    const other = (await begin(s, { brand: goapply, flow: 'web', purpose: 'reverify', userId: 'someone_else' }));
    await expect(cb(s, { brand: goapply, flow: 'web', code: 'c1', state: other })).resolves.toEqual({
      kind: 'error',
      code: 'identity_proof_invalid',
    });
  });
});

describe('miniLogin (API seam)', () => {
  it('creates an account with the required consents and binds the WeChat-verified number', async () => {
    const { s, fake } = setup({ codes: { m1: { openid: 'o_mini', unionid: 'U9' } }, phones: { p1: '13812345678' } });
    const r = await s.wechat.miniLogin({ brand: goapply, code: 'm1', phoneCode: 'p1', consents: CN0_CONSENTS });
    expect(r).toMatchObject({ isNewUser: true, phoneBound: true });
    expect(fake.$rows('user')[0]).toMatchObject({ phoneE164: '+8613812345678', provider: 'wechat' });
  });

  it('requires consents for a new account', async () => {
    const { s } = setup({ codes: { m1: { openid: 'o_mini' } } });
    await expect(s.wechat.miniLogin({ brand: goapply, code: 'm1' })).rejects.toMatchObject({ code: 'consent_required' });
  });

  it('links to the account that already owns the WeChat-verified number', async () => {
    const { s, fake } = setup({
      codes: { m1: { openid: 'o_mini' } },
      phones: { p1: '13812345678' },
      seed: {
        user: [{ id: 'owner', email: 'o@x.invalid', brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date(), isActive: true }],
        seekerProfile: [{ id: 'po', userId: 'owner', onboardingStep: 'done' }],
      },
    });
    await expect(s.wechat.miniLogin({ brand: goapply, code: 'm1', phoneCode: 'p1' })).resolves.toMatchObject({ userId: 'owner', isNewUser: false });
    expect(fake.$rows('rAAuthIdentity')[0]).toMatchObject({ userId: 'owner', appId: 'wx_mini', subject: 'o_mini' });
  });

  it('maps WeChat failures to wechat_failed', async () => {
    const { s } = setup();
    await expect(s.wechat.miniLogin({ brand: goapply, code: 'bad' })).rejects.toMatchObject({ code: 'wechat_failed', status: 502 });
  });
});

describe('phone binding gate (AI features)', () => {
  const seed = {
    user: [
      { id: 'wx', email: 'a@x.invalid', brand: 'goapply', phoneE164: null, phoneVerifiedAt: null },
      { id: 'ph', email: 'b@x.invalid', brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date() },
      { id: 'em', email: 'c@example.com', brand: 'goapply', phoneE164: null, phoneVerifiedAt: null },
      { id: 'intl', email: 'd@example.com', brand: 'roboapply', phoneE164: null, phoneVerifiedAt: null },
    ],
    rAAuthIdentity: [
      { id: 'i1', userId: 'wx', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'o1' },
      { id: 'i2', userId: 'intl', brand: 'roboapply', provider: 'wechat', appId: 'x', subject: 'o2' },
    ],
  };

  it('blocks only GoApply WeChat accounts without a verified phone', async () => {
    const { db } = fakeDb(seed);
    await expect(phoneBindingRequired('wx', db)).resolves.toBe(true);
    await expect(phoneBindingRequired('ph', db)).resolves.toBe(false);
    await expect(phoneBindingRequired('em', db)).resolves.toBe(false);
    await expect(phoneBindingRequired('intl', db)).resolves.toBe(false);
    await expect(hasBoundPhone('ph', db)).resolves.toBe(true);
    await expect(hasBoundPhone('wx', db)).resolves.toBe(false);
    const err = await assertPhoneBound('wx', db).catch((e) => e);
    expect(err).toBeInstanceOf(AuthCnError);
    expect(err).toMatchObject({ code: 'phone_binding_required', status: 403, details: { bindRoute: '/bind-phone' } });
  });
});

describe('returnLocation', () => {
  it('is a relative path on the web return page', () => {
    expect(returnLocation({ result: 'ok', next: '/onboarding/consent', bind: '1' })).toBe('/auth/callback/wechat?result=ok&next=%2Fonboarding%2Fconsent&bind=1');
    expect(returnLocation({ result: 'error', code: 'wechat_failed' })).toBe('/auth/callback/wechat?result=error&code=wechat_failed');
  });
});
