'use client';

// hooks/useSetup.ts — data layer for the two-step first-run setup panel.
//
// Replaces `hooks/useOnboardingChat.ts` (deleted with the chat). There is no
// stream here, no transcript, no quick replies: five plain JSON calls and a
// local draft reducer.
//
//   POST /onboarding/bootstrap  → the seeded OnboardingSetupState (step 2's
//                                 whole screen), taken after a resume lands.
//   GET  /onboarding/session    → the same shape, for a mid-step reload and
//                                 for the ONE enrichment re-fetch below.
//   POST /onboarding/confirm    → persist; the feed then refetches with it.
//   POST /onboarding/skip       → always 200, writes no preferences.
//   POST /onboarding/seen       → the auto-open counter. Panel-open only.
//
// ─── WHY THE DRAFT LIVES HERE AND NOT IN THE SERVER SESSION ───────────────
//
// Step 2 is a CONFIRM screen. Its core interaction is REMOVING a value the
// server seeded — "QA Lead" is on the resume but the user never wants to see
// it again. `mergeDraft` on the server UNIONS array fields, so a removal
// posted as a partial update silently does nothing. The client therefore owns
// the complete post-edit state and posts it whole, and `POST /confirm`
// REPLACES every key it receives, including `[]`.
//
// ─── WHICH KEYS WE SEND, AND WHY THAT IS NOT "ALL OF THEM" ────────────────
//
// A key ABSENT from the confirm body is left untouched; a key PRESENT replaces
// the seed wholesale. Both behaviours are needed:
//
//   • `targetRoles`, `workModes`, `locations`, `targetCompanies` are sent
//     ALWAYS. They are the four the user can see and edit on screen, and three
//     of them reach retrieval (`q`, `workType`, `location`), so "what is on
//     screen" and "what filters the feed" must be the same list. `locations`
//     in particular MUST be explicit: it arrives in `proposedFields` — seeded
//     but not applied — and if we omitted it the server would keep the seeded
//     city and confirm it at 1.0, which is precisely the silent-inversion
//     failure (resume says Bangalore, user wants remote EU) that the unselected
//     suggestion chip exists to prevent.
//
//   • `employmentTypes` and `industriesTarget` are sent ONLY when the user
//     actually edited them. They are also seeded, but `industriesTarget` is
//     the one field the parallel LLM seed contributes, and it can land AFTER
//     bootstrap returned. Sending our stale snapshot would delete it. Untouched
//     means "no opinion", which is exactly what an absent key means.
//
//   • `salary` is never sent, never seeded, never rendered. A guessed floor is
//     applied as `salaryMax >= min`, and Prisma's `gte` does not match NULL, so
//     it deletes every posting without a published range — most of them.
//
// Query keys are namespaced `['v3','setup',…]` per the build rules.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  OnboardingConfirmResponse,
  OnboardingDraftPreferences,
  OnboardingSetupState,
  OnboardingStep,
  RAEmploymentType,
  RAWorkType,
} from '../lib/api/v2/types';
import { RoboApiError } from '../lib/api/client';
import { useAuth } from '../lib/auth/AuthProvider';
import { preferenceKeys } from './usePreferences';
import { resumeKeys } from './useResumes';
import { todayKeys } from './useTodayMatches';

export const setupKeys = {
  all: ['v3', 'setup'] as const,
  session: () => ['v3', 'setup', 'session'] as const,
};

/**
 * How long to wait before the single enrichment re-fetch.
 *
 * The deterministic seed renders step 2 immediately; one Haiku call runs in
 * parallel and can land later. We re-read the session EXACTLY ONCE, and only
 * when `enrichmentPending && thin` — that is the single case where the late
 * seed changes what the screen renders (a thin resume has no roles at all
 * until the model supplies some). In every other case the screen is already
 * correct and a re-fetch would only risk stomping an edit in flight.
 */
export const ENRICHMENT_REFETCH_MS = 1500;

// ─────────────────────────────────────────────────────────────────────
// Draft state — pure, exported, unit-tested without React
// ─────────────────────────────────────────────────────────────────────

