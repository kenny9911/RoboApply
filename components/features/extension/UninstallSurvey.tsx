'use client';

// UninstallSurvey — /extension/uninstalled, the page the extension opens when
// it is removed (`chrome.runtime.setUninstallURL`, WP-55b). Optional and
// anonymous: the answer is stored without a user id (RASurveyResponse kind
// 'ext_uninstall'), 5 per day per IP.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useUninstallSurvey } from '../../../hooks/extension';
import type { UNINSTALL_REASONS } from '../../../lib/api/contracts/extension';
import s from './extension.module.css';

type Reason = (typeof UNINSTALL_REASONS)[number];
/** Same order as the contract's UNINSTALL_REASONS (contract mirrors are type-only on the web). */
export const SURVEY_REASONS: readonly Reason[] = ['not_useful', 'wrong_fills', 'privacy', 'too_many_prompts', 'site_not_supported', 'other'];

export function UninstallSurvey() {
  const t = useTranslations('extensionWeb');
  const survey = useUninstallSurvey();
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);

  const toggle = (r: Reason, on: boolean) => {
    setMissing(false);
    setReasons((prev) => (on ? [...prev.filter((x) => x !== r), r] : prev.filter((x) => x !== r)));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!reasons.length) {
      setMissing(true);
      return;
    }
    const text = note.trim();
    survey.mutate({ reasons, ...(text ? { note: text.slice(0, 1000) } : {}) });
  };

  if (survey.isSuccess) {
    return (
      <p className={s.body} role="status">
        {t('uninstalled.sent')}
      </p>
    );
  }

  return (
    <form className={s.stack} onSubmit={onSubmit} noValidate>
      <fieldset className={s.fieldset} aria-describedby={missing ? 'ext-survey-missing' : undefined}>
        <legend className={s.legend}>{t('uninstalled.question')}</legend>
        {SURVEY_REASONS.map((r) => (
          <label key={r} className={s.check}>
            <input type="checkbox" name="reason" value={r} checked={reasons.includes(r)} onChange={(e) => toggle(r, e.currentTarget.checked)} />
            <span>{t(`uninstalled.reasons.${r}`)}</span>
          </label>
        ))}
      </fieldset>
      {missing ? (
        <p className={s.error} id="ext-survey-missing" role="alert">
          {t('uninstalled.pickOne')}
        </p>
      ) : null}
      <label className={s.label}>
        {t('uninstalled.note')}
        <textarea className={s.textarea} maxLength={1000} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      </label>
      {survey.isError ? (
        <p className={s.error} role="alert">
          {t('uninstalled.error')}
        </p>
      ) : null}
      <div className={s.actions}>
        <Btn type="submit" variant="primary" disabled={survey.isPending}>
          {survey.isPending ? t('uninstalled.sending') : t('uninstalled.send')}
        </Btn>
      </div>
    </form>
  );
}

export function UninstalledPage() {
  const t = useTranslations('extensionWeb');
  return (
    <div className={s.page}>
      <section className={s.hero} aria-labelledby="ext-uninstalled-title">
        <h1 className={s.title} id="ext-uninstalled-title">
          {t('uninstalled.title')}
        </h1>
        <p className={s.lead}>{t('uninstalled.intro')}</p>
      </section>
      <section className={s.card}>
        <UninstallSurvey />
      </section>
      <div className={s.actions}>
        <Btn as="a" href="/extension">
          {t('uninstalled.reinstall')}
        </Btn>
        <Btn as="a" href="/" variant="ghost">
          {t('uninstalled.back')}
        </Btn>
      </div>
    </div>
  );
}

export default UninstallSurvey;
