'use client';

// hooks/agent/useAgent.ts — Ready to apply data hooks (WP-53; API WP-52).
//
//   useAgentSettings / useSaveAgentSettings   weekly settings (F-AGENT-03)
//   useAgentSetup / useCalibrate              setup checks, "Check your search" verdicts
//   useCompleteSetupStep                      finish / skip a wizard step (setup → done → first list)
//   useSuggestions                            top fits not yet on the list
//   useReadyQueue                             the list (polls while a kit is being prepared)
//   useGenerateList                           add jobs from the search (with Ready-only filter changes)
//   useAddToList                              add jobs (weekly, suggestions, manual…)
//   useKitDetail / useKitHistory              one kit's review data and history rows
//   useKitAiAvailable                         may this kit offer AI actions (ai.text + consent)?
//   useKitActions(id)                         confirm part · open · undo · I applied · skip · restore · remove
//   usePrepareKits                            quote (credit proposal) → prepare, through the credit gate
//   useAnswerBank / useSaveAnswers            common application answers
//   useQuestionKeys                           the brand's common questions (canonical keys)
//
// D1: nothing here submits anything. `open` returns the employer's link; the
// user applies there. The server moves the tracker entry to Applied at once
// and `undo` reverts it ("Undo · I didn't apply"), exactly like "Apply on
// company site".
//
// API calls go through lib/api/agent.ts only.

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  addToQueue,
  completeSetupStep,
  confirmKitPart,
  generateList,
  getAgentSettings,
  getAgentSetup,
  getAnswerBank,
  getKitDetail,
  getKitHistory,
  getQuestionKeys,
  getSuggestions,
  listQueue,
  markQueueApplied,
  openApplication,
  prepareKit,
  putAgentSettings,
  putAnswerBank,
  removeQueueItem,
  restoreQueueItem,
  skipQueueItem,
  submitCalibration,
  undoQueueApplied,
  type GenerateListBody,
  type GenerateListResponse,
  type KitHistoryResponse,
  type QuestionKeyView,
  type QueueItemDetail,
  type QueueListResult,
  type SetupStepBody,
  type SetupStepResponse,
} from '../../lib/api/agent';
import { apiErrorCode, type In, type Items } from '../../lib/api/contracts/wire';
import type * as A from '../../lib/api/contracts/agent';
import type { FeedItem } from '../../lib/api/contracts/feed';
import { useFlag } from '../../lib/flags';
import { useCreditGate, type CreditsExhaustedInfo } from '../shared/useCreditGate';
import { useTailorAvailability } from '../tailor/useTailorAvailability';
import { agentKeys } from './keys';
import type { ReadyQueueItem } from './adapters';

/** Errors no retry can fix. */
const FINAL = new Set(['not_found', 'unauthorized', 'auth_expired', 'AUTH_REQUIRED', 'auth_other_brand', 'feature_disabled', 'not_implemented', 'invalid_request', 'ai_unavailable']);

export function shouldRetryAgent(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL.has(code)) return false;
  return failureCount < 1;
}

/** The area cannot be used here: flag off, or the API is not live yet. */
export function isUnavailable(error: unknown): boolean {
  const code = apiErrorCode(error);
  return code === 'feature_disabled' || code === 'not_implemented';
}

/** How often the list refreshes while a kit is being prepared. */
export const PREPARING_POLL_MS = 4_000;

