// server/src/platform/embeddings/index.ts — public surface of the embeddings client (MKT-2H).
//
//   import { embedTexts, resolveEmbeddingConfig } from '../../platform/embeddings/index.js';
//
// `embedTexts` answers vectors of exactly 1024 numbers, or `{ unavailable }`
// when no key is set, the brand's route policy refuses the endpoint or the
// daily budget is spent. The caller then runs without the dense leg.
// `embeddingAvailability` answers the same question without a request. Consent
// (`aiAllowed`, the 个性化推荐 grant) is the caller's gate.

export {
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBED_TIMEOUT_MS,
  EmbeddingsError,
  MAX_EMBED_BATCH_SIZE,
  createEmbeddingsClient,
  embedTexts,
  embeddingAvailability,
  embeddingEnvProblems,
  embeddingRoute,
  resolveEmbeddingConfig,
  setEmbeddingsClientForTests,
} from './client.js';
export type {
  EmbedOptions,
  EmbedResult,
  EmbeddingAvailability,
  EmbeddingConfig,
  EmbeddingEnvProblem,
  EmbeddingPurpose,
  EmbeddingUnavailableReason,
  EmbeddingVectors,
  EmbeddingsClient,
  EmbeddingsClientDeps,
} from './client.js';
export { DEFAULT_EMBED_DAILY_TOKENS, createEmbeddingBudget, embedBudgetKey, embedDailyTokens } from './budget.js';
export type { EmbeddingBudget } from './budget.js';
export { EMBED_COST_SKU, EMBEDDING_PRICED_HOSTS, createEmbeddingUsageLog, embeddingUsageRow } from './usage.js';
export type { EmbeddingUsageEntry } from './usage.js';
