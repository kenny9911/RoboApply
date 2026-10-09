// server/src/features/auth-cn/signupPolicy.ts — who may create a GoApply account
// (CN_TW_LAUNCH_PLAN.md §2.3 rule 4, §3; TASK_PLAN.md WP-11, H6).
//
//   - Production: signup is closed unless `CN_LEGAL_DOCS_VERSION` is set
//     (counsel-approved documents) AND the method being used is live. Phone
//     and WeChat routes are only reachable when their capability is live, so
//     the check here is the documents version. Development and preview stay
//     open so the flow can be exercised.
//   - `CN_SIGNUP_MODE=invite` (the default when unset — CN-0 is invite-only):
//     a new account needs a valid invite code. `open` drops the requirement.
//   - CN-0 (data processed outside the mainland, i.e. any deployment whose
//     `DEPLOY_REGION` is not `cn-mainland`): the separate cross-border
//     consent `pipl_cross_border` is required at signup.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { brandEnv } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { isEnabled } from '../../platform/flags.js';
import { isSeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import {
  AUTH_CN_CONSENT_PROSE_VERSION,
  requiredSignupConsentTypes,
  type ConsentInput,
  type SignupPolicyResponse,
} from './contract.js';
import { AuthCnError } from './errors.js';

export type SignupMode = 'invite' | 'open';

export function cnSignupMode(env: EnvSource = process.env): SignupMode {
  return (env.CN_SIGNUP_MODE || '').trim().toLowerCase() === 'open' ? 'open' : 'invite';
}

/** CN-0: the deployment processes GoApply data outside the mainland. */
export function isCn0(env: EnvSource = process.env): boolean {
  return (env.DEPLOY_REGION || '').trim().toLowerCase() !== 'cn-mainland';
}

/** CN §2.3 rule 4 (documents part); the live-method part is the route's capability gate. */
export function goapplySignupOpen(env: EnvSource = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return Boolean((env.CN_LEGAL_DOCS_VERSION || '').trim());
}

export function requiredSignupConsents(env: EnvSource = process.env): Array<{ type: string; proseVersion: string }> {
  const version = (env.CN_LEGAL_DOCS_VERSION || '').trim() || AUTH_CN_CONSENT_PROSE_VERSION;
  return requiredSignupConsentTypes(isCn0(env)).map((type) => ({ type, proseVersion: version }));
}

/**
 * Validates the consents a NEW account sends: every required type granted;
 * unknown types rejected. Returns the rows to record: the required types
 * only, each with the SERVER's prose version (`CN_LEGAL_DOCS_VERSION`, else
 * the area default). The client's `proseVersion` is never stored — the
 * record must name the legal text the server was serving when the person
 * accepted it, not whatever string a client sent.
 */
export function checkSignupConsents(consents: ConsentInput[] | undefined, env: EnvSource = process.env): ConsentInput[] {
  const granted = new Map<string, boolean>();
  for (const c of consents ?? []) {
    if (!isSeekerConsentType(c.type)) throw new AuthCnError('consent_required', { unknown: [c.type] });
    granted.set(c.type, c.granted);
  }
  const required = requiredSignupConsents(env);
  const missing = required.filter((r) => granted.get(r.type) !== true).map((r) => r.type);
  if (missing.length) throw new AuthCnError('consent_required', { missing });
  return required.map((r) => ({ type: r.type, granted: true, proseVersion: r.proseVersion }));
}

/** Throws unless a new GoApply account may be created right now. */
export function assertSignupOpen(env: EnvSource = process.env): void {
  if (!goapplySignupOpen(env)) throw new AuthCnError('signup_closed');
}

export async function buildSignupPolicy(brand: ProductBrand, env: EnvSource = process.env): Promise<SignupPolicyResponse> {
  const [phoneOtp, wechatWeb, wechatInApp] = await Promise.all([
    isEnabled('auth.phoneOtp', { brand, env }),
    isEnabled('auth.wechatWeb', { brand, env }),
    isEnabled('auth.wechatInApp', { brand, env }),
  ]);
  return {
    // CN §2.3 rule 4: documents approved AND phone OTP or WeChat web live (production).
    signupOpen: goapplySignupOpen(env) && (env.NODE_ENV !== 'production' || phoneOtp || wechatWeb),
    inviteRequired: cnSignupMode(env) === 'invite',
    requiredConsents: requiredSignupConsents(env),
    methods: { phoneOtp, wechatWeb, wechatInApp },
    legal: { termsPath: brand.legal.termsPath, privacyPath: brand.legal.privacyPath },
  };
}

/** Public origin for absolute links (WeChat redirect_uri). */
export function publicOrigin(brand: ProductBrand, env: EnvSource = process.env): string {
  return (brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).replace(/\/+$/, '');
}
