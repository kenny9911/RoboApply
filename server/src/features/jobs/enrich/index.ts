// server/src/features/jobs/enrich/index.ts — public surface of job enrichment (WP-17).
//
// Producers (WP-16b ingest, WP-35 import, WP-42 ATS sources) enqueue with
// `enqueueJobEnrich(jobId, { changed })`; readers use the exported shapes:
//   - `RAJob.sponsorship` + `sponsorshipEvidence` (the quote the badge/tooltip shows);
//   - `RAJob.citizenshipRequired` / `clearanceRequired`, quotes in `marketTags`
//     under REQUIREMENT_TAGS;
//   - `RAJob.fraudFlags` rules INTL_SCAM_RULES (WP-32 excludes, WP-74 lists);
//   - `RAJob.summary` is AI output: render it as `{ text, aiWritten: true }`
//     ("Summary written by AI from the job post"; AiGeneratedBadge on GoApply).
// Since ENRICH_VERSION 3 (a row not yet re-enriched has none of these, and every reader falls back):
//   - `RAJob.skillsDetail[]` is `SkillDetail`: one entry per skill with `skillId` (null when the vocabulary
//     holds none), `via` ('embedding' is a machine guess) and `also` (the skill's other spellings in
//     `RAJob.skills`: a reader that lists skills from both folds those strings into the entry);
//     `RAJob.skillIds` holds the canonical ids of the hard skills and certifications, required first (soft
//     skills are shown and never in it);
//   - `RAKeywordExtraction.keywords[]` is `JobKeyword` with a `skillId`: canonical terms only, never a guess;
//   - `RAJob.requirements` is `StoredRequirements` (`readStoredRequirements`): the posting's own lines, one
//     list per text of the posting. Its `contentHash` is `jobContentHash(requirementsHashRow(job))`: the
//     title and the requirement text WITHOUT the skill strings, so it is not `RAJob.contentHash`;
//   - `RAJob.sponsorshipSource` is SPONSORSHIP_SOURCE_QUOTE when the value rests on a quote of the posting;
//   - a GoApply posting that states an age limit carries the market tag AGE_LIMIT_TAG with its sentence. It
//     is a flag for the card, never an input of a score or a filter.

import { enqueue, type EnqueueOptions, type EnqueuedItem } from '../../../platform/queue/index.js';
// agent.js before service.js, on purpose: service.js loads the market hooks, and a hook module
// (cn/jobs/fraud/llm.ts) reads this area's CN_DOMESTIC_PROVIDERS while this file is still loading.
// With the other order, a process whose first import is this file stops with "Cannot access
// 'CN_DOMESTIC_PROVIDERS' before initialization" (a command-line script, for example).
import { brandForMarket } from './agent.js';
import { enrichDedupeKey } from './service.js';
import { JOBS_ENRICH_WORK_KINDS } from './workers.js';
import type { EnrichPayload } from './schema.js';

export {
  EDUCATION_LEVELS,
  EMPLOYER_TAG_IDS,
  ENRICH_INDUSTRY_IDS,
  ENRICH_VERSION,
  EnrichLlmOutputSchema,
  EnrichOutputError,
  EnrichPayloadSchema,
  MAX_QUOTE_CHARS,
  MAX_REQUIREMENT_CHARS,
  REQUIREMENT_KINDS,
  RULES_CHECKED_MODEL,
  RULES_ONLY_MODEL,
  SENIORITY_LEVELS,
  SPONSORSHIP_STATUSES,
  enrichRequirementsMax,
  parseEnrichOutput,
  parseEnrichText,
} from './schema.js';
export type { EducationLevel, EmployerTagId, EnrichLlmOutput, EnrichPayload, EnrichRequirement, RequirementKind, Seniority, SponsorshipStatus } from './schema.js';
export { hasNegation, mentionsWorkAuthorization, reconcileSponsorship, verifyQuote } from './quotes.js';
export { INTL_SCAM_RULES, detectScamSignals, mergeFraudFlags } from './scamSignals.js';
export type { FraudFlag, IntlScamRule, ScamSignal } from './scamSignals.js';
export { buildKeywords, MAX_KEYWORDS } from './keywords.js';
export type { JobKeyword, KeywordImportance, KeywordVocabulary } from './keywords.js';
export { selectTaxonomyCandidates } from './candidates.js';
export { PROVIDER_SPONSORSHIP_PREFIX, REQUIREMENT_TAGS, SPONSORSHIP_SOURCE_QUOTE, needsLlm, postingTextOf, readStoredRequirements, requirementsHashRow } from './reconcile.js';
export type { RequirementHashInput, SkillDetail, StoredRequirements } from './reconcile.js';
export { AGE_LIMIT_TAG } from './ageLimit.js';
export { heldByRetiredWord, roleFromTitle, titleEvidence, titleIsDecisive, titleMatches, titleReadings } from './titleEvidence.js';
export type { TitleRuling } from './titleEvidence.js';
export type { CompanyIndustryClaim, ReconcileReport } from './reconcile.js';
export { CN_DOMESTIC_PROVIDERS, brandForMarket, resolveEnrichModel, taskModelRoute, type EnrichModelRoute } from './agent.js';
export { DEFAULT_ENRICH_DAILY_JOBS, enrichDailyLimit } from './budget.js';
export { enrichDedupeKey, enrichJob, systemUserIdFor } from './service.js';
export type { EnrichOutcome } from './service.js';
export { ENRICH_CONCURRENCY, JOBS_ENRICH_WORK_KINDS } from './workers.js';

