'use client';

// hooks/coverletter/useCoverLetters.ts — cover letter state (WP-37).
//
//   const list = useCoverLetterList({ jobId });        letters, newest first ("Load more" pages)
//   const letter = useCoverLetter(id);                  one letter (body, sources, versions)
//   const create = useCreateCoverLetter();              await create.run(body) → spends a cover_letter credit
//   const editor = useLetterEditor(letter.data);        local text + autosave (PATCH after a pause)
//   const actions = useLetterActions(id);               rewrite · regenerate · restore · attach · remove
//
// API calls go through lib/api/coverLetters.ts only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createCoverLetter,
  deleteCoverLetter,
  getCoverLetter,
  listCoverLetters,
  patchCoverLetter,
  regenerateCoverLetter,
  restoreCoverLetter,
  rewriteCoverLetter,
} from '../../lib/api/coverLetters';
import { getJob } from '../../lib/api/jobs';
import { apiErrorCode, apiErrorDetails } from '../../lib/api/contracts/wire';
import type { CoverLetterView, LetterLength, LetterLocale, LetterTone, ListLettersResponse } from '../../lib/api/contracts/coverletter';
import { useCreditGate } from '../shared/useCreditGate';

export const coverLetterKeys = {
  all: ['cover-letters'] as const,
  list: (jobId?: string | null) => ['cover-letters', 'list', jobId ?? 'all'] as const,
  detail: (id: string) => ['cover-letters', 'detail', id] as const,
};

export type LetterErrorKind =
  | 'credits_exhausted'
  | 'ai_unavailable'
  | 'safety_unavailable'
  | 'content_blocked'
  | 'phone_binding_required'
  | 'claim_rejected'
  | 'rewrite_limit'
  | 'resume_unverified'
  | 'resume_too_short'
  | 'posting_unavailable'
  | 'pdf_unavailable'
  | 'not_found'
  | 'failed';

/** Map a failed call to the states the UI explains in plain words. */
export function letterErrorKind(err: unknown): LetterErrorKind {
  const code = apiErrorCode(err);
  const reason = apiErrorDetails<{ reason?: string }>(err)?.reason;
  switch (code) {
    case 'credits_exhausted':
      return 'credits_exhausted';
    case 'ai_unavailable':
      return reason === 'content_safety_unavailable' ? 'safety_unavailable' : 'ai_unavailable';
    case 'content_blocked':
      return 'content_blocked';
    case 'phone_binding_required':
      return 'phone_binding_required';
    case 'rate_limited':
      return reason === 'cover_letter_rewrite_limit' ? 'rewrite_limit' : 'failed';
    case 'not_found':
      return 'not_found';
    case 'invalid_request':
      return reason === 'resume_too_short' ? 'resume_too_short' : 'failed';
    case 'conflict':
      if (reason === 'cover_letter_claim_rejected') return 'claim_rejected';
      if (reason === 'resume_unverified_claims') return 'resume_unverified';
      if (reason === 'posting_unavailable') return 'posting_unavailable';
      if (reason === 'pdf_font_unavailable') return 'pdf_unavailable';
      return 'failed';
    default:
      return 'failed';
  }
}

