'use client';

// /settings#sensitive — the encrypted answers some application forms ask for
// (WP-19): equal-opportunity answers on RoboApply (people who'd like to work
// in the US, flag `eeoAnswers`), 籍贯 / 政治面貌 / 家庭成员 on GoApply.
// Work authorization lives on /profile (it is linked from here). Registered
// in components/features/settings/sectionComponents.ts.

import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useProfile, useSensitiveAnswers } from '../../../hooks/profile/useProfile';
import type { SettingsSectionProps } from '../settings/sectionComponents';
import { SensitiveAnswersForm } from './SensitiveAnswersForm';
import { targetsUs } from './options';
import s from './profile.module.css';

export function SettingsSection(_props: SettingsSectionProps) {
  const t = useTranslations('profile');
  const { data: profile, isLoading } = useProfile();
  const intl = profile?.availability.market === 'intl';
  const eeoAsked = !!profile && intl && profile.availability.eeo && targetsUs(profile);
  // Answers saved earlier stay reachable (to delete) even when the questions no longer apply.
  const stored = useSensitiveAnswers({ enabled: !!profile && intl && !eeoAsked });

  if (isLoading) return <p className={s.note}>{t('page.loading')}</p>;
  if (!profile) return <p className={s.note}>{t('page.loadError')}</p>;
  if (intl && !eeoAsked && stored.isLoading) return <p className={s.note}>{t('page.loading')}</p>;

  const a = profile.availability;
  const eeoStored = !!stored.data && (!!stored.data.answers.eeo || stored.data.unreadable);
  const part = a.market === 'cn' ? (a.cnSensitive ? 'cn' : null) : eeoAsked ? 'eeo' : eeoStored ? 'eeoStored' : null;

  return (
    <div className={s.page}>
      <div>
        <h2 className={s.cardTitle}>{t('sensitive.title')}</h2>
        <p className={s.cardIntro}>{t('sensitive.intro')}</p>
      </div>
      {part === 'eeo' || part === 'eeoStored' ? (
        <section aria-label={t('sections.eeo')}>
          <h3 className={s.label}>{t('sections.eeo')}</h3>
          <SensitiveAnswersForm part="eeo" deleteOnly={part === 'eeoStored'} />
        </section>
      ) : part === 'cn' ? (
        <SensitiveAnswersForm part="cn" />
      ) : (
        <p className={s.note}>{t('sensitive.none')}</p>
      )}
      <div>
        <Btn as="a" href={a.market === 'intl' ? '/profile#workAuth' : '/profile'}>
          {t('sensitive.openProfile')}
        </Btn>
      </div>
    </div>
  );
}

export default SettingsSection;
