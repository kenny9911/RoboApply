'use client';

// AdminCoachesConsole — /admin/coaches (WP-72; PRODUCT_PLAN.md §3.4).
// Admin only (the API enforces it too). The coach list for both sites:
// name, photo, bio, languages, what they help with, session lengths and the
// coach's own prices, a booking page or an email for requests, shown/hidden.
//
// Honesty (D3): staff add only people who agreed to be listed (a required
// confirmation on every new entry), with the coach's own words and prices.
// A coach is shown only with a way to book (the API refuses otherwise).
// While a site's list has no shown coach, coaching stays hidden there.

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { Modal } from '../../v3/primitives/Modal';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { useAuth } from '../../../lib/auth/useAuth';
import { clientBrandFor } from '../../../lib/brand';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import type { AdminCoachView } from '../../../lib/api/contracts/coaching';
import {
  useAdminCoaches,
  useCreateCoach,
  useDeleteCoach,
  useUpdateCoach,
  type CoachBrandFilter,
} from '../../../hooks/coaching/useCoaching';
import { splitList, toMajor, toMinor } from './format';
import styles from './coaching.module.css';

const BRANDS: readonly CoachBrandFilter[] = ['roboapply', 'goapply'];

function siteName(id: CoachBrandFilter): string {
  return clientBrandFor(id).name;
}

