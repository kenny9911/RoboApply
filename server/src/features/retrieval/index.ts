// server/src/features/retrieval/index.ts — public surface of the retrieval area (MKT-2H).
//
// The write path of the search document and the vectors, and the reads later
// phases build on (MARKET_TASK_PLAN 3.3 "Retrieval seam"):
//   - writeSearchDoc(jobId, { searchDoc, contentHash, lang })  one statement with to_tsvector('simple', …)
//   - upsertJobEmbedding / nearestJobsByJob(jobId, { market, country, modelTag, limit })
//   - userVector(userId, market, modelTag)   resume vector, else intent vector, else null
//   - currentModelTag(market)                the tag queries must filter on
//   - segmentForSearch / toTsQuery           one tokenizer for documents and queries
//   - retrievalWorkers                       'job.index' and 'user.embed' (registered by jobs/enrich/workers.ts)
//   - runRetrievalSweep                      the third step of the score-precompute cron
// Vectors never cross markets, and vectors of two models are never compared.
// On GoApply a person's vector exists only with the AI consent and a live
// 个性化推荐 grant; a reader of `userVector` still asks the feed's own
// personalisation switch before it uses one.

import { defaultRetrievalRepo, type NearestJob, type UserVectorKind } from './repo.js';

export { VECTOR_DIMENSIONS, createRetrievalRepo, defaultRetrievalRepo, parseVector, vectorLiteral } from './repo.js';
export type { EmbeddingMeta, IndexStats, NearestJob, RetrievalDb, RetrievalRepo, UserEmbeddingMeta, UserVectorKind } from './repo.js';
export { MAX_QUERY_TOKENS, QUERY_STOPWORDS, queryTokens, segmentForSearch, toTsQuery } from './segment.js';
export { HANT_HANS_UNICODE_VERSION, foldHantToHans, isTraditionalOnly } from './hantHans.js';
export { detectLang } from './lang.js';
export type { PostingLang } from './lang.js';
export { SEARCH_DOC_MAX_CHARS, buildSearchDoc } from './searchDoc.js';
export { CARD_TEXT_MAX_CHARS, buildCardText, cardHash } from './cardText.js';
export type { IndexJobRow, JobTextDeps, SkillLabels } from './jobText.js';
export { intentText, isSensitiveLine, redactResumeText, resumeText, sourceHash } from './userText.js';
export type { IntentInput, ResumeStrip } from './userText.js';
export { MODEL_SWITCH_SHARE, brandOfMarket, currentModelTag, modelTagConfigKey, reconcileModelTag, writeModelTag } from './modelTag.js';
export type { ModelTagState } from './modelTag.js';
export {
  JOB_INDEX_MAX_IDS,
  RETRIEVAL_WORK_KINDS,
  embedUser,
  indexJobs,
  jobIndexWorker,
  retrievalWorkers,
  setRetrievalDepsForTests,
  userEmbedWorker,
  userVectorGate,
} from './workers.js';
export type { JobIndexDeps, JobIndexOutcome, JobIndexPayload, UserEmbedDeps, UserEmbedOutcome, UserEmbedPayload, UserTextSource } from './workers.js';
export { RETRIEVAL_SWEEP_LIMITS, createRetrievalSweep, jobIndexBatchDedupeKey, jobIndexDedupeKey, runRetrievalSweep, userEmbedDedupeKey } from './sweep.js';
export type { RetrievalSweepDeps, RetrievalSweepResult } from './sweep.js';

/** One statement: `searchDoc`, `searchTsv = to_tsvector('simple', searchDoc)`, `contentHash` and `lang`. */
export const writeSearchDoc = (jobId: string, input: { searchDoc: string; contentHash: string; lang: string }): Promise<void> => defaultRetrievalRepo.writeSearchDoc(jobId, input);

export const upsertJobEmbedding = (jobId: string, market: string, model: string, contentHash: string, vector: readonly number[]): Promise<void> =>
  defaultRetrievalRepo.upsertJobEmbedding(jobId, market, model, contentHash, vector);

export const jobsNeedingIndex = (market: string, modelTag: string | null, limit: number): Promise<string[]> => defaultRetrievalRepo.jobsNeedingIndex(market, modelTag, limit);

/** Public, canonical, open jobs of the same market nearest to the job's vector; empty when the job has none. */
export const nearestJobsByJob = (jobId: string, options: { market: string; country?: string | null; modelTag: string; limit: number }): Promise<NearestJob[]> =>
  defaultRetrievalRepo.nearestJobsByJob(jobId, options);

export const upsertUserEmbedding = (userId: string, market: string, kind: UserVectorKind, model: string, sourceHash: string, vector: readonly number[]): Promise<void> =>
  defaultRetrievalRepo.upsertUserEmbedding(userId, market, kind, model, sourceHash, vector);

export const deleteUserEmbeddings = (userId: string, market: string): Promise<number> => defaultRetrievalRepo.deleteUserEmbeddings(userId, market);

/** Delete the vectors of the person's own private imports in a market (they were embedded under the AI consent). */
export const deleteJobEmbeddingsOfOwner = (userId: string, market: string): Promise<number> => defaultRetrievalRepo.deleteJobEmbeddingsOfOwner(userId, market);

/** The person's resume vector, else intent vector, else null; only vectors of `modelTag` are read. */
export const userVector = (userId: string, market: string, modelTag: string): Promise<number[] | null> => defaultRetrievalRepo.userVector(userId, market, modelTag);
