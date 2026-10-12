// backend/src/roboapply/v2/services/RAMockService.ts
//
// RoboApply V3 — Mock interview service. Backs the five `mock.*` endpoints:
//
//   catalog()                       → MockCatalogResponse     (STATIC)
//   recentSessions(userId)          → MockRecentSessionsResponse
//   start(userId, body)             → MockStartResponse
//   nextTurn(userId, body)          → MockNextTurnResponse
//   score(userId, sessionId)        → MockScoreResponse
//
// Shapes match `roboapply/lib/api/v2/types.ts` exactly (and the stub in
// `roboapply/lib/stub/raV2.stub.ts`). The frontend + `_real.ts` need no
// change once the route swaps from stub-delegation to a real fetch.
//
// Persistence: one `RAMockSession` row per run (Prisma table already created).
//   - start    : create the row (status 'in_progress'), store role / persona /
//                type / format and the generated `questions`.
//   - nextTurn : append { who:'you', text:answer } + the interviewer's
//                generated `turns` to `transcript`; persist.
//   - score    : mark the row 'complete', persist overall / breakdown /
//                strengths / gaps / note / durationMinutes; compute `delta` vs
//                the user's previous completed session.
//
// LLM: the question plan + per-turn follow-ups come from
// `RAMockInterviewerAgent` (configured interview model, persona-aware). The SCORE is the
// engine's deterministic text-check scorer (interview-engine/scoring/interviewScorer:
// localized to the session language, CJK-aware) — robust, free, and never 500s. It is
// told how many questions went unanswered, so a skipped question is counted and named. Mock is
// NOT a billed SKU yet (no quota gating / no UsageDeductionLog row); if it
// becomes one, gate `start`/`nextTurn` through `lib/matchBilling`-style
// primitives and note it here.
//
// Graceful degradation: when the LLM is unconfigured / errors / returns an
// empty parse, `start` falls back to a deterministic per-type question bank and
// `nextTurn` falls back to a canned interviewer turn, so every endpoint returns
// a valid shape with no LLM key.
//
// WRITTEN practice: every exchange here is typed (the candidate reads a
// question and sends text). The model is told so on every call — in the type
// line of the question plan and at the top of each turn's brief — because the
// catalog's type and persona lines describe live formats ("shared editor",
// "whiteboard") and would otherwise produce "stay off the keyboard" or
// microphone wording in a text box.
//
// GoApply (WP-66): the cn market lists its AI-interview practice format first
// (`catalog('cn')`); `start` passes the job post, the market and the session
// id (the question-selection seed) to the prompt generator, which then runs
// the format's script and saves its timing plan on `blueprint.cnFormat`; and
// `score` adds the `cn` report block (communication / logic / story answers,
// STAR and filler-word checks — text checks only, no model). RoboApply is
// unchanged: no market format, no `cn` block.
//
// Ownership: every session-scoped method loads `{ id, userId }` and 404s
// otherwise (single-user product — no team scope; see raVisibility.ts).

import { randomUUID } from 'node:crypto';
import prisma from '../../../lib/prisma.js';
import { getCurrentBrandId, getCurrentRequestId } from '../../../lib/requestContext.js';
import { getBrand } from '../../../platform/brand/index.js';
import {
  CN_AI_INTERVIEW_FORMAT_ID,
  buildCnPracticeReport,
  normalizeCnTurns,
  type CnPracticeReport,
} from '../../../features/cn/interview/index.js';
import { logger } from '../../../services/LoggerService.js';
import {
  catalogForMarket,
  findAnyType,
  findInterviewer,
  findType,
  interviewerNameFor,
  typeLabelFor,
  type RAMockCatalog,
  type RAMockMarket,
} from '../lib/raMockCatalog.js';
import {
  RAMockInterviewerAgent,
  type RAMockCoachTip,
  type RAMockPersona,
  type RAMockQuestion,
  type RAMockTurn,
  type RAMockTypeContext,
} from '../agents/RAMockInterviewerAgent.js';
import { raInterviewPromptService } from './RAInterviewPromptService.js';
import { normalizeRaLocale } from '../lib/raLocale.js';
import { normalizeScorerLocale, scoreTranscript } from '../../../interview-engine/scoring/interviewScorer.js';
import type { TranscriptTurn } from '../../../interview-engine/types.js';

// ─── Wire types (mirror roboapply/lib/api/v2/types.ts exactly) ────────────

export type RAMockFormat = 'video' | 'voice';

export interface RAMockSessionSummary {
  id: string;
  role: string;
  interviewerName: string;
  typeLabel: string;
  /** 0..100 */
  score: number;
  /** "2 days ago" */
  when: string;
  note: string;
}

export interface MockCatalogResult {
  catalog: RAMockCatalog;
}

export interface MockRecentSessionsResult {
  sessions: RAMockSessionSummary[];
}

/** Per-question timing of the GoApply AI-interview format, in question order. */
export interface MockCnFormatTiming {
  formatId: string;
  minutes: number;
  questions: Array<{ prepSeconds: number; answerSeconds: number; story: boolean }>;
}

