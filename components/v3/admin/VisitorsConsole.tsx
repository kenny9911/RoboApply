'use client';

// components/v3/admin/VisitorsConsole.tsx — /admin/visitors: who came to the
// site, where from, and how many created an account (visitor conversion).
//
// The report is a cohort: the visitors FIRST SEEN in the chosen period, and
// how far each has got since (opened sign-up → started → account → finished
// setup). It reads the visitor records the events ingest keeps (server
// features/growth/visitors.ts) through GET /admin/visitors and
// /admin/visitors/list. Every number is a live count; nothing is estimated.
//
// Three things are said next to the funnel rather than folded into it, so the
// conversion rate is not flattered or deflated by them:
//   - visitors who already had an account when first seen here;
//   - page loads counted without a visitor record (people in the EEA, the UK
//     and Switzerland who have not allowed usage statistics);
//   - the accounts created in the period in total, matched to a visitor or not.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { PageHeader } from '../primitives/PageHeader';
import { MetricGrid, type MetricItem } from '../primitives/MetricGrid';
import { Btn } from '../primitives/Btn';
import { Tag, type TagTone } from '../primitives/Tag';
import { IconRefresh } from '../primitives/Iconset';
import { useVisitorList, useVisitorsReport } from '../../../hooks/useAdmin';
import type {
  VisitorBreakdownRow,
  VisitorChannelId,
  VisitorDayRow,
  VisitorFunnel,
  VisitorStatus,
  VisitorView,
  VisitorsReportResponse,
} from '../../../lib/api/admin';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { AdminGate } from './AdminGate';
import { AdminNav } from './AdminNav';
import { ErrorPanel } from './SystemConsole';
import { DateRangePicker, resolveRange, type RangeValue } from './controls';
import { fmtCount, fmtPercent } from './format';
import styles from './console.module.css';
import own from './visitors.module.css';

type T = ReturnType<typeof useTranslations>;
type Range = { from: string; to: string; tz: string };
type BrandFilter = '' | 'roboapply' | 'goapply';

const STAGES = ['visitors', 'signupViewed', 'signupStarted', 'signedUp', 'onboarded'] as const satisfies readonly (keyof VisitorFunnel)[];
const STATUSES: readonly VisitorStatus[] = ['browsing', 'signup_viewed', 'signup_started', 'signed_up', 'onboarded', 'known_user'];
const CHANNELS: readonly VisitorChannelId[] = ['direct', 'search', 'ai', 'social', 'email', 'paid', 'campaign', 'invite', 'referral'];
/** Columns the day chart draws at most; longer periods are grouped into equal runs of days. */
const MAX_CHART_COLUMNS = 62;

