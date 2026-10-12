// @vitest-environment node
//
// GoApply email signup rules (INT-01; GOAPPLY_PARITY_PLAN.md §3.7, D5): open by
// default in every environment (no documents version, SMS or WeChat needed);
// the required consents (incl. the cross-border one whenever data leaves the
// mainland) checked against the compliance catalog; each stored record carries
// the version and hash of the text the form showed (the prose GET
// /auth/phone/policy served), never a hash of a wording the person did not
// see; only with CN_SIGNUP_MODE=invite an invite that is checked early and
// spent inside the caller's transaction; CN_SIGNUP_MODE=closed refuses.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { CONSENT_PROSE_VERSION, consentProseHash, findConsentDefinition, resolveConsentProse } from '../compliance/consents.js';
import { buildSignupPolicy } from '../auth-cn/signupPolicy.js';
import { CN_OWN_STACK_ENV } from '../auth-cn/__tests__/testkit.js';
import { planGoApplyEmailSignup, shownConsentProse, type GoApplyInviteSeam } from './goapplySignup.js';

const goapply = getBrand('goapply');
/**
 * The hash of the text the form shows for a consent (what the policy serves in that language).
 * `env` is the deployment's: the cross-border text names the processors of the stack in use
 * (PAR-5 item 7), so a deployment with other credentials shows, and hashes, another text.
 */
const hashOf = (type: string, locale: 'zh' | 'en' = 'zh', env: Record<string, string | undefined> = process.env) =>
  resolveConsentProse(findConsentDefinition('goapply', type)!, goapply, locale, env).hash;
/** What the form sends on a deployment with `env`: each ticked consent with the hash of the text beside its box. */
const grantedOn = (env: Record<string, string | undefined>, ...types: string[]) =>
  types.map((type) => ({ type, granted: true, proseVersion: 'client-string', ...(findConsentDefinition('goapply', type) ? { proseHash: hashOf(type, 'zh', env) } : {}) }));
const granted = (...types: string[]) => grantedOn(process.env, ...types);
const CN0_TYPES = ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'] as const;
const CN0 = granted(...CN0_TYPES);
/** The default: no CN_SIGNUP_MODE. */
const OPEN = { NODE_ENV: 'test' };
const INVITE = { NODE_ENV: 'test', CN_SIGNUP_MODE: 'invite' };
/** Production with only the shared credentials: no CN_LEGAL_DOCS_VERSION, no SMS, no WeChat. */
const PROD = { NODE_ENV: 'production', RESEND_API_KEY: 're_test' };

function invites(redeemable = true) {
  const seam: GoApplyInviteSeam & { checked: string[]; spent: Array<[unknown, string]> } = {
    checked: [],
    spent: [],
    async isInviteRedeemable(_brand, code) {
      seam.checked.push(code);
      return redeemable;
    },
    async redeemInviteInTx(tx, _brand, code) {
      seam.spent.push([tx, code]);
    },
  };
  return seam;
}

async function code(p: Promise<unknown>): Promise<{ code?: string; status?: number; details?: unknown }> {
  try {
    await p;
    return {};
  } catch (err) {
    const e = err as { code?: string; status?: number; details?: unknown };
    return { code: e.code, status: e.status, details: e.details };
  }
}

