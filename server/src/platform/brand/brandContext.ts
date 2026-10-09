// server/src/platform/brand/brandContext.ts
//
// Express brand middleware + request context (ARCHITECTURE.md §1.4).
// Mounted in server/src/app.ts after cookieParser() and the request-id
// middleware, before every router. It:
//   1. resolves the brand from the request (runtime.ts),
//   2. refuses brands this deployment does not serve (ALLOWED_BRANDS / BRAND_LOCK),
//   3. sets `req.brand` and the `X-RA-Brand` response header,
//   4. enters the AsyncLocalStorage request context, which also revives
//      setCurrentUserId (BYOK, per-user log lines) — before this, nothing
//      ever entered the context and those calls were no-ops.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getCurrentBrandId, getCurrentRequestId, withRequestContext } from '../../lib/requestContext.js';
import { DEFAULT_BRAND, getBrand, type ProductBrand } from './registry.js';
import { resolveBrandFromRequest, type BrandResolution } from './runtime.js';
import type { EnvSource } from './brandEnv.js';

export class BrandContextMissingError extends Error {
  constructor() {
    super(
      'No brand in the request context. Wrap HTTP handlers in brandContext and crons/workers/webhooks in runWithBrand().',
    );
    this.name = 'BrandContextMissingError';
  }
}

export type BrandedRequest = Request & { brand: ProductBrand; brandResolution?: BrandResolution; requestId?: string };

/** Paths answered without a brand check (health probes). */
const BRAND_EXEMPT_PATHS = new Set(['/api/health', '/api/v1/health']);

export interface BrandContextOptions {
  env?: EnvSource;
}

export function createBrandContext(options: BrandContextOptions = {}): RequestHandler {
  return function brandContext(req: Request, res: Response, next: NextFunction): void {
    const env = options.env ?? process.env;
    const resolution = resolveBrandFromRequest(req, env);
    const brand = getBrand(resolution.brandId);
    const requestId = (req as BrandedRequest).requestId ?? getCurrentRequestId() ?? '';

    if (!resolution.allowed && !BRAND_EXEMPT_PATHS.has(req.path)) {
      res.status(404).json({
        success: false,
        code: 'brand_unavailable',
        error: 'This site is not served by this deployment.',
      });
      return;
    }

    (req as BrandedRequest).brand = brand;
    (req as BrandedRequest).brandResolution = resolution;
    res.setHeader('X-RA-Brand', brand.id);
    withRequestContext({ requestId, brandId: brand.id, host: resolution.host || undefined }, () => next());
  };
}

/** The default middleware instance (reads process.env per request). */
export const brandContext: RequestHandler = createBrandContext();

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

let warnedMissing = false;

/**
 * The brand of the current unit of work. Outside production a missing
 * context throws BrandContextMissingError so wiring mistakes surface in tests;
 * in production it logs once and serves the default brand.
 * Use in new code (server/src/features/**, server/src/platform/**).
 */
export function getCurrentBrand(): ProductBrand {
  const id = safeCurrentBrandId();
  if (id) return getBrand(id);
  if (!isProduction()) throw new BrandContextMissingError();
  if (!warnedMissing) {
    warnedMissing = true;
    // eslint-disable-next-line no-console
    console.warn('[brand] getCurrentBrand() called without a brand context; serving the default brand');
  }
  return getBrand(DEFAULT_BRAND);
}

/**
 * Lenient variant for legacy call sites (LLM personas, provider headers,
 * cookie helpers) that also run in crons and tests without a context:
 * never throws, falls back to the default brand.
 */
export function getCurrentBrandOrDefault(): ProductBrand {
  return getBrand(safeCurrentBrandId() ?? DEFAULT_BRAND);
}

function safeCurrentBrandId() {
  try {
    return getCurrentBrandId();
  } catch {
    // A test that mocks requestContext without this export.
    return undefined;
  }
}
