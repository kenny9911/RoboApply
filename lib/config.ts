// Shared runtime config.
//
// `API_BASE` follows the project rule (CLAUDE.md "Frontend API Calls"): in
// dev we leave it empty so relative `/api/v1/...` paths hit Next's rewrite
// (which forwards to localhost:4607). In production it's set to the
// fully-qualified API host (e.g. https://api.robohire.io).

// A localhost API base in a PRODUCTION bundle is always a misconfiguration
// (the dev default baked at build time, or a dev .env pasted into the deploy
// platform's env settings) — the deployed site would try to call the
// VISITOR'S machine and every request would die on CORS ("Failed to fetch").
// Guard against it explicitly: production falls back to same-origin relative
// URLs, which the vercel.json rewrite routes to the API function.
const rawApiUrl = process.env.NEXT_PUBLIC_API_URL || '';
const isLocalhostApiUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(rawApiUrl);

export const API_BASE: string =
  rawApiUrl && process.env.NODE_ENV !== 'development' && !isLocalhostApiUrl
    ? rawApiUrl
    : '';

// Cookie name shared with the backend — must match SESSION_COOKIE_NAME in
// server/src/lib/cookieOptions.ts. Deliberately NOT `session_token`: RoboHire
// dev uses that name, and cookies are host-scoped (not port-scoped), so on
// localhost the two apps shared one cookie jar. Since the DB split a RoboHire
// session is invalid here — the shared name caused a redirect-to-login loop
// whenever a stale RoboHire / pre-split cookie was present.
export const SESSION_COOKIE_NAME = 'ra_session_token';

/**
 * Build a URL into the RoboHire recruiter / marketing SPA. Used to bounce
 * RoboHire recruiters out of the candidate app to the /job-seeker bridge.
 * Resolution order: explicit NEXT_PUBLIC_ROBOHIRE_URL → derive from the api
 * host in prod (api.robohire.io → robohire.io) → localhost:3607 in dev.
 */
export function getRoboHireUrl(path = '/'): string {
  const explicit = process.env.NEXT_PUBLIC_ROBOHIRE_URL;
  let origin: string;
  if (explicit) {
    origin = explicit.replace(/\/+$/, '');
  } else if (API_BASE && API_BASE.includes('//api.')) {
    origin = API_BASE.replace('//api.', '//');
  } else {
    origin = 'http://localhost:3607';
  }
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${suffix}`;
}
