'use client';

// Personal: names, contact details, location, headline and "About you".

import { useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { ProfileView } from '../../../lib/api/contracts/profile';
import { useProfileMutations } from '../../../hooks/profile/useProfile';
import { E164, PHONE_TYPES, compactPhone, sortedCountries } from './options';
import { SaveRow, SectionCard, SelectField, TextArea, TextField, str, useDraft, type SaveState } from './parts';
import s from './profile.module.css';

interface Draft {
  firstName: string;
  middleName: string;
  lastName: string;
  headline: string;
  contactEmail: string;
  phone: string;
  phoneType: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  summary: string;
}

function draftOf(p: ProfileView): Draft {
  return {
    firstName: str(p.firstName),
    middleName: str(p.middleName),
    lastName: str(p.lastName),
    headline: str(p.headline),
    contactEmail: str(p.contactEmail),
    phone: str(p.phoneE164),
    phoneType: str(p.phoneType),
    addressLine1: str(p.addressLine1),
    city: str(p.city),
    region: str(p.region),
    postalCode: str(p.postalCode),
    country: str(p.country),
    summary: str(p.summary),
  };
}

export function PersonalSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const locale = useLocale();
  const { patch } = useProfileMutations();
  const { draft, update, markClean } = useDraft(profile, () => draftOf(profile));
  const [state, setState] = useState<SaveState>('idle');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const countries = useMemo(() => sortedCountries(locale), [locale]);
  const missing = new Set(profile.missing.filter((m) => m.section === 'personal').map((m) => m.key));
  const isCn = profile.availability.market === 'cn';

  const set = (key: keyof Draft) => (value: string) => {
    update((d) => ({ ...d, [key]: value }));
    if (state !== 'idle') setState('idle');
  };

  async function save(e?: FormEvent) {
    e?.preventDefault();
    const phone = compactPhone(draft.phone);
    if (phone && !E164.test(phone)) {
      setPhoneError(t('personal.phoneInvalid'));
      setState('error');
      return;
    }
    setPhoneError(null);
    setState('saving');
    try {
      await patch.mutateAsync({
        firstName: draft.firstName,
        middleName: draft.middleName,
        lastName: draft.lastName,
        headline: draft.headline,
        contactEmail: draft.contactEmail.trim() || null,
        phoneE164: phone || null,
        phoneType: (draft.phoneType || null) as (typeof PHONE_TYPES)[number] | null,
        addressLine1: draft.addressLine1,
        city: draft.city,
        region: draft.region,
        postalCode: draft.postalCode,
        country: draft.country || null,
        summary: draft.summary,
      });
      markClean();
      setState('saved');
    } catch {
      setState('error');
    }
  }

  return (
    <SectionCard id="personal" title={t('sections.personal')} missing={missing.size > 0}>
      <form onSubmit={save} noValidate>
        <div className={s.grid}>
          {isCn ? (
            <>
              <TextField label={t('personal.lastName')} value={draft.lastName} onChange={set('lastName')} missing={missing.has('lastName')} autoComplete="family-name" maxLength={80} />
              <TextField label={t('personal.firstName')} value={draft.firstName} onChange={set('firstName')} missing={missing.has('firstName')} autoComplete="given-name" maxLength={80} />
            </>
          ) : (
            <>
              <TextField label={t('personal.firstName')} value={draft.firstName} onChange={set('firstName')} missing={missing.has('firstName')} autoComplete="given-name" maxLength={80} />
              <TextField label={t('personal.lastName')} value={draft.lastName} onChange={set('lastName')} missing={missing.has('lastName')} autoComplete="family-name" maxLength={80} />
              <TextField label={t('personal.middleName')} value={draft.middleName} onChange={set('middleName')} autoComplete="additional-name" maxLength={80} />
            </>
          )}
          <TextField label={t('personal.headline')} hint={t('personal.headlineHint')} value={draft.headline} onChange={set('headline')} maxLength={160} wide={isCn} />
          <TextField
            label={t('personal.contactEmail')}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={draft.contactEmail}
            onChange={set('contactEmail')}
            missing={missing.has('contactEmail')}
            maxLength={254}
          />
          <TextField
            label={t('personal.phone')}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            hint={t('personal.phoneHint')}
            error={phoneError}
            value={draft.phone}
            onChange={set('phone')}
            missing={missing.has('phone')}
            maxLength={24}
          />
          <SelectField
            label={t('personal.phoneType')}
            value={draft.phoneType}
            onChange={set('phoneType')}
            placeholder=""
            options={PHONE_TYPES.map((v) => ({ value: v, label: t(`personal.phoneTypes.${v}`) }))}
          />
          <TextField label={t('personal.city')} value={draft.city} onChange={set('city')} missing={missing.has('location') || missing.has('city')} autoComplete="address-level2" maxLength={120} />
          <TextField label={t('personal.region')} value={draft.region} onChange={set('region')} autoComplete="address-level1" maxLength={120} />
          <SelectField
            label={t('personal.country')}
            value={draft.country}
            onChange={set('country')}
            placeholder={t('personal.countryPlaceholder')}
            options={countries.map((c) => ({ value: c.code, label: c.name }))}
            missing={missing.has('location') && !draft.country}
          />
          <TextField label={t('personal.postalCode')} value={draft.postalCode} onChange={set('postalCode')} autoComplete="postal-code" maxLength={20} />
          <TextField label={t('personal.addressLine1')} value={draft.addressLine1} onChange={set('addressLine1')} autoComplete="street-address" maxLength={200} wide />
          <TextArea label={t('personal.summary')} hint={t('personal.summaryHint')} value={draft.summary} onChange={set('summary')} maxLength={4000} />
        </div>
        <SaveRow state={state} />
      </form>
    </SectionCard>
  );
}
