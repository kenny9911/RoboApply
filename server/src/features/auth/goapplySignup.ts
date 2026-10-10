// server/src/features/auth/goapplySignup.ts
//
// What an email + password signup on GoApply must satisfy before the account
// exists (CN_TW_LAUNCH_PLAN.md §2.3 rule 4, §3; TASK_PLAN.md H6; INT-01). The
// phone and WeChat flows (features/auth-cn) apply the same rules; this is the
// email twin, called by SeekerAuthService.signup.
//
//   - Production: closed unless counsel-approved documents are configured
//     (`goapplySignupOpen`, 403 signup_closed).
//   - Consents: the required types come from auth-cn `requiredSignupConsents`
//     (the agreement, the age confirmation and, while data is processed
//     outside the mainland, the separate cross-border consent). They are
//     checked through the compliance catalog. A missing one → 422
//     consent_required with `details.missing`.
//   - What is stored is what was shown. The form shows, beside each box, the
//     catalog prose that GET /auth/phone/policy served (`prose.text`) and
//     sends that text's hash back (`proseHash`). A row is written only when
//     the hash equals the hash of a text this server serves for that consent
//     (in Chinese or English); the row then carries that version and hash.
//     A consent without a hash, or with the hash of a text that is no longer
//     served (the wording changed while the form was open), is refused with
//     422 consent_required and `details.outdated`, and the form reloads the
//     text. The client's `proseVersion` string is never stored.
//   - Invite mode (`CN_SIGNUP_MODE=invite`, the default): a code is required
//     (422 invite_invalid, `details.missing` when absent). It is checked
//     early (no use spent) and spent by `redeemInvite(tx)` INSIDE the
//     transaction that creates the User, so a failed redemption rolls the
//     account back and the last use of a code cannot be spent twice.
//
// Everything here runs before the email is looked up, so the answer never
// depends on whether an account exists on either brand.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { isSeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import { AuthCnError, cnSignupMode, goapplySignupOpen, requiredSignupConsents, type InviteTx } from '../auth-cn/index.js';
import {
  CONSENT_PROSE_VERSION,
  findConsentDefinition,
  isConsentApplicable,
  servedConsentProseByHash,
  validateSignupConsents as validateAgainstCatalog,
  type ConsentDefinition,
  type ConsentProseLocale,
} from '../compliance/index.js';
import type { ConsentRow, SignupConsentInput } from './signupPolicy.js';

const BRAND = 'goapply' as const;

export interface GoApplyInviteSeam {
  /** Read-only: would this code work now? */
  isInviteRedeemable(brand: typeof BRAND, code: string): Promise<boolean>;
  /** Spend one use inside the account-creation transaction. Throws AuthCnError('invite_invalid'). */
  redeemInviteInTx(tx: InviteTx, brand: typeof BRAND, code: string): Promise<void>;
}

export interface GoApplySignupDeps {
  env?: EnvSource;
  /** Default: `authCnService` (features/auth-cn). */
  invites?: GoApplyInviteSeam;
}

export interface GoApplySignupPlan {
  /** Rows to write with the account (required consents, server prose version + hash). */
  consentRows: ConsentRow[];
  /** True when an invite will be spent. */
  inviteRequired: boolean;
  /** Call inside the transaction that creates the User, before the create. No-op in open mode. */
  redeemInvite(tx: InviteTx): Promise<void>;
}

/**
 * The served text whose hash is `hash`: the text the form showed. Null when
 * the hash is absent or matches nothing this server serves for the consent.
 * `env` is the deployment the sign-up policy was served from (the cross-border
 * text names its processors), so the form's hash and this lookup agree. The
 * phone and WeChat flows use the same lookup (auth-cn `checkSignupConsents`).
 */
export function shownConsentProse(
  def: ConsentDefinition,
  brand: ProductBrand,
  hash: string | null | undefined,
  env: EnvSource = process.env,
): { version: string; hash: string; locale: ConsentProseLocale } | null {
  const prose = servedConsentProseByHash(def, brand, hash, env);
  return prose ? { version: prose.version, hash: prose.hash, locale: prose.locale } : null;
}