export interface MockStartResult {
  sessionId: string;
  questions: Array<{ q: string; hint: string; coachTip: RAMockCoachTip }>;
  /** Only when the session runs the GoApply AI-interview format (one entry per question). */
  cnFormat?: MockCnFormatTiming | null;
}

export interface MockNextTurnResult {
  /** next question index, or null when the interview is over */
  nextIndex: number | null;
  turns: RAMockTurn[];
  coachTip: RAMockCoachTip | null;
}

export interface MockScoreResult {
  /** 0..100 */
  overall: number;
  /** delta vs last session, e.g. +11 */
  delta: number | null;
  breakdown: Array<{ key: string; value: number; note: string }>;
  strengths: string[];
  gaps: string[];
  durationMinutes: number;
  /** GoApply only: the practice report block (text checks; no model). */
  cn?: CnPracticeReport;
}

// ─── Request shapes ───────────────────────────────────────────────────────

export interface MockStartInput {
  role: string;
  interviewerId: string;
  typeId: string;
  format: RAMockFormat;
  /** BCP-47 interview language (defaults to the request locale / 'en'). */
  language?: string;
  /** Planned interview length in minutes (defaults to the type's minutes). */
  durationMinutes?: number;
  /** The job post the practice is for; given to the question plan as evidence. */
  jdText?: string;
  /** The brand's market; defaults to the request's brand (intl when none). */
  market?: RAMockMarket;
  /** The RAJob the practice was started from (already market-checked by the caller). */
  jobId?: string | null;
}

export interface MockNextTurnInput {
  sessionId: string;
  /** the candidate's answer to the current question (may be empty on skip) */
  answer: string;
  /** current question index */
  questionIndex: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class MockValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MockValidationError';
  }
}

export class MockSessionNotFoundError extends Error {
  constructor() {
    super('Mock session not found');
    this.name = 'MockSessionNotFoundError';
  }
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_QUESTION_COUNT = 5;

/** Job post text handed to the generator (the engine's own cap). */
const JD_TEXT_MAX_CHARS = 8000;

/**
 * Put first in the type line handed to the question plan and the interviewer.
 * Short on purpose: the agents keep only the first 200 characters of that
 * line, and the longest type description in the catalog (GoApply's format) is
 * 103 characters, so the note has to leave room for it.
 */
export const WRITTEN_PRACTICE_TYPE_NOTE =
  'WRITTEN practice: answers are typed. Never mention voice, video, microphones or a shared editor.';

/** What the interviewer agent keeps of the type line and of a turn's brief. */
export const AGENT_TYPE_LINE_MAX_CHARS = 200;
export const AGENT_BRIEF_MAX_CHARS = 2000;

/**
 * Put first in the brief of every interviewer turn. One sentence: the agent
 * keeps 2,000 characters of the brief and a generated session brief can be
 * longer than that, so every character here is taken from the end of the
 * session's own brief (its adaptation rules and format line).
 */
export const WRITTEN_PRACTICE_BRIEF =
  'Written practice: the candidate types every answer. No audio, video, microphone or shared editor; never refer to them or to waiting before typing.';

/** The type as the model sees it in a written practice: the note, then the type's own line. */
function writtenTypeContext(type: { id: string; label: string; sub: string }): RAMockTypeContext {
  return { id: type.id, label: type.label, sub: `${WRITTEN_PRACTICE_TYPE_NOTE} ${type.sub}` };
}

/** The turn brief of a written practice: the medium first, then the session's own brief (when it has one). */
function writtenBrief(sessionBrief: string | undefined): string {
  return sessionBrief ? `${WRITTEN_PRACTICE_BRIEF}\n${sessionBrief}` : WRITTEN_PRACTICE_BRIEF;
}

/** The market of the request's brand; intl when there is no brand context. */
function currentMarket(): RAMockMarket {
  try {
    const id = getCurrentBrandId();
    return id && getBrand(id).market === 'cn' ? 'cn' : 'intl';
  } catch {
    return 'intl';
  }
}

/**
 * The timing plan saved by the generator (`blueprint.cnFormat`), when it has
 * one entry per question. Anything else (no plan, a fallback question set of
 * another length) is null, so the UI never shows a timing for the wrong question.
 */
function cnTimingFrom(blueprint: unknown, questionCount: number): MockCnFormatTiming | null {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) return null;
  const plan = (blueprint as Record<string, unknown>).cnFormat;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const p = plan as Record<string, unknown>;
  if (!Array.isArray(p.questions) || p.questions.length !== questionCount || questionCount === 0) return null;
  const questions: MockCnFormatTiming['questions'] = [];
  for (const row of p.questions) {
    const r = (row ?? {}) as Record<string, unknown>;
    const prep = Number(r.prepSeconds);
    const answer = Number(r.answerSeconds);
    if (!Number.isFinite(prep) || prep < 0 || !Number.isFinite(answer) || answer <= 0) return null;
    questions.push({ prepSeconds: Math.round(prep), answerSeconds: Math.round(answer), story: r.story === true });
  }
  return {
    formatId: typeof p.formatId === 'string' && p.formatId ? p.formatId : CN_AI_INTERVIEW_FORMAT_ID,
    minutes: Number.isFinite(Number(p.minutes)) ? Math.round(Number(p.minutes)) : 0,
    questions,
  };
}

