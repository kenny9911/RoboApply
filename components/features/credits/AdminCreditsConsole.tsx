'use client';

// AdminCreditsConsole — /admin/credits (TASK_PLAN.md WP-21a/21b; PRODUCT_PLAN.md
// §6.2 "admin-editable at /admin/credits"; CN_TW_LAUNCH_PLAN.md L-7, TW-06).
//
//   Credit limits     per brand × Free/Pro cap override (AppConfig credits.catalog.v1);
//                     an empty cell means "use the default"
//   Per-user changes  RAEntitlementOverride rows (beta access, support fixes)
//   Taiwan rate       the TWD reference rate with its source and date; the
//                     reference line hides itself after 45 days
//   Taiwan revenue    year-to-date Taiwan-card revenue vs the NT$600,000 VAT
//                     registration level, warning at 70 %
//
// Admin only (the API enforces it too). Every number shown comes from the API.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { useAuth } from '../../../lib/auth/useAuth';
import { BRAND_IDS, getBrand, type BrandId } from '../../../lib/brand/registry.generated';
import { FX_REFERENCE_MAX_AGE_DAYS, isFxReferenceFresh } from '../../../lib/pricing';
import {
  useAdminCreditCatalog,
  useAdminFxReference,
  useAdminOverrides,
  useCreateOverride,
  useDeleteOverride,
  useSaveCreditCatalog,
  useSaveFxReference,
  useTwRevenue,
} from '../../../hooks/credits/useAdminCredits';
import {
  EDITABLE_BUCKETS,
  OVERRIDE_KEY_RE,
  applyDraft,
  draftFromOverride,
  invalidCells,
  parseOverrideValue,
  revenueShare,
  type CapDraft,
} from './adminCatalog';
import { bucketLabelKey, parseDate } from './labels';
import styles from './credits.module.css';

export function AdminCreditsConsole() {
  const t = useTranslations('credits.admin');
  const tAdmin = useTranslations('admin');
  const { user, status } = useAuth();
  if (status === 'loading') return <p className={styles.muted} aria-busy="true">{t('loading')}</p>;
  if (user?.role !== 'admin') {
    return <EmptyState title={`${tAdmin('notAuthorized.title')} ${tAdmin('notAuthorized.titleAccent')}`} sub={tAdmin('notAuthorized.sub')} />;
  }
  return (
    <div className={styles.page} data-testid="admin-credits">
      <PageHeader title={t('title')} sub={t('sub')} />
      <CapsEditor />
      <OverridesPanel />
      <FxPanel />
      <TwRevenuePanel />
    </div>
  );
}

// ── Credit limits ─────────────────────────────────────────────────────────

