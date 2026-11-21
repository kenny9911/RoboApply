'use client';

// hooks/today/useTodaySources.ts — every read behind /today, the signed-in
// home (docs/agent-driven/REDESIGN.md §5).
//
// Today owns no data and no endpoint. It composes the hooks the other areas
// already have, so each number on it is the number its own page shows:
//
//   search          useActiveSearchProfile        the goal line
//   queue           useReadyQueue                 applications being prepared and waiting (flag `agent`)
//   autoPrepare     useAutoPrepare                "Prepare my weekly list automatically": on or off, and
//                                                 this week's run with its real counts (flag `agent`)
//   picks           useSuggestions({ limit: 3 })  with `agent`: top fits not yet on the list
//                   useFeed                       without it: the top of the Jobs list, read with
//                                                 `visit: false` (not a visit to Jobs: the Jobs badge
//                                                 and the "New" markers keep counting from the last one)
//   newJobs         GET /feed/new-count           the Jobs nav badge's own count, with its date
//   board           usePipelineBoard              applications (the cache entry /applications and its badge use)
//   profileMissing  useProfile                    details application forms ask for (the Profile badge's source)
//   resumes         useResumeList                 the main resume, versions with details to verify
//   setupStepsLeft  useOnboardingState            setup left early
//   searching       useOnboardingState            the setup search is still at work (`searchRunning`)
//   skills          useSkillsCheckData            what the top jobs ask for that the profile does not list
//                                                 (asked only once a base resume exists)
//
// The setup search: the two-screen start finishes setup while its search runs
// on (docs/agent-driven/REDESIGN.md §9), so the first visit here usually comes
// before the first picks exist. The picks are asked for only once the setup
// state has answered and says no search is at work; while one is, the lane
// shows its loading state, the state is read again every few seconds, and
// when the search ends the picks and the new-jobs count are read afresh. The
// server bounds how long a search counts as at work, so the lane never waits
// on a search that died.
//
// Rules kept here:
//   • a capability that is off asks nothing and reads `off` (R-04). Flags fail
//     closed while they load, so nothing that depends on a flag is asked
//     before the flags are known: the feed is never read "just in case" and
//     then dropped for the suggestions (a new feed session is rate-limited);
//   • a read that failed is `error` with its own retry; it never blocks the
//     others;
//   • nothing is counted on the client that the server did not send (D3).

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getNewCount } from '../../lib/api/feed';
import type { FeedItem, SkillsCheckResponse } from '../../lib/api/contracts/feed';
import { BASE_SLOT_KINDS, type ResumeSummary } from '../../lib/api/resumes';
import type { AutoPrepareView } from '../../lib/api/agent';
import { useCapabilities } from '../../lib/flags';
import { useAutoPrepare, useReadyQueue, useSuggestions, type ReadyQueueItem } from '../agent';
import { agentKeys } from '../agent/keys';
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
  /** "Prepare my weekly list automatically" and its latest run (`off` without `agent`). */
  autoPrepare: Loadable<AutoPrepareView>;
  picks: Loadable<FeedItem[]>;
  /** Where the picks come from; null when there is no list to pick from. */
  picksFrom: 'suggestions' | 'feed' | null;
  newJobs: Loadable<NewJobs>;
  board: Loadable<PipelineBoardData>;
  profileMissing: Loadable<number>;
  resumes: Loadable<ResumeSummary[]>;
  /** Setup screens left when the user left onboarding early; 0 when nothing is left. */
  setupStepsLeft: Loadable<number>;
  /** The setup search is still at work (the server says so): the picks wait for it and read `loading`. */
  searching: boolean;
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
  const autoPrepare = useAutoPrepare({ enabled: agent });
  // The setup search (see the header): the picks wait until the setup state says none is at work.
  const onboarding = useOnboardingState({ pollWhileSearching: true });
  const searching = onboarding.data?.searchRunning === true;
  const picksMayLoad = (onboarding.data !== undefined || onboarding.isError) && !searching;
  useFreshPicksAfterSearch(searching);
  const suggestions = useSuggestions({ enabled: agent && picksMayLoad, limit: PICK_LIMIT });
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
  // Without Ready to apply the picks are the top of the Jobs list on its
  // default sort, read with `visit: false`: looking at the Dashboard is not a
  // visit to Jobs, so the server leaves the instant the Jobs badge and the
  // "New" markers count from as it is (the list's own read on /jobs stamps
  // it). The read is keyed apart from /jobs' list for that reason.
  const useFeedPicks = flagsReady && !agent && feedOn;
  const feed = useFeed({
    searchProfileId: profiles.profile?.id ?? null,
    version: profiles.profile?.version ?? null,
    sort: 'recommended',
    fitTier: profiles.profile?.filters.fitTier ?? 'all',
    visit: false,
    enabled: useFeedPicks && !profiles.isPending && picksMayLoad,
  });
  const board = usePipelineBoard();
  const profile = useProfile();
  const resumes = useResumeList();
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
    picks = picksMayLoad ? loadableOf(suggestions, true, (d) => (Array.isArray(d.items) ? d.items.slice(0, PICK_LIMIT) : undefined)) : LOADING;
    picksFrom = 'suggestions';
  } else if (feedOn) {
    picksFrom = 'feed';
    if (!picksMayLoad) picks = LOADING;
    else if (feed.items.length > 0 || (!feed.isPending && !feed.isError)) picks = { status: 'ready', data: feed.items.slice(0, PICK_LIMIT) };
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
    autoPrepare: flagsReady ? loadableOf(autoPrepare, agent, (d) => (typeof d?.on === 'boolean' ? d : undefined)) : LOADING,
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
    searching,
    skills: loadableOf(skills, skillsOn, (d) => (Array.isArray(d.skills) ? d.skills : undefined)),
  };
}

/**
 * When the setup search stops being at work, read again what may have been
 * read before it ended: the suggestions (the picks with `agent`) and the
 * new-jobs count. The Jobs list is left alone: it is not asked for while the
 * search is at work, and each fresh read of it opens a feed session the
 * server rate-limits.
 */
function useFreshPicksAfterSearch(searching: boolean): void {
  const qc = useQueryClient();
  const was = useRef(searching);
  useEffect(() => {
    const ended = was.current && !searching;
    was.current = searching;
    if (!ended) return;
    void qc.invalidateQueries({ queryKey: agentKeys.suggestions() });
    void qc.invalidateQueries({ queryKey: feedKeys.newCount() });
  }, [searching, qc]);
}
