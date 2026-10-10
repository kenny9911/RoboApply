'use client';

// hooks/shared/useOpenAssistant.ts — open the Assistant rail from anywhere
// (R-10; F-ORION-01; FND-7).
//
//   const openAssistant = useOpenAssistant();
//   <button onClick={() => openAssistant({ jobId, source: 'job_card' })}>Ask about this job</button>
//   <button onClick={() => openAssistant({ scope: 'resume', resumeId, source: 'resume' })}>Ask about this resume</button>
//
// The rail (`components/features/copilot/CopilotRail.tsx`, FND-6a slot,
// WP-51) reads `useAssistantRail()`. Rules:
//   - The rail opens only on an explicit user action. Nothing here listens to
//     route changes, so it never auto-opens on navigation (FND-6a acceptance).
//   - With the `copilot` capability off there is no Assistant: `open()` does
//     nothing and returns false (a disabled feature has no UI, R-04).
//   - Each request carries a sequence number, so asking about the same job
//     twice still reaches the rail.

import { useCallback, useSyncExternalStore } from 'react';

import { useFlag } from '../../lib/flags';
import { createStore } from './store';

export type AssistantSource =
  | 'topbar'
  | 'command_palette'
  | 'job_card'
  | 'job_detail'
  | 'tracker'
  | 'resume'
  | 'ready'
  | 'onboarding'
  | 'other';

/** What a new conversation is about: a job (chips show) or one resume (F-RES-11). */
export type AssistantScope = 'job' | 'resume';

export interface AssistantOpenRequest {
  /** Thread context: the job the user is asking about. */
  jobId?: string | null;
  /**
   * The resume the user is asking about (F-RES-11, the resume editor). With
   * `scope: 'resume'` the rail starts a chat scoped to this resume and every
   * turn carries it (`SendMessageBody.resumeId`), so "my resume" means this one.
   */
  resumeId?: string | null;
  /** Default: `'job'` when `jobId` is set. `'resume'` needs `resumeId`. */
  scope?: AssistantScope;
  /** Continue an existing thread. */
  threadId?: string | null;
  /** Text to prefill (never sent without the user pressing Send). */
  prompt?: string;
  source?: AssistantSource;
}

export interface AssistantRailState {
  open: boolean;
  request: AssistantOpenRequest | null;
  /** Increments on every open request. */
  seq: number;
}

const INITIAL: AssistantRailState = { open: false, request: null, seq: 0 };
const rail = createStore<AssistantRailState>(INITIAL);

/** Imperative open (for non-React callers such as keyboard shortcuts). Does not check the flag. */
export function openAssistantRail(request: AssistantOpenRequest = {}): void {
  rail.set((prev) => ({ open: true, request, seq: prev.seq + 1 }));
}

export function closeAssistantRail(): void {
  rail.set((prev) => (prev.open ? { ...prev, open: false } : prev));
}

/** Returns `open(request)`; false when the Assistant is not available on this brand/user. */
export function useOpenAssistant(): (request?: AssistantOpenRequest) => boolean {
  const enabled = useFlag('copilot');
  return useCallback(
    (request: AssistantOpenRequest = {}) => {
      if (!enabled) return false;
      openAssistantRail(request);
      return true;
    },
    [enabled],
  );
}

/** For the rail: current state plus close. */
export function useAssistantRail(): AssistantRailState & { close: () => void } {
  const state = useSyncExternalStore(rail.subscribe, rail.get, () => INITIAL);
  return { ...state, close: closeAssistantRail };
}

/** Tests only. */
export const __assistantRailStore = rail;