/** Refresh every Ready-to-apply read and the places a kit touches (tracker, job pages). */
export function invalidateReady(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: agentKeys.all }),
    qc.invalidateQueries({ queryKey: ['job'] }),
    qc.invalidateQueries({ queryKey: ['tracker'] }),
    qc.invalidateQueries({ queryKey: ['v3', 'pipeline'] }),
  ]).then(() => undefined);
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function useAgentSettings(options: { enabled?: boolean } = {}) {
  return useQuery<A.AgentSettingsResponse>({
    queryKey: agentKeys.settings(),
    queryFn: ({ signal }) => getAgentSettings({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    retry: shouldRetryAgent,
  });
}

export function useAgentSetup(options: { enabled?: boolean } = {}) {
  return useQuery<A.AgentSetupResponse>({
    queryKey: agentKeys.setup(),
    queryFn: ({ signal }) => getAgentSetup({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    retry: shouldRetryAgent,
  });
}

export function useSuggestions(options: { enabled?: boolean; limit?: number } = {}) {
  const limit = options.limit;
  return useQuery<Items<FeedItem>>({
    queryKey: agentKeys.suggestions(limit),
    queryFn: ({ signal }) => getSuggestions(limit === undefined ? undefined : { limit }, { signal }),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60_000,
    retry: shouldRetryAgent,
  });
}

/** The list refreshes itself while any kit is `preparing`. Pure, for tests. */
export function queueRefetchInterval(items: readonly A.QueueItemView[] | undefined): number | false {
  return items?.some((i) => i.state === 'preparing') ? PREPARING_POLL_MS : false;
}

/** GET /agent/queue: the items, plus WP-52's `weekKey` and per-tab `counts` when sent. */
export type ReadyQueueList = Omit<QueueListResult, 'items'> & { items: ReadyQueueItem[] };

export function useReadyQueue(options: { enabled?: boolean } = {}) {
  return useQuery<ReadyQueueList>({
    queryKey: agentKeys.queue(),
    queryFn: ({ signal }) => listQueue(undefined, { signal }),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
    retry: shouldRetryAgent,
    refetchInterval: (q) => queueRefetchInterval(q.state.data?.items),
  });
}

/** One kit's review data (GET /agent/queue/:id): resume, letter, AI availability, history. */
export function useKitDetail(id: string | null, options: { enabled?: boolean } = {}) {
  return useQuery<QueueItemDetail>({
    queryKey: agentKeys.kit(id ?? ''),
    queryFn: ({ signal }) => getKitDetail(id!, { signal }),
    enabled: (options.enabled ?? true) && !!id,
    staleTime: 15_000,
    retry: shouldRetryAgent,
  });
}

/** One kit's history rows (GET /agent/queue/:id/history). */
export function useKitHistory(id: string | null, options: { enabled?: boolean } = {}) {
  return useQuery<KitHistoryResponse>({
    queryKey: agentKeys.history(id ?? ''),
    queryFn: ({ signal }) => getKitHistory(id!, { signal }),
    enabled: (options.enabled ?? true) && !!id,
    staleTime: 15_000,
    retry: shouldRetryAgent,
  });
}

/**
 * May this kit offer AI actions ("Ask for changes", a new letter)? Fails
 * closed (TASK_PLAN §2.2, R-04): the brand capability `ai.text`, and the
 * account's own answer — the kit detail's `aiAvailable` (aiAllowed(user) on
 * the server; on GoApply the AI consent) or, without it, the resume check's
 * `aiAvailable` for the kit's resume. Unknown → false.
 */
export function useKitAiAvailable(detail: QueueItemDetail | null | undefined, resumeVariantId: string | null): boolean {
  const capability = useFlag('ai.text');
  const fromDetail = typeof detail?.kit.aiAvailable === 'boolean' ? detail.kit.aiAvailable : null;
  const fromResume = useTailorAvailability(capability && fromDetail === null ? resumeVariantId : null);
  if (!capability) return false;
  return fromDetail ?? fromResume.available;
}

/** The brand's common application questions (canonical keys, WP-52). */
export function useQuestionKeys(options: { enabled?: boolean } = {}) {
  return useQuery<Items<QuestionKeyView>>({
    queryKey: agentKeys.questions(),
    queryFn: ({ signal }) => getQuestionKeys({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 60 * 60_000,
    retry: shouldRetryAgent,
  });
}

export function useAnswerBank(options: { enabled?: boolean } = {}) {
  return useQuery<Items<A.AnswerBankItemView>>({
    queryKey: agentKeys.answers(),
    queryFn: ({ signal }) => getAnswerBank({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    retry: shouldRetryAgent,
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────

export function useSaveAgentSettings() {
  const qc = useQueryClient();
  return useMutation<A.AgentSettingsResponse, Error, In<typeof A.PutAgentSettingsBodySchema>>({
    mutationFn: (body) => putAgentSettings(body),
    onSuccess: (settings) => {
      qc.setQueryData(agentKeys.settings(), settings);
      void qc.invalidateQueries({ queryKey: agentKeys.setup() });
      void qc.invalidateQueries({ queryKey: agentKeys.suggestions() });
    },
  });
}

export function useCalibrate() {
  const qc = useQueryClient();
  return useMutation<A.AgentSetupResponse, Error, In<typeof A.CalibrationBodySchema>>({
    mutationFn: (body) => submitCalibration(body),
    onSuccess: (setup) => qc.setQueryData(agentKeys.setup(), setup),
  });
}

/**
 * Finish (or, for "Get the extension", skip) one wizard step. The server
 * finishes setup after the last step and then makes the first weekly list
 * (`firstList`).
 */
export function useCompleteSetupStep() {
  const qc = useQueryClient();
  return useMutation<SetupStepResponse, Error, SetupStepBody>({
    mutationFn: (body) => completeSetupStep(body),
    onSuccess: (setup) => {
      qc.setQueryData(agentKeys.setup(), setup);
      if (setup.firstList) void qc.invalidateQueries({ queryKey: agentKeys.queue() });
    },
  });
}

/**
 * Add jobs from the search now (filter changes made inside Ready to apply go
 * in `overrides`). The server keeps `overrides` in the settings
 * (`listFilters.overrides`), so the settings are read again when they were sent.
 */
export function useGenerateList() {
  const qc = useQueryClient();
  return useMutation<GenerateListResponse, Error, GenerateListBody>({
    mutationFn: (body) => generateList(body),
    onSuccess: async (_data, body) => {
      void qc.invalidateQueries({ queryKey: agentKeys.queue() });
      void qc.invalidateQueries({ queryKey: agentKeys.suggestions() });
      // Awaited: the caller's `mutateAsync` resolves with the kept filters already on screen.
      if (body?.overrides) await qc.invalidateQueries({ queryKey: agentKeys.settings() });
    },
  });
}

export function useAddToList() {
  const qc = useQueryClient();
  return useMutation<Items<A.QueueItemView>, Error, In<typeof A.AddToQueueBodySchema>>({
    mutationFn: (body) => addToQueue(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.queue() });
      void qc.invalidateQueries({ queryKey: agentKeys.suggestions() });
    },
  });
}

export function useSaveAnswers() {
  const qc = useQueryClient();
  return useMutation<Items<A.AnswerBankItemView>, Error, In<typeof A.PutAnswersBodySchema>>({
    mutationFn: (body) => putAnswerBank(body),
    onSuccess: (data) => {
      qc.setQueryData(agentKeys.answers(), data);
      void qc.invalidateQueries({ queryKey: agentKeys.setup() });
    },
  });
}

export type KitAction = 'confirm' | 'open' | 'undo' | 'applied' | 'skip' | 'restore' | 'remove';

/** Every per-kit action, each refreshing the list (and the tracker) afterwards. */
export function useKitActions(id: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<KitAction | null>(null);
  const wrap = useCallback(
    async <T,>(action: KitAction, fn: () => Promise<T>): Promise<T> => {
      setPending(action);
      try {
        return await fn();
      } finally {
        setPending(null);
        void invalidateReady(qc);
      }
    },
    [qc],
  );
  return {
    pending,
    confirm: (body: In<typeof A.ConfirmPartBodySchema>) => wrap('confirm', () => confirmKitPart(id, body)),
    open: () => wrap('open', () => openApplication(id)),
    undo: () => wrap('undo', () => undoQueueApplied(id)),
    markApplied: () => wrap('applied', () => markQueueApplied(id)),
    skip: () => wrap('skip', () => skipQueueItem(id)),
    restore: () => wrap('restore', () => restoreQueueItem(id)),
    remove: () => wrap('remove', () => removeQueueItem(id)),
  };
}

// ── Preparing kits (F-AGENT-10) ─────────────────────────────────────────────

export interface PrepareQuote {
  /** Queue item ids the quote covers. */
  ids: string[];
  /** Credits per bucket, summed from the server's proposals (never computed here). */
  totals: Record<'tailor' | 'cover_letter', number>;
  /** Kits the run uses: the server's `ready_kits` lines when it sends them, else one per kit. */
  kits: number;
  /** False when the server says the kits are prepared without AI; null when it does not say. */
  aiAvailable: boolean | null;
  /** Items whose proposal could not be read (kept out of the run). */
  failed: string[];
}

type ProposalLine = { bucket: string; cost: number };
type Proposal = { credits: ReadonlyArray<ProposalLine>; confirmed?: boolean; aiAvailable?: boolean };

/** Kits a quote uses. Pure, for tests. */
export function kitsInProposals(proposals: ReadonlyArray<Proposal | null>): number {
  let sent = false;
  let total = 0;
  for (const p of proposals) {
    for (const c of p?.credits ?? []) {
      if (c.bucket === 'ready_kits' && Number.isFinite(c.cost) && c.cost >= 0) {
        sent = true;
        total += c.cost;
      }
    }
  }
  return sent ? total : proposals.filter(Boolean).length;
}

/** False when any proposal says AI is unavailable; null when none says. Pure. */
export function aiInProposals(proposals: ReadonlyArray<Proposal | null>): boolean | null {
  let seen: boolean | null = null;
  for (const p of proposals) {
    if (typeof p?.aiAvailable !== 'boolean') continue;
    if (!p.aiAvailable) return false;
    seen = true;
  }
  return seen;
}

export type PrepareRunResult =
  | { ok: true; prepared: string[]; failed: string[] }
  | { ok: false; reason: 'credits_exhausted'; prepared: string[]; info: CreditsExhaustedInfo };

/** Sum the server's proposals. Pure, for tests. */
export function sumProposals(proposals: ReadonlyArray<Proposal | null>): PrepareQuote['totals'] {
  const totals = { tailor: 0, cover_letter: 0 };
  for (const p of proposals) {
    for (const c of (p?.credits ?? []) as ProposalLine[]) {
      if ((c.bucket === 'tailor' || c.bucket === 'cover_letter') && Number.isFinite(c.cost) && c.cost > 0) totals[c.bucket] += c.cost;
    }
  }
  return totals;
}

/**
 * Two steps, so the cost is on screen before anything is spent:
 *   quote(ids)  → POST /prepare without `confirm` (a credit proposal; nothing runs)
 *   run(ids)    → POST /prepare { confirm: true } per kit, one Idempotency-Key
 *                 each, through the `ready_kits` credit gate. A 402 stops the
 *                 run and opens the out-of-credits sheet with the server's
 *                 bucket and reset time.
 */
export function usePrepareKits() {
  const qc = useQueryClient();
  const gate = useCreditGate('ready_kits');
  const [busy, setBusy] = useState<'quote' | 'run' | null>(null);

  const quote = useCallback(async (ids: string[]): Promise<PrepareQuote> => {
    setBusy('quote');
    try {
      const results = await Promise.all(
        ids.map((id) =>
          prepareKit(id, {})
            .then((p) => ({ id, p }))
            .catch(() => ({ id, p: null as A.PrepareProposal | null })),
        ),
      );
      const proposals = results.map((r) => r.p as Proposal | null);
      return {
        ids: results.filter((r) => r.p).map((r) => r.id),
        totals: sumProposals(proposals),
        kits: kitsInProposals(proposals),
        aiAvailable: aiInProposals(proposals),
        failed: results.filter((r) => !r.p).map((r) => r.id),
      };
    } finally {
      setBusy(null);
    }
  }, []);

  const run = useCallback(
    async (ids: string[]): Promise<PrepareRunResult> => {
      setBusy('run');
      const prepared: string[] = [];
      const failed: string[] = [];
      try {
        for (const id of ids) {
          try {
            const r = await gate.run((idempotencyKey) => prepareKit(id, { confirm: true }, { idempotencyKey }));
            if (!r.ok) return { ok: false, reason: 'credits_exhausted', prepared, info: r.info };
            prepared.push(id);
          } catch {
            failed.push(id);
          }
        }
        return { ok: true, prepared, failed };
      } finally {
        setBusy(null);
        void invalidateReady(qc);
      }
    },
    [gate, qc],
  );

  return { quote, run, busy, gate };
}