/** True when the stored blueprint carries the AI-interview format plan. */
function hasCnFormatPlan(blueprint: unknown): boolean {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) return false;
  const plan = (blueprint as Record<string, unknown>).cnFormat;
  return !!plan && typeof plan === 'object' && !Array.isArray(plan);
}

/** Clamp a requested interview duration to a sane 5..120 minute window. */
function clampDurationMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  if (n < 5) return 5;
  if (n > 120) return 120;
  return n;
}

/** Pull a condensed interviewer brief out of a stored blueprint Json blob. */
function briefFromBlueprint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const b = (value as Record<string, unknown>).interviewerBrief;
  return typeof b === 'string' && b.trim() ? b : undefined;
}

// ─── Deterministic question bank (graceful degradation) ───────────────────
//
// One ordered set per interview TYPE, used when the LLM is unconfigured /
// errors / returns an empty plan. Each entry mirrors the wire shape
// { q, hint, coachTip }. Ported in spirit from the proto SAMPLE_QUESTIONS for
// the behavioral set; the others are type-appropriate analogues.

const FALLBACK_BANK: Record<string, RAMockQuestion[]> = {
  behavioral: [
    {
      q: "Walk me through a decision you made that you'd reverse today. Why?",
      hint: 'Lean into the reversal — interviewers want self-awareness, not perfect outcomes.',
      coachTip: { kind: 'good', text: 'Good specifics. Now name the metric that proved you wrong.' },
    },
    {
      q: 'Tell me about a time you disagreed with your manager. How did it resolve?',
      hint: "Don't go too soft. They want to see you stand on a real position.",
      coachTip: { kind: 'careful', text: "Use a concrete moment, not 'sometimes I…'." },
    },
    {
      q: 'Describe a project that failed. What did you own and what did you learn?',
      hint: 'Own your part explicitly — deflecting reads as low accountability.',
      coachTip: { kind: 'careful', text: "Say 'I' more than 'we' when describing your contribution." },
    },
    {
      q: 'Tell me about a time you influenced a team without formal authority.',
      hint: 'Show the mechanism — data, a prototype, a 1:1 — not just the outcome.',
      coachTip: { kind: 'good', text: 'Name the specific tactic that turned the room.' },
    },
    {
      q: 'When have you had to deliver under a hard deadline with limited resources?',
      hint: 'Talk tradeoffs out loud, then state what you cut and why.',
      coachTip: { kind: 'good', text: 'Commit to the call — show you can prioritize.' },
    },
  ],
  technical: [
    {
      q: 'Given an array of integers, find the two numbers that add up to a target. Talk me through your approach.',
      hint: 'State brute force, then optimize — narrate the time/space tradeoff.',
      coachTip: { kind: 'good', text: 'Say the complexity out loud before you code.' },
    },
    {
      q: 'How would you detect a cycle in a linked list?',
      hint: 'Mention the two-pointer idea and why it works.',
      coachTip: { kind: 'careful', text: "Don't jump to code — explain the invariant first." },
    },
    {
      q: 'Walk me through how a hash map handles collisions.',
      hint: 'Cover load factor + at least one resolution strategy.',
      coachTip: { kind: 'good', text: 'Tie it back to real performance characteristics.' },
    },
    {
      q: 'Design a function to validate balanced brackets in a string. Edge cases?',
      hint: 'Enumerate edge cases up front — empty, unmatched, nested.',
      coachTip: { kind: 'careful', text: 'List edge cases before the happy path.' },
    },
    {
      q: 'How would you make this solution thread-safe / production-ready?',
      hint: 'Talk about contention, immutability, and where you would add tests.',
      coachTip: { kind: 'good', text: 'Name the failure mode you are guarding against.' },
    },
  ],
  system: [
    {
      q: 'Design a URL shortener. Start with the requirements you would clarify.',
      hint: 'Clarify scale + read/write ratio before drawing boxes.',
      coachTip: { kind: 'good', text: 'State your assumptions explicitly up front.' },
    },
    {
      q: 'How do you handle the read path at 100k QPS?',
      hint: 'Reach for caching + a CDN, and justify the eviction policy.',
      coachTip: { kind: 'careful', text: 'Get to the bottleneck faster — name it.' },
    },
    {
      q: 'Where is your single point of failure, and how do you remove it?',
      hint: 'Walk replication + failover, and the consistency cost.',
      coachTip: { kind: 'good', text: 'Acknowledge the CAP tradeoff you are making.' },
    },
    {
      q: 'How would you generate unique short keys without collisions at scale?',
      hint: 'Compare counter-based vs hashing, and the coordination cost.',
      coachTip: { kind: 'good', text: 'Quantify the keyspace you need.' },
    },
    {
      q: 'What metrics and alarms would you add before launch?',
      hint: 'Pick the few SLOs that actually matter, not a dashboard wall.',
      coachTip: { kind: 'careful', text: 'Tie each metric to a user-facing symptom.' },
    },
  ],
  case: [
    {
      q: 'Our activation rate dropped 15% last month. How would you diagnose it?',
      hint: 'Segment before theorizing — cohort, platform, funnel step.',
      coachTip: { kind: 'good', text: 'Form a hypothesis, then say how you would test it.' },
    },
    {
      q: 'How would you prioritize between three features your team proposed?',
      hint: 'Name a framework, then apply it to the actual options.',
      coachTip: { kind: 'careful', text: "Don't fence-sit — make the call." },
    },
    {
      q: 'Size the market for this product. Walk me through your math.',
      hint: 'State assumptions out loud; the structure matters more than the number.',
      coachTip: { kind: 'good', text: 'Sanity-check your final number against reality.' },
    },
    {
      q: 'A key metric and a guardrail metric conflict. How do you decide?',
      hint: 'Make the tradeoff explicit and pick a defensible bar.',
      coachTip: { kind: 'careful', text: 'Define what "too far" looks like before deciding.' },
    },
    {
      q: 'How would you measure the success of the change you just proposed?',
      hint: 'Pick a leading + a lagging indicator.',
      coachTip: { kind: 'good', text: 'Name the metric you would ship behind.' },
    },
  ],
  culture: [
    {
      q: 'Why this company, specifically?',
      hint: 'Reference something concrete — a shipped product, a value, a recent decision.',
      coachTip: { kind: 'good', text: 'Specific reference > generic mission talk.' },
    },
    {
      q: 'What kind of environment brings out your best work?',
      hint: 'Be honest — a real preference is more credible than "anything".',
      coachTip: { kind: 'careful', text: 'Avoid answers that fit every company.' },
    },
    {
      q: 'Tell me about a value you hold that has cost you something.',
      hint: 'Pick a real tradeoff — it shows the value is genuine.',
      coachTip: { kind: 'good', text: 'Concrete stakes make this land.' },
    },
    {
      q: 'How do you handle feedback you disagree with?',
      hint: 'Show you can hold the bar and stay coachable.',
      coachTip: { kind: 'careful', text: "Don't claim you always agree — that reads as hollow." },
    },
    {
      q: 'If we hired you tomorrow, what would you focus on in the first 30 days?',
      hint: "Pick one thing. Avoid the 'listen, learn, lead' cliché.",
      coachTip: { kind: 'careful', text: 'Pick one bet rather than the 30-60-90 framework.' },
    },
  ],
  panel: [
    {
      q: 'Give me the 60-second version of your background.',
      hint: 'Lead with the throughline, not a chronology.',
      coachTip: { kind: 'good', text: 'End on why you are here, now.' },
    },
    {
      q: 'Walk me through your proudest shipped result and your role in it.',
      hint: 'One project, real numbers, your specific contribution.',
      coachTip: { kind: 'good', text: 'Quantify the outcome.' },
    },
    {
      q: 'Quick one: a P0 surfaces in week 2 of a 6-week ship. What do you do?',
      hint: 'Talk tradeoffs, then commit to a recommendation.',
      coachTip: { kind: 'careful', text: "Don't fence-sit — make the call." },
    },
    {
      q: 'Where are you strongest, and where are you actively growing?',
      hint: 'A real growth area is more convincing than a humblebrag.',
      coachTip: { kind: 'careful', text: 'Pick a growth area you are visibly working on.' },
    },
    {
      q: 'Any questions for us?',
      hint: 'Ask something only this team could answer — shows you did the work.',
      coachTip: { kind: 'good', text: 'A sharp question is part of the evaluation.' },
    },
  ],
};

