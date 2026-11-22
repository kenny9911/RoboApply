'use client';

// The rows of a job profile, shared by the comparison of two profiles, the
// version being refined and the saved profile. A row can carry Alice's marks:
// `differs` (the two profiles differ here, a blue dot) and `changed` (this
// version changed it, a blue rule with the old value struck through). Empty
// fields read as a dash, never as an invented value (D3).

import { useLocale, useTranslations } from 'next-intl';

import type { AliceJobProfile, AliceProfileField } from '../../../lib/api/contracts/alice';
import { formatAmount, placeText, SHOWN_FIELDS } from './model';
import s from './alice.module.css';

type Translate = ReturnType<typeof useTranslations>;

function List({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <span className={s.muted}>—</span>;
  return (
    <ul className={s.list}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Pills({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <span className={s.muted}>—</span>;
  return (
    <span className={s.inline}>
      {items.map((item) => (
        <span key={item} className={s.pill}>
          {item}
        </span>
      ))}
    </span>
  );
}

/** A field's value as plain text (for "Was: …" and for screen readers). */
export function fieldText(profile: AliceJobProfile, field: AliceProfileField, t: Translate, locale: string): string {
  const v = (key: string) => t(`values.${key}` as never);
  switch (field) {
    case 'titles':
    case 'industries':
    case 'skills':
    case 'mustHaves':
    case 'niceToHaves':
    case 'dealbreakers':
    case 'whyItFits':
      return (profile[field] as string[]).join(', ') || '—';
    case 'levels':
      return profile.levels.map((l) => v(`levels.${l}`)).join(', ') || '—';
    case 'workModels':
      return profile.workModels.map((w) => v(`workModels.${w}`)).join(', ') || '—';
    case 'companyKinds':
      return profile.companyKinds.map((k) => v(`companyKinds.${k}`)).join(', ') || '—';
    case 'companySizes':
      return profile.companySizes.map((size) => t('values.companySize', { size })).join(', ') || '—';
    case 'jobTypes':
      return profile.jobTypes.map((j) => v(`jobTypes.${j}`)).join(', ') || '—';
    case 'places':
      return placeText(profile.places) || '—';
    case 'pay':
      return profile.pay ? t(`values.payPer.${profile.pay.period}`, { amount: formatAmount(profile.pay, locale) }) : '—';
    case 'companies':
      return profile.companies.map((c) => c.name).join(', ') || '—';
    case 'label':
    case 'headline':
    case 'summary':
    case 'tradeoff':
      return profile[field] || '—';
    default:
      return '—';
  }
}

export function FieldValue({ profile, field }: { profile: AliceJobProfile; field: AliceProfileField }) {
  const t = useTranslations('alice');
  const locale = useLocale();
  switch (field) {
    case 'titles':
    case 'industries':
    case 'skills':
      return <Pills items={profile[field]} />;
    case 'mustHaves':
    case 'niceToHaves':
    case 'dealbreakers':
    case 'whyItFits':
      return <List items={profile[field]} />;
    case 'companies':
      if (profile.companies.length === 0) return <span className={s.muted}>—</span>;
      return (
        <span className={s.inline}>
          {profile.companies.map((c) => (
            <span key={c.name} className={c.source === 'you' ? s.pill : `${s.pill} ${s.pillAlice}`} title={c.source === 'you' ? t('values.companyYou') : t('values.companyAlice')}>
              {c.name}
              <span className={s.srOnly}> ({c.source === 'you' ? t('values.companyYou') : t('values.companyAlice')})</span>
            </span>
          ))}
        </span>
      );
    default:
      return <>{fieldText(profile, field, t, locale)}</>;
  }
}

export interface ProfileRowsProps {
  profile: AliceJobProfile;
  fields?: readonly AliceProfileField[];
  /** Fields where the two compared profiles differ. */
  differs?: ReadonlySet<AliceProfileField>;
  /** Fields this version changed, with the version before for "Was: …". */
  changed?: ReadonlySet<AliceProfileField>;
  previous?: AliceJobProfile | null;
}

export function ProfileRows({ profile, fields = SHOWN_FIELDS, differs, changed, previous }: ProfileRowsProps) {
  const t = useTranslations('alice');
  const locale = useLocale();
  return (
    <dl className={s.rows}>
      {fields.map((field) => {
        const isChanged = changed?.has(field) ?? false;
        return (
          <div key={field} className={s.row} data-differs={differs?.has(field) ? 'true' : undefined} data-changed={isChanged ? 'true' : undefined}>
            <dt>
              {t(`fields.${field}` as never)}
              {differs?.has(field) ? <span className={s.srOnly}> ({t('compare.differs')})</span> : null}
            </dt>
            <dd>
              <FieldValue profile={profile} field={field} />
              {isChanged ? <span className={s.changedTag}>{t('profile.changed')}</span> : null}
              {isChanged && previous ? <span className={s.was}>{t('profile.was', { value: fieldText(previous, field, t, locale) })}</span> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
