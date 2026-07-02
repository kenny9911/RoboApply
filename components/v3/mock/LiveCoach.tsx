'use client';

// LiveCoach — the in-room COACH layer for the real-time interview (the "COACH
// HINT" box + the "YOUR COACH · LIVE" nudge + live answer meters from the V3
// design). Gated by Coach Mode. The live engine is CONVERSATIONAL (no fixed
// "Question N/5"), so the coach derives the CURRENT question (last interviewer
// turn) and the ANSWER-so-far (your turns since) straight from the LiveKit
// transcript, then:
//   • fetches a one-line strategy HINT when a new question lands, and
//   • fetches a one-line live NUDGE as you answer (debounced + throttled),
//   • computes zero-latency client-side meters (timer · pace · fillers ·
//     specifics) and surfaces what this interviewer is listening for.
// All LLM text routes through the sanitized Markdown primitive (CLAUDE.md rule).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { IconSparkle, IconX, IconClock, IconBolt, IconCheck } from '../primitives/Iconset';
import { Markdown } from '../primitives/Markdown';
import { interviewEngineApi, type IECoachTip, type IESessionDetail } from '../../../lib/api/interviewEngine';
import type { RAMockTurn } from '../../../lib/api/v2/types';

// ── Derive (current question, answer-so-far) from the live transcript ──────────
function deriveQA(turns: RAMockTurn[]): { question: string; answer: string } {
  let lastThem = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].who === 'them') { lastThem = i; break; }
  }
  if (lastThem < 0) return { question: '', answer: '' };
  let start = lastThem;
  while (start - 1 >= 0 && turns[start - 1].who === 'them') start--;
  const question = turns.slice(start, lastThem + 1).map((t) => t.text).join(' ').trim();
  const answer = turns.slice(lastThem + 1).filter((t) => t.who === 'you').map((t) => t.text).join(' ').trim();
  return { question, answer };
}

// Hedging / filler words across the live interview languages (en/zh/ja).
const HEDGE_RE =
  /\b(?:u[mh]+|like|you know|sort of|kind of|i guess|i mean|basically|actually|literally|maybe|sometimes|i think|just)\b|嗯+|那个|就是说|就是|可能|也许|大概|应该是|好像|其实|然后|怎么说|えーと|ええと|あの|まあ|たぶん|なんか/giu;

export interface CoachMetrics {
  words: number;
  seconds: number;
  wpm: number | null;
  hedges: number;
  specifics: number;
}

