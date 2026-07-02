/**
 * RoboApply V2 auth helpers — the one place V2 imports auth from.
 *
 * Per the boundary rule (docs/roboapply/v2/04-backend-spec.md §10), V2
 * code under `backend/src/roboapply/v2/*` can only reach the auth
 * middleware through this re-export shim. Direct imports of
 * `../../middleware/auth` from inside V2 sub-folders work today but
 * concentrating them here gives the BE2 route layer one symbol to import,
 * keeps the boundary-check regex tight, and gives us a single place to
 * tag V2-specific auth flavoring (e.g. seeker-style soft-redirects to the
 * `/login` page) if that ever becomes a separate product surface.
 *
 * Allowed source: `backend/src/middleware/auth.ts` — explicitly listed in
 * the V2 boundary allow-list.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  requireAuth as upstreamRequireAuth,
  resolveUserFromTokens as upstreamResolveUserFromTokens,
  type AuthTokenBundle,
} from '../../../middleware/auth.js';

/**
 * Express middleware: require an authenticated user on the request.
 * Mirrors `backend/src/middleware/auth.ts#requireAuth` exactly — V2
 * routes import this name so the import-graph audit only shows
 * `roboapply/v2/lib/raAuth` as the single auth touchpoint.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  return upstreamRequireAuth(req, res, next);
}

/**
 * Resolve an AuthUser from an already-parsed set of tokens. Mirrors
 * `backend/src/middleware/auth.ts#resolveUserFromTokens`. Used by any
 * non-Express context (e.g. a future V2 WebSocket upgrade handler in
 * `index.ts`). Returns null on any failure — caller decides whether to
 * reject or continue anonymously.
 */
export async function resolveUserFromTokens(tokens: AuthTokenBundle) {
  return upstreamResolveUserFromTokens(tokens);
}

export type { AuthTokenBundle } from '../../../middleware/auth.js';
