'use client';

// components/v3/admin/ReportsConsole.tsx — /admin/reports, "Reports to review"
// (WP-74; PRODUCT F-TRUST-04). Views, linkable with ?view=:
//   jobs       user job reports (scam, closed, wrong data …) and the
//              international scam signals (WP-17), with Close / Restore;
//   referrals  GoApply referral codes waiting for a first check or hidden by
//              reports (WP-54), with Approve / Reject (GoApply only);
//   privacy    personal-data requests with their legal due dates (WP-13).
// GoApply jobs reported only for fraud reasons are decided on /admin/fraud
// (WP-41); their cards link there instead of offering a decision.

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { PageHeader } from '../primitives/PageHeader';
import { Btn } from '../primitives/Btn';
import { Tag } from '../primitives/Tag';
import { Tabs, tabPanelProps } from '../primitives/Tabs';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import {
  useModerateReferral,
  usePiRequests,
  useReferralQueue,
  useReports,
  useResolveReport,
  useUpdatePiRequest,
} from '../../../hooks/useAdmin';
import type { ReportItem } from '../../../lib/api/admin';
import { AdminGate } from './AdminGate';
import { AdminNav } from './AdminNav';
import { ErrorPanel } from './SystemConsole';
import { fmtCount, fmtLongDate, fmtShortDate } from './format';
import { useViewParam } from './viewParam';
import styles from './console.module.css';

const ALL_VIEWS = ['jobs', 'referrals', 'privacy'] as const;
type ReportsView = (typeof ALL_VIEWS)[number];

export function ReportsConsole() {
  return (
    <AdminGate>
      <ReportsConsoleInner />
    </AdminGate>
  );
}

function ReportsConsoleInner() {
  const t = useTranslations('admin.console.reports');
  const brand = useBrandId();
  const views = ALL_VIEWS.filter((v) => v !== 'referrals' || brand === 'goapply');
  const [view, setView] = useViewParam<ReportsView>(views, 'jobs');
  const current = views.includes(view) ? view : 'jobs';
  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      <AdminNav />
      <Tabs idBase="admin-reports" ariaLabel={t('title')} value={current} onChange={setView} tabs={views.map((id) => ({ id, label: t(`views.${id}`) }))} />
      <section {...tabPanelProps('admin-reports', current)}>
        {current === 'jobs' && <JobReports />}
        {current === 'referrals' && <ReferralCodes />}
        {current === 'privacy' && <DataRequests />}
      </section>
    </div>
  );
}

// ── Job reports ──────────────────────────────────────────────────────────

function JobReports() {
  const t = useTranslations('admin.console.reports');
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [market, setMarket] = useState<'' | 'intl' | 'cn'>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const q = useReports({ status, ...(market ? { market } : {}), ...(cursor ? { cursor } : {}) });
  return (
    <div className={styles.panel}>
      <div className={styles.filters}>
        <label className={styles.field}>
          {t('status')}
          <select value={status} onChange={(e) => { setCursor(undefined); setStatus(e.target.value as typeof status); }}>
            <option value="open">{t('statusOpen')}</option>
            <option value="resolved">{t('statusResolved')}</option>
          </select>
        </label>
        <label className={styles.field}>
          {t('market')}
          <select value={market} onChange={(e) => { setCursor(undefined); setMarket(e.target.value as typeof market); }}>
            <option value="">{t('allMarkets')}</option>
            <option value="intl">{t('marketIntl')}</option>
            <option value="cn">{t('marketCn')}</option>
          </select>
        </label>
      </div>
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : q.data.items.length === 0 ? (
        <p className={styles.muted}>{t(status === 'open' ? 'emptyOpen' : 'emptyResolved')}</p>
      ) : (
        <ul className={styles.list}>
          {q.data.items.map((item) => <ReportCard key={item.id} item={item} />)}
        </ul>
      )}
      {q.data?.cursor && <Btn variant="ghost" onClick={() => setCursor(q.data!.cursor ?? undefined)}>{t('more')}</Btn>}
      {cursor && <Btn variant="ghost" onClick={() => setCursor(undefined)}>{t('first')}</Btn>}
    </div>
  );
}

