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
// `RAMockInterviewerAgent` (Haiku-tier, persona-aware). The SCORE is a
// deterministic transcript heuristic — robust, free, and never 500s. Mock is
// NOT a billed SKU yet (no quota gating / no UsageDeductionLog row); if it
// becomes one, gate `start`/`nextTurn` through `lib/matchBilling`-style
// primitives and note it here.
//
// Graceful degradation: when the LLM is unconfigured / errors / returns an
// empty parse, `start` falls back to a deterministic per-type question bank and
// `nextTurn` falls back to a canned interviewer turn, so every endpoint returns
// a valid shape with no LLM key.
//
// Ownership: every session-scoped method loads `{ id, userId }` and 404s
// otherwise (single-user product — no team scope; see raVisibility.ts).

import prisma from '../../../lib/prisma.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import {
  RA_MOCK_CATALOG,
  findInterviewer,
  findType,
  interviewerNameFor,
  typeLabelFor,
  type RAMockCatalog,
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

export interface MockStartResult {
  sessionId: string;
  questions: Array<{ q: string; hint: string; coachTip: RAMockCoachTip }>;
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

/** A canned interviewer turn used when the agent fails on nextTurn. Stays in a
 *  generic-but-professional voice and transitions into the next question. */
function fallbackTurns(
  answer: string,
  nextQuestion: string | null,
): { turns: RAMockTurn[]; coachTip: RAMockCoachTip | null } {
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

// ─── Heuristic scorer (deterministic, free, never throws) ─────────────────
//
// Reads the accumulated transcript (the candidate's "you" turns) and derives a
// bounded 0..100 score across 5 dimensions, plus strengths + gaps. The score
// rewards: substantive answers (length), specificity (numbers / metrics),
// structure (multiple clauses / situation→action→result markers), and
// completeness (didn't skip). Difficulty modestly tightens the bar.

interface ScoreSignals {
  answerCount: number;
  totalWords: number;
  numericAnswers: number;
  structuredAnswers: number;
  emptyAnswers: number;
  avgWords: number;
}

const NUMBER_RE = /\b\d[\d.,%]*\b|\b(?:percent|x|%|\$)\b/i;
const STRUCTURE_RE = /\b(because|so that|which|then|after|resulted|led to|so we|as a result|increased|reduced|shipped|launched)\b/i;

function gatherSignals(transcript: RAMockTurn[]): ScoreSignals {
  const youTurns = transcript.filter((t) => t.who === 'you');
  let totalWords = 0;
  let numericAnswers = 0;
  let structuredAnswers = 0;
  let emptyAnswers = 0;
  for (const t of youTurns) {
    const text = (t.text ?? '').trim();
    const words = text ? text.split(/\s+/).length : 0;
    totalWords += words;
    if (words === 0) emptyAnswers++;
    if (NUMBER_RE.test(text)) numericAnswers++;
    if (STRUCTURE_RE.test(text) || text.split(/[.;]/).filter((s) => s.trim()).length >= 3) {
      structuredAnswers++;
    }
  }
  const answerCount = youTurns.length;
  return {
    answerCount,
    totalWords,
    numericAnswers,
    structuredAnswers,
    emptyAnswers,
    avgWords: answerCount > 0 ? totalWords / answerCount : 0,
  };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Map avg words (0..~120) to a 0..100 sub-score with diminishing returns. */
function lengthScore(avgWords: number): number {
  // 0 words → ~30; 40 words → ~80; 80+ words → ~90 (plateau).
  if (avgWords <= 0) return 30;
  return clampScore(30 + 60 * (1 - Math.exp(-avgWords / 45)));
}

function ratioScore(part: number, whole: number, floor: number, ceil: number): number {
  if (whole <= 0) return floor;
  const r = part / whole;
  return clampScore(floor + (ceil - floor) * r);
}

interface HeuristicReport {
  overall: number;
  breakdown: Array<{ key: string; value: number; note: string }>;
  strengths: string[];
  gaps: string[];
  note: string;
}

function heuristicScore(
  transcript: RAMockTurn[],
  difficulty: number,
): HeuristicReport {
  const s = gatherSignals(transcript);

  // Difficulty 1..3 → penalty 0..~6 points (harder personas grade tighter).
  const difficultyPenalty = Math.max(0, (difficulty - 1)) * 3;

  const structure = clampScore(ratioScore(s.structuredAnswers, Math.max(1, s.answerCount), 55, 92) - difficultyPenalty);
  const specificity = clampScore(ratioScore(s.numericAnswers, Math.max(1, s.answerCount), 50, 95) - difficultyPenalty);
  const communication = clampScore(lengthScore(s.avgWords) - difficultyPenalty / 2);
  const completeness = clampScore(
    ratioScore(Math.max(0, s.answerCount - s.emptyAnswers), Math.max(1, s.answerCount), 40, 95),
  );
  const confidence = clampScore(
    // A blend: structure + a small nudge for not skipping, minus difficulty.
    (structure * 0.5 + completeness * 0.5) - difficultyPenalty,
  );

  const breakdown = [
    { key: 'Structure', value: structure, note: structureNote(structure, s) },
    { key: 'Specificity', value: specificity, note: specificityNote(specificity, s) },
    { key: 'Communication', value: communication, note: communicationNote(communication, s) },
    { key: 'Confidence', value: confidence, note: confidenceNote(confidence, s) },
    { key: 'Role fit', value: completeness, note: roleFitNote(completeness, s) },
  ];

  const overall = clampScore(
    breakdown.reduce((sum, b) => sum + b.value, 0) / breakdown.length,
  );

  const { strengths, gaps } = strengthsAndGaps(breakdown, s);
  const note = summaryNote(overall, s);

  return { overall, breakdown, strengths, gaps, note };
}

function structureNote(v: number, s: ScoreSignals): string {
  if (s.answerCount === 0) return 'No answers were recorded this session.';
  return v >= 80
    ? 'Clear arc on most answers — situation, action, and result were easy to follow.'
    : v >= 60
      ? 'Mostly structured; a couple of answers jumped straight to the result.'
      : 'Answers tended to ramble — set up the situation, then the action, then the result.';
}

function specificityNote(v: number, s: ScoreSignals): string {
  return v >= 80
    ? 'Strong use of concrete numbers — interviewers trust figures over adjectives.'
    : s.numericAnswers > 0
      ? 'Some answers carried metrics; aim for at least one number per story.'
      : 'No measurable outcomes surfaced — add a number to each story (before → after).';
}

function communicationNote(v: number, s: ScoreSignals): string {
  if (s.avgWords < 15) return 'Answers were very short — give the interviewer enough to evaluate.';
  if (v >= 80) return 'Good depth and pacing across answers.';
  return 'Reasonable depth; trim filler and lead with the headline.';
}

function confidenceNote(v: number, _s: ScoreSignals): string {
  return v >= 80
    ? 'Answers read as decisive and owned.'
    : v >= 60
      ? 'Mostly assured; a few answers hedged where a clear position would land better.'
      : 'Tended to hedge — commit to a position and use ownership verbs (I led / I owned).';
}

function roleFitNote(v: number, s: ScoreSignals): string {
  if (s.emptyAnswers > 0) return `${s.emptyAnswers} question(s) went unanswered — completing every prompt strengthens fit signal.`;
  return v >= 80
    ? 'Engaged with every prompt — completeness reads as genuine interest.'
    : 'Answered most prompts; fuller engagement on each strengthens the signal.';
}

function strengthsAndGaps(
  breakdown: Array<{ key: string; value: number; note: string }>,
  s: ScoreSignals,
): { strengths: string[]; gaps: string[] } {
  const sorted = [...breakdown].sort((a, b) => b.value - a.value);
  const strengths: string[] = [];
  const gaps: string[] = [];

  if (s.answerCount === 0) {
    return {
      strengths: ['Session started — complete a few answers to get a graded report.'],
      gaps: ['No answers were recorded. Run the interview through to the end for a real score.'],
    };
  }

  for (const b of sorted.slice(0, 2)) {
    if (b.value >= 70) strengths.push(`${b.key}: ${b.note}`);
  }
  if (s.numericAnswers > 0 && !strengths.some((x) => x.startsWith('Specificity'))) {
    strengths.push('You backed claims with concrete numbers in at least one answer.');
  }
  if (strengths.length === 0) {
    strengths.push('You engaged with the prompts — there is a clear base to build on.');
  }

  for (const b of [...sorted].reverse().slice(0, 2)) {
    if (b.value < 75) gaps.push(`${b.key}: ${b.note}`);
  }
  if (s.emptyAnswers > 0 && !gaps.some((x) => x.startsWith('Role fit'))) {
    gaps.push(`Answer every prompt — ${s.emptyAnswers} were skipped this session.`);
  }
  if (gaps.length === 0) {
    gaps.push('Keep tightening: one crisp metric per answer and a clear position on every question.');
  }

  return { strengths: strengths.slice(0, 3), gaps: gaps.slice(0, 3) };
}

function summaryNote(overall: number, s: ScoreSignals): string {
  if (s.answerCount === 0) return 'No answers recorded.';
  if (overall >= 85) return 'Authentic and specific. Best session signal yet.';
  if (overall >= 75) return 'Strong on metrics. Watch hedging on the harder questions.';
  if (overall >= 60) return 'Good framing. Get to the point faster and quantify more.';
  return 'A solid first rep — add structure and concrete numbers next time.';
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
  /** The STATIC setup catalog. No DB, no LLM. */
  catalog(): MockCatalogResult {
    return { catalog: RA_MOCK_CATALOG };
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
    const interviewer = findInterviewer(body?.interviewerId ?? '');
    const type = findType(body?.typeId ?? '');
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
    const typeCtx: RAMockTypeContext = { id: type.id, label: type.label, sub: type.sub };

    // Resolve the interview language + planned duration from the request,
    // falling back to the UI locale / the interview type's default minutes.
    const language = normalizeRaLocale(body.language) ?? normalizeRaLocale(locale) ?? 'en';
    const durationMinutes = clampDurationMinutes(body.durationMinutes) ?? type.minutes;
    const resumeContext = await this.loadResumeContext(userId);

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

    const created = await prisma.rAMockSession.create({
      data: {
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
      },
      select: { id: true },
    });

    logger.info('RA_V2_MOCK', 'session started', {
      userId,
      sessionId: created.id,
      interviewerId: interviewer.id,
      typeId: type.id,
      language,
      durationMinutes,
      questionCount: questions.length,
      generated: !!interviewPrompt,
      requestId,
    });

    return {
      sessionId: created.id,
      questions: questions.map((q) => ({ q: q.q, hint: q.hint, coachTip: q.coachTip })),
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
    const interviewerBrief = briefFromBlueprint(session.blueprint);
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
    const type = findType(session.typeId);
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
      const typeCtx: RAMockTypeContext = { id: type.id, label: type.label, sub: type.sub };
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
          const fb = fallbackTurns(answer, nextQuestion);
          turns = fb.turns;
          coachTip = fb.coachTip;
        }
      } catch (err) {
        logger.warn('RA_V2_MOCK', 'nextTurn: interviewer agent failed; canned turn', {
          userId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        const fb = fallbackTurns(answer, nextQuestion);
        turns = fb.turns;
        coachTip = fb.coachTip;
      }
    } else {
      const fb = fallbackTurns(answer, nextQuestion);
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

  /** Mark the session complete + produce the scored report. */
  async score(userId: string, sessionId: string): Promise<MockScoreResult> {
    const id = (sessionId ?? '').trim();
    if (!id) throw new MockValidationError('sessionId is required');

    const session = await this.loadOwnedSession(userId, id);
    const transcript = asTranscript(session.transcript);
    const interviewer = findInterviewer(session.interviewerId);
    const difficulty = interviewer?.difficulty ?? 2;

    const report = heuristicScore(transcript, difficulty);

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

    logger.info('RA_V2_MOCK', 'session scored', {
      userId,
      sessionId: id,
      overall: report.overall,
      delta,
      durationMinutes,
      turnCount: transcript.length,
    });

    return {
      overall: report.overall,
      delta,
      breakdown: report.breakdown,
      strengths: report.strengths,
      gaps: report.gaps,
      durationMinutes,
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
  heuristicScore,
  gatherSignals,
  relativeWhen,
  asQuestions,
  asTranscript,
};
