'use client';

// CareerSourcesPanel — /admin/sources: the list of company job boards read
// through their public posting APIs into the job list (TASK_PLAN.md WP-42;
// MARKET_STRATEGY JI-3, JC-4). Admin only; the API enforces it.
//
// One list for both sites: a board is one source and each of its postings
// lands on the site of the country it is in. The panel shows the boards that
// feed the site the admin is on (or the `market` it is given).
//
// Add a board (system + board id + company + optional countries), add many at
// once from a CSV or JSON list, turn a board off or on, remove it, or "Check
// now" (the board is read once to report what it lists; its postings are then
// saved by the board sync, which runs every few minutes). Each row says where
// the board came from, which countries it is read for and its state: on,
// waiting for its first check, not confirmed, off, or off after failed reads.
// Counts shown are what the board itself listed.
//
// The systems offered are the contract's own list (./meta.ts, typed by the
// server's `BoardAts`): nothing here names a system. Of those the panel
// offers the ones the server says it can read on this deployment (`systems`
// in the list answer: a connector may be switched off). Until that answer is
// there (the list is still loading, or the request failed) a system that is
// read only behind a flag is neither offered nor named. A server that answers
// without the field gets every system offered; adding a board of one that is
// switched off is then refused, and the panel says that this system cannot be
// read instead of blaming the fields.
//
// A board that is already in the list but read only for the other site's
// countries is not in this list, so "already in the list" alone would send
// the admin looking for nothing. The panel says so and offers the one action
// that helps: read it for this site too (its countries are widened; nothing
// else about the board changes).

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';

import {
  adminCreateCareerSource,
  adminDeleteCareerSource,
  adminImportCareerSources,
  adminListCareerSources,
  adminRunCareerSource,
  adminUpdateCareerSource,
  type CareerSourceRunResult,
  type CareerSourceView,
  type ImportCareerSourcesResult,
} from '../../../../lib/api/careerSources';
import type { BoardAts } from '../../../../lib/api/contracts/jobs/sources/atsPublic';
import { apiErrorCode, apiErrorDetails, apiErrorReason } from '../../../../lib/api/contracts/wire';
import { useAuth } from '../../../../lib/auth/AuthProvider';
import { Btn } from '../../../v3/primitives/Btn';
import { EmptyState } from '../../../v3/primitives/EmptyState';
import { PageHeader } from '../../../v3/primitives/PageHeader';
import { BOARD_READ_URLS, BOARD_SYSTEMS, FLAG_GATED_SYSTEMS, PUBLIC_ATS_NAMES, boardSystemLabel } from './meta';
import styles from './tw.module.css';

const LIST_KEY = ['admin', 'careerSources'] as const;

/**
 * The systems to offer: every system of the contract, less the ones the
 * server's list answer leaves out of `systems` (connectors switched off on
 * this deployment). No answer yet (`undefined` or `null`: the list is
 * loading, or the request failed): every system that needs no flag, so a
 * flag-gated one is never shown before the server says it reads it. An answer
 * without the field: every system.
 */
export function offeredSystems(listAnswer: unknown): BoardAts[] {
  if (listAnswer === undefined || listAnswer === null) return BOARD_SYSTEMS.filter((s) => !FLAG_GATED_SYSTEMS.includes(s));
  const systems = (listAnswer as { systems?: unknown }).systems;
  if (!Array.isArray(systems)) return BOARD_SYSTEMS;
  const offered = BOARD_SYSTEMS.filter((s) => systems.includes(s));
  return offered.length > 0 ? offered : BOARD_SYSTEMS;
}

/** The listing URL a board id maps to (mirrors the server connectors; shown to ops before saving). */
export function boardReadUrl(ats: BoardAts, token: string): string {
  return BOARD_READ_URLS[ats](encodeURIComponent(token.trim() || '…'));
}

/** The server's reason when a system's connector is switched off: a refused create (`details.reason`), a refused import row, a board's last problem. */
const CONNECTOR_DISABLED = 'connector_disabled';

type Notice = { kind: 'ok' | 'error'; text: string } | null;

/** `lastError` of a candidate whose first check did not confirm it: 'validation:<reason>' (server shared.ts). */
const VALIDATION_PREFIX = 'validation:';

