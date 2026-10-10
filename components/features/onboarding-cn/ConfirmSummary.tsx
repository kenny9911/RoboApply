'use client';

// "确认你的设置" lists the settings (G7). Every row is what the user chose on
// an earlier screen, read from the stored step answers; the two consent rows
// come from the consent ledger (Settings or the resume gate may have changed
// them since G1). A step the user skipped says so, and a question the user
// did not answer says "未填写" — nothing is filled in for them. Each group
// links back to its screen.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CN_ANY_CITY, CN_EMPLOYER_TYPES, CN_WORK_TYPES, formatMonthlyK, identityOf, stepAnswers } from './logic';
import styles from './OnboardingCn.module.css';

type Answers = Record<string, unknown> | null;
type T = ReturnType<typeof useTranslations>;

export type ConfirmSummaryRowId = 'identity' | 'education' | 'roles' | 'cities' | 'workType' | 'pay' | 'employer' | 'resume' | 'ai' | 'ranking';

export interface ConfirmSummaryRow {
  id: ConfirmSummaryRowId;
  /** The screen that edits it. */
  step: 'consent' | 'identity' | 'education' | 'intent' | 'tags' | 'resume';
  label: string;
  value: string;
}

/** The consent answers the summary shows: true / false, or null = never answered. */
export interface ConfirmConsents {
  aiProcessing: boolean | null;
  personalized: boolean | null;
}

const YEARS_KEY: Record<string, string> = { lt1: 'lt1', '1-3': 'y1to3', '3-5': 'y3to5', '5-10': 'y5to10', '10+': 'y10plus' };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The rows, from the stored answers. Pure: no request, no default values.
 * `consents` null = the ledger is not read yet (the consent rows are left out
 * rather than shown from stale step answers).
 */
