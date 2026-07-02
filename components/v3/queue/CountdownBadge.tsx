'use client';

// CountdownBadge — the live "Auto-applies in 18m" pill on a queue card. Renders
// a blinking accent blip + a mono countdown derived from the item's ISO
// `plannedSubmitAt`. Ticks once a minute (the granularity we display) and
// rolls down to "<1m", then "now" once the timer has elapsed.
//
// Copy is fully `t()`-driven (queue.countdown.* keys) so the unit phrasing
// ("18m", "2h 4m", "<1m", "now") localizes. The `.countdown` class + `.blip`
// come from styles/v3.css.

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

interface Props {
  /** ISO timestamp — when the agent will auto-submit if untouched. */
  plannedSubmitAt: string;
}

/** Whole-minute diff (now → target). Negative once the target has passed. */
function minutesUntil(targetMs: number, nowMs: number): number {
  return Math.round((targetMs - nowMs) / 60_000);
}

export function CountdownBadge({ plannedSubmitAt }: Props) {
  const t = useTranslations('queue');
  const targetMs = useMemo(() => {
    const ms = Date.parse(plannedSubmitAt);
    return Number.isNaN(ms) ? null : ms;
  }, [plannedSubmitAt]);

  // Re-render every 30s so the minute label stays fresh without being chatty.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const label = useMemo(() => {
    if (targetMs === null) return t('countdown.scheduled');
    const mins = minutesUntil(targetMs, nowMs);
    if (mins <= 0) return t('countdown.now');
    if (mins < 1) return t('countdown.lessThanMinute');
    if (mins < 60) return t('countdown.minutes', { minutes: mins });
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0
      ? t('countdown.hours', { hours })
      : t('countdown.hoursMinutes', { hours, minutes: rem });
  }, [targetMs, nowMs, t]);

  return (
    <div className="countdown" title={t('countdown.title')}>
      <span className="blip" aria-hidden="true" />
      {label}
    </div>
  );
}
