// extension/src/content/panel/Panel.tsx — the side panel over an employer's form.
//
// Job card with fit (the app's own scoring service, POST /ext/page-job),
// "Fill this form", a per-field checklist, drafts that live ONLY here until
// the user clicks "Use this answer" for that field, "Undo autofill", and the
// closing question "Did you submit this application?". Rendered in a shadow
// root (mount.tsx); nothing in it presses anything on the page.
// GoApply (market cn, 一键填表): the three fill modes replace the single button,
// a fill can be repeated for the next step of a portal form, the review line
// "请核对后自行提交" outlines the portal's own submit control, and AI text
// carries the AiGeneratedBadge-style label (CnControls.tsx).
// Page-by-page forms (Workday; R4): the button reads "Fill this page", and
// when the form moves to its next page the panel offers it again. The fill
// session — and its run, so one form-fill credit — lasts as long as the panel.
// The panel learns about a new page only when the user comes back to it
// (pointer or focus on the panel) or uses the toolbar button; it never
// watches the page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AtsAdapter, JobOnPage } from '../../adapters/types';
import { useTranslations, type TFunction } from '../../i18n/index';
import { fitConfidenceReasonKey, type ExtMeResponse, type FitChip } from '../../shared/contract';
import type { ExtApi } from '../bridge';
import { apiPageUrl } from '../pageUrl';
import { FillSession, summarize, type ChecklistItem, type FillMode, type SessionState } from '../fill';
import { CN_ERRORS, CN_NOTES, CnAiBadge, CnFillModes, CnReviewHint, type InScope } from './CnControls';
import { cnText } from './cnStrings';

export interface PanelProps {
  adapter: AtsAdapter;
  doc: Document;
  url: string;
  api: ExtApi;
  /** The brand's web origin ("Open %BRAND%" → /extension). */
  webOrigin: string;
  /** cn market: AI drafts carry the AI-generated label (they always say they are AI-written). */
  market: 'intl' | 'cn';
  /**
   * Page-by-page forms only: `current()` names the page the user is on (null
   * when the form shows none). Absent on single-page forms. `oneRun`: the
   * pages change in place, so one run (one form fill) covers the whole
   * application (ONE_RUN_MULTI_PAGE) and the panel says so; without it the
   * panel promises nothing about the cost — a page that loads as a new
   * document may start its own run.
   */
  steps?: { current: () => string | null; oneRun?: boolean };
  /** Receives a function that makes the panel look at the page again (the content controller calls it on a toolbar click). */
  onRegisterRefresh?: (refresh: () => void) => void;
  onCollapse: () => void;
}

type Connection = 'checking' | 'connected' | 'not_connected' | 'unavailable';

/**
 * Drafts are offered only when /ext/me says so (`flags.aiAnswers === true`:
 * the account's AI consent, the brand's AI gate — aiAllowed() on GoApply —
 * and a configured model). A missing flag hides them (fails closed).
 */
export function aiAvailableFrom(me: ExtMeResponse | null): boolean {
  return me?.flags?.aiAnswers === true;
}

function formatReset(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  } catch {
    return d.toISOString();
  }
}

function FitLine({ fit, market, t }: { fit: FitChip; market: 'intl' | 'cn'; t: TFunction }) {
  // Why a quick estimate rests on little (the same reasons, in the same words, as the app's fit card).
  const reasonKey = fitConfidenceReasonKey(fit);
  return (
    <div className="fit">
      {fit.tier ? (
        <span className="tier" data-tier={fit.tier}>
          {t(`fit.tier.${fit.tier}`)}
        </span>
      ) : null}
      <span className="meta">{fit.score === null ? '—' : t('fit.score', { score: Math.round(fit.score) })}</span>
      {fit.kind === 'pre' ? <span className="chip">{t('fit.quickEstimate')}</span> : null}
      {fit.kind === 'ai' && market === 'cn' ? <CnAiBadge /> : null}
      {reasonKey ? (
        <p className="meta" data-testid="fit-low-confidence" style={{ width: '100%', margin: 0 }}>
          {t(reasonKey)}
        </p>
      ) : null}
      <p className="meta muted" style={{ width: '100%', margin: 0 }}>
        {t('fit.note')}
      </p>
    </div>
  );
}

