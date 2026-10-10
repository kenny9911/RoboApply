// server/src/features/jobs/detail/defaultService.ts — the production job-detail
// service: Prisma, the brand context, and the other areas' public surfaces,
// loaded lazily so importing the router (features/index.ts mounts it at
// boot) pulls in no LLM, queue or growth module until a request needs one.

import prisma from '../../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import type { ProductBrand } from '../../../platform/brand/registry.js';
import { FLAG_KEYS, hiringContactsMode, isEnabled, loadUserFlagOverrides, type FlagKey } from '../../../platform/flags.js';
import { consentTypeSpellings } from '../../../roboapply/engine/lib/seekerConsentTypes.js';
import { cardMeta } from '../marketHooks.js';
import { explainMatch } from '../../compliance/index.js';
import type { MatchFitView } from '../../match/contract.js';
import { searchCompanyNews } from './newsSearch.js';
import { createJobDetailService, type DetailFlag, type JobDetailServiceImpl } from './service.js';
import type { JobRow } from './view.js';

/** ATS types the extension can fill. Empty until the extension registers its adapters (WP-55a/WP-70). */
const extensionAtsTypes = new Set<string>();

/** Extension point: the extension area registers the ATS types it can fill. */
export function registerExtensionAtsTypes(types: Iterable<string>): void {
  for (const t of types) if (t) extensionAtsTypes.add(t);
}

/** A flag the resolver does not know yet (e.g. `companyNews` before INT adds it) is off. */
async function detailFlag(key: DetailFlag, userId: string): Promise<boolean> {
  if (!(FLAG_KEYS as readonly string[]).includes(key)) return false;
  return isEnabled(key as FlagKey, { userId });
}

async function personalized(userId: string, brand: ProductBrand): Promise<boolean> {
  if (brand.market !== 'cn') return true;
  const latest = await prisma.seekerConsentRecord.findFirst({
    where: { seekerProfile: { userId }, consentType: { in: consentTypeSpellings('personalized_recommendation') } },
    orderBy: { createdAt: 'desc' },
    select: { granted: true },
  });
  return latest?.granted === true;
}

function createDefault(): JobDetailServiceImpl {
  return createJobDetailService({
    db: prisma,
    brand: getCurrentBrandOrDefault,
    companyProfile: async (companyId) => (await import('../companies/index.js')).companyService.profile(companyId, { publicOnly: false }),
    cachedFit: async (userId, jobId) => (await import('../../match/index.js')).matchService.scoreJob(userId, jobId, { mode: 'cache_only' }),
    preScore: async (userId, jobIds) => (await import('../../match/index.js')).matchService.preScoreMany(userId, jobIds),
    explain: ({ market, personalized: p, fit }) => explainNow({ market, personalized: p, fit }),
    personalized,
    peopleContext: async (userId) => {
      const { profileService } = await import('../../profile/index.js');
      const p = await profileService.get(userId);
      return { pastCompanies: p.experience.map((e) => e.company), schools: p.education.map((e) => e.school) };
    },
    practicedForJob: async () => null,
    markChecklistStep: async (userId, step) => (await import('../../growth/index.js')).markChecklistStep(userId, step),
    isEnabled: detailFlag,
    hiringContacts: async (userId) => hiringContactsMode(getCurrentBrandOrDefault(), process.env, await loadUserFlagOverrides(userId)),
    marketMeta: (row: JobRow, brand) => cardMeta({ ...row, market: brand.market }, { brand: brand.id, market: brand.market, stage: 'card' }),
    searchNews: (brand, name) => searchCompanyNews(brand, name),
    extensionAts: () => extensionAtsTypes,
    log: (message, meta) => {
      // eslint-disable-next-line no-console
      console.warn(`[jobs.detail] ${message}`, meta);
    },
  });
}

function explainNow(input: { market: 'intl' | 'cn'; personalized: boolean; fit: MatchFitView }) {
  return explainMatch({
    market: input.market,
    personalized: input.personalized,
    score: input.fit.score,
    kind: input.fit.kind,
    dimensions: input.fit.dimensions,
    skills: { aligned: input.fit.skills.aligned, missing: input.fit.skills.missing },
  });
}

let instance: JobDetailServiceImpl | null = null;
export function defaultJobDetailService(): JobDetailServiceImpl {
  return (instance ??= createDefault());
}
