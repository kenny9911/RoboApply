'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../lib/auth/useAuth';
import { useOperationsOverview, useOperationsUsers, useOperationsPayments, useOperationsActivity } from '../../../hooks/useAdminOperations';
import { operationsCsvUrl, type OperationsFilters, type OperationsPayment, type OperationsUser, type OperationsActivity, type OperationsOverview, type NativeRevenue, type PaymentCoverage } from '../../../lib/api/adminOperations';
import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { MetricGrid } from '../../../components/v3/primitives/MetricGrid';
import { EmptyState } from '../../../components/v3/primitives/EmptyState';
import { Btn } from '../../../components/v3/primitives/Btn';
import { IconRefresh, IconUpload } from '../../../components/v3/primitives/Iconset';
import { DateRangePicker, DataTable, TierBadge, resolveRange, type RangeValue, type Column, fmtCurrency, fmtCount } from '../../../components/v3/admin';
import { fmtNativeAmount } from '../../../components/v3/admin/format';
import { SessionsTab, RateCardTab } from '../../../components/v3/admin/legacyTabs';
import styles from './admin.module.css';

type Tab = 'overview' | 'users' | 'payments' | 'activity' | 'sessions' | 'rateCard';
type Translator = ReturnType<typeof useTranslations>;
const TABS: Tab[] = ['overview', 'users', 'payments', 'activity', 'sessions', 'rateCard'];

export default function AdminPage() {
  const t = useTranslations('adminOps');
  const admin = useTranslations('admin');
  const { user, status } = useAuth();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const refreshing = useIsFetching({ queryKey: ['admin'] }) > 0;
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<RangeValue>({ preset: '30d' });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [userFilter, setUserFilter] = useState('');
  const resolved = useMemo(() => resolveRange(range), [range, refreshVersion]);
  const isAdmin = user?.role === 'admin';
  const go = (next: Tab, userId = '') => { setUserFilter(userId); setTab(next); };
  // Drill-down links are shareable; never include personal names or emails in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('tab') as Tab;
    if (TABS.includes(requested)) setTab(requested);
    setUserFilter(params.get('userId') ?? '');
  }, []);

  if (status === 'loading') return <p aria-busy="true">{t('loading')}</p>;
  if (!isAdmin) return <EmptyState title={`${admin('notAuthorized.title')} ${admin('notAuthorized.titleAccent')}`} sub={admin('notAuthorized.sub')} />;
  return (
    <div className={styles.console}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('subtitle')} actions={
        <Btn icon={<IconRefresh size={15} />} disabled={refreshing} onClick={() => { setRefreshVersion(v => v + 1); void queryClient.invalidateQueries({ queryKey: ['admin'] }); }}>
          {t(refreshing ? 'refreshing' : 'refresh')}
        </Btn>
      } />
      <div className={styles.toolbar}>
        <div className={styles.period}><DateRangePicker value={range} onChange={setRange} /><span className={styles.meta}>{t('timezone', { tz: resolved.tz })}</span></div>
      </div>
      <div className={styles.tabs} role="tablist" aria-label={t('title')}>
        {TABS.map(id => <button key={id} id={`admin-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`admin-panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={event => {
          const index = TABS.indexOf(id);
          const next = event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length] : event.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length] : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : null;
          if (next) { event.preventDefault(); go(next); document.getElementById(`admin-tab-${next}`)?.focus(); }
        }} onClick={() => go(id)}>{t(id)}</button>)}
      </div>
      <section id={`admin-panel-${tab}`} role="tabpanel" aria-labelledby={`admin-tab-${tab}`} key={`${tab}:${resolved.from}:${resolved.to}:${userFilter}`}>
        {tab === 'overview' && <Overview range={resolved} locale={locale} go={go} />}
        {tab === 'users' && <Users range={resolved} locale={locale} go={go} />}
        {tab === 'payments' && <Payments range={resolved} locale={locale} userId={userFilter} clearUser={() => setUserFilter('')} />}
        {tab === 'activity' && <Activity range={resolved} locale={locale} userId={userFilter} clearUser={() => setUserFilter('')} />}
        {tab === 'sessions' && <div className={styles.tableWrap}><SessionsTab range={resolved} locale={locale} /></div>}
        {tab === 'rateCard' && <RateCardTab locale={locale} />}
      </section>
    </div>
  );
}

