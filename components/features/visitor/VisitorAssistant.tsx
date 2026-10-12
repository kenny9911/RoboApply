'use client';

// VisitorAssistant — the signed-out assistant on public job pages (WP-78;
// F-ORION-13). A launcher opens a sheet; each question is one turn of
// POST /api/v1/public/copilot (SSE), which answers with page-scoped public
// tools only (public job search, pay as posted, how the site works).
//
// GoApply: AI answers need the visitor's consent, and a visitor has no
// account to hold one. So the panel shows a consent line with an unticked
// box; nothing can be asked until it is ticked, and every turn carries the
// consent version (VISITOR_CONSENT_VERSION). The server refuses a turn
// without it (422 consent_required). RoboApply shows no box.
//
// Honesty: nothing typed here is stored (the server keeps no thread); the
// answers never talk about the visitor's fit (there is no resume); every
// answer is labelled as AI (and carries AiGeneratedBadge where required);
// jobs it lists open their public page, never an app page the visitor
// cannot see. The per-IP limit (10/h, 30/day) answers with a signup prompt.

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { RoboApiError } from '../../../lib/api/client';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import type { CopilotCard, CopilotSseEvent } from '../../../lib/api/contracts/copilot';
import type { PublicFeedItem } from '../../../lib/api/contracts/feed';
import { sendVisitorTurn } from '../../../lib/api/visitor';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { Btn, Sheet } from '../../v3/primitives';
import { CopilotCardView } from '../copilot';
import { AiGeneratedBadge } from '../market';
import { payText } from '../feed';
import { VISITOR_CONSENT_VERSION, signupHref, visitorJobHref } from './model';
import styles from './visitor.module.css';

export interface VisitorPageContext {
  path: string;
  role?: string;
  city?: string;
  country?: string;
}

export interface VisitorAssistantProps {
  pageContext: VisitorPageContext;
  /** Signup attribution (`/signup?from=<from>-assistant`). */
  from: string;
}

type TurnError = 'rateLimited' | 'unavailable' | 'consent' | 'generic';

interface Turn {
  id: string;
  question: string;
  answer: string;
  cards: CopilotCard[];
  status: 'writing' | 'lookingUp' | 'done' | 'error';
  error?: TurnError;
}

/** Card types a visitor turn may show; anything else (a seeker card) is dropped. */
const VISITOR_CARDS = new Set(['job_list', 'salary', 'notice']);

export function errorKind(err: unknown): TurnError {
  const code = apiErrorCode(err);
  const status = err instanceof RoboApiError ? err.status : undefined;
  if (apiErrorReason(err) === 'consent_required') return 'consent';
  if (code === 'rate_limited' || status === 429) return 'rateLimited';
  if (code === 'ai_unavailable' || code === 'feature_disabled' || status === 503 || status === 404) return 'unavailable';
  return 'generic';
}

