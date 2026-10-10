'use client';

// components/v3/admin/SourcesConsole.tsx — /admin/sources on both brands
// (GOAPPLY_PARITY_PLAN.md §3.9; bundle PAR-7).
//
//   <JobSourcesPanel />     the shared part: each job source of a brand from the
//                           job source registry — on or off and why, how it is
//                           reached, what its last check did, and why postings
//                           were left out. A recruiter bank with no public job
//                           page says its jobs are saved but not shown, and
//                           names the setting that turns them on.
//   <CareerBoardsPanel />   GoApply's company job boards: list, add, turn on or
//                           off, check now, remove.
//   <SourcesConsole />      the page. GoApply: both panels. RoboApply: its
//                           existing company-boards panel (passed in by the
//                           page, unchanged) followed by the shared panel.
//
// Every number is what the server counted (a stored result of the last check,
// or a count of saved jobs); nothing here is estimated or filled in.

import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useSystemStatus } from '../../../hooks/useAdmin';
import type { BrandHealth, JobSourceRunView, JobSourceView } from '../../../lib/api/admin';
import {
  adminCreateCareerSource,
  adminDeleteCareerSource,
  adminListCareerSources,
  adminRunCareerSource,
  adminUpdateCareerSource,
  type CareerSourceRunResult,
  type CareerSourceView,
  type PublicAts,
} from '../../../lib/api/careerSources';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import { Btn } from '../primitives/Btn';
import { PageHeader } from '../primitives/PageHeader';
import { Tag } from '../primitives/Tag';
import { IconRefresh } from '../primitives/Iconset';
import { AdminGate } from './AdminGate';
import { AdminNav } from './AdminNav';
import { fmtCount, fmtLongDate } from './format';
import styles from './console.module.css';

type T = ReturnType<typeof useTranslations>;

/** Job-board systems the server can read (vendor names are data, not copy). */
export const BOARD_SYSTEMS: Readonly<Record<PublicAts, string>> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters' };

const KNOWN_SOURCES = new Set(['ats_public', 'activejobs', 'jsearch', 'linkedin', 'user_import']);
const KNOWN_REASONS = new Set(['kill_switch', 'transport_off', 'tls_required', 'tls_required_no_api_key', 'no_api_key', 'not_configured', 'cross_tenant_unconfirmed', 'not_registered', 'wrong_market', 'disabled']);
const KNOWN_TRANSPORTS = new Set(['db', 'api', 'syndication', 'board_api', 'rapidapi', 'off']);
/**
 * Tallies shown, in this order; `wrong_market` reads differently on each site.
 * The same list the server keeps (ingest/status.ts SOURCE_STATUS_NOTES): each
 * has its own sentence, and a code that is not in the list is not shown at
 * all, so the panel never prints a raw reason code.
 */
export const TALLY_ORDER = [
  'bank_synced',
  'bank_no_public_page',
  'bank_unpublished',
  'bank_no_company',
  'bank_test_posting',
  'bank_closed',
  'boards_read',
  'board_errors',
  'board_backlog',
  'wrong_market',
  'no_apply_url',
  'missing_title_or_company',
  'private_row',
  'normalize_failed',
  'no_external_id',
  'bank_page_cap',
  'bank_pass_cut_short',
] as const;
const BANK_NAMES: Readonly<Record<string, string>> = { bank_gohire: 'GoHire', bank_robohire: 'RoboHire' };

/** The tallies of a run as translated lines, in TALLY_ORDER. */
export function tallyLines(run: JobSourceRunView | null, market: string, t: T, locale: string): string[] {
  if (!run) return [];
  const notes = run.notes ?? {};
  return TALLY_ORDER.filter((k) => (notes[k] ?? 0) > 0).map((k) =>
    t(`skips.${k === 'wrong_market' ? (market === 'cn' ? 'wrong_market_cn' : 'wrong_market_intl') : k}`, { count: fmtCount(notes[k], locale) }),
  );
}