function ReportCard({ item }: { item: ReportItem }) {
  const t = useTranslations('admin.console.reports');
  const locale = useLocale();
  const resolve = useResolveReport();
  const [note, setNote] = useState('');
  const noteId = `report-note-${item.id}`;
  const decide = (decision: 'close' | 'restore') => resolve.mutate({ id: item.id, decision, ...(note.trim() ? { note: note.trim() } : {}) });
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h3>{item.title}</h3>
          <p>{[item.companyName, item.sourceName, item.market === 'cn' ? t('marketCn') : t('marketIntl')].filter(Boolean).join(' · ')}</p>
        </div>
        <div className={styles.tags}>
          <Tag tone={item.state === 'closed' ? 'warn' : 'default'}>{t(item.state === 'closed' ? 'stateClosed' : 'stateOpen')}</Tag>
          {item.closeReason && <Tag>{t('closeReason', { reason: item.closeReason })}</Tag>}
        </div>
      </div>
      {item.reportCount > 0 && (
        <>
          <p className={styles.muted}>
            {t('reportSummary', { count: item.reportCount, first: fmtShortDate(item.firstReportedAt, locale), last: fmtShortDate(item.lastReportedAt, locale) })}
          </p>
          <div className={styles.tags}>
            {item.reasons.map((r) => <Tag key={r.reason}>{t('reasonCount', { reason: t.has(`reason.${r.reason}`) ? t(`reason.${r.reason}`) : r.reason, count: r.count })}</Tag>)}
          </div>
        </>
      )}
      {item.notes.map((n, i) => <p key={i} className={styles.quote}>{n}</p>)}
      {item.scamSignals.length > 0 && (
        <div>
          <p className={styles.muted}>{t('signalsTitle')}</p>
          {item.scamSignals.map((s, i) => (
            <p key={`${s.rule}:${i}`} className={styles.quote}>
              <b>{t.has(`signal.${s.rule}`) ? t(`signal.${s.rule}`) : s.rule}</b> {t('signalQuote', { quote: s.evidence })}
            </p>
          ))}
        </div>
      )}
      {item.lastDecision && (
        <p className={styles.muted}>
          {t('lastDecision', { decision: t(`decision.${item.lastDecision.decision}`), at: fmtLongDate(item.lastDecision.at, locale) })}
          {item.lastDecision.note ? ` · ${item.lastDecision.note}` : ''}
        </p>
      )}
      {item.applyUrl && <a className={styles.link} href={item.applyUrl} target="_blank" rel="noopener noreferrer">{t('openPosting')}</a>}
      {item.reviewElsewhere ? (
        <Link className={styles.link} href="/admin/fraud">{t('reviewElsewhere')}</Link>
      ) : (
        <>
          <label className={styles.field} htmlFor={noteId}>
            {t('note')}
            <input id={noteId} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className={styles.actions}>
            <Btn variant="primary" disabled={resolve.isPending} onClick={() => decide('close')}>{t('close')}</Btn>
            <Btn disabled={resolve.isPending} onClick={() => decide('restore')}>{t('restore')}</Btn>
            {resolve.isError && <p className={styles.error} role="alert">{t('decideFailed')}</p>}
            {resolve.isSuccess && <p className={styles.success} role="status">{t('decided')}</p>}
          </div>
          <p className={styles.muted}>{t('decisionHelp')}</p>
        </>
      )}
    </li>
  );
}

// ── Referral codes (GoApply) ─────────────────────────────────────────────

const REJECT_REASONS = ['not_a_referral_code', 'paid_or_traded', 'contact_details', 'duplicate', 'expired', 'other'] as const;

