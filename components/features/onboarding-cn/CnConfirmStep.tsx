'use client';

// G7 确认 (/onboarding/confirm on GoApply) — PRODUCT_PLAN.md §4.5 G7.
//
// Real counts only: the matching stage's count when the page passes it,
// otherwise the open jobs in our index for the search (labelled as such); the
// campus programmes taking applications now for the user's 届别, each with a
// 届别 eligibility line, its official link, source and last-verified date.
// When the cn job feed is off (R-14) only the programmes show. When 个性化推荐
// is off, the page says jobs are sorted by date. Optional extra roles and
// "你从哪里知道我们". CTA 开始 → the first-value screen (`nextRoute`).

import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import type { CampusEventView } from '../../../lib/api/contracts/cn/campus';
import { useFlag } from '../../../lib/flags';
import { useCnOnboardingApi, type CnProgramList, type CnSnapshotView } from './api';
import { jobsLine as indexJobsLine } from './OpportunityPanel';
import { proseLocale } from './ConsentStep';
import type { CnOnboardingStepProps } from './types';
import { SelectField, StepFrame, useSaveStep, useStoredAnswers } from './parts';
import { CN_HEARD_FROM, stepAnswers } from './logic';
import styles from './OnboardingCn.module.css';

type Role = { taxonomyId?: string; label: string };
type HeardFrom = (typeof CN_HEARD_FROM)[number];

