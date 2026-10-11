// server/src/features/jobs/sources/atsPublic/index.ts — public surface (FND-5; owner WP-42).
// The employer boards plug into WP-16b's provider interface as `ats_public`;
// the board sync (features/jobs/ingest/boards.ts) reads them through this file.

export * from './contract.js';
export { createCareerSourcesAdminRouter } from './routes.js';
export { atsPublicHooks, isTaiwanJob, twCardMeta } from './hooks.js';
export { atsPublicAdapter, ensureAtsPublicAdapter } from './register.js';
export { atsPublicEnabled, createAtsPublicAdapter, ATS_PUBLIC_KILL_SWITCH } from './adapter.js';
export { CONNECTORS, connectorEnabled, connectorFor, createHostGate, enabledAts, hasPlaceholderName } from './connectors.js';
export type { AtsConnector, BoardRead, BoardSource, ConnectorDeps, ReadOptions } from './connectors.js';
export { API_HOSTS, BoardFetchError, assertApiHost } from './http.js';
export type { FetchLike } from './http.js';
export { extractPermitTags } from './permitTags.js';
export { careerSourcesService } from './service.js';
// Seeds (JI-3, JT-5, JC-4).
export { CAREER_SEEDS_CONFIG_KEY, SEEDABLE_ATS, careerSeedBoards, ensureSeedCareerSources, loadCareerSeeds, parseSeedFile, seedFile, seedFilesFor, seedHash, servedSeedMarkets } from './seeds.js';
export type { MergedSeedBoard, SeedBoard, SeedFile, SeedLoadResult, SeedResult, SeedableAts } from './seeds.js';
// Reading and routing one board (JI-4, JC-4).
export { CAREER_SOURCE_COLUMNS, asBoardSource, boardErrorText, diffByPostingId, readBoard, storesEveryPosting, toCareerSourceRow } from './sync.js';
export type { BoardReadOutcome, CareerSourceDb, CareerSourceRow, ReadBoardOptions } from './sync.js';
export { CN_COPY_SUFFIX, copyIdsOf, postingIdOf, routeBoardRead, routePosting, splitPostingByMarket, storedIdsOf } from './market.js';
export type { MarketSplit, RoutedBoard, RoutedPosting } from './market.js';
// The sync schedule (JI-4).
export {
  CANDIDATE_MAX_ATTEMPTS,
  HARD_BOARD_ERRORS,
  SKIPPED_BOARD_ERRORS,
  TENANT_DENIED,
  TENANT_FLOOR,
  candidateRetry,
  classifyBoardError,
  failureStamp,
  firstReadAfterSwitchOn,
  isSkippedBoardError,
  nextReadDelayMs,
  skippedStamp,
  successStamp,
  syncIntervalMs,
  tenantAskedRecently,
  withTenantFloor,
} from './schedule.js';
export type { BoardFailureClass, BoardReadResult, SourceStamp, SourceSyncState } from './schedule.js';
export {
  BEISEN_FLAG,
  BEISEN_MAX_POSTINGS_ENV,
  BEISEN_TENANTS_IN_FLIGHT,
  BEISEN_TENANT_FLOOR_MS,
  DISABLED_ARCHIVE_AFTER_MS,
  LARGE_BOARD_POSTINGS,
  MAINLAND_ONLY_ATS,
  TENANT_DENYLIST_ENV,
  VALIDATION_ERROR_PREFIX,
  WORKABLE_KILL_SWITCH,
  beisenEnabled,
  beisenMaxPostingsPerRun,
  boardsConcurrency,
  careerSourceState,
  discoveryValidationsPerRun,
  externalIdPrefix,
  isMainlandOnlyAts,
  isPublicAts,
  smartRecruitersDetailsPerRun,
  sourceCoversCountry,
  sourceFeedsMarket,
  tenantDenied,
  tenantDenylist,
  workableEnabled,
} from './shared.js';
// Discovery (JI-3).
export { DISCOVERY_ATS, boardDiscovery, companyNamesMatch, judgeCandidate, noteDiscoveredBoard, parsePostingKey } from './discovery.js';
export type { CandidateVerdict, DiscoveryOutcome } from './discovery.js';
// Boards an admin removed (JI-3): never proposed again by discovery or a seed list.
export { REMOVED_BOARDS_CONFIG_KEY, forgetRemovedBoards, readRemovedBoards, rememberRemovedBoard, removedBoardKey } from './removed.js';
