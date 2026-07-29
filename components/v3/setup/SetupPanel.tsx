'use client';

// SetupPanel — first-run setup, two steps, in the PAGE SLOT.
//
// This is not a shell replacement and that distinction is the reason it exists.
// `ResumeGate` wrapped the entire authenticated layout and swapped it for an
// upload prompt, so a first-run user could not reach settings, could not read
// what they were paying for, and — the bug that actually shipped — could not
// sign out to recover from a stale session. This panel renders inside
// `.main-inner`: the Topbar, sidebar, mobile nav and avatar menu stay mounted
// behind it, and step 1 carries its own close control on top of that.
//
// ─── THE TWO STEPS ────────────────────────────────────────────────────────
//
//   resume   Add your resume. Four doors. The only mandatory input, because
//            with no parsed resume the scorer has nothing to compare.
//   reading  Not a spinner: IngestRecap streams what the resume said. This is
//            the evidence that earns the prefill on the next screen.
//   confirm  Check what we read. Every field prefilled, editable, zero
//            mandatory typing, one button.
//
// There is no third step. The only candidate — "show scored jobs" — is the
// destination rendered twice; /jobs runs its own preference-driven search one
// second after this closes.
//
// ─── WHO DECIDES IT OPENS ─────────────────────────────────────────────────
//
// Not this component. The gate reads `onboardingState` from `/auth/me`:
//
//   no 'resume' in completedSteps                  → open at step 1, always
//   'resume' but no 'preferences', autoOpens < 2   → open at step 2
//   completed                                       → closed; filter-bar tap only
//   skippedAt within 7 days                         → closed, except no-resume
//
// The panel's only job in that contract is to report the open: `POST
// /onboarding/seen` increments the counter, and it fires on PANEL OPEN rather
// than on bootstrap. That ordering matters — bootstrap needs a
// `resumeVariantId`, which the no-resume user does not have, so counting there
// would let the panel reopen forever for exactly the people the cap protects.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';

import { ConfirmStep } from './ConfirmStep';
import { ResumeStep } from './ResumeStep';
import { IngestRecap } from './IngestRecap';
import {
  draftFromPreferences,
  formatDraftFieldValue,
  LABELLED_DRAFT_FIELDS,
} from './formatDraftField';
import { useSetup } from '../../../hooks/useSetup';
import type { OnboardingStep } from '../../../lib/api/v2/types';

/** How long the panel stays up to show what the notes line contributed.
 *  Only ever reached by a user who typed something, so the median first-run
 *  path pays nothing for it. */
const NOTES_ECHO_MS = 1400;

type Phase = 'resume' | 'reading' | 'confirm';

export interface SetupPanelProps {
  /** Where to open. `confirm` requires `resumeVariantId`. */
  initialStep: OnboardingStep;
  /** The variant to bootstrap against when opening straight at confirm —
   *  normally the user's primary resume. */
  resumeVariantId?: string | null;
  /** True when the panel opened by itself. Drives `POST /onboarding/seen`,
   *  which must NOT be called for a tap-opened panel. */
  auto?: boolean;
  /** Dismiss without finishing. The caller unmounts the panel. */
  onClose: () => void;
  /** Setup finished (confirmed or skipped). Preferences and the feed have
   *  already been invalidated by the time this fires. */
  onDone?: () => void;
}

