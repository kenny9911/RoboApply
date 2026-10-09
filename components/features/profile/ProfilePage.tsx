'use client';

// /profile (F-ACCT-03; PRODUCT O9; TASK_PLAN.md WP-19).
//
//   Complete your profile (stepper over missing sections)
//   Update from a resume (field-by-field review)
//   Personal · [GoApply: Basic information + optional encrypted details]
//   Education · Work · Skills · Links
//   [RoboApply] Work authorization per country · [Taiwan] Taiwan job preferences
//   Application answers (→ Ready to apply's saved answers, WP-53)
//   [RoboApply, US targets, flag eeoAnswers] Equal-opportunity answers
//
// The profile is not the resume: a resume can propose changes here, never
// apply them silently, and editing the profile never edits a resume.

import { useLocale, useTranslations } from 'next-intl';

import { Btn, PageHeader } from '../../v3/primitives';
import type { ProfileSection, ProfileView } from '../../../lib/api/contracts/profile';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { useProfile, useSensitiveAnswers } from '../../../hooks/profile/useProfile';
import { BasicsSection } from './BasicsSection';
import { PersonalSection } from './PersonalSection';
import { ProfileCompletionCard } from './ProfileCompletionCard';
import { ResumeSyncPanel } from './ResumeSyncPanel';
import { EducationSection, WorkSection } from './RowSections';
import { SensitiveAnswersForm } from './SensitiveAnswersForm';
import { LinksSection, SkillsSection } from './SkillsLinksSections';
import { TaiwanSection, WorkAuthSection } from './WorkAuthSections';
import { isTaiwanRelevant, targetsUs } from './options';
import { MissingTag, SectionCard } from './parts';
import s from './profile.module.css';

/** True when the equal-opportunity questions are asked of this person (RoboApply, flag on, US target). */
export function eeoAsked(profile: ProfileView): boolean {
  return profile.availability.market === 'intl' && profile.availability.eeo && targetsUs(profile);
}

/**
 * Which sections this person sees, in page order. `storedEeo`: EEO answers are
 * stored; the section then stays (delete only) even when the questions no
 * longer apply, so saved answers are never out of reach.
 */
export function visibleSections(profile: ProfileView, locale: string, opts: { storedEeo?: boolean } = {}): ProfileSection[] {
  const intl = profile.availability.market === 'intl';
  const out: ProfileSection[] = ['personal'];
  if (!intl) out.push('basics');
  out.push('education', 'work', 'skills', 'links');
  if (intl) out.push('workAuth');
  if (intl && isTaiwanRelevant(profile, locale)) out.push('taiwan');
  out.push('answers');
  if (intl && (eeoAsked(profile) || opts.storedEeo)) out.push('eeo');
  return out;
}

function Section({ id, profile }: { id: ProfileSection; profile: ProfileView }) {
  const t = useTranslations('profile');
  switch (id) {
    case 'personal':
      return <PersonalSection profile={profile} />;
    case 'basics':
      return <BasicsSection profile={profile} />;
    case 'education':
      return <EducationSection profile={profile} />;
    case 'work':
      return <WorkSection profile={profile} />;
    case 'skills':
      return <SkillsSection profile={profile} />;
    case 'links':
      return <LinksSection profile={profile} />;
    case 'workAuth':
      return <WorkAuthSection profile={profile} />;
    case 'taiwan':
      return <TaiwanSection profile={profile} />;
    case 'answers':
      return (
        <SectionCard id="answers" title={t('sections.answers')} intro={t('answers.intro')}>
          <Btn as="a" href="/ready/setup#answers">
            {t('answers.open')}
          </Btn>
        </SectionCard>
      );
    case 'eeo':
      return eeoAsked(profile) ? (
        <SectionCard id="eeo" title={t('sections.eeo')} intro={t('eeo.intro')} optional>
          <p className={s.note}>{t('eeo.onlyUs')}</p>
          <SensitiveAnswersForm part="eeo" />
        </SectionCard>
      ) : (
        <SectionCard id="eeo" title={t('sections.eeo')} optional>
          <SensitiveAnswersForm part="eeo" deleteOnly />
        </SectionCard>
      );
    default:
      return null;
  }
}

export function ProfilePage() {
  const t = useTranslations('profile');
  const locale = useLocale();
  const query = useProfile();
  const profile = query.data;

  return (
    <div className={s.page}>
      <PageHeader eyebrow={t('page.eyebrow')} title={t('page.title')} sub={t('page.sub')} />

      {query.isLoading ? (
        <p className={s.note} role="status">
          {t('page.loading')}
        </p>
      ) : !profile ? (
        <div className={s.card} role="alert">
          <p className={s.note}>{apiErrorCode(query.error) === 'not_implemented' ? t('page.notReady') : t('page.loadError')}</p>
          <div className={s.actions}>
            <Btn onClick={() => void query.refetch()}>{t('page.retry')}</Btn>
          </div>
        </div>
      ) : (
        <ProfileBody profile={profile} locale={locale} />
      )}
    </div>
  );
}

function ProfileBody({ profile, locale }: { profile: ProfileView; locale: string }) {
  const t = useTranslations('profile');
  // Only fetched when the EEO questions aren't asked: are answers from earlier still stored?
  const stored = useSensitiveAnswers({ enabled: profile.availability.market === 'intl' && !eeoAsked(profile) });
  const storedEeo = !!stored.data && (!!stored.data.answers.eeo || stored.data.unreadable);
  const sections = visibleSections(profile, locale, { storedEeo });
  const missingBySection = new Set(profile.missing.map((m) => m.section));

  return (
    <>
      <ProfileCompletionCard profile={profile} />
      <div className={s.layout}>
        <nav className={s.rail} aria-label={t('page.sectionsNav')}>
          {sections.map((id) => (
            <a key={id} href={`#${id}`} className={s.railLink}>
              {t(`sections.${id}`)}
              {missingBySection.has(id) ? <MissingTag /> : null}
            </a>
          ))}
        </nav>
        <div className={s.sections}>
          <ResumeSyncPanel />
          <p className={s.note}>{t('notResume')}</p>
          {sections.map((id) => (
            <Section key={id} id={id} profile={profile} />
          ))}
        </div>
      </div>
    </>
  );
}
