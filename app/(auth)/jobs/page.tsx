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
//   PageHeader                  "{n} jobs that fit you." + "Updated {time}."
//   MatchesHeader + MatchFeed   the scored match cards (expand → reasoning)
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
import { useTodayMatches } from '../../../hooks/useTodayMatches';

export default function JobsPage() {
  const t = useTranslations('jobs');
  const { feed } = useTodayMatches();

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

  return (
    <>
      <PageHeader
        title={feed.isLoading ? t('headlineLoading') : t('headline', { count })}
        sub={stamp ? t('sub', { time: stamp }) : undefined}
      />

      <MatchFeed />
    </>
  );
}
