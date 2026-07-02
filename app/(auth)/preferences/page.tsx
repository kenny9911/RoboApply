'use client';

// /preferences — the V3 8-section settings screen (Route 10).
//
// Proto: RoboApply_V3/preferences.jsx (whole) + preferences.css → .pref-*.
//
// Composition (per docs/roboapply/v3/01-ia-and-routes.md §Route 10):
//   - preferences.get / update  → the extended prefs blob (most fields)
//   - goal.get / upsert         → seniority + salary band overlap (split write)
//   - resumes.list              → default-resume picker
//   - integrations.* (inside IntegSection) → connect/disconnect tiles
//   - auth profile              → identity name/email (read-only here)
//
// Dirty/Save model: we hold a working draft (RAPreferences) + a separate
// seniority index (goal-derived). `dirty` is a structural compare of
// { draft, seniorityIndex } against the server baseline — so Save clears it and
// Discard restores it. On Save we fire preferences.update with the full draft
// and goal.upsert with the seniority + salary band; the SaveBar disappears.
//
// FIELD SPLIT NOTE (contract): `seniority` + the salary band live on `goal`.
// The salary band (salaryMinK/MaxK) is ALSO kept on the prefs draft for the UI
// and mirrored to goal on save (goal stores absolute dollars; prefs stores k).

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePreferences, useUpdatePreferences } from '../../../hooks/usePreferences';
import { useGoal, useGoalMutation } from '../../../hooks/useGoal';
import { useResumeList } from '../../../hooks/useResumes';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { useJobApplyingEnabled } from '../../../lib/jobApplying';
import {
  SaveBar,
  IdentitySection,
  HuntSection,
  AgentSection,
  NotifSection,
  IntegSection,
  PrivacySection,
  PlanSection,
  DangerSection,
} from '../../../components/v3/preferences';
import type {
  RAPreferences,
  RAPreferenceOptions,
  RASeniority,
  PreferencesUpdateBody,
} from '../../../lib/api/v2';

type SectionId =
  | 'identity'
  | 'hunt'
  | 'agent'
  | 'notif'
  | 'integ'
  | 'privacy'
  | 'plan'
  | 'danger';

const SECTION_ORDER: { id: SectionId; ic: string; danger?: boolean }[] = [
  { id: 'identity', ic: '◉' },
  { id: 'hunt', ic: '◎' },
  { id: 'agent', ic: '◐' },
  { id: 'notif', ic: '◑' },
  { id: 'integ', ic: '◇' },
  { id: 'privacy', ic: '◈' },
  { id: 'plan', ic: '◆' },
  { id: 'danger', ic: '⊗', danger: true },
];

// Map a numeric seniority index (proto's Intern..Principal, 0..5) ↔ the
// RASeniority enum used by `goal`. The two vocabularies don't line up 1:1
// (RASeniority has no "intern/junior/mid" and adds manager/director/vp/cxo) —
// this is a best-effort bridge; see the contract-gap note in the report.
const INDEX_TO_SENIORITY: RASeniority[] = [
  'ic', // 0 Intern   → ic
  'ic', // 1 Junior   → ic
  'ic', // 2 Mid      → ic
  'senior', // 3 Senior   → senior
  'staff', // 4 Staff    → staff
  'principal', // 5 Principal→ principal
];

function seniorityToIndex(s: RASeniority | null): number {
  if (!s) return 3; // default Senior (matches the proto fixture)
  const i = INDEX_TO_SENIORITY.indexOf(s);
  return i >= 0 ? i : 3;
}

