// server/src/features/account-v2/readiness.ts
//
// When can a user turn two-factor sign-in on? Only when it cannot be walked
// around (WP-79 acceptance: "2FA bypass impossible on login"). Every path
// that mints a seeker session is listed here with whether it already runs
// the second-factor check (`gateSessionForSignIn` / `startLoginChallenge`,
// loginChallenge.ts). Enrolment stays closed while any path is ungated, so no
// account can hold a two-factor setting that another sign-in route skips.
//
// A path flips to `gated: true` in the same change that wires it (INT,
// handoff "Requests"); the readiness test fails if a path is marked gated
// here without the call in its file.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { totpKey } from './sealing.js';

export interface SignInPath {
  id: string;
  /** Repo-relative file that mints the session (or accepts the credential). */
  file: string;
  /**
   * What to look for in that file once it is gated. Every marker is unique
   * (the readiness test enforces it), so one gated call site can never vouch
   * for another in the same file: in `features/auth/routes.ts` each
   * `setSession(` call gets its own `// 2fa-gate:<site>` comment next to the
   * `gateSessionForSignIn(` call that guards it.
   */
  marker: string;
  gated: boolean;
  /** Paths that only exist on one market. */
  markets?: ReadonlyArray<'intl' | 'cn'>;
}

export const SIGN_IN_PATHS: readonly SignInPath[] = [
  // Email + password (WP-79 hook in the legacy auth router).
  { id: 'auth.login', file: 'server/src/roboapply/routes/auth.ts', marker: 'startLoginChallenge', gated: true },
  // The email form must take the user to /login/2fa on `two_factor_required`.
  { id: 'web.emailLoginForm', file: 'components/auth/methods/EmailMethod.tsx', marker: 'two_factor_required', gated: false },
  // features/auth/routes.ts: one entry per `setSession(` call.
  // POST /auth/password/reset signs the browser in after a reset.
  { id: 'auth.passwordReset', file: 'server/src/features/auth/routes.ts', marker: '2fa-gate:password-reset', gated: false },
  // GET /email/verify opened as a link (redirect branch) and as JSON (`signed_in`).
  { id: 'auth.emailVerifyLink', file: 'server/src/features/auth/routes.ts', marker: '2fa-gate:email-verify-link', gated: false },
  { id: 'auth.emailVerifyJson', file: 'server/src/features/auth/routes.ts', marker: '2fa-gate:email-verify-json', gated: false },
  // OAuth callbacks (Google, LINE): provider redirect straight to the API, and the web page's JSON call.
  { id: 'auth.oauthCallbackRedirect', file: 'server/src/features/auth/routes.ts', marker: '2fa-gate:oauth-callback-redirect', gated: false },
  { id: 'auth.oauthCallbackJson', file: 'server/src/features/auth/routes.ts', marker: '2fa-gate:oauth-callback-json', gated: false },
  // POST /oauth/complete (consent step after a new OAuth identity).
  { id: 'auth.oauthComplete', file: 'server/src/features/auth/routes.ts', marker: '2fa-gate:oauth-complete', gated: false },
  // Phone OTP and WeChat sign-in (issueSessionCookie).
  { id: 'authCn.sessions', file: 'server/src/features/auth-cn/accounts.ts', marker: '2fa-gate:issue-session-cookie', gated: false, markets: ['cn'] },
  // `POST /auth/login` has always returned a 7-day JWT that `requireAuth`
  // accepts as `Authorization: Bearer`. Revoking Session rows does not end
  // it, so a token taken before two-step sign-in was turned on would keep
  // working. Enrolment stays closed until the middleware rejects JWTs issued
  // before the user's last two-step change (INT, handoff "Requests").
  { id: 'auth.bearerJwt', file: 'server/src/middleware/auth.ts', marker: '2fa-gate:bearer-jwt', gated: false },
];

/**
 * Files where every session-issuing call must be matched by a gate call
 * before any entry in that file may be marked gated. `issuer` is counted
 * as call sites (its own definition excluded); `gate` must appear at least
 * as often. This catches a session-issuing call added later without a
 * marker of its own.
 */
export interface GateCoverageRule {
  file: string;
  issuer: RegExp;
  gate: RegExp;
}

export const GATE_COVERAGE: readonly GateCoverageRule[] = [
  { file: 'server/src/features/auth/routes.ts', issuer: /(?<!function )\bsetSession\(/g, gate: /\bgateSessionForSignIn\(/g },
  { file: 'server/src/features/auth-cn/accounts.ts', issuer: /res\.cookie\(\s*SESSION_COOKIE_NAME/g, gate: /\bgateSessionForSignIn\(/g },
];

/** Issuer and gate call counts for one file's source (see GATE_COVERAGE). */
export function gateCoverage(src: string, rule: Pick<GateCoverageRule, 'issuer' | 'gate'>): { issuers: number; gates: number; covered: boolean } {
  const issuers = src.match(rule.issuer)?.length ?? 0;
  const gates = src.match(rule.gate)?.length ?? 0;
  return { issuers, gates, covered: gates >= issuers };
}

export type TotpUnavailableReason = 'key_missing' | 'sign_in_paths_ungated' | 'storage_unavailable';

export interface TotpAvailability {
  available: boolean;
  reason: TotpUnavailableReason | null;
  ungated: string[];
}

/** Whether enrolment may start on this brand now. Existing enrolments keep working regardless. */
export function totpAvailability(
  brand: { id: BrandId; market: 'intl' | 'cn' },
  input: { env?: EnvSource; storeAvailable: boolean; paths?: readonly SignInPath[] },
): TotpAvailability {
  const paths = (input.paths ?? SIGN_IN_PATHS).filter((p) => !p.markets || p.markets.includes(brand.market));
  const ungated = paths.filter((p) => !p.gated).map((p) => p.id);
  if (!input.storeAvailable) return { available: false, reason: 'storage_unavailable', ungated };
  if (!totpKey(brand.id, input.env)) return { available: false, reason: 'key_missing', ungated };
  if (ungated.length) return { available: false, reason: 'sign_in_paths_ungated', ungated };
  return { available: true, reason: null, ungated };
}
