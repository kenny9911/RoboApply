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
import { clampLocaleToBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { isEnabled } from '../../platform/flags.js';
import { isSeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import {
  AUTH_CN_CONSENT_PROSE_VERSION,
  requiredSignupConsentTypes,
  type ConsentInput,
  type SignupPolicyConsent,
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
 * Validates the consents a NEW phone or WeChat account sends: every required
 * type granted; unknown types rejected. Returns the rows to record: the
 * required types only.
 *
 * What is stored is what was shown (the same rule as the email form,
 * features/auth/goapplySignup.ts). The form shows, beside each box, the
 * catalog prose GET /auth/phone/policy served and sends that text's hash back
 * (`proseHash`). A row carries the catalog version and hash of the served text
 * the hash belongs to, so the consent ledger can later tell whether the text
 * has changed since (`answeredTextCurrent`). A required consent without a
 * hash, or with the hash of a text no longer served, is refused with
 * `consent_required { outdated }`: the form reloads the text and asks again.
 * The client's `proseVersion` string is never stored.
 *
 * A required type the catalog has no text for (the policy served none, so
 * there is nothing to hash) is recorded with the sign-up policy's version
 * (`CN_LEGAL_DOCS_VERSION`, else the area default) and no hash.
 */
export async function checkSignupConsents(
  consents: ConsentInput[] | undefined,
  brand: ProductBrand,
  env: EnvSource = process.env,
): Promise<ConsentInput[]> {
  const granted = new Map<string, boolean>();
  const shownHash = new Map<string, string>();
  for (const c of consents ?? []) {
    if (!isSeekerConsentType(c.type)) throw new AuthCnError('consent_required', { unknown: [c.type] });
    granted.set(c.type, c.granted);
    if (typeof c.proseHash === 'string' && c.proseHash) shownHash.set(c.type, c.proseHash);
    else shownHash.delete(c.type);
  }
  const required = requiredSignupConsents(env);
  const missing = required.filter((r) => granted.get(r.type) !== true).map((r) => r.type);
  if (missing.length) throw new AuthCnError('consent_required', { missing });

  // Lazy, like the policy below: the compliance area is loaded only when a sign-up needs its text.
  const { CONSENT_PROSE_VERSION, findConsentDefinition, servedConsentProseByHash } = await import('../compliance/index.js');
  const rows: ConsentInput[] = [];
  const outdated: string[] = [];
  for (const r of required) {
    const def = findConsentDefinition(brand.id, r.type);
    if (!def) {
      rows.push({ type: r.type, granted: true, proseVersion: r.proseVersion });
      continue;
    }
    const shown = servedConsentProseByHash(def, brand, shownHash.get(r.type), env);
    if (!shown) outdated.push(r.type);
    else rows.push({ type: r.type, granted: true, proseVersion: shown.version, proseHash: shown.hash });
  }
  if (outdated.length) throw new AuthCnError('consent_required', { outdated, proseVersion: CONSENT_PROSE_VERSION });
  return rows;
}

/** Throws unless a new GoApply account may be created right now. */
export function assertSignupOpen(env: EnvSource = process.env): void {
  if (!goapplySignupOpen(env)) throw new AuthCnError('signup_closed');
}

/**
 * The required signup consents with the text the form shows for each: the
 * compliance catalog prose in `locale` (clamped to the brand; English where
 * the catalog has no text in that language), its version and its hash. The
 * form renders `prose.text` verbatim, so the hash names what was on screen.
 */
export async function requiredSignupConsentsWithProse(
  brand: ProductBrand,
  env: EnvSource = process.env,
  locale?: string | null,
): Promise<SignupPolicyConsent[]> {
  // Lazy: the compliance area is loaded only when a signup form asks for its text.
  const { findConsentDefinition, resolveConsentProse } = await import('../compliance/index.js');
  const lang = clampLocaleToBrand(brand, locale ?? brand.defaultLocale);
  return requiredSignupConsents(env).map((required) => {
    const def = findConsentDefinition(brand.id, required.type);
    if (!def) return required;
    // `env` too: the cross-border text names this deployment's processors, the same facts /legal renders (FIX-8).
    const { text, locale: proseLocale, version, hash } = resolveConsentProse(def, brand, lang, env);
    return { ...required, prose: { text, locale: proseLocale, version, hash } };
  });
}

export async function buildSignupPolicy(brand: ProductBrand, env: EnvSource = process.env, locale?: string | null): Promise<SignupPolicyResponse> {
  const [phoneOtp, wechatWeb, wechatInApp] = await Promise.all([
    isEnabled('auth.phoneOtp', { brand, env }),
    isEnabled('auth.wechatWeb', { brand, env }),
    isEnabled('auth.wechatInApp', { brand, env }),
  ]);
  return {
    // CN §2.3 rule 4: documents approved AND phone OTP or WeChat web live (production).
    signupOpen: goapplySignupOpen(env) && (env.NODE_ENV !== 'production' || phoneOtp || wechatWeb),
    inviteRequired: cnSignupMode(env) === 'invite',
    requiredConsents: await requiredSignupConsentsWithProse(brand, env, locale),
    methods: { phoneOtp, wechatWeb, wechatInApp },
    legal: { termsPath: brand.legal.termsPath, privacyPath: brand.legal.privacyPath },
  };
}

/** Public origin for absolute links (WeChat redirect_uri). */
export function publicOrigin(brand: ProductBrand, env: EnvSource = process.env): string {
  return (brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).replace(/\/+$/, '');
}
