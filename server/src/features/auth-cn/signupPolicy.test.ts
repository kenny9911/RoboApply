// @vitest-environment node
//
// Who may create a GoApply account (GOAPPLY_PARITY_PLAN.md §3.7, D5): open by
// default in every environment; `CN_SIGNUP_MODE=invite|closed` narrows it; the
// cross-border consent is asked whenever GoApply data leaves the mainland.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../services/LoggerService.js', () => ({ logger: log }));

// The compliance catalog's "required" rule is another bundle's (PAR-5). A test
// below widens it to prove the sign-up list follows the catalog whatever that
// rule becomes; everywhere else the real rule runs.
const catalog = vi.hoisted(() => ({ alsoRequired: [] as string[] }));
vi.mock('../compliance/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compliance/index.js')>();
  return {
    ...actual,
    isConsentRequired: (def: Parameters<typeof actual.isConsentRequired>[0], ctx: Parameters<typeof actual.isConsentRequired>[1]) =>
      catalog.alsoRequired.includes(def.type) || actual.isConsentRequired(def, ctx),
  };
});

import { getBrand } from '../../platform/brand/registry.js';
import { brandUsesSharedStack } from '../../platform/brand/brandEnv.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { AUTH_CN_CONSENT_PROSE_VERSION, requiredSignupConsentTypes } from './contract.js';
import {
  assertSignupOpen,
  buildSignupPolicy,
  checkSignupConsents,
  cnSignupMode,
  cnSignupModeProblem,
  cnSignupModeWarning,
  crossBorderConsentRequired,
  goapplySignupOpen,
  requiredSignupConsents,
} from './signupPolicy.js';
import { createPhoneAuthRouter } from './routes.js';
import { planGoApplyEmailSignup } from '../auth/goapplySignup.js';
import { CN_OWN_STACK_ENV } from './__tests__/testkit.js';

const goapply = getBrand('goapply');

beforeAll(() => setFlagOverrideLoader(async () => []));
afterAll(() => setFlagOverrideLoader(null));
afterEach(() => {
  catalog.alsoRequired = [];
  log.error.mockClear();
});

/** Production with only the shared credentials: no legal-documents version, no SMS, no WeChat. */
const PROD_SHARED = { NODE_ENV: 'production', RESEND_API_KEY: 're_test' };

