// server/src/features/match/eval/seamRegistry.ts
//
// Every surface that shows a fit (strategy 2.2, invariant I1): feed card, job
// detail, Similar jobs, alert selection, the Ready list, the Assistant, the
// extension chip and the tailoring kit. Invariant 3 iterates this registry:
// for one seeded user and job it reads each seam and compares the score, tier
// and kind with `getFit`. A seam that is missing fails BY NAME.
//
// Created by MKT-1D with the seam names. The read functions are wired by
// MKT-2F (phase M2), when every consumer has moved to `getFit` / `getFits`:
// each builds its service on the fakes of `ctx.world` (the same in-memory
// repository and the same counting scorer `getFit` reads) and returns what the
// surface would show. Until then a read throws `SeamMissing`, and invariant 3
// is pending before M2 and failing from M2 on.
//
// Adding a surface that shows a fit means adding an entry here; a name in
// REQUIRED_FIT_SEAMS may never be removed.

import { SeamMissing } from './seams.js';
import type { World } from './world.js';

/** What a surface shows for (user, job): the three fields I1 compares. */
export interface SeamReading {
  score: unknown;
  tier: unknown;
  /** 'ai' | 'estimate' ('pre' is accepted as the wire spelling of an estimate). */
  kind: unknown;
}

export interface SeamContext {
  /** The world `getFit` was read from: one repository, one scorer, one brand, one clock. */
  world: World;
  /** Whether the world holds a fresh stored AI fit for the pair (`ai`) or none (`estimate`). */
  scenario: 'estimate' | 'ai';
}

export interface FitSeam {
  /** Stable name; printed when the seam is missing or disagrees. */
  name: string;
  /** The surface, in words. */
  surface: string;
  /** Repository path of the module that serves the surface. */
  modulePath: string;
  read(userId: string, jobId: string, ctx: SeamContext): Promise<SeamReading>;
}

/** The surfaces invariant I1 names. Every one must be in the registry. */
export const REQUIRED_FIT_SEAMS = [
  'feed_card',
  'job_detail',
  'similar_jobs',
  'alert_selection',
  'ready_list',
  'assistant_stored_fit',
  'assistant_analyze_fit',
  'extension_chip',
  'tailoring_kit',
] as const;

function notWired(modulePath: string, exportName: string): FitSeam['read'] {
  return async () => {
    throw new SeamMissing(`${modulePath}#${exportName}`, 'this surface is not read through the fit contract yet: wire its read in eval/seamRegistry.ts (MKT-2F)');
  };
}

export const FIT_SEAMS: FitSeam[] = [
  {
    name: 'feed_card',
    surface: 'Feed card (POST /feed/query, item.fit)',
    modulePath: 'server/src/features/feed/FeedQueryService.ts',
    read: notWired('server/src/features/feed/FeedQueryService.ts', 'createFeedQueryService'),
  },
  {
    name: 'job_detail',
    surface: 'Job detail fit (GET /jobs/:id)',
    modulePath: 'server/src/features/jobs/detail/service.ts',
    read: notWired('server/src/features/jobs/detail/service.ts', 'createJobDetailService'),
  },
  {
    name: 'similar_jobs',
    surface: 'Similar jobs cards',
    modulePath: 'server/src/features/jobs/detail/service.ts',
    read: notWired('server/src/features/jobs/detail/service.ts', 'createJobDetailService'),
  },
  {
    name: 'alert_selection',
    surface: 'Job alert selection (notification and mail cards)',
    modulePath: 'server/src/features/alerts/service.ts',
    read: notWired('server/src/features/alerts/service.ts', 'createJobAlertsTask'),
  },
  {
    name: 'ready_list',
    surface: 'Ready to apply list (fitsFor)',
    modulePath: 'server/src/features/agent/deps.ts',
    read: notWired('server/src/features/agent/deps.ts', 'fitsFor'),
  },
  {
    name: 'assistant_stored_fit',
    surface: 'Assistant: stored fit of a job it lists',
    modulePath: 'server/src/features/copilot/areas.ts',
    read: notWired('server/src/features/copilot/areas.ts', 'storedFit'),
  },
  {
    name: 'assistant_analyze_fit',
    surface: 'Assistant: analyze_fit tool',
    modulePath: 'server/src/features/copilot/tools/jobs.ts',
    read: notWired('server/src/features/copilot/tools/jobs.ts', 'analyze_fit'),
  },
  {
    name: 'extension_chip',
    surface: 'Browser extension fit chip',
    modulePath: 'server/src/features/extension/defaultDeps.ts',
    read: notWired('server/src/features/extension/defaultDeps.ts', 'match.cached'),
  },
  {
    name: 'tailoring_kit',
    surface: 'Tailoring kit: "Your fit" (the canonical fit)',
    modulePath: 'server/src/features/resume/tailor/TailorService.ts',
    read: notWired('server/src/features/resume/tailor/TailorService.ts', 'canonicalFit'),
  },
];
