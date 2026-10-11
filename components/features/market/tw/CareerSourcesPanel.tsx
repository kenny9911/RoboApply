'use client';

// CareerSourcesPanel — /admin/sources: the ops-curated list of company job
// boards read through their public posting APIs into RoboApply's job list
// (TASK_PLAN.md WP-42; TW-02, F-FEED-15). Admin only; the API enforces it
// and answers feature_disabled on the GoApply host.
//
// Add a board (system + board id + company + optional country tag), turn it
// off or on, remove it, or "Check now" (the board is read once to report what
// it lists; its postings are then imported by the regular ingest run, queued
// to start at once). Counts shown are what the board itself listed.

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';

import {
  adminCreateCareerSource,
  adminDeleteCareerSource,
  adminListCareerSources,
  adminRunCareerSource,
  adminUpdateCareerSource,
  type CareerSourceRunResult,
  type CareerSourceView,
  type PublicAts,
} from '../../../../lib/api/careerSources';
import { apiErrorCode, apiErrorReason } from '../../../../lib/api/contracts/wire';
import { useAuth } from '../../../../lib/auth/AuthProvider';
import { Btn } from '../../../v3/primitives/Btn';
import { EmptyState } from '../../../v3/primitives/EmptyState';
import { PageHeader } from '../../../v3/primitives/PageHeader';
import { PUBLIC_ATS_NAMES } from './meta';
import styles from './tw.module.css';

const SYSTEMS = Object.keys(PUBLIC_ATS_NAMES) as PublicAts[];
const LIST_KEY = ['admin', 'careerSources'] as const;

/** The listing URL a board id maps to (mirrors the server connectors; shown to ops before saving). */
export function boardReadUrl(ats: PublicAts, token: string): string {
  const t = encodeURIComponent(token.trim() || '…');
  switch (ats) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${t}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`;
    case 'smartrecruiters':
      return `https://api.smartrecruiters.com/v1/companies/${t}/postings`;
  }
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

/** Plain-language key for a stored board error code (BoardFetchError codes in server http.ts / connectors.ts). */
export function problemKey(code: string): string {
  if (code === 'board_not_found' || code === 'timeout' || code === 'not_json' || code === 'unexpected_shape' || code === 'unsupported_job_board') return code;
  if (code === 'redirect' || code === 'response_too_large') return code;
  if (code === 'http_429') return 'rate_limited';
  if (/^http_5\d\d$/.test(code)) return 'server_error';
  if (/^http_\d+$/.test(code)) return 'refused';
  if (code.startsWith('network')) return 'network';
  return 'other';
}

