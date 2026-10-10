'use client';

// components/v3/admin/SystemConsole.tsx — /admin/system (WP-74; ARCHITECTURE.md
// §10.4). Five views, linkable with ?view=:
//   health    ingest, queue (dead items with retry), provider calls, enrichment,
//             AI scores, alert and email sends, Assistant, out-of-credits — per brand,
//             with the metrics past their alert level listed first;
//   costs     cost by SKU × brand × day, with a CSV download;
//   feedback  Assistant thumbs up/down with a redacted excerpt and guard hits;
//   safety    GoApply content-safety readiness and recent events;
//   audit     admin actions (overrides, report decisions, moderation, retries),
//             newest first, read from the admin audit table (INT-08).
// Every number is a live count from the API (refreshed each minute on Health);
// a value the API does not have renders "—".

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { PageHeader } from '../primitives/PageHeader';
import { MetricGrid, type MetricItem } from '../primitives/MetricGrid';
import { Btn } from '../primitives/Btn';
import { Tag } from '../primitives/Tag';
import { Tabs, tabPanelProps } from '../primitives/Tabs';
import { IconRefresh, IconUpload } from '../primitives/Iconset';
import {
  useAdminAudit,
  useAdminCosts,
  useCopilotFeedback,
  useRetryWorkItem,
  useSafety,
  useSystemStatus,
  useWorkItems,
} from '../../../hooks/useAdmin';
import { costsCsvUrl, type AlertHit, type BrandHealth, type SystemStatusResponse } from '../../../lib/api/admin';
import { AiGeneratedBadge } from '../../features/market';
import { AdminGate } from './AdminGate';
import { AdminNav } from './AdminNav';
import { fmtCount, fmtLongDate, fmtPercent } from './format';
import { useViewParam } from './viewParam';
import styles from './console.module.css';

export const SYSTEM_VIEWS = ['health', 'costs', 'feedback', 'safety', 'audit'] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];
type T = ReturnType<typeof useTranslations>;

/** USD with up to four decimals (model costs are often fractions of a cent). */
export function fmtUsd(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function usage(used: number, limit: number | null, locale: string, t: T): string {
  return limit === null ? t('usage.unmetered', { used: fmtCount(used, locale) }) : t('usage.ofLimit', { used: fmtCount(used, locale), limit: fmtCount(limit, locale) });
}

export function SystemConsole() {
  return (
    <AdminGate>
      <SystemConsoleInner />
    </AdminGate>
  );
}

function SystemConsoleInner() {
  const t = useTranslations('admin.console.system');
  const [view, setView] = useViewParam<SystemView>(SYSTEM_VIEWS, 'health');
  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      <AdminNav />
      <Tabs idBase="admin-system" ariaLabel={t('title')} value={view} onChange={setView} tabs={SYSTEM_VIEWS.map((id) => ({ id, label: t(`views.${id}`) }))} />
      <section {...tabPanelProps('admin-system', view)}>
        {view === 'health' && <HealthView />}
        {view === 'costs' && <CostsView />}
        {view === 'feedback' && <FeedbackView />}
        {view === 'safety' && <SafetyView />}
        {view === 'audit' && <AuditView />}
      </section>
    </div>
  );
}

// ── Health ───────────────────────────────────────────────────────────────

function alertText(hit: AlertHit, t: T, locale: string): string {
  const value = hit.key === 'assistant_budget' ? fmtUsd(hit.value, locale) : fmtCount(hit.value, locale);
  const level = hit.key === 'assistant_budget' ? fmtUsd(hit.level, locale) : fmtCount(hit.level, locale);
  return t(`alerts.${hit.key}`, { brand: hit.brand ?? '', subject: hit.subject ?? '', value, level });
}

function HealthView() {
  const t = useTranslations('admin.console.system');
  const locale = useLocale();
  const q = useSystemStatus();
  if (q.isError) return <ErrorPanel retry={() => void q.refetch()} />;
  if (!q.data) return <p className={styles.muted} aria-busy="true">{t('loading')}</p>;
  const d = q.data;
  return (
    <div className={styles.page}>
      {d.alerts.length ? (
        <div className={styles.alertBox} role="status">
          <strong>{t('alerts.title', { count: d.alerts.length })}</strong>
          <ul>{d.alerts.map((a, i) => <li key={`${a.key}:${a.brand}:${a.subject}:${i}`}>{alertText(a, t, locale)}</li>)}</ul>
          <p className={styles.muted}>{t('alerts.email')}</p>
        </div>
      ) : (
        <p className={styles.okBox} role="status">{t('alerts.none')}</p>
      )}
      <div className={styles.actions}>
        <p className={styles.muted}>{t('asOf', { time: fmtLongDate(d.asOf, locale), day: d.dayKey })}</p>
        <Btn variant="ghost" icon={<IconRefresh size={15} />} disabled={q.isFetching} onClick={() => void q.refetch()}>{t(q.isFetching ? 'refreshing' : 'refresh')}</Btn>
      </div>
      {d.brands.map((b) => <BrandPanel key={b.brand} health={b} alerts={d.alerts} />)}
      <QueuePanel status={d} />
      <ProvidersPanel status={d} />
    </div>
  );
}