export function SetupPanel({
  initialStep,
  resumeVariantId,
  auto = false,
  onClose,
  onDone,
}: SetupPanelProps) {
  const t = useTranslations('jobs.setup');
  const setup = useSetup();

  const [phase, setPhase] = useState<Phase>(
    initialStep === 'confirm' ? 'reading' : 'resume',
  );
  const [restored, setRestored] = useState(false);
  const [submitErrorKey, setSubmitErrorKey] = useState<string | null>(null);
  const [notesEcho, setNotesEcho] = useState<string | null>(null);

  const openedRef = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const { bootstrap, markSeen, restore } = setup;

  // ── Focus, on close ───────────────────────────────────────────────
  //
  // Declared FIRST on purpose: effects run in declaration order, so this reads
  // `activeElement` before the step-focus effect below moves it. Unmounting
  // the panel destroys whatever inside it had focus, and returning it to
  // whatever opened the panel — normally the feed's setup button — is the
  // difference between "the panel closed" and "the page went blank and Tab
  // starts from the browser chrome again".
  useLayoutEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (!(opener instanceof HTMLElement)) return;
      if (opener === document.body || !opener.isConnected) return;
      opener.focus();
    };
  }, []);

  // ── Focus, on open and on every step change ───────────────────────
  //
  // The card swaps IN PLACE: step 1's drop zone is destroyed the moment a
  // resume lands, and step 2 renders in its place. Whatever had focus is gone,
  // so focus falls to <body> and the keyboard user is silently returned to the
  // top of the document — with no announcement that the step changed at all.
  //
  // Each step marks its own <h2 data-setup-heading tabIndex={-1}>. Focusing it
  // does both jobs at once: the caret is at the top of the new step, and the
  // screen reader reads "Here is what your resume says, heading level 2",
  // which IS the step-change announcement. A layout effect so it happens
  // before paint rather than one frame into the new screen.
  useLayoutEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-setup-heading]')?.focus();
  }, [phase]);

  // ── Report the auto-open, once, for BOTH steps ────────────────────
  useEffect(() => {
    if (!auto) return;
    markSeen(initialStep);
  }, [auto, initialStep, markSeen]);

  // ── Opening straight at step 2 ────────────────────────────────────
  //
  // Try the existing session first: a mid-step reload must not throw away the
  // seed (or a supersede an older tab is still holding). Only when there is
  // none do we bootstrap a new one.
  useEffect(() => {
    if (initialStep !== 'confirm') return;
    if (openedRef.current) return;
    openedRef.current = true;
    void (async () => {
      const existing = await restore();
      if (existing) {
        setRestored(true);
        setPhase('confirm');
        return;
      }
      if (!resumeVariantId) {
        // The gate said the user has a resume but did not name one. Falling
        // back to step 1 is honest and self-correcting; an error screen is not.
        setPhase('resume');
        return;
      }
      try {
        await bootstrap(resumeVariantId);
        setPhase('confirm');
      } catch {
        // Step 1, NOT the reading screen. The reading screen has a skeleton, no
        // close control and no retry, so a failed bootstrap parked the user on
        // a permanent "Reading your resume" with the words "Try again" and
        // nothing to try — the one true dead end in the flow. Step 1 has the
        // error with a real recovery, the close control, and "use a resume you
        // already have" listing the variant that just failed. Same reasoning as
        // the missing-variant fallback above: honest and self-correcting.
        setPhase('resume');
      }
    })();
  }, [bootstrap, initialStep, restore, resumeVariantId]);

  // Escape closes, and it is scoped to the panel rather than to `window`.
  //
  // A window listener fired for every Escape on the page: dismissing the avatar
  // menu behind the panel, or backing out of a browser autofill dropdown, also
  // destroyed setup and every edit in it. This panel is deliberately NOT modal
  // — the shell behind it is live — so Escape belongs to it only while it holds
  // focus, which is the standard contract for a non-modal region.
  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key !== 'Escape') return;
    // Escape also cancels an IME composition; that must not close the panel.
    if (e.nativeEvent.isComposing) return;
    e.stopPropagation();
    onClose();
  }

  /** Step 1 produced a parseable variant → read it, then swap the card. */
  const onResumeReady = useCallback(
    async (variantId: string) => {
      setPhase('reading');
      try {
        await bootstrap(variantId);
        setPhase('confirm');
      } catch {
        // Bootstrap failed: back to the doors, with the reason on screen. The
        // resume itself uploaded fine, so "pick existing" now shows it.
        setPhase('resume');
      }
    },
    [bootstrap],
  );

  const onSubmit = useCallback(async () => {
    setSubmitErrorKey(null);
    try {
      const result = await setup.confirm();
      const captured = (result.capturedFromNotes ?? []).filter((f) =>
        LABELLED_DRAFT_FIELDS.has(f),
      );
      if (captured.length === 0) {
        onDone?.();
        return;
      }
      // One receipt for the one place a model read something the user typed —
      // built from what was PERSISTED, not from what was sent, so it can never
      // claim a value the taxonomy tables dropped.
      const stored = draftFromPreferences(result.preferences);
      const echo = captured
        .map((field) => {
          const value = formatDraftFieldValue(stored, field, (v) =>
            t(`values.${v}`),
          );
          return value ? `${t(`fields.${field}`)}: ${value}` : t(`fields.${field}`);
        })
        .join(' · ');
      setNotesEcho(echo);
      setTimeout(() => onDone?.(), NOTES_ECHO_MS);
    } catch {
      setSubmitErrorKey('error_save_failed');
    }
  }, [onDone, setup, t]);

  const onSkip = useCallback(async () => {
    try {
      await setup.skip();
    } catch {
      // `POST /skip` always returns 200, so this is a transport failure — and
      // a transport failure must not keep someone on a screen they asked to
      // leave, nor surface as an unhandled rejection. Swallowed on purpose:
      // skip writes no preferences, so there is nothing to lose by closing.
    }
    onDone?.();
    onClose();
  }, [onClose, onDone, setup]);

  return (
    // NOT `aria-modal`. The shell behind this card is live and reachable —
    // claiming the rest of the page is inert would be a lie to a screen reader
    // and would hide the sign-out the stale-session recovery depends on.
    <section
      ref={panelRef}
      aria-label={t('title')}
      onKeyDown={onPanelKeyDown}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--e2)',
        padding: 'var(--sp-5)',
        maxWidth: 820,
        margin: '0 auto',
      }}
    >
      <p
        style={{
          fontSize: 'var(--fs-label)',
          fontWeight: 500,
          color: 'var(--action)',
          margin: '0 0 var(--sp-3)',
        }}
      >
        {t('title')}
      </p>

      {restored ? (
        <p
          role="status"
          style={{
            fontSize: 'var(--fs-meta)',
            color: 'var(--text-2)',
            margin: '0 0 var(--sp-3)',
          }}
        >
          {t('restore_notice')}
        </p>
      ) : null}

      {phase === 'resume' ? (
        <ResumeStep
          onReady={(id) => void onResumeReady(id)}
          busy={setup.loading}
          errorKey={setup.errorKey}
          onClose={onClose}
        />
      ) : null}

      {phase === 'reading' ? (
        <div>
          <h2
            data-setup-heading
            tabIndex={-1}
            style={{
              outline: 'none',
              fontSize: 'var(--fs-title)',
              fontWeight: 600,
              letterSpacing: 'var(--ls-title)',
              lineHeight: 'var(--lh-title)',
              margin: '0 0 var(--sp-2)',
              color: 'var(--text)',
            }}
          >
            {t('reading_title')}
          </h2>
          <p
            style={{
              fontSize: 'var(--fs-body)',
              color: 'var(--text-2)',
              margin: '0 0 var(--sp-4)',
            }}
          >
            {t('reading_sub')}
          </p>
          {/* `null` rows → the skeleton. The real rows arrive with the
           *  bootstrap response and the card swaps in place. */}
          <IngestRecap rows={null} />
          {setup.errorKey ? (
            <p
              role="alert"
              style={{
                marginTop: 'var(--sp-3)',
                marginBottom: 0,
                color: 'var(--warn)',
                fontSize: 'var(--fs-meta)',
              }}
            >
              {t(setup.errorKey)}
            </p>
          ) : null}
        </div>
      ) : null}

      {phase === 'confirm' && setup.session ? (
        // `errorKey` goes INTO the step, not after it: the action bar is
        // sticky, so a message rendered as its sibling lands in the panel's
        // bottom padding — below the fold and behind the bar — exactly when the
        // user needs to read it.
        <ConfirmStep
          session={setup.session}
          draft={setup.draft}
          dispatch={setup.dispatch}
          freeText={setup.freeText}
          onFreeTextChange={setup.setFreeText}
          onSubmit={() => void onSubmit()}
          onSkip={() => void onSkip()}
          submitting={setup.confirming}
          skipping={setup.skipping}
          notesEcho={notesEcho}
          errorKey={submitErrorKey}
        />
      ) : null}
    </section>
  );
}
