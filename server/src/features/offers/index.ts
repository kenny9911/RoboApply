// server/src/features/offers/index.ts — public surface of offer comparison (FND-5; owner WP-64).
//
// Seams:
//   offersService.list(userId)          every application with an offer (Assistant, tracker summaries)
//   offersService.compare(userId, ids)  deterministic totals with stated assumptions
//   getOffersService()                  the full service (benchmark, AI draft/explanation)

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { aiAllowed } from '../../platform/consent/aiAllowed.js';
import { isEnabled } from '../../platform/flags.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { LLM_PII_KINDS, redactPii } from '../../platform/pii/index.js';
import { trackerCore, TrackerNotFoundError } from '../tracker/index.js';
import type { OfferComparison, OfferView } from './contract.js';
import { createPrismaPostedPay } from './postedRange.js';
import { createOffersService, type OffersService as OffersServiceImpl, type OffersServiceDeps } from './service.js';

export * from './contract.js';
export { createOffersRouter, OFFERS_AI_LIMIT_NAME, OFFERS_AI_WINDOWS, type OffersRouterOptions } from './routes.js';
export { createOffersService, readStoredOffer, toOfferView, type OffersServiceDeps, type OffersTrackerPort } from './service.js';
export { compareOffers, totalsFor, assumptionsFor, baseAnnualOf, housingFundAnnualOf } from './compute.js';
export { summarizePostedPay, roleScopeFor, postedPayWhere, type PostedPaySource } from './postedRange.js';
export { checkNumbers, extractNumbers } from './numberGuard.js';

/** AI for offers: the user's AI consent AND the brand's text model (R-13). */
export async function offersAiAvailable(userId: string): Promise<boolean> {
  if (!(await aiAllowed(userId))) return false;
  return isEnabled('ai.text', { userId });
}

export function defaultOffersDeps(): OffersServiceDeps {
  return {
    tracker: {
      entries: (userId) => trackerCore.exportEntries(userId),
      entry: (userId, entryId) => trackerCore.getById(userId, entryId),
      updateOffer: (userId, entryId, offer) => trackerCore.updateOffer(userId, entryId, offer),
    },
    postedPay: createPrismaPostedPay(async () => (await import('../../lib/prisma.js')).default),
    market: () => (getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl'),
    aiAvailable: offersAiAvailable,
    isEntryNotFound: (err) => err instanceof TrackerNotFoundError,
    redact: (text) => redactPii(text, { kinds: LLM_PII_KINDS }).text,
    write: async (input) => {
      const { OfferWriterAgent } = await import('./OfferWriterAgent.js');
      return new OfferWriterAgent().run(input, { requestId: getCurrentRequestId() ?? undefined });
    },
  };
}

let singleton: OffersServiceImpl | null = null;

/** The process-wide offers service (tracker core, Prisma index reads, OfferWriterAgent). */
export function getOffersService(): OffersServiceImpl {
  singleton ??= createOffersService(defaultOffersDeps());
  return singleton;
}

export type { OffersServiceImpl };

export interface OffersService {
  list(userId: string): Promise<OfferView[]>;
  compare(userId: string, trackerEntryIds: readonly string[]): Promise<OfferComparison>;
}

export const offersService: OffersService = {
  list: (userId) => getOffersService().list(userId),
  compare: (userId, ids) => getOffersService().compare(userId, ids),
};
