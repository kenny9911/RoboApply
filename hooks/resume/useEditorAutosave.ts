'use client';

// useEditorAutosave — the resume editor's document state: hydrate the
// structured resume from the stored markdown, and save it (debounced) only
// after the user has changed something.
//
// "Changed" is measured against what the loaded resume serializes to, NOT
// against the stored markdown text. The stored text of an uploaded resume is
// in the upload format (`**Role — Company** · When`), which the serializer
// writes differently (`### Company · Role · When`). The editor used to compare
// its serialization with the stored text, so for every upload the two differed
// from the first render: it showed "Saving…" on open and rewrote the resume
// with no user edit (and marked Resume check stale each time). With the
// baseline below, a resume that was only opened is never saved.
//
// A save that fails (offline, 5xx) is tried again on its own, 2 s later, then
// 4 s, 8 s … up to 30 s apart, until it goes through or the user edits again
// (which starts a fresh save). The header says "Not saved yet — trying again"
// in that state, so a retry has to be under way even when nobody is typing.
//
// Hydration runs on first load, on a resume switch, and on a real external
// change. An autosave echo (the PATCH response carrying what was just sent)
// and a refetch racing local edits are ignored, so typing is never interrupted
// and row ids / focus survive.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { parseResumeMarkdown, serializeResumeMarkdown, type StructuredResume } from '../../lib/resumeStructure';

export type EditorSaveState = 'idle' | 'saving' | 'saved' | 'error';

export const EDITOR_AUTOSAVE_MS = 1200;
/** Wait before the first retry of a failed save; doubles each time, capped. */
export const EDITOR_RETRY_MS = 2000;
export const EDITOR_RETRY_MAX_MS = 30000;

export interface EditorAutosave {
  structured: StructuredResume | null;
  setStructured: Dispatch<SetStateAction<StructuredResume | null>>;
  saveState: EditorSaveState;
  /** Counts hydrations from the server (first load, resume switch, external change). */
  hydrations: number;
}

export function useEditorAutosave(
  resume: { id: string; resumeMarkdown: string } | null | undefined,
  /** Persist the serialized markdown; reject to mark the save as failed. */
  save: (markdown: string) => Promise<unknown>,
  delayMs: number = EDITOR_AUTOSAVE_MS,
): EditorAutosave {
  const [structured, setStructured] = useState<StructuredResume | null>(null);
  const [saveState, setSaveState] = useState<EditorSaveState>('idle');
  const [hydrations, setHydrations] = useState(0);

  /** The markdown the server last returned, or that was last sent to it. */
  const serverRef = useRef('');
  /** What the loaded (or last saved) resume serializes to: "no edit" looks like this. */
  const baselineRef = useRef('');
  const hydratedIdRef = useRef<string | null>(null);
  /** True while `structured` differs from the baseline. */
  const dirtyRef = useRef(false);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  /** Bumped when a failed save is due for another attempt; re-runs the save effect. */
  const [retryTick, setRetryTick] = useState(0);
  const seenTickRef = useRef(0);
  /** Consecutive failed saves of the current edit. */
  const failuresRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!resume) return;
    const sameDoc = hydratedIdRef.current === resume.id;
    if (sameDoc && resume.resumeMarkdown === serverRef.current) return;
    if (sameDoc && dirtyRef.current) return;
    const parsed = parseResumeMarkdown(resume.resumeMarkdown);
    hydratedIdRef.current = resume.id;
    serverRef.current = resume.resumeMarkdown;
    baselineRef.current = serializeResumeMarkdown(parsed);
    dirtyRef.current = false;
    setStructured(parsed);
    setHydrations((n) => n + 1);
  }, [resume]);

  useEffect(() => {
    // This run supersedes any retry that was waiting.
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    const isRetry = retryTick !== seenTickRef.current;
    seenTickRef.current = retryTick;
    if (!structured) return;
    const serialized = serializeResumeMarkdown(structured);
    dirtyRef.current = serialized !== baselineRef.current;
    if (!dirtyRef.current) {
      // An edit that was undone before the save fired (or another resume was
      // loaded) leaves nothing to save.
      failuresRef.current = 0;
      setSaveState((s) => (s === 'saving' || s === 'error' ? 'idle' : s));
      return;
    }
    // A new edit starts over; a retry keeps "not saved yet" on screen and
    // sends at once (its wait was the backoff).
    if (!isRetry) {
      failuresRef.current = 0;
      setSaveState('saving');
    }
    let live = true;
    const handle = setTimeout(async () => {
      // Commit before the request resolves: the save writes its response into
      // the query cache, and the hydration effect compares against these refs.
      const prev = { server: serverRef.current, baseline: baselineRef.current };
      serverRef.current = serialized;
      baselineRef.current = serialized;
      dirtyRef.current = false;
      try {
        await saveRef.current(serialized);
        failuresRef.current = 0;
        // A newer edit still waiting for its own save keeps "Saving…".
        setSaveState((s) => (live || !dirtyRef.current ? 'saved' : s));
      } catch {
        // Unless a later save has already taken over the refs, the document
        // is back to "differs from what the server has".
        if (baselineRef.current === serialized) {
          serverRef.current = prev.server;
          baselineRef.current = prev.baseline;
          dirtyRef.current = true;
        }
        if (unmountedRef.current) return;
        setSaveState('error');
        failuresRef.current += 1;
        const wait = Math.min(EDITOR_RETRY_MS * 2 ** (failuresRef.current - 1), EDITOR_RETRY_MAX_MS);
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          setRetryTick((n) => n + 1);
        }, wait);
      }
    }, isRetry ? 0 : delayMs);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [structured, delayMs, retryTick]);

  return { structured, setStructured, saveState, hydrations };
}
