'use client';

// §03 Agent behavior — mood card, auto-apply mode, thresholds (match / daily
// cap / quiet hours), smart automation toggles, coach loudness. All fields are
// preferences-owned (aggressiveness + dailyCap overlap RoboSettings on the real
// backend, but the V3 stub keeps them on the preferences blob).

import { useTranslations } from 'next-intl';
import {
  PrefHeader,
  PrefGroup,
  PrefRow,
  Toggle,
  Segmented,
  Slider,
  Select,
} from '../controls';
import { useAgentStats } from '../../../../hooks/useActivity';
import type { RAPreferences, RAAggressiveness } from '../../../../lib/api/v2';

// Fixed secondary-tint orb recipes per aggressiveness (literal per design
// system §1.1 — the orb gradient always uses literal tints, not --accent).
const AGGR_ORB: Record<RAAggressiveness, [string, string]> = {
  manual: ['#4ED8FF', '#8B5BFF'],
  balanced: ['#C9FF3B', '#4ED8FF'],
  aggressive: ['#FF6B9D', '#8B5BFF'],
};

export function AgentSection({
  p,
  set,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
}) {
  const t = useTranslations('preferences');

  // Real agent activity for the mood card (shared, cached aggregate — same
  // source the /home OrbCard uses). Replaces the prototype's hardcoded
  // 14 sent / 11h saved / 3 replies numbers, which showed as the user's own.
  const { data: agentStats } = useAgentStats();
  const stats = agentStats?.stats;
  const fmtStat = (n: number | undefined) =>
    n === undefined ? '—' : new Intl.NumberFormat().format(n);

  const aggrMeta: Record<RAAggressiveness, { ic: string; name: string; desc: string }> = {
    manual: { ic: '◌', name: t('agent.mode_manual'), desc: t('agent.mode_manual_desc') },
    balanced: { ic: '◑', name: t('agent.mode_balanced'), desc: t('agent.mode_balanced_desc') },
    aggressive: { ic: '●', name: t('agent.mode_aggressive'), desc: t('agent.mode_aggressive_desc') },
  };
  const aggr = aggrMeta[p.aggressiveness];
  const orb = AGGR_ORB[p.aggressiveness];

  // "Matches at this threshold" estimate (proto heuristic).
  const matchCount = Math.max(2, Math.round((100 - p.matchThreshold) * 1.2));

  const capTone =
    p.dailyCap < 5
      ? t('agent.cap_conservative')
      : p.dailyCap < 12
        ? t('agent.cap_sweet')
        : t('agent.cap_pushing');

  const hourOptions = Array.from({ length: 24 }, (_, i) => ({
    value: String(i),
    label: `${i}:00`,
  }));

  return (
    <>
      <PrefHeader
        eyebrow={t('agent.eyebrow')}
        title={
          <>
            {t('agent.title_before')} <em>{t('agent.title_em')}</em>{' '}
            {t('agent.title_after')}
          </>
        }
        sub={t('agent.sub')}
      />

      {/* Mood card */}
      <div className="pref-mood">
        <div
          className="pref-mood-orb"
          style={{
            background: `radial-gradient(circle at 30% 30%, ${orb[0]}, transparent 60%),
                         radial-gradient(circle at 70% 70%, ${orb[1]}, transparent 60%)`,
            boxShadow: `0 0 80px ${orb[0]}77`,
            animationDuration:
              p.aggressiveness === 'aggressive'
                ? '3s'
                : p.aggressiveness === 'balanced'
                  ? '6s'
                  : '10s',
          }}
        />
        <div className="pref-mood-body">
          <div className="pref-mood-lbl">{t('agent.current_mode')}</div>
          <div className="pref-mood-name">{aggr.name}</div>
          <div className="pref-mood-desc">{aggr.desc}</div>
        </div>
        <div className="pref-mood-stats">
          <div>
            <div className="pref-mood-stat">{fmtStat(stats?.sent)}</div>
            <div className="pref-mood-statlbl">{t('agent.stat_sent')}</div>
          </div>
          <div>
            <div className="pref-mood-stat">
              {stats?.hoursSaved === undefined
                ? '—'
                : `${Math.round(stats.hoursSaved)}h`}
            </div>
            <div className="pref-mood-statlbl">{t('agent.stat_saved')}</div>
          </div>
          <div>
            <div className="pref-mood-stat">{fmtStat(stats?.replies)}</div>
            <div className="pref-mood-statlbl">{t('agent.stat_replies')}</div>
          </div>
        </div>
      </div>

      <PrefGroup label={t('agent.group_mode')}>
        <PrefRow label={t('agent.behaviour_label')} align="top">
          <div className="pref-aggr-grid">
            {(Object.keys(aggrMeta) as RAAggressiveness[]).map((id) => (
              <button
                key={id}
                type="button"
                className={`pref-aggr ${p.aggressiveness === id ? 'on' : ''}`}
                onClick={() => set('aggressiveness', id)}
              >
                <span className="pref-aggr-ic">{aggrMeta[id].ic}</span>
                <div className="pref-aggr-name">{aggrMeta[id].name}</div>
                <div className="pref-aggr-desc">{aggrMeta[id].desc}</div>
              </button>
            ))}
          </div>
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('agent.group_thresholds')}>
        <PrefRow
          label={t('agent.threshold_label')}
          sub={t('agent.threshold_sub', { score: p.matchThreshold, count: matchCount })}
        >
          <Slider
            value={p.matchThreshold}
            min={60}
            max={95}
            step={1}
            onChange={(v) => set('matchThreshold', v)}
            fmt={(v) => `${v}/100`}
            ariaLabel={t('agent.threshold_label')}
          />
        </PrefRow>
        <PrefRow
          label={t('agent.cap_label')}
          sub={t('agent.cap_sub', { count: p.dailyCap, tone: capTone })}
        >
          <Slider
            value={p.dailyCap}
            min={1}
            max={30}
            step={1}
            onChange={(v) => set('dailyCap', v)}
            suffix={t('agent.cap_suffix')}
            ariaLabel={t('agent.cap_label')}
          />
        </PrefRow>
        <PrefRow label={t('agent.quiet_label')} sub={t('agent.quiet_sub')}>
          <div className="pref-quiet">
            <div className="pref-time">
              <Select
                value={String(p.quietStart)}
                onChange={(v) => set('quietStart', Number(v))}
                options={hourOptions}
                ariaLabel={t('agent.quiet_start')}
              />
            </div>
            <span
              style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}
            >
              →
            </span>
            <div className="pref-time">
              <Select
                value={String(p.quietEnd)}
                onChange={(v) => set('quietEnd', Number(v))}
                options={hourOptions}
                ariaLabel={t('agent.quiet_end')}
              />
            </div>
          </div>
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('agent.group_automations')}>
        <PrefRow label={t('agent.auto_decline_label')} sub={t('agent.auto_decline_sub')}>
          <Toggle
            value={p.autoDecline}
            onChange={(v) => set('autoDecline', v)}
            ariaLabel={t('agent.auto_decline_label')}
          />
        </PrefRow>
        <PrefRow label={t('agent.auto_schedule_label')} sub={t('agent.auto_schedule_sub')}>
          <Toggle
            value={p.autoSchedule}
            onChange={(v) => set('autoSchedule', v)}
            ariaLabel={t('agent.auto_schedule_label')}
          />
        </PrefRow>
        <PrefRow
          label={t('agent.pause_interviews_label')}
          sub={t('agent.pause_interviews_sub')}
        >
          <Toggle
            value={p.pauseDuringInterviews}
            onChange={(v) => set('pauseDuringInterviews', v)}
            ariaLabel={t('agent.pause_interviews_label')}
          />
        </PrefRow>
        <PrefRow label={t('agent.rescore_label')} sub={t('agent.rescore_sub')}>
          <Toggle
            value={p.reScoreWeekly}
            onChange={(v) => set('reScoreWeekly', v)}
            ariaLabel={t('agent.rescore_label')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('agent.group_coach')}>
        <PrefRow label={t('agent.coach_label')} sub={t('agent.coach_sub')}>
          <Segmented
            value={p.coachLoudness}
            onChange={(v) => set('coachLoudness', v)}
            options={[
              { value: 'silent', label: `◌ ${t('agent.coach_silent')}` },
              { value: 'nudges', label: `◐ ${t('agent.coach_nudges')}` },
              { value: 'loud', label: `● ${t('agent.coach_loud')}` },
            ]}
          />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
