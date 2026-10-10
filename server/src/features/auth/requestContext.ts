// server/src/features/auth/requestContext.ts
//
// What the request that creates an account says about the visitor, for the
// attribution and invite seams (WP-23 recipe; WP-60 signals). Used by the
// legacy signup route and the new auth routes, so every way into an account
// hands the same context to `authService.afterAccountCreated`.

import type { Request } from 'express';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { analyticsIdentity, requestSignals } from '../growth/index.js';
import type { SignupRequestContext } from './service.js';

/**
 * - `anonId` / `linkAllowed`: `analyticsIdentity(req, market)`. Marketing
 *   fields of a touch are stored, and the `ra_anon` id linked, only where the
 *   analytics rules allow it (never before consent in the EEA/UK/CH).
 * - `clientTouches`: `req.body.attribution` as the client sent it; the
 *   service reads `{ firstTouch, lastTouch }` out of it with `touchesFromClient`.
 * - `ip`, `userAgent`, `deviceId`: the invite risk signals (`requestSignals`),
 *   hashed before storage and kept 30 days.
 */
export function signupRequestContext(req: Request, brand: ProductBrand): SignupRequestContext {
  const identity = analyticsIdentity(req as Parameters<typeof analyticsIdentity>[0], brand.market);
  const signals = requestSignals(req);
  return {
    userAgent: signals.userAgent ?? null,
    ip: signals.ip ?? null,
    deviceId: signals.deviceId ?? null,
    anonId: identity.anonId,
    linkAllowed: identity.linkAllowed,
    clientTouches: (req.body as { attribution?: unknown } | undefined)?.attribution,
    country: identity.country,
  };
}