function JobsCard({ card }: { card: CopilotCard }) {
  const t = useTranslations('visitor');
  const locale = useLocale();
  const brand = useBrand();
  const raw = (card.data as { items?: unknown })?.items;
  const items = Array.isArray(raw) ? (raw as PublicFeedItem[]).filter((i) => i && typeof i.jobId === 'string' && typeof i.title === 'string').slice(0, 8) : [];
  if (!items.length) return null;
  return (
    <div className={styles.answerCard}>
      <ul className={styles.answerJobs}>
        {items.map((job) => {
          const pay = payText(job.pay ?? null, {
            locale,
            market: brand.market,
            range: (min, max) => t('card.range', { min, max }),
            from: (amount) => t('card.from', { amount }),
            upTo: (amount) => t('card.upTo', { amount }),
          });
          return (
            <li key={job.jobId}>
              <Link href={visitorJobHref(job)} className={styles.cardLink}>
                {job.title}
              </Link>
              <span className={styles.meta}>
                {[job.company?.name, job.location ?? t('card.placeNotListed'), pay ? (pay.period ? t(`card.payPeriod.${pay.period}`, { amount: pay.amount }) : pay.amount) : t('card.payNotListed')]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function VisitorAssistant({ pageContext, from }: VisitorAssistantProps) {
  const t = useTranslations('visitor.assistant');
  const brand = useBrand();
  // GoApply: the consent line must be ticked before a question is sent.
  const needsConsent = brand.market === 'cn';
  const [consented, setConsented] = useState(false);
  const consentId = useId();
  const consentDetailId = useId();
  const locked = needsConsent && !consented;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputId = useId();
  const seq = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = useCallback((id: string, fn: (t: Turn) => Turn) => {
    setTurns((all) => all.map((x) => (x.id === id ? fn(x) : x)));
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim().slice(0, 1000);
      if (!q || busy || locked) return;
      const id = `turn-${++seq.current}`;
      setTurns((all) => [...all, { id, question: q, answer: '', cards: [], status: 'writing' }]);
      setText('');
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await sendVisitorTurn(
          { text: q, pageContext, ...(needsConsent ? { consent: VISITOR_CONSENT_VERSION } : {}) },
          {
            signal: controller.signal,
            onEvent: (e: CopilotSseEvent) => {
              switch (e.event) {
                case 'delta':
                  patch(id, (x) => ({ ...x, answer: x.answer + e.data.text, status: x.status === 'lookingUp' ? 'writing' : x.status }));
                  break;
                case 'tool':
                  patch(id, (x) => ({ ...x, status: e.data.phase === 'start' ? 'lookingUp' : 'writing' }));
                  break;
                case 'card':
                  if (VISITOR_CARDS.has(e.data.type)) patch(id, (x) => ({ ...x, cards: [...x.cards, e.data] }));
                  break;
                case 'error':
                  patch(id, (x) => ({ ...x, status: 'error', error: e.data.code === 'rate_limited' ? 'rateLimited' : e.data.code === 'ai_unavailable' ? 'unavailable' : 'generic' }));
                  break;
                case 'done':
                  // The guarded final text replaces what streamed (a sentence may have been removed).
                  patch(id, (x) => ({ ...x, answer: typeof e.data.content === 'string' ? e.data.content : x.answer, status: x.status === 'error' ? 'error' : 'done' }));
                  break;
                default:
                  break;
              }
            },
          },
        );
        patch(id, (x) => (x.status === 'writing' || x.status === 'lookingUp' ? { ...x, status: x.answer ? 'done' : 'error', error: x.answer ? undefined : 'generic' } : x));
      } catch (err) {
        if (controller.signal.aborted) return;
        const kind = errorKind(err);
        // The server did not accept the consent (a newer version of the line): ask again.
        if (kind === 'consent') setConsented(false);
        patch(id, (x) => ({ ...x, status: 'error', error: kind }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, locked, needsConsent, pageContext, patch],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };

  const close = () => {
    abortRef.current?.abort();
    setOpen(false);
  };

  const signup = signupHref(`${from}-assistant`);
  const chips = ['remote', 'pay', 'how'] as const;

  return (
    <>
      <button type="button" className={styles.launcher} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} data-visitor-assistant="launcher">
        {t('launcher')}
      </button>
      <Sheet open={open} onClose={close} title={t('title')} description={t('intro')} initialFocusRef={inputRef}>
        <div className={styles.assistant} data-visitor-assistant="panel">
          <p className={styles.muted}>{t('note')}</p>
          {needsConsent && (locked || turns.length === 0) ? (
            <div className={styles.field} data-visitor-consent={consented ? 'given' : 'needed'}>
              <label htmlFor={consentId} className={styles.check}>
                <input id={consentId} type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} disabled={busy} aria-describedby={consentDetailId} />
                <span>{t('consent.label')}</span>
              </label>
              <p className={styles.muted} id={consentDetailId}>
                {t('consent.detail')} <Link href={brand.legal.privacyPath}>{t('consent.privacyLink')}</Link>
              </p>
            </div>
          ) : null}
          {turns.length === 0 ? (
            <ul className={styles.chips}>
              {chips.map((c) => (
                <li key={c}>
                  <button type="button" className={styles.chip} onClick={() => void ask(t(`chips.${c}`))} disabled={busy || locked}>
                    {t(`chips.${c}`)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <ol className={styles.turns} aria-live="polite">
            {turns.map((turn) => (
              <li key={turn.id} className={styles.turn}>
                <p className={styles.question}>
                  <span className="sr-only">{t('you')}: </span>
                  {turn.question}
                </p>
                <div className={styles.answer}>
                  <p className={styles.answerLabel}>
                    <span>{t('aiLabel')}</span>
                    <AiGeneratedBadge kind="text" />
                  </p>
                  {turn.answer ? <p className={styles.answerText}>{turn.answer}</p> : null}
                  {turn.status === 'writing' && !turn.answer ? (
                    <p className={styles.muted} role="status">
                      {t('writing')}
                    </p>
                  ) : null}
                  {turn.status === 'lookingUp' ? (
                    <p className={styles.muted} role="status">
                      {t('lookingUp')}
                    </p>
                  ) : null}
                  {turn.cards.map((card) =>
                    card.type === 'job_list' ? <JobsCard key={card.id} card={card} /> : <CopilotCardView key={card.id} card={card} ctx={{ onNavigate: close }} />,
                  )}
                  {turn.status === 'error' ? (
                    <div className={styles.notice} role="alert">
                      <p className={styles.body}>{t(`errors.${turn.error ?? 'generic'}`)}</p>
                      {turn.error === 'rateLimited' ? (
                        <Link href={signup} className={styles.gateCta}>
                          {t('signupCta')}
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <form className={styles.composer} onSubmit={onSubmit}>
            <label htmlFor={inputId} className="sr-only">
              {t('inputLabel')}
            </label>
            <textarea
              id={inputId}
              ref={inputRef}
              className={styles.input}
              value={text}
              maxLength={1000}
              rows={2}
              placeholder={t('placeholder')}
              disabled={locked}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(text);
                }
              }}
            />
            <Btn type="submit" variant="primary" disabled={busy || locked || !text.trim()}>
              {t('send')}
            </Btn>
          </form>
        </div>
      </Sheet>
    </>
  );
}
