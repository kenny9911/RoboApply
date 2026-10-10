// server/src/features/alerts/candidates.ts
//
// The ONE seam job alerts take their candidates from (`JobAlertsDeps.candidates`).
//
//   source        where the ids come from. Production (join J4, INT gate):
//                 `feedService.alertCandidates(searchProfileId, { since,
//                 limit, postedSince })`, which selects with the feed's own
//                 filter semantics. `AlertsRepo.candidateJobIds` (FilterSet →
//                 RAJob `where`, jobFilters.ts) is the earlier Prisma source,
//                 still used by tests; the query below carries what either needs.
//   mode gate     `modeGatedCandidates(source)`: on GoApply with
//                 CN_RECRUITMENT_INFO_MODE=off (R-14, R41-1b) the source is not
//                 even asked and the answer is "no candidates", whatever the
//                 source is. Alert candidates are public postings only (a
//                 user's own import never alerts), so in mode off there is
//                 nothing an alert may carry. The feed source checks the
//                 mode itself as well (FeedQueryService `postingsAllowed`; the
//                 Prisma source ANDs `cnPostingsWhere`), so the rule holds at
//                 both layers.
//
// The lifecycle re-engagement count ("N new jobs fit your saved search") reads
// the same gated feed source (`lifecycle/service.ts` `countNewJobsWith`), so
// the number in that message follows the rules of the list it links to.
//
// No LLM, no ranking: ids newest first; the service scores and picks.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';

export interface AlertCandidateQuery {
  /** The saved search the alert is for (the feed seam selects by it). */
  searchProfileId: string;
  userId: string;
  market: Market;
  /** The saved search's stored FilterSet. */
  filters: unknown;
  /** Only jobs first seen after this instant. */
  since: Date;
  /** Instant alerts: only postings from this instant on (or with no posting date). */
  postedSince: Date | null;
  limit: number;
}

export interface AlertCandidates {
  /** Job ids, newest first. */
  ids: string[];
  /** True when more than `limit` jobs matched (then no exact total may be claimed). */
  truncated: boolean;
}

export type AlertCandidateSource = (query: AlertCandidateQuery) => Promise<AlertCandidates>;

/** May third-party postings be shown to this market right now? */
export type PostingsAllowed = (market: Market) => boolean | Promise<boolean>;

/** Production rule: every market but GoApply; GoApply only while the recruitment-info mode is not `off`. */
export function defaultPostingsAllowed(env: EnvSource = process.env): PostingsAllowed {
  return async (market) => {
    if (market !== 'cn') return true;
    const { cnJobCapabilities } = await import('../cn/jobs/index.js');
    return cnJobCapabilities(env).postings;
  };
}

/** Wrap a candidate source with the recruitment-info mode gate (see the file header). */
export function modeGatedCandidates(source: AlertCandidateSource, postingsAllowed: PostingsAllowed = defaultPostingsAllowed()): AlertCandidateSource {
  return async (query) => {
    if (!(await postingsAllowed(query.market))) return { ids: [], truncated: false };
    return source(query);
  };
}
