'use client';

// hooks/today/useTodaySources.ts — every read behind /today, the signed-in
// home (docs/agent-driven/REDESIGN.md §5).
//
// Today owns no data and no endpoint. It composes the hooks the other areas
// already have, so each number on it is the number its own page shows:
//
//   search          useActiveSearchProfile        the goal line
//   queue           useReadyQueue                 applications being prepared and waiting (flag `agent`)
//   picks           useSuggestions({ limit: 3 })  with `agent`: top fits not yet on the list
//                   useFeed                       without it: the top of the Jobs list. There is no
//                                                 other read of that list: the server counts it as a
//                                                 visit to Jobs, so the new-jobs count is read first
//   newJobs         GET /feed/new-count           the Jobs nav badge's own count, with its date
//   board           usePipelineBoard              applications (the cache entry /applications and its badge use)
//   profileMissing  useProfile                    details application forms ask for (the Profile badge's source)
//   resumes         useResumeList                 the main resume, versions with details to verify
//   setupStepsLeft  useOnboardingState            setup left early
//   skills          useSkillsCheckData            what the top jobs ask for that the profile does not list
//                                                 (asked only once a base resume exists)
//
// Rules kept here:
//   • a capability that is off asks nothing and reads `off` (R-04). Flags fail
//     closed while they load, so nothing that depends on a flag is asked
//     before the flags are known: the feed is never read "just in case" and
//     then dropped for the suggestions (a new feed session is rate-limited);
//   • a read that failed is `error` with its own retry; it never blocks the
//     others;
//   • nothing is counted on the client that the server did not send (D3).

import { useQuery } from '@tanstack/react-query';

import { getNewCount } from '../../lib/api/feed';
import type { FeedItem, SkillsCheckResponse } from '../../lib/api/contracts/feed';
import { BASE_SLOT_KINDS, type ResumeSummary } from '../../lib/api/resumes';
import { useCapabilities } from '../../lib/flags';
import { useReadyQueue, useSuggestions, type ReadyQueueItem } from '../agent';
import { feedKeys } from '../feed/keys';
import { useSkillsCheckData } from '../feed/useCalibration';
import { useFeed } from '../feed/useFeed';
import { useOnboardingState } from '../onboarding/useOnboarding';
import { useProfile } from '../profile/useProfile';
import { useActiveSearchProfile, type SearchProfile } from '../search/useSearchProfiles';
import { usePipelineBoard, type PipelineBoardData } from '../usePipelineBoard';
import { useResumeList } from '../useResumes';
import { LOADING, OFF, isUnavailableError, loadableOf, type Loadable } from './loadable';

/** Picks the Job search lane shows. */
export const PICK_LIMIT = 3;

/** New jobs since the last visit to the Jobs list, as the server counted them. */
export interface NewJobs {
  count: number;
  /** ISO time the count starts from; null when the server sent none. */
  since: string | null;
  /** The count hit its ceiling: "more than {count}". */
  capped: boolean;
}

export type SkillAsk = SkillsCheckResponse['skills'][number];

export interface TodayFlags {
  /** Flags are known (they fail closed until then). */
  ready: boolean;
  agent: boolean;
  copilot: boolean;
  /** The Jobs list (`jobs.feed`). */
  feed: boolean;
}

export interface TodaySources {
  flags: TodayFlags;
  /** The search Jobs uses now (the active one, else the main one); null when the user has none. */
  search: Loadable<SearchProfile | null>;
  queue: Loadable<ReadyQueueItem[]>;
  picks: Loadable<FeedItem[]>;
  /** Where the picks come from; null when there is no list to pick from. */
  picksFrom: 'suggestions' | 'feed' | null;
  newJobs: Loadable<NewJobs>;
  board: Loadable<PipelineBoardData>;
  profileMissing: Loadable<number>;
  resumes: Loadable<ResumeSummary[]>;
  /** Setup screens left when the user left onboarding early; 0 when nothing is left. */
  setupStepsLeft: Loadable<number>;
  skills: Loadable<SkillAsk[]>;
}

const validIso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/** GET /feed/new-count as Today reads it; undefined for an answer with no usable count. Pure. */
export function newJobsOf(data: { count?: unknown; since?: unknown; capped?: unknown }): NewJobs | undefined {
  const count = data.count;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return undefined;
  return { count: Math.floor(count), since: validIso(data.since), capped: data.capped === true };
}

