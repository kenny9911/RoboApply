'use client';

// FraudQueue — /admin/fraud: 可疑职位待审核 / "Suspicious jobs to review"
// (CN-E-08, F-TRUST-04 cn, F-FEED-12 cn). Admin only; the API enforces it too.
//
//   To review   GoApply posts the warning-sign rules, the AI check or users
//               flagged, each flag with the sentence it rests on; "Not a
//               scam" clears the flags (they never come back for the same
//               sentence), "Confirm scam and take down" archives an indexed
//               post (a user's own import stays theirs, with the warning) and
//               can add the employer to the block list.
//   Cleared / Confirmed   past decisions with who and when.
//   Block list  employers whose open posts are flagged (kept out of feeds and
//               Explore by WP-32); adding one reports how many open posts matched.
// Flags raised by the AI check carry the AI label (GoApply rule §2.2).

import { useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../../v3/primitives/Btn';
import { EmptyState } from '../../../v3/primitives/EmptyState';
import { PageHeader } from '../../../v3/primitives/PageHeader';
import { Tabs, tabPanelProps } from '../../../v3/primitives/Tabs';
import { useAuth } from '../../../../lib/auth/useAuth';
import { apiErrorCode } from '../../../../lib/api/contracts/wire';
import type { FraudQueueItem, FraudQueueStatus } from '../../../../lib/api/contracts/cn/jobs';
import { AiGeneratedBadge } from '../AiGeneratedBadge';
import { parseDate, ruleKey } from './meta';
import { useAddBlacklist, useBlacklist, useFraudQueue, useRemoveBlacklist, useResolveFraud } from './useCnJobs';
import styles from './cnJobs.module.css';

const STATUSES: readonly FraudQueueStatus[] = ['flagged', 'cleared', 'confirmed'];
const METHODS = ['keywords', 'llm', 'blacklist', 'admin'] as const;

export function FraudQueue() {
  const t = useTranslations('jobsCn.admin');
  const tAdmin = useTranslations('admin');
  const { user, status } = useAuth();
  if (status === 'loading') {
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  }
  if (user?.role !== 'admin') {
    return <EmptyState title={`${tAdmin('notAuthorized.title')} ${tAdmin('notAuthorized.titleAccent')}`} sub={tAdmin('notAuthorized.sub')} />;
  }
  return (
    <div className={styles.page} data-testid="admin-fraud">
      <PageHeader title={t('title')} sub={t('sub')} />
      <ReviewList />
      <BlacklistPanel />
    </div>
  );
}

function useDate() {
  const format = useFormatter();
  return (iso: string | null) => {
    const d = parseDate(iso);
    return d ? format.dateTime(d, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  };
}

// ── Review list ──────────────────────────────────────────────────────────

function ReviewList() {
  const t = useTranslations('jobsCn.admin');
  const [tab, setTab] = useState<FraudQueueStatus>('flagged');
  const q = useFraudQueue(tab);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className={styles.cardBox} aria-label={t('title')}>
      <Tabs
        tabs={STATUSES.map((s) => ({ id: s, label: t(`tabs.${s}`) }))}
        value={tab}
        onChange={setTab}
        ariaLabel={t('tabsLabel')}
        idBase="cn-fraud"
      />
      <div {...tabPanelProps('cn-fraud', tab)} className={styles.stack}>
        {q.isLoading ? (
          <p className={styles.muted} aria-busy="true">
            {t('loading')}
          </p>
        ) : q.isError ? (
          <p className={styles.error} role="alert">
            {t('loadError')}
          </p>
        ) : items.length === 0 ? (
          <p className={styles.muted}>{t(`empty.${tab}`)}</p>
        ) : (
          <ul className={styles.items}>
            {items.map((item) => (
              <li key={item.jobId}>
                <ReviewItem item={item} status={tab} />
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage ? (
          <div className={styles.actions}>
            <Btn onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {t('more')}
            </Btn>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReviewItem({ item, status }: { item: FraudQueueItem; status: FraudQueueStatus }) {
  const t = useTranslations('jobsCn.admin');
  const tRules = useTranslations('jobsCn.rules');
  const date = useDate();
  const resolve = useResolveFraud();
  const [note, setNote] = useState('');
  const [blacklist, setBlacklist] = useState(false);
  const own = item.visibility === 'private';
  const idBase = `cn-fraud-${item.jobId}`;

  const submit = (decision: 'clear' | 'confirm') => {
    resolve.mutate({ jobId: item.jobId, decision, note: note.trim() || undefined, blacklistEmployer: decision === 'confirm' && blacklist });
  };

  return (
    <article className={styles.item} aria-labelledby={`${idBase}-h`}>
      <header className={styles.itemHead}>
        <h3 className={styles.h3} id={`${idBase}-h`}>
          {item.title}
        </h3>
        <p className={styles.muted}>
          {t('company', { company: item.companyName })}
          <span aria-hidden="true"> · </span>
          {own ? t('ownImport') : item.sourceName ? t('sourceLine', { sourceName: item.sourceName }) : t('sourceUnknown')}
          <span aria-hidden="true"> · </span>
          {t('flaggedAt', { date: date(item.flaggedAt) })}
          <span aria-hidden="true"> · </span>
          {t('reports', { count: item.reportCount })}
        </p>
      </header>

      {item.flags.length ? (
        <ul className={styles.flags}>
          {item.flags.map((f, i) => (
            <li key={`${f.rule}-${i}`} className={styles.flag}>
              <span className={styles.warningRule}>{tRules(ruleKey(f.rule))}</span>
              {f.method && (METHODS as readonly string[]).includes(f.method) ? (
                <span className={styles.methodTag}>{t(`method.${f.method as (typeof METHODS)[number]}`)}</span>
              ) : null}
              {f.method === 'llm' ? <AiGeneratedBadge /> : null}
              <span className={styles.quote}>{t('evidence', { evidence: f.evidence })}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>{t('noFlags')}</p>
      )}

      {item.review ? (
        <p className={styles.muted}>
          {item.review.byName
            ? t('reviewed', { decision: item.review.decision, by: item.review.byName, date: date(item.review.at) })
            : t('reviewedNoName', { decision: item.review.decision, date: date(item.review.at) })}
          {item.review.note ? ` — ${item.review.note}` : ''}
        </p>
      ) : null}

      {status === 'flagged' ? (
        <div className={styles.resolve}>
          <label className={styles.label} htmlFor={`${idBase}-note`}>
            {t('note')}
          </label>
          <textarea
            id={`${idBase}-note`}
            className={styles.textarea}
            value={note}
            maxLength={500}
            rows={2}
            placeholder={t('notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
          <label className={styles.check}>
            <input type="checkbox" checked={blacklist} onChange={(e) => setBlacklist(e.target.checked)} />
            <span>{t('blacklistEmployer', { company: item.companyName })}</span>
          </label>
          <div className={styles.actions}>
            <Btn onClick={() => submit('clear')} disabled={resolve.isPending || blacklist}>
              {resolve.isPending ? t('saving') : t('clear')}
            </Btn>
            <Btn variant="primary" onClick={() => submit('confirm')} disabled={resolve.isPending}>
              {resolve.isPending ? t('saving') : own ? t('confirmOwnImport') : t('confirm')}
            </Btn>
          </div>
          {resolve.isError ? (
            <p className={styles.error} role="alert">
              {t('resolveError')}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// ── Block list ───────────────────────────────────────────────────────────

function BlacklistPanel() {
  const t = useTranslations('jobsCn.admin.blacklist');
  const tAdmin = useTranslations('jobsCn.admin');
  const date = useDate();
  const list = useBlacklist();
  const add = useAddBlacklist();
  const remove = useRemoveBlacklist();
  const [employerName, setEmployerName] = useState('');
  const [reason, setReason] = useState('');

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!employerName.trim() || !reason.trim()) return;
    add.mutate(
      { employerName: employerName.trim(), reason: reason.trim() },
      {
        onSuccess: () => {
          setEmployerName('');
          setReason('');
        },
      },
    );
  };

  const entries = list.data?.items ?? [];
  return (
    <section className={styles.cardBox} aria-labelledby="cn-blacklist-h">
      <h2 className={styles.h2} id="cn-blacklist-h">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      <form className={styles.form} onSubmit={onAdd}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cn-bl-employer">
            {t('employer')}
          </label>
          <input id="cn-bl-employer" className={styles.input} value={employerName} maxLength={200} onChange={(e) => setEmployerName(e.target.value)} required />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cn-bl-reason">
            {t('reason')}
          </label>
          <input id="cn-bl-reason" className={styles.input} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} required />
        </div>
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={add.isPending || !employerName.trim() || !reason.trim()}>
            {add.isPending ? t('adding') : t('add')}
          </Btn>
        </div>
        {add.isError ? (
          <p className={styles.error} role="alert">
            {apiErrorCode(add.error) === 'conflict' ? t('exists') : t('addError')}
          </p>
        ) : null}
        {add.isSuccess && add.data ? (
          <p className={add.data.matchedOpenJobs === 0 ? styles.error : styles.muted} role="status" data-testid="cn-bl-matched">
            {t('matched', { count: add.data.matchedOpenJobs })}
          </p>
        ) : null}
      </form>
      {list.isError ? (
        <p className={styles.error} role="alert">
          {tAdmin('loadError')}
        </p>
      ) : entries.length === 0 && !list.isLoading ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <ul className={styles.items}>
          {entries.map((e) => (
            <li key={e.id} className={styles.blRow}>
              <div className={styles.blText}>
                <span className={styles.strong}>{e.employerName}</span>
                <span className={styles.muted}>
                  {e.reason} · {t('added', { date: date(e.createdAt) })}
                </span>
              </div>
              <Btn variant="ghost" onClick={() => remove.mutate(e.id)} disabled={remove.isPending} aria-label={t('remove', { employer: e.employerName })}>
                ×
              </Btn>
            </li>
          ))}
        </ul>
      )}
      {remove.isError ? (
        <p className={styles.error} role="alert">
          {t('removeError')}
        </p>
      ) : null}
    </section>
  );
}

export default FraudQueue;