export default function PreferencesPage() {
  const t = useTranslations('preferences');
  const prefsQuery = usePreferences();
  const goalQuery = useGoal();
  const resumesQuery = useResumeList();
  const { user, profile } = useAuth();

  const updatePrefs = useUpdatePreferences();
  const upsertGoal = useGoalMutation();

  // The 'agent' section is the auto-apply tuning (aggressiveness / daily cap /
  // threshold) — hidden when job-applying is off (only shown once we know it's
  // on). `section` defaults to 'hunt' and can't reach 'agent' once the nav
  // entry is gone, so the content switch needs no extra guard.
  const showJobApply = useJobApplyingEnabled() === true;
  const sections = showJobApply
    ? SECTION_ORDER
    : SECTION_ORDER.filter((s) => s.id !== 'agent');

  const [section, setSection] = useState<SectionId>('hunt');

  // Working draft + its server baseline (for dirty compare + discard).
  const [draft, setDraft] = useState<RAPreferences | null>(null);
  const [baseline, setBaseline] = useState<RAPreferences | null>(null);
  const [seniorityIndex, setSeniorityIndex] = useState(3);
  const [baselineSeniority, setBaselineSeniority] = useState(3);

  const serverPrefs = prefsQuery.data?.preferences ?? null;
  const options: RAPreferenceOptions | null = prefsQuery.data?.options ?? null;
  const goalSeniority = goalQuery.data?.goal?.seniority ?? null;

  // Hydrate the draft once the server prefs arrive (and re-sync after a save,
  // when serverPrefs.updatedAt changes).
  useEffect(() => {
    if (!serverPrefs) return;
    setDraft(structuredClone(serverPrefs));
    setBaseline(structuredClone(serverPrefs));
  }, [serverPrefs]);

  // Seniority comes from goal; seed it once goal resolves.
  useEffect(() => {
    const idx = seniorityToIndex(goalSeniority);
    setSeniorityIndex(idx);
    setBaselineSeniority(idx);
  }, [goalSeniority]);

  // Deep path-set on the draft — mirrors the proto's set(path, value).
  const set = (path: string, value: unknown) => {
    setDraft((cur) => {
      if (!cur) return cur;
      const next = structuredClone(cur) as unknown as Record<string, unknown>;
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        obj[keys[i]] = { ...(obj[keys[i]] as Record<string, unknown>) };
        obj = obj[keys[i]] as Record<string, unknown>;
      }
      obj[keys[keys.length - 1]] = value;
      return next as unknown as RAPreferences;
    });
  };

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return (
      JSON.stringify(draft) !== JSON.stringify(baseline) ||
      seniorityIndex !== baselineSeniority
    );
  }, [draft, baseline, seniorityIndex, baselineSeniority]);

  const saving = updatePrefs.isPending || upsertGoal.isPending;

  const discard = () => {
    if (baseline) setDraft(structuredClone(baseline));
    setSeniorityIndex(baselineSeniority);
  };

  const save = async () => {
    if (!draft || !baseline) return;
    // Send the whole draft (the stub deep-merges; only changed fields matter).
    const body = draft as unknown as PreferencesUpdateBody;
    await updatePrefs.mutateAsync(body);

    // Split write: seniority + salary band → goal. goal.upsert requires a
    // targetTitle; reuse the existing goal's, falling back to the first role
    // title (or a placeholder) so a first save doesn't throw.
    const currentGoal = goalQuery.data?.goal ?? null;
    const targetTitle =
      currentGoal?.targetTitle || draft.roleTitles[0] || 'Untitled role';
    try {
      await upsertGoal.mutateAsync({
        targetTitle,
        seniority: INDEX_TO_SENIORITY[seniorityIndex] ?? 'senior',
        targetSalaryMin: draft.salaryMinK * 1000,
        targetSalaryMax: draft.salaryMaxK * 1000,
      });
    } catch {
      // Goal write is best-effort in the stub; prefs already persisted.
    }

    // Re-baseline so the SaveBar clears.
    setBaseline(structuredClone(draft));
    setBaselineSeniority(seniorityIndex);
  };

  const huntActive = draft?.huntActive ?? false;
  const toggleHunt = () => set('huntActive', !huntActive);

  // Loading / empty guards.
  if (prefsQuery.isLoading || !draft || !options) {
    return (
      <div className="pref">
        <div className="pref-body">
          <p className="pref-sub">{t('loading')}</p>
        </div>
      </div>
    );
  }

  const name = (profile?.name as string) || user?.name || user?.email || '';
  const email = (profile?.email as string) || user?.email || '';

  return (
    <div className="pref">
      {/* Left rail */}
      <aside className="pref-rail">
        <div className="pref-rail-head">
          <div className="pref-rail-eye">{t('rail.eyebrow')}</div>
          <div className="pref-rail-title">{t('rail.title')}</div>
        </div>
        <nav className="pref-nav">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`pref-nav-item ${section === s.id ? 'active' : ''} ${
                s.danger ? 'danger' : ''
              }`}
              onClick={() => setSection(s.id)}
            >
              <span className="pref-nav-ic">{s.ic}</span>
              {t(`nav.${s.id}`)}
            </button>
          ))}
        </nav>

        {/* The "hunt active/paused" status + pause button drive the auto-apply
         *  engine — hidden with the rest of the job-applying surface. */}
        {showJobApply && (
          <div className="pref-rail-foot">
            <div className="pref-status">
              <span className={`pref-status-dot ${huntActive ? 'on' : 'off'}`} />
              <span>
                <strong>{huntActive ? t('rail.hunt_active') : t('rail.hunt_paused')}</strong>
                <small>
                  {huntActive ? t('rail.hunt_active_sub') : t('rail.hunt_paused_sub')}
                </small>
              </span>
            </div>
            <button type="button" className="pref-pause-btn" onClick={toggleHunt}>
              {huntActive ? `⏸ ${t('rail.pause')}` : `▶ ${t('rail.resume')}`}
            </button>
          </div>
        )}
      </aside>

      {/* Content */}
      <div className="pref-body">
        {section === 'identity' && (
          <IdentitySection
            p={draft}
            set={set}
            name={name}
            email={email}
            resumes={resumesQuery.data?.resumes ?? []}
          />
        )}
        {section === 'hunt' && (
          <HuntSection
            p={draft}
            set={set}
            options={options}
            seniorityIndex={seniorityIndex}
            setSeniorityIndex={setSeniorityIndex}
          />
        )}
        {section === 'agent' && <AgentSection p={draft} set={set} />}
        {section === 'notif' && <NotifSection p={draft} set={set} />}
        {section === 'integ' && <IntegSection />}
        {section === 'privacy' && <PrivacySection p={draft} set={set} />}
        {section === 'plan' && <PlanSection p={draft} set={set} />}
        {section === 'danger' && (
          <DangerSection
            huntActive={huntActive}
            onPauseToggle={toggleHunt}
            onReset={discard}
          />
        )}
      </div>

      {/* Save bar — appears on dirty, clears on save/discard. */}
      {dirty && <SaveBar saving={saving} onDiscard={discard} onSave={save} />}
    </div>
  );
}
