// server/src/features/brand/contract.ts
//
// Wire contract for GET /api/v1/public/brand (ARCHITECTURE.md §3.2; R-24
// replaces the CN plan's /v2/brand/capabilities). Public, unauthenticated,
// cached 5 minutes. The web mirrors these types through
// lib/api/contracts/brand.ts (`export type *`).

import { z } from 'zod';
import type { ResolvedFlags } from '../../platform/flags.js';

export const BrandIdSchema = z.enum(['roboapply', 'goapply']);
export const MarketSchema = z.enum(['intl', 'cn']);
export const RoboLocaleSchema = z.enum(['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de']);
export const AuthMethodSchema = z.enum(['email_password', 'google', 'line', 'phone_otp', 'wechat']);
export const PaymentRailSchema = z.enum(['stripe', 'alipay', 'wechatpay']);
export const HiringContactsModeSchema = z.enum(['off', 'deeplinks_only', 'on']);

/** Resolved capability map: every key is a boolean except `hiringContacts`. */
export const ResolvedFlagsSchema = z
  .object({ hiringContacts: HiringContactsModeSchema })
  .catchall(z.boolean());

export const PublicBrandSchema = z.object({
  id: BrandIdSchema,
  market: MarketSchema,
  name: z.string().min(1),
  canonicalOrigin: z.string().url(),
  locales: z.array(RoboLocaleSchema).min(1),
  defaultLocale: RoboLocaleSchema,
  currency: z.enum(['USD', 'CNY']),
  defaultCountry: z.string().length(2),
  /** Only the methods that are configured on this deployment, in display order. */
  authMethods: z.array(AuthMethodSchema),
  /** Only the rails that can take a payment right now (the rail's credential is set and it is not switched off). */
  paymentRails: z.array(PaymentRailSchema),
  flags: ResolvedFlagsSchema,
  otherBrand: z.object({ id: BrandIdSchema, name: z.string(), canonicalOrigin: z.string().url() }),
});

export type PublicBrand = Omit<z.infer<typeof PublicBrandSchema>, 'flags'> & { flags: ResolvedFlags };

export interface PublicBrandResponse {
  success: true;
  data: PublicBrand;
}

/** Seconds the response may be cached (ARCH §3.2: cached 5 min). */
export const PUBLIC_BRAND_MAX_AGE_SEC = 300;