async function defaultInvites(): Promise<GoApplyInviteSeam> {
  // Lazy, like this whole module: SeekerAuthService loads it only for a GoApply signup.
  return (await import('../auth-cn/index.js')).authCnService;
}

/** Validate a GoApply email signup. Throws AuthCnError (signup_closed 403, consent_required 422, invite_invalid 422). */
export async function planGoApplyEmailSignup(
  input: {
    /** Each required consent with the `proseHash` of the text the form showed. */
    consents: readonly SignupConsentInput[] | undefined;
    inviteCode?: string | null;
  },
  deps: GoApplySignupDeps = {},
): Promise<GoApplySignupPlan> {
  const env = deps.env ?? process.env;
  if (!goapplySignupOpen(env)) throw new AuthCnError('signup_closed');

  const brand = getBrand(BRAND);
  const ctx = { env };

  // The visitor's answers, latest per type. An unknown type is refused, as on the phone flow.
  const answers = new Map<string, boolean>();
  const shownHash = new Map<string, string>();
  for (const c of input.consents ?? []) {
    if (!isSeekerConsentType(c.type)) throw new AuthCnError('consent_required', { unknown: [c.type] });
    answers.set(c.type, c.granted === true);
    if (typeof c.proseHash === 'string' && c.proseHash) shownHash.set(c.type, c.proseHash);
    else shownHash.delete(c.type);
  }

  // Checked against the catalog with the server's prose version. Types the
  // catalog does not offer here are left out rather than failing the signup.
  const submitted = [...answers]
    .filter(([type]) => {
      const def = findConsentDefinition(BRAND, type);
      return Boolean(def && isConsentApplicable(def, ctx));
    })
    .map(([type, granted]) => ({ type, granted, proseVersion: CONSENT_PROSE_VERSION }));
  const check = validateAgainstCatalog(BRAND, submitted, ctx);
  const policy = requiredSignupConsents(env);
  const required = new Set<string>([...policy.map((r) => r.type), ...check.missing]);
  const missing = [...required].filter((type) => answers.get(type) !== true);
  if (missing.length) throw new AuthCnError('consent_required', { missing });

  // Each row names the text that was on screen: the served text whose hash
  // the form sent back. Nothing is recorded for a text nobody was shown, so
  // there is no row for product mail here (GoApply's form has no such box).
  const consentRows: ConsentRow[] = [];
  const outdated: string[] = [];
  for (const type of required) {
    const def = findConsentDefinition(BRAND, type);
    if (!def) {
      // A required type the catalog has no prose for is still recorded (with
      // the sign-up policy's version, no hash) rather than silently dropped.
      const fromPolicy = policy.find((r) => r.type === type);
      if (fromPolicy && isSeekerConsentType(type)) consentRows.push({ consentType: type, granted: true, proseVersion: fromPolicy.proseVersion });
      continue;
    }
    const shown = shownConsentProse(def, brand, shownHash.get(type), env);
    if (!shown) outdated.push(type);
    else consentRows.push({ consentType: def.type, granted: true, proseVersion: shown.version, proseHash: shown.hash });
  }
  if (outdated.length) throw new AuthCnError('consent_required', { outdated, proseVersion: CONSENT_PROSE_VERSION });

  const inviteRequired = cnSignupMode(env) === 'invite';
  const code = typeof input.inviteCode === 'string' ? input.inviteCode.trim() : '';
  const invites = inviteRequired ? (deps.invites ?? (await defaultInvites())) : null;
  if (inviteRequired) {
    if (!code) throw new AuthCnError('invite_invalid', { missing: true });
    if (!(await invites!.isInviteRedeemable(BRAND, code))) throw new AuthCnError('invite_invalid');
  }

  return {
    consentRows,
    inviteRequired,
    async redeemInvite(tx) {
      if (inviteRequired) await invites!.redeemInviteInTx(tx, BRAND, code);
    },
  };
}
