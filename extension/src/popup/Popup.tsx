// extension/src/popup/Popup.tsx — the toolbar popup.
//
// Not connected: open %BRAND% to connect, or type the 8-character code.
// Connected, on a supported form: "Fill this form" opens the panel.
// Elsewhere: "Request this site" (POST /ext/site-requests, the host and URL
// only). On a job board WP-70 supports: "Check fit" / "Save job" — the page
// is read only after that click (activeTab). Nothing here presses anything on
// the page.

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { plannedSiteForUrl, type AdapterSet } from '../adapters/registry';
import { findBoardReader } from '../content/boards/index';
import { useTranslations } from '../i18n/index';
import { PAIR_CODE_RE, type FitChip } from '../shared/contract';
import type { ApiResult, ContentMessage, ContentPingResponse, InternalMessage, PageReadResponse, StatusResponse } from '../shared/messages';

export interface PopupDeps {
  send(msg: InternalMessage): Promise<unknown>;
  activeTab(): Promise<{ id: number; url: string | null } | null>;
  tabMessage(tabId: number, msg: ContentMessage): Promise<unknown | null>;
  /** Inject the content script into the active tab (activeTab grant from the toolbar click). */
  inject(tabId: number): Promise<boolean>;
  openTab(url: string): void;
  close(): void;
  adapterSet: AdapterSet;
  /** 'cn' (GoApply): AI-scored fit carries the AI-generated label. Defaults to 'intl'. */
  market?: 'intl' | 'cn';
}

type PageKind = { kind: 'form'; site: string } | { kind: 'board'; site: string } | { kind: 'planned'; site: string } | { kind: 'other' } | { kind: 'none' };

