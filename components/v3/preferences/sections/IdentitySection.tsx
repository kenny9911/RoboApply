'use client';

// Settings § Account — profile, contact, links.
// name/email come from the auth profile (read-only display + editable name);
// the rest live on the preferences blob. The default-résumé picker that used to
// close this section now has its own settings section (ResumeSection).

import { useTranslations } from 'next-intl';
import {
  PrefHeader,
  PrefGroup,
  PrefRow,
  TextInput,
  Select,
  Slider,
} from '../controls';
import { Btn } from '../../primitives';
import { LanguageSwitcher } from '../../shell/LanguageSwitcher';
import type { RAPreferences } from '../../../../lib/api/v2';

export function IdentitySection({
  p,
  set,
  name,
  email,
}: {
  p: RAPreferences;
  set: <K extends keyof RAPreferences>(path: string, value: unknown) => void;
  name: string;
  email: string;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const initials =
    name
      .split(/\s+/)
      .map((w) => w.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase() || '··';

  return (
    <>
      <PrefHeader
        eyebrow={t('identity.eyebrow')}
        title={`${t('identity.title_before')} ${t('identity.title_em')}${t('identity.title_after')}`}
        sub={t('identity.sub')}
      />

      <PrefGroup label={t('identity.group_profile')}>
        <div className="pref-avatar-row">
          <div className="pref-avatar">{initials}</div>
          <div>
            <Btn>{t('identity.upload_photo')}</Btn>
            <div className="pref-row-sub" style={{ marginTop: 6 }}>
              {t('identity.photo_hint')}
            </div>
          </div>
        </div>
        <PrefRow label={t('identity.full_name')}>
          {/* Name lives on the auth profile; editing it here is display-only in
              the stub (profile update is out of scope for this lane). */}
          <TextInput value={name} onChange={() => {}} ariaLabel={t('identity.full_name')} />
        </PrefRow>
        <PrefRow label={t('identity.pronouns')} sub={t('identity.pronouns_sub')}>
          <Select
            value={p.pronouns ?? ''}
            onChange={(v) => set('pronouns', v)}
            ariaLabel={t('identity.pronouns')}
            options={[
              { value: 'she/her', label: 'she/her' },
              { value: 'he/him', label: 'he/him' },
              { value: 'they/them', label: 'they/them' },
              { value: 'other', label: t('identity.pronouns_other') },
              { value: '', label: t('identity.pronouns_none') },
            ]}
          />
        </PrefRow>
        <PrefRow label={t('identity.years_exp')}>
          <Slider
            value={p.yearsExp}
            min={0}
            max={20}
            onChange={(v) => set('yearsExp', v)}
            fmt={(v) => (v === 0 ? t('identity.new_grad') : v)}
            suffix={p.yearsExp > 0 ? t('identity.years_suffix') : ''}
            ariaLabel={t('identity.years_exp')}
          />
        </PrefRow>
        <PrefRow label={tc('language')}>
          <LanguageSwitcher variant="full" />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('identity.group_contact')}>
        <PrefRow label={t('identity.email')}>
          <TextInput value={email} onChange={() => {}} ariaLabel={t('identity.email')} />
        </PrefRow>
        <PrefRow label={t('identity.phone')}>
          <TextInput
            value={p.phone ?? ''}
            onChange={(v) => set('phone', v)}
            ariaLabel={t('identity.phone')}
          />
        </PrefRow>
        <PrefRow label={t('identity.location')}>
          <TextInput
            value={p.location ?? ''}
            onChange={(v) => set('location', v)}
            placeholder={t('identity.location_ph')}
            ariaLabel={t('identity.location')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('identity.group_links')}>
        <PrefRow label={t('identity.linkedin')}>
          <TextInput
            value={p.links.linkedin}
            onChange={(v) => set('links.linkedin', v)}
            prefix="↗"
            placeholder="linkedin.com/in/…"
            ariaLabel={t('identity.linkedin')}
          />
        </PrefRow>
        <PrefRow label={t('identity.github')}>
          <TextInput
            value={p.links.github}
            onChange={(v) => set('links.github', v)}
            prefix="↗"
            placeholder="github.com/…"
            ariaLabel={t('identity.github')}
          />
        </PrefRow>
        <PrefRow label={t('identity.portfolio')}>
          <TextInput
            value={p.links.portfolio}
            onChange={(v) => set('links.portfolio', v)}
            prefix="↗"
            placeholder="your.site"
            ariaLabel={t('identity.portfolio')}
          />
        </PrefRow>
      </PrefGroup>

    </>
  );
}
