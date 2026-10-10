'use client';

// Settings § Account — profile, contact, links.
// The name is the sign-in account's display name and is edited here (saved
// with the page's Save bar through PATCH /account). It is never the email
// address: an account with no name shows an empty field. The email is
// read-only (it is changed through its verification flow); the rest live on
// the preferences blob. The default-résumé picker that used to close this
// section sits under "Your search" (ResumeSection).
//
// Years of experience: the stored 0 is the default, not an answer, so it
// reads "Not set" (it used to claim "New graduate" for everyone). The LinkedIn
// link follows the same linkedin.com/in/ rule as onboarding. Pronoun options
// are translated (they were English in every locale).
//
// INT-12 removed two dead controls: the "Upload a photo" button (no handler,
// and the account has no photo) and the name / email inputs that accepted
// typing and threw it away. It also hides the Email row (and its confirmation
// line) for an account that has no email: a GoApply phone or WeChat sign-up
// stores a generated `…@users.goapply.invalid` address, which is not the
// user's and is never shown (components/v3/account/format.ts).

import { useTranslations } from 'next-intl';
import {
  PrefHeader,
  PrefGroup,
  PrefRow,
  TextInput,
  Select,
  Slider,
  joinTitleTail,
} from '../controls';
import { LanguageSwitcher } from '../../shell/LanguageSwitcher';
import type { RAPreferences } from '../../../../lib/api/v2';
import { EmailVerificationLine } from '../../../features/auth/SecuritySettings';
import { isPlaceholderEmail } from '../../account/format';

/** The account name's length limit (PATCH /account refuses more). */
export const ACCOUNT_NAME_MAX = 120;

/**
 * A LinkedIn profile link as this page accepts it: linkedin.com/in/<name>,
 * with or without https:// and www. (the field's placeholder has neither).
 * The same profile-link rule as onboarding (which stores the https form).
 */
export const SETTINGS_LINKEDIN_RE = /^(https?:\/\/)?(www\.)?linkedin\.com\/in\/[^\s/]+\/?$/i;

/** True when the LinkedIn field holds something that is not a profile link (empty is fine: the link is optional). */
export function linkedinInvalid(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  return v !== '' && !SETTINGS_LINKEDIN_RE.test(v);
}

export function IdentitySection({
  p,
  set,
  name,
  onNameChange,
  email,
}: {
  p: RAPreferences;
  set: <K extends keyof RAPreferences>(path: string, value: unknown) => void;
  name: string;
  /** Edits the account name (the page saves it with the Save bar). Omit to show it read-only. */
  onNameChange?: (value: string) => void;
  email: string;
}) {
  const t = useTranslations('settings');
  const ta = useTranslations('accountV2.prefs.identity');
  const tc = useTranslations('common');
  const hasEmail = !isPlaceholderEmail(email);
  const initials =
    name
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase() || '··';

  return (
    <>
      <PrefHeader
        eyebrow={t('identity.eyebrow')}
        title={joinTitleTail(t('identity.title_before'), t('identity.title_em'), t('identity.title_after'))}
        sub={t('identity.sub')}
      />

      <PrefGroup label={t('identity.group_profile')}>
        <div className="pref-avatar-row">
          <div className="pref-avatar" aria-hidden="true">
            {initials}
          </div>
        </div>
        <PrefRow label={t('identity.full_name')}>
          <TextInput
            value={name}
            onChange={onNameChange}
            readOnly={!onNameChange}
            placeholder={onNameChange ? ta('name_ph') : undefined}
            maxLength={ACCOUNT_NAME_MAX}
            autoComplete="name"
            ariaLabel={t('identity.full_name')}
          />
        </PrefRow>
        <PrefRow label={t('identity.pronouns')} sub={t('identity.pronouns_sub')}>
          <Select
            value={p.pronouns ?? ''}
            onChange={(v) => set('pronouns', v)}
            ariaLabel={t('identity.pronouns')}
            options={[
              { value: 'she/her', label: ta('pronouns_she') },
              { value: 'he/him', label: ta('pronouns_he') },
              { value: 'they/them', label: ta('pronouns_they') },
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
            fmt={(v) => (v === 0 ? ta('years_unset') : v)}
            suffix={p.yearsExp > 0 ? t('identity.years_suffix') : ''}
            ariaLabel={t('identity.years_exp')}
          />
        </PrefRow>
        <PrefRow label={tc('language')}>
          <LanguageSwitcher variant="full" />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('identity.group_contact')}>
        {hasEmail ? (
          <>
            <PrefRow label={t('identity.email')}>
              <TextInput value={email} readOnly ariaLabel={t('identity.email')} />
            </PrefRow>
            {/* WP-10: confirmed or not, with a resend button (never blocking). */}
            <EmailVerificationLine />
          </>
        ) : null}
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
            error={linkedinInvalid(p.links.linkedin) ? ta('linkedin_invalid') : null}
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