describe('planGoApplyEmailSignup', () => {
  it('production with no documents version, SMS or WeChat: the account is planned without an invite code', async () => {
    const seam = invites();
    // The form on this deployment shows its own cross-border text (it names Resend here).
    const plan = await planGoApplyEmailSignup({ consents: grantedOn(PROD, ...CN0_TYPES) }, { env: PROD, invites: seam });
    // A hash of the text another deployment shows is not this deployment's text: asked again.
    expect(await code(planGoApplyEmailSignup({ consents: CN0 }, { env: PROD, invites: seam }))).toMatchObject({ code: 'consent_required', details: { outdated: ['pipl_cross_border'] } });
    expect(plan.inviteRequired).toBe(false);
    expect(plan.consentRows.map((r) => r.consentType).sort()).toEqual(['age_16_plus', 'pipl_basic_processing', 'pipl_cross_border']);
    await plan.redeemInvite({ rABrandInvite: {} } as never);
    expect([seam.checked, seam.spent]).toEqual([[], []]);
    // The same answer whatever the documents version says: it is not a gate.
    const versioned = { ...PROD, CN_LEGAL_DOCS_VERSION: '2026-11' };
    await expect(planGoApplyEmailSignup({ consents: grantedOn(versioned, ...CN0_TYPES) }, { env: versioned })).resolves.toMatchObject({ inviteRequired: false });
  });

  it('CN_SIGNUP_MODE=closed answers signup_closed before anything else is looked at', async () => {
    for (const env of [{ ...PROD, CN_SIGNUP_MODE: 'closed' }, { ...OPEN, CN_SIGNUP_MODE: 'closed' }, { ...PROD, CN_SIGNUP_MODE: 'closed', CN_LEGAL_DOCS_VERSION: '2026-11' }]) {
      const seam = invites();
      expect(await code(planGoApplyEmailSignup({ consents: undefined, inviteCode: 'ABCDE-FGHJK' }, { env, invites: seam }))).toMatchObject({ code: 'signup_closed', status: 403 });
      expect(seam.checked).toEqual([]);
    }
  });

  it('requires the agreement, the age confirmation and, while data leaves the mainland, the cross-border consent', async () => {
    expect(await code(planGoApplyEmailSignup({ consents: granted('age_16_plus') }, { env: OPEN }))).toMatchObject({
      code: 'consent_required',
      status: 422,
      details: { missing: expect.arrayContaining(['pipl_basic_processing', 'pipl_cross_border']) },
    });
    expect(await code(planGoApplyEmailSignup({ consents: undefined }, { env: OPEN }))).toMatchObject({ code: 'consent_required' });
    // A mainland deployment on the shared stack still sends data out of the mainland: the consent is required.
    expect(await code(planGoApplyEmailSignup({ consents: granted('pipl_basic_processing', 'age_16_plus') }, { env: { ...OPEN, DEPLOY_REGION: 'cn-mainland' } }))).toMatchObject({
      code: 'consent_required',
      details: { missing: ['pipl_cross_border'] },
    });
    // Mainland, and every GoApply stack its own: nothing leaves, so the consent is neither asked for nor stored.
    const own = { ...OPEN, ...CN_OWN_STACK_ENV };
    const mainland = await planGoApplyEmailSignup({ consents: granted('pipl_basic_processing', 'age_16_plus') }, { env: own });
    expect(mainland.consentRows.map((r) => r.consentType).sort()).toEqual(['age_16_plus', 'pipl_basic_processing']);
    const mainlandExtra = await planGoApplyEmailSignup({ consents: CN0 }, { env: own });
    expect(mainlandExtra.consentRows.map((r) => r.consentType)).not.toContain('pipl_cross_border');
  });

  it('refuses a consent type that does not exist; ignores ones GoApply does not offer', async () => {
    expect(await code(planGoApplyEmailSignup({ consents: [...CN0, ...granted('made_up')] }, { env: OPEN }))).toMatchObject({
      code: 'consent_required',
      details: { unknown: ['made_up'] },
    });
    const plan = await planGoApplyEmailSignup({ consents: [...CN0, ...granted('tw_pdpa_notice')] }, { env: OPEN });
    expect(plan.consentRows.map((r) => r.consentType)).not.toContain('tw_pdpa_notice');
  });

  // The consent evidence: the stored hash is the hash of the string the form
  // rendered. The form renders `prose.text` from the policy verbatim (web:
  // SignupConsents; components/features/auth-cn/__tests__/authCn.test.tsx)
  // and sends `prose.hash` back.
  it.each(['zh', 'en'] as const)('the hash stored at signup equals the hash of the text the form renders (%s)', async (locale) => {
    const policy = await buildSignupPolicy(goapply, OPEN, locale);
    expect(policy.requiredConsents.map((c) => c.type)).toEqual(['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border']);
    const sent = policy.requiredConsents.map((c) => ({ type: c.type, granted: true, proseVersion: 'client-string', proseHash: c.prose!.hash }));
    const plan = await planGoApplyEmailSignup({ consents: sent }, { env: OPEN });
    expect(plan.consentRows).toHaveLength(3);
    for (const shown of policy.requiredConsents) {
      const row = plan.consentRows.find((r) => r.consentType === shown.type)!;
      // Recomputed from the rendered string itself, not taken from the server's word for it.
      const ofRenderedText = consentProseHash({ brand: 'goapply', type: shown.type, version: shown.prose!.version, locale: shown.prose!.locale, text: shown.prose!.text });
      expect(row).toEqual({ consentType: shown.type, granted: true, proseVersion: CONSENT_PROSE_VERSION, proseHash: ofRenderedText });
      expect(shown.prose!.locale).toBe(locale);
      expect(shown.prose!.text.length).toBeGreaterThan(5);
    }
  });

  it('Chinese and English readers get different records for the same consent; another language is served the English text and says so', async () => {
    const zh = await buildSignupPolicy(goapply, OPEN, 'zh');
    const en = await buildSignupPolicy(goapply, OPEN, 'en');
    const other = await buildSignupPolicy(goapply, OPEN, 'ja');
    const cross = (p: typeof zh) => p.requiredConsents.find((c) => c.type === 'pipl_cross_border')!.prose!;
    expect(cross(zh).hash).not.toBe(cross(en).hash);
    expect(cross(zh).text).toContain('境外');
    expect(cross(en).text).toContain('outside mainland China');
    // GoApply reads in Chinese unless English is asked for.
    expect(cross(other)).toEqual(cross(zh));
    expect((await buildSignupPolicy(goapply, OPEN)).requiredConsents).toEqual(zh.requiredConsents);
  });

  it('refuses a consent sent without the hash of what was shown, or with the hash of a text that is not served', async () => {
    const noHash = CN0.map(({ proseHash: _proseHash, ...c }) => c);
    expect(await code(planGoApplyEmailSignup({ consents: noHash }, { env: OPEN }))).toMatchObject({
      code: 'consent_required',
      status: 422,
      details: { outdated: ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'], proseVersion: CONSENT_PROSE_VERSION },
    });
    // The wording of one consent changed while the form was open (or the hash belongs to another consent).
    const stale = CN0.map((c) => (c.type === 'pipl_cross_border' ? { ...c, proseHash: 'a'.repeat(64) } : c));
    expect(await code(planGoApplyEmailSignup({ consents: stale }, { env: OPEN }))).toMatchObject({ code: 'consent_required', details: { outdated: ['pipl_cross_border'] } });
    const swapped = CN0.map((c) => (c.type === 'pipl_cross_border' ? { ...c, proseHash: hashOf('age_16_plus') } : c));
    expect(await code(planGoApplyEmailSignup({ consents: swapped }, { env: OPEN }))).toMatchObject({ code: 'consent_required', details: { outdated: ['pipl_cross_border'] } });
    // A missed box is reported as missing, not as outdated.
    expect(await code(planGoApplyEmailSignup({ consents: noHash.slice(0, 1) }, { env: OPEN }))).toMatchObject({ details: { missing: expect.any(Array) } });
  });

  it('shownConsentProse names the language whose text was on screen', () => {
    const def = findConsentDefinition('goapply', 'pipl_cross_border')!;
    expect(shownConsentProse(def, goapply, hashOf('pipl_cross_border', 'zh'))).toMatchObject({ locale: 'zh', version: CONSENT_PROSE_VERSION });
    expect(shownConsentProse(def, goapply, hashOf('pipl_cross_border', 'en'))).toMatchObject({ locale: 'en' });
    expect(shownConsentProse(def, goapply, undefined)).toBeNull();
    expect(shownConsentProse(def, goapply, 'not-a-hash')).toBeNull();
  });

  it('writes no row for a text nobody was shown: no product-mail record (the form has no such box)', async () => {
    const plan = await planGoApplyEmailSignup({ consents: [...CN0, { type: 'marketing_email', granted: true, proseVersion: 'x' }] }, { env: OPEN });
    expect(plan.consentRows.map((r) => r.consentType).sort()).toEqual(['age_16_plus', 'pipl_basic_processing', 'pipl_cross_border']);
  });

  it('invite mode: needs a redeemable code, checks it early and spends it only inside the transaction', async () => {
    expect(await code(planGoApplyEmailSignup({ consents: CN0 }, { env: INVITE, invites: invites() }))).toMatchObject({
      code: 'invite_invalid',
      status: 422,
      details: { missing: true },
    });
    expect(await code(planGoApplyEmailSignup({ consents: CN0, inviteCode: '   ' }, { env: INVITE, invites: invites() }))).toMatchObject({ details: { missing: true } });
    const spentAlready = invites(false);
    expect(await code(planGoApplyEmailSignup({ consents: CN0, inviteCode: 'ABCDE-FGHJK' }, { env: INVITE, invites: spentAlready }))).toMatchObject({ code: 'invite_invalid' });
    expect(spentAlready.spent).toEqual([]);

    const seam = invites();
    const plan = await planGoApplyEmailSignup({ consents: CN0, inviteCode: ' ABCDE-FGHJK ' }, { env: INVITE, invites: seam });
    expect(plan.inviteRequired).toBe(true);
    expect(seam.checked).toEqual(['ABCDE-FGHJK']);
    // Nothing is spent until the account-creation transaction runs.
    expect(seam.spent).toEqual([]);
    const tx = { rABrandInvite: {} } as never;
    await plan.redeemInvite(tx);
    expect(seam.spent).toEqual([[tx, 'ABCDE-FGHJK']]);
  });

  it('consents are checked before the invite, so a missed box never costs a lookup or a use', async () => {
    const seam = invites();
    expect(await code(planGoApplyEmailSignup({ consents: granted('age_16_plus'), inviteCode: 'ABCDE-FGHJK' }, { env: INVITE, invites: seam }))).toMatchObject({
      code: 'consent_required',
    });
    expect(seam.checked).toEqual([]);
  });

  it('open mode: no invite is asked for, and one that was sent is not spent', async () => {
    const seam = invites();
    const plan = await planGoApplyEmailSignup({ consents: CN0, inviteCode: 'ABCDE-FGHJK' }, { env: OPEN, invites: seam });
    expect(plan.inviteRequired).toBe(false);
    await plan.redeemInvite({ rABrandInvite: {} } as never);
    expect(seam.checked).toEqual([]);
    expect(seam.spent).toEqual([]);
  });
});