export function AdminCoachesConsole() {
  const t = useTranslations('coaching.admin');
  const tAdmin = useTranslations('admin');
  const tCard = useTranslations('coaching.card');
  const { user, status } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [brand, setBrand] = useState<CoachBrandFilter | ''>('');
  const q = useAdminCoaches(brand || null, isAdmin);
  const [editing, setEditing] = useState<AdminCoachView | 'new' | null>(null);
  const [removing, setRemoving] = useState<AdminCoachView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const update = useUpdateCoach();
  const remove = useDeleteCoach();

  if (status === 'loading') {
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  }
  if (!isAdmin) {
    return <EmptyState title={`${tAdmin('notAuthorized.title')} ${tAdmin('notAuthorized.titleAccent')}`} sub={tAdmin('notAuthorized.sub')} />;
  }

  const coaches = q.data?.items ?? [];

  return (
    <div className={styles.page} data-testid="admin-coaches">
      <PageHeader
        title={t('title')}
        sub={t('sub')}
        actions={
          <Btn variant="primary" onClick={() => setEditing('new')}>
            {t('add')}
          </Btn>
        }
      />
      <section className={styles.section}>
        <label className={styles.field}>
          <span className={styles.label}>{t('filterLabel')}</span>
          <select className={styles.select} value={brand} onChange={(e) => setBrand(e.target.value as CoachBrandFilter | '')}>
            <option value="">{t('filterAll')}</option>
            {BRANDS.map((b) => (
              <option key={b} value={b}>
                {siteName(b)}
              </option>
            ))}
          </select>
        </label>
        {notice ? (
          <p className={styles.muted} role="status">
            {notice}
          </p>
        ) : null}
        {q.isLoading ? (
          <p className={styles.muted} aria-busy="true">
            {t('loading')}
          </p>
        ) : q.isError ? (
          <p className={styles.error} role="alert">
            {t('loadError')}
          </p>
        ) : coaches.length === 0 ? (
          <p className={styles.muted}>{t('empty')}</p>
        ) : (
          <ul className={styles.rows}>
            {coaches.map((c) => (
              <li key={c.id} className={styles.row} data-testid="admin-coach-row">
                <div className={styles.who}>
                  <h2 className={styles.h3}>
                    {c.displayName}{' '}
                    <span className={`${styles.status} ${c.active ? styles.statusListed : ''}`}>{c.active ? t('listed') : t('notListedState')}</span>
                  </h2>
                  <p className={styles.muted}>
                    {t('rowMeta', {
                      site: siteName(c.brand),
                      booking: c.bookingUrl ? t('bookingLink') : c.requestEmail ? t('bookingRequest') : t('bookingNone'),
                    })}
                  </p>
                  <p className={styles.muted}>{c.sessionLengths.length ? c.sessionLengths.map((m) => tCard('sessionLength', { minutes: m })).join(' · ') : t('sessionsNone')}</p>
                </div>
                <div className={styles.actions}>
                  <Btn onClick={() => setEditing(c)}>{t('edit')}</Btn>
                  <Btn
                    disabled={update.isPending || (!c.active && !c.bookingUrl && !c.requestEmail)}
                    onClick={() =>
                      update.mutate(
                        { id: c.id, body: { active: !c.active } },
                        { onSuccess: () => setNotice(t('saved')) },
                      )
                    }
                  >
                    {c.active ? t('unlist') : t('list')}
                  </Btn>
                  <Btn variant="ghost" onClick={() => setRemoving(c)}>
                    {t('remove')}
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing ? (
        <CoachEditor
          coach={editing === 'new' ? null : editing}
          defaultBrand={brand || 'roboapply'}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice(t('saved'));
          }}
        />
      ) : null}

      {removing ? (
        <Modal
          open
          onClose={() => setRemoving(null)}
          title={t('remove')}
          maxWidth="sm"
          footer={
            <div className={styles.actions}>
              <Btn
                variant="primary"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(removing.id, {
                    onSuccess: () => {
                      setRemoving(null);
                      setNotice(t('removed'));
                    },
                  })
                }
              >
                {t('removeYes')}
              </Btn>
              <Btn variant="ghost" onClick={() => setRemoving(null)}>
                {t('removeNo')}
              </Btn>
            </div>
          }
        >
          <p className={styles.text}>{t('removeConfirm', { name: removing.displayName })}</p>
        </Modal>
      ) : null}
    </div>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────

interface FormState {
  brand: CoachBrandFilter;
  displayName: string;
  headline: string;
  bio: string;
  photoUrl: string;
  languages: string;
  specialties: string;
  sessionLengths: string;
  currency: string;
  prices: Record<string, string>;
  bookingUrl: string;
  requestEmail: string;
  introVideoUrl: string;
  userId: string;
  active: boolean;
  consent: boolean;
}

function initialState(coach: AdminCoachView | null, defaultBrand: CoachBrandFilter): FormState {
  const currency = typeof coach?.rates?.currency === 'string' ? coach.rates.currency : '';
  const prices: Record<string, string> = {};
  for (const s of coach?.sessions ?? []) {
    if (s.amountMinor !== null && s.currency) prices[String(s.minutes)] = String(toMajor(s.amountMinor, s.currency));
  }
  return {
    brand: coach?.brand ?? defaultBrand,
    displayName: coach?.displayName ?? '',
    headline: coach?.headline ?? '',
    bio: coach?.bio ?? '',
    photoUrl: coach?.photoUrl ?? '',
    languages: (coach?.languages ?? []).join(', '),
    specialties: (coach?.specialties ?? []).join(', '),
    sessionLengths: (coach?.sessionLengths ?? []).join(', '),
    currency,
    prices,
    bookingUrl: coach?.bookingUrl ?? '',
    requestEmail: coach?.requestEmail ?? '',
    introVideoUrl: coach?.introVideoUrl ?? '',
    userId: coach?.userId ?? '',
    active: coach?.active ?? false,
    // Existing entries were confirmed when they were added.
    consent: Boolean(coach),
  };
}

type FormErrorKey =
  | 'required'
  | 'consent'
  | 'noBookingPath'
  | 'lengths'
  | 'currency'
  | 'price'
  | 'userTaken'
  | 'userNotFound'
  | 'userWrongBrand'
  | 'invalid'
  | 'generic';

/** Parse the session lengths field; null when any entry is not a whole number of minutes in range. */
export function parseLengths(value: string): number[] | null {
  const parts = splitList(value);
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 15 || n > 180) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b).slice(0, 5);
}

/** Build the `rates` object (minor units), or null when no price is given; `error` on bad input. */
type Rates = { currency: string; [minutes: string]: number | string };

export function buildRates(lengths: number[], currency: string, prices: Record<string, string>): { rates: Rates | null; error?: FormErrorKey } {
  const given = lengths.filter((m) => (prices[String(m)] ?? '').trim() !== '');
  if (given.length === 0) return { rates: null };
  const cur = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return { rates: null, error: 'currency' };
  const rates: Rates = { currency: cur };
  for (const m of given) {
    const minor = toMinor(prices[String(m)]!, cur);
    if (minor === null) return { rates: null, error: 'price' };
    rates[String(m)] = minor;
  }
  return { rates };
}

function CoachEditor({
  coach,
  defaultBrand,
  onClose,
  onSaved,
}: {
  coach: AdminCoachView | null;
  defaultBrand: CoachBrandFilter;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('coaching.admin.form');
  const id = useId();
  const [f, setF] = useState<FormState>(() => initialState(coach, defaultBrand));
  const [error, setError] = useState<FormErrorKey | null>(null);
  const create = useCreateCoach();
  const update = useUpdateCoach();
  const pending = create.isPending || update.isPending;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const lengthsPreview = parseLengths(f.sessionLengths) ?? [];

  function onError(err: unknown) {
    const reason = apiErrorReason(err);
    if (reason === 'no_booking_path') setError('noBookingPath');
    else if (reason === 'coach_user_taken') setError('userTaken');
    else if (reason === 'coach_user_not_found') setError('userNotFound');
    else if (reason === 'coach_user_wrong_brand') setError('userWrongBrand');
    else if (apiErrorCode(err) === 'invalid_request') setError('invalid');
    else setError('generic');
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!f.displayName.trim() || !f.headline.trim() || !f.bio.trim()) return setError('required');
    if (!coach && !f.consent) return setError('consent');
    const lengths = parseLengths(f.sessionLengths);
    if (lengths === null) return setError('lengths');
    const { rates, error: ratesError } = buildRates(lengths, f.currency, f.prices);
    if (ratesError) return setError(ratesError);
    if (f.active && !f.bookingUrl.trim() && !f.requestEmail.trim()) return setError('noBookingPath');

    const text = (v: string) => v.trim() || null;
    const common = {
      brand: f.brand,
      displayName: f.displayName.trim(),
      headline: f.headline.trim(),
      bio: f.bio.trim(),
      languages: splitList(f.languages),
      specialties: splitList(f.specialties),
      sessionLengths: lengths,
      active: f.active,
    };
    if (coach) {
      update.mutate(
        {
          id: coach.id,
          body: {
            ...common,
            photoUrl: text(f.photoUrl),
            bookingUrl: text(f.bookingUrl),
            requestEmail: text(f.requestEmail),
            introVideoUrl: text(f.introVideoUrl),
            userId: text(f.userId),
            rates,
          },
        },
        { onSuccess: onSaved, onError },
      );
    } else {
      const optional = (key: string, v: string) => (v.trim() ? { [key]: v.trim() } : {});
      create.mutate(
        {
          ...common,
          ...optional('photoUrl', f.photoUrl),
          ...optional('bookingUrl', f.bookingUrl),
          ...optional('requestEmail', f.requestEmail),
          ...optional('introVideoUrl', f.introVideoUrl),
          ...optional('userId', f.userId),
          ...(rates ? { rates } : {}),
          // The server refuses a new roster row without this attestation (D3).
          listingConsent: true,
        },
        { onSuccess: onSaved, onError },
      );
    }
  }

  const formId = `${id}-coach`;
  const field = (key: keyof FormState, label: string, opts: { hint?: string; type?: string; wide?: boolean; required?: boolean } = {}) => (
    <div className={`${styles.field} ${opts.wide ? styles.wide : ''}`}>
      <label className={styles.label} htmlFor={`${id}-${key}`}>
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        className={styles.input}
        type={opts.type ?? 'text'}
        value={f[key] as string}
        onChange={(e) => set(key, e.target.value as never)}
        required={opts.required}
        aria-describedby={opts.hint ? `${id}-${key}-hint` : undefined}
      />
      {opts.hint ? (
        <p className={styles.hint} id={`${id}-${key}-hint`}>
          {opts.hint}
        </p>
      ) : null}
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={coach ? t('titleEdit', { name: coach.displayName }) : t('titleNew')}
      maxWidth="xl"
      footer={
        <div className={styles.actions}>
          <Btn variant="primary" type="submit" form={formId} disabled={pending}>
            {pending ? t('saving') : t('save')}
          </Btn>
          <Btn variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Btn>
        </div>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.label}>{t('site')}</span>
            <select className={styles.select} value={f.brand} onChange={(e) => set('brand', e.target.value as CoachBrandFilter)}>
              {BRANDS.map((b) => (
                <option key={b} value={b}>
                  {siteName(b)}
                </option>
              ))}
            </select>
          </label>
          {field('displayName', t('displayName'), { required: true })}
          {field('headline', t('headline'), { required: true, wide: true })}
          <div className={`${styles.field} ${styles.wide}`}>
            <label className={styles.label} htmlFor={`${id}-bio`}>
              {t('bio')}
            </label>
            <textarea
              id={`${id}-bio`}
              className={styles.textarea}
              value={f.bio}
              onChange={(e) => set('bio', e.target.value)}
              required
              aria-describedby={`${id}-bio-hint`}
              maxLength={5000}
            />
            <p className={styles.hint} id={`${id}-bio-hint`}>
              {t('bioHint')}
            </p>
          </div>
          {field('photoUrl', t('photoUrl'), { type: 'url' })}
          {field('introVideoUrl', t('introVideoUrl'), { type: 'url' })}
          {field('languages', t('languages'), { hint: t('languagesHint') })}
          {field('specialties', t('specialties'), { hint: t('specialtiesHint') })}
          {field('sessionLengths', t('sessionLengths'), { hint: t('sessionLengthsHint') })}
          {field('currency', t('currency'), { hint: t('currencyHint') })}
          {lengthsPreview.map((m) => (
            <label key={m} className={styles.field}>
              <span className={styles.label}>{t('price', { minutes: m })}</span>
              <input
                className={styles.input}
                inputMode="decimal"
                value={f.prices[String(m)] ?? ''}
                onChange={(e) => set('prices', { ...f.prices, [String(m)]: e.target.value })}
              />
            </label>
          ))}
          {field('bookingUrl', t('bookingUrl'), { type: 'url', hint: t('bookingUrlHint'), wide: true })}
          {field('requestEmail', t('requestEmail'), { type: 'email', hint: t('requestEmailHint') })}
          {field('userId', t('userId'), { hint: t('userIdHint') })}
        </div>
        <div className={styles.field}>
          <label className={styles.check}>
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} aria-describedby={`${id}-active-hint`} />
            <span>{t('active')}</span>
          </label>
          <p className={styles.hint} id={`${id}-active-hint`}>
            {t('activeHint')}
          </p>
        </div>
        {!coach ? (
          <label className={styles.check}>
            <input type="checkbox" checked={f.consent} onChange={(e) => set('consent', e.target.checked)} />
            <span>{t('consent')}</span>
          </label>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {t(`errors.${error}`)}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
