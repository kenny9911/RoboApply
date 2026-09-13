'use client';

// Candidate discovery inside the authenticated shell. The page keeps its
// navigation and feed available during first-run setup. Counts belong to the
// loaded collection; the introduction makes no claim about unscored jobs.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { PageHeader } from '../../../components/v3/primitives';
import { MatchFeed } from '../../../components/v3/today';
import { SetupPanel } from '../../../components/v3/setup';
import { useTodayMatches } from '../../../hooks/useTodayMatches';
import { useSetupTrigger } from '../../../hooks/useSetupTrigger';

export default function JobsPage() {
  const t = useTranslations('jobs');
  const searchT = useTranslations('jobSearch');
  const { feed, resumeVariantId, isResolvingResume } = useTodayMatches();
  const setup = useSetupTrigger();

  // Hold a Step-2 opening until the resume variant is known.
  //
  // SetupPanel resolves its session ONCE, in a mount effect. Handed a null
  // `resumeVariantId` it falls back to Step 1 — honest behaviour on its part,
  // and exactly the wrong screen here: the gate only says `confirm` when
  // /auth/me confirmed a live resume variant exists, and "Step 1 never renders
  // for a user who has a resume" is the entire reason this is a ONE-screen
  // onboarding for most of the existing user base. The variant arrives from a
  // separate query a few hundred milliseconds later, so mounting on the first
  // render would lose that race almost every time.
  const setupReady = setup.step === 'resume' || !isResolvingResume;

  // The stamp is the query's own `dataUpdatedAt` — the moment this response
  // landed — not the wall clock, so "Updated 9:14 AM" is a fact about the list
  // underneath it. Formatted client-side only: `toLocaleTimeString` resolves
  // against the browser's locale + timezone, so rendering it on the server
  // would hydrate a mismatch. Empty until the effect runs, and the sub is
  // withheld rather than guessed.
  const updatedAt = feed.dataUpdatedAt;
  const [stamp, setStamp] = useState('');
  useEffect(() => {
    if (!updatedAt) {
      setStamp('');
      return;
    }
    setStamp(
      new Date(updatedAt).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  }, [updatedAt]);

  // `isPending`, not `isLoading`. The feed query is held until stored
  // preferences resolve (so it fires once, with filters, rather than firing
  // unfiltered and then replacing the list), and a DISABLED TanStack query
  // reports isLoading === false while it has no data — which rendered
  // "No jobs fit you yet." at a user whose feed had not been requested yet.
  // isPending covers both "waiting to start" and "in flight".
  //
  // The panel renders FIRST in document order so a screen reader meets the
  // dialog before the list behind it, and the feed keeps rendering underneath:
  // the setup panel is a layer over a working screen, never a replacement for
  // one. A brand-new user's feed is the whole index in retrieval order — that
  // is a real list of real jobs, and it is what they return to the moment they
  // close, skip or finish.
  return (
    <>
      {/* `initialStep`, not `step`: the trigger says where the panel STARTS.
       *  A no-resume user who uploads inside Step 1 advances to Step 2 without
       *  the trigger hearing about it, because /auth/me has not been re-read
       *  yet — progression is the panel's to own, not something to round-trip
       *  through the session.
       *
       *  `auto` is the whole of the auto-open accounting. The panel reports the
       *  open (POST /onboarding/seen) and this flag is what tells it whether
       *  the open was one the user asked for. A tap must never spend one of
       *  the two free showings, so `auto` is false for every tap and true only
       *  for the one automatic decision useSetupTrigger makes per mount.
       *
       *  `resumeVariantId` is the same variant the feed scores against — the
       *  base "Master Resume" — so opening straight at Step 2 confirms a
       *  reading of the resume the user is actually being matched on. */}
      {setup.open && setupReady ? (
        <SetupPanel
          initialStep={setup.step}
          auto={setup.auto}
          resumeVariantId={resumeVariantId}
          onClose={setup.closeSetup}
          onDone={setup.closeSetup}
        />
      ) : null}

      <div className="discovery-page-hero">
        <span className="discovery-eyebrow">{t('discovery.eyebrow')}</span>
        <PageHeader
          title={t('discovery.title')}
          sub={t('discovery.intro')}
        />
        <Link className="v3-btn v3-btn-secondary" href="/job-search">{searchT('title')}</Link>
      </div>

      {/* The one place the panel can be summoned by tap (ruling C21 — one
       *  name, one place). It lives on the feed header because that is where a
       *  user who wants different jobs already looks. */}
      <MatchFeed onOpenSetup={setup.openSetup} updatedLabel={stamp ? t('sub', { time: stamp }) : undefined} />
    </>
  );
}
