// server/src/features/brand/routes.ts
//
// GET /api/v1/public/brand — the brand of the requesting host plus its
// resolved capabilities (R-04, R-24). Public; no user data; cached 5 minutes.
// Mounted in server/src/app.ts after the brand middleware.

import { Router, type Request, type Response } from 'express';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { getBrand, isDevOrPreviewHost, type AuthMethod, type PaymentRail, type ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { resolveFlags, type ResolvedFlags } from '../../platform/flags.js';
import { PUBLIC_BRAND_MAX_AGE_SEC, type PublicBrand } from './contract.js';

function authMethodConfigured(method: AuthMethod, flags: ResolvedFlags): boolean {
  switch (method) {
    case 'email_password':
      return true;
    case 'google':
      return flags['auth.google'];
    case 'line':
      return flags['auth.line'];
    case 'phone_otp':
      return flags['auth.phoneOtp'];
    case 'wechat':
      return flags['auth.wechatWeb'] || flags['auth.wechatInApp'] || flags['auth.wechatMini'];
    default:
      return false;
  }
}

function railLive(rail: PaymentRail, flags: ResolvedFlags): boolean {
  if (rail === 'stripe') return flags['pay.stripe'];
  if (rail === 'alipay') return flags['pay.alipay'];
  return flags['pay.wechatpay'];
}

/** Pure builder (no user, no secrets): what any visitor of this host may know. */
export function buildPublicBrand(brand: ProductBrand, env: EnvSource = process.env): PublicBrand {
  const flags = resolveFlags(brand, env);
  const other = getBrand(brand.otherBrand);
  return {
    id: brand.id,
    market: brand.market,
    name: brand.name,
    canonicalOrigin: brand.canonicalOrigin,
    locales: [...brand.locales],
    defaultLocale: brand.defaultLocale,
    currency: brand.currency,
    defaultCountry: brand.defaultCountry,
    authMethods: brand.authMethods.filter((m) => authMethodConfigured(m, flags)),
    paymentRails: brand.paymentRails.filter((r) => railLive(r, flags)),
    flags,
    otherBrand: { id: other.id, name: other.name, canonicalOrigin: other.canonicalOrigin },
  };
}

export function createBrandPublicRouter(options: { env?: EnvSource } = {}): Router {
  const router = Router();
  router.get('/', (req: Request, res: Response) => {
    const brand = (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
    const host = (req as Request & { brandResolution?: { host?: string } }).brandResolution?.host;
    // Production hosts map 1:1 to a brand, so a shared cache keyed by URL is
    // correct there. Dev/preview hosts can switch brand by cookie, so keep
    // those responses private.
    const scope = host && !isDevOrPreviewHost(host) ? 'public' : 'private';
    res.setHeader('Cache-Control', `${scope}, max-age=${PUBLIC_BRAND_MAX_AGE_SEC}`);
    res.json({ success: true, data: buildPublicBrand(brand, options.env ?? process.env) });
  });
  return router;
}

const brandPublicRouter = createBrandPublicRouter();
export default brandPublicRouter;
