// server/src/features/cn/referrals/index.ts — public surface (FND-5; owner WP-54).
//
//   createCnReferralsRouter        seeker routes (mounted by features/index.ts)
//   createCnReferralsAdminRouter   moderation queue (INT mounts it at /api/v1/roboapply/admin/cn/referrals)
//   getCnReferralService()         the full service

import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import { normalizeCompanyName } from '../../jobs/normalize/index.js';
import { CnReferralService } from './service.js';
import { createPrismaReferralStore } from './store.js';

export * from './contract.js';
export { createCnReferralsAdminRouter, createCnReferralsRouter } from './routes.js';
export { CnReferralService, hasContactDetails } from './service.js';
export type { ReferralDeps } from './service.js';
export { createMemoryReferralStore, createPrismaReferralStore } from './store.js';
export type { ReferralStore } from './store.js';

let singleton: CnReferralService | null = null;

export function getCnReferralService(): CnReferralService {
  singleton ??= new CnReferralService({
    store: createPrismaReferralStore(),
    brandId: () => getCurrentBrandOrDefault().id,
    normalizeCompany: (name) => normalizeCompanyName(name),
  });
  return singleton;
}