/** `part` as a percent of `whole` (0..100); null when there is nothing to divide by. */
export function conversionRate(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** The share of the stage before that reached this one; null for the first stage. */
export function stepRate(funnel: VisitorFunnel, stage: (typeof STAGES)[number]): number | null {
  const i = STAGES.indexOf(stage);
  return i <= 0 ? null : conversionRate(funnel[stage], funnel[STAGES[i - 1]!]);
}

/** Group a daily series into at most `max` columns of equal length (the last may be shorter). */
export function groupDays(daily: readonly VisitorDayRow[], max: number = MAX_CHART_COLUMNS): Array<{ from: string; to: string; visitors: number; signedUp: number }> {
  const size = Math.max(1, Math.ceil(daily.length / max));
  const out: Array<{ from: string; to: string; visitors: number; signedUp: number }> = [];
  for (let i = 0; i < daily.length; i += size) {
    const run = daily.slice(i, i + size);
    out.push({
      from: run[0]!.day,
      to: run[run.length - 1]!.day,
      visitors: run.reduce((n, d) => n + d.visitors, 0),
      signedUp: run.reduce((n, d) => n + d.signedUp, 0),
    });
  }
  return out;
}

/** "3 minutes" / "5 hours" / "2 days", in the reader's language. */
function fmtSpan(seconds: number, locale: string): string {
  const unit = seconds < 3600 ? 'minute' : seconds < 48 * 3600 ? 'hour' : 'day';
  const value = unit === 'minute' ? Math.max(1, Math.round(seconds / 60)) : unit === 'hour' ? Math.round(seconds / 3600) : Math.round(seconds / 86400);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}

/** A calendar day ("2026-11-03") as "Nov 3". Days are dates, not instants: formatted in UTC. */
function fmtDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

function fmtDateTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function VisitorsConsole() {
  return (
    <AdminGate>
      <VisitorsConsoleInner />
    </AdminGate>
  );
}

function VisitorsConsoleInner() {
  const t = useTranslations('admin.console.visitors');
  const locale = useLocale();
  const brand = useBrand();
  const [rangeValue, setRangeValue] = useState<RangeValue>({ preset: '30d' });
  const [site, setSite] = useState<BrandFilter>('');
  const [version, setVersion] = useState(0);
  // `version` re-reads "now" on Refresh, so a preset keeps ending at the present.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => resolveRange(rangeValue), [rangeValue, version]);
  const query = { ...range, ...(site ? { brand: site } : {}) };
  const q = useVisitorsReport(query);

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        sub={t('sub')}
        actions={
          <Btn icon={<IconRefresh size={15} />} disabled={q.isFetching} onClick={() => setVersion((v) => v + 1)}>
            {t(q.isFetching ? 'refreshing' : 'refresh')}
          </Btn>
        }
      />
      <AdminNav />
      <div className={styles.filters}>
        <DateRangePicker value={rangeValue} onChange={setRangeValue} />
        <label className={`${styles.field} ${own.site}`}>
          {t('site')}
          <select value={site} onChange={(e) => setSite(e.target.value as BrandFilter)}>
            <option value="">{t('allSites')}</option>
            {[brand, brand.otherBrand].map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
        <p className={styles.muted}>{t('timezone', { tz: range.tz })}</p>
      </div>

      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : (
        <Report data={q.data} locale={locale} t={t} />
      )}

      {q.data?.ready ? <VisitorList range={range} site={site} locale={locale} /> : null}
    </div>
  );
}