function fallbackQuestions(typeId: string, count: number): RAMockQuestion[] {
  const bank = FALLBACK_BANK[typeId] ?? FALLBACK_BANK.behavioral;
  // Clone so callers never mutate the constant.
  return bank.slice(0, Math.max(3, Math.min(count, bank.length))).map((q) => ({
    q: q.q,
    hint: q.hint,
    coachTip: { ...q.coachTip },
  }));
}

/**
 * A canned interviewer turn used when the agent fails on nextTurn.
 *
 * The canned lines exist in English only. In an English session they keep the
 * old generic-but-professional voice. In any other session language an English
 * sentence would be the wrong language, so the turn is just the next question
 * (already written in the session language), with no closing line and no tip.
 */
function fallbackTurns(
  answer: string,
  nextQuestion: string | null,
  language?: string | null,
): { turns: RAMockTurn[]; coachTip: RAMockCoachTip | null } {
  if (normalizeScorerLocale(language) !== 'en') {
    return { turns: nextQuestion ? [{ who: 'them', text: nextQuestion }] : [], coachTip: null };
  }
  const answered = answer.trim().length > 0;
  const turns: RAMockTurn[] = [];
  if (nextQuestion) {
    turns.push({
      who: 'them',
      text: answered
        ? `Thanks — that gives me a feel for it. Let me move us on: ${nextQuestion}`
        : `No problem, let's keep moving. ${nextQuestion}`,
    });
  } else {
    turns.push({
      who: 'them',
      text: answered
        ? "That's a good place to wrap. Thanks for walking me through all of that — I have what I need."
        : "Let's call it there. Thanks for your time today.",
    });
  }
  const coachTip: RAMockCoachTip | null = answered
    ? null
    : { kind: 'careful', text: 'A short answer is a missed rep — take a beat and give one concrete example.' };
  return { turns, coachTip };
}