describe('CN_SIGNUP_MODE', () => {
  it('is open unless it says invite or closed', () => {
    expect(cnSignupMode({})).toBe('open');
    expect(cnSignupMode({ CN_SIGNUP_MODE: '' })).toBe('open');
    expect(cnSignupMode({ CN_SIGNUP_MODE: 'open' })).toBe('open');
    expect(cnSignupMode({ CN_SIGNUP_MODE: ' Invite ' })).toBe('invite');
    expect(cnSignupMode({ CN_SIGNUP_MODE: 'CLOSED' })).toBe('closed');
    // Not one of the three: open, and reported.
    expect(cnSignupMode({ CN_SIGNUP_MODE: 'off' })).toBe('open');
  });

  it('names a value that is none of the three, so a mistyped switch is not silent', () => {
    for (const ok of [undefined, '', '  ', 'open', 'invite', 'closed', ' Closed ']) expect(cnSignupModeProblem({ CN_SIGNUP_MODE: ok })).toBeNull();
    for (const bad of ['off', 'false', 'invite_only', 'close', '0']) expect(cnSignupModeProblem({ CN_SIGNUP_MODE: bad })).toBe(bad);
    expect(cnSignupModeProblem({ CN_SIGNUP_MODE: ' Invited ' })).toBe('Invited');
  });

  it('the phone-auth router, built at boot, logs a mistyped value once per process and nothing for a valid one', () => {
    expect(cnSignupModeWarning({ CN_SIGNUP_MODE: 'invite' })).toBeNull();
    expect(cnSignupModeWarning({})).toBeNull();
    expect(cnSignupModeWarning({ CN_SIGNUP_MODE: 'invite-only' })).toBe(
      'unknown CN_SIGNUP_MODE value "invite-only"; GoApply sign-up is OPEN. Use invite or closed.',
    );
    expect(cnSignupModeWarning({ CN_SIGNUP_MODE: 'x'.repeat(200) })).toContain(`"${'x'.repeat(40)}"`);

    for (const CN_SIGNUP_MODE of [undefined, 'open', 'invite', 'closed']) createPhoneAuthRouter({ env: { CN_SIGNUP_MODE } });
    expect(log.error).not.toHaveBeenCalled();

    createPhoneAuthRouter({ env: { CN_SIGNUP_MODE: 'invite-only' } });
    createPhoneAuthRouter({ env: { CN_SIGNUP_MODE: 'invite-only' } });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('AUTH_CN', 'unknown CN_SIGNUP_MODE value "invite-only"; GoApply sign-up is OPEN. Use invite or closed.');
  });

  it('sign-up is open in every environment with no legal-documents version; only `closed` refuses', () => {
    for (const NODE_ENV of ['production', 'development', 'test', undefined]) {
      expect(goapplySignupOpen({ NODE_ENV })).toBe(true);
      expect(goapplySignupOpen({ NODE_ENV, CN_SIGNUP_MODE: 'invite' })).toBe(true);
      expect(goapplySignupOpen({ NODE_ENV, CN_SIGNUP_MODE: 'closed' })).toBe(false);
      // The documents version is not a gate any more, in either direction.
      expect(goapplySignupOpen({ NODE_ENV, CN_SIGNUP_MODE: 'closed', CN_LEGAL_DOCS_VERSION: '2026-11' })).toBe(false);
    }
    expect(() => assertSignupOpen(PROD_SHARED)).not.toThrow();
    expect(() => assertSignupOpen({ ...PROD_SHARED, CN_SIGNUP_MODE: 'closed' })).toThrowError(expect.objectContaining({ code: 'signup_closed', status: 403 }));
  });
});