export function CareerSourcesPanel() {
  const t = useTranslations('jobsTw.admin');
  // The one sentence this panel shares with GoApply's board manager (a board is read for one site at a time).
  const tBoards = useTranslations('admin.console.sources.boards');
  const locale = useLocale();
  const { user, status } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'admin';

  const [ats, setAts] = useState<PublicAts>('greenhouse');
  const [boardToken, setBoardToken] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => adminListCareerSources({ market: 'intl' }), enabled: isAdmin });
  const refresh = () => qc.invalidateQueries({ queryKey: LIST_KEY });
  const errorText = (err: unknown) => {
    const code = apiErrorCode(err);
    // 409 with `details.reason: board_on_other_site` (PAR-7): the other site reads this board (the mainland
    // seed boards, for example), so it is not in this list and "already in the list" would be untrue.
    if (code === 'conflict') return apiErrorReason(err) === 'board_on_other_site' ? tBoards('errors.otherSite') : t('errors.duplicate');
    return code === 'invalid_request' ? t('errors.invalid') : t('errors.generic');
  };

  const create = useMutation({
    mutationFn: () =>
      adminCreateCareerSource({
        ats,
        boardToken: boardToken.trim(),
        companyName: companyName.trim(),
        ...(countryCode.trim() ? { countryCode: countryCode.trim().toUpperCase() } : {}),
      }),
    onSuccess: async () => {
      setBoardToken('');
      setCompanyName('');
      setCountryCode('');
      setFormError(null);
      await refresh();
    },
    onError: (err) => setFormError(errorText(err)),
  });

  const toggle = useMutation({
    mutationFn: (row: CareerSourceView) => adminUpdateCareerSource(row.id, { enabled: !row.enabled }),
    onSuccess: () => refresh(),
    onError: (err) => setNotice({ kind: 'error', text: errorText(err) }),
  });

  const remove = useMutation({
    mutationFn: (row: CareerSourceView) => adminDeleteCareerSource(row.id),
    onSuccess: async () => {
      setConfirming(null);
      await refresh();
    },
    onError: (err) => setNotice({ kind: 'error', text: errorText(err) }),
  });

  const run = useMutation({
    mutationFn: async (row: CareerSourceView): Promise<[CareerSourceView, CareerSourceRunResult]> => [row, await adminRunCareerSource(row.id)],
    onSuccess: async ([row, res]) => {
      setNotice(
        res.status === 'scheduled'
          ? { kind: 'ok', text: t(res.queued ? 'run.queued' : 'run.waiting', { company: row.companyName, listed: res.listed }) }
          : { kind: 'error', text: t('run.error', { company: row.companyName, problem: t(`problem.${problemKey(res.error ?? '')}`) }) },
      );
      await refresh();
    },
    onError: (err) => setNotice({ kind: 'error', text: errorText(err) }),
  });

  if (status === 'loading') return <p aria-busy="true">{t('loading')}</p>;
  if (!isAdmin) return <EmptyState title={t('notAuthorized')} />;

  const rows = list.data?.items ?? [];
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : t('list.never'));
  const canSubmit = boardToken.trim().length > 0 && companyName.trim().length > 0 && !create.isPending;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (canSubmit) create.mutate();
  }

  return (
    <div className={styles.admin}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('subtitle')} />

      <section className={styles.panel} aria-labelledby="career-sources-add">
        <h2 id="career-sources-add" className={styles.sectionTitle}>
          {t('add.title')}
        </h2>
        <p className={styles.hint}>{t('systems', { names: SYSTEMS.map((s) => PUBLIC_ATS_NAMES[s]).join(', ') })}</p>
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.label}>{t('add.system')}</span>
              <select className={styles.select} value={ats} onChange={(e) => setAts(e.target.value as PublicAts)}>
                {SYSTEMS.map((s) => (
                  <option key={s} value={s}>
                    {PUBLIC_ATS_NAMES[s]}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.field}>
              <label htmlFor="career-sources-token" className={styles.label}>
                {t('add.token')}
              </label>
              <input
                id="career-sources-token"
                className={styles.input}
                value={boardToken}
                maxLength={120}
                pattern="[A-Za-z0-9_.\-]+"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setBoardToken(e.target.value)}
                aria-describedby="career-sources-token-hint"
              />
              <span id="career-sources-token-hint" className={styles.hint}>
                {t('add.tokenHint')} {t('add.willRead', { url: boardReadUrl(ats, boardToken) })}
              </span>
            </div>
            <label className={styles.field}>
              <span className={styles.label}>{t('add.company')}</span>
              <input className={styles.input} value={companyName} maxLength={200} onChange={(e) => setCompanyName(e.target.value)} />
            </label>
            <div className={styles.field}>
              <label htmlFor="career-sources-country" className={styles.label}>
                {t('add.country')}
              </label>
              <input
                id="career-sources-country"
                className={styles.input}
                value={countryCode}
                maxLength={2}
                autoCapitalize="characters"
                onChange={(e) => setCountryCode(e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase())}
                aria-describedby="career-sources-country-hint"
              />
              <span id="career-sources-country-hint" className={styles.hint}>
                {t('add.countryHint')}
              </span>
            </div>
          </div>
          {formError ? (
            <p className={styles.error} role="alert">
              {formError}
            </p>
          ) : null}
          <div className={styles.row}>
            <Btn type="submit" variant="primary" disabled={!canSubmit} aria-busy={create.isPending}>
              {create.isPending ? t('add.adding') : t('add.submit')}
            </Btn>
          </div>
        </form>
      </section>

      <section className={styles.panel} aria-labelledby="career-sources-list">
        <h2 id="career-sources-list" className={styles.sectionTitle}>
          {t('list.title')}
        </h2>
        <p className={styles.hint}>{t('offNote')}</p>
        {notice ? (
          <p className={`${styles.status} ${notice.kind === 'error' ? styles.statusError : ''}`} role="status">
            {notice.text}
          </p>
        ) : null}
        {list.isError ? (
          <p className={styles.error} role="alert">
            {t('list.loadError')}
          </p>
        ) : list.isLoading ? (
          <p className={styles.hint} aria-busy="true">
            {t('loading')}
          </p>
        ) : rows.length === 0 ? (
          <p className={styles.hint}>{t('list.empty')}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('list.columns.company')}</th>
                  <th scope="col">{t('list.columns.system')}</th>
                  <th scope="col">{t('list.columns.board')}</th>
                  <th scope="col">{t('list.columns.country')}</th>
                  <th scope="col">{t('list.columns.status')}</th>
                  <th scope="col">{t('list.columns.lastChecked')}</th>
                  <th scope="col">{t('list.columns.jobs')}</th>
                  <th scope="col">{t('list.columns.problem')}</th>
                  <th scope="col">{t('list.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const busy = (toggle.isPending && toggle.variables?.id === row.id) || (remove.isPending && remove.variables?.id === row.id);
                  const checking = run.isPending && run.variables?.id === row.id;
                  return (
                    <tr key={row.id} className={row.enabled ? undefined : styles.off}>
                      <th scope="row">{row.companyName}</th>
                      <td>{PUBLIC_ATS_NAMES[row.ats] ?? row.ats}</td>
                      <td className={styles.token}>{row.boardToken}</td>
                      <td>{row.countryCode ?? t('list.none')}</td>
                      <td>{row.enabled ? t('status.on') : t('status.off')}</td>
                      <td>{fmt(row.lastSyncedAt)}</td>
                      <td>{row.lastJobCount ?? t('list.none')}</td>
                      <td className={row.lastError ? styles.problem : undefined}>
                        {row.lastError ? t(`problem.${problemKey(row.lastError)}`) : t('list.none')}
                      </td>
                      <td>
                        <div className={styles.actions}>
                          <Btn onClick={() => run.mutate(row)} disabled={checking || !row.enabled} aria-busy={checking}>
                            {checking ? t('actions.checking') : t('actions.checkNow')}
                          </Btn>
                          <Btn variant="ghost" onClick={() => toggle.mutate(row)} disabled={busy}>
                            {row.enabled ? t('actions.turnOff') : t('actions.turnOn')}
                          </Btn>
                          {confirming === row.id ? (
                            <>
                              <Btn variant="ghost" onClick={() => remove.mutate(row)} disabled={busy}>
                                {t('actions.confirmRemove')}
                              </Btn>
                              <Btn variant="ghost" onClick={() => setConfirming(null)}>
                                {t('actions.cancel')}
                              </Btn>
                            </>
                          ) : (
                            <Btn variant="ghost" onClick={() => setConfirming(row.id)} disabled={busy}>
                              {t('actions.remove')}
                            </Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default CareerSourcesPanel;
