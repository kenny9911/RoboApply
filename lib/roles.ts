// Role access rules for the RoboApply (candidate) app.
//
// RoboHire and RoboApply share one User table + one `session_token` cookie
// (COOKIE_DOMAIN=.robohire.io in prod). So a signed-in RoboHire recruiter can
// land on RoboApply with a valid session. They must NOT use the candidate app
// — they're bounced to the robohire.io/job-seeker bridge. Everyone else is
// allowed in: job-seekers (role 'seeker'), GoHire candidates / resume holders
// (role 'candidate'), and admins (who may use both apps interchangeably).

// RoboHire recruiter-side roles. The default `user` role is recruiter-side.
// `sales` / `customer_success` are internal RoboHire staff seats and belong in
// the recruiter SPA too, so they are blocked from RoboApply.
//
// INVARIANT: this set must stay byte-identical to the one in
// `frontend/src/utils/userRole.ts` (separate workspaces, no shared import) —
// change one, change the other, or the two apps disagree on who to bounce.
const RECRUITER_ROLES = new Set(['user', 'internal', 'agency', 'sales', 'customer_success']);

/**
 * True for RoboHire recruiter accounts — the only users blocked from RoboApply.
 * Unknown / missing roles are treated as NOT recruiter (allowed in), since the
 * candidate-side data is the user's own and is independently gated by the
 * SeekerProfile requirement on the backend.
 */
export function isRecruiterRole(role?: string | null): boolean {
  return RECRUITER_ROLES.has(role ?? '');
}