export function useCoverLetterList(options: { jobId?: string | null; enabled?: boolean } = {}) {
  return useInfiniteQuery<ListLettersResponse>({
    queryKey: coverLetterKeys.list(options.jobId),
    queryFn: ({ pageParam, signal }) =>
      listCoverLetters({ jobId: options.jobId ?? undefined, cursor: (pageParam as string | undefined) ?? undefined }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}

export function useCoverLetter(id: string | null | undefined) {
  return useQuery<CoverLetterView>({
    queryKey: id ? coverLetterKeys.detail(id) : ['cover-letters', 'detail', 'none'],
    queryFn: ({ signal }) => getCoverLetter(id as string, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export interface NewLetterInput {
  jobId?: string;
  jd?: { title: string; company: string; text: string };
  resumeVariantId: string;
  tone: LetterTone;
  length: LetterLength;
  locale?: LetterLocale;
  trackerEntryId?: string;
}

export type LetterResult = { ok: true; letter: CoverLetterView } | { ok: false; error: LetterErrorKind; cause?: unknown };

/** Write a new letter (one `cover_letter` credit; the gate opens the out-of-credits sheet when none are left). */
export function useCreateCoverLetter() {
  const qc = useQueryClient();
  const gate = useCreditGate('cover_letter');
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (input: NewLetterInput): Promise<LetterResult> => {
      setPending(true);
      try {
        const r = await gate.run((idempotencyKey) => createCoverLetter(input, { idempotencyKey }));
        if (!r.ok) return { ok: false, error: 'credits_exhausted' };
        qc.setQueryData(coverLetterKeys.detail(r.value.id), r.value);
        void qc.invalidateQueries({ queryKey: ['cover-letters', 'list'] });
        return { ok: true, letter: r.value };
      } catch (err) {
        return { ok: false, error: letterErrorKind(err), cause: err };
      } finally {
        setPending(false);
      }
    },
    [gate, qc],
  );

  return { run, pending, creditsLeft: gate.left, summary: gate.summary };
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Autosave delay after the last keystroke. */
export const AUTOSAVE_MS = 1_200;

/**
 * Local editor text with autosave. The server snapshots edits as versions
 * (one per 10 minutes of typing), so saving often is cheap and safe.
 */
export function useLetterEditor(letter: CoverLetterView | undefined) {
  const qc = useQueryClient();
  const [text, setText] = useState<string>(letter?.bodyMarkdown ?? '');
  const [state, setState] = useState<SaveState>('idle');
  const saved = useRef<string>(letter?.bodyMarkdown ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const id = letter?.id;

  // Server-side changes (rewrite, restore, regenerate, first load) replace the text.
  useEffect(() => {
    if (!letter) return;
    if (letter.bodyMarkdown !== saved.current) {
      saved.current = letter.bodyMarkdown;
      setText(letter.bodyMarkdown);
    }
  }, [letter]);

  const save = useCallback(
    async (body: string) => {
      if (!id || body === saved.current) return;
      setState('saving');
      try {
        const next = await patchCoverLetter(id, { bodyMarkdown: body });
        saved.current = next.bodyMarkdown;
        qc.setQueryData(coverLetterKeys.detail(id), next);
        setState('saved');
      } catch {
        setState('error');
      }
    },
    [id, qc],
  );

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return save(textRef.current);
  }, [save]);

  const change = useCallback(
    (next: string) => {
      setText(next);
      setState('idle');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void save(next);
      }, AUTOSAVE_MS);
    },
    [save],
  );

  // Save what is pending when the editor goes away.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void save(textRef.current);
      }
    },
    [save],
  );

  return { text, change, flush, state, dirty: text !== saved.current };
}

export function useLetterActions(id: string) {
  const qc = useQueryClient();
  const gate = useCreditGate('cover_letter');
  const [pending, setPending] = useState<null | 'rewrite' | 'regenerate' | 'restore' | 'attach' | 'remove'>(null);

  const apply = useCallback(
    (next: CoverLetterView) => {
      qc.setQueryData(coverLetterKeys.detail(id), next);
      void qc.invalidateQueries({ queryKey: ['cover-letters', 'list'] });
    },
    [id, qc],
  );

  const wrap = useCallback(
    async (kind: NonNullable<typeof pending>, fn: () => Promise<CoverLetterView>): Promise<LetterResult> => {
      setPending(kind);
      try {
        const next = await fn();
        apply(next);
        return { ok: true, letter: next };
      } catch (err) {
        return { ok: false, error: letterErrorKind(err), cause: err };
      } finally {
        setPending(null);
      }
    },
    [apply],
  );

  const rewrite = useCallback((instruction: string) => wrap('rewrite', () => rewriteCoverLetter(id, { instruction })), [id, wrap]);

  const regenerate = useCallback(
    async (body: { tone?: LetterTone; length?: LetterLength; locale?: LetterLocale }): Promise<LetterResult> => {
      setPending('regenerate');
      try {
        const r = await gate.run((idempotencyKey) => regenerateCoverLetter(id, body, { idempotencyKey }));
        if (!r.ok) return { ok: false, error: 'credits_exhausted' };
        apply(r.value);
        return { ok: true, letter: r.value };
      } catch (err) {
        return { ok: false, error: letterErrorKind(err), cause: err };
      } finally {
        setPending(null);
      }
    },
    [apply, gate, id],
  );

  const restore = useCallback((versionIndex: number) => wrap('restore', () => restoreCoverLetter(id, { versionIndex })), [id, wrap]);
  const attach = useCallback((trackerEntryId: string | null) => wrap('attach', () => patchCoverLetter(id, { trackerEntryId })), [id, wrap]);

  const remove = useCallback(async (): Promise<boolean> => {
    setPending('remove');
    try {
      await deleteCoverLetter(id);
      qc.removeQueries({ queryKey: coverLetterKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: ['cover-letters', 'list'] });
      return true;
    } catch {
      return false;
    } finally {
      setPending(null);
    }
  }, [id, qc]);

  return { rewrite, regenerate, restore, attach, remove, pending, creditsLeft: gate.left, summary: gate.summary };
}

/** Title and company of the job a letter is for (job detail API); null while unknown or when it fails. */
export function useLetterJob(jobId: string | null | undefined) {
  return useQuery<{ title: string; company: string } | null>({
    queryKey: ['cover-letters', 'job', jobId ?? 'none'],
    queryFn: async ({ signal }) => {
      try {
        const d = await getJob(jobId as string, { signal });
        return { title: d.job.title, company: d.company?.name || d.job.companyName };
      } catch {
        return null;
      }
    },
    enabled: Boolean(jobId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
