'use client';

// /home — V3 "Today" screen (IA Route 1).
//
// The agent's overnight report + the match feed. Layout (the (auth) shell
// already provides the .main-inner wrapper, so we render only the body):
//
//   PageHeader   eyebrow "Live · {time}" + tone-aware headline + sub
//   TodayStatStrip   4-up hero (Auto-applied / Scanned / Matched ≥80 / In queue)
//   MatchesHeader + MatchFeed   the scored match cards (expand → reasoning)
//
// Data:
//   • useAgentStats()  → activity.orbStats — the hero strip numbers
//   • useTodayMatches() (inside MatchFeed) → search.run + resolved resume
//     variant; per-card jobs.score for the donut, jobs.get on expand.
//
// Tone-aware copy: the dcTheme tone (formal | casual | witty) selects one of
// three headline/sub variants per the prototype's TodayView. All copy is
// `t()` under the `today` namespace.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { PageHeader } from '../../../components/v3/primitives';
import { TodayStatStrip, MatchFeed } from '../../../components/v3/today';
import { useAgentStats } from '../../../hooks/useActivity';
import { useDcTheme, toneFor, type ToneKey } from '../../../lib/dcTheme';
import { QUEUE_REVIEW_ENABLED } from '../../../lib/jobApplying';

/** Map the dcTheme tone enum → the proto's copy register key. */
function toneVariant(tone: ToneKey): 'direct' | 'playful' | 'formal' {
  return toneFor(tone, {
    formal: 'formal',
    casual: 'direct',
    witty: 'playful',
  });
}

export default function HomePage() {
  const t = useTranslations('today');
  const theme = useDcTheme();
  const stats = useAgentStats();

  // Client-only clock for the "Live · {time}" eyebrow (avoids SSR hydration
  // mismatch — render a stable placeholder first, then the real time).
  const [now, setNow] = useState<string>('');
  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    setNow(fmt());
    const id = window.setInterval(() => setNow(fmt()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const variant = toneVariant(theme.tone);
  const autoApplied = stats.data?.stats.autoAppliedToday ?? 0;
  const scanned = stats.data?.stats.scannedOvernight ?? 0;
  const matched = stats.data?.stats.matchedAboveThreshold ?? 0;
  const queued = stats.data?.stats.inQueue ?? 0;

  // Headline: the accent word sits mid-sentence, so we build the node with its
  // own <em> and pass it as PageHeader's `title`.
  const headline =
    variant === 'playful' ? (
      <>
        {t('headline.playful.before')}{' '}
        <em>{t('headline.playful.accent')}</em>{' '}
        {t('headline.playful.after')}
      </>
    ) : variant === 'formal' ? (
      <>
        {t('headline.formal.before')}{' '}
        <em>{t('headline.formal.accent')}</em>
        {t('headline.formal.after')}
      </>
    ) : (
      <>
        {t('headline.direct.before', { count: autoApplied })}{' '}
        <em>{t('headline.direct.accent')}</em>{' '}
        {t('headline.direct.after')}
      </>
    );

  // While /queue is hidden for launch the sub copy must not tease a review
  // queue the user can't visit — the *_noqueue variants drop that clause.
  const sub = t(QUEUE_REVIEW_ENABLED ? `sub.${variant}` : `sub_noqueue.${variant}`, {
    scanned,
    matched,
    autoApplied,
    queued,
  });

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow', { time: now || '—' })}
        eyebrowLive
        title={headline}
        sub={sub}
      />

      <TodayStatStrip stats={stats.data?.stats} loading={stats.isLoading} />

      <MatchFeed />
    </>
  );
}