/** The six controls step 2 renders, by draft field name. */
export type SetupDraftField =
  | 'targetRoles'
  | 'workModes'
  | 'locations'
  | 'employmentTypes'
  | 'industriesTarget'
  | 'targetCompanies';

export interface SetupDraftState {
  targetRoles: string[];
  workModes: RAWorkType[];
  /** `locations.cities`. Starts EMPTY even when the seed proposed a city — the
   *  proposal renders as an unselected suggestion chip, never as a value. */
  cities: string[];
  /** `locations.countries`, carried through untouched. The confirm body
   *  replaces `locations` as a whole object, so dropping this would silently
   *  clear a country the user set in Settings. */
  countries: string[];
  employmentTypes: RAEmploymentType[];
  industriesTarget: string[];
  targetCompanies: string[];
  /** Fields the user has actually changed. Drives the send/omit rule above. */
  touched: SetupDraftField[];
}

export type SetupDraftAction =
  /** Seed (or re-seed) from the server. `preserveTouched` keeps any field the
   *  user already edited — used by the enrichment re-fetch. */
  | {
      type: 'hydrate';
      state: OnboardingSetupState;
      preserveTouched?: boolean;
    }
  | { type: 'add'; field: SetupDraftField; value: string }
  | { type: 'remove'; field: SetupDraftField; value: string }
  | { type: 'toggle'; field: 'workModes'; value: RAWorkType }
  | { type: 'toggleEmployment'; value: RAEmploymentType };

export function emptyDraftState(): SetupDraftState {
  return {
    targetRoles: [],
    workModes: [],
    cities: [],
    countries: [],
    employmentTypes: [],
    industriesTarget: [],
    targetCompanies: [],
    touched: [],
  };
}

/** Trim, drop blanks, drop case-insensitive duplicates, cap the list. */
function addTo(list: string[], raw: string, cap = 10): string[] {
  const value = raw.trim();
  if (!value) return list;
  if (list.some((v) => v.toLowerCase() === value.toLowerCase())) return list;
  return [...list, value].slice(0, cap);
}

function withTouched(
  touched: SetupDraftField[],
  field: SetupDraftField,
): SetupDraftField[] {
  return touched.includes(field) ? touched : [...touched, field];
}

/**
 * Seed the editable state from a server `OnboardingSetupState`.
 *
 * `proposedFields` is the important asymmetry: a field listed there was seeded
 * but NOT applied, so it must not become a value. Today that is exactly
 * `locations` — the resume's city is a question ("Still in Berlin?"), not a
 * stated destination.
 */
export function draftStateFromSession(
  session: OnboardingSetupState,
): SetupDraftState {
  const d = session.draft ?? {};
  const proposed = new Set(session.proposedFields ?? []);
  const cities = proposed.has('locations') ? [] : (d.locations?.cities ?? []);
  return {
    targetRoles: d.targetRoles ?? [],
    workModes: proposed.has('workModes') ? [] : (d.workModes ?? []),
    cities,
    countries: d.locations?.countries ?? [],
    employmentTypes: d.employmentTypes ?? [],
    industriesTarget: d.industriesTarget ?? [],
    targetCompanies: d.targetCompanies ?? [],
    touched: [],
  };
}

