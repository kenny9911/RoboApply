'use client';

// hooks/shared/useJobActions.ts — the per-job actions every job surface offers
// (card, split detail, job page, Ready to apply, Assistant cards; PRODUCT
// F-FEED-05, R-19, D1; FND-7).
//
//   const actions = useJobActions(jobId, { applyUrl });
//   actions.applyOnCompanySite()   // opens the employer page, moves the job to Applied
//   actions.lastApplied            // non-null → render "Undo · I didn't apply"
//   actions.undoApplied()
//
// D1: nothing here submits anything. "Apply on company site" opens the
// employer's own page in a new tab and records that the user went there; the
// user presses the employer's Submit. Per R-19 the tracker moves to Applied at
// once (the server does it in `POST /jobs/:id/apply-click`) and the caller
// shows an inline Undo — there is no separate "Did you apply?" question.
//
// After a mutation the hook invalidates cached queries whose key starts with
// one of JOB_RELATED_QUERY_ROOTS, so counts and badges refresh. Area hooks
// should root their query keys there ('feed', 'job', 'tracker', 'agent').

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { applyClick, markApplied, saveJob, shareJob, undoApplied as undoAppliedApi, unsaveJob } from '../../lib/api/jobs';
import { hideJob, reportJob } from '../../lib/api/feed';
import type { In } from '../../lib/api/contracts/wire';
import type * as F from '../../lib/api/contracts/feed';
import type * as D from '../../lib/api/contracts/jobs/detail';
import { useOpenAssistant, type AssistantSource } from './useOpenAssistant';
import { useLaunchPractice } from './useLaunchPractice';
import { useLaunchTailor } from './useLaunchTailor';

export const JOB_RELATED_QUERY_ROOTS = ['feed', 'job', 'jobs', 'tracker', 'agent', 'applications'] as const;

export type HideReason = In<typeof F.HideJobBodySchema>['reasonCode'];
export type ReportReason = In<typeof F.ReportJobBodySchema>['reason'];

export type JobActionName = 'save' | 'unsave' | 'hide' | 'report' | 'share' | 'apply' | 'markApplied' | 'undoApplied';

export interface JobActionsOptions {
  /**
   * The employer URL when the caller already has it (feed card, job detail).
   * With it the new tab opens synchronously inside the click, so pop-up
   * blockers never eat it.
   */
  applyUrl?: string | null;
  /** Where the actions are shown (analytics and the Assistant's context). */
  source?: AssistantSource;
  /** Test seam: how tabs are opened (default: `window.open`). */
  opener?: TabOpener;
}

/** Opens employer pages in a new tab without giving them a handle on ours. */
export interface TabOpener {
  /** Open `url` now (inside the click). */
  open(url: string): void;
  /** Open an empty tab now, to be pointed at the URL once the server answers. */
  blank(): Window | null;
}

export interface JobActions {
  /** The action currently running, if any. */
  pending: JobActionName | null;
  error: unknown;
  /** Set after "Apply on company site" / "I applied" so the caller can offer Undo. */
  lastApplied: { trackerEntryId: string | null; at: string } | null;
  save(): Promise<void>;
  unsave(): Promise<void>;
  /** Not interested. May return a filter change to propose ("Stop showing …?"). */
  hide(reasonCode: HideReason, detail?: string): Promise<F.HideJobResponse | null>;
  report(reason: ReportReason, note?: string): Promise<void>;
  share(): Promise<D.ShareResponse | null>;
  /** Open the employer page and move the job to Applied (R-19). */
  applyOnCompanySite(): Promise<D.ApplyClickResponse | null>;
  /** "I applied" (already applied elsewhere). */
  markApplied(appliedAt?: string): Promise<void>;
  /** "Undo · I didn't apply". */
  undoApplied(): Promise<void>;
  askAboutJob(prompt?: string): boolean;
  tailor(resumeId?: string | null): void;
  practice(resumeId?: string | null): void;
}