/**
 * The dedupe suffix of a forced pass queued by the role backfill
 * (backfill/rematchRoles.ts): one per job per rematch generation. Bump it
 * when the title matcher changes again and stored roles must be looked at anew.
 */
export const REMATCH_GENERATION = 'rematch-v2';

/** The work-item dedupe key of the backfill's forced pass for a job. */
export function rematchDedupeKey(jobId: string): string {
  return `${enrichDedupeKey(jobId)}:${REMATCH_GENERATION}`;
}

/**
 * Queue one forced enrichment for a job whose title does not decide its role
 * (SM-2 backfill), so the model picks among the candidates. A second call for
 * the same job in the same rematch generation is a no-op (`created: false`):
 * the backfill can be run again without queueing the row twice.
 */
export function enqueueJobRematch(jobId: string, options: { market?: string } & Pick<EnqueueOptions, 'brand' | 'priority' | 'runAfter' | 'db'> = {}): Promise<EnqueuedItem> {
  const { market, brand, ...rest } = options;
  const payload: EnrichPayload = { jobId, force: true };
  return enqueue(JOBS_ENRICH_WORK_KINDS.jobEnrich, payload, {
    ...rest,
    brand: brand ?? (market ? brandForMarket(market) : undefined),
    dedupeKey: rematchDedupeKey(jobId),
    onConflict: 'keep',
  });
}

/**
 * The work-item key of a skills-only pass: one per job, enrichment version and
 * `generation`. The generation names the state of the vocabulary that makes
 * the pass worth running, for example the tag of the embedding model whose
 * label vectors RASkill now holds: the same state never queues a job twice
 * while the item exists, and a new state does.
 */
export function skillRemapDedupeKey(jobId: string, generation: string): string {
  return `${enrichDedupeKey(jobId)}:skills:${generation}`;
}

/**
 * Queue a skills-only pass for a job (payload `{ jobId, skillsOnly: true }`):
 * its skill strings are mapped to canonical ids again and its keyword row is
 * rewritten. No model call, no enrichment budget, no other column. For rows
 * that were enriched while the embedding step was off and so hold skills with
 * no id (`skillsDetail[].via = 'none'`); such a row is stamped with the
 * enrichment version and no full pass comes for it. A second call for the same
 * job and generation is a no-op (`created: false`).
 */
export function enqueueJobSkillRemap(
  jobId: string,
  options: { generation: string; market?: string } & Pick<EnqueueOptions, 'brand' | 'priority' | 'runAfter' | 'db'>,
): Promise<EnqueuedItem> {
  const { generation, market, brand, ...rest } = options;
  const payload: EnrichPayload = { jobId, skillsOnly: true };
  return enqueue(JOBS_ENRICH_WORK_KINDS.jobEnrich, payload, {
    ...rest,
    brand: brand ?? (market ? brandForMarket(market) : undefined),
    dedupeKey: skillRemapDedupeKey(jobId, generation),
    onConflict: 'keep',
  });
}

/**
 * Enqueue enrichment for a job. A new job: one item per job per version
 * (a duplicate call is a no-op). A materially changed job (`changed: true`):
 * the finished item is put back in the queue with `force`, so the row is
 * re-enriched even though it already carries ENRICH_VERSION. Pass the job's
 * `market` so the item is drained by the deployment that serves that brand
 * (an explicit `brand` wins; otherwise the current context's brand).
 */
export function enqueueJobEnrich(
  jobId: string,
  options: { changed?: boolean; market?: string } & Pick<EnqueueOptions, 'brand' | 'priority' | 'runAfter' | 'db'> = {},
): Promise<EnqueuedItem> {
  const { changed, market, brand, ...rest } = options;
  const payload: EnrichPayload = changed ? { jobId, force: true } : { jobId };
  return enqueue(JOBS_ENRICH_WORK_KINDS.jobEnrich, payload, {
    ...rest,
    brand: brand ?? (market ? brandForMarket(market) : undefined),
    dedupeKey: enrichDedupeKey(jobId),
    onConflict: changed ? 'requeue' : 'keep',
  });
}
