// server/src/features/auth-cn/signupPolicy.ts — who may create a GoApply account
// (GOAPPLY_PARITY_PLAN.md §3.7, owner ruling D5; supersedes the invite-only
// rule of CN_TW_LAUNCH_PLAN.md §2.3 rule 4).
//
//   - Sign-up is OPEN by default, in every environment, with email + password.
//     It needs no legal-documents version, no SMS provider and no WeChat
//     credentials: the consents below always have a text and a version
//     (`CN_LEGAL_DOCS_VERSION`, else the built-in prose version).
//   - `CN_SIGNUP_MODE` is the operator's switch: `open` (the default, also for
//     an unset or unknown value), `invite` (a new account needs a valid invite
//     code) or `closed` (no new account; existing accounts still sign in).
//     `cnSignupModeProblem` names a value that is none of the three, and the
//     phone-auth router logs it once when it is built (at boot).
//   - The separate cross-border consent `pipl_cross_border` is required at
//     sign-up whenever GoApply data leaves the mainland: the deployment is
//     offshore (`DEPLOY_REGION` is not `cn-mainland`), OR GoApply runs on the
//     shared stack (`brandUsesSharedStack`: the shared model routes, email,
//     voice, storage or push). One predicate, `crossBorderConsentRequired`;
//     the consent catalog computes the same one (plan §5, `crossBorderApplies`).
//   - ONE list of required consents, `requiredSignupConsents`, for the form
//     (the boxes it shows) and for all three sign-up paths (email, phone,
//     WeChat): the types above, plus every sign-up consent the compliance
//     catalog says is required on this deployment. So if the catalog's rule
//     ever asks for more than the predicate here (a database override that
//     sends GoApply work to the shared model stack, PAR-1 handoff P5-5), the
//     box is on the page and every path asks for it and stores it. No path
//     can demand a consent the form did not show.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { brandEnv, brandUsesSharedStack } from '../../platform/brand/brandEnv.js';
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

export type SignupMode = 'open' | 'invite' | 'closed';

const SIGNUP_MODES: readonly SignupMode[] = ['open', 'invite', 'closed'];

function rawSignupMode(env: EnvSource): string {
  return (env.CN_SIGNUP_MODE || '').trim().toLowerCase();
}

/** `open` unless `CN_SIGNUP_MODE` is `invite` or `closed` (D5: GoApply sign-up is open by default). */
export function cnSignupMode(env: EnvSource = process.env): SignupMode {
  const raw = rawSignupMode(env);
  return raw === 'invite' || raw === 'closed' ? raw : 'open';
}

/**
 * The raw `CN_SIGNUP_MODE` when it is set and is none of `open | invite |
 * closed` (case and spaces ignored), else null. Such a value leaves sign-up
 * OPEN, so an operator who meant to close it (`CN_SIGNUP_MODE=off`) can be
 * told at boot instead of finding out from new accounts.
 */
export function cnSignupModeProblem(env: EnvSource = process.env): string | null {
  const raw = rawSignupMode(env);
  return raw && !(SIGNUP_MODES as readonly string[]).includes(raw) ? (env.CN_SIGNUP_MODE || '').trim() : null;
}

/**
 * The log line for `cnSignupModeProblem`, or null. The value is cut to 40
 * characters: it is an operator's typo, not something to print at length.
 */
export function cnSignupModeWarning(env: EnvSource = process.env): string | null {
  const value = cnSignupModeProblem(env);
  return value === null ? null : `unknown CN_SIGNUP_MODE value "${value.slice(0, 40)}"; GoApply sign-up is OPEN. Use invite or closed.`;
}

/** CN-0: the deployment processes GoApply data outside the mainland. */
export function isCn0(env: EnvSource = process.env): boolean {
  return (env.DEPLOY_REGION || '').trim().toLowerCase() !== 'cn-mainland';
}

/**
 * True when a new GoApply account must grant the separate cross-border
 * consent: the deployment is offshore, or GoApply resolves any part of its
 * stack to the shared (offshore) one. Env only: an admin override in the
 * database that sends a GoApply task to the shared model stack, or a GoApply
 * model provider that is itself abroad, is invisible here (PAR-1 handoff
 * P5-5). The consent catalog sees those, and `requiredSignupConsents` adds
 * whatever the catalog requires, so sign-up asks for the consent then too.
 * Ask `requiredSignupConsents`, not this function, what a new account must grant.
 */
export function crossBorderConsentRequired(env: EnvSource = process.env): boolean {
  return isCn0(env) || brandUsesSharedStack('goapply', env);
}

/** A new GoApply account may be created unless the operator closed sign-up (`CN_SIGNUP_MODE=closed`). */
export function goapplySignupOpen(env: EnvSource = process.env): boolean {
  return cnSignupMode(env) !== 'closed';
}

/**
 * The consents a new GoApply account must grant, in the order the form shows
 * them: the sign-up types (`requiredSignupConsentTypes`), then any other
 * sign-up consent the compliance catalog requires on this deployment. The
 * single list behind the policy endpoint and the email, phone and WeChat
 * sign-up checks, so what is asked always equals what is shown.
 */
export async function requiredSignupConsents(env: EnvSource = process.env): Promise<Array<{ type: string; proseVersion: string }>> {
  const version = (env.CN_LEGAL_DOCS_VERSION || '').trim() || AUTH_CN_CONSENT_PROSE_VERSION;
  const types = new Set(requiredSignupConsentTypes(crossBorderConsentRequired(env)));
  // Lazy, like the prose lookups below: the compliance area is loaded only when a sign-up needs it.
  const { consentDefinitionsFor, isConsentRequired } = await import('../compliance/index.js');
  for (const def of consentDefinitionsFor('goapply')) {
    if (def.stage === 'signup' && isConsentRequired(def, { env })) types.add(def.type);
  }
  return [...types].map((type) => ({ type, proseVersion: version }));
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
  const required = await requiredSignupConsents(env);
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
  return (await requiredSignupConsents(env)).map((required) => {
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
    // Open unless the operator closed it. Email + password is always there, so
    // no phone or WeChat capability is needed for a new account (D5).
    signupOpen: goapplySignupOpen(env),
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