describe('the cross-border consent', () => {
  it('is required offshore, and on the mainland whenever GoApply runs on the shared stack', () => {
    expect(crossBorderConsentRequired({})).toBe(true);
    expect(crossBorderConsentRequired({ DEPLOY_REGION: 'us-east-1' })).toBe(true);
    // The mainland kit with no CN_ provider: the data still leaves the mainland.
    expect(brandUsesSharedStack('goapply', { DEPLOY_REGION: 'cn-mainland' })).toBe(true);
    expect(crossBorderConsentRequired({ DEPLOY_REGION: 'cn-mainland' })).toBe(true);
    // Every stack its own, on the mainland: nothing leaves.
    expect(crossBorderConsentRequired(CN_OWN_STACK_ENV)).toBe(false);
    // One shared piece is enough (here: email through the shared transport).
    expect(crossBorderConsentRequired({ ...CN_OWN_STACK_ENV, CN_EMAIL_TRANSPORT: 'resend' })).toBe(true);
    expect(crossBorderConsentRequired({ ...CN_OWN_STACK_ENV, CN_S3_BUCKET: '' })).toBe(true);
    // The same own stack run offshore is still offshore.
    expect(crossBorderConsentRequired({ ...CN_OWN_STACK_ENV, DEPLOY_REGION: 'ap-southeast-1' })).toBe(true);
  });

  it('decides the required consent types, each with a version even when no documents version is set', async () => {
    expect(requiredSignupConsentTypes(true)).toEqual(['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border']);
    expect(requiredSignupConsentTypes(false)).toEqual(['pipl_basic_processing', 'age_16_plus']);
    expect(await requiredSignupConsents(PROD_SHARED)).toEqual(
      ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'].map((type) => ({ type, proseVersion: AUTH_CN_CONSENT_PROSE_VERSION })),
    );
    expect(await requiredSignupConsents({ ...CN_OWN_STACK_ENV, CN_LEGAL_DOCS_VERSION: 'legal-2026-11' })).toEqual([
      { type: 'pipl_basic_processing', proseVersion: 'legal-2026-11' },
      { type: 'age_16_plus', proseVersion: 'legal-2026-11' },
    ]);
  });

  // The catalog's rule may become wider than the predicate here (PAR-1 handoff
  // P5-5: a database override that sends GoApply work to the shared model
  // stack). Then the box must be on the page and every path must ask for it:
  // no path may demand a consent the form did not show, and none may skip it.
  it('one list for the form and for every sign-up path: a consent the catalog requires is shown, asked for and stored on all of them', async () => {
    const env = CN_OWN_STACK_ENV;
    expect(crossBorderConsentRequired(env)).toBe(false);
    const two = ['pipl_basic_processing', 'age_16_plus'];
    const three = [...two, 'pipl_cross_border'];
    expect((await buildSignupPolicy(goapply, env, 'zh')).requiredConsents.map((c) => c.type)).toEqual(two);

    catalog.alsoRequired = ['pipl_cross_border'];
    expect((await requiredSignupConsents(env)).map((c) => c.type)).toEqual(three);
    const shown = (await buildSignupPolicy(goapply, env, 'zh')).requiredConsents;
    expect(shown.map((c) => c.type)).toEqual(three);
    for (const c of shown) expect(c.prose?.hash).toBeTruthy();
    const ticked = (types: string[]) =>
      shown.filter((c) => types.includes(c.type)).map((c) => ({ type: c.type, granted: true, proseVersion: c.proseVersion, proseHash: c.prose!.hash }));

    // Phone and WeChat (checkSignupConsents) and email (planGoApplyEmailSignup) agree.
    await expect(checkSignupConsents(ticked(two), goapply, env)).rejects.toMatchObject({ code: 'consent_required', details: { missing: ['pipl_cross_border'] } });
    await expect(planGoApplyEmailSignup({ consents: ticked(two) }, { env })).rejects.toMatchObject({
      code: 'consent_required',
      details: { missing: ['pipl_cross_border'] },
    });
    expect((await checkSignupConsents(ticked(three), goapply, env)).map((r) => r.type)).toEqual(three);
    const plan = await planGoApplyEmailSignup({ consents: ticked(three) }, { env });
    expect(plan.consentRows.map((r) => r.consentType)).toEqual(three);
    for (const row of plan.consentRows) expect(row.proseHash).toBeTruthy();
  });
});

describe('buildSignupPolicy', () => {
  it('production, no CN_LEGAL_DOCS_VERSION, no SMS, no WeChat: open, no invite, every consent with its text', async () => {
    const policy = await buildSignupPolicy(goapply, PROD_SHARED, 'zh');
    expect(policy).toMatchObject({
      signupOpen: true,
      inviteRequired: false,
      methods: { phoneOtp: false, wechatWeb: false, wechatInApp: false },
    });
    expect(policy.requiredConsents.map((c) => c.type)).toEqual(['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border']);
    for (const c of policy.requiredConsents) expect(c.prose?.text.length).toBeGreaterThan(5);
  });

  it('invite mode asks for a code and stays open; closed mode says so', async () => {
    expect(await buildSignupPolicy(goapply, { ...PROD_SHARED, CN_SIGNUP_MODE: 'invite' })).toMatchObject({ signupOpen: true, inviteRequired: true });
    expect(await buildSignupPolicy(goapply, { ...PROD_SHARED, CN_SIGNUP_MODE: 'closed' })).toMatchObject({ signupOpen: false, inviteRequired: false });
  });

  it('does not depend on a phone or WeChat capability: the same answer with and without an SMS provider', async () => {
    const withSms = await buildSignupPolicy(goapply, { ...PROD_SHARED, SMS_DEV_CONSOLE: 'true', NODE_ENV: 'development' });
    expect(withSms).toMatchObject({ signupOpen: true, inviteRequired: false, methods: { phoneOtp: true } });
  });
});