export function setupDraftReducer(
  state: SetupDraftState,
  action: SetupDraftAction,
): SetupDraftState {
  switch (action.type) {
    case 'hydrate': {
      const next = draftStateFromSession(action.state);
      if (!action.preserveTouched) return next;
      // Enrichment re-fetch: never overwrite something the user just edited.
      const keep = state.touched;
      return {
        targetRoles: keep.includes('targetRoles')
          ? state.targetRoles
          : next.targetRoles,
        workModes: keep.includes('workModes') ? state.workModes : next.workModes,
        cities: keep.includes('locations') ? state.cities : next.cities,
        countries: keep.includes('locations')
          ? state.countries
          : next.countries,
        employmentTypes: keep.includes('employmentTypes')
          ? state.employmentTypes
          : next.employmentTypes,
        industriesTarget: keep.includes('industriesTarget')
          ? state.industriesTarget
          : next.industriesTarget,
        targetCompanies: keep.includes('targetCompanies')
          ? state.targetCompanies
          : next.targetCompanies,
        touched: keep,
      };
    }

    case 'add': {
      const touched = withTouched(state.touched, action.field);
      switch (action.field) {
        case 'targetRoles':
          return {
            ...state,
            targetRoles: addTo(state.targetRoles, action.value, 6),
            touched,
          };
        case 'locations':
          return { ...state, cities: addTo(state.cities, action.value, 6), touched };
        case 'industriesTarget':
          return {
            ...state,
            industriesTarget: addTo(state.industriesTarget, action.value),
            touched,
          };
        case 'targetCompanies':
          return {
            ...state,
            targetCompanies: addTo(state.targetCompanies, action.value),
            touched,
          };
        default:
          // workModes / employmentTypes are closed enums — use the toggles.
          return state;
      }
    }

    case 'remove': {
      const touched = withTouched(state.touched, action.field);
      const drop = (list: string[]) => list.filter((v) => v !== action.value);
      switch (action.field) {
        case 'targetRoles':
          return { ...state, targetRoles: drop(state.targetRoles), touched };
        case 'locations':
          return { ...state, cities: drop(state.cities), touched };
        case 'industriesTarget':
          return {
            ...state,
            industriesTarget: drop(state.industriesTarget),
            touched,
          };
        case 'targetCompanies':
          return {
            ...state,
            targetCompanies: drop(state.targetCompanies),
            touched,
          };
        case 'workModes':
          return {
            ...state,
            workModes: state.workModes.filter((v) => v !== action.value),
            touched,
          };
        case 'employmentTypes':
          return {
            ...state,
            employmentTypes: state.employmentTypes.filter(
              (v) => v !== action.value,
            ),
            touched,
          };
        default:
          return state;
      }
    }

    case 'toggle': {
      const on = state.workModes.includes(action.value);
      return {
        ...state,
        workModes: on
          ? state.workModes.filter((v) => v !== action.value)
          : [...state.workModes, action.value],
        touched: withTouched(state.touched, 'workModes'),
      };
    }

    case 'toggleEmployment': {
      const on = state.employmentTypes.includes(action.value);
      return {
        ...state,
        employmentTypes: on
          ? state.employmentTypes.filter((v) => v !== action.value)
          : [...state.employmentTypes, action.value],
        touched: withTouched(state.touched, 'employmentTypes'),
      };
    }

    default:
      return state;
  }
}

/**
 * The complete post-edit draft posted to `POST /onboarding/confirm`.
 *
 * See the send/omit rule at the top of this file. `remoteOk` is derived rather
 * than asked: a user who tapped Remote is telling us the same thing twice, and
 * `preferencesToFilters` already suppresses the city filter when remote is on.
 */
export function toConfirmDraft(
  state: SetupDraftState,
): OnboardingDraftPreferences {
  const draft: OnboardingDraftPreferences = {
    targetRoles: state.targetRoles,
    workModes: state.workModes,
    locations: {
      cities: state.cities,
      countries: state.countries,
      remoteOk: state.workModes.includes('remote'),
    },
    targetCompanies: state.targetCompanies,
  };
  if (state.touched.includes('employmentTypes')) {
    draft.employmentTypes = state.employmentTypes;
  }
  if (state.touched.includes('industriesTarget')) {
    draft.industriesTarget = state.industriesTarget;
  }
  return draft;
}

// ─────────────────────────────────────────────────────────────────────
// Error codes → i18n keys
// ─────────────────────────────────────────────────────────────────────

/**
 * The structured backend code on a rejected mutation.
 *
 * Read by SHAPE, not by `instanceof RoboApiError`. The raw payload code is
 * preferred over `RoboApiError.code` because `normalizeCode` collapses anything
 * it does not recognise to 'unknown' — and `empty_text`, the one code whose
 * recovery differs from every other, is one of the ones it collapses.
 */
