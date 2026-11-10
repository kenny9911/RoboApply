'use client';

// Screen 1 of the start flow — "Start with your resume".
//
// The resume intake is the long flow's own screen (../steps/ResumeStep.tsx),
// used whole: the four doors (upload, the LinkedIn PDF, paste, a resume
// already in the account), the question asked before a PDF is read elsewhere,
// its fail-closed rules and its messages. It also asks the server what the
// resume suggests (POST /onboarding/resume) before it reports a choice, so
// this screen never asks twice. Nothing of it is copied here.
//
// What differs is where its two buttons lead, and three of its words:
//   - "Continue" hands the chosen resume to the second screen (nothing is
//     saved as a step yet: the steps are saved together by "Find my jobs");
//   - "I don't have a resume yet" opens the second screen empty.
// ResumeStep takes its words from the `onboarding.resume` messages and has no
// props for them, so the three are swapped in the messages it reads, for this
// subtree only (`ResumeStepWords`).
//
// Below it, at low emphasis: the way to the longer screens.

import { useCallback, useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { NextIntlClientProvider, useLocale, useMessages, useTranslations } from 'next-intl';

import type { OnboardingState } from '../../../../hooks/onboarding/useOnboarding';
import { CLASSIC_FLOW_ROUTE } from '../flow';
import { ResumeStep } from '../steps/ResumeStep';
import x from './express.module.css';

type Tree = Record<string, unknown>;
const tree = (v: unknown): Tree => (v && typeof v === 'object' ? (v as Tree) : {});

/** The messages ResumeStep reads, with this screen's heading and button words. */
function ResumeStepWords({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const messages = useMessages();
  const t = useTranslations('onboarding.express.resume');
  const patched = useMemo(() => {
    const onboarding = tree(messages.onboarding);
    return {
      ...messages,
      onboarding: {
        ...onboarding,
        // `raw`: the text as written, so it is read as a message again, not as a formatted string.
        resume: { ...tree(onboarding.resume), title: t.raw('title'), submit: t.raw('continue'), skip: t.raw('noResume') },
        frame: { ...tree(onboarding.frame), saving: t.raw('working') },
      },
    };
  }, [messages, t]);
  return (
    <NextIntlClientProvider locale={locale} messages={patched}>
      {children}
    </NextIntlClientProvider>
  );
}

export interface ExpressResumeScreenProps {
  state: OnboardingState;
  /** The resume chosen earlier on this visit (shown as ready when the user comes back). */
  chosenId: string | null;
  /** A resume is in and the server has said what it suggests. */
  onResume: (resumeVariantId: string) => void;
  onNoResume: () => void;
  onLeave: () => void;
  busy: boolean;
  /** A "Finish later" failure, already in plain words. */
  error: string | null;
}

export function ExpressResumeScreen({ state, chosenId, onResume, onNoResume, onLeave, busy, error }: ExpressResumeScreenProps) {
  const t = useTranslations('onboarding.express.resume');
  // ResumeStep shows the stored `resume` answer as ready; here that is the resume chosen on this visit.
  const stepState = useMemo<OnboardingState>(
    () => (chosenId ? { ...state, answers: { ...state.answers, resume: { resumeVariantId: chosenId } } } : state),
    [state, chosenId],
  );
  const save = useCallback(
    (body: Record<string, unknown>) => {
      if (typeof body.resumeVariantId === 'string') onResume(body.resumeVariantId);
      else onNoResume();
    },
    [onResume, onNoResume],
  );

  return (
    <>
      <ResumeStepWords>
        <ResumeStep state={stepState} save={save} onLeave={onLeave} busy={busy} error={error} position={{ current: 1, total: 2 }} />
      </ResumeStepWords>
      <p className={x.alt}>
        <Link className={x.altLink} href={CLASSIC_FLOW_ROUTE}>
          {t('classic')}
        </Link>
      </p>
    </>
  );
}
