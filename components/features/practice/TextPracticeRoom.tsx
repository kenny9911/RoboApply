'use client';

// TextPracticeRoom — the written practice interview (TASK_PLAN.md WP-43;
// CN_TW_LAUNCH_PLAN.md: "absent voice credentials → text practice").
//
// Used when live voice practice is not available for the brand (GoApply with
// `ai.interviewVoice` off). It runs the written interview through the
// first-party practice routes (`textPracticeApi`: start → next-turn per answer
// → score), one question at a time. The server checks the brand gate, loads
// the job (`jobId`) itself and meters the practice; a refused start (402, the
// gate, an unknown job) goes back to the setup page through `onStartRefused`.
// An answered, scored practice ticks the getting-started checklist and the
// job's "Practiced" step on the server; this refreshes the checklist and the
// credit balance. The interviewer's text and the result are AI output, so each
// block carries AiGeneratedBadge (it renders only on GoApply). The score line
// says what it is: a score of this practice, not a prediction.

import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { AiGeneratedBadge } from '../market';
import {
  textPracticeApi,
  type TextPracticeQuestion,
  type TextPracticeScore,
  type TextPracticeTurn,
} from '../../../lib/api/interviewEngine';
import { refreshChecklist } from '../../../hooks/growth';
import { accountKeys } from '../../../hooks/useAccount';
import styles from './practice.module.css';

export interface TextPracticeRoomProps {
  role: string;
  interviewerId: string;
  typeId: string;
  language?: string;
  durationMinutes?: number;
  /** The job this practice is for (the server loads it and seeds the interview). */
  jobId?: string | null;
  /**
   * A start the server refused for a reason the setup page shows (out of
   * credits, the GoApply gate, an unknown job). Return true when handled: the
   * room then leaves without its own retry.
   */
  onStartRefused?: (err: unknown) => boolean;
  /** Leave the room (back to the setup). */
  onExit: () => void;
}

type Phase = 'starting' | 'answering' | 'scoring' | 'done' | 'error';