export function Popup({ deps }: { deps: PopupDeps }) {
  const t = useTranslations('extension');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [tab, setTab] = useState<{ id: number; url: string | null } | null>(null);
  const [page, setPage] = useState<PageKind>({ kind: 'none' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [fit, setFit] = useState<FitChip | null>(null);

  const refresh = useCallback(async () => {
    const s = (await deps.send({ type: 'status' })) as StatusResponse;
    setStatus(s);
    const active = await deps.activeTab();
    setTab(active);
    if (!active?.url) {
      setPage({ kind: 'other' });
      return;
    }
    let url: URL;
    try {
      url = new URL(active.url);
    } catch {
      setPage({ kind: 'other' });
      return;
    }
    const ping = (await deps.tabMessage(active.id, { type: 'content.ping' })) as ContentPingResponse | null;
    if (ping?.siteName && !findBoardReader(url)) {
      setPage({ kind: 'form', site: ping.siteName });
      return;
    }
    const board = findBoardReader(url);
    if (board) {
      setPage({ kind: 'board', site: board.siteName });
      return;
    }
    const planned = plannedSiteForUrl(url, deps.adapterSet);
    setPage(planned ? { kind: 'planned', site: planned.siteName } : { kind: 'other' });
  }, [deps]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const redeem = async (e: FormEvent) => {
    e.preventDefault();
    const clean = code.trim().toUpperCase().replace(/[\s-]/g, '');
    if (!PAIR_CODE_RE.test(clean)) {
      setMessage({ text: t('popup.codeInvalid'), tone: 'warn' });
      return;
    }
    setBusy(true);
    const res = (await deps.send({ type: 'redeem', code: clean })) as ApiResult<StatusResponse>;
    setBusy(false);
    if (res.ok) {
      setCode('');
      setMessage({ text: t('popup.connected'), tone: 'ok' });
      await refresh();
    } else {
      setMessage({ text: res.code === 'pair_code_invalid' || res.code === 'invalid_request' ? t('popup.codeInvalid') : t('error.network'), tone: 'warn' });
    }
  };

  const openPanel = async () => {
    if (!tab) return;
    await deps.tabMessage(tab.id, { type: 'panel.open' });
    deps.close();
  };

  const requestSite = async () => {
    if (!tab?.url) return;
    setBusy(true);
    const url = new URL(tab.url);
    const res = (await deps.send({ type: 'api', call: { op: 'siteRequest', body: { host: url.hostname, url: `${url.origin}${url.pathname}`.slice(0, 2000) } } })) as ApiResult<unknown>;
    setBusy(false);
    setMessage(res.ok ? { text: t('popup.requested'), tone: 'ok' } : { text: res.code === 'rate_limited' ? t('error.rate_limited') : t('error.network'), tone: 'warn' });
  };

  const readPage = async (): Promise<PageReadResponse['job']> => {
    if (!tab) return null;
    let res = (await deps.tabMessage(tab.id, { type: 'page.read' })) as PageReadResponse | null;
    if (!res && (await deps.inject(tab.id))) res = (await deps.tabMessage(tab.id, { type: 'page.read' })) as PageReadResponse | null;
    return res?.job ?? null;
  };

  const boardAction = async (op: 'pageJob' | 'saveJob') => {
    setBusy(true);
    setMessage(null);
    const job = await readPage();
    if (!job) {
      setBusy(false);
      setMessage({ text: t('popup.noJobFound'), tone: 'warn' });
      return;
    }
    const res = (await deps.send({ type: 'api', call: { op, body: job } })) as ApiResult<{ fit?: FitChip }>;
    setBusy(false);
    if (!res.ok) {
      setMessage({ text: t('error.network'), tone: 'warn' });
      return;
    }
    if (op === 'saveJob') setMessage({ text: t('popup.saved'), tone: 'ok' });
    else if (res.data?.fit) setFit(res.data.fit);
    else setMessage({ text: t('popup.noFit'), tone: 'warn' });
  };

  const disconnect = async () => {
    setStatus((await deps.send({ type: 'disconnect' })) as StatusResponse);
  };

  if (!status) {
    return (
      <div className="wrap">
        <p className="meta">{t('panel.checking')}</p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <h1>{t('popup.title')}</h1>
      {!status.connected ? (
        <>
          <p className="meta">{status.needsReconnect ? t('popup.reconnectBody') : t('connect.body')}</p>
          <button type="button" className="btn primary" onClick={() => deps.openTab(`${status.webOrigin}/extension`)}>
            {status.needsReconnect ? t('popup.reconnect') : t('connect.open')}
          </button>
          <form className="card" onSubmit={(e) => void redeem(e)}>
            <label htmlFor="ra-code">{t('popup.codeLabel')}</label>
            <input id="ra-code" value={code} maxLength={9} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" className="btn" disabled={busy}>
              {t('popup.codeConnect')}
            </button>
          </form>
        </>
      ) : (
        <>
          {page.kind === 'form' ? (
            <>
              <p className="meta">{t('panel.site', { site: page.site })}</p>
              <button type="button" className="btn primary" onClick={() => void openPanel()}>
                {t('panel.fill')}
              </button>
              <p className="meta muted">{t('panel.submitYourself')}</p>
            </>
          ) : null}
          {page.kind === 'board' ? (
            <div className="card">
              <p className="meta">{t('popup.boardBody', { site: page.site })}</p>
              <div className="row">
                <button type="button" className="btn" disabled={busy} onClick={() => void boardAction('pageJob')}>
                  {t('popup.checkFit')}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void boardAction('saveJob')}>
                  {t('popup.saveJob')}
                </button>
              </div>
              {fit ? (
                <p className="meta">
                  {fit.tier ? t(`fit.tier.${fit.tier}`) : '—'} · {fit.score === null ? '—' : t('fit.score', { score: Math.round(fit.score) })}
                  {fit.kind === 'pre' ? ` · ${t('fit.quickEstimate')}` : ''}
                  {fit.kind === 'ai' && deps.market === 'cn' ? (
                    <span className="chip" data-kind="ai">
                      {t('draft.aiBadge')}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {fit ? <p className="meta muted">{t('fit.note')}</p> : null}
            </div>
          ) : null}
          {page.kind === 'planned' || page.kind === 'other' ? (
            <div className="card">
              <p className="meta">{page.kind === 'planned' ? t('popup.plannedSite', { site: page.site }) : t('popup.otherSite')}</p>
              <button type="button" className="btn" disabled={busy || !tab?.url} onClick={() => void requestSite()}>
                {t('popup.requestSite')}
              </button>
            </div>
          ) : null}
          <div className="row">
            <span className="meta muted">{t('popup.version', { version: status.version })}</span>
            <button type="button" className="btn quiet" onClick={() => void disconnect()}>
              {t('popup.disconnect')}
            </button>
          </div>
        </>
      )}
      {message ? (
        <p className={message.tone === 'warn' ? 'notice' : 'meta'} role="status">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
