// server/src/features/support/service.ts
//
// Support contact + the public marketing facts (TASK_PLAN.md WP-40).
//
//   contact()     → one transactional email to the brand's support inbox.
//                   Answers `received` only when the transport accepted it;
//                   otherwise an error that carries the inbox address so the
//                   page can say "email us at …" instead of pretending.
//   indexStats()  → hourly-cached public counts (stats.ts).
//   creditCaps()  → Free vs Pro caps from the effective credit catalog
//                   (defaults + the admin override), never from copy.

import { addressOf, sendEmail, type SendEmailInput, type SendEmailResult } from '../../platform/email/index.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { getCreditCatalog, type CreditCatalog } from '../../platform/credits/index.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import {
  PUBLIC_CAP_BUCKETS,
  type CreditCapsResponse,
  type IndexStatsResponse,
  type SupportContactResponse,
  type SupportTopic,
} from './contract.js';
// Importing email.ts registers the `support.contact` template.
import { SUPPORT_CONTACT_TEMPLATE } from './email.js';
import { createIndexStatsCache, type IndexStatsCache, type IndexStatsDb } from './stats.js';

export interface SupportContactInput {
  email: string;
  name?: string;
  topic: SupportTopic;
  message: string;
  pageUrl?: string;
  locale?: string;
}

export interface SupportService {
  contact(input: SupportContactInput, ctx: { brand: ProductBrand; userId: string | null }): Promise<SupportContactResponse>;
  indexStats(brand: ProductBrand): Promise<IndexStatsResponse>;
  creditCaps(brand: ProductBrand): Promise<CreditCapsResponse>;
}

export interface SupportServiceDeps {
  send?: (input: SendEmailInput<Record<string, unknown>>) => Promise<SendEmailResult>;
  env?: EnvSource;
  stats?: IndexStatsCache;
  creditCatalog?: (brand: ProductBrand) => Promise<CreditCatalog>;
}

/** The brand's support inbox: SUPPORT_EMAIL / CN_SUPPORT_EMAIL (no fallback across brands), else the registry address. */
export function supportAddress(brand: ProductBrand, env: EnvSource = process.env): string {
  const configured = brandEnv(brand, 'SUPPORT_EMAIL', env);
  return (configured && addressOf(configured)) || brand.email.replyTo;
}

/** Only an http(s) page URL is forwarded to support staff. */
function cleanPageUrl(url: string | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url.trim()) ? url.trim().slice(0, 500) : null;
}

export function capsFromCatalog(catalog: CreditCatalog): CreditCapsResponse {
  return {
    buckets: PUBLIC_CAP_BUCKETS.map((bucket) => {
      const def = catalog.buckets[bucket];
      return {
        bucket,
        free: { cap: def.caps.free.cap, window: def.caps.free.window === 'week' ? 'week' : 'day' },
        pro: { cap: def.caps.pro.cap, window: def.caps.pro.window === 'week' ? 'week' : 'day' },
      };
    }),
    entitlements: {
      free: { saved_searches: catalog.entitlements.free.saved_searches, instant_alerts: catalog.entitlements.free.instant_alerts },
      pro: { saved_searches: catalog.entitlements.pro.saved_searches, instant_alerts: catalog.entitlements.pro.instant_alerts },
    },
  };
}

async function prismaStatsDb(): Promise<IndexStatsDb> {
  const { default: prisma } = await import('../../lib/prisma.js');
  return prisma as unknown as IndexStatsDb;
}

export function createSupportService(deps: SupportServiceDeps = {}): SupportService {
  const env = deps.env ?? process.env;
  const send = deps.send ?? ((input) => sendEmail(input));
  const stats = deps.stats ?? createIndexStatsCache(prismaStatsDb);
  const catalogFor = deps.creditCatalog ?? ((brand: ProductBrand) => getCreditCatalog(brand.id));

  return {
    async contact(input, { brand, userId }) {
      const to = supportAddress(brand, env);
      const result = await send({
        template: SUPPORT_CONTACT_TEMPLATE,
        to,
        userId,
        brand,
        params: {
          replyEmail: input.email,
          name: input.name?.trim() || null,
          topic: input.topic,
          message: input.message,
          pageUrl: cleanPageUrl(input.pageUrl),
          locale: input.locale ?? null,
          userId,
        },
      });
      if (result.status === 'sent') return { received: true };
      logger.warn('SUPPORT', `${SUPPORT_CONTACT_TEMPLATE} not delivered`, { brand: brand.id, status: result.status, reason: result.reason });
      if (result.status === 'suppressed' && result.reason === 'transport_not_configured') {
        throw new HttpError('provider_not_configured', 'Email is not configured on this deployment.', { supportEmail: to });
      }
      throw new HttpError('internal_error', 'The message could not be sent.', { supportEmail: to });
    },

    indexStats(brand) {
      return stats.get(brand.market);
    },

    async creditCaps(brand) {
      return capsFromCatalog(await catalogFor(brand));
    },
  };
}

let defaultService: SupportService | null = null;

/** The process-wide service (lazy, so importing the router never opens a database connection). */
export function supportService(): SupportService {
  defaultService ??= createSupportService();
  return defaultService;
}
