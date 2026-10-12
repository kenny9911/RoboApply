'use client';

// hooks/copilot/useCopilotAvailability.ts — may this user ask the Assistant?
// (WP-51; TASK_PLAN.md §2.2 "when aiAllowed is false COP hides its AI
// actions"; R-04 a disabled AI path has no UI entry).
//
// Three checks, all fail closed:
//   1. the brand capability `copilot` (brand has an AI text model);
//   2. the user's AI consent, mirroring the server's aiAllowed(user):
//      RoboApply → always; GoApply → the `ai_resume_parsing` grant is live.
//      Read from the consent catalog (/compliance/consents, the same cached
//      query the memory section uses). While unknown on GoApply: not allowed.
//   3. nothing this session has answered `ai_unavailable`: the server is the
//      final word, so after one such turn the composer and chips stay hidden
//      until the next page load (markAssistantAiUnavailable).
//
// Until WP-50 exposes `aiAvailable` on the copilot API (requested), check 2
// is computed here from the consent catalog.

import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { getConsents } from '../../lib/api/compliance';
import { useBrand } from '../../lib/brand';
import { useFlag } from '../../lib/flags';
import { createStore } from '../shared/store';
import { consentsKey } from './keys';

/** The GoApply consent the server's aiAllowed(user) reads. */
export const AI_CONSENT_TYPE = 'ai_resume_parsing';

const blockedStore = createStore<boolean>(false);

/** A turn ended with `ai_unavailable`: hide the Assistant's AI actions for this session. */
export function markAssistantAiUnavailable(): void {
  blockedStore.set(true);
}

/** Tests only. */
export function __resetAssistantAvailability(): void {
  blockedStore.reset();
}

export interface AiConsent {
  /** The user may use AI: always on RoboApply; on GoApply the `ai_resume_parsing` grant is live. */
  allowed: boolean;
  /** Still waiting for the consent answer (GoApply only): not allowed yet. */
  loading: boolean;
  /** GoApply: the consent is known to be off (refused, withdrawn or never given). */
  off: boolean;
}

/**
 * The user's AI consent, mirroring the server's aiAllowed(user). Fails closed:
 * while unknown on GoApply nothing AI is offered. Other areas that only need
 * "may this user see an AI entry?" (the tracker's follow-up draft) use this;
 * the server stays the final word (503 ai_unavailable before any credit).
 */
export function useAiConsent(options: { enabled?: boolean } = {}): AiConsent {
  const brand = useBrand();
  const locale = useLocale();
  const needsConsent = brand.market === 'cn';
  const consents = useQuery({
    queryKey: consentsKey(locale),
    queryFn: ({ signal }) => getConsents({ locale }, { signal }),
    enabled: (options.enabled ?? true) && needsConsent,
    retry: false,
  });
  if (!needsConsent) return { allowed: true, loading: false, off: false };
  const granted = consents.data?.items.find((c) => c.type === AI_CONSENT_TYPE)?.granted === true;
  return { allowed: granted, loading: consents.isLoading, off: consents.isSuccess && !granted };
}

export interface CopilotAvailability {
  /** The brand has the Assistant at all (`copilot` capability). */
  capability: boolean;
  /** The user may ask now: capability, AI consent and no `ai_unavailable` this session. */
  canAsk: boolean;
  /** Still waiting for the consent answer (GoApply only). */
  loading: boolean;
  /** GoApply: the user's AI consent is known to be off (or was never given). */
  consentOff: boolean;
  /** A turn this session ended with `ai_unavailable`. */
  blocked: boolean;
}

export function useCopilotAvailability(): CopilotAvailability {
  const capability = useFlag('copilot');
  const blocked = useSyncExternalStore(blockedStore.subscribe, blockedStore.get, () => false);
  const consent = useAiConsent({ enabled: capability });

  if (!capability) return { capability, canAsk: false, loading: false, consentOff: false, blocked };
  return { capability, canAsk: consent.allowed && !blocked, loading: consent.loading, consentOff: consent.off, blocked };
}