function CapsEditor() {
  const t = useTranslations('credits.admin.caps');
  const tc = useTranslations('credits');
  const q = useAdminCreditCatalog();
  const save = useSaveCreditCatalog();
  const [brand, setBrand] = useState<BrandId>('roboapply');
  const stored = q.data?.override;
  const [draft, setDraft] = useState<CapDraft>(() => draftFromOverride(undefined, 'roboapply'));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setDraft(draftFromOverride(stored, brand));
    setTouched(false);
  }, [stored, brand]);

  const bad = useMemo(() => invalidCells(draft), [draft]);

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    if (bad.length) return;
    save.mutate({ override: applyDraft(stored, brand, draft) }, { onSuccess: () => setTouched(false) });
  };

  return (
    <section className={styles.card} aria-labelledby="admin-caps">
      <h2 className={styles.h2} id="admin-caps">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      {q.isError ? <p className={styles.error}>{t('loadError')}</p> : null}
      <form className={styles.form} onSubmit={onSave}>
        <label className={styles.label} htmlFor="admin-caps-brand">
          {t('brand')}
        </label>
        <select id="admin-caps-brand" className={styles.select} value={brand} onChange={(e) => setBrand(e.target.value as BrandId)}>
          {BRAND_IDS.map((id) => (
            <option key={id} value={id}>
              {getBrand(id).name}
            </option>
          ))}
        </select>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('bucket')}</th>
                <th scope="col">{t('free')}</th>
                <th scope="col">{t('pro')}</th>
              </tr>
            </thead>
            <tbody>
              {EDITABLE_BUCKETS.map((b) => (
                <tr key={b}>
                  <th scope="row">{tc(bucketLabelKey(b))}</th>
                  {(['free', 'pro'] as const).map((p) => (
                    <td key={p}>
                      <input
                        className={styles.capInput}
                        inputMode="numeric"
                        aria-label={`${tc(bucketLabelKey(b))} · ${t(p)}`}
                        aria-invalid={bad.includes(`${b}.${p}`) || undefined}
                        placeholder={t('default')}
                        value={draft[b]?.[p] ?? ''}
                        disabled={!q.data}
                        onChange={(e) => {
                          setTouched(true);
                          setDraft((d) => ({ ...d, [b]: { ...d[b], [p]: e.target.value } }));
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {bad.length ? <p className={styles.error}>{t('invalid')}</p> : null}
        {save.isError ? <p className={styles.error} role="alert">{t('error')}</p> : null}
        {save.isSuccess && !touched ? <p className={styles.muted} role="status">{t('saved')}</p> : null}
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={!q.data || !touched || bad.length > 0 || save.isPending}>
            {t('save')}
          </Btn>
        </div>
      </form>
    </section>
  );
}

// ── Per-user overrides ────────────────────────────────────────────────────

function OverridesPanel() {
  const t = useTranslations('credits.admin.overrides');
  const format = useFormatter();
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState<string | undefined>(undefined);
  const list = useAdminOverrides(applied);
  const create = useCreateOverride();
  const remove = useDeleteOverride();
  const [form, setForm] = useState({ userId: '', key: '', value: '', expiresAt: '', reason: '' });
  const [invalid, setInvalid] = useState(false);

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    const value = parseOverrideValue(form.value);
    const expires = form.expiresAt ? new Date(`${form.expiresAt}T23:59:59Z`) : null;
    if (!form.userId.trim() || !OVERRIDE_KEY_RE.test(form.key.trim()) || value === null || !form.reason.trim() || (expires && Number.isNaN(expires.getTime()))) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(
      {
        userId: form.userId.trim(),
        key: form.key.trim(),
        value,
        reason: form.reason.trim(),
        ...(expires ? { expiresAt: expires.toISOString() } : {}),
      },
      { onSuccess: () => setForm({ userId: '', key: '', value: '', expiresAt: '', reason: '' }) },
    );
  };

  const field = (name: keyof typeof form, label: string, extra: Record<string, unknown> = {}) => (
    <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
      <label className={styles.label} htmlFor={`ovr-${name}`}>
        {label}
      </label>
      <input
        id={`ovr-${name}`}
        className={styles.input}
        value={form[name]}
        onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}
        {...extra}
      />
    </div>
  );

  return (
    <section className={styles.card} aria-labelledby="admin-overrides">
      <h2 className={styles.h2} id="admin-overrides">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      <form
        className={styles.actions}
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filter.trim() || undefined);
        }}
      >
        <label className={styles.label} htmlFor="ovr-filter">
          {t('filter')}
        </label>
        <input id="ovr-filter" className={styles.input} style={{ maxWidth: 280 }} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Btn type="submit">{t('apply')}</Btn>
      </form>
      {list.isError ? <p className={styles.error}>{t('loadError')}</p> : null}
      {list.data && list.data.items.length === 0 ? <p className={styles.muted}>{t('empty')}</p> : null}
      {list.data && list.data.items.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('userId')}</th>
                <th scope="col">{t('key')}</th>
                <th scope="col">{t('value')}</th>
                <th scope="col">{t('expires')}</th>
                <th scope="col">{t('reason')}</th>
                <th scope="col">
                  <span className={styles.srOnly}>{t('remove')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((o) => {
                const exp = parseDate(o.expiresAt);
                return (
                  <tr key={o.id}>
                    <td>{o.userId}</td>
                    <td>{o.key}</td>
                    <td>{String(o.value)}</td>
                    <td>{exp ? format.dateTime(exp, { dateStyle: 'medium' }) : t('never')}</td>
                    <td>{o.reason}</td>
                    <td>
                      <Btn variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(o.id)}>
                        {t('remove')}
                      </Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onCreate}>
        <h3 className={styles.h3}>{t('addTitle')}</h3>
        <div className={styles.grid2}>
          {field('userId', t('userId'))}
          {field('key', t('key'), { placeholder: 'bucket:tailor' })}
          {field('value', t('value'), { placeholder: '20' })}
          {field('expiresAt', t('expires'), { type: 'date' })}
        </div>
        {field('reason', t('reason'))}
        <p className={styles.muted}>{t('keyHelp')}</p>
        {invalid ? <p className={styles.error}>{t('invalid')}</p> : null}
        {create.isError ? <p className={styles.error} role="alert">{t('error')}</p> : null}
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={create.isPending}>
            {t('add')}
          </Btn>
        </div>
      </form>
    </section>
  );
}

// ── Taiwan reference rate ─────────────────────────────────────────────────

function FxPanel() {
  const t = useTranslations('credits.admin.fx');
  const q = useAdminFxReference();
  const save = useSaveFxReference();
  const [rate, setRate] = useState('');
  const [source, setSource] = useState('');
  const [asOf, setAsOf] = useState('');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setRate(String(q.data.ratePerUsd));
    setSource(q.data.source);
    setAsOf(q.data.asOf);
  }, [q.data]);

  const fresh = q.data ? isFxReferenceFresh(q.data) : false;

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(rate);
    if (!(n > 0 && n <= 1000) || !source.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate({ currency: 'TWD', ratePerUsd: n, source: source.trim(), asOf });
  };

  return (
    <section className={styles.card} aria-labelledby="admin-fx">
      <h2 className={styles.h2} id="admin-fx">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub', { days: FX_REFERENCE_MAX_AGE_DAYS })}</p>
      {q.isError ? <p className={styles.error}>{t('loadError')}</p> : null}
      {q.isSuccess && !q.data ? <p className={styles.body}>{t('none')}</p> : null}
      {q.data && !fresh ? <p className={styles.body}>{t('stale', { days: FX_REFERENCE_MAX_AGE_DAYS })}</p> : null}
      <form className={styles.form} onSubmit={onSave}>
        <div className={styles.grid2}>
          <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
            <label className={styles.label} htmlFor="fx-rate">
              {t('rate')}
            </label>
            <input id="fx-rate" className={styles.input} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
          <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
            <label className={styles.label} htmlFor="fx-asof">
              {t('asOf')}
            </label>
            <input id="fx-asof" className={styles.input} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
        <label className={styles.label} htmlFor="fx-source">
          {t('source')}
        </label>
        <input id="fx-source" className={styles.input} value={source} onChange={(e) => setSource(e.target.value)} />
        {invalid ? <p className={styles.error}>{t('invalid')}</p> : null}
        {save.isError ? <p className={styles.error} role="alert">{t('error')}</p> : null}
        {save.isSuccess ? <p className={styles.muted} role="status">{t('saved')}</p> : null}
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={save.isPending}>
            {t('save')}
          </Btn>
        </div>
      </form>
    </section>
  );
}

// ── Taiwan card revenue ───────────────────────────────────────────────────

function TwRevenuePanel() {
  const t = useTranslations('credits.admin.tw');
  const format = useFormatter();
  const q = useTwRevenue();
  const d = q.data;
  const share = d ? revenueShare(d.revenueTwd, d.thresholdTwd) : null;
  // `warnAt` is whole NT$ (the contract's one unit); the percentage in the
  // copy is derived from it, and whether to warn is the server's own answer.
  const warnPct = d && d.thresholdTwd > 0 ? Math.round((d.warnAt / d.thresholdTwd) * 100) : null;
  const warn = d?.warning === true && warnPct !== null;
  const twd = (n: number) => format.number(n, { style: 'currency', currency: 'TWD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const asOf = parseDate(d?.asOf);
  return (
    <section className={styles.card} aria-labelledby="admin-tw">
      <h2 className={styles.h2} id="admin-tw">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      {q.isLoading ? <p className={styles.muted} aria-busy="true">{t('loading')}</p> : null}
      {q.isError ? <p className={styles.error}>{t('loadError')}</p> : null}
      {d ? (
        <ul className={styles.list}>
          <li className={styles.row}>
            <span className={styles.rowLabel}>{t('revenue')}</span>
            <span className={styles.rowValue}>{d.revenueTwd === null ? '—' : twd(d.revenueTwd)}</span>
          </li>
          <li className={styles.row}>
            <span className={styles.rowLabel}>{t('level')}</span>
            <span className={styles.rowValue}>{twd(d.thresholdTwd)}</span>
            <span className={styles.rowMeta}>{share === null ? '—' : t('share', { pct: share })}</span>
          </li>
          <li className={styles.row}>
            <span className={styles.rowMeta}>
              {t('asOf', { source: d.source, date: asOf ? format.dateTime(asOf, { dateStyle: 'medium' }) : '—' })}
            </span>
          </li>
        </ul>
      ) : null}
      {warn ? (
        <div className={styles.banner} role="alert">
          <p className={styles.body}>{t('warn', { pct: warnPct ?? 0 })}</p>
        </div>
      ) : null}
    </section>
  );
}

export default AdminCreditsConsole;
