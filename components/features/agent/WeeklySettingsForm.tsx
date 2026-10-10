'use client';

// WeeklySettingsForm — Ready to apply settings (PRODUCT F-AGENT-03). No modes:
// the product only prepares; the user opens and submits each application.
//
//   jobs per week     5 · 10 · 20 · 30 — a target, not a cap; the plan's kit
//                     allowance is the server's `ready_kits` bucket
//   minimum fit       Great fit · Good fit (default) · Possible
//   tailor each       on by default
//   cover letters     only when the post asks (default) · always · never
//   base resume       one of the user's base resumes, or the main one
//   file naming       four presets, previewed with the user's own name

import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Ref } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, FitTierLabel } from '../../v3/primitives';
import { useAgentSettings, useSaveAgentSettings } from '../../../hooks/agent';
import { useProfile } from '../../../hooks/profile/useProfile';
import { useResumeList } from '../../../hooks/useResumes';
import type { AgentSettings } from '../../../lib/api/contracts/agent';
import { COVER_LETTER_MODES, FILE_NAME_STYLES, MIN_TIERS, WEEKLY_TARGETS } from './options';
import { cn } from '../../../lib/utils';
import { KitAllowance } from './KitAllowance';
import type { StepFormHandle } from './AnswersEditor';
import { previewFileName } from './fileName';
import styles from './ready.module.css';

/** Default settings (the schema defaults, R-19) used until the server answers. */
export const DEFAULT_SETTINGS: AgentSettings = {
  weeklyTarget: 10,
  minTier: 'good',
  tailorEach: true,
  coverLetterMode: 'when_required',
  baseVariantId: null,
  fileNameStyle: 'name_company_role',
};

export interface WeeklySettingsFormProps {
  onSaved?: () => void;
  /** Lets the wizard save unsaved settings on Continue / Finish. */
  handleRef?: Ref<StepFormHandle | null>;
}

function pick(s: AgentSettings): AgentSettings {
  const { weeklyTarget, minTier, tailorEach, coverLetterMode, baseVariantId, fileNameStyle } = s;
  return { weeklyTarget, minTier, tailorEach, coverLetterMode, baseVariantId, fileNameStyle };
}

/** True when the form differs from what the server holds. Pure. */
export function settingsDirty(form: AgentSettings, server: AgentSettings | null | undefined): boolean {
  return JSON.stringify(pick(form)) !== JSON.stringify(pick(server ?? DEFAULT_SETTINGS));
}

export function WeeklySettingsForm({ onSaved, handleRef }: WeeklySettingsFormProps) {
  const t = useTranslations('ready');
  const settings = useAgentSettings();
  const save = useSaveAgentSettings();
  const profile = useProfile();
  const resumes = useResumeList();
  const [form, setForm] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    if (!settings.data) return;
    setForm(pick(settings.data));
  }, [settings.data]);

  const bases = useMemo(() => (resumes.data?.resumes ?? []).filter((r) => r.kind === 'base' || r.kind === 'from_template'), [resumes.data]);
  const name = [profile.data?.firstName, profile.data?.lastName].filter(Boolean).join(' ') || t('weekly.exampleName');
  const set = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    setStatus('idle');
    setForm((f) => ({ ...f, [key]: value }));
  };

  const onSave = useCallback(async (): Promise<boolean> => {
    try {
      await save.mutateAsync(form);
      setStatus('saved');
      onSaved?.();
      return true;
    } catch {
      setStatus('failed');
      return false;
    }
  }, [save, form, onSaved]);

  useImperativeHandle(handleRef, () => ({ dirty: () => settingsDirty(form, settings.data), save: onSave }), [form, settings.data, onSave]);

  return (
    <div className={styles.stack} data-testid="weekly-settings">
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('weekly.target')}</legend>
        <div className={styles.choices}>
          {WEEKLY_TARGETS.map((n) => (
            <label key={n} className={cn(styles.choice, form.weeklyTarget === n && styles.choiceOn)}>
              <input type="radio" name="weeklyTarget" checked={form.weeklyTarget === n} onChange={() => set('weeklyTarget', n)} />
              {t('weekly.targetValue', { count: n })}
            </label>
          ))}
        </div>
        <p className={styles.muted}>{t('weekly.targetNote')}</p>
        <KitAllowance />
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('weekly.minTier')}</legend>
        <div className={styles.choices}>
          {MIN_TIERS.map((tier) => (
            <label key={tier} className={cn(styles.choice, form.minTier === tier && styles.choiceOn)}>
              <input type="radio" name="minTier" checked={form.minTier === tier} onChange={() => set('minTier', tier)} />
              <span>{t(`weekly.tierAtLeast.${tier}`)}</span>
              <FitTierLabel tier={tier} />
            </label>
          ))}
        </div>
      </fieldset>

      <label className={styles.toggle}>
        <input type="checkbox" checked={form.tailorEach} onChange={(e) => set('tailorEach', e.target.checked)} />
        <span>
          <span className={styles.strong}>{t('weekly.tailorEach')}</span>
          <br />
          <span className={styles.muted}>{t('weekly.tailorEachNote')}</span>
        </span>
      </label>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('weekly.coverLetter')}</legend>
        <div className={styles.choices}>
          {COVER_LETTER_MODES.map((m) => (
            <label key={m} className={cn(styles.choice, form.coverLetterMode === m && styles.choiceOn)}>
              <input type="radio" name="coverLetterMode" checked={form.coverLetterMode === m} onChange={() => set('coverLetterMode', m)} />
              {t(`weekly.coverLetterModes.${m}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <label className={styles.label}>
        {t('weekly.baseResume')}
        <select className={styles.select} value={form.baseVariantId ?? ''} onChange={(e) => set('baseVariantId', e.target.value || null)}>
          <option value="">{t('weekly.mainResume')}</option>
          {bases.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('weekly.fileName')}</legend>
        <div className={styles.choices}>
          {FILE_NAME_STYLES.map((style) => (
            <label key={style} className={cn(styles.choiceColumn, form.fileNameStyle === style && styles.choiceOn)}>
              <span className={styles.row}>
                <input type="radio" name="fileNameStyle" checked={form.fileNameStyle === style} onChange={() => set('fileNameStyle', style)} />
                {t(`weekly.fileNameStyles.${style}`)}
              </span>
              <span className={styles.muted}>
                {previewFileName(style, { name, company: t('weekly.exampleCompany'), role: t('weekly.exampleRole') })}.pdf
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.row}>
        <Btn variant="primary" onClick={() => void onSave()} disabled={save.isPending || settings.isLoading} aria-busy={save.isPending}>
          {save.isPending ? t('weekly.saving') : t('weekly.save')}
        </Btn>
        {status === 'saved' ? (
          <p className={styles.status} role="status">
            {t('weekly.saved')}
          </p>
        ) : null}
        {status === 'failed' ? (
          <p className={styles.error} role="alert">
            {t('weekly.failed')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