function BrandPanel({ health: b, alerts }: { health: BrandHealth; alerts: AlertHit[] }) {
  const t = useTranslations('admin.console.system');
  const locale = useLocale();
  const hot = new Set(alerts.filter((a) => a.brand === b.brand).map((a) => a.key));
  const mark = (key: AlertHit['key'], text: string) => (hot.has(key) ? <span className={styles.metricAlert}>{text}</span> : text);
  const items: MetricItem[] = [
    { label: t('metrics.newJobs'), value: mark('ingest_new_low', fmtCount(b.ingest.newJobsToday, locale)), detail: t('metrics.newJobsDetail', { avg: fmtCount(b.ingest.newJobs7dAvg, locale) }) },
    { label: t('metrics.queriesDue'), value: fmtCount(b.ingest.due, locale), detail: t('metrics.queriesDueDetail', { overdue: fmtCount(b.ingest.overdue, locale), failing: fmtCount(b.ingest.failing, locale) }) },
    { label: t('metrics.enrichBacklog'), value: fmtCount(b.ingest.enrichBacklog, locale), detail: t('metrics.enrichBacklogDetail', { share: b.ingest.enrichedShare === null ? '—' : fmtPercent(b.ingest.enrichedShare * 100, locale), open: fmtCount(b.ingest.openJobs, locale) }) },
    { label: t('metrics.enrichCalls'), value: mark('enrich_budget', usage(b.ingest.enrichBudget.used, b.ingest.enrichBudget.limit, locale, t)), detail: t('metrics.enrichCallsDetail') },
    { label: t('metrics.scores'), value: mark('score_budget', usage(b.precompute.used, b.precompute.limit, locale, t)), detail: t('metrics.scoresDetail') },
    { label: t('metrics.alertEmails'), value: fmtCount(b.alerts.sent, locale), detail: t('metrics.alertEmailsDetail', { failed: fmtCount(b.alerts.failed, locale) }) },
    { label: t('metrics.emailFailures'), value: mark('email_failures', fmtCount(b.email.failed, locale)), detail: t('metrics.emailFailuresDetail', { sent: fmtCount(b.email.sent, locale) }) },
    { label: t('metrics.assistant'), value: mark('assistant_budget', `${fmtUsd(b.copilot.costUsd, locale)} / ${fmtUsd(b.copilot.budgetUsd, locale)}`), detail: t('metrics.assistantDetail', { turns: fmtCount(b.copilot.turns, locale), hits: fmtCount(b.copilot.guardHits, locale) }) },
  ];
  return (
    <section className={styles.panel} aria-labelledby={`brand-${b.brand}`}>
      <div className={styles.panelHead}>
        <div>
          <h2 id={`brand-${b.brand}`}>{t('brandTitle', { brand: b.brand, market: b.market })}</h2>
          <p>{t('brandSub')}</p>
        </div>
        <Link className={styles.link} href="/admin/system?view=feedback">{t('feedbackLink')}</Link>
      </div>
      <MetricGrid className={styles.metrics} label={t('brandTitle', { brand: b.brand, market: b.market })} items={items} />
      {b.email.failedByTemplate.length > 0 && (
        <p className={styles.muted}>{t('failedTemplates', { list: b.email.failedByTemplate.map((f) => `${f.template} (${f.count})`).join(', ') })}</p>
      )}
      <div>
        <h3 className={styles.muted}>{t('exhaustion.title')}</h3>
        {b.creditExhaustion === null ? (
          <p className={styles.muted}>{t('exhaustion.notRecorded')}</p>
        ) : b.creditExhaustion.length === 0 ? (
          <p className={styles.muted}>{t('exhaustion.none')}</p>
        ) : (
          <div className={styles.tags}>
            {b.creditExhaustion.map((e) => <Tag key={e.bucket}>{t('exhaustion.item', { bucket: e.bucket, count: e.count })}</Tag>)}
          </div>
        )}
      </div>
    </section>
  );
}