function Report({ data: d, locale, t }: { data: VisitorsReportResponse; locale: string; t: T }) {
  const f = d.funnel;
  const pct = (part: number, whole: number) => fmtPercent(conversionRate(part, whole), locale);
  const kpis: MetricItem[] = [
    { label: t('kpi.visitors'), value: fmtCount(f.visitors, locale), detail: t('kpi.visitorsDetail', { pages: fmtCount(d.pageViews, locale) }) },
    { label: t('kpi.signedUp'), value: fmtCount(f.signedUp, locale), detail: t('kpi.signedUpDetail') },
    { label: t('kpi.rate'), value: pct(f.signedUp, f.visitors), detail: t('kpi.rateDetail', { signedUp: fmtCount(f.signedUp, locale), visitors: fmtCount(f.visitors, locale) }) },
    { label: t('kpi.onboarded'), value: fmtCount(f.onboarded, locale), detail: t('kpi.onboardedDetail', { rate: pct(f.onboarded, f.signedUp) }) },
  ];
  return (
    <>
      {!d.ready ? (
        <div className={styles.alertBox} role="status">
          <strong>{t('notReady.title')}</strong>
          <p className={styles.muted}>{t('notReady.body')}</p>
        </div>
      ) : null}
      <MetricGrid className={styles.metrics} label={t('title')} items={kpis} />

      <section className={styles.panel} aria-labelledby="visitors-funnel">
        <div className={styles.panelHead}>
          <div>
            <h2 id="visitors-funnel">{t('steps.title')}</h2>
            <p>{t('steps.sub')}</p>
          </div>
        </div>
        {f.visitors === 0 ? (
          <p className={styles.muted}>{t('empty')}</p>
        ) : (
          <ol className={own.funnel}>
            {STAGES.map((stage) => {
              const share = conversionRate(f[stage], f.visitors) ?? 0;
              const step = stepRate(f, stage);
              return (
                <li key={stage} className={own.stage}>
                  <div className={own.stageHead}>
                    <span className={own.stageName}>{t(`steps.stages.${stage}`)}</span>
                    <strong className={own.stageCount}>{fmtCount(f[stage], locale)}</strong>
                  </div>
                  <div className={own.track} aria-hidden="true">
                    <div className={own.fill} style={{ width: `${Math.max(share, f[stage] > 0 ? 1 : 0)}%` }} />
                  </div>
                  <p className={own.stageNote}>
                    {t('steps.ofVisitors', { rate: fmtPercent(share, locale) })}
                    {step !== null ? <> · {t('steps.ofPrevious', { rate: fmtPercent(step, locale) })}</> : null}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
        <ul className={own.notes}>
          {d.medianSecondsToSignup !== null ? <li>{t('steps.median', { time: fmtSpan(d.medianSecondsToSignup, locale) })}</li> : null}
          <li>{t('steps.accounts', { count: d.newAccounts, formatted: fmtCount(d.newAccounts, locale) })}</li>
          {d.knownUsers > 0 ? <li>{t('steps.knownUsers', { count: d.knownUsers, formatted: fmtCount(d.knownUsers, locale) })}</li> : null}
          {d.untrackedVisits > 0 ? <li>{t('steps.untracked', { count: d.untrackedVisits, formatted: fmtCount(d.untrackedVisits, locale) })}</li> : null}
        </ul>
      </section>

      <section className={styles.panel} aria-labelledby="visitors-daily">
        <div className={styles.panelHead}>
          <div>
            <h2 id="visitors-daily">{t('daily.title')}</h2>
            <p>{t('daily.sub')}</p>
          </div>
        </div>
        <DayChart daily={d.daily} locale={locale} t={t} />
      </section>

      <div className={styles.split}>
        <Breakdown id="channels" rows={d.channels} locale={locale} t={t} label={(key) => (key && t.has(`channel.${key}`) ? t(`channel.${key}`) : key)} />
        <Breakdown id="sources" rows={d.sources} locale={locale} t={t} label={(key) => key ?? t('breakdown.direct')} />
      </div>
      <div className={styles.split}>
        <Breakdown id="landing" rows={d.landingPages} locale={locale} t={t} label={(key) => key} code />
        <Breakdown id="countries" rows={d.countries} locale={locale} t={t} label={(key) => (key ? countryName(key, locale) : null)} />
      </div>
      <div className={styles.split}>
        <Breakdown id="devices" rows={d.devices} locale={locale} t={t} label={(key) => (key && t.has(`device.${key}`) ? t(`device.${key}`) : key)} />
        <Breakdown id="methods" rows={d.methods} locale={locale} t={t} label={(key) => (key && t.has(`method.${key}`) ? t(`method.${key}`) : key)} />
      </div>
    </>
  );
}

function DayChart({ daily, locale, t }: { daily: VisitorDayRow[]; locale: string; t: T }) {
  const columns = groupDays(daily);
  const max = Math.max(...columns.map((c) => c.visitors), 1);
  const totals = columns.reduce((n, c) => ({ visitors: n.visitors + c.visitors, signedUp: n.signedUp + c.signedUp }), { visitors: 0, signedUp: 0 });
  if (!columns.length || totals.visitors === 0) return <p className={styles.muted}>{t('empty')}</p>;
  const name = (c: { from: string; to: string }) => (c.from === c.to ? fmtDay(c.from, locale) : `${fmtDay(c.from, locale)} – ${fmtDay(c.to, locale)}`);
  const mid = columns[Math.floor(columns.length / 2)]!;
  return (
    <>
      <div
        className={own.chart}
        role="img"
        aria-label={t('daily.summary', { from: fmtDay(columns[0]!.from, locale), to: fmtDay(columns[columns.length - 1]!.to, locale), visitors: fmtCount(totals.visitors, locale), signedUp: fmtCount(totals.signedUp, locale) })}
      >
        {columns.map((c) => (
          <div key={c.from} className={own.day} title={`${name(c)} · ${t('daily.visitors')}: ${fmtCount(c.visitors, locale)} · ${t('daily.signedUp')}: ${fmtCount(c.signedUp, locale)}`}>
            <div className={own.barVisitors} style={{ height: `${(c.visitors / max) * 100}%` }}>
              {c.signedUp > 0 ? <div className={own.barSigned} style={{ height: `${Math.max((c.signedUp / Math.max(c.visitors, 1)) * 100, 4)}%` }} /> : null}
            </div>
          </div>
        ))}
      </div>
      <div className={own.axis} aria-hidden="true">
        <span>{fmtDay(columns[0]!.from, locale)}</span>
        {columns.length > 2 ? <span>{fmtDay(mid.from, locale)}</span> : null}
        <span>{fmtDay(columns[columns.length - 1]!.to, locale)}</span>
      </div>
      <div className={own.legend}>
        <span><i className={own.swatchVisitors} />{t('daily.visitors')}</span>
        <span><i className={own.swatchSigned} />{t('daily.signedUp')}</span>
      </div>
    </>
  );
}

function Breakdown({
  id,
  rows,
  locale,
  t,
  label,
  code,
}: {
  id: 'channels' | 'sources' | 'landing' | 'countries' | 'devices' | 'methods';
  rows: VisitorBreakdownRow[];
  locale: string;
  t: T;
  label: (key: string | null) => string | null;
  code?: boolean;
}) {
  return (
    <section className={styles.panel} aria-labelledby={`visitors-${id}`}>
      <div className={styles.panelHead}>
        <div>
          <h2 id={`visitors-${id}`}>{t(`breakdown.${id}.title`)}</h2>
          <p>{t(`breakdown.${id}.sub`)}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className={styles.muted}>{t('breakdown.empty')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t(`breakdown.${id}.column`)}</th>
                <th scope="col" className={styles.num}>{t('breakdown.visitors')}</th>
                <th scope="col" className={styles.num}>{t('breakdown.signedUp')}</th>
                <th scope="col" className={styles.num}>{t('breakdown.rate')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const text = label(r.key) ?? t('breakdown.none');
                return (
                  <tr key={r.key ?? '∅'}>
                    <th scope="row">{code && r.key ? <span className={styles.code}>{text}</span> : text}</th>
                    <td className={styles.num}>{fmtCount(r.visitors, locale)}</td>
                    <td className={styles.num}>{fmtCount(r.signedUp, locale)}</td>
                    <td className={styles.num}>{fmtPercent(conversionRate(r.signedUp, r.visitors), locale)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const STATUS_TONE: Record<VisitorStatus, TagTone> = {
  browsing: 'default',
  signup_viewed: 'default',
  signup_started: 'warn',
  signed_up: 'strong',
  onboarded: 'strong',
  known_user: 'default',
};

function VisitorList({ range, site, locale }: { range: Range; site: BrandFilter; locale: string }) {
  const t = useTranslations('admin.console.visitors');
  const [status, setStatus] = useState<'' | VisitorStatus>('');
  const [channel, setChannel] = useState<'' | VisitorChannelId>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const q = useVisitorList({ ...range, ...(site ? { brand: site } : {}), ...(status ? { status } : {}), ...(channel ? { channel } : {}), ...(cursor ? { cursor } : {}) });
  const items = q.data?.items ?? [];
  return (
    <section className={styles.panel} aria-labelledby="visitors-list">
      <div className={styles.panelHead}>
        <div>
          <h2 id="visitors-list">{t('list.title')}</h2>
          <p>{t('list.sub')}</p>
        </div>
      </div>
      <div className={styles.filters}>
        <label className={styles.field}>
          {t('list.statusFilter')}
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setCursor(undefined); }}>
            <option value="">{t('list.allStatuses')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          {t('list.channelFilter')}
          <select value={channel} onChange={(e) => { setChannel(e.target.value as typeof channel); setCursor(undefined); }}>
            <option value="">{t('list.allChannels')}</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{t(`channel.${c}`)}</option>)}
          </select>
        </label>
      </div>
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : items.length === 0 ? (
        <p className={styles.muted}>{t('list.empty')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('list.col.lastSeen')}</th>
                <th scope="col">{t('list.col.status')}</th>
                <th scope="col">{t('list.col.source')}</th>
                <th scope="col">{t('list.col.landing')}</th>
                <th scope="col">{t('list.col.where')}</th>
                <th scope="col" className={styles.num}>{t('list.col.pages')}</th>
                <th scope="col">{t('list.col.account')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => <VisitorRow key={v.id} visitor={v} locale={locale} tz={range.tz} t={t} />)}
            </tbody>
          </table>
        </div>
      )}
      {cursor || q.data?.cursor ? (
        <div className={styles.actions}>
          {cursor ? <Btn variant="ghost" onClick={() => setCursor(undefined)}>{t('list.first')}</Btn> : null}
          {q.data?.cursor ? <Btn onClick={() => setCursor(q.data!.cursor ?? undefined)}>{t('list.next')}</Btn> : null}
        </div>
      ) : null}
    </section>
  );
}

function VisitorRow({ visitor: v, locale, tz, t }: { visitor: VisitorView; locale: string; tz: string; t: T }) {
  const channel = t.has(`channel.${v.channel}`) ? t(`channel.${v.channel}`) : v.channel;
  const device = v.device && t.has(`device.${v.device}`) ? t(`device.${v.device}`) : v.device;
  const method = v.signupMethod && t.has(`method.${v.signupMethod}`) ? t(`method.${v.signupMethod}`) : v.signupMethod;
  const where = [v.country ? countryName(v.country, locale) : null, device].filter(Boolean).join(' · ');
  return (
    <tr>
      <td className={own.nowrap}>
        {fmtDateTime(v.lastSeenAt, locale, tz)}
        <br />
        <small className={own.sub}>{t('list.firstSeen', { time: fmtDateTime(v.firstSeenAt, locale, tz) })}</small>
      </td>
      <td className={own.nowrap}>
        <Tag tone={STATUS_TONE[v.status]}>{t(`status.${v.status}`)}</Tag>
        {method ? <><br /><small className={own.sub}>{method}</small></> : null}
      </td>
      <td>
        {channel}
        {v.source || v.campaign ? <><br /><small className={own.sub}>{[v.source, v.campaign].filter(Boolean).join(' · ')}</small></> : null}
      </td>
      <td>
        {v.landingPath ? <span className={styles.code}>{v.landingPath}</span> : '—'}
        {v.signupFrom ? <><br /><small className={own.sub}>{t('list.signupFrom', { from: v.signupFrom })}</small></> : null}
      </td>
      <td className={own.nowrap}>{where || '—'}</td>
      <td className={styles.num}>
        {fmtCount(v.pageViews, locale)}
        <br />
        <small className={own.sub}>{t('list.visits', { count: v.visits })}</small>
      </td>
      <td>
        {v.user ? (
          <Link className={styles.link} href={`/admin/users/${encodeURIComponent(v.user.id)}`}>{v.user.name || v.user.email}</Link>
        ) : (
          '—'
        )}
        {v.signedUpAt ? <><br /><small className={own.sub}>{fmtDateTime(v.signedUpAt, locale, tz)}</small></> : null}
      </td>
    </tr>
  );
}
