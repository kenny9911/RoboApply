'use client';

// ProfileCompletionCard — "Complete your profile" (PRODUCT O9, ruling C32).
// A stepper over the sections that still miss a field application forms ask
// for. Rendered at the top of /profile; Ready to apply (WP-53) and the
// extension's web pages (WP-55a) render it too, with `linkBase="/profile"`,
// so each step jumps to its section. Renders nothing while loading, on error,
// or (unless `showWhenComplete`) once nothing is missing.
//
// The percentage is computed from the user's own profile by the server
// (`completeness`); it is not a statistic about anyone else.

import { useTranslations } from 'next-intl';

import type { ProfileSection, ProfileView } from '../../../lib/api/contracts/profile';
import { useProfile } from '../../../hooks/profile/useProfile';
import { cn } from '../../../lib/utils';
import s from './profile.module.css';

export interface ProfileCompletionCardProps {
  /** Prefix for the section links: '' on /profile (same-page anchors), '/profile' elsewhere. */
  linkBase?: string;
  /** Pass the profile when the caller already has it; otherwise the card reads the shared query. */
  profile?: ProfileView;
  showWhenComplete?: boolean;
}

/** Sections in page order, with the brand they appear on. */
const STEP_SECTIONS: ReadonlyArray<{ id: ProfileSection; market: 'intl' | 'cn' | 'both' }> = [
  { id: 'personal', market: 'both' },
  { id: 'basics', market: 'cn' },
  { id: 'education', market: 'both' },
  { id: 'work', market: 'both' },
  { id: 'skills', market: 'both' },
  { id: 'workAuth', market: 'intl' },
];

export function ProfileCompletionCard({ linkBase = '', profile, showWhenComplete = false }: ProfileCompletionCardProps) {
  const t = useTranslations('profile');
  const query = useProfile({ enabled: !profile });
  const data = profile ?? query.data;
  if (!data || !Array.isArray(data.missing)) return null;
  if (data.missing.length === 0 && !showWhenComplete) return null;

  const market = data.availability.market;
  const steps = STEP_SECTIONS.filter((x) => x.market === 'both' || x.market === market).map((x) => ({
    id: x.id,
    missing: data.missing.filter((m) => m.section === x.id).length,
  }));
  const percent = Math.max(0, Math.min(100, Math.round(data.completeness)));

  return (
    <section className={s.completion} aria-labelledby="profile-completion-title">
      <div className={s.completionHead}>
        <h2 id="profile-completion-title" className={s.completionTitle}>
          {t('completion.title')}
        </h2>
        <span className={s.note}>{t('completion.progress', { percent })}</span>
      </div>
      <div className={s.meter} role="progressbar" aria-label={t('completion.progressLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={s.meterFill} style={{ width: `${percent}%` }} />
      </div>
      <p className={s.note}>{data.missing.length === 0 ? t('completion.done') : t('completion.why')}</p>
      <ol className={s.steps}>
        {steps.map((step) => {
          const label = t(`sections.${step.id}`);
          const body = (
            <>
              <span className={s.stepName}>{label}</span>
              <span className={cn(s.tag, step.missing ? s.tagMissing : s.tagDone)}>
                {step.missing ? t('completion.stepMissing', { count: step.missing }) : t('completion.stepDone')}
              </span>
            </>
          );
          return (
            <li key={step.id}>
              {step.missing ? (
                <a className={s.step} href={`${linkBase}#${step.id}`} aria-label={`${t('completion.go', { section: label })}: ${t('completion.stepMissing', { count: step.missing })}`}>
                  {body}
                </a>
              ) : (
                <div className={s.step}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
