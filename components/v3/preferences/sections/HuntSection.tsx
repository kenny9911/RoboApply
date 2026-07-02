'use client';

// §02 Job target — the largest section. Live "plain English" translation of the
// hunt settings, intent statement, role titles, seniority, work mode, salary
// band, company stage/size, target/avoid industries, hard rules.
//
// FIELD SPLIT (per the contract): seniority + the salary band overlap `goal`.
// The page owns the goal write-through; this section receives `seniorityIndex`
// (0..5, derived from goal.seniority) + `setSeniorityIndex`. The salary band
// (salaryMinK/MaxK) lives on preferences here and is mirrored to goal on save by
// the page. Everything else (roleTitles, workModes, cities, companyStages,
// companySizes, industries*, mustHaves, dealbreakers, workAuth, intentMarkdown)
// is preferences-owned.

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  PrefHeader,
  PrefGroup,
  PrefRow,
  ChipInput,
  CheckGrid,
  Select,
} from '../controls';
import { IconCheck as Check } from '../../primitives';
import type { RAPreferences, RAPreferenceOptions } from '../../../../lib/api/v2';

export function HuntSection({
  p,
  set,
  options,
  seniorityIndex,
  setSeniorityIndex,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
  options: RAPreferenceOptions;
  seniorityIndex: number;
  setSeniorityIndex: (i: number) => void;
}) {
  const t = useTranslations('preferences');
  const seniorityLabels = options.seniorityLabels;

  // Live "in plain English" translation — recomputed from the working draft.
  const intentLines = useMemo(() => {
    const remoteParts: string[] = [];
    if (p.workModes.remote) remoteParts.push(t('hunt.mode_remote_word'));
    if (p.workModes.hybrid) remoteParts.push(t('hunt.mode_hybrid_word'));
    if (p.workModes.onsite) remoteParts.push(t('hunt.mode_onsite_word'));
    const stages = options.companyStages
      .filter((s) => p.companyStages[s.id])
      .map((s) => s.label);
    return {
      l1: t('hunt.plain_l1', {
        roles: p.roleTitles.join(', ') || '—',
        stages: stages.join(', ') || t('hunt.any_stage'),
      }),
      l2: t('hunt.plain_l2', {
        modes: remoteParts.join(' / ') || '—',
        cities: p.cities.join(', ') || '—',
      }),
      l3: t('hunt.plain_l3', {
        min: p.salaryMinK,
        max: p.salaryMaxK,
        count: p.industriesTarget.length,
      }),
      l4: t('hunt.plain_l4', { items: p.mustHaves.join(' · ') || t('hunt.none') }),
      l5: t('hunt.plain_l5', {
        items: p.dealbreakers.join(' · ') || t('hunt.none'),
      }),
    };
  }, [p, options.companyStages, t]);

  const toggleStage = (id: string) =>
    set('companyStages', { ...p.companyStages, [id]: !p.companyStages[id] });
  const toggleSize = (s: string) =>
    set(
      'companySizes',
      p.companySizes.includes(s)
        ? p.companySizes.filter((x) => x !== s)
        : [...p.companySizes, s],
    );
  const toggleInd = (i: string) =>
    set(
      'industriesTarget',
      p.industriesTarget.includes(i)
        ? p.industriesTarget.filter((x) => x !== i)
        : [...p.industriesTarget, i],
    );

  const modes: Array<{ id: 'remote' | 'hybrid' | 'onsite'; label: string; desc: string }> = [
    { id: 'remote', label: t('hunt.mode_remote'), desc: t('hunt.mode_remote_desc') },
    { id: 'hybrid', label: t('hunt.mode_hybrid'), desc: t('hunt.mode_hybrid_desc') },
    { id: 'onsite', label: t('hunt.mode_onsite'), desc: t('hunt.mode_onsite_desc') },
  ];

  const seniorityLabel = seniorityLabels[seniorityIndex] ?? '—';

  return (
    <>
      <PrefHeader
        eyebrow={t('hunt.eyebrow')}
        title={
          <>
            {t('hunt.title_before')} <em>{t('hunt.title_em')}</em>{' '}
            {t('hunt.title_after')}
          </>
        }
        sub={t('hunt.sub')}
      />

      {/* Live translation */}
      <div className="pref-intent">
        <div className="pref-intent-lbl">
          <span className="rb-ai-spark">✦</span>
          {t('hunt.plain_label')}
        </div>
        <div className="pref-intent-body">
          <div className="pref-intent-line">{intentLines.l1}</div>
          <div className="pref-intent-line">{intentLines.l2}</div>
          <div className="pref-intent-line">{intentLines.l3}</div>
          <div className="pref-intent-line good">{intentLines.l4}</div>
          <div className="pref-intent-line warn">{intentLines.l5}</div>
        </div>
      </div>

      <PrefGroup label={t('hunt.group_intent')}>
        <PrefRow
          label={t('hunt.intent_label')}
          sub={t('hunt.intent_sub')}
          align="top"
        >
          <textarea
            className="pref-textarea"
            value={p.intentMarkdown}
            onChange={(e) => set('intentMarkdown', e.target.value)}
            rows={3}
            aria-label={t('hunt.intent_label')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('hunt.group_role')}>
        <PrefRow label={t('hunt.titles_label')} sub={t('hunt.titles_sub')}>
          <ChipInput
            values={p.roleTitles}
            onAdd={(v) => set('roleTitles', [...p.roleTitles, v])}
            onRemove={(v) =>
              set('roleTitles', p.roleTitles.filter((x) => x !== v))
            }
            placeholder={t('hunt.titles_ph')}
          />
        </PrefRow>
        <PrefRow
          label={t('hunt.seniority_label')}
          sub={t('hunt.seniority_sub', { level: seniorityLabel })}
        >
          <div className="pref-seniority">
            {seniorityLabels.map((l, i) => (
              <button
                key={l}
                type="button"
                className={`pref-sen ${
                  i === seniorityIndex ? 'on' : i < seniorityIndex ? 'low' : ''
                }`}
                onClick={() => setSeniorityIndex(i)}
              >
                <span className="pref-sen-pip" />
                {l}
              </button>
            ))}
          </div>
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('hunt.group_location')}>
        <PrefRow label={t('hunt.work_mode_label')}>
          <div className="pref-mode-grid">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`pref-mode ${p.workModes[m.id] ? 'on' : ''}`}
                onClick={() =>
                  set('workModes', { ...p.workModes, [m.id]: !p.workModes[m.id] })
                }
              >
                <div className="pref-mode-check">
                  {p.workModes[m.id] ? <Check size={11} strokeWidthValue={3.5} /> : null}
                </div>
                <div className="pref-mode-label">{m.label}</div>
                <div className="pref-mode-desc">{m.desc}</div>
              </button>
            ))}
          </div>
        </PrefRow>
        <PrefRow label={t('hunt.cities_label')} sub={t('hunt.cities_sub')}>
          <ChipInput
            values={p.cities}
            onAdd={(v) => set('cities', [...p.cities, v])}
            onRemove={(v) => set('cities', p.cities.filter((x) => x !== v))}
            placeholder={t('hunt.cities_ph')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('hunt.group_comp')}>
        <PrefRow
          label={t('hunt.salary_label')}
          sub={t('hunt.salary_sub', { min: p.salaryMinK, max: p.salaryMaxK })}
        >
          <div className="pref-salary">
            <div className="pref-salary-track">
              <div
                className="pref-salary-fill"
                style={{
                  left: `${((p.salaryMinK - 60) / 290) * 100}%`,
                  right: `${100 - ((p.salaryMaxK - 60) / 290) * 100}%`,
                }}
              />
              <input
                type="range"
                min={60}
                max={350}
                step={5}
                value={p.salaryMinK}
                aria-label={t('hunt.salary_min')}
                onChange={(e) =>
                  set('salaryMinK', Math.min(Number(e.target.value), p.salaryMaxK - 5))
                }
              />
              <input
                type="range"
                min={60}
                max={350}
                step={5}
                value={p.salaryMaxK}
                aria-label={t('hunt.salary_max')}
                onChange={(e) =>
                  set('salaryMaxK', Math.max(Number(e.target.value), p.salaryMinK + 5))
                }
              />
            </div>
            <div className="pref-salary-vals">
              <span>${p.salaryMinK}k</span>
              <span style={{ color: 'var(--muted)' }}>—</span>
              <span>${p.salaryMaxK}k</span>
            </div>
            <div className="pref-salary-bands">
              <span>$60k</span>
              <span>{t('hunt.salary_median', { level: seniorityLabel })}</span>
              <span>$350k</span>
            </div>
          </div>
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('hunt.group_company')}>
        <PrefRow label={t('hunt.stage_label')} sub={t('hunt.stage_sub')} align="top">
          <CheckGrid
            items={options.companyStages}
            values={p.companyStages}
            onToggle={toggleStage}
            cols={3}
          />
        </PrefRow>
        <PrefRow label={t('hunt.headcount_label')} align="top">
          <CheckGrid
            items={options.companySizes}
            values={p.companySizes}
            onToggle={toggleSize}
            cols={6}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('hunt.group_industry')}>
        <PrefRow
          label={t('hunt.industries_target_label')}
          sub={t('hunt.industries_target_sub')}
          align="top"
        >
          <CheckGrid
            items={options.industries}
            values={p.industriesTarget}
            onToggle={toggleInd}
            cols={4}
          />
        </PrefRow>
        <PrefRow
          label={t('hunt.industries_avoid_label')}
          sub={t('hunt.industries_avoid_sub')}
          align="top"
        >
          <ChipInput
            values={p.industriesAvoid}
            onAdd={(v) => set('industriesAvoid', [...p.industriesAvoid, v])}
            onRemove={(v) =>
              set('industriesAvoid', p.industriesAvoid.filter((x) => x !== v))
            }
            placeholder={t('hunt.industries_avoid_ph')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('hunt.group_hard_rules')}>
        <PrefRow
          label={t('hunt.musthaves_label')}
          sub={t('hunt.musthaves_sub')}
          align="top"
        >
          <ChipInput
            values={p.mustHaves}
            onAdd={(v) => set('mustHaves', [...p.mustHaves, v])}
            onRemove={(v) => set('mustHaves', p.mustHaves.filter((x) => x !== v))}
            placeholder={t('hunt.musthaves_ph')}
          />
        </PrefRow>
        <PrefRow
          label={t('hunt.dealbreakers_label')}
          sub={t('hunt.dealbreakers_sub')}
          align="top"
        >
          <ChipInput
            values={p.dealbreakers}
            onAdd={(v) => set('dealbreakers', [...p.dealbreakers, v])}
            onRemove={(v) =>
              set('dealbreakers', p.dealbreakers.filter((x) => x !== v))
            }
            placeholder={t('hunt.dealbreakers_ph')}
          />
        </PrefRow>
        <PrefRow label={t('hunt.work_auth_label')}>
          <Select
            value={p.workAuth}
            onChange={(v) => set('workAuth', v)}
            ariaLabel={t('hunt.work_auth_label')}
            options={[
              { value: 'US Citizen — no sponsorship needed', label: t('hunt.auth_citizen') },
              { value: 'US Permanent Resident', label: t('hunt.auth_pr') },
              { value: 'Need H1-B sponsorship', label: t('hunt.auth_h1b') },
              { value: 'Need OPT extension', label: t('hunt.auth_opt') },
              { value: 'EU / UK citizen', label: t('hunt.auth_eu') },
              { value: 'Other', label: t('hunt.auth_other') },
            ]}
          />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
