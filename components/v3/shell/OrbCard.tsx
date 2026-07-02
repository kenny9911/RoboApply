'use client';

// OrbCard — the agent character in the sidebar footer (.orb-card). A rotating
// gradient orb (reusing dc/AiOrb so the accent swap re-tints it), a live state
// line that cycles STATUS_LINES, and a 3-up mini stat row (Sent / Replies /
// Saved).
//
// STATS WIRING: the spec (02-stub-contract.md) puts these numbers in
// `activity.orbStats()` → `AgentStatsResponse.stats` (sent / replies /
// hoursSaved). W0-A owns the data layer; we consume the named hook
// `useAgentStats()` from hooks/useActivity.ts (query key ['v3','activity',
// 'orbStats']) so the cache + invalidations are shared with Today / Activity /
// Preferences. Renders em-dashes until the stub resolves.
//
// `--density` doesn't touch this card; the status line + numbers always show.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAgentStats } from '../../../hooks/useActivity';
import { useDcTheme } from '../../../lib/dcTheme';
import { AiOrb } from '../../dc/AiOrb';

// The live status lines the agent cycles through. Client-side flavor (the
// server may pin a `currentAction`, which we prefer when present).
const STATUS_LINE_KEYS = [
  'status_scan',
  'status_tailor',
  'status_cover',
  'status_crosscheck',
  'status_timer',
  'status_idle',
  'status_index',
  'status_rescore',
] as const;

export function OrbCard() {
  const t = useTranslations('nav_v3');
  const theme = useDcTheme();
  const [idx, setIdx] = useState(0);

  // Aggregate for the 3-up stats. Cheap + cacheable; shared with Today /
  // Activity / Preferences via W0-A's useAgentStats hook.
  const { data } = useAgentStats();
  const stats = data?.stats;

  useEffect(() => {
    const id = setInterval(
      () => setIdx((i) => (i + 1) % STATUS_LINE_KEYS.length),
      3200,
    );
    return () => clearInterval(id);
  }, []);

  // Server-pinned action wins over the cycling client line.
  const liveLine = stats?.currentAction ?? t(STATUS_LINE_KEYS[idx]);
  const fmt = (n: number | undefined) =>
    n === undefined ? '—' : new Intl.NumberFormat().format(n);

  return (
    <div className="orb-card">
      <div className="orb-row">
        <AiOrb size="md" />
        <div className="orb-meta">
          <div className="orb-state">
            <span className="live" aria-hidden="true" />
            {t('agent_state', { mode: t(`aggr_${theme.aggressiveness}`) })}
          </div>
          <div className="orb-now" title={liveLine}>
            {liveLine}
          </div>
        </div>
      </div>
      <div className="orb-stats">
        <div>
          <div className="v robo-tnum">{fmt(stats?.sent)}</div>
          <div className="k">{t('stat_sent')}</div>
        </div>
        <div>
          <div className="v robo-tnum">{fmt(stats?.replies)}</div>
          <div className="k">{t('stat_replies')}</div>
        </div>
        <div>
          <div className="v robo-tnum">
            {stats?.hoursSaved === undefined ? '—' : `${Math.round(stats.hoursSaved)}h`}
          </div>
          <div className="k">{t('stat_saved')}</div>
        </div>
      </div>
    </div>
  );
}
