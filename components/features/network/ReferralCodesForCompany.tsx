'use client';

// ReferralCodesForCompany — the GoApply job page's People tab: moderated
// 内推码 that users shared for this company (WP-54; flag `cn.referralCodes`).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useReferralCodes } from '../../../hooks/network';
import { ReferralCodeCard } from './ReferralCodeCard';
import { REFERRALS_HREF } from './links';
import styles from './network.module.css';

const SHOWN = 4;

export function ReferralCodesForCompany({ companyName }: { companyName: string }) {
  const t = useTranslations('people.referrals');
  const q = useReferralCodes({ company: companyName });
  const items = (q.data?.pages ?? []).flatMap((p) => p.items).slice(0, SHOWN);
  if (q.isError) return null;
  return (
    <section className={styles.section} data-testid="referrals-for-company">
      <h3 className={styles.title}>{t('forCompany', { company: companyName })}</h3>
      <p className={styles.muted}>{t('honesty')}</p>
      {q.isLoading ? null : items.length ? (
        <ul className={styles.cards}>
          {items.map((item) => (
            <ReferralCodeCard key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>{t('noneForCompany', { company: companyName })}</p>
      )}
      <Link className={styles.link} href={`${REFERRALS_HREF}?company=${encodeURIComponent(companyName)}`}>
        {t('seeAll')}
      </Link>
    </section>
  );
}

export default ReferralCodesForCompany;