// ─── Score input (the engine's text-check scorer does the scoring) ────────
//
// The score itself comes from interview-engine/scoring/interviewScorer: one
// scorer for the voice engine and the written practice, localized to the
// session language and CJK-aware. This file used to carry its own
// English-only copy that split answers on whitespace (a whole Chinese answer
// counted as one word, so every Chinese answer was "very short") and never saw
// a skipped question (a skip is an empty answer, and empty turns are dropped
// when the transcript is read back), so it reported "engaged with every
// prompt" after four skips out of five.

/** Interviewer personas are graded 1..3 here; the scorer's scale is 1..5 with 3 as "no penalty". */
const SCORER_DIFFICULTY_OFFSET = 2;

interface ScorerInput {
  /** One candidate turn per answered question, for the scorer. */
  turns: TranscriptTurn[];
  /** The stored transcript without re-sent answers (for the GoApply report block). */
  transcript: RAMockTurn[];
  /** Distinct planned questions that got a non-blank answer. */
  answered: number;
  unanswered: number;
}

/**
 * The transcript as the scorer reads it, and how many planned questions got
 * no answer.
 *
 * Questions are counted, not candidate turns. `nextTurn` appends an answer on
 * every call, and the room re-sends the same question when a request fails on
 * the client after the server stored it (a gateway timeout on the slow
 * interviewer call), so one question can hold the same answer twice. Counting
 * turns would then report a skipped question as answered. `nextTurn` records
 * the planned question in front of each answer, so each answer is filed under
 * the planned question that precedes it:
 *   - an answer identical to one already filed under that question is a
 *     re-send and is dropped (with the repeated question in front of it);
 *   - different answers to one question (an edited re-send) are scored as one
 *     answer, so the scorer's answer count equals the questions answered.
 * A skipped question leaves no answer, so `unanswered` is the plan's question
 * count minus the questions answered.
 */
function scorerInput(stored: RAMockTurn[], questions: RAMockQuestion[]): ScorerInput {
  const planned = questions.map((q) => q.q.trim());
  /** The planned question this text is, looking forward from the current one first. */
  const plannedIndex = (text: string, from: number): number => {
    const ahead = planned.indexOf(text, Math.max(0, from));
    return ahead >= 0 ? ahead : planned.indexOf(text);
  };

  const transcript: RAMockTurn[] = [];
  const answers = new Map<number, string[]>();
  // -1: an answer with no planned question in front of it (not written by nextTurn).
  let current = -1;
  for (const turn of stored) {
    const text = (turn.text ?? '').trim();
    if (!text) continue;
    if (turn.who !== 'you') {
      const idx = plannedIndex(text, current);
      if (idx >= 0) current = idx;
      transcript.push(turn);
      continue;
    }
    const filed = answers.get(current) ?? [];
    if (filed.includes(text)) {
      const last = transcript[transcript.length - 1];
      if (last && last.who === 'them' && plannedIndex(last.text.trim(), current) === current) transcript.pop();
      continue;
    }
    filed.push(text);
    answers.set(current, filed);
    transcript.push(turn);
  }

  const turns: TranscriptTurn[] = [...answers.values()].map((texts) => ({
    role: 'candidate',
    text: texts.join('\n'),
    ts: 0,
  }));
  const total = planned.length;
  const answered = total > 0 ? Math.min(answers.size, total) : answers.size;
  return { turns, transcript, answered, unanswered: Math.max(0, total - answered) };
}

// ─── Relative-time formatter ("2 days ago") ───────────────────────────────

function relativeWhen(from: Date): string {
  const ms = Date.now() - from.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

// ─── JSON coercion helpers (rows store Json columns) ──────────────────────

function asQuestions(value: unknown): RAMockQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: RAMockQuestion[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const q = typeof r.q === 'string' ? r.q : '';
    if (!q) continue;
    const tip = r.coachTip && typeof r.coachTip === 'object' ? (r.coachTip as Record<string, unknown>) : {};
    out.push({
      q,
      hint: typeof r.hint === 'string' ? r.hint : '',
      coachTip: {
        kind: tip.kind === 'careful' ? 'careful' : 'good',
        text: typeof tip.text === 'string' ? tip.text : '',
      },
    });
  }
  return out;
}

