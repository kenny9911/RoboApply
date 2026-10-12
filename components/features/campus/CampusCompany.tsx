'use client';

// CampusCompany — /campus/[company]: one employer's programmes (WP-58) and
// "Follow {company}" for a 届别 (RACampusSubscription kind 'company'): the
// follower gets one inbox notice when that company publishes a programme for
// that class. Nothing is followed without the user's tap.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { useAuth } from '../../../lib/auth/useAuth';
import type { CampusCompanyResponse } from '../../../lib/api/campus';
import { EventCard } from './EventCard';
import { useReminders } from './CampusCalendar';
import { CLASS_YEARS, yearOfClass } from './format';
import { useCampusCompany, useCampusSubscriptions, useFollowCompany, useUnsubscribe } from './useCampus';
import styles from './campus.module.css';

export interface CampusCompanyProps {
  slug: string;
  initial?: CampusCompanyResponse | null;
}

export function CampusCompany({ slug, initial = null }: CampusCompanyProps) {
  const t = useTranslations('campus');
  const pathname = usePathname() ?? `/campus/${encodeURIComponent(slug)}`;
  const q = useCampusCompany(slug, initial);
  const reminderFor = useReminders(pathname);
  const data = q.data;

  return (
    <div className={styles.page} data-testid="campus-company">
      <Link className={styles.back} href="/campus">
        ← {t('company.back')}
      </Link>
      {q.isLoading ? (
        <p className={styles.muted}>{t('list.loading')}</p>
      ) : !data ? (
        <EmptyState title={t('list.error')} action={<Btn onClick={() => void q.refetch()}>{t('list.retry')}</Btn>} />
      ) : (
        <>
          <PageHeader eyebrow={t('company.eyebrow')} title={t('company.title', { company: data.companyName })} sub={t('company.sub')} />
          <p className={styles.honesty}>{t('page.honesty')}</p>
          <FollowCompany companyName={data.companyName} defaultYear={yearOfClass(data.items[0]?.graduationClass)} returnTo={pathname} />
          <ul className={styles.list} aria-label={t('list.label')}>
            {data.items.map((ev) => (
              <li key={ev.id}>
                <EventCard event={ev} reminder={reminderFor(ev.id)} hideCompanyLink />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function FollowCompany({ companyName, defaultYear, returnTo }: { companyName: string; defaultYear: number | null; returnTo: string }) {
  const t = useTranslations('campus.follow');
  const tf = useTranslations('campus.filters');
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  const subs = useCampusSubscriptions(signedIn);
  const follow = useFollowCompany();
  const unfollow = useUnsubscribe();
  const existing = useMemo(
    () => (subs.data?.items ?? []).find((s) => s.kind === 'company' && s.companyName === norm(companyName)) ?? null,
    [subs.data, companyName],
  );
  const [year, setYear] = useState<number>(defaultYear ?? CLASS_YEARS[2]);
  const followingYear = yearOfClass(existing?.graduationClass);
  const pending = follow.isPending || unfollow.isPending;

  return (
    <section className={styles.followBox} aria-labelledby="campus-follow-h">
      <div className={styles.followText}>
        <h2 className={styles.h2} id="campus-follow-h">
          {t('title', { company: companyName })}
        </h2>
        <p className={styles.body}>{t('sub', { company: companyName })}</p>
        {existing && followingYear ? <p className={styles.muted}>{t('following', { year: followingYear })}</p> : null}
      </div>
      {!signedIn ? (
        <Btn as="a" href={`/login?from=campus&next=${encodeURIComponent(returnTo)}`}>
          {t('signIn', { company: companyName })}
        </Btn>
      ) : existing ? (
        <Btn onClick={() => unfollow.mutate(existing.id)} disabled={pending}>
          {pending ? t('saving') : t('unfollow')}
        </Btn>
      ) : (
        <form
          className={styles.followForm}
          onSubmit={(e) => {
            e.preventDefault();
            follow.mutate({ companyName, year });
          }}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor="campus-follow-class">
              {t('class')}
            </label>
            <select id="campus-follow-class" className={styles.select} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {CLASS_YEARS.map((y) => (
                <option key={y} value={y}>
                  {tf('classOption', { year: y })}
                </option>
              ))}
            </select>
          </div>
          <Btn type="submit" variant="primary" disabled={pending}>
            {pending ? t('saving') : t('button')}
          </Btn>
        </form>
      )}
      {follow.isError || unfollow.isError ? (
        <p className={styles.error} role="alert">
          {t('error')}
        </p>
      ) : null}
    </section>
  );
}