/** "2027届" → 2027 (null when the programme states no class). */
export function classOfProgram(p: Pick<CampusEventView, 'graduationClass'>): number | null {
  const m = p.graduationClass.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

export function CnConfirmStep({ onDone, onBack, matchSummary }: CnOnboardingStepProps) {
  const t = useTranslations('onboardingCn');
  const locale = useLocale();
  const format = useFormatter();
  const api = useCnOnboardingApi();
  const feedOn = useFlag('jobs.feed');
  const { answers, loaded } = useStoredAnswers();
  const [snapshot, setSnapshot] = useState<CnSnapshotView | null | 'loading'>('loading');
  const [programs, setPrograms] = useState<CnProgramList | null | 'loading'>('loading');
  // The ledger's 个性化推荐 answer (Settings may have changed it since G1); null = never answered.
  const [ledgerPersonalized, setLedgerPersonalized] = useState<boolean | null | 'unknown'>('unknown');
  const [related, setRelated] = useState<Role[]>([]);
  const [extra, setExtra] = useState<Role[]>([]);
  const [heardFrom, setHeardFrom] = useState<HeardFrom | null>(null);
  const [note, setNote] = useState('');
  const { save, saving, error } = useSaveStep('confirm', onDone);

  const intent = stepAnswers(answers, 'intent');
  const roles = useMemo(() => (Array.isArray(intent.targetRoles) ? (intent.targetRoles as Role[]) : []), [intent.targetRoles]);
  const cities = useMemo(() => (Array.isArray(intent.cities) ? (intent.cities as string[]) : []), [intent.cities]);
  const classYearRaw = stepAnswers(answers, 'identity').graduationClass;
  const classYear = typeof classYearRaw === 'number' ? classYearRaw : null;
  const answeredPersonalized = stepAnswers(answers, 'consent').personalizedRecommendation;
  const personalized = ledgerPersonalized === 'unknown' ? answeredPersonalized : ledgerPersonalized;

  useEffect(() => {
    if (!loaded) return;
    let live = true;
    if (!matchSummary && feedOn && roles.length) {
      api
        .marketSnapshot({ roles, cities, classYear })
        .then((s) => live && setSnapshot(s))
        .catch(() => live && setSnapshot(null));
    } else setSnapshot(null);
    api
      .campusPrograms({ classYear, cities })
      .then((p) => live && setPrograms(p))
      .catch(() => live && setPrograms(null));
    api
      .getMyConsents(proseLocale(locale))
      .then((list) => {
        const item = list.find((i) => i.type === 'personalized_recommendation');
        if (live && item) setLedgerPersonalized(item.granted);
      })
      .catch(() => undefined);
    if (roles[0]) {
      api
        .suggestRoles(roles[0].label, locale)
        .then((list) => live && setRelated(list.filter((s) => !roles.some((r) => r.label === s.label)).slice(0, 4).map((s) => ({ taxonomyId: s.taxonomyId, label: s.label }))))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, api, feedOn, matchSummary, classYear, locale]);

  const date = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { month: 'short', day: 'numeric' }) : '—');
  const programList = programs !== 'loading' && programs ? programs.items : [];
  const programsMore = programs !== 'loading' && !!programs?.more;
  const jobsLine = !feedOn
    ? null
    : matchSummary
      ? t('confirm.foundJobs', { count: matchSummary.jobCount })
      : snapshot && snapshot !== 'loading'
        ? snapshot.jobs.scope.complete
          ? t('confirm.indexJobs', { count: snapshot.jobs.value })
          : indexJobsLine(t, snapshot)
        : snapshot === 'loading'
          ? t('common.loading')
          : null;

  function toggleExtra(r: Role) {
    setExtra((cur) => (cur.some((x) => x.label === r.label) ? cur.filter((x) => x.label !== r.label) : cur.length >= 3 ? cur : [...cur, r]));
  }

  return (
    <StepFrame
      title={t('confirm.title')}
      onBack={onBack}
      nextLabel={t('confirm.cta')}
      saving={saving}
      error={error}
      onSubmit={() =>
        void save({
          ...(extra.length ? { extraRoles: extra } : {}),
          ...(heardFrom ? { heardFrom } : {}),
          ...(heardFrom === 'other' && note.trim() ? { heardFromNote: note.trim() } : {}),
        })
      }
    >
      <section className={styles.panel} aria-live="polite">
        {jobsLine ? <p className={styles.stat}>{jobsLine}</p> : null}
        {jobsLine && !matchSummary && snapshot && snapshot !== 'loading' && !snapshot.jobs.scope.complete ? <p className={styles.note}>{t('intent.panel.partial')}</p> : null}
        {programs === 'loading' ? null : programs ? (
          <p className={feedOn ? styles.subtitle : styles.stat}>
            {programsMore ? t('intent.panel.campusMore', { count: programList.length }) : t('confirm.programs', { count: programList.length })}
          </p>
        ) : null}
        <p className={styles.note}>{t('confirm.source')}</p>
      </section>

      {personalized !== true ? <p className={styles.notice}>{t('confirm.byDate')}</p> : null}

      {programList.length ? (
        <section className={styles.section} aria-labelledby="cn-confirm-programs">
          <h2 id="cn-confirm-programs" className={styles.label}>
            {classYear ? t('confirm.programsFor', { year: classYear }) : t('confirm.programsTitle')}
          </h2>
          <ul className={styles.list}>
            {programList.slice(0, 5).map((p) => {
              const cls = classOfProgram(p);
              return (
                <li key={p.id} className={styles.listItem}>
                  <span>
                    <strong>{p.companyName}</strong> · {p.title}
                    <br />
                    <span className={styles.optionMeta}>
                      {t('confirm.closes', { date: date(p.applyClosesAt) })} · {t('confirm.verified', { date: date(p.verifiedAt) })}
                      {p.sourceName ? ` · ${p.sourceName}` : ''}
                    </span>
                  </span>
                  <span>
                    {classYear && cls === classYear ? (
                      <span className={styles.ok}>{t('confirm.eligible', { year: cls })}</span>
                    ) : cls ? (
                      <span className={styles.optionMeta}>{t('confirm.forClass', { year: cls })}</span>
                    ) : null}{' '}
                    <a className={styles.inlineLink} href={p.officialUrl} target="_blank" rel="noopener noreferrer">
                      {t('confirm.official')}
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {related.length ? (
        <div className={styles.section} role="group" aria-labelledby="cn-confirm-related">
          <span id="cn-confirm-related" className={styles.label}>
            {t('confirm.relatedTitle')}
          </span>
          <div className={styles.chips}>
            {related.map((r) => (
              <button key={r.label} type="button" aria-pressed={extra.some((x) => x.label === r.label)} className={styles.chip} onClick={() => toggleExtra(r)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <SelectField
        label={t('confirm.heardFromLabel')}
        value={heardFrom}
        options={CN_HEARD_FROM}
        onChange={setHeardFrom}
        render={(v) => t(`confirm.heardFrom.${v}`)}
        placeholder={t('confirm.heardFromNone')}
      />
      {heardFrom === 'other' ? (
        <input className={styles.input} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} aria-label={t('confirm.heardFromOther')} placeholder={t('confirm.heardFromOther')} />
      ) : null}
    </StepFrame>
  );
}