function asTranscript(value: unknown): RAMockTurn[] {
  if (!Array.isArray(value)) return [];
  const out: RAMockTurn[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text) continue;
    out.push({ who: r.who === 'you' ? 'you' : 'them', text });
  }
  return out;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class RAMockService {
  /** The STATIC setup catalog. No DB, no LLM. GoApply (`cn`) lists its AI-interview practice format first. */
  catalog(market: RAMockMarket = currentMarket()): MockCatalogResult {
    return { catalog: catalogForMarket(market) };
  }

  /** The user's COMPLETED sessions → recent-session cards. */
  async recentSessions(userId: string): Promise<MockRecentSessionsResult> {
    const rows = await prisma.rAMockSession.findMany({
      where: { userId, status: 'complete' },
      orderBy: { completedAt: 'desc' },
      take: 12,
      select: {
        id: true,
        role: true,
        interviewerId: true,
        typeId: true,
        overall: true,
        note: true,
        completedAt: true,
        createdAt: true,
      },
    });

    const sessions: RAMockSessionSummary[] = rows.map((r) => ({
      id: r.id,
      role: r.role,
      interviewerName: interviewerNameFor(r.interviewerId),
      typeLabel: typeLabelFor(r.typeId),
      score: r.overall ?? 0,
      when: relativeWhen(r.completedAt ?? r.createdAt),
      note: r.note ?? '',
    }));

    return { sessions };
  }

  /** Create a session row + generate the ordered question set. */
  async start(userId: string, body: MockStartInput, locale?: string): Promise<MockStartResult> {
    const market: RAMockMarket = body?.market === 'cn' || body?.market === 'intl' ? body.market : currentMarket();
    const interviewer = findInterviewer(body?.interviewerId ?? '');
    // A market's own format (GoApply's AI-interview practice) is valid on that market only.
    const type = findType(body?.typeId ?? '', market);
    if (!interviewer || !type) {
      throw new MockValidationError('Unknown interviewer or interview type');
    }
    const format: RAMockFormat = body.format === 'voice' ? 'voice' : 'video';
    const role = (body.role ?? '').trim();

    const requestId = getCurrentRequestId() ?? undefined;
    const persona: RAMockPersona = {
      id: interviewer.id,
      name: interviewer.name,
      role: interviewer.role,
      difficulty: interviewer.difficulty,
      style: interviewer.style,
      blurb: interviewer.blurb,
    };
    // The model reads the type line with the written-practice note in front.
    const typeCtx = writtenTypeContext(type);

    // Resolve the interview language + planned duration from the request,
    // falling back to the UI locale / the interview type's default minutes.
    const language = normalizeRaLocale(body.language) ?? normalizeRaLocale(locale) ?? 'en';
    const durationMinutes = clampDurationMinutes(body.durationMinutes) ?? type.minutes;
    const resumeContext = await this.loadResumeContext(userId);
    const jdText = typeof body.jdText === 'string' ? body.jdText.trim().slice(0, JD_TEXT_MAX_CHARS) : '';
    // The row's id is chosen up front: it seeds the question selection of the
    // GoApply format, so one session can be replayed and two sessions differ.
    const sessionId = randomUUID();

    // ── Interview Prompt Generator pipeline (Tavily + 4 agents + composer) ──
    // Never throws — returns heuristic fallbacks for any stage that fails.
    let questions: RAMockQuestion[] = [];
    let interviewPrompt = '';
    let blueprint: Record<string, unknown> | null = null;
    try {
      const gen = await raInterviewPromptService.generate({
        role,
        persona,
        type: typeCtx,
        durationMinutes,
        language,
        resumeContext,
        questionCount: DEFAULT_QUESTION_COUNT,
        requestId,
        jdText: jdText || undefined,
        market,
        seed: sessionId,
      });
      interviewPrompt = gen.interviewPrompt;
      // Persist the condensed live brief inside the blueprint so nextTurn can
      // read it back and conduct the interview adaptively.
      blueprint = { ...gen.blueprint, interviewerBrief: gen.interviewerBrief };
      questions = gen.seedQuestions.map((q) => ({ q: q.q, hint: q.hint, coachTip: q.coachTip }));
    } catch (err) {
      logger.warn('RA_V2_MOCK', 'start: prompt generator failed; falling back to plan agent', {
        userId,
        interviewerId: interviewer.id,
        typeId: type.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Secondary fallback: the legacy single-call plan, then the static bank —
    // so a session can always start even if generation produced no questions.
    if (questions.length === 0) {
      try {
        const agent = new RAMockInterviewerAgent();
        const out = await agent.run(
          { mode: 'plan', persona, type: typeCtx, role, count: DEFAULT_QUESTION_COUNT },
          { requestId, locale: language },
        );
        questions =
          out.questions && out.questions.length > 0
            ? out.questions
            : fallbackQuestions(type.id, DEFAULT_QUESTION_COUNT);
      } catch {
        questions = fallbackQuestions(type.id, DEFAULT_QUESTION_COUNT);
      }
    }

    const jobId = typeof body.jobId === 'string' && body.jobId.trim() ? body.jobId.trim().slice(0, 64) : null;
    const created = await prisma.rAMockSession.create({
      data: {
        id: sessionId,
        userId,
        role,
        interviewerId: interviewer.id,
        typeId: type.id,
        format,
        language,
        plannedDurationMinutes: durationMinutes,
        interviewPrompt: interviewPrompt || null,
        blueprint: blueprint as unknown as object,
        // Json columns accept plain JS objects/arrays.
        questions: questions as unknown as object,
        transcript: [] as unknown as object,
        status: 'in_progress',
        // SCHEMA-3 column: the job this practice is for (feeds the job's "Practiced" step).
        ...(jobId ? { jobId } : {}),
      },
      select: { id: true },
    });
    const cnFormat = cnTimingFrom(blueprint, questions.length);

    logger.info('RA_V2_MOCK', 'session started', {
      userId,
      sessionId: created.id,
      interviewerId: interviewer.id,
      typeId: type.id,
      language,
      durationMinutes,
      questionCount: questions.length,
      generated: !!interviewPrompt,
      market,
      jobPost: jdText ? true : undefined,
      cnFormat: cnFormat ? true : undefined,
      requestId,
    });

    return {
      sessionId: created.id,
      questions: questions.map((q) => ({ q: q.q, hint: q.hint, coachTip: q.coachTip })),
      ...(cnFormat ? { cnFormat } : {}),
    };
  }

  /** Append the candidate's answer + the interviewer's follow-up to the
   *  transcript; return the next index + the new interviewer turns + a tip. */
  async nextTurn(userId: string, body: MockNextTurnInput, locale?: string): Promise<MockNextTurnResult> {
    const sessionId = (body?.sessionId ?? '').trim();
    if (!sessionId) throw new MockValidationError('sessionId is required');
    const questionIndex = Number.isInteger(body?.questionIndex) ? body.questionIndex : 0;

    const session = await this.loadOwnedSession(userId, sessionId);

    // The interview was generated in a specific language + with an adaptive
    // brief — keep follow-ups in that language and steered by that brief, even
    // if the per-request locale differs.
    const interviewerBrief = writtenBrief(briefFromBlueprint(session.blueprint));
    const turnLocale = session.language ?? locale;

    const questions = asQuestions(session.questions);
    const transcript = asTranscript(session.transcript);
    const total = questions.length;
    const currentIdx = Math.max(0, Math.min(questionIndex, Math.max(0, total - 1)));
    const current = questions[currentIdx];
    const nextIndex = currentIdx + 1 < total ? currentIdx + 1 : null;
    const nextQuestion = nextIndex !== null ? questions[nextIndex].q : null;
    const answer = typeof body.answer === 'string' ? body.answer : '';

    // 1) Append the candidate's answer first (paired with the current Q for
    //    the transcript record). We record the question as a 'them' turn only
    //    if it isn't already the tail of the transcript (start doesn't seed
    //    turns, so the first nextTurn seeds the opening question too).
    if (current) {
      const tail = transcript[transcript.length - 1];
      const alreadyAsked = tail && tail.who === 'them' && tail.text === current.q;
      if (!alreadyAsked) {
        transcript.push({ who: 'them', text: current.q });
      }
    }
    transcript.push({ who: 'you', text: answer });

    // 2) Generate the interviewer's reaction + transition.
    const interviewer = findInterviewer(session.interviewerId);
    // A stored session may be in a market format (GoApply's AI-interview practice).
    const type = findAnyType(session.typeId);
    let turns: RAMockTurn[];
    let coachTip: RAMockCoachTip | null;

    if (interviewer && type) {
      const persona: RAMockPersona = {
        id: interviewer.id,
        name: interviewer.name,
        role: interviewer.role,
        difficulty: interviewer.difficulty,
        style: interviewer.style,
        blurb: interviewer.blurb,
      };
      const typeCtx = writtenTypeContext(type);
      try {
        const agent = new RAMockInterviewerAgent();
        const out = await agent.run(
          {
            mode: 'turn',
            persona,
            type: typeCtx,
            role: session.role,
            currentQuestion: current?.q ?? '',
            answer,
            nextQuestion,
            interviewerBrief,
          },
          { requestId: getCurrentRequestId() ?? undefined, locale: turnLocale },
        );
        if (out.turns && out.turns.length > 0) {
          turns = out.turns;
          coachTip = out.coachTip ?? null;
        } else {
          const fb = fallbackTurns(answer, nextQuestion, turnLocale);
          turns = fb.turns;
          coachTip = fb.coachTip;
        }
      } catch (err) {
        logger.warn('RA_V2_MOCK', 'nextTurn: interviewer agent failed; canned turn', {
          userId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        const fb = fallbackTurns(answer, nextQuestion, turnLocale);
        turns = fb.turns;
        coachTip = fb.coachTip;
      }
    } else {
      const fb = fallbackTurns(answer, nextQuestion, turnLocale);
      turns = fb.turns;
      coachTip = fb.coachTip;
    }

    // 3) Append the interviewer turns and persist the grown transcript.
    for (const t of turns) transcript.push(t);

    await prisma.rAMockSession.update({
      where: { id: sessionId },
      data: { transcript: transcript as unknown as object },
    });

    return { nextIndex, turns, coachTip };
  }

  /**
   * Mark the session complete + produce the scored report. On GoApply
   * (`market: 'cn'`, default: the request's brand) the result also carries the
   * `cn` practice report block; RoboApply results never do.
   */
  async score(userId: string, sessionId: string, opts: { market?: RAMockMarket } = {}): Promise<MockScoreResult> {
    const id = (sessionId ?? '').trim();
    if (!id) throw new MockValidationError('sessionId is required');

    const session = await this.loadOwnedSession(userId, id);
    const transcript = asTranscript(session.transcript);
    const interviewer = findInterviewer(session.interviewerId);
    const difficulty = interviewer?.difficulty ?? 2;

    // Scored in the session language. Questions that got no answer are counted.
    const input = scorerInput(transcript, asQuestions(session.questions));
    const scored = scoreTranscript(
      input.turns,
      difficulty + SCORER_DIFFICULTY_OFFSET,
      session.language ?? undefined,
      { unanswered: input.unanswered },
    );
    const report = { ...scored, note: scored.summary };

    // delta vs the user's previous COMPLETED session (exclude this one).
    const previous = await prisma.rAMockSession.findFirst({
      where: { userId, status: 'complete', id: { not: id } },
      orderBy: { completedAt: 'desc' },
      select: { overall: true },
    });
    const delta =
      previous && typeof previous.overall === 'number'
        ? report.overall - previous.overall
        : null;

    const startedAt = session.startedAt ?? session.createdAt;
    const durationMinutes = Math.max(
      1,
      Math.round((Date.now() - new Date(startedAt).getTime()) / 60_000),
    );

    await prisma.rAMockSession.update({
      where: { id },
      data: {
        status: 'complete',
        overall: report.overall,
        delta,
        breakdown: report.breakdown as unknown as object,
        strengths: report.strengths,
        gaps: report.gaps,
        note: report.note,
        durationMinutes,
        completedAt: new Date(),
      },
    });

    // GoApply: the practice report block. The breakdown above comes from text
    // checks on the transcript (no model), and the block says so (`basis`).
    // `formatId` names the AI-interview format only when the session ran it.
    const market = opts.market ?? currentMarket();
    let cn: CnPracticeReport | undefined;
    if (market === 'cn') {
      try {
        cn = buildCnPracticeReport({
          // Without re-sent answers, so a retried answer's filler words count once.
          turns: normalizeCnTurns(input.transcript),
          breakdown: report.breakdown,
          basis: 'text_checks',
          language: session.language || 'zh',
          formatId: hasCnFormatPlan(session.blueprint) ? CN_AI_INTERVIEW_FORMAT_ID : session.typeId || 'general',
        });
      } catch (err) {
        logger.warn('RA_V2_MOCK', 'score: cn report block failed; scored without it', {
          userId, sessionId: id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('RA_V2_MOCK', 'session scored', {
      userId,
      sessionId: id,
      overall: report.overall,
      delta,
      durationMinutes,
      turnCount: transcript.length,
      answered: input.answered,
      unanswered: input.unanswered,
      cnReport: cn ? true : undefined,
    });

    return {
      overall: report.overall,
      delta,
      breakdown: report.breakdown,
      strengths: report.strengths,
      gaps: report.gaps,
      durationMinutes,
      ...(cn ? { cn } : {}),
    };
  }

  // ─── Internals ───────────────────────────────────────────────────────

  /** Load a session scoped to the authed user. Throws on miss / cross-tenant. */
  private async loadOwnedSession(userId: string, sessionId: string) {
    const session = await prisma.rAMockSession.findFirst({
      where: { id: sessionId, userId },
      select: {
        id: true,
        userId: true,
        role: true,
        interviewerId: true,
        typeId: true,
        format: true,
        questions: true,
        transcript: true,
        status: true,
        startedAt: true,
        createdAt: true,
        language: true,
        blueprint: true,
      },
    });
    if (!session) throw new MockSessionNotFoundError();
    return session;
  }

  /**
   * Load a compact résumé context string for the generator pipeline: the
   * primary variant's AI summary if present, else the head of its markdown.
   * Returns '' when the user has no résumé yet (generation still works).
   */
  private async loadResumeContext(userId: string): Promise<string> {
    try {
      const variant =
        (await prisma.rAResumeVariant.findFirst({
          where: { userId, isPrimary: true, deletedAt: null },
          select: { summary: true, resumeMarkdown: true },
        })) ??
        (await prisma.rAResumeVariant.findFirst({
          where: { userId, kind: 'base', deletedAt: null },
          orderBy: { lastEditedAt: 'desc' },
          select: { summary: true, resumeMarkdown: true },
        }));
      if (!variant) return '';
      const summary = (variant.summary ?? '').trim();
      const md = (variant.resumeMarkdown ?? '').trim();
      // Prefer the summary; append a head of the markdown for concrete claims.
      return [summary, md.slice(0, 2000)].filter(Boolean).join('\n\n').slice(0, 2400);
    } catch {
      return '';
    }
  }
}

export const raMockService = new RAMockService();
export default raMockService;

export const __test = {
  fallbackQuestions,
  fallbackTurns,
  scorerInput,
  relativeWhen,
  asQuestions,
  asTranscript,
};