function SourceCard({ source, market }: { source: JobSourceView; market: string }) {
  const t = useTranslations('admin.console.sources');
  const locale = useLocale();
  // RoboHire / GoHire are real source names (data), passed into the copy as a parameter.
  const bankName = BANK_NAMES[source.provider];
  const name = bankName ? t('name.bank', { sourceName: bankName }) : KNOWN_SOURCES.has(source.provider) ? t(`name.${source.provider}`) : t('name.other', { provider: source.provider });
  const about = bankName ? t('about.bank', { sourceName: bankName }) : KNOWN_SOURCES.has(source.provider) ? t(`about.${source.provider}`) : t('about.other');
  const isImport = source.kind === 'import';
  // The run whose tallies are shown: the last one that read something, else the last one.
  const counted = source.lastCounted ?? source.lastRun;
  const lines = tallyLines(counted, market, t, locale);
  const waiting = counted?.notes?.bank_no_public_page ?? 0;
  const notShown = source.publicPage !== null && !source.publicPage.configured;
  const id = `source-${source.provider}`;
  return (
    <li className={styles.card} aria-labelledby={id}>
      <div className={styles.cardHead}>
        <div>
          <h3 id={id}>{name}</h3>
          <p>{about}</p>
        </div>
        {!isImport && (
          <div className={styles.tags}>
            <Tag tone={source.enabled ? 'strong' : 'warn'}>{t(source.enabled ? 'state.on' : 'state.off')}</Tag>
            <Tag>{t(`transport.${KNOWN_TRANSPORTS.has(source.transport) ? source.transport : 'off'}`)}</Tag>
          </div>
        )}
      </div>
      {!isImport && !source.enabled && source.reason && (
        <p className={styles.muted}>{KNOWN_REASONS.has(source.reason) ? t(`reason.${source.reason}`) : t('reason.other', { code: source.reason })}</p>
      )}
      {!isImport && (
        <dl className={styles.facts}>
          <div>
            <dt>{t('facts.lastRun')}</dt>
            <dd>{source.lastRun ? fmtLongDate(source.lastRun.at, locale) : t('facts.never')}</dd>
          </div>
          <div>
            <dt>{t('facts.written')}</dt>
            <dd>{source.lastRun ? fmtCount(source.lastRun.written, locale) : '—'}</dd>
          </div>
          <div>
            <dt>{t('facts.open')}</dt>
            <dd>{fmtCount(source.openJobs, locale)}</dd>
          </div>
          {source.heldJobs > 0 && (
            <div>
              <dt>{t('facts.held')}</dt>
              <dd>{fmtCount(source.heldJobs, locale)}</dd>
            </div>
          )}
          {source.boards && (
            <div>
              <dt>{t('facts.boards')}</dt>
              <dd>{t('facts.boardsValue', { enabled: fmtCount(source.boards.enabled, locale), total: fmtCount(source.boards.total, locale) })}</dd>
            </div>
          )}
        </dl>
      )}
      {source.boards && source.boards.failing > 0 && <p className={styles.muted}>{t('facts.boardsFailing', { count: source.boards.failing })}</p>}
      {source.lastRun && !source.lastRun.ok && (
        <p className={styles.error} role="status">{t('lastError', { error: source.lastRun.error ?? '' })}</p>
      )}
      {notShown && (
        <div className={styles.alertBox} role="note">
          <strong>{t('notShown.title')}</strong>
          <p className={styles.muted}>{t('notShown.body', { source: bankName ?? name, variable: source.publicPage!.variable })}</p>
          {waiting > 0 && <p className={styles.muted}>{t('notShown.count', { count: waiting })}</p>}
        </div>
      )}
      {source.publicPage?.configured && <p className={styles.muted}>{t('pageSet')}</p>}
      {!isImport && counted && (
        <div>
          <h4 className={styles.factsTitle}>{t('skips.title')}</h4>
          {lines.length === 0 ? (
            <p className={styles.muted}>{t('skips.none')}</p>
          ) : (
            <>
              <ul className={styles.tallies}>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
              <p className={styles.muted}>{t('skips.countedAt', { time: fmtLongDate(counted.at, locale) })}</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** One brand's job sources (the shared component: /admin/sources and the System health view). */
export function JobSourcesPanel({ health, showBrand = false }: { health: Pick<BrandHealth, 'brand' | 'market' | 'sources'>; showBrand?: boolean }) {
  const t = useTranslations('admin.console.sources');
  const sources = health.sources ?? [];
  const titleId = `job-sources-${health.brand}`;
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <div className={styles.panelHead}>
        <div>
          <h2 id={titleId}>{showBrand ? t('panelTitleBrand', { brand: health.brand }) : t('panelTitle')}</h2>
          <p>{t('panelSub')}</p>
        </div>
      </div>
      {sources.length === 0 ? <p className={styles.muted}>{t('empty')}</p> : <ul className={styles.list}>{sources.map((s) => <SourceCard key={s.provider} source={s} market={health.market} />)}</ul>}
    </section>
  );
}

/** The current brand's sources, read from the System status of that brand. */
function CurrentBrandSources() {
  const t = useTranslations('admin.console.sources');
  const tc = useTranslations('admin.console');
  const brand = useBrand();
  const q = useSystemStatus(brand.id);
  if (q.isError) {
    return (
      <div className={styles.alertBox} role="alert">
        <strong>{tc('error')}</strong>
        <div className={styles.actions}><Btn onClick={() => void q.refetch()}>{tc('retry')}</Btn></div>
      </div>
    );
  }
  if (!q.data) return <p className={styles.muted} aria-busy="true">{t('loading')}</p>;
  const health = q.data.brands.find((b) => b.brand === brand.id) ?? q.data.brands[0];
  if (!health) return <p className={styles.muted}>{t('empty')}</p>;
  return (
    <>
      <div className={styles.actions}>
        <Btn variant="ghost" icon={<IconRefresh size={15} />} disabled={q.isFetching} onClick={() => void q.refetch()}>{t(q.isFetching ? 'refreshing' : 'refresh')}</Btn>
      </div>
      <JobSourcesPanel health={health} />
    </>
  );
}

// ── Company job boards (GoApply) ─────────────────────────────────────────

const SYSTEMS = Object.keys(BOARD_SYSTEMS) as PublicAts[];
const BOARDS_KEY = ['admin', 'careerSources'] as const;

/** Plain-language key for a stored board error code (the server's BoardFetchError codes). */
export function boardProblemKey(code: string): string {
  if (['board_not_found', 'timeout', 'not_json', 'unexpected_shape', 'unsupported_job_board', 'redirect', 'response_too_large'].includes(code)) return code;
  if (code === 'http_429') return 'rate_limited';
  if (/^http_5\d\d$/.test(code)) return 'server_error';
  if (/^http_\d+$/.test(code)) return 'refused';
  if (code.startsWith('network')) return 'network';
  return 'other';
}

/** The brand's company job boards: add, turn on or off, check now, remove. `market` is the brand's own. */
export function CareerBoardsPanel({ market }: { market: 'intl' | 'cn' }) {
  const t = useTranslations('admin.console.sources.boards');
  const ts = useTranslations('admin.console.sources');
  const tp = useTranslations('jobsTw.admin');
  const locale = useLocale();
  const qc = useQueryClient();
  const [ats, setAts] = useState<PublicAts>('greenhouse');
  const [boardToken, setBoardToken] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const list = useQuery({ queryKey: [...BOARDS_KEY, market], queryFn: () => adminListCareerSources({ market }) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: BOARDS_KEY });
    void qc.invalidateQueries({ queryKey: ['admin', 'console', 'system'] });
  };
  const errorText = (err: unknown) => {
    const code = apiErrorCode(err);
    // A board is read for one site only: the server says when the other site already has it.
    if (code === 'conflict') return t(apiErrorReason(err) === 'board_on_other_site' ? 'errors.otherSite' : 'errors.duplicate');
    return code === 'invalid_request' ? t('errors.invalid') : t('errors.generic');
  };
  const problem = (code: string | null) => tp(`problem.${boardProblemKey(code ?? '')}`);

  const create = useMutation({
    // A mainland board is tagged CN; the tag is only a weak hint, each posting's own location decides.
    mutationFn: () => adminCreateCareerSource({ market, ats, boardToken: boardToken.trim(), companyName: companyName.trim(), ...(market === 'cn' ? { countryCode: 'CN' } : {}) }),
    onSuccess: () => {
      setBoardToken('');
      setCompanyName('');
      setFormError(null);
      refresh();
    },
    onError: (err) => setFormError(errorText(err)),
  });
  const toggle = useMutation({
    mutationFn: (row: CareerSourceView) => adminUpdateCareerSource(row.id, { enabled: !row.enabled }),
    onSuccess: refresh,
    onError: (err) => setNotice({ kind: 'error', text: errorText(err) }),
  });
  const remove = useMutation({
    mutationFn: (row: CareerSourceView) => adminDeleteCareerSource(row.id),
    onSuccess: () => {
      setConfirming(null);
      refresh();
    },
    onError: (err) => setNotice({ kind: 'error', text: errorText(err) }),
  });
  const run = useMutation({
    mutationFn: async (row: CareerSourceView): Promise<[CareerSourceView, CareerSourceRunResult]> => [row, await adminRunCareerSource(row.id)],
    onSuccess: ([row, res]) => {
      setNotice(
        res.status === 'scheduled'
          ? { kind: 'ok', text: t(res.queued ? 'run.queued' : 'run.waiting', { company: row.companyName, listed: res.listed }) }
          : { kind: 'error', text: t('run.error', { company: row.companyName, problem: problem(res.error) }) },
      );
      refresh();
    },
    onError: (err) => setNotice({ kind: 'error', text: errorText(err) }),
  });

  const rows = list.data?.items ?? [];
  const canSubmit = boardToken.trim().length > 0 && companyName.trim().length > 0 && !create.isPending;
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (canSubmit) create.mutate();
  }

  return (
    <section className={styles.panel} aria-labelledby="career-boards-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="career-boards-title">{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
      </div>

      <form className={styles.filters} onSubmit={onSubmit} noValidate aria-labelledby="career-boards-add">
        <h3 id="career-boards-add" className={`${styles.factsTitle} ${styles.full}`}>{t('add.title')}</h3>
        <p className={`${styles.muted} ${styles.full}`}>{t('systems', { names: SYSTEMS.map((s) => BOARD_SYSTEMS[s]).join(', ') })}</p>
        <label className={styles.field}>
          {t('add.system')}
          <select value={ats} onChange={(e) => setAts(e.target.value as PublicAts)}>
            {SYSTEMS.map((s) => <option key={s} value={s}>{BOARD_SYSTEMS[s]}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          {t('add.token')}
          <input value={boardToken} maxLength={120} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setBoardToken(e.target.value)} aria-describedby="career-boards-token-hint" />
          <span id="career-boards-token-hint" className={styles.muted}>{t('add.tokenHint')}</span>
        </label>
        <label className={styles.field}>
          {t('add.company')}
          <input value={companyName} maxLength={200} onChange={(e) => setCompanyName(e.target.value)} aria-describedby="career-boards-company-hint" />
          <span id="career-boards-company-hint" className={styles.muted}>{t('add.companyHint')}</span>
        </label>
        <div className={`${styles.actions} ${styles.full}`}>
          <Btn type="submit" variant="primary" disabled={!canSubmit} aria-busy={create.isPending}>{t(create.isPending ? 'add.adding' : 'add.submit')}</Btn>
        </div>
        {formError && <p className={`${styles.error} ${styles.full}`} role="alert">{formError}</p>}
      </form>

      <div>
        <h3 className={styles.factsTitle}>{t('list.title')}</h3>
        <p className={styles.muted}>{t('offNote')}</p>
      </div>
      {notice && <p className={notice.kind === 'error' ? styles.error : styles.success} role="status">{notice.text}</p>}
      {list.isError ? (
        <p className={styles.error} role="alert">{t('list.loadError')}</p>
      ) : list.isLoading ? (
        <p className={styles.muted} aria-busy="true">{ts('loading')}</p>
      ) : rows.length === 0 ? (
        <p className={styles.muted}>{t('list.empty')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('list.columns.company')}</th>
                <th scope="col">{t('list.columns.system')}</th>
                <th scope="col">{t('list.columns.board')}</th>
                <th scope="col">{t('list.columns.status')}</th>
                <th scope="col">{t('list.columns.lastChecked')}</th>
                <th scope="col" className={styles.num}>{t('list.columns.jobs')}</th>
                <th scope="col">{t('list.columns.problem')}</th>
                <th scope="col">{t('list.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = (toggle.isPending && toggle.variables?.id === row.id) || (remove.isPending && remove.variables?.id === row.id);
                const checking = run.isPending && run.variables?.id === row.id;
                return (
                  <tr key={row.id}>
                    <th scope="row">{row.companyName}</th>
                    <td>{BOARD_SYSTEMS[row.ats] ?? row.ats}</td>
                    <td><span className={styles.code}>{row.boardToken}</span></td>
                    <td>{t(row.enabled ? 'list.on' : 'list.off')}</td>
                    <td>{row.lastSyncedAt ? fmtLongDate(row.lastSyncedAt, locale) : t('list.never')}</td>
                    <td className={styles.num}>{row.lastJobCount === null ? '—' : fmtCount(row.lastJobCount, locale)}</td>
                    <td className={styles.wrap}>{row.lastError ? problem(row.lastError) : t('list.noProblem')}</td>
                    <td>
                      <div className={styles.actions}>
                        {confirming === row.id ? (
                          <>
                            <Btn disabled={busy} onClick={() => remove.mutate(row)}>{t('actions.confirmRemove')}</Btn>
                            <Btn variant="ghost" onClick={() => setConfirming(null)}>{t('actions.cancel')}</Btn>
                          </>
                        ) : (
                          <>
                            <Btn variant="ghost" disabled={!row.enabled || checking} aria-label={t('actions.checkLabel', { company: row.companyName })} onClick={() => run.mutate(row)}>{t(checking ? 'actions.checking' : 'actions.check')}</Btn>
                            <Btn variant="ghost" disabled={busy} aria-label={t('actions.toggleLabel', { company: row.companyName })} onClick={() => toggle.mutate(row)}>{t(row.enabled ? 'actions.turnOff' : 'actions.turnOn')}</Btn>
                            <Btn variant="ghost" disabled={busy} aria-label={t('actions.removeLabel', { company: row.companyName })} onClick={() => setConfirming(row.id)}>{t('actions.remove')}</Btn>
                          </>
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
  );
}

// ── The page ─────────────────────────────────────────────────────────────

/**
 * /admin/sources. `intlBoards` is RoboApply's existing company-boards panel,
 * passed in by the page so it stays exactly as it is; GoApply gets the panels
 * of this file. Both brands end with the shared job sources panel.
 */
export function SourcesConsole({ intlBoards }: { intlBoards?: ReactNode }) {
  const brand = useBrand();
  const { user, status } = useAuth();
  if (brand.market !== 'cn' && intlBoards) {
    // RoboApply's panel shows its own loading and not-authorized states, so the shared panel is
    // added for an admin only: nobody sees two not-authorized blocks or two sign-in loading lines.
    const isAdmin = status !== 'loading' && user?.role === 'admin';
    return (
      <div className={styles.page}>
        {intlBoards}
        {isAdmin && <CurrentBrandSources />}
      </div>
    );
  }
  return (
    <AdminGate>
      <SourcesConsoleInner market={brand.market === 'cn' ? 'cn' : 'intl'} />
    </AdminGate>
  );
}

function SourcesConsoleInner({ market }: { market: 'intl' | 'cn' }) {
  const t = useTranslations('admin.console.sources');
  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      <AdminNav />
      <CurrentBrandSources />
      <CareerBoardsPanel market={market} />
    </div>
  );
}