function ReferralCodes() {
  const t = useTranslations('admin.console.referrals');
  const locale = useLocale();
  const q = useReferralQueue();
  const moderate = useModerateReferral();
  const [reasons, setReasons] = useState<Record<string, (typeof REJECT_REASONS)[number]>>({});
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2>{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
      </div>
      {moderate.isError && <p className={styles.error} role="alert">{t('failed')}</p>}
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : q.data.items.length === 0 ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <ul className={styles.list}>
          {q.data.items.map((c) => {
            const reason = reasons[c.id] ?? 'not_a_referral_code';
            return (
              <li key={c.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h3>{c.company}</h3>
                    <p>{[c.programme, c.expiresAt ? t('expires', { date: fmtShortDate(c.expiresAt, locale) }) : null, t('shared', { date: fmtShortDate(c.sharedAt, locale) })].filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className={styles.tags}>
                    <Tag>{t(`queue.${c.queue}`)}</Tag>
                    {c.reportCount > 0 && <Tag tone="warn">{t('reports', { count: c.reportCount })}</Tag>}
                  </div>
                </div>
                <p><span className={styles.code}>{c.code}</span></p>
                {c.note && <p className={styles.quote}>{c.note}</p>}
                {c.reports.map((r, i) => (
                  <p key={i} className={styles.muted}>{t('reportLine', { reason: r.reason, date: fmtShortDate(r.createdAt, locale) })}{r.note ? ` · ${r.note}` : ''}</p>
                ))}
                <div className={styles.actions}>
                  <Btn variant="primary" disabled={moderate.isPending} onClick={() => moderate.mutate({ id: c.id, decision: 'approve' })}>{t('approve')}</Btn>
                  <label className={styles.field}>
                    {t('rejectReason')}
                    <select value={reason} onChange={(e) => setReasons((m) => ({ ...m, [c.id]: e.target.value as (typeof REJECT_REASONS)[number] }))}>
                      {REJECT_REASONS.map((r) => <option key={r} value={r}>{t(`rejectReasons.${r}`)}</option>)}
                    </select>
                  </label>
                  <Btn disabled={moderate.isPending} onClick={() => moderate.mutate({ id: c.id, decision: 'reject', reason })}>{t('reject')}</Btn>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Personal-data requests ───────────────────────────────────────────────

const PI_STATUSES = ['open', 'in_progress', 'done', 'rejected'] as const;

function DataRequests() {
  const t = useTranslations('admin.console.privacy');
  const locale = useLocale();
  const [filter, setFilter] = useState<'overdue' | (typeof PI_STATUSES)[number] | ''>('open');
  const q = usePiRequests(filter === 'overdue' ? { overdue: 'true' } : filter ? { status: filter } : {});
  const update = useUpdatePiRequest();
  const [notes, setNotes] = useState<Record<string, string>>({});
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2>{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
      </div>
      <div className={styles.filters}>
        <label className={styles.field}>
          {t('filter')}
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="overdue">{t('overdue')}</option>
            {PI_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
            <option value="">{t('all')}</option>
          </select>
        </label>
      </div>
      {update.isError && <p className={styles.error} role="alert">{t('failed')}</p>}
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : q.data.items.length === 0 ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <ul className={styles.list}>
          {q.data.items.map((r) => {
            const noteId = `pi-note-${r.id}`;
            return (
              <li key={r.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h3>{t(`kind.${r.kind}`)}</h3>
                    <p>{t('meta', { brand: r.brand, created: fmtShortDate(r.createdAt, locale), due: fmtShortDate(r.dueAt, locale) })}</p>
                  </div>
                  <div className={styles.tags}>
                    <Tag>{t(`status.${r.status}`)}</Tag>
                    {r.overdue && <Tag tone="warn">{t('overdueTag')}</Tag>}
                  </div>
                </div>
                {r.userNote && <p className={styles.quote}>{r.userNote}</p>}
                {r.handlingNotes.map((n, i) => <p key={i} className={styles.muted}>{t('handled', { at: fmtLongDate(n.at, locale), note: n.note })}</p>)}
                {r.userId && <Link className={styles.link} href={`/admin/users/${encodeURIComponent(r.userId)}`}>{t('viewUser')}</Link>}
                <label className={styles.field} htmlFor={noteId}>
                  {t('note')}
                  <input id={noteId} value={notes[r.id] ?? ''} maxLength={2000} onChange={(e) => setNotes((m) => ({ ...m, [r.id]: e.target.value }))} />
                </label>
                <div className={styles.actions}>
                  {PI_STATUSES.filter((s) => s !== r.status).map((s) => (
                    <Btn key={s} disabled={update.isPending} onClick={() => update.mutate({ id: r.id, body: { status: s, ...(notes[r.id]?.trim() ? { note: notes[r.id]!.trim() } : {}) } })}>
                      {t(`set.${s}`)}
                    </Btn>
                  ))}
                  <Btn variant="ghost" disabled={update.isPending || !notes[r.id]?.trim()} onClick={() => update.mutate({ id: r.id, body: { note: notes[r.id]!.trim() } })}>{t('addNote')}</Btn>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.muted}>{t('dueRule', { count: fmtCount(q.data?.items.length ?? 0, locale) })}</p>
    </div>
  );
}