/** Plain-language key for a stored board error code (BoardFetchError codes in server http.ts / connectors.ts, validation verdicts in discovery.ts). */
export function problemKey(raw: string): string {
  const code = raw.startsWith(VALIDATION_PREFIX) ? raw.slice(VALIDATION_PREFIX.length) : raw;
  if (code === 'board_not_found' || code === 'timeout' || code === 'not_json' || code === 'unexpected_shape' || code === 'unsupported_job_board') return code;
  // Not read on purpose (no request was made): a switched-off connector, a denylisted tenant, a tenant asked again too soon.
  if (code === CONNECTOR_DISABLED || code === 'tenant_denied' || code === 'tenant_floor') return code;
  // A feed that is not the XML we know reads like one that is not JSON.
  if (code === 'not_xml') return 'not_json';
  if (code === 'invalid_board_id') return 'board_not_found';
  if (code === 'redirect' || code === 'response_too_large' || code === 'sources_off') return code;
  if (code === 'empty_board' || code === 'name_mismatch' || code === 'name_unconfirmed') return code;
  if (code === 'http_429') return 'rate_limited';
  if (/^http_5\d\d$/.test(code)) return 'server_error';
  if (/^http_\d+$/.test(code)) return 'refused';
  if (code.startsWith('network')) return 'network';
  return 'other';
}

/**
 * The sentence shown for a problem key that has none of its own yet. The three
 * keys below were added by MKT-5B, whose bundle owns no copy; until the
 * sentences exist (handoff MKT-5B, Requests) each reads as the closest one
 * that does. Every other key has its sentence.
 */
export const PROBLEM_FALLBACK: Readonly<Record<string, string>> = {
  [CONNECTOR_DISABLED]: 'unsupported_job_board',
  tenant_denied: 'unsupported_job_board',
  tenant_floor: 'rate_limited',
};

/** The reason of a refused import row that has no sentence of its own yet (same rule as PROBLEM_FALLBACK). */
export const IMPORT_REASON_FALLBACK: Readonly<Record<string, string>> = { [CONNECTOR_DISABLED]: 'unknown_job_board' };

/** The key of a row's state: on, waiting for its first check, not confirmed, off, or off after failed reads. */
export function stateKey(row: Pick<CareerSourceView, 'state' | 'lastError' | 'lastSyncedAt' | 'failCount' | 'enabled'>): 'on' | 'waiting' | 'notConfirmed' | 'off' | 'offAfterFailures' {
  // `state` is absent on a row from a server older than the market wave.
  const state = row.state ?? (row.enabled ? 'enabled' : 'disabled');
  if (state === 'enabled') return 'on';
  // A check that reached a result carries its time. One that failed in passing (the board was busy) has
  // none yet: it is tried again, so the board is still waiting.
  if (state === 'candidate') return (row.lastError ?? '').startsWith(VALIDATION_PREFIX) && row.lastSyncedAt ? 'notConfirmed' : 'waiting';
  return (row.failCount ?? 0) >= 3 ? 'offAfterFailures' : 'off';
}

