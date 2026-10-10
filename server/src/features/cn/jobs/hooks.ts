// server/src/features/cn/jobs/hooks.ts — GoApply market hooks (WP-41), statically
// imported by features/jobs/marketHooks.ts (FND-5, TASK_PLAN.md F18).
//
//   afterNormalize  GoHire source name, keyword + blacklist fraud flags, 届别
//                   `class_year:` tags, `cnFraudWarnings` on a user's import;
//   afterEnrich     the same rules on the stored row, persisted; gray-zone
//                   postings are queued for the cheap CN LLM check;
//   cardMeta        CnCardMeta for JobMetaCn (source line incl. 企业直招 rule
//                   and the GoHire licence line, verbatim pay, updated and
//                   expiry dates, quoted tags only, warnings on own imports).
// Applies to mainland jobs only (`job.market === 'cn'`).

import type { EnvSource } from '../../../platform/brand/index.js';
import type { MarketHookSet } from '../../jobs/marketHooks.js';
import { buildCnCardMeta } from './card.js';
import { cnJobCapabilities } from './mode.js';
import { cnAfterEnrich, cnAfterNormalize, defaultCnJobsDeps, type CnJobsDeps } from './service.js';

export interface CnHooksOptions {
  /** Lazily built dependencies (tests pass fakes). */
  deps?: () => CnJobsDeps;
  env?: () => EnvSource;
}

export function createCnJobsHooks(options: CnHooksOptions = {}): MarketHookSet {
  let lazy: CnJobsDeps | null = null;
  const deps = () => (lazy ??= (options.deps ?? defaultCnJobsDeps)());
  const env = options.env ?? (() => process.env);
  return {
    id: 'cn',
    appliesTo: (job) => job.market === 'cn',
    afterNormalize: (job, ctx) => cnAfterNormalize(job, ctx, deps()),
    afterEnrich: (job, ctx) => cnAfterEnrich(job, ctx, deps()),
    cardMeta: (job) => buildCnCardMeta(job, cnJobCapabilities(env())) as unknown as Record<string, unknown>,
  };
}

export const cnJobsHooks: MarketHookSet = createCnJobsHooks();
