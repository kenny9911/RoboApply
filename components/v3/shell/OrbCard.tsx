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

import { useTranslations } from 'next-intl';
import { useAgentStats } from '../../../hooks/useActivity';
import { useDcTheme } from '../../../lib/dcTheme';
import { AiOrb } from '../../dc/AiOrb';

export function OrbCard() {
  const t = useTranslations('nav_v3');
  const theme = useDcTheme();

  // Aggregate for the 3-up stats. Cheap + cacheable; shared with Today /
  // Activity / Preferences via W0-A's useAgentStats hook.
  const { data } = useAgentStats();
  const stats = data?.stats;

  // Live status line: show the agent's real, server-pinned action when there
  // is one; otherwise a truthful idle state. (This used to cycle invented
  // "scanning / tailoring / drafting a cover letter" lines on a timer, which
  // faked live activity even when the agent was completely idle — removed so
  // the orb never claims work it isn't doing.)
  const liveLine = stats?.currentAction ?? t('status_idle');
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