function backendCode(err: unknown): string | undefined {
  const e = err as { payload?: { code?: unknown }; code?: unknown } | null;
  const fromPayload = e?.payload?.code;
  if (typeof fromPayload === 'string') return fromPayload;
  if (typeof e?.code === 'string') return e.code;
  return undefined;
}

/**
 * Map a resume upload / create failure to a `jobs.setup.*` recovery message.
 *
 * `empty_text` is deliberately its own case rather than folding into
 * "could not be read": it means a scanned PDF, whose actual fix is pasting the
 * text, and the caller opens the paste field underneath the message.
 */
export function resumeErrorKey(err: unknown): string {
  switch (backendCode(err)) {
    case 'file_too_large':
      return 'error_file_too_large';
    case 'unsupported_format':
      return 'error_unsupported_format';
    case 'empty_text':
      return 'error_empty_text';
    case 'save_failed':
      return 'error_save_failed';
    default:
      return 'error_parse_failed';
  }
}

/** Map a bootstrap / session failure to a `jobs.setup.*` message. */
export function sessionErrorKey(err: unknown): string {
  // A resume the reader could not use is a document problem, and its recovery
  // is another file — not "try again", which loops on the same document.
  if (backendCode(err) === 'resume_unusable') return 'error_parse_failed';
  return 'error_load_failed';
}

// ─────────────────────────────────────────────────────────────────────
// The hook
// ─────────────────────────────────────────────────────────────────────

export interface UseSetupResult {
  /** The seeded server state, or null before a resume exists. */
  session: OnboardingSetupState | null;
  /** Bootstrap or session restore in flight. */
  loading: boolean;
  /** `jobs.setup.*` key for a bootstrap/session failure, or null. */
  errorKey: string | null;

  draft: SetupDraftState;
  dispatch: (action: SetupDraftAction) => void;

  freeText: string;
  setFreeText: (value: string) => void;

  /** Take a resume variant into a session. Resolves when step 2 can render. */
  bootstrap: (resumeVariantId: string) => Promise<OnboardingSetupState>;
  /** Restore an interrupted session (mid-step reload). Resolves null on 404. */
  restore: () => Promise<OnboardingSetupState | null>;
  confirm: () => Promise<OnboardingConfirmResponse>;
  skip: () => Promise<void>;
  /** Report an AUTOMATIC open. Never call this for a tap-opened panel. */
  markSeen: (step: OnboardingStep) => void;

  confirming: boolean;
  skipping: boolean;
  /** Draft fields the free-text line contributed, for the `notes_added` echo. */
  capturedFromNotes: string[];
}