export function confirmSummaryRows(answers: Answers, consents: ConfirmConsents | null, t: T): ConfirmSummaryRow[] {
  const sep = ' · ';
  const notSet = t('confirm.notSet');
  const rows: ConfirmSummaryRow[] = [];

  const identity = stepAnswers(answers, 'identity');
  const id = identityOf(answers);
  const identityParts = id
    ? [
        t(`identity.option.${id}.title`),
        typeof identity.graduationClass === 'number' ? t('identity.classOption', { year: identity.graduationClass }) : null,
        typeof identity.yearsExperience === 'string' && YEARS_KEY[identity.yearsExperience] ? t(`identity.years.${YEARS_KEY[identity.yearsExperience]}`) : null,
        typeof identity.jobSearchStatus === 'string' ? t(`identity.status.${identity.jobSearchStatus}`) : null,
      ].filter((v): v is string => !!v)
    : [];
  rows.push({ id: 'identity', step: 'identity', label: t('confirm.rows.identity'), value: identityParts.length ? identityParts.join(sep) : notSet });

  const edu = stepAnswers(answers, 'education');
  const eduParts = [
    typeof edu.degree === 'string' ? t(`education.degree.${edu.degree}`) : null,
    text(edu.school),
    text(edu.major),
    // 统招 only when the user answered it.
    typeof edu.fullTime === 'boolean' ? t('confirm.fullTime', { answer: edu.fullTime ? 'yes' : 'no' }) : null,
  ].filter((v): v is string => !!v);
  rows.push({ id: 'education', step: 'education', label: t('confirm.rows.education'), value: edu.skip === true ? t('confirm.skipped') : eduParts.length ? eduParts.join(sep) : notSet });

  const intent = stepAnswers(answers, 'intent');
  const roles = Array.isArray(intent.targetRoles) ? intent.targetRoles.map((r) => (isRecord(r) ? text(r.label) : null)).filter((v): v is string => !!v) : [];
  rows.push({ id: 'roles', step: 'intent', label: t('confirm.rows.roles'), value: roles.length ? roles.join(sep) : notSet });
  const cities = Array.isArray(intent.cities) ? intent.cities.filter((c): c is string => typeof c === 'string') : [];
  rows.push({ id: 'cities', step: 'intent', label: t('confirm.rows.cities'), value: cities.length ? cities.map((c) => (c === CN_ANY_CITY ? t('intent.anyCity') : c)).join(sep) : notSet });
  const workType = (CN_WORK_TYPES as readonly string[]).includes(intent.workType as string) ? (intent.workType as string) : null;
  rows.push({ id: 'workType', step: 'intent', label: t('confirm.rows.workType'), value: workType ? t(`intent.workType.${workType}`) : notSet });

  // Pay: only what was chosen (月薪 for 全职/兼职, 元/天 for 实习); nothing chosen = "未填写".
  const salary = intent.salaryMonthlyK;
  const daily = intent.internDailyPay;
  let pay: string | null = null;
  if (salary === 'negotiable') pay = t('intent.negotiable');
  else if (isRecord(salary) && typeof salary.min === 'number' && typeof salary.max === 'number') {
    pay = formatMonthlyK({ min: salary.min, max: salary.max }, typeof intent.salaryMonths === 'number' ? intent.salaryMonths : null);
  } else if (isRecord(daily) && typeof daily.min === 'number' && typeof daily.max === 'number') {
    pay = daily.min === daily.max ? t('intent.dailyOption', { n: daily.min }) : `${daily.min}–${t('intent.dailyOption', { n: daily.max })}`;
  } else if (daily === 'any') pay = t('intent.dailyAny');
  rows.push({ id: 'pay', step: 'intent', label: t('confirm.rows.pay'), value: pay ?? notSet });

  const tags = stepAnswers(answers, 'tags');
  const employer = Array.isArray(tags.employerTypes) ? tags.employerTypes.filter((e): e is string => (CN_EMPLOYER_TYPES as readonly string[]).includes(e as string)) : [];
  const tagParts = [...employer.map((e) => t(`tags.employer.${e}`)), ...(tags.wantsHukou === true ? [t('tags.hukou')] : [])];
  rows.push({ id: 'employer', step: 'tags', label: t('confirm.rows.employer'), value: tags.skip === true ? t('confirm.skipped') : tagParts.length ? tagParts.join(sep) : notSet });

  const resume = stepAnswers(answers, 'resume');
  rows.push({ id: 'resume', step: 'resume', label: t('confirm.rows.resume'), value: text(resume.resumeVariantId) ? t('confirm.resumeAdded') : t('confirm.resumeNone') });

  if (consents) {
    const onOff = (v: boolean | null) => (v === true ? t('consent.rankOn') : v === false ? t('consent.rankOff') : t('confirm.notChosen'));
    rows.push({ id: 'ai', step: 'consent', label: t('confirm.rows.ai'), value: onOff(consents.aiProcessing) });
    rows.push({ id: 'ranking', step: 'consent', label: t('confirm.rows.ranking'), value: onOff(consents.personalized) });
  }
  return rows;
}

export function ConfirmSummary({ answers, consents }: { answers: Answers; consents: ConfirmConsents | null }) {
  const t = useTranslations('onboardingCn');
  const rows = confirmSummaryRows(answers, consents, t);
  return (
    <section className={styles.section} aria-labelledby="cn-confirm-summary" data-testid="cn-confirm-summary">
      <h2 id="cn-confirm-summary" className={styles.label}>
        {t('confirm.summaryTitle')}
      </h2>
      <dl className={styles.summary}>
        {rows.map((r) => (
          <div key={r.id} className={styles.summaryRow} data-row={r.id}>
            <dt className={styles.summaryLabel}>{r.label}</dt>
            <dd className={styles.summaryValue}>{r.value}</dd>
            <dd className={styles.summaryEdit}>
              <Link className={styles.inlineLink} href={`/onboarding/${r.step}`} aria-label={t('confirm.editRow', { row: r.label })}>
                {t('confirm.edit')}
              </Link>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