const defaultOpener: TabOpener = {
  open(url) {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
  },
  blank() {
    if (typeof window === 'undefined') return null;
    return window.open('about:blank', '_blank');
  },
};

/** Point a placeholder tab at the employer URL, cutting its link back to us. */
function navigatePlaceholder(tab: Window, url: string): void {
  try {
    tab.opener = null;
  } catch {
    // some browsers make opener read-only; navigation still works
  }
  tab.location.href = url;
}

export function useJobActions(jobId: string, options: JobActionsOptions = {}): JobActions {
  const client = useQueryClient();
  const openAssistant = useOpenAssistant();
  const launchTailor = useLaunchTailor();
  const launchPractice = useLaunchPractice();
  const [pending, setPending] = useState<JobActionName | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [lastApplied, setLastApplied] = useState<JobActions['lastApplied']>(null);
  const opener = options.opener ?? defaultOpener;
  const source = options.source ?? 'other';

  const refresh = useCallback(
    () =>
      client.invalidateQueries({
        predicate: (q) => (JOB_RELATED_QUERY_ROOTS as readonly unknown[]).includes(q.queryKey[0]),
      }),
    [client],
  );

  const runAction = useCallback(
    async <T,>(name: JobActionName, fn: () => Promise<T>): Promise<T | null> => {
      setPending(name);
      setError(null);
      try {
        const out = await fn();
        void refresh();
        return out;
      } catch (err) {
        setError(err);
        return null;
      } finally {
        setPending(null);
      }
    },
    [refresh],
  );

  const applyOnCompanySite = useCallback(async () => {
    // Open inside the user's click so pop-up blockers allow it: the known URL
    // directly, otherwise an empty tab that follows once the server answers.
    const known = options.applyUrl ?? null;
    let placeholder: Window | null = null;
    if (known) opener.open(known);
    else placeholder = opener.blank();
    const res = await runAction('apply', () => applyClick(jobId));
    if (!known) {
      if (res?.applyUrl && placeholder) navigatePlaceholder(placeholder, res.applyUrl);
      else if (res?.applyUrl) opener.open(res.applyUrl);
      else placeholder?.close();
    }
    // Undo is offered only for a move to Applied this click made: a no-op click
    // (already applied or later) answers `alreadyApplied: true` (WP-34 request, Wave 3 gate).
    if (res && res.alreadyApplied !== true) setLastApplied({ trackerEntryId: res.trackerEntryId, at: new Date().toISOString() });
    return res;
  }, [jobId, opener, options.applyUrl, runAction]);

  return {
    pending,
    error,
    lastApplied,
    save: async () => {
      await runAction('save', () => saveJob(jobId));
    },
    unsave: async () => {
      await runAction('unsave', () => unsaveJob(jobId));
    },
    hide: (reasonCode, detail) => runAction('hide', () => hideJob(jobId, detail ? { reasonCode, detail } : { reasonCode })),
    report: async (reason, note) => {
      await runAction('report', () => reportJob(jobId, note ? { reason, note } : { reason }));
    },
    share: () => runAction('share', () => shareJob(jobId)),
    applyOnCompanySite,
    markApplied: async (appliedAt) => {
      const done = await runAction('markApplied', async () => ({ res: await markApplied(jobId, appliedAt ? { appliedAt } : {}) }));
      // Same rule as apply: no Undo when nothing changed (`alreadyApplied: true`).
      if (done && done.res?.alreadyApplied !== true) setLastApplied({ trackerEntryId: null, at: appliedAt ?? new Date().toISOString() });
    },
    undoApplied: async () => {
      const ok = await runAction('undoApplied', async () => {
        await undoAppliedApi(jobId);
        return true;
      });
      if (ok) setLastApplied(null);
    },
    askAboutJob: (prompt) => openAssistant({ jobId, prompt, source }),
    tailor: (resumeId) => launchTailor({ jobId, resumeId, from: source }),
    practice: (resumeId) => launchPractice({ jobId, resumeId, from: source }),
  };
}