export function useSetup(): UseSetupResult {
  const qc = useQueryClient();
  const { refresh } = useAuth();

  const [session, setSession] = useState<OnboardingSetupState | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [capturedFromNotes, setCapturedFromNotes] = useState<string[]>([]);
  const [draft, dispatch] = useReducer(setupDraftReducer, undefined, emptyDraftState);

  // One enrichment re-fetch per session, ever. A ref, not state: re-arming it
  // on a re-render is how a "once" turns into a poll.
  const enrichedFor = useRef<string | null>(null);
  // `seen` is reported once per (panel open, step). Same reasoning.
  const seenFor = useRef<string | null>(null);

  const bootstrapMut = useMutation({
    mutationFn: (resumeVariantId: string) =>
      raV2Api.onboarding.bootstrap({ resumeVariantId }),
  });
  const confirmMut = useMutation({
    mutationFn: (body: Parameters<typeof raV2Api.onboarding.confirm>[0]) =>
      raV2Api.onboarding.confirm(body),
  });
  const skipMut = useMutation({
    mutationFn: (sessionId?: string) =>
      raV2Api.onboarding.skip(sessionId ? { sessionId } : {}),
  });

  const bootstrap = useCallback(
    async (resumeVariantId: string) => {
      setErrorKey(null);
      try {
        const next = await bootstrapMut.mutateAsync(resumeVariantId);
        setSession(next);
        dispatch({ type: 'hydrate', state: next });
        return next;
      } catch (err) {
        setErrorKey(sessionErrorKey(err));
        throw err;
      }
    },
    [bootstrapMut],
  );

  const restore = useCallback(async () => {
    setErrorKey(null);
    try {
      const next = await raV2Api.onboarding.getSession();
      setSession(next);
      dispatch({ type: 'hydrate', state: next });
      return next;
    } catch (err) {
      // 404 `no_active_session` is the normal first-run answer, not a failure:
      // there is nothing to restore before a resume exists. Surfacing it would
      // put a red line on a screen where nothing went wrong.
      const code = err instanceof RoboApiError ? err.code : undefined;
      if (code !== 'not_found') setErrorKey(sessionErrorKey(err));
      return null;
    }
  }, []);

  // ── The single enrichment re-fetch ────────────────────────────────
  useEffect(() => {
    if (!session) return;
    if (!(session.enrichmentPending && session.thin)) return;
    if (enrichedFor.current === session.sessionId) return;
    enrichedFor.current = session.sessionId;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await raV2Api.onboarding.getSession();
          setSession(next);
          // preserveTouched: the user has been looking at this screen for a
          // second and a half. Anything they already changed outranks a seed.
          dispatch({ type: 'hydrate', state: next, preserveTouched: true });
        } catch {
          // The screen is already correct without it. Silence is the contract.
        }
      })();
    }, ENRICHMENT_REFETCH_MS);
    return () => clearTimeout(timer);
  }, [session]);

  const confirm = useCallback(async () => {
    if (!session) throw new Error('No setup session');
    const trimmed = freeText.trim();
    const result = await confirmMut.mutateAsync({
      sessionId: session.sessionId,
      draft: toConfirmDraft(draft),
      // Blank costs zero tokens server-side, so omit rather than send ''.
      ...(trimmed ? { freeText: trimmed } : {}),
    });
    setCapturedFromNotes(result.capturedFromNotes ?? []);
    // The whole point of the flow: /jobs refetches with the new preferences.
    // `preferences` first (useTodayMatches derives its filters from it), then
    // the feed, then the resume list (confirm sets the variant primary), then
    // /auth/me so `onboardingState.completed` flips and the panel stops
    // auto-opening.
    qc.invalidateQueries({ queryKey: preferenceKeys.all });
    qc.invalidateQueries({ queryKey: todayKeys.all });
    qc.invalidateQueries({ queryKey: resumeKeys.all });
    void refresh();
    return result;
  }, [confirmMut, draft, freeText, qc, refresh, session]);

  const skip = useCallback(async () => {
    await skipMut.mutateAsync(session?.sessionId);
    // Skip writes no preferences, so the feed does not change — but
    // `skippedAt` did, and that is what suppresses the next auto-open.
    void refresh();
  }, [refresh, session, skipMut]);

  const markSeen = useCallback((step: OnboardingStep) => {
    if (seenFor.current === step) return;
    seenFor.current = step;
    // Fire-and-forget: the counter is a guard rail, not a precondition. A
    // failed increment must never keep the panel from rendering.
    void raV2Api.onboarding
      .seen({ step })
      .then(() => refresh())
      .catch(() => {});
  }, [refresh]);

  return useMemo<UseSetupResult>(
    () => ({
      session,
      loading: bootstrapMut.isPending,
      errorKey,
      draft,
      dispatch,
      freeText,
      setFreeText,
      bootstrap,
      restore,
      confirm,
      skip,
      markSeen,
      confirming: confirmMut.isPending,
      skipping: skipMut.isPending,
      capturedFromNotes,
    }),
    [
      bootstrap,
      bootstrapMut.isPending,
      capturedFromNotes,
      confirm,
      confirmMut.isPending,
      draft,
      errorKey,
      freeText,
      markSeen,
      restore,
      session,
      skip,
      skipMut.isPending,
    ],
  );
}