function detailFor(item: ChecklistItem, t: TFunction): string | null {
  if (item.status === 'filled') {
    if (item.source === 'resume') return t('source.resume', { fileName: item.fileName ?? '' });
    if (item.source) return t(`source.${item.source}`);
    return null;
  }
  if (item.note) return CN_NOTES.has(item.note) ? cnText(`note.${item.note}`) : t(`note.${item.note}`);
  return null;
}

function ItemRow({ item, session, market, t }: { item: ChecklistItem; session: FillSession; market: 'intl' | 'cn'; t: TFunction }) {
  // The user's edit belongs to one draft; a new draft starts from its own text.
  const [edit, setEdit] = useState<{ of: string | undefined; text: string }>({ of: item.draft?.text, text: item.draft?.text ?? '' });
  const text = edit.of === item.draft?.text ? edit.text : (item.draft?.text ?? '');
  const setText = (value: string) => setEdit({ of: item.draft?.text, text: value });
  const label = item.label || t('item.unlabelled');
  const detail = detailFor(item, t);
  return (
    <li className="item" data-sensitive={item.sensitive ? 'true' : 'false'} data-field-id={item.id}>
      <div className="item-head">
        <p className="item-label">{label}</p>
        <span className="chip" data-status={item.status}>
          {t(`status.${item.status}`)}
        </span>
      </div>
      {detail ? <p className="meta">{detail}</p> : null}
      {item.sensitive && item.status === 'filled' ? <p className="meta">{item.cnKey ? cnText('item.checkSensitive') : t('item.checkSensitive')}</p> : null}
      {item.status === 'filled' && item.savable && !item.saved ? (
        <div className="row">
          <button type="button" className="btn quiet" disabled={item.saving} onClick={() => void session.saveDraftAnswer(item.id)}>
            {item.saving ? t('draft.saving') : t('draft.save')}
          </button>
          <span className="meta muted">{t('draft.saveHint')}</span>
        </div>
      ) : null}
      {item.saved ? (
        <p className="meta" role="status">
          {t('draft.saved')}
        </p>
      ) : null}
      {item.saveError ? (
        <p className="meta" role="alert">
          {item.saveError === 'protected' ? t('draft.saveProtected') : t('draft.saveFailed')}
        </p>
      ) : null}
      {item.canDraft && !item.draft && item.status !== 'filled' ? (
        <div className="row">
          <button type="button" className="btn" disabled={item.drafting} onClick={() => void session.requestDraft(item.id)}>
            {item.drafting ? t('draft.writing') : t('draft.write')}
          </button>
          <span className="meta muted">{t('draft.cost')}</span>
        </div>
      ) : null}
      {item.draft ? (
        <div className="draft">
          <div className="row">
            {item.draft.source === 'ai' ? (
              market === 'cn' ? (
                <CnAiBadge />
              ) : (
                <span className="chip" data-kind="ai">
                  {t('draft.aiBadge')}
                </span>
              )
            ) : null}
            <span className="meta">{item.draft.source === 'ai' ? t('draft.aiLabel') : t('draft.bankLabel')}</span>
          </div>
          {item.draft.source === 'ai' && market === 'cn' ? <p className="meta muted">{t('draft.aiDisclosure')}</p> : null}
          <textarea aria-label={t('draft.editLabel', { question: label })} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button type="button" className="btn primary" style={{ width: 'auto' }} onClick={() => void session.useDraft(item.id, text)} disabled={!text.trim()}>
              {t('draft.use')}
            </button>
            <button type="button" className="btn quiet" onClick={() => session.dismissDraft(item.id)}>
              {t('draft.dismiss')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function Panel({ adapter, doc, url, api, webOrigin, market, steps, onRegisterRefresh, onCollapse }: PanelProps) {
  const t = useTranslations('extension');
  const job: JobOnPage | null = useMemo(() => adapter.readJob(doc), [adapter, doc]);
  const [connection, setConnection] = useState<Connection>('checking');
  const [me, setMe] = useState<ExtMeResponse | null>(null);
  const [page, setPage] = useState<{ jobId?: string | null; fit?: FitChip | null } | null>(null);
  const [session, setSession] = useState<FillSession | null>(null);
  const [state, setState] = useState<SessionState | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await api({ op: 'me' });
      if (!live) return;
      if (!res.ok) {
        setConnection(res.code === 'not_connected' || res.code === 'unauthorized' || res.code === 'device_revoked' ? 'not_connected' : 'unavailable');
        return;
      }
      setMe(res.data);
      setConnection('connected');
      if (job?.title && job.company) {
        const fit = await api({
          op: 'pageJob',
          body: { url: apiPageUrl(url), title: job.title.slice(0, 200), company: job.company.slice(0, 200), location: job.location?.slice(0, 200), descriptionText: (job.descriptionText ?? '').slice(0, 60_000) },
        });
        if (live && fit.ok) setPage(fit.data);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, job, url]);

  // Page-by-page forms: the page the user is on now, and the page the last fill covered.
  const multiPage = Boolean(steps);
  const oneRun = steps?.oneRun === true;
  const [stepNow, setStepNow] = useState<string | null>(() => steps?.current() ?? null);
  const [filledStep, setFilledStep] = useState<string | null | undefined>(undefined);
  const checkStep = useCallback(() => {
    if (!steps) return;
    const now = steps.current();
    setStepNow((prev) => (prev === now ? prev : now));
  }, [steps]);
  useEffect(() => {
    onRegisterRefresh?.(checkStep);
  }, [onRegisterRefresh, checkStep]);

  const [fills, setFills] = useState(0);
  // One session per panel: every fill of this application shares its run (one form-fill credit).
  const sessionRef = useRef<FillSession | null>(null);
  const startFill = (mode: FillMode = 'all', inScope: InScope | null = null) => {
    const s = sessionRef.current ?? new FillSession({ adapter, doc, url, api, jobId: page?.jobId ?? null, aiAvailable: aiAvailableFrom(me), multiPage, onChange: setState });
    sessionRef.current = s;
    setSession(s);
    setFills((n) => n + 1);
    const step = steps?.current() ?? null;
    setStepNow(step);
    setFilledStep(step);
    void s.start({ mode, inScope, pageKey: step ?? '', jobId: page?.jobId ?? null });
    setState(s.getState());
  };
  const cn = market === 'cn';

  const counts = state ? summarize(state.items) : null;
  const filling = state?.phase === 'filling';
  const done = state?.phase === 'done';
  /** The form moved to another page since the last fill: offer "Fill this page" again. */
  const newPage = multiPage && done && filledStep !== undefined && stepNow !== filledStep;

  return (
    <section className="panel" aria-labelledby="ra-panel-title" data-ra-ext-panel="" onPointerEnter={checkStep} onFocusCapture={checkStep}>
      <header className="head">
        <div>
          <h2 className="title" id="ra-panel-title">
            {cn ? cnText('panel.title') : t('panel.title')}
          </h2>
          <p className="meta">{cn ? cnText('panel.site', { site: adapter.siteName }) : t('panel.site', { site: adapter.siteName })}</p>
        </div>
        <button type="button" className="btn quiet" aria-label={t('panel.collapse')} onClick={onCollapse}>
          ✕
        </button>
      </header>
      <div className="body">
        {connection === 'checking' ? <p className="meta">{t('panel.checking')}</p> : null}
        {connection === 'unavailable' ? <p className="notice">{t('error.network')}</p> : null}
        {connection === 'not_connected' ? (
          <div className="card">
            <p className="strong">{t('connect.title')}</p>
            <p className="meta">{t('connect.body')}</p>
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <a className="btn" href={`${webOrigin}/extension`} target="_blank" rel="noreferrer">
                {t('connect.open')}
              </a>
            </div>
          </div>
        ) : null}

        {connection === 'connected' ? (
          <>
            <div className="card">
              <p className="job-title">{job?.title ?? t('job.untitled')}</p>
              <p className="meta">{[job?.company, job?.location].filter(Boolean).join(' · ') || '—'}</p>
              {page?.fit ? <FitLine fit={page.fit} market={market} t={t} /> : null}
            </div>

            {!cn && (!state || state.phase === 'idle' || state.phase === 'error') ? (
              <>
                <button type="button" className="btn primary" onClick={() => startFill()}>
                  {multiPage ? t('panel.fillPage') : t('panel.fill')}
                </button>
                {multiPage ? (
                  <p className="meta muted">
                    {t('panel.pageByPage')}
                    {oneRun ? ` ${t('panel.oneFill')}` : ''}
                  </p>
                ) : null}
              </>
            ) : null}
            {!cn && newPage ? (
              <div className="card" role="status">
                <p className="strong">{t('panel.newPage')}</p>
                <p className="meta">
                  {t('panel.newPageHint')}
                  {oneRun ? ` ${t('panel.newPageNoCost')}` : ''}
                </p>
                <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                  <button type="button" className="btn primary" style={{ width: 'auto' }} onClick={() => startFill()}>
                    {t('panel.fillPage')}
                  </button>
                </div>
              </div>
            ) : null}
            {cn && (!state || state.phase !== 'filling') && !done ? <CnFillModes doc={doc} again={false} onStart={startFill} /> : null}
            {filling ? (
              <p className="meta" role="status">
                {t('panel.filling')}
              </p>
            ) : null}
            {state?.error ? (
              <p className="notice" role="alert">
                {state.error === 'credits_exhausted' && formatReset(state.resetsAt)
                  ? t('error.credits_exhaustedUntil', { time: formatReset(state.resetsAt)! })
                  : CN_ERRORS.has(state.error)
                    ? cnText(`error.${state.error}`)
                    : t(`error.${state.error}`)}
              </p>
            ) : null}

            {counts && counts.total > 0 && session ? (
              <>
                <p className="strong" role="status">
                  {t('panel.summary', { filled: counts.filled, total: counts.total })}
                  {counts.needsYou ? ` ${t('panel.summaryNeedsYou', { count: counts.needsYou })}` : ''}
                </p>
                <ul className="list" aria-label={t('panel.checklist')}>
                  {state!.items.map((item) => (
                    <ItemRow key={item.id} item={item} session={session} market={market} t={t} />
                  ))}
                </ul>
              </>
            ) : null}
            {done && counts && counts.total === 0 ? <p className="meta">{t('panel.noFields')}</p> : null}

            {done && session ? (
              <div className="foot">
                <div className="row">
                  <button type="button" className="btn" onClick={() => session.undo()}>
                    {t('panel.undo')}
                  </button>
                </div>
                {state?.undo ? (
                  <p className="meta" role="status">
                    {t('panel.undone', { count: state.undo.restored })}
                    {state.undo.notRestored ? ` ${t('panel.undoPartial', { count: state.undo.notRestored })}` : ''}
                  </p>
                ) : null}
                {cn ? <CnReviewHint doc={doc} adapter={adapter} fillKey={fills} /> : <p className="strong">{t('panel.submitYourself')}</p>}
                {state?.submitted === 'unknown' ? (
                  <div>
                    <p className="meta" id="ra-submitted-q">
                      {t('submitted.question')}
                    </p>
                    <div className="row" role="group" aria-labelledby="ra-submitted-q" style={{ marginTop: 'var(--sp-2)' }}>
                      <button type="button" className="btn" onClick={() => void session.markSubmitted(true)}>
                        {t('submitted.yes')}
                      </button>
                      <button type="button" className="btn quiet" onClick={() => void session.markSubmitted(false)}>
                        {t('submitted.notYet')}
                      </button>
                    </div>
                  </div>
                ) : null}
                {state?.submitted === 'yes' ? (
                  <p className="meta" role="status">
                    {state.jobId ? t('submitted.thanks') : t('submitted.thanksNoJob')}
                  </p>
                ) : null}
                {state?.submitted === 'not_yet' ? (
                  <div>
                    <p className="meta" role="status">
                      {t('submitted.later')}
                    </p>
                    {/* "Not yet" is not final: the user can still record a submission from here. */}
                    <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                      <button type="button" className="btn" onClick={() => void session.markSubmitted(true)}>
                        {t('submitted.yes')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {cn && done ? <CnFillModes doc={doc} again onStart={startFill} /> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
