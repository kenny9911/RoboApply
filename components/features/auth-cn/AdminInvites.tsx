'use client';

// AdminInvites — /admin/invites: GoApply invite codes, asked for at sign-up
// only when the operator sets CN_SIGNUP_MODE=invite (open by default, D5;
// CN_TW_LAUNCH_PLAN.md §3; TASK_PLAN.md WP-11). Codes are created for the
// site the admin is on, shown once (stored hashed), and listed with their
// uses and status. Counts come from the invite rows themselves.

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';

import { adminCreateInvites, adminListInvites, type InvitePage } from '../../../lib/api/authCn';
import type { InviteStatus, InviteView } from '../../../lib/api/contracts/auth-cn';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { errorMessage } from './shared';
import styles from './AuthCn.module.css';

const STATUSES: InviteStatus[] = ['active', 'used', 'expired'];

export function AdminInvites() {
  const t = useTranslations('authCn');
  const locale = useLocale();
  const { user, status } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'admin';

  const [filter, setFilter] = useState<InviteStatus | ''>('');
  const [extra, setExtra] = useState<InviteView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [count, setCount] = useState(10);
  const [maxUses, setMaxUses] = useState(1);
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<InviteView[]>([]);
  const [copied, setCopied] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const listKey = ['admin', 'authCn', 'invites', filter] as const;
  const list = useQuery<InvitePage>({
    queryKey: listKey,
    queryFn: async () => {
      const page = await adminListInvites(filter ? { status: filter } : {});
      setExtra([]);
      setCursor(page.cursor);
      return page;
    },
    enabled: isAdmin,
  });

  const create = useMutation({
    mutationFn: () =>
      adminCreateInvites({
        count,
        maxUses,
        ...(expiresOn ? { expiresAt: new Date(`${expiresOn}T23:59:59`).toISOString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async (res) => {
      setCreated(res.items);
      setCopied(false);
      setFormError(null);
      await qc.invalidateQueries({ queryKey: ['admin', 'authCn', 'invites'] });
    },
    onError: (err) => setFormError(errorMessage(err, t)),
  });

  const more = useMutation({
    mutationFn: () => adminListInvites({ ...(filter ? { status: filter } : {}), ...(cursor ? { cursor } : {}) }),
    onSuccess: (page) => {
      setExtra((prev) => [...prev, ...page.items]);
      setCursor(page.cursor);
    },
  });

  if (status === 'loading') return <p aria-busy="true">{t('change.loading')}</p>;
  if (!isAdmin) return <EmptyState title={t('admin.notAuthorized')} />;

  const rows = [...(list.data?.items ?? []), ...extra];
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale) : t('admin.never'));

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate();
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(created.map((c) => c.code).filter(Boolean).join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.admin}>
      <PageHeader eyebrow={t('admin.eyebrow')} title={t('admin.title')} sub={t('admin.subtitle')} />

      <section className={styles.panel} aria-labelledby="invites-create">
        <h2 id="invites-create" className={styles.sectionTitle}>
          {t('admin.createTitle')}
        </h2>
        <form className={styles.form} onSubmit={onCreate}>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.label}>{t('admin.count')}</span>
              <span className={styles.inputWrap}>
                <input className={styles.input} type="number" min={1} max={500} value={count} onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('admin.maxUses')}</span>
              <span className={styles.inputWrap}>
                <input className={styles.input} type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('admin.expiresAt')}</span>
              <span className={styles.inputWrap}>
                <input className={styles.input} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('admin.note')}</span>
              <span className={styles.inputWrap}>
                <input className={styles.input} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
              </span>
            </label>
          </div>
          {formError ? (
            <p className={styles.error} role="alert">
              {formError}
            </p>
          ) : null}
          <div className={styles.row}>
            <Btn type="submit" variant="primary" disabled={create.isPending} aria-busy={create.isPending}>
              {create.isPending ? t('admin.creating') : t('admin.create')}
            </Btn>
          </div>
        </form>
        {created.length ? (
          <div className={styles.form} role="status">
            <p className={styles.notice}>{t('admin.newCodes')}</p>
            <ul className={styles.codes}>
              {created.map((c) => (
                <li key={c.id} className={styles.code}>
                  {c.code}
                </li>
              ))}
            </ul>
            <div className={styles.row}>
              <Btn onClick={copyAll}>{copied ? t('admin.copied') : t('admin.copyAll')}</Btn>
            </div>
          </div>
        ) : null}
      </section>

      <section className={styles.panel} aria-labelledby="invites-list">
        <div className={styles.row}>
          <h2 id="invites-list" className={styles.sectionTitle}>
            {t('admin.title')}
          </h2>
          <label className={styles.row}>
            <span className={styles.label}>{t('admin.filter')}</span>
            <select className={styles.select} value={filter} onChange={(e) => setFilter(e.target.value as InviteStatus | '')}>
              <option value="">{t('admin.all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`admin.status.${s}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {list.isError ? (
          <p className={styles.error} role="alert">
            {t('admin.loadError')}
          </p>
        ) : list.isLoading ? (
          <p className={styles.hint} aria-busy="true">
            {t('change.loading')}
          </p>
        ) : rows.length === 0 ? (
          <p className={styles.hint}>{t('admin.empty')}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('admin.columns.created')}</th>
                  <th scope="col">{t('admin.columns.uses')}</th>
                  <th scope="col">{t('admin.columns.status')}</th>
                  <th scope="col">{t('admin.columns.expires')}</th>
                  <th scope="col">{t('admin.columns.note')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmt(r.createdAt)}</td>
                    <td>{t('admin.uses', { used: r.usedCount, max: r.maxUses })}</td>
                    <td>{t(`admin.status.${r.status}`)}</td>
                    <td>{fmt(r.expiresAt)}</td>
                    <td>{r.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor ? (
          <div className={styles.row}>
            <Btn onClick={() => more.mutate()} disabled={more.isPending} aria-busy={more.isPending}>
              {t('admin.loadMore')}
            </Btn>
          </div>
        ) : null}
      </section>
    </div>
  );
}