export function TextPracticeRoom({
  role,
  interviewerId,
  typeId,
  language,
  durationMinutes,
  jobId,
  onStartRefused,
  onExit,
}: TextPracticeRoomProps) {
  const t = useTranslations('practice.text');
  const queryClient = useContext(QueryClientContext);
  const answerId = useId();
  const [phase, setPhase] = useState<Phase>('starting');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<TextPracticeQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [turns, setTurns] = useState<TextPracticeTurn[]>([]);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [finished, setFinished] = useState(false);
  const [score, setScore] = useState<TextPracticeScore | null>(null);
  const [failedStep, setFailedStep] = useState<'start' | 'turn' | 'score' | null>(null);
  const startedRef = useRef(false);

  const start = useCallback(async () => {
    setPhase('starting');
    setFailedStep(null);
    try {
      const res = await textPracticeApi.start({
        role,
        interviewerId,
        typeId,
        language,
        durationMinutes,
        jobId: jobId ?? null,
      });
      setSessionId(res.sessionId);
      setQuestions(res.questions ?? []);
      setIndex(0);
      setTurns([]);
      setFinished((res.questions ?? []).length === 0);
      setPhase('answering');
    } catch (err) {
      if (onStartRefused?.(err)) return;
      setFailedStep('start');
      setPhase('error');
    }
  }, [role, interviewerId, typeId, language, durationMinutes, jobId, onStartRefused]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  async function send(text: string) {
    if (!sessionId || sending) return;
    setSending(true);
    try {
      const res = await textPracticeApi.nextTurn({ sessionId, answer: text, questionIndex: index });
      setTurns((prev) => [
        ...prev,
        ...(text.trim() ? [{ who: 'you' as const, text: text.trim() }] : []),
        ...(res.turns ?? []),
      ]);
      setAnswer('');
      if (res.nextIndex === null || res.nextIndex >= questions.length) setFinished(true);
      else setIndex(res.nextIndex);
    } catch {
      setFailedStep('turn');
    } finally {
      setSending(false);
    }
  }

  async function finish() {
    if (!sessionId) return;
    setPhase('scoring');
    setFailedStep(null);
    try {
      const result = await textPracticeApi.score(sessionId);
      setScore(result);
      setPhase('done');
      if (queryClient) {
        // The practice was metered; an answered one also ticked the checklist.
        void queryClient.invalidateQueries({ queryKey: accountKeys.credits() });
        if (result.practiceCounted) void refreshChecklist(queryClient).catch(() => undefined);
      }
    } catch {
      setFailedStep('score');
      setPhase('answering');
    }
  }

  const current = questions[index] ?? null;

  return (
    <section className={styles.room} aria-labelledby="text-practice-title">
      <header className={styles.roomHead}>
        <h1 id="text-practice-title">{t('title')}</h1>
        <p>{t('intro')}</p>
      </header>

      {phase === 'starting' ? (
        <p className={styles.muted} role="status" aria-live="polite">{t('starting')}</p>
      ) : null}

      {phase === 'error' ? (
        <div className={styles.card} role="alert">
          <p>{t('error')}</p>
          <div className={styles.actions}>
            <Btn variant="primary" onClick={() => void start()}>{t('retry')}</Btn>
            <Btn onClick={onExit}>{t('exit')}</Btn>
          </div>
        </div>
      ) : null}

      {phase === 'answering' || phase === 'scoring' ? (
        <>
          {turns.length > 0 ? (
            <ul className={styles.turns} aria-live="polite">
              {turns.map((turn, i) => (
                <li key={i} className={`${styles.turn} ${turn.who === 'you' ? styles.turnYou : ''}`}>
                  <strong>{turn.who === 'you' ? t('you') : t('interviewer')}</strong>
                  {turn.text}
                </li>
              ))}
            </ul>
          ) : null}

          {!finished && current ? (
            <div className={styles.card}>
              <p className={styles.cardLabel}>{t('question', { n: index + 1, total: questions.length })}</p>
              <p className={styles.question}>{current.q}</p>
              <AiGeneratedBadge />
              {current.hint ? <p className={styles.muted}>{t('hint')}: {current.hint}</p> : null}
              <label className={styles.cardLabel} htmlFor={answerId}>{t('answerLabel')}</label>
              <textarea
                id={answerId}
                className={styles.textarea}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                disabled={sending}
              />
              <div className={styles.actions}>
                <Btn variant="primary" onClick={() => void send(answer)} disabled={sending || !answer.trim()}>
                  {sending ? t('sending') : t('send')}
                </Btn>
                <Btn onClick={() => void send('')} disabled={sending}>{t('skip')}</Btn>
              </div>
            </div>
          ) : null}

          {failedStep === 'turn' || failedStep === 'score' ? (
            <p className={styles.error} role="alert">{t('error')}</p>
          ) : null}

          {finished || !current ? (
            <div className={styles.actions}>
              <Btn variant="primary" onClick={() => void finish()} disabled={phase === 'scoring'}>
                {phase === 'scoring' ? t('scoring') : t('finish')}
              </Btn>
            </div>
          ) : null}
        </>
      ) : null}

      {phase === 'done' && score ? (
        <div className={styles.card} aria-labelledby="text-practice-result">
          <h2 id="text-practice-result" className={styles.question}>{t('resultTitle')}</h2>
          <AiGeneratedBadge />
          <p className={styles.score}>
            <span className={styles.cardLabel}>{t('overall')}</span>{' '}
            <strong>{Math.max(0, Math.min(100, Math.round(score.overall)))}</strong>
            <span>/100</span>
          </p>
          {score.strengths.length > 0 ? (
            <>
              <h3 className={styles.cardLabel}>{t('strengths')}</h3>
              <ul className={styles.list}>{score.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul>
            </>
          ) : null}
          {score.gaps.length > 0 ? (
            <>
              <h3 className={styles.cardLabel}>{t('gaps')}</h3>
              <ul className={styles.list}>{score.gaps.map((item, i) => <li key={i}>{item}</li>)}</ul>
            </>
          ) : null}
          <p className={styles.reportNote}>{t('scoreNote')}</p>
          <div className={styles.actions}>
            <Btn variant="primary" onClick={() => { startedRef.current = true; void start(); setScore(null); }}>
              {t('again')}
            </Btn>
            <Btn onClick={onExit}>{t('exit')}</Btn>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default TextPracticeRoom;
