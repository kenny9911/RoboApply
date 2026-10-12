// server/src/features/resume/tailor/fitDeps.ts
//
// The two fit reads of tailoring on the fit contract (match/fit.ts; strategy
// 2.2). One wiring for production (`defaultTailorDeps` in resume/index.ts; the
// default reads the module's own functions, loaded on first use) and for the
// every-seam contract test, which passes the functions of an in-memory world.
//
//   canonicalFit   "Your fit": `getFit`, the person's MAIN resume, whatever
//                  version the session started from. The number the job page
//                  shows.
//   variantFit     "With this version": `getVariantFit`, the one function that
//                  accepts a resume version. Tailoring is its caller (the
//                  Assistant has the explicit version question).
//
// Both answer the fit as a snapshot (`fitSnapshot`: kind, versions, scoredAt).

import type { FitFunctions } from '../../match/index.js';
import type { TailorServiceDeps } from './TailorService.js';

export function tailorFitDeps(fits?: Pick<FitFunctions, 'getFit' | 'getVariantFit'>): Pick<TailorServiceDeps, 'canonicalFit' | 'variantFit'> {
  return {
    canonicalFit: async (userId, jobId, options) => {
      const match = await import('../../match/index.js');
      return match.fitSnapshot(await (fits ?? match).getFit(userId, jobId, { allowModelCall: options.allowModelCall, mode: 'on_demand', locale: options.locale }));
    },
    variantFit: async (userId, jobId, variantId, locale) => {
      const match = await import('../../match/index.js');
      return match.fitSnapshot(await (fits ?? match).getVariantFit(userId, jobId, variantId, { allowModelCall: true, mode: 'on_demand', locale }));
    },
  };
}