/** "TW, cn" → ['TW', 'CN']; null when a part is not a two-letter code. */
export function parseCountries(text: string): string[] | null {
  const parts = text
    .split(/[\s,;|]+/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  if (parts.some((p) => !/^[A-Z]{2}$/.test(p))) return null;
  return [...new Set(parts)];
}

/** `details.reason` of the 409 for a board that is in the list but read for other countries than this site's (server service.ts). */
const OTHER_COUNTRIES = 'board_read_for_other_countries';

/** The shared board a create ran into: its row, the countries it is read for now, and the market of this site. */
interface OtherBoard {
  id: string;
  countries: string[];
  market: 'intl' | 'cn';
}

const feeds = (countries: readonly string[], market: 'intl' | 'cn'): boolean =>
  countries.length === 0 || (market === 'cn' ? countries.includes('CN') : countries.some((c) => c !== 'CN'));

/**
 * The countries a board must be read for so that it also feeds `market`: what
 * it is read for now plus what the admin asked for (an empty list means every
 * country and wins). When that still leaves this site out, the mainland site
 * adds CN and the international site reads every country.
 */
export function countriesToAlsoFeed(existing: readonly string[], wanted: readonly string[], market: 'intl' | 'cn'): string[] {
  const merged = existing.length === 0 || wanted.length === 0 ? [] : [...new Set([...existing, ...wanted])].sort();
  if (feeds(merged, market)) return merged;
  return market === 'cn' ? [...merged, 'CN'].sort() : [];
}

/** Longest list sent (the server's limit for a CSV; a larger file is refused before it is sent). */
const IMPORT_MAX_CHARS = 1_000_000;
const IMPORT_MAX_ROWS = 5000;

/** The first line of an import CSV (the server's IMPORT_CSV_COLUMNS; field names are data, not copy). */
export const IMPORT_CSV_HEADER = 'ats,boardToken,companyName,countries';

type ImportBody = Parameters<typeof adminImportCareerSources>[0];

/** The request for a pasted or chosen list: a JSON list when it starts with '[', else CSV. Returns the error key when it cannot be sent. */
export function importBody(text: string, enable: boolean): ImportBody | 'empty' | 'json' | 'tooLarge' {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return 'json';
    }
    const rows = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) return 'json';
    if (rows.length > IMPORT_MAX_ROWS) return 'tooLarge';
    return { format: 'json', rows: rows as NonNullable<ImportBody['rows']>, enable };
  }
  if (trimmed.length > IMPORT_MAX_CHARS) return 'tooLarge';
  return { format: 'csv', csv: trimmed, enable };
}

export interface CareerSourcesPanelProps {
  /** Show the boards that feed this market. Default: the site the admin is on (the server decides). */
  market?: 'intl' | 'cn';
}