type RangeProps = { range: { from: string; to: string; tz: string }; locale: string };
type Go = (tab: Tab, userId?: string) => void;
function Overview({ range, locale, go }: RangeProps & { go: Go }) {
  const t = useTranslations('adminOps');
  const q = useOperationsOverview(range);
  const recent = useOperationsPayments({ ...range, page: 1, pageSize: 5 });
  if (q.isError) return <ErrorPanel retry={() => void q.refetch()} />;
  const d = q.data;
  const count = (v: number | undefined) => v === undefined ? '—' : fmtCount(v, locale);
  return <div className={styles.overview} aria-busy={q.isLoading}>
    <MetricGrid className={styles.metrics} label={t('overview')} items={[
      { label: t('totalUsers'), value: count(d?.users.total), detail: d ? t('newUsers', { count: d.users.new }) : t('loading') },
      { label: t('activeUsers'), value: count(d?.users.active), detail: t('activeHint') },
      { label: t('logins'), value: count(d?.users.loginEvents), detail: d ? t('loginHint', { count: d.users.loginUsers }) : t('loading') },
      { label: t('featureUses'), value: count(d?.users.featureEvents), detail: t('featureHint') },
    ]} />
    <div className={styles.split}>
      <section className={styles.panel}>
        <PanelHeader title={t('collections')} sub={t('nativeCurrency')} action={<Btn variant="ghost" onClick={() => go('payments')}>{t('viewPayments')} →</Btn>} />
        {d ? <CurrencyTotals currencies={d.payments.currencies} locale={locale} /> : <p className={styles.empty}>{t('loading')}</p>}
        <p className={styles.note}>{t('currencyNote')}</p>
        {d && <Coverage coverage={d.payments.coverage} />}
      </section>
      <section className={`${styles.panel} ${styles.cost}`}>
        <PanelHeader title={t('serviceCost')} sub={t('costHint')} />
        <div><strong className={styles.money}>{d ? fmtCurrency(d.costUsd, locale, 'USD') : '—'}</strong><span className={styles.meta}>{t('costCurrency')}</span></div>
        <div className={styles.featureRow}><div className={styles.featureTitle}><span>{t('payingUsers')}</span><strong>{count(d?.users.payingUsers)}</strong></div><p className={styles.note}>{t('paidHint')}</p></div>
      </section>
    </div>
    <div className={styles.split}>
      <section className={styles.panel}>
        <PanelHeader title={t('activityTrend')} sub={t('trendHint')} action={<Btn variant="ghost" onClick={() => go('activity')}>{t('viewActivity')} →</Btn>} />
        {d ? <ActivityChart series={d.activitySeries} locale={locale} /> : <p className={styles.empty}>{t('loading')}</p>}
      </section>
      <section className={styles.panel}>
        <PanelHeader title={t('featureBreakdown')} sub={t('featureBreakdownHint')} />
        {d?.featureUsage.length ? d.featureUsage.slice(0, 6).map((f) => <div className={styles.featureRow} key={`${f.source}:${f.key}`}>
          <div className={styles.featureTitle}><span>{featureName(f.key, t)}<small className={styles.subtext}>{t(f.source === 'usage_ledger' ? 'usageLedger' : 'featureRequest')}</small></span><strong>{fmtCount(f.events, locale)}</strong></div>
          <div className={styles.featureTrack}><div className={styles.featureFill} style={{ width: `${f.events / Math.max(...d.featureUsage.map(i => i.events), 1) * 100}%` }} /></div>
        </div>) : <p className={styles.empty}>{t(d ? 'emptyActivity' : 'loading')}</p>}
        <p className={styles.note}>{t('ledgerHint')}</p>
      </section>
    </div>
    <section>
      <PanelHeader title={t('recentPayments')} action={<Btn variant="ghost" onClick={() => go('payments')}>{t('viewPayments')} →</Btn>} />
      <div className={styles.tableWrap}><DataTable columns={paymentColumns(t, locale, range.tz)} rows={recent.data?.rows ?? []} rowKey={r => r.id} loading={recent.isLoading} error={recent.isError} {...tableMessages(t, () => void recent.refetch())} /></div>
    </section>
    <div className={styles.coverage}><strong>{t('coverage')}</strong><p>{t('coverageNote')}</p>{d?.trackingSince && <p>{t('trackingSince', { date: dateTime(d.trackingSince, locale, range.tz) })}</p>}<p>{t('regionNote')}</p></div>
  </div>;
}
function PanelHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return <div className={styles.panelHeader}><div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>{action}</div>;
}
function CurrencyTotals({ currencies, locale }: { currencies: NativeRevenue[]; locale: string }) {
  const t = useTranslations('adminOps');
  const sorted = [...currencies].sort((a, b) => a.currency === 'CNY' ? -1 : b.currency === 'CNY' ? 1 : a.currency.localeCompare(b.currency));
  if (!sorted.length) return <p className={styles.empty}>{t('noPayments')}</p>;
  return <div className={styles.currencies}>{sorted.map(c => <div className={styles.currency} key={c.currency}>
    <span className={styles.currencyTag}>{c.currency}</span><strong className={styles.money}>{fmtNativeAmount(c.paidMinor, c.currency, locale)}</strong><span className={styles.meta}>{t('transactions', { count: c.paidCount })}</span>
  </div>)}</div>;
}
function Coverage({ coverage }: { coverage: PaymentCoverage }) {
  const t = useTranslations('adminOps');
  const key = { partial: 'stripePartial', unavailable: 'stripeUnavailable', not_configured: 'stripeNotConfigured', complete: '' }[coverage.stripe];
  return <>{key && <p className={styles.notice} role="status">{t(key)}</p>}<p className={styles.note}>{t('refundsNote')}</p></>;
}
function ActivityChart({ series, locale }: { series: OperationsOverview['activitySeries']; locale: string }) {
  const t = useTranslations('adminOps');
  if (!series.some(p => p.logins || p.featureEvents)) return <p className={styles.empty}>{t('emptyActivity')}</p>;
  const max = Math.max(...series.flatMap(p => [p.logins, p.featureEvents]), 1);
  const day = (s: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(s));
  return <>
    <div className={styles.chart} role="img" aria-label={series.map(p => `${day(p.day)}: ${t('logins')} ${p.logins}, ${t('featureUses')} ${p.featureEvents}`).join('; ')}>
      {series.map(p => <div className={styles.chartDay} key={p.day} title={`${day(p.day)} · ${t('logins')}: ${p.logins} · ${t('featureUses')}: ${p.featureEvents}`}><div className={`${styles.chartBar} ${styles.chartBarLogin}`} style={{ height: `${p.logins / max * 100}%` }} /><div className={styles.chartBar} style={{ height: `${p.featureEvents / max * 100}%` }} /></div>)}
    </div>
    <div className={styles.axis}><span>{day(series[0].day)}</span><span>{day(series[Math.floor(series.length / 2)].day)}</span><span>{day(series[series.length - 1].day)}</span></div>
    <div className={styles.legend}><span><i />{t('logins')}</span><span><i />{t('featureUses')}</span></div>
  </>;
}