export function useTodaySources(): TodaySources {
  const caps = useCapabilities();
  const flagsReady = caps.status !== 'loading';
  const agent = caps.flags?.agent === true;
  const copilot = caps.flags?.copilot === true;
  const feedOn = caps.flags?.['jobs.feed'] === true;

  const profiles = useActiveSearchProfile();
  const queue = useReadyQueue({ enabled: agent });
  const suggestions = useSuggestions({ enabled: agent, limit: PICK_LIMIT });
  // The Jobs nav badge's own request (hooks/feed/useJobsBadge.ts): same key and
  // options, so it is asked once. The badge keeps only a positive count; Today
  // also needs "none", "not known yet" and the date the count starts from.
  // Reading it does not count as a visit to Jobs.
  const newCount = useQuery({
    queryKey: feedKeys.newCount(),
    queryFn: ({ signal }) => getNewCount(undefined, { signal }),
    enabled: feedOn,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  // Without Ready to apply the picks are the top of the Jobs list itself: the
  // same query key as /jobs on its default sort, so the two share one read.
  // Opening the list IS a visit to Jobs for the server (it stamps the instant
  // the new-jobs count starts from), so the count is read first: the line
  // "Found N new jobs since {date}" is then about the time before this visit,
  // never a count taken a moment after the list reset it.
  const useFeedPicks = flagsReady && !agent && feedOn;
  const countSettled = newCount.data !== undefined || newCount.isError;
  const feed = useFeed({
    searchProfileId: profiles.profile?.id ?? null,
    version: profiles.profile?.version ?? null,
    sort: 'recommended',
    fitTier: profiles.profile?.filters.fitTier ?? 'all',
    enabled: useFeedPicks && !profiles.isPending && countSettled,
  });
  const board = usePipelineBoard();
  const profile = useProfile();
  const resumes = useResumeList();
  const onboarding = useOnboardingState();
  // The Resume lane shows it under the main resume only, so it is not asked for an account without one.
  const hasBaseResume = resumes.data?.resumes?.some((r) => BASE_SLOT_KINDS.includes(r.kind)) === true;
  const skillsOn = feedOn && hasBaseResume;
  const skills = useSkillsCheckData(skillsOn);

  let picks: Loadable<FeedItem[]>;
  let picksFrom: TodaySources['picksFrom'];
  if (!flagsReady) {
    picks = LOADING;
    picksFrom = null;
  } else if (agent) {
    picks = loadableOf(suggestions, true, (d) => (Array.isArray(d.items) ? d.items.slice(0, PICK_LIMIT) : undefined));
    picksFrom = 'suggestions';
  } else if (feedOn) {
    picksFrom = 'feed';
    if (feed.items.length > 0 || (!feed.isPending && !feed.isError)) picks = { status: 'ready', data: feed.items.slice(0, PICK_LIMIT) };
    else if (feed.isError) picks = isUnavailableError(feed.error) ? OFF : { status: 'error', retry: feed.refetch };
    else picks = LOADING;
  } else {
    picks = OFF;
    picksFrom = null;
  }

  return {
    flags: { ready: flagsReady, agent, copilot, feed: feedOn },
    search: loadableOf(profiles, true, () => profiles.profile),
    // Not `off` before the flags are known: the list would settle without the applications and then change.
    queue: flagsReady ? loadableOf(queue, agent, (d) => (Array.isArray(d.items) ? d.items : undefined)) : LOADING,
    picks,
    picksFrom,
    newJobs: flagsReady ? loadableOf(newCount, feedOn, newJobsOf) : LOADING,
    board: loadableOf(board, true, (d) => (Array.isArray(d.entries) ? d : undefined)),
    profileMissing: loadableOf(profile, true, (d) => (Array.isArray(d.missing) ? d.missing.length : undefined)),
    resumes: loadableOf(resumes, true, (d) => (Array.isArray(d.resumes) ? d.resumes : undefined)),
    setupStepsLeft: loadableOf(onboarding, true, (d) => {
      const progress = d.progress;
      if (!progress) return undefined;
      const left = progress.leftEarly ? progress.stepsLeft : 0;
      return Number.isFinite(left) && left > 0 ? Math.floor(left) : 0;
    }),
    skills: loadableOf(skills, skillsOn, (d) => (Array.isArray(d.skills) ? d.skills : undefined)),
  };
}