function QueuePanel({ status }: { status: SystemStatusResponse }) {
  const t = useTranslations('admin.console.system');
  const locale = useLocale();
  const dead = useWorkItems({ status: 'dead' });
  const retry = useRetryWorkItem();
  const [retried, setRetried] = useState<string | null>(null);
  return (
    <section className={styles.panel} aria-labelledby="queue-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="queue-title">{t('queue.title')}</h2>
          <p>{t('queue.sub', { dead: fmtCount(status.queue.deadTotal, locale) })}</p>
        </div>
      </div>
      {status.queue.kinds.length === 0 ? (
        <p className={styles.muted}>{t('queue.empty')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('queue.kind')}</th>
                <th scope="col" className={styles.num}>{t('queue.queued')}</th>
                <th scope="col" className={styles.num}>{t('queue.leased')}</th>
                <th scope="col" className={styles.num}>{t('queue.failed')}</th>
                <th scope="col" className={styles.num}>{t('queue.dead')}</th>
                <th scope="col">{t('queue.oldest')}</th>
              </tr>
            </thead>
            <tbody>
              {status.queue.kinds.map((k) => (
                <tr key={k.kind}>
                  <td><span className={styles.code}>{k.kind}</span></td>
                  <td className={styles.num}>{fmtCount(k.queued, locale)}</td>
                  <td className={styles.num}>{fmtCount(k.leased, locale)}</td>
                  <td className={styles.num}>{fmtCount(k.failed, locale)}</td>
                  <td className={styles.num}>{fmtCount(k.dead, locale)}</td>
                  <td>{fmtLongDate(k.oldestQueuedAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className={styles.muted}>{t('queue.deadTitle')}</h3>
      {retry.isError && <p className={styles.error} role="alert">{t('queue.retryFailed')}</p>}
      {retried && <p className={styles.success} role="status">{t('queue.retried')}</p>}
      {dead.isError ? (
        <ErrorPanel retry={() => void dead.refetch()} />
      ) : !dead.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : dead.data.items.length === 0 ? (
        <p className={styles.muted}>{t('queue.noDead')}</p>
      ) : (
        <ul className={styles.list}>
          {dead.data.items.map((w) => (
            <li key={w.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <h3><span className={styles.code}>{w.kind}</span></h3>
                  <p>{t('queue.itemMeta', { attempts: w.attempts, max: w.maxAttempts, brand: w.brand ?? '—', at: fmtLongDate(w.updatedAt, locale) })}</p>
                </div>
                <Btn
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(w.id, { onSuccess: () => setRetried(w.id) })}
                  aria-label={t('queue.retryLabel', { kind: w.kind })}
                >
                  {t('queue.retry')}
                </Btn>
              </div>
              {w.lastError && <p className={styles.quote}>{w.lastError}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProvidersPanel({ status }: { status: SystemStatusResponse }) {
  const t = useTranslations('admin.console.system');
  const locale = useLocale();
  return (
    <section className={styles.panel} aria-labelledby="providers-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="providers-title">{t('providers.title')}</h2>
          <p>{t('providers.sub', { day: status.dayKey })}</p>
        </div>
      </div>
      {status.providers.length === 0 ? (
        <p className={styles.muted}>{t('providers.empty')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('providers.provider')}</th>
                <th scope="col" className={styles.num}>{t('providers.calls')}</th>
                <th scope="col" className={styles.num}>{t('providers.returned')}</th>
                <th scope="col" className={styles.num}>{t('providers.new')}</th>
                <th scope="col" className={styles.num}>{t('providers.errors')}</th>
              </tr>
            </thead>
            <tbody>
              {status.providers.map((p) => (
                <tr key={p.provider}>
                  <td>{p.provider}</td>
                  <td className={styles.num}>{usage(p.calls, p.limit, locale, t)}</td>
                  <td className={styles.num}>{fmtCount(p.jobsReturned, locale)}</td>
                  <td className={styles.num}>{fmtCount(p.jobsNew, locale)}</td>
                  <td className={styles.num}>{fmtCount(p.errors, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Costs ────────────────────────────────────────────────────────────────

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function CostsView() {
  const t = useTranslations('admin.console.costs');
  const locale = useLocale();
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [brand, setBrand] = useState<'' | 'roboapply' | 'goapply'>('');
  const query = { from, to, ...(brand ? { brand } : {}) };
  const q = useAdminCosts(query);
  return (
    <section className={styles.panel} aria-labelledby="costs-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="costs-title">{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
        <Btn as="a" href={costsCsvUrl(query)} variant="ghost" icon={<IconUpload size={15} />}>{t('csv')}</Btn>
      </div>
      <div className={styles.filters}>
        <label className={styles.field}>{t('from')}<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className={styles.field}>{t('to')}<input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <label className={styles.field}>
          {t('brand')}
          <select value={brand} onChange={(e) => setBrand(e.target.value as typeof brand)}>
            <option value="">{t('allBrands')}</option>
            <option value="roboapply">roboapply</option>
            <option value="goapply">goapply</option>
          </select>
        </label>
      </div>
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : q.data.rows.length === 0 ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <>
          <p className={styles.muted}>{t('totals', { cost: fmtUsd(q.data.totals.costUsd, locale), rows: fmtCount(q.data.totals.rows, locale), from: q.data.from, to: q.data.to })}</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('day')}</th>
                  <th scope="col">{t('sku')}</th>
                  <th scope="col">{t('brand')}</th>
                  <th scope="col" className={styles.num}>{t('cost')}</th>
                  <th scope="col" className={styles.num}>{t('units')}</th>
                  <th scope="col" className={styles.num}>{t('rows')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={`${r.day}:${r.sku}:${r.brand}`}>
                    <td>{r.day}</td>
                    <td>
                      <span className={styles.code}>{r.sku}</span>
                      {r.platform && <> <Tag>{t('platform')}</Tag></>}
                    </td>
                    <td>{r.brand}</td>
                    <td className={styles.num}>{fmtUsd(r.costUsd, locale)}{r.unpricedRows > 0 && <><br /><small>{t('unpriced', { count: r.unpricedRows })}</small></>}</td>
                    <td className={styles.num}>{fmtCount(r.units, locale)}</td>
                    <td className={styles.num}>{fmtCount(r.rows, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ── Assistant feedback ───────────────────────────────────────────────────

function FeedbackView() {
  const t = useTranslations('admin.console.feedback');
  const locale = useLocale();
  const [value, setValue] = useState<'' | 'up' | 'down'>('down');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const q = useCopilotFeedback({ ...(value ? { value } : {}), ...(cursor ? { cursor } : {}) });
  return (
    <section className={styles.panel} aria-labelledby="feedback-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="feedback-title">{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
      </div>
      <div className={styles.filters}>
        <label className={styles.field}>
          {t('filter')}
          <select value={value} onChange={(e) => { setCursor(undefined); setValue(e.target.value as typeof value); }}>
            <option value="down">{t('down')}</option>
            <option value="up">{t('up')}</option>
            <option value="">{t('all')}</option>
          </select>
        </label>
      </div>
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : q.data.items.length === 0 ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <ul className={styles.list}>
          {q.data.items.map((f) => (
            <li key={f.messageId} className={styles.card}>
              <div className={styles.cardHead}>
                <div className={styles.tags}>
                  <Tag tone={f.value === 'down' ? 'warn' : 'default'}>{t(f.value)}</Tag>
                  <Tag>{f.guardHits === null ? t('guardUnknown') : t('guardHits', { count: f.guardHits })}</Tag>
                </div>
                <p className={styles.muted}>{fmtLongDate(f.createdAt, locale)}</p>
              </div>
              {f.note && <p className={styles.quote}>{t('reason', { note: f.note })}</p>}
              {f.excerpt.map((m, i) => (
                <div key={i} className={styles.turn}>
                  <b>{t(`role.${m.role}`)}</b>
                  <span>{m.text}{m.role === 'assistant' && <> <AiGeneratedBadge /></>}</span>
                </div>
              ))}
              <Link className={styles.link} href={`/admin/users/${encodeURIComponent(f.userId)}`}>{t('viewUser')}</Link>
            </li>
          ))}
        </ul>
      )}
      {q.data?.cursor && <Btn variant="ghost" onClick={() => setCursor(q.data!.cursor ?? undefined)}>{t('more')}</Btn>}
      {cursor && <Btn variant="ghost" onClick={() => setCursor(undefined)}>{t('first')}</Btn>}
    </section>
  );
}

// ── Content safety ───────────────────────────────────────────────────────

function SafetyView() {
  const t = useTranslations('admin.console.safety');
  const locale = useLocale();
  const [verdict, setVerdict] = useState<'' | 'review' | 'block' | 'error'>('');
  const q = useSafety(verdict ? { verdict } : {});
  return (
    <section className={styles.panel} aria-labelledby="safety-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="safety-title">{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
      </div>
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : (
        <>
          <MetricGrid
            className={styles.metrics}
            label={t('readiness')}
            items={[
              { label: t('provider'), value: q.data.readiness.provider, detail: t(q.data.readiness.usable ? 'usable' : 'notUsable') },
              { label: t('cn1'), value: t(q.data.readiness.cn1Ready ? 'yes' : 'no'), detail: t('keywordList', { list: q.data.readiness.keywordList }) },
              ...q.data.last7d.map((v) => ({ label: t('last7d', { verdict: v.verdict }), value: fmtCount(v.count, locale) })),
            ]}
          />
          {q.data.readiness.problems.length > 0 && (
            <div className={styles.alertBox}><strong>{t('problems')}</strong><ul>{q.data.readiness.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
          )}
          <div className={styles.filters}>
            <label className={styles.field}>
              {t('verdict')}
              <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
                <option value="">{t('allVerdicts')}</option>
                <option value="block">block</option>
                <option value="review">review</option>
                <option value="error">error</option>
              </select>
            </label>
          </div>
          {q.data.items.length === 0 ? (
            <p className={styles.muted}>{t('empty')}</p>
          ) : (
            <ul className={styles.list}>
              {q.data.items.map((e) => (
                <li key={e.id} className={styles.card}>
                  <div className={styles.cardHead}>
                    <div className={styles.tags}>
                      <Tag tone={e.verdict === 'block' ? 'warn' : 'default'}>{e.verdict}</Tag>
                      <Tag>{e.surface}</Tag>
                      <Tag>{e.direction}</Tag>
                      <Tag>{e.brand}</Tag>
                    </div>
                    <p className={styles.muted}>{fmtLongDate(e.createdAt, locale)}</p>
                  </div>
                  {(e.reason || e.labels.length > 0) && <p className={styles.muted}>{[e.reason, ...e.labels].filter(Boolean).join(' · ')}</p>}
                  {e.excerpt && <p className={styles.quote}>{e.excerpt}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function ErrorPanel({ retry }: { retry: () => void }) {
  const t = useTranslations('admin.console');
  return (
    <div className={styles.alertBox} role="alert">
      <strong>{t('error')}</strong>
      <div className={styles.actions}><Btn onClick={retry}>{t('retry')}</Btn></div>
    </div>
  );
}

// ── Admin actions (RAAdminAuditLog) ──────────────────────────────────────

/** Actions the filter offers (ADMIN_AUDIT_EVENTS, server/src/features/admin/contract.ts). Other areas' events still list under "All". */
export const AUDIT_ACTIONS = ['admin_override_created', 'admin_override_deleted', 'admin_report_resolved', 'admin_work_item_retried', 'admin_referral_moderated', 'admin_invite_reward_reviewed'] as const;

function AuditView() {
  const t = useTranslations('admin.console.audit');
  const locale = useLocale();
  const [action, setAction] = useState<'' | (typeof AUDIT_ACTIONS)[number]>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const q = useAdminAudit({ ...(action ? { eventType: action } : {}), ...(cursor ? { cursor } : {}) });
  const actionLabel = (eventType: string) => (t.has(`action.${eventType}`) ? t(`action.${eventType}`) : eventType);
  const time = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <section className={styles.panel} aria-labelledby="audit-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="audit-title">{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
      </div>
      <div className={styles.filters}>
        <label className={styles.field}>
          {t('filter')}
          <select value={action} onChange={(e) => { setCursor(undefined); setAction(e.target.value as typeof action); }}>
            <option value="">{t('all')}</option>
            {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{t(`action.${a}`)}</option>)}
          </select>
        </label>
      </div>
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : q.data.items.length === 0 ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('when')}</th>
                <th scope="col">{t('what')}</th>
                <th scope="col">{t('admin')}</th>
                <th scope="col">{t('about')}</th>
                <th scope="col">{t('details')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((row) => (
                <tr key={row.id}>
                  <td>{time(row.createdAt)}</td>
                  <td>{actionLabel(row.eventType)}</td>
                  <td><Link className={styles.link} href={`/admin/users/${encodeURIComponent(row.adminId)}`} aria-label={t('adminPage', { id: row.adminId })}><span className={styles.code}>{row.adminId}</span></Link></td>
                  <td>
                    {row.subjectUserId ? (
                      <Link className={styles.link} href={`/admin/users/${encodeURIComponent(row.subjectUserId)}`} aria-label={t('aboutPage', { id: row.subjectUserId })}><span className={styles.code}>{row.subjectUserId}</span></Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={styles.wrap}>{row.details || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data?.cursor && <Btn variant="ghost" onClick={() => setCursor(q.data!.cursor ?? undefined)}>{t('more')}</Btn>}
      {cursor && <Btn variant="ghost" onClick={() => setCursor(undefined)}>{t('first')}</Btn>}
    </section>
  );
}
