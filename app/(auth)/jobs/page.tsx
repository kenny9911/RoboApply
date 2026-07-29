'use client';

// /jobs — destination 1 of 4: "what should I apply to?"
//
// Route, nav label, page H1 and i18n namespace all share the name `jobs`
// (ruling D2/D3). This was `/home`, and "Today" before that; a screen named
// for when you look at it cannot answer a question.
//
// Layout (the (auth) shell already provides the .main-inner wrapper, so we
// render only the body):
//
//   SetupPanel                  first-run setup, when the trigger says so
//   PageHeader                  "{n} jobs that fit you." + "Updated {time}."
//   MatchesHeader + MatchFeed   the scored match cards (expand → reasoning)
//
// ─── FIRST-RUN SETUP LIVES HERE, AS A PANEL, NOT AS A WALL ────────────────
//
// `ResumeGate` used to stand in front of this screen and replace the ENTIRE
// authenticated shell for anyone with zero resumes: no sidebar, no settings, no
// sign-out, no way back. That is the same class of trap commit 212a2e6 exists
// to fix, and it captured nothing — a user could upload a resume and still
// arrive at /jobs having told the product nothing about what they want.
//
// It is deleted. Setup is now a panel that occupies the page slot INSIDE the
// shell, on this route only. Every other destination renders normally with no
// resume (their own empty states already say something useful), the Topbar and
// avatar menu stay mounted behind the panel, and the user is one tap from
// anywhere else in the product at every moment of the flow.
//
// WHEN it opens is `useSetupTrigger()`; WHAT it does is `SetupPanel`. The two
// are deliberately separate: the trigger is a pure reading of the already
// shipped `/auth/me` signal, and it is the piece with a matrix worth testing.
//
// Data:
//   • useTodayMatches() → search.run + the resolved resume variant. MatchFeed
//     calls the same hook with the same default limit, so this is one shared
//     cache entry, not a second request. We read it here only for the headline
//     count and the "updated at" stamp.
//
// TRUTH RULE (ruling D9 — the product never displays a number it did not
// measure). This header states exactly two things and both are measured: how
// many rows the feed actually returned, and when that response landed.
// What used to be here, and why it is gone:
//   • The tone-forked overnight headline (direct / playful / formal, selected
//     from the dcTheme tone) — three ways to say the agent worked all night.
//   • TodayStatStrip — a 4-up hero of `scannedOvernight` (the server hardcodes
//     it to 0), `matchedAboveThreshold` (the pending count of a queue that is
//     gated off for launch) and `autoAppliedToday`. A new account read
//     "0 applications shipped overnight. 0 jobs scanned, 0 cleared your
//     threshold." on its first visit.
//
// All copy is `t()` under the `jobs` namespace.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { PageHeader } from '../../../components/v3/primitives';
import { MatchFeed } from '../../../components/v3/today';
import { SetupPanel } from '../../../components/v3/setup';
import { useTodayMatches } from '../../../hooks/useTodayMatches';
import { useSetupTrigger } from '../../../hooks/useSetupTrigger';

export default function JobsPage() {
  const t = useTranslations('jobs');
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

  const count = feed.data?.jobs.length ?? 0;

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

      <PageHeader
        title={feed.isPending ? t('headlineLoading') : t('headline', { count })}
        sub={stamp ? t('sub', { time: stamp }) : undefined}
      />

      {/* The one place the panel can be summoned by tap (ruling C21 — one
       *  name, one place). It lives on the feed header because that is where a
       *  user who wants different jobs already looks. */}
      <MatchFeed onOpenSetup={setup.openSetup} />
    </>
  );
}