function computeMetrics(answer: string, startTs: number | null, now: number): CoachMetrics {
  const latin = (answer.match(/[A-Za-z0-9']+/g) || []).length;
  const cjk = (answer.match(/[぀-ヿ一-鿿]/g) || []).length;
  const words = latin + Math.round(cjk / 1.7);
  const seconds = startTs ? Math.max(0, (now - startTs) / 1000) : 0;
  const wpm = seconds >= 4 && words > 0 ? Math.round(words / (seconds / 60)) : null;
  const hedges = (answer.match(HEDGE_RE) || []).length;
  const specifics = (answer.match(/\d+(?:[.,]\d+)?/g) || []).length;
  return { words, seconds, wpm, hedges, specifics };
}

export interface UseLiveCoachResult {
  question: string;
  hint: IECoachTip | null;
  hintLoading: boolean;
  nudge: IECoachTip | null;
  dismissNudge: () => void;
  metrics: CoachMetrics;
  listeningFor: string[];
}

/** Drives the live coach: question/answer derivation, debounced LLM hint+nudge
 *  fetches, and zero-latency client metrics. Inert when `enabled` is false. */
export function useLiveCoach(args: {
  sessionId: string;
  transcript: RAMockTurn[];
  session: IESessionDetail;
  enabled: boolean;
}): UseLiveCoachResult {
  const { sessionId, transcript, session, enabled } = args;
  const { question, answer } = useMemo(() => deriveQA(transcript), [transcript]);

  const [hint, setHint] = useState<IECoachTip | null>(null);
  const [hintLoading, setHintLoading] = useState(false);
  const [nudge, setNudge] = useState<IECoachTip | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [tick, setTick] = useState(0);

  const lastHintQRef = useRef('');
  const answerStartRef = useRef<number | null>(null);
  const lastNudgeAtRef = useRef(0);
  const lastNudgeLenRef = useRef(0);

  // New question → reset the per-answer coach state.
  useEffect(() => {
    setNudge(null);
    setNudgeDismissed(false);
    answerStartRef.current = null;
    lastNudgeLenRef.current = 0;
  }, [question]);

  // Mark when the answer to THIS question started (for the timer/pace).
  useEffect(() => {
    if (answer && answerStartRef.current == null) answerStartRef.current = Date.now();
  }, [answer]);

  // 1s tick so the timer/pace stay live even while the candidate pauses.
  useEffect(() => {
    if (!enabled) return;
    const h = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(h);
  }, [enabled]);

  // HINT: fetch once per distinct, settled question.
  useEffect(() => {
    if (!enabled) { setHint(null); return; }
    const q = question.trim();
    if (!q || q === lastHintQRef.current) return;
    const handle = window.setTimeout(() => {
      if (question.trim() !== q) return; // still streaming → wait for next settle
      lastHintQRef.current = q;
      setHint(null);
      setHintLoading(true);
      interviewEngineApi
        .coach(sessionId, { mode: 'hint', question: q })
        .then((r) => setHint(r.coach))
        .catch(() => undefined)
        .finally(() => setHintLoading(false));
    }, 1300);
    return () => window.clearTimeout(handle);
  }, [question, enabled, sessionId]);

  // NUDGE: react to the answer-so-far, debounced + throttled, only on real growth.
  useEffect(() => {
    if (!enabled) return;
    const a = answer.trim();
    if (a.length < 60) return;
    const handle = window.setTimeout(() => {
      const now = Date.now();
      if (now - lastNudgeAtRef.current < 10000) return; // throttle: ≥10s apart
      if (a.length - lastNudgeLenRef.current < 40) return; // need meaningful growth
      lastNudgeAtRef.current = now;
      lastNudgeLenRef.current = a.length;
      interviewEngineApi
        .coach(sessionId, { mode: 'nudge', question: question.trim(), answer: a })
        .then((r) => { if (r.coach) { setNudge(r.coach); setNudgeDismissed(false); } })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearTimeout(handle);
  }, [answer, enabled, sessionId, question]);

  const metrics = useMemo(
    () => computeMetrics(answer, answerStartRef.current, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answer, tick],
  );

  // What this interviewer is listening for — already role-specific + in-language
  // from the blueprint (success signals → focus areas as a fallback).
  const listeningFor = useMemo(() => {
    const sig = session.requirements?.successSignals;
    const focus = session.characteristics?.focusAreas;
    return (sig && sig.length ? sig : focus ?? []).slice(0, 3);
  }, [session]);

  const dismissNudge = useCallback(() => setNudgeDismissed(true), []);

  return {
    question,
    hint,
    hintLoading,
    nudge: nudgeDismissed ? null : nudge,
    dismissNudge,
    metrics,
    listeningFor,
  };
}

// ── Left stage: current question + COACH HINT ─────────────────────────────────
export function LiveQuestionCard({
  question, hint, hintLoading, hintOpen, onToggleHint,
}: {
  question: string;
  hint: IECoachTip | null;
  hintLoading: boolean;
  hintOpen: boolean;
  onToggleHint: () => void;
}) {
  const t = useTranslations('ie');
  return (
    <div className="iv-question" style={{ marginTop: 12 }}>
      <div className="iv-question-num">{t('live.coach.currentQuestion')}</div>
      <div className="iv-question-text">
        {question ? <Markdown>{question}</Markdown> : <span style={{ color: 'var(--text-2)' }}>{t('live.coach.awaitingQuestion')}</span>}
      </div>
      <div className="iv-question-actions">
        <button type="button" className="btn ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={onToggleHint}>
          <IconSparkle size={12} />
          {hintOpen ? t('live.coach.hideHint') : t('live.coach.showHint')}
        </button>
      </div>
      {hintOpen ? (
        <div className="iv-hint">
          <span className="iv-hint-lbl">{t('live.coach.coachHint')}</span>
          {hint ? (
            <Markdown>{hint.text}</Markdown>
          ) : (
            <span style={{ color: 'var(--text-2)' }}>{hintLoading ? t('live.coach.thinking') : t('live.coach.noHint')}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Right stage: the live coach nudge (YOUR COACH · LIVE) ──────────────────────
export function LiveCoachNudge({ tip, onDismiss }: { tip: IECoachTip; onDismiss: () => void }) {
  const t = useTranslations('ie');
  return (
    <div className={`iv-coach ${tip.kind === 'careful' ? 'careful' : ''}`} style={{ marginTop: 12 }}>
      <div className="iv-coach-orb" />
      <div className="iv-coach-body">
        <div className="iv-coach-lbl">{t('live.coach.coachLive')}</div>
        <div className="iv-coach-text"><Markdown>{tip.text}</Markdown></div>
      </div>
      <button type="button" className="iv-coach-close" onClick={onDismiss} aria-label={t('live.coach.dismiss')}>
        <IconX size={11} />
      </button>
    </div>
  );
}

// ── Right stage: zero-latency answer meters + listening-for chips ──────────────
function paceTone(wpm: number | null): 'good' | 'warn' | 'muted' {
  if (wpm == null) return 'muted';
  if (wpm < 90 || wpm > 195) return 'warn';
  return 'good';
}
function fmtTime(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Stat({ label, value, tone, icon }: { label: string; value: string; tone: 'good' | 'warn' | 'muted'; icon?: React.ReactNode }) {
  return (
    <div className={`iv-cm-stat ${tone}`}>
      <div className="v">{icon}{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function CoachMeters({ metrics, listeningFor }: { metrics: CoachMetrics; listeningFor: string[] }) {
  const t = useTranslations('ie');
  const answering = metrics.seconds > 0;
  return (
    <div className="iv-cmeters">
      {listeningFor.length > 0 ? (
        <div className="iv-cm-listen">
          <div className="iv-cm-listen-lbl">{t('live.coach.listeningFor')}</div>
          <div className="iv-cm-chips">
            {listeningFor.map((s, i) => (
              <span key={i} className="iv-cm-chip">{s}</span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="iv-cm-stats">
        <Stat
          label={t('live.coach.answerTime')}
          value={answering ? fmtTime(metrics.seconds) : '—'}
          tone={metrics.seconds > 90 ? 'warn' : answering ? 'good' : 'muted'}
          icon={<IconClock size={11} />}
        />
        <Stat
          label={t('live.coach.pace')}
          value={metrics.wpm != null ? `${metrics.wpm}` : '—'}
          tone={paceTone(metrics.wpm)}
          icon={<IconBolt size={11} />}
        />
        <Stat
          label={t('live.coach.fillers')}
          value={answering ? `${metrics.hedges}` : '—'}
          tone={metrics.hedges >= 4 ? 'warn' : answering ? 'good' : 'muted'}
        />
        <Stat
          label={t('live.coach.specifics')}
          value={answering ? `${metrics.specifics}` : '—'}
          tone={metrics.specifics > 0 ? 'good' : 'muted'}
          icon={metrics.specifics > 0 ? <IconCheck size={11} /> : undefined}
        />
      </div>
    </div>
  );
}

// ── Coach Mode toggle (controls row) ──────────────────────────────────────────
export function CoachToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const t = useTranslations('ie');
  return (
    <button
      type="button"
      className={`btn ${on ? 'coach-on' : 'ghost'}`}
      onClick={onToggle}
      aria-pressed={on}
      title={t('live.coach.coachModeHint')}
    >
      <IconSparkle size={12} />
      {t('live.coach.coachMode')} · {on ? t('live.coach.on') : t('live.coach.off')}
    </button>
  );
}