function useFilters(range: RangeProps['range'], userId?: string) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  const change = (key: string, value: string) => { setFilters(prev => ({ ...prev, [key]: value })); setPage(1); };
  const reset = () => { setFilters({}); setSearch(''); setQuery(''); setPage(1); };
  const params: OperationsFilters = { ...range, ...filters, q: query || undefined, userId: userId || undefined, page, pageSize: 25 };
  return { filters, search, setSearch, page, setPage, change, reset, params };
}
type FilterState = ReturnType<typeof useFilters>;
function Filters({ state, kind, userId, clearUser }: { state: FilterState; kind: 'payments' | 'users' | 'activity'; userId?: string; clearUser?: () => void }) {
  const t = useTranslations('adminOps');
  const locale = useLocale();
  const select = (key: string, label: string, options: [string, string][]) => <label className={styles.field} key={key}>{t(label)}<select value={state.filters[key] ?? ''} onChange={e => state.change(key, e.target.value)}>{options.map(([value, text]) => <option key={value} value={value}>{t(text)}</option>)}</select></label>;
  return <div className={styles.filters}>
    <label className={`${styles.field} ${styles.searchField}`}>{t('search')}<input type="search" value={state.search} onChange={e => state.setSearch(e.target.value)} placeholder={t('search')} /></label>
    <label className={styles.field}>{t('region')}<select value={state.filters.region ?? ''} onChange={e => state.change('region', e.target.value)}><option value="">{t('allRegions')}</option>{['cn', 'us', 'tw', 'jp', 'eu', 'hk', 'kr', 'gb', 'sg', 'ca', 'au', 'other', 'unknown'].map(code => <option key={code} value={code}>{regionLabel(code, t, locale)}</option>)}</select></label>
    {kind === 'payments' && <>
      {select('provider', 'provider', [['', 'allProviders'], ['alipay', 'alipay'], ['stripe', 'stripe']])}
      {select('type', 'type', [['', 'allTypes'], ['plan_purchase', 'plan_purchase'], ['renewal', 'renewal']])}
      {select('status', 'status', [['', 'allStatuses'], ['paid', 'paid'], ['pending', 'pending'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['expired', 'expired'], ['open', 'open'], ['draft', 'draft'], ['void', 'void'], ['uncollectible', 'uncollectible']])}
      <label className={styles.field}>{t('currency')}<select value={state.filters.currency ?? ''} onChange={e => state.change('currency', e.target.value)}><option value="">{t('allCurrencies')}</option>{['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'HKD', 'TWD', 'BRL', 'CAD', 'AUD', 'SGD'].map(code => <option key={code}>{code}</option>)}</select></label>
    </>}
    {kind === 'activity' && select('type', 'event', [['', 'allEvents'], ['login', 'login'], ['signup', 'signup'], ['feature_use', 'featureRequest'], ['usage_debit', 'usageLedger']])}
    {(Object.values(state.filters).some(Boolean) || state.search || userId) && <Btn variant="ghost" onClick={() => { state.reset(); clearUser?.(); }}>{t('clearFilters')}</Btn>}
    {userId && <span className={styles.meta}>{t('filteredUser', { id: userId })}</span>}
  </div>;
}
function Payments({ range, locale, userId, clearUser }: RangeProps & { userId: string; clearUser: () => void }) {
  const t = useTranslations('adminOps');
  const state = useFilters(range, userId);
  const q = useOperationsPayments(state.params);
  return <>
    <Filters state={state} kind="payments" userId={userId} clearUser={clearUser} />
    {q.data && <section className={styles.panel} style={{ marginBottom: 24 }}><CurrencyTotals currencies={q.data.currencies} locale={locale} /><Coverage coverage={q.data.coverage} /></section>}
    <TableTitle title={t('payments')} kind="payments" params={state.params} />
    <div className={styles.tableWrap}><DataTable columns={paymentColumns(t, locale, range.tz)} rows={q.data?.rows ?? []} rowKey={r => r.id} loading={q.isLoading} error={q.isError} {...pagination(state, q.data?.total ?? 0, t)} {...tableMessages(t, () => void q.refetch())} /></div>
    <p className={styles.note}>{t('regionNote')}</p>
  </>;
}
function paymentColumns(t: Translator, locale: string, tz: string): Column<OperationsPayment>[] {
  return [
    { key: 'date', header: t('date'), render: r => <span>{dateTime(r.paidAt ?? r.createdAt, locale, tz)}</span> },
    { key: 'user', header: t('user'), render: r => <Person row={r} /> },
    { key: 'amount', header: t('amount'), align: 'right', render: r => <span className={styles.amount}>{fmtNativeAmount(r.amountMinor, r.currency, locale)}</span> },
    { key: 'status', header: t('status'), render: r => <EventBadge value={r.status} /> },
    { key: 'type', header: t('type'), render: r => <>{label(r.type, t)}{r.tier && <span className={styles.subtext}><TierBadge tier={r.tier} /></span>}</> },
    { key: 'region', header: t('region'), render: r => regionLabel(r.region, t, locale) },
    { key: 'provider', header: t('provider'), render: r => <>{label(r.provider, t)}<span className={styles.subtext} title={r.reference}>{r.reference}</span></> },
  ];
}
function Users({ range, locale, go }: RangeProps & { go: Go }) {
  const t = useTranslations('adminOps');
  const state = useFilters(range);
  const q = useOperationsUsers(state.params);
  const columns: Column<OperationsUser>[] = [
    { key: 'user', header: t('user'), render: r => <Person row={r} /> },
    { key: 'plan', header: t('plan'), render: r => <><TierBadge tier={r.tier} /><span className={styles.subtext}>{r.subscription.amountMinor == null ? t('priceUnknown') : fmtNativeAmount(r.subscription.amountMinor, r.subscription.currency, locale)}</span></> },
    { key: 'region', header: t('region'), render: r => regionLabel(r.region, t, locale) },
    { key: 'logins', header: t('logins'), align: 'right', render: r => fmtCount(r.loginEvents, locale) },
    { key: 'features', header: t('featureUses'), align: 'right', render: r => fmtCount(r.featureEvents, locale) },
    { key: 'cost', header: t('costCurrency'), align: 'right', render: r => fmtCurrency(r.periodCostUsd, locale, 'USD') },
    { key: 'lastLogin', header: t('lastLogin'), render: r => dateTime(r.lastLoginAt, locale, range.tz) },
    { key: 'lastActive', header: t('lastActive'), render: r => dateTime(r.lastActiveAt, locale, range.tz) },
    { key: 'actions', header: t('details'), render: r => <div className={styles.rowActions}><button onClick={() => go('payments', r.userId)}>{t('userPayments')}</button><button onClick={() => go('activity', r.userId)}>{t('userActivity')}</button></div> },
  ];
  return <><Filters state={state} kind="users" /><TableTitle title={t('users')} kind="operations/users" params={state.params} /><div className={styles.tableWrap}><DataTable columns={columns} rows={q.data?.rows ?? []} rowKey={r => r.userId} loading={q.isLoading} error={q.isError} {...pagination(state, q.data?.total ?? 0, t)} {...tableMessages(t, () => void q.refetch())} /></div></>;
}
function Activity({ range, locale, userId, clearUser }: RangeProps & { userId: string; clearUser: () => void }) {
  const t = useTranslations('adminOps');
  const state = useFilters(range, userId);
  const q = useOperationsActivity(state.params);
  const columns: Column<OperationsActivity>[] = [
    { key: 'date', header: t('date'), render: r => dateTime(r.createdAt, locale, range.tz) },
    { key: 'user', header: t('user'), render: r => <Person row={r} /> },
    { key: 'type', header: t('event'), render: r => <EventBadge value={r.type} /> },
    { key: 'feature', header: t('feature'), render: r => r.feature ? featureName(r.feature, t) : '—' },
    { key: 'region', header: t('region'), render: r => regionLabel(r.region, t, locale) },
    { key: 'units', header: t('units'), align: 'right', render: r => r.units === null ? '—' : fmtCount(r.units, locale) },
    { key: 'cost', header: t('costCurrency'), align: 'right', render: r => r.costUsd === null ? '—' : fmtCurrency(r.costUsd, locale, 'USD') },
    { key: 'source', header: t('source'), render: r => t(r.source === 'usage_ledger' ? 'usageLedger' : r.type === 'login' || r.type === 'signup' ? 'recorded' : 'featureRequest') },
  ];
  return <><Filters state={state} kind="activity" userId={userId} clearUser={clearUser} /><TableTitle title={t('activity')} kind="activity" params={state.params} /><div className={styles.tableWrap}><DataTable columns={columns} rows={q.data?.rows ?? []} rowKey={r => r.id} loading={q.isLoading} error={q.isError} {...pagination(state, q.data?.total ?? 0, t)} {...tableMessages(t, () => void q.refetch())} /></div><div className={styles.coverage} style={{ marginTop: 20 }}><strong>{t('coverage')}</strong><p>{t('coverageNote')}</p><p>{t('ledgerHint')}</p></div></>;
}
function TableTitle({ title, kind, params }: { title: string; kind: 'payments' | 'activity' | 'operations/users'; params: OperationsFilters }) {
  const t = useTranslations('adminOps');
  return <div className={styles.tableTitle}><h2>{title}</h2><Btn as="a" href={operationsCsvUrl(kind, params)} icon={<IconUpload size={15} />} title={t('exportHint')}>{t('export')}</Btn></div>;
}
function Person({ row }: { row: { userId: string; name: string | null; email: string } }) {
  return <div className={styles.person}><Link href={`/admin/users/${encodeURIComponent(row.userId)}`}>{row.name || row.email || row.userId}</Link>{row.name && <small>{row.email}</small>}</div>;
}
function EventBadge({ value }: { value: string }) {
  const t = useTranslations('adminOps');
  const tone = ['paid', 'success', 'completed'].includes(value) ? 'positive' : ['failed', 'error'].includes(value) ? 'negative' : ['pending', 'processing', 'created'].includes(value) ? 'pending' : '';
  return <span className={styles.badge} data-tone={tone}>{label(value, t)}</span>;
}
function label(value: string, t: Translator) { const key = value === 'feature_use' ? 'featureRequest' : value === 'usage_debit' ? 'usageLedger' : value === 'refunded' ? 'refundedStatus' : value; return t.has(key) ? t(key) : value; }
function regionLabel(value: string, t: Translator, locale: string) {
  if (!value || value === 'unknown') return t('unknown');
  if (value === 'other') return t('other');
  if (value.toLowerCase() === 'cn') return t('cn');
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(value.toUpperCase()) || value; } catch { return value; }
}
function featureName(value: string, t: Translator) { return t.has(`features.${value}`) ? t(`features.${value}`) : value.replace(/[_:.]/g, ' '); }
function dateTime(value: string | null, locale: string, timeZone: string) { return value ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(value)) : '—'; }
function tableMessages(t: Translator, retry: () => void) { return { emptyMessage: t('emptyResults'), errorTitle: t('loadError'), errorBody: t('loadErrorHint'), retryLabel: t('retry'), loadingLabel: t('loading'), onRetry: retry }; }
function pagination(state: FilterState, total: number, t: Translator) { return { page: state.page, pageSize: 25, total, prevLabel: t('prev'), nextLabel: t('next'), onPageChange: state.setPage, paginationLabel: (from: number, to: number, total: number) => t('rows', { from, to, total }) }; }
function ErrorPanel({ retry }: { retry: () => void }) { const t = useTranslations('adminOps'); return <EmptyState title={t('loadError')} sub={t('loadErrorHint')} action={<Btn onClick={retry}>{t('retry')}</Btn>} />; }