export function CareerSourcesPanel({ market }: CareerSourcesPanelProps = {}) {
  const t = useTranslations('jobsTw.admin');
  const locale = useLocale();
  const { user, status } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'admin';

  const [chosenAts, setAts] = useState<BoardAts>('greenhouse');
  const [boardToken, setBoardToken] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [countries, setCountries] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [otherBoard, setOtherBoard] = useState<OtherBoard | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importEnable, setImportEnable] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportCareerSourcesResult | null>(null);

  const listKey = [...LIST_KEY, market ?? 'site'] as const;
  const list = useQuery({ queryKey: listKey, queryFn: () => adminListCareerSources(market ? { market } : undefined), enabled: isAdmin });
  const refresh = () => qc.invalidateQueries({ queryKey: LIST_KEY });
  // Only systems this deployment can read are offered; a choice that is no longer offered falls back to the first.
  const SYSTEMS = offeredSystems(list.data);
  const ats: BoardAts = SYSTEMS.includes(chosenAts) ? chosenAts : SYSTEMS[0]!;
  // A sentence under `base`, by its own key when the bundle has it, else by the closest key that exists.
  const has = (key: string): boolean => typeof t.has !== 'function' || t.has(key as never);
  const sentence = (base: 'problem' | 'import.reason', key: string, fallback: Readonly<Record<string, string>>, last: string): string =>
    t(`${base}.${has(`${base}.${key}`) ? key : (fallback[key] ?? last)}` as never);
  const problemText = (raw: string): string => sentence('problem', problemKey(raw), PROBLEM_FALLBACK, 'other');
  const importReasonText = (reason: string): string => sentence('import.reason', reason, IMPORT_REASON_FALLBACK, 'unreadable_row');
  const errorText = (err: unknown) => {
    const code = apiErrorCode(err);
    // 409 with `details.reason: board_read_for_other_countries`: the board is one shared row that this
    // site's list does not show (it is read for other countries), so "already in the list" would mislead.
    if (code === 'conflict') return apiErrorReason(err) === OTHER_COUNTRIES ? t('errors.otherCountries') : t('errors.duplicate');
    // 400 with `details.reason: connector_disabled`: nothing is wrong with the fields, this system is switched off here.
    if (code === 'invalid_request' && apiErrorReason(err) === CONNECTOR_DISABLED) return problemText(CONNECTOR_DISABLED);
    return code === 'invalid_request' ? t('errors.invalid') : t('errors.generic');
  };
  const countryList = parseCountries(countries);

  const create = useMutation({
    mutationFn: () =>
      adminCreateCareerSource({
        ats,
        boardToken: boardToken.trim(),
        companyName: companyName.trim(),
        ...(countryCode.trim() ? { countryCode: countryCode.trim().toUpperCase() } : {}),
        ...(countryList && countryList.length > 0 ? { countries: countryList } : {}),
      }),
    onSuccess: async () => {
      setBoardToken('');
      setCompanyName('');
      setCountryCode('');
      setCountries('');
      setFormError(null);
      setOtherBoard(null);
      await refresh();
    },
    onError: (err) => {
      setFormError(errorText(err));
      // The shared row this site's list does not show: offer to read it for this site too.
      const details = apiErrorReason(err) === OTHER_COUNTRIES ? apiErrorDetails<{ id?: unknown; countries?: unknown; market?: unknown }>(err) : null;
      setOtherBoard(
        details && typeof details.id === 'string'
          ? {
              id: details.id,
              countries: Array.isArray(details.countries) ? details.countries.filter((c): c is string => typeof c === 'string') : [],
              market: details.market === 'cn' || details.market === 'intl' ? details.market : (market ?? 'intl'),
            }
          : null,
      );
    },
  });

  const readHereToo = useMutation({
    // The countries in the form are what the admin wants this board read for here.
    mutationFn: (board: OtherBoard) => adminUpdateCareerSource(board.id, { countries: countriesToAlsoFeed(board.countries, countryList ?? [], board.market) }),
    onSuccess: async (row) => {
      setBoardToken('');
      setCompanyName('');
      setCountryCode('');
      setCountries('');
      setFormError(null);
      setOtherBoard(null);
      setNotice({ kind: 'ok', text: t('errors.otherCountriesDone', { company: row.companyName }) });
      await refresh();
    },
    onError: (err) => {
      setOtherBoard(null);
      setFormError(errorText(err));
    },
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
          : { kind: 'error', text: t('run.error', { company: row.companyName, problem: problemText(res.error ?? '') }) },
      );
      await refresh();
    },
    onError: (err) => setNotice({ kind: 'error', text: errorText(err) }),
  });

  const importMany = useMutation({
    mutationFn: (body: ImportBody) => adminImportCareerSources(body),
    onSuccess: async (res) => {
      setImportResult(res);
      setImportError(null);
      setImportText('');
      await refresh();
    },
    onError: (err) => {
      setImportResult(null);
      setImportError(apiErrorCode(err) === 'invalid_request' ? t('import.errors.invalid') : t('errors.generic'));
    },
  });

  function onImport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (importMany.isPending) return;
    const body = importBody(importText, importEnable);
    if (typeof body === 'string') {
      setImportResult(null);
      setImportError(t(`import.errors.${body}`));
      return;
    }
    importMany.mutate(body);
  }

  async function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImportText(await file.text());
      setImportError(null);
    } catch {
      setImportError(t('import.errors.file'));
    }
  }

  if (status === 'loading') return <p aria-busy="true">{t('loading')}</p>;
  if (!isAdmin) return <EmptyState title={t('notAuthorized')} />;

  const rows = list.data?.items ?? [];
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : t('list.never'));
  const canSubmit = boardToken.trim().length > 0 && companyName.trim().length > 0 && countryList !== null && !create.isPending;

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
        <p className={styles.hint}>{t('systems', { names: [...new Set(SYSTEMS.map((s) => PUBLIC_ATS_NAMES[s]))].join(', ') })}</p>
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.label}>{t('add.system')}</span>
              <select
                className={styles.select}
                value={ats}
                onChange={(e) => {
                  setAts(e.target.value as BoardAts);
                  setOtherBoard(null);
                }}
              >
                {SYSTEMS.map((s) => (
                  <option key={s} value={s}>
                    {boardSystemLabel(s)}
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
                onChange={(e) => {
                  setBoardToken(e.target.value);
                  // The offer below was about the board that was typed before.
                  setOtherBoard(null);
                }}
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
            <div className={styles.field}>
              <label htmlFor="career-sources-countries" className={styles.label}>
                {t('add.countries')}
              </label>
              <input
                id="career-sources-countries"
                className={styles.input}
                value={countries}
                maxLength={240}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={countryList === null}
                onChange={(e) => setCountries(e.target.value)}
                aria-describedby="career-sources-countries-hint"
              />
              <span id="career-sources-countries-hint" className={styles.hint}>
                {t('add.countriesHint')}
              </span>
            </div>
          </div>
          {formError ? (
            <p className={styles.error} role="alert">
              {formError}
            </p>
          ) : null}
          {otherBoard ? (
            <div className={styles.row}>
              <Btn onClick={() => readHereToo.mutate(otherBoard)} disabled={readHereToo.isPending} aria-busy={readHereToo.isPending}>
                {t('errors.otherCountriesAction')}
              </Btn>
            </div>
          ) : null}
          <div className={styles.row}>
            <Btn type="submit" variant="primary" disabled={!canSubmit} aria-busy={create.isPending}>
              {create.isPending ? t('add.adding') : t('add.submit')}
            </Btn>
          </div>
        </form>
      </section>

      <section className={styles.panel} aria-labelledby="career-sources-import">
        <h2 id="career-sources-import" className={styles.sectionTitle}>
          {t('import.title')}
        </h2>
        <p className={styles.hint}>{t('import.intro', { header: IMPORT_CSV_HEADER })}</p>
        <form className={styles.form} onSubmit={onImport} noValidate>
          <div className={styles.field}>
            <label htmlFor="career-sources-import-text" className={styles.label}>
              {t('import.paste')}
            </label>
            <textarea
              id="career-sources-import-text"
              className={styles.input}
              rows={6}
              value={importText}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setImportText(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="career-sources-import-file" className={styles.label}>
              {t('import.file')}
            </label>
            <input id="career-sources-import-file" type="file" accept=".csv,.json,text/csv,application/json,text/plain" onChange={onImportFile} />
          </div>
          <div className={styles.field}>
            <label className={styles.row}>
              <input type="checkbox" checked={importEnable} onChange={(e) => setImportEnable(e.target.checked)} aria-describedby="career-sources-import-enable-hint" />
              <span className={styles.label}>{t('import.enable')}</span>
            </label>
            <span id="career-sources-import-enable-hint" className={styles.hint}>
              {t('import.enableHint')}
            </span>
          </div>
          {importError ? (
            <p className={styles.error} role="alert">
              {importError}
            </p>
          ) : null}
          <div className={styles.row}>
            <Btn type="submit" variant="primary" disabled={importMany.isPending} aria-busy={importMany.isPending}>
              {importMany.isPending ? t('import.importing') : t('import.submit')}
            </Btn>
          </div>
        </form>
        {importResult ? (
          <div role="status">
            <p className={styles.status}>
              {t('import.summary', { total: importResult.total, created: importResult.created, merged: importResult.merged, invalid: importResult.invalidCount })}
            </p>
            {importResult.invalid.length > 0 ? (
              <>
                <p className={styles.label}>{t('import.invalidTitle')}</p>
                <ul className={styles.hint}>
                  {importResult.invalid.map((row) => (
                    <li key={`${row.line}:${row.reason}`}>{t('import.invalidRow', { line: row.line, reason: importReasonText(row.reason) })}</li>
                  ))}
                </ul>
                {importResult.invalidCount > importResult.invalid.length ? (
                  <p className={styles.hint}>{t('import.invalidMore', { count: importResult.invalidCount - importResult.invalid.length })}</p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
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
                  <th scope="col">{t('list.columns.origin')}</th>
                  <th scope="col">{t('list.columns.countries')}</th>
                  <th scope="col">{t('list.columns.country')}</th>
                  <th scope="col">{t('list.columns.state')}</th>
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
                      <td>{row.ats in PUBLIC_ATS_NAMES ? boardSystemLabel(row.ats) : row.ats}</td>
                      <td className={styles.token}>{row.boardToken}</td>
                      <td>{t(`origin.${row.origin ?? 'admin'}`)}</td>
                      <td className={styles.token}>{row.countries && row.countries.length > 0 ? row.countries.join(', ') : t('list.all')}</td>
                      <td>{row.countryCode ?? t('list.none')}</td>
                      <td>{t(`state.${stateKey(row)}`)}</td>
                      <td>{fmt(row.lastSyncedAt)}</td>
                      <td>{row.lastJobCount ?? t('list.none')}</td>
                      <td className={row.lastError ? styles.problem : undefined}>
                        {row.lastError ? problemText(row.lastError) : t('list.none')}
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
