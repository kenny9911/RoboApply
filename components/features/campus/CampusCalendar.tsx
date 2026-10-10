'use client';

// CampusCalendar — /campus, GoApply 校招日历 (WP-58; F-TOOL-05 cn, F-SEO-07 cn).
//
//   PageHeader     title + "dates are copied from the official page"
//   filters        届别 · role · city · taking applications now (in the URL,
//                  so a filtered page is linkable and server-rendered)
//   list           EventCard per programme, closing soonest first; "Show more"
//
// The list is the public read (CDN-cacheable, server-rendered for crawlers);
// a signed-in user's reminders come from /subscriptions. Everything shown is
// a published entry a person checked against the official page.

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { useAuth } from '../../../lib/auth/useAuth';
import type { CampusEventList } from '../../../lib/api/campus';
import { EventCard, type ReminderState } from './EventCard';
import { CLASS_YEARS } from './format';
import { useCampusList, useCampusSubscriptions, useSubscribeEvent, useUnsubscribe, type CampusFilter } from './useCampus';
import styles from './campus.module.css';

export interface CampusCalendarProps {
  /** Server-rendered first page (null when the server could not read it). */
  initial?: CampusEventList | null;
  filter?: CampusFilter;
}

/** Reminder state per programme for the signed-in user (shared by the list and company pages). */
export function useReminders(returnTo: string): (eventId: string) => ReminderState {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  const subs = useCampusSubscriptions(signedIn);
  const subscribe = useSubscribeEvent();
  const unsubscribe = useUnsubscribe();
  const byEvent = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of subs.data?.items ?? []) if (s.kind === 'event' && s.eventId) m.set(s.eventId, s.id);
    return m;
  }, [subs.data]);
  const pendingId = subscribe.isPending ? (subscribe.variables?.eventId ?? null) : null;
  const pendingSub = unsubscribe.isPending ? unsubscribe.variables : null;
  const errorId = subscribe.isError ? (subscribe.variables?.eventId ?? null) : null;
  return useCallback(
    (eventId: string): ReminderState => {
      const subscriptionId = byEvent.get(eventId) ?? null;
      return {
        signedIn,
        subscriptionId,
        pending: pendingId === eventId || (subscriptionId !== null && pendingSub === subscriptionId),
        error: errorId === eventId || (subscriptionId !== null && unsubscribe.isError && unsubscribe.variables === subscriptionId),
        onSubscribe: (id, channel) => subscribe.mutate({ eventId: id, channel: channel ?? 'in_app' }),
        onUnsubscribe: (id) => unsubscribe.mutate(id),
        returnTo,
      };
    },
    [byEvent, signedIn, pendingId, pendingSub, errorId, subscribe, unsubscribe, returnTo],
  );
}

function toQuery(f: CampusFilter): string {
  const qs = new URLSearchParams();
  if (f.class) qs.set('class', String(f.class));
  if (f.role) qs.set('role', f.role);
  if (f.city) qs.set('city', f.city);
  if (f.openNow) qs.set('openNow', 'true');
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function CampusCalendar({ initial = null, filter = {} }: CampusCalendarProps) {
  const t = useTranslations('campus');
  const router = useRouter();
  const pathname = usePathname() ?? '/campus';
  const [applied, setApplied] = useState<CampusFilter>(filter);
  const [draft, setDraft] = useState<CampusFilter>(filter);
  const sameAsInitial = JSON.stringify(applied) === JSON.stringify(filter);
  const list = useCampusList(applied, sameAsInitial ? initial : null);
  const reminderFor = useReminders(`${pathname}${toQuery(applied)}`);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  const apply = (next: CampusFilter) => {
    const clean: CampusFilter = {
      ...(next.class ? { class: next.class } : {}),
      ...(next.role?.trim() ? { role: next.role.trim() } : {}),
      ...(next.city?.trim() ? { city: next.city.trim() } : {}),
      ...(next.openNow ? { openNow: true } : {}),
    };
    setApplied(clean);
    setDraft(clean);
    router.replace(`${pathname}${toQuery(clean)}`, { scroll: false });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    apply(draft);
  };

  return (
    <div className={styles.page} data-testid="campus-calendar">
      <PageHeader eyebrow={t('page.eyebrow')} title={t('page.title')} sub={t('page.sub')} />
      <p className={styles.honesty}>{t('page.honesty')}</p>

      <form className={styles.filters} aria-label={t('filters.label')} onSubmit={onSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-class">
            {t('filters.class')}
          </label>
          <select
            id="campus-class"
            className={styles.select}
            value={draft.class ?? ''}
            onChange={(e) => setDraft({ ...draft, class: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">{t('filters.classAny')}</option>
            {CLASS_YEARS.map((y) => (
              <option key={y} value={y}>
                {t('filters.classOption', { year: y })}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-role">
            {t('filters.role')}
          </label>
          <input
            id="campus-role"
            className={styles.input}
            value={draft.role ?? ''}
            maxLength={80}
            placeholder={t('filters.rolePlaceholder')}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-city">
            {t('filters.city')}
          </label>
          <input
            id="campus-city"
            className={styles.input}
            value={draft.city ?? ''}
            maxLength={40}
            placeholder={t('filters.cityPlaceholder')}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
          />
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={!!draft.openNow} onChange={(e) => setDraft({ ...draft, openNow: e.target.checked })} />
          <span>{t('filters.openNow')}</span>
        </label>
        <div className={styles.filterActions}>
          <Btn type="submit" variant="primary">
            {t('filters.apply')}
          </Btn>
          <Btn type="button" onClick={() => apply({})}>
            {t('filters.clear')}
          </Btn>
        </div>
      </form>

      <section aria-label={t('list.label')} aria-busy={list.isLoading || undefined}>
        {list.isLoading ? (
          <p className={styles.muted}>{t('list.loading')}</p>
        ) : list.isError && !items.length ? (
          <EmptyState title={t('list.error')} action={<Btn onClick={() => void list.refetch()}>{t('list.retry')}</Btn>} />
        ) : !items.length ? (
          <EmptyState title={t('list.empty')} sub={t('list.emptySub')} />
        ) : (
          <ul className={styles.list}>
            {items.map((ev) => (
              <li key={ev.id}>
                <EventCard event={ev} reminder={reminderFor(ev.id)} />
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <div className={styles.more}>
            <Btn onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? t('list.loadingMore') : t('list.more')}
            </Btn>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** Shown when the capability is off (the server page normally 404s first). */
export function CampusUnavailable() {
  const t = useTranslations('campus.page');
  return (
    <div className={styles.page}>
      <EmptyState title={t('unavailableTitle')} sub={t('unavailableSub')} />
    </div>
  );
}
