'use client';

// ReferralHub — /referrals, the GoApply 内推码 hub (PRODUCT F-NET-08 cn; WP-54).
//
// Users share referral codes (company, code, programme, use-by date); a
// moderator checks each one before it appears; anyone can report a code; the
// sharer can delete theirs. Codes carry "Shared by a %BRAND% user, {month
// year}". Hidden behind `cn.referralCodes` (no UI entry when it is off).

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, EmptyState, PageHeader } from '../../v3/primitives';
import { useFlag } from '../../../lib/flags';
import { referralErrorKind, useReferralCodes, useShareReferralCode } from '../../../hooks/network';
import { ReferralCodeCard } from './ReferralCodeCard';
import { PhoneRequiredNotice } from './PhoneRequiredNotice';
import styles from './network.module.css';

const CLASS_YEARS = [2026, 2027, 2028, 2029, 2030];

export interface ReferralHubProps {
  /** `?company=` from the URL (the job page's "See all referral codes"). */
  initialCompany?: string | null;
}

function ShareForm() {
  const t = useTranslations('people.referrals');
  const share = useShareReferralCode();
  const [company, setCompany] = useState('');
  const [code, setCode] = useState('');
  const [programme, setProgramme] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [phoneRequired, setPhoneRequired] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setPhoneRequired(false);
    try {
      await share.mutateAsync({
        company: company.trim(),
        code: code.trim(),
        programme: programme.trim() || undefined,
        expiresAt: expiresAt || undefined,
        note: note.trim() || undefined,
      });
      setCode('');
      setNote('');
      setMessage({ ok: true, text: t('sharedPending') });
    } catch (err) {
      const kind = referralErrorKind(err);
      if (kind === 'phone_binding_required') setPhoneRequired(true);
      else setMessage({ ok: false, text: t(`error.${kind}`) });
    }
  };

  return (
    <section className={styles.section} aria-labelledby="share-referral">
      <h2 className={styles.title} id="share-referral">
        {t('shareTitle')}
      </h2>
      <p className={styles.muted}>{t('rules')}</p>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.row}>
          <label className={styles.fieldGrow}>
            {t('fieldCompany')}
            <input className={styles.input} required maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />
          </label>
          <label className={styles.fieldGrow}>
            {t('fieldCode')}
            <input className={styles.input} required minLength={2} maxLength={64} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        </div>
        <div className={styles.row}>
          <label className={styles.fieldGrow}>
            {t('fieldProgramme')}
            <input className={styles.input} maxLength={120} value={programme} onChange={(e) => setProgramme(e.target.value)} />
          </label>
          <label className={styles.fieldGrow}>
            {t('fieldExpires')}
            <input className={styles.input} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
        </div>
        <label className={styles.field}>
          {t('fieldNote')}
          <input className={styles.input} maxLength={300} placeholder={t('notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className={styles.row}>
          <Btn variant="primary" type="submit" disabled={share.isPending || !company.trim() || code.trim().length < 2}>
            {share.isPending ? t('sharing') : t('shareSubmit')}
          </Btn>
        </div>
        {phoneRequired ? <PhoneRequiredNotice /> : null}
        {message ? (
          <p className={message.ok ? styles.notice : styles.error} role={message.ok ? 'status' : 'alert'}>
            {message.text}
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function ReferralHub({ initialCompany = null }: ReferralHubProps) {
  const t = useTranslations('people.referrals');
  const enabled = useFlag('cn.referralCodes');
  const [companyInput, setCompanyInput] = useState(initialCompany ?? '');
  const [company, setCompany] = useState(initialCompany ?? '');
  const [classYear, setClassYear] = useState<number | null>(null);
  const q = useReferralCodes({ company, classYear }, { enabled });

  if (!enabled) {
    return (
      <div className={styles.page}>
        <EmptyState title={t('unavailable')} />
      </div>
    );
  }

  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const mine = pages[0]?.mine ?? [];

  return (
    <div className={styles.page} data-testid="referral-hub">
      <PageHeader title={t('title')} sub={t('sub')} />
      <p className={styles.muted}>{t('honesty')}</p>

      <form
        className={styles.row}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setCompany(companyInput.trim());
        }}
      >
        <label className={styles.fieldGrow}>
          {t('filterCompany')}
          <input className={styles.input} value={companyInput} maxLength={120} onChange={(e) => setCompanyInput(e.target.value)} />
        </label>
        <label className={styles.field}>
          {t('filterClassYear')}
          <select className={styles.select} value={classYear ?? ''} onChange={(e) => setClassYear(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('allYears')}</option>
            {CLASS_YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <Btn type="submit">{t('search')}</Btn>
      </form>

      {q.isError ? (
        <p className={styles.error} role="alert">
          {t(`error.${referralErrorKind(q.error)}`)}
        </p>
      ) : q.isLoading ? null : items.length ? (
        <ul className={styles.cards} data-testid="referral-list">
          {items.map((item) => (
            <ReferralCodeCard key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <EmptyState title={t('empty')} />
      )}
      {q.hasNextPage ? (
        <div className={styles.row}>
          <Btn onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {t('loadMore')}
          </Btn>
        </div>
      ) : null}

      <ShareForm />

      {mine.length ? (
        <section className={styles.section} aria-labelledby="my-referrals">
          <h2 className={styles.title} id="my-referrals">
            {t('mineTitle')}
          </h2>
          <ul className={styles.cards}>
            {mine.map((item) => (
              <ReferralCodeCard key={item.id} item={item} showStatus />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default ReferralHub;
