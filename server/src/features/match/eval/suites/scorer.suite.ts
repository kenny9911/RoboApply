// server/src/features/match/eval/suites/scorer.suite.ts
//
// Scorer layer (strategy 2.6; SM-8): is the fit scorer stable, and does it
// agree with people who recruit for a living?
//
//   icc_3_runs       intraclass correlation of the totals over three runs on
//                    the same pairs                                  gate >= 0.85
//   tier_flip_rate   share of pairs that did not get one and the same tier in
//                    all three runs                                  gate < 0.05
//   spearman_human   rank correlation of the score (mean of the runs) with a
//                    recruiter's grade of the same pair              gate >= 0.6
//
// A run with no usable answer (the call failed, the answer does not parse, the
// checklist is refused) is instability the person sees: an estimate where the
// AI fit should be. Such a pair is never dropped quietly: it counts in
// tier_flip_rate as a pair without one tier, whether one run or all three gave
// nothing. The ICC and the correlation need three numbers per pair, so they
// are computed over the pairs every run scored, and only when those are at
// least 90% of the recording and at least 30 pairs: a value over the survivors
// of a scorer that often gives nothing would say nothing about it. Below
// either bound the row reads `no_fixture` and says why (tier_flip_rate then
// carries the failure). The correlation with recruiters likewise needs 30
// graded pairs, as the judge audit does: two pairs always give +1 or -1.
//
// Offline (CI). The suite replays RECORDED model answers; it never calls a
// model. `fixtures/scorer/recorded.<market>.json` holds, for 100 synthetic
// persona-posting pairs of the committed fixtures, the raw answers of three
// runs of the pinned scorer. Each answer is replayed through the product's own
// path: a MatchService on in-memory fakes whose scorer returns the parsed
// recorded answer, so the strip, the parser, the verification against the two
// texts, the arithmetic and the borderline rule are the production code, not a
// copy of it. Until a recording is committed the three rows read `no_fixture`:
// nothing fails and no number is invented.
//
// A recording is for the inputs it was made on. Every pair stores the hash of
// the prompt the model saw; a pair whose prompt would be another today (the
// fixtures or the strip changed) is left out and counted, and when most pairs
// changed the rows read `no_fixture` again.
//
// `fixtures/scorer/audit.<market>.json` holds recruiters' grades (0-3) of
// recorded pairs, when the owner has them; without it `spearman_human` reads
// `no_fixture`. "Not below the previous scorer": when a recording of scorer v3
// made the same way (`recorded.v3.<market>.json`) is there, its correlation
// and the difference are printed next to it.
//
// The self-check always runs when its fixture is there
// (`fixtures/scorer/selfcheck.json`): ten hand-written pairs with three
// hand-written answers each, the same checklist in three spellings. Identical
// input must give identical totals and tiers: ICC 1 and no flip, and every
// total must be the hand-computed one. Anything else is a broken pipeline and
// fails the command.
//
// Live (the owner's step; `--live` with EVAL_LIVE=1, and EVAL_SCORER_RECORD=1
// to record): the real pinned scorer is called three times on a fixed draw of
// 100 pooled pairs of the synthetic fixtures, inside the market's brand, and
// the recording is written under eval/.snapshots/<date>/scorer/ (git-ignored)
// with the model id, the date and the sample size, next to a sheet for the
// recruiters. After review the owner copies the recording into
// fixtures/scorer/. Nothing real is in it: personas and postings are the
// synthetic fixtures.

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  RAJobMatchScorerV3Agent,
  RAJobMatchScorerV4Agent,
  formatScorerV4Input,
  parseScorerV4Output,
  type RAJobMatchScorerV3Input,
  type RAJobMatchScorerV3Output,
  type RAJobMatchScorerV4Input,
  type RAJobMatchScorerV4Output,
} from '../../../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { JobRequirementSchema, type FitPromptVersion } from '../../contract.js';
import type { MatchJobRecord } from '../../context.js';
import { requirementListHash } from '../../jobHash.js';
import type { MatchServiceDeps, ScorerLike, ScorerV4Like } from '../../MatchService.js';
import { loadMarketFixtures } from '../fixtures/load.js';
import type { Persona } from '../fixtures/schema.js';
import { JUDGE_TRUST_MIN_PAIRS, type GateLayer } from '../gates.js';
import { auditCsv, pairId, parseAuditCsv, type AuditPair } from '../live/audit.js';
import { STABILITY_PAIRS, STABILITY_RUNS, stabilitySample } from '../live/stability.js';
import { EVAL_DEFAULT_TIERS, icc, spearman, tierFlipRate } from '../metrics.js';
import { fitKind, isSeamMissing, loadFitApi, type FitLike } from '../seams.js';
import { notBuiltOrThrow, unmeasured, type SuiteContext, type SuiteMarket, type SuiteMeasure } from '../suite.js';
import { createWorld, defaultUserInputs, fixtureWorld, jobRecord, resumeHash, resumeRecord, type World } from '../world.js';

export const name = 'scorer';
export const layer: GateLayer = 'scorer';

/** The folder of this suite's fixtures, under eval/fixtures. */
export const SCORER_FIXTURES = 'scorer';
export const SCORER_FILES = {
  selfcheck: 'selfcheck.json',
  recorded: (market: SuiteMarket, prompt: FitPromptVersion = 'scorer_v4') => (prompt === 'scorer_v4' ? `recorded.${market}.json` : `recorded.v3.${market}.json`),
  audit: (market: SuiteMarket) => `audit.${market}.json`,
  auditSheet: (market: SuiteMarket) => `audit.${market}.csv`,
} as const;

/** Runs per pair (strategy 2.6: "3 runs on 100 pairs"). */
export const SCORER_RUNS = STABILITY_RUNS;
/** The shell switch that lets a live run call the scorer and write a recording (never read from .env by this suite). */
export const RECORD_SWITCH = 'EVAL_SCORER_RECORD';
/** Pairs scored at the same time while recording (the job.score worker runs four). */
export const RECORD_CONCURRENCY = 4;
/** When more than this share of a recording's pairs is for other inputs, it is no fixture for today's code. */
export const MAX_CHANGED_SHARE = 0.5;
/** Pairs a gated scorer value needs behind it (the bound of the judge audit: fewer give noise, not a measurement). */
export const SCORER_MIN_PAIRS = JUDGE_TRUST_MIN_PAIRS;
/** The share of a recording's pairs every run must have scored before a value over those pairs is read at all. */
export const MIN_MEASURED_SHARE = 0.9;
const SELFCHECK_PAIRS = 10;

// ── Files ─────────────────────────────────────────────────────────────────

const Id = z.string().min(1).max(64);
const Market = z.enum(['intl', 'cn']);

const RecordedPairSchema = z
  .object({
    personaId: Id,
    postingId: Id,
    /** sha1 of the prompt the model saw (the formatted user message). */
    inputHash: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    /** The raw answer of each run, as the model wrote it; null when that call failed. */
    answers: z.array(z.string().nullable()).length(SCORER_RUNS),
  })
  .strict();

export const RecordingSchema = z
  .object({
    _synthetic: z.literal(true),
    /** The command that wrote the file. */
    _recordedBy: z.string().min(1),
    market: Market,
    scorer: z.object({ prompt: z.enum(['scorer_v3', 'scorer_v4']), rubric: z.enum(['fit_v3', 'fit_v4']), model: z.string().min(1) }).strict(),
    /** ISO time of the run. */
    recordedAt: z.string().min(1),
    runs: z.literal(SCORER_RUNS),
    pairs: z.array(RecordedPairSchema).min(1),
  })
  .strict();
export type Recording = z.infer<typeof RecordingSchema>;
export type RecordedPair = z.infer<typeof RecordedPairSchema>;

export const ScorerAuditSchema = z
  .object({
    _synthetic: z.literal(true),
    market: Market,
    /** Grades of a recruiter. Never the engineer's own, and never a judge model's. */
    labels: z.literal('human'),
    gradedAt: z.string().min(1),
    /** `<personaId>::<postingId>` → grade 0-3. */
    grades: z.record(z.string().min(3), z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])),
  })
  .strict();
export type ScorerAudit = z.infer<typeof ScorerAuditSchema>;

const SelfcheckPairSchema = z
  .object({
    id: Id,
    /** What the pair proves, with its arithmetic. */
    what: z.string().min(1),
    market: Market,
    /** The person's resume (SYNTHETIC). */
    resume: z.string().min(20),
    /** GoApply: the profile's 届别. */
    classYear: z.number().int().optional(),
    posting: z
      .object({
        title: z.string().min(1),
        description: z.string().min(1),
        qualifications: z.string().nullable(),
        seniority: z.string().nullable(),
        /** The posting's stored requirement list, when the pair is about one. */
        requirements: z.array(JobRequirementSchema).optional(),
        classYears: z.array(z.number().int()).optional(),
        classYearQuote: z.string().nullable().optional(),
      })
      .strict(),
    /** The estimate the tier rule reads for this pair. */
    estimate: z.number().min(0).max(100),
    answers: z.array(z.string().min(2)).length(SCORER_RUNS),
    expected: z
      .object({
        total: z.number().int(),
        tier: z.enum(['great', 'good', 'possible', 'unlikely']),
        title_level: z.number().nullable(),
        skills: z.number().nullable(),
        industry: z.number().nullable(),
        career_path: z.number().nullable(),
      })
      .strict(),
  })
  .strict();
export const SelfcheckSchema = z.object({ _synthetic: z.literal(true), _note: z.string().min(1), pairs: z.array(SelfcheckPairSchema).length(SELFCHECK_PAIRS) }).strict();
export type SelfcheckPair = z.infer<typeof SelfcheckPairSchema>;

function readFixture<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null;
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`fixture ${path.basename(file)} does not match its shape: ${first ? `${first.path.join('.') || '(file)'}: ${first.message}` : 'unknown issue'}`);
  }
  return parsed.data;
}

const scorerDir = (fixturesDir: string) => path.join(fixturesDir, SCORER_FIXTURES);

/**
 * A recording of one market and one scorer prompt, or null when the file is
 * not on disk. A file that is there and wrong throws: its shape (three answers
 * per pair, synthetic header), a market tag or a prompt that is not the one
 * asked for, or a pair listed twice. A bad recording is never scored quietly.
 */
export function loadRecording(fixturesDir: string, market: SuiteMarket, prompt: FitPromptVersion = 'scorer_v4'): Recording | null {
  const file = path.join(scorerDir(fixturesDir), SCORER_FILES.recorded(market, prompt));
  const recording = readFixture(file, RecordingSchema);
  if (!recording) return null;
  const where = path.basename(file);
  if (recording.market !== market) throw new Error(`fixture ${where} is tagged market ${recording.market}, not ${market}`);
  if (recording.scorer.prompt !== prompt) throw new Error(`fixture ${where} was recorded with ${recording.scorer.prompt}, not ${prompt}`);
  const seen = new Set<string>();
  for (const p of recording.pairs) {
    const id = pairId(p);
    if (seen.has(id)) throw new Error(`fixture ${where} lists the pair ${id} twice`);
    seen.add(id);
  }
  return recording;
}

export function loadScorerAudit(fixturesDir: string, market: SuiteMarket): ScorerAudit | null {
  const file = path.join(scorerDir(fixturesDir), SCORER_FILES.audit(market));
  const audit = readFixture(file, ScorerAuditSchema);
  if (audit && audit.market !== market) throw new Error(`fixture ${path.basename(file)} is tagged market ${audit.market}, not ${market}`);
  return audit;
}

export function loadSelfcheck(fixturesDir: string): SelfcheckPair[] | null {
  return readFixture(path.join(scorerDir(fixturesDir), SCORER_FILES.selfcheck), SelfcheckSchema)?.pairs ?? null;
}

// ── The two scorers, as the replay and the recorder need them ─────────────

class V3Text extends RAJobMatchScorerV3Agent {
  /** The raw answer of the last call (set before it is parsed, so an answer that does not parse is kept too). */
  raw: string | null = null;
  format(input: RAJobMatchScorerV3Input): string {
    return this.formatInput(input);
  }
  parse(response: string): RAJobMatchScorerV3Output {
    return super.parseOutput(response);
  }
  protected parseOutput(response: string): RAJobMatchScorerV3Output {
    this.raw = response;
    return super.parseOutput(response);
  }
}

class V4Text extends RAJobMatchScorerV4Agent {
  raw: string | null = null;
  protected parseOutput(response: string): RAJobMatchScorerV4Output {
    this.raw = response;
    return super.parseOutput(response);
  }
}

const sha1 = (text: string): string => crypto.createHash('sha1').update(text).digest('hex');

/** What one call of a scorer saw and (when recording) wrote. */
export interface CallTrace {
  inputHash: string | null;
  raw: string | null;
}

/** How a scorer call is answered: from a recorded answer, or by the real agent (live). */
export type Answerer = { kind: 'replay'; answer: string | null } | { kind: 'live' };

/** The scorer dependencies of a MatchService that answers as `answerer` says, pinned to `prompt`. */
function scorerDeps(prompt: FitPromptVersion, answerer: Answerer, trace: CallTrace): Pick<MatchServiceDeps, 'scorer' | 'scorerV4'> {
  if (prompt === 'scorer_v4') {
    const scorerV4: ScorerV4Like = {
      async run(input: RAJobMatchScorerV4Input, options) {
        trace.inputHash = sha1(formatScorerV4Input(input));
        if (answerer.kind === 'replay') {
          if (answerer.answer === null) throw new Error('no answer was recorded for this run (the call failed)');
          return parseScorerV4Output(answerer.answer);
        }
        const agent = new V4Text();
        try {
          return await agent.run(input, options);
        } finally {
          trace.raw = agent.raw;
        }
      },
    };
    return { scorerV4 };
  }
  const scorer: ScorerLike = {
    async run(input: RAJobMatchScorerV3Input, options) {
      const agent = new V3Text();
      trace.inputHash = sha1(agent.format(input));
      if (answerer.kind === 'replay') {
        if (answerer.answer === null) throw new Error('no answer was recorded for this run (the call failed)');
        return agent.parse(answerer.answer);
      }
      try {
        return await agent.run(input, options);
      } finally {
        trace.raw = agent.raw;
      }
    },
  };
  return { scorer };
}

export interface ScoredOnce {
  /** The total, or null when the scorer gave no usable answer (never counted as a score). */
  score: number | null;
  tier: string | null;
  fit: FitLike;
  trace: CallTrace;
}

/**
 * One first score of one pair through the product's own path: `getFit` with a
 * model call allowed, on a MatchService built on the world's fakes and the
 * given scorer. The world must hold no stored score for the pair.
 */
export async function scoreOnce(
  world: World,
  input: { userId: string; jobId: string; locale: string; prompt: FitPromptVersion; answerer: Answerer; deps?: Partial<MatchServiceDeps>; /** False: read what is there (the estimate), with no scorer call. */ allowModelCall?: boolean },
): Promise<ScoredOnce> {
  const trace: CallTrace = { inputHash: null, raw: null };
  const deps: Record<string, unknown> = {
    ...world.deps,
    // Every score of this suite is a FIRST score of its posting: the repository stores no requirement list here. With
    // the store on, the first pair of a posting would write its copied lines and the later pairs of that posting would
    // be handed them. Which pair comes first differs between recording (four at a time) and replay (one by one), so the
    // prompt of a pair, and what its recorded answer means, would depend on the order. Without the store the model
    // copies the lines itself in every call, in any order. (A list the fixtures themselves carry is read all the same.)
    repo: { ...world.deps.repo, saveJobRequirements: undefined },
    // Both scorers named, so only the one of this prompt can run; the pinned rubric is set to match.
    scorer: undefined,
    scorerV4: undefined,
    ...scorerDeps(input.prompt, input.answerer, trace),
    env: input.prompt === 'scorer_v3' ? { MATCH_SCORER_RUBRIC: 'fit_v3' } : {},
    ...input.deps,
  };
  const api = await loadFitApi(deps);
  const fit = (await world.inBrand(() => api.raw.getFit(input.userId, input.jobId, { allowModelCall: input.allowModelCall !== false, mode: 'precompute', locale: input.locale }))) as FitLike;
  const scored = fitKind(fit.kind) === 'ai' && typeof fit.score === 'number' && Number.isFinite(fit.score);
  return { score: scored ? (fit.score as number) : null, tier: scored ? fit.tier : null, fit, trace };
}

// ── Replay of a recording ─────────────────────────────────────────────────

export interface ReplayResult {
  /** Over `kept`: the pairs every run scored. */
  icc: number | null;
  /**
   * Over `usable`: the share of pairs that did not get one and the same tier
   * in every run. A pair with a run that gave no usable answer is one of them.
   */
  tierFlipRate: number | null;
  /** Pairs every run scored, on today's inputs. */
  kept: Array<{ personaId: string; postingId: string; scores: number[]; tiers: Array<string | null> }>;
  /** Pairs on today's inputs: `kept` and `dropped` together. */
  usable: number;
  /** Usable pairs with a run that gave no score (a failed call, an answer that does not parse, a refused checklist). Counted as flips; not in `kept`. */
  dropped: number;
  /** Pairs left out because the prompt would be another today. */
  changed: number;
  /** Pairs of the recording that are not in the fixtures any more. */
  unknown: number;
  total: number;
}

/** Replay every answer of a recording through the product's path and measure the three runs. */
export async function replayRecording(recording: Recording, fixturesDir: string): Promise<ReplayResult | null> {
  const fx = loadMarketFixtures(recording.market, fixturesDir);
  if (!fx) return null;
  const personas = new Map(fx.personas.map((p) => [p.id, p]));
  const postings = new Set(fx.postings.map((p) => p.id));
  const known = recording.pairs.filter((p) => personas.has(p.personaId) && postings.has(p.postingId));
  const scores: Array<Array<number | null>> = [];
  const tiers: Array<Array<string | null>> = [];
  const changedAt = new Set<number>();
  for (let run = 0; run < SCORER_RUNS; run += 1) {
    // A fresh world per run: every score is a first score of its pair, as it was when it was recorded.
    const world = fixtureWorld(recording.market, fx.personas, fx.postings);
    const runScores: Array<number | null> = [];
    const runTiers: Array<string | null> = [];
    for (const [i, pair] of known.entries()) {
      const once = await scoreOnce(world, {
        userId: pair.personaId,
        jobId: pair.postingId,
        locale: personas.get(pair.personaId)!.locale,
        prompt: recording.scorer.prompt,
        answerer: { kind: 'replay', answer: pair.answers[run] ?? null },
        deps: { resolveModel: () => recording.scorer.model },
      });
      if (pair.inputHash && once.trace.inputHash && once.trace.inputHash !== pair.inputHash) changedAt.add(i);
      runScores.push(once.score);
      runTiers.push(once.tier);
    }
    scores.push(runScores);
    tiers.push(runTiers);
  }
  const usable = known.map((_, i) => !changedAt.has(i));
  const complete = known.map((_, i) => usable[i] && scores.every((row) => row[i] !== null));
  const kept = known
    .map((pair, i) => ({ personaId: pair.personaId, postingId: pair.postingId, scores: scores.map((row) => row[i] as number), tiers: tiers.map((row) => row[i] ?? null), keep: complete[i] }))
    .filter((p) => p.keep)
    .map(({ keep: _keep, ...p }) => p);
  const byRun = Array.from({ length: SCORER_RUNS }, (_, run) => kept.map((p) => p.scores[run]!));
  const usableCount = usable.filter(Boolean).length;
  const dropped = usableCount - kept.length;
  // Flips among the pairs every run scored, plus every pair with a run that gave nothing: neither got one tier.
  const flipsAmongKept = Math.round((tierFlipRate(Array.from({ length: SCORER_RUNS }, (_, run) => kept.map((p) => p.tiers[run] ?? null))) ?? 0) * kept.length);
  return {
    icc: icc(byRun),
    tierFlipRate: usableCount ? (flipsAmongKept + dropped) / usableCount : null,
    kept,
    usable: usableCount,
    dropped,
    changed: changedAt.size,
    unknown: recording.pairs.length - known.length,
    total: recording.pairs.length,
  };
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Spearman of the score (mean of the runs) against the recruiter's grade, over the pairs that have both. */
export function spearmanWithHuman(result: ReplayResult, audit: ScorerAudit): { value: number | null; n: number } {
  const x: number[] = [];
  const y: number[] = [];
  for (const pair of result.kept) {
    const grade = audit.grades[pairId(pair)];
    if (typeof grade !== 'number') continue;
    x.push(mean(pair.scores));
    y.push(grade);
  }
  return { value: spearman(x, y), n: x.length };
}

function recordingNote(recording: Recording, result: ReplayResult): string {
  return [
    `recorded ${recording.recordedAt.slice(0, 10)} with ${recording.scorer.model} (${recording.scorer.prompt})`,
    `${SCORER_RUNS} runs on ${result.total} synthetic pairs`,
    `${result.kept.length} scored in every run`,
    result.dropped ? `${result.dropped} with a run that gave no usable answer (${Math.round((result.dropped / Math.max(1, result.usable)) * 1000) / 10}% of the pairs; each counts as a tier flip)` : '',
    result.changed ? `${result.changed} left out because their prompt would be another today` : '',
    result.unknown ? `${result.unknown} not in the fixtures any more` : '',
    'the model copied the requirement lines itself in every call (the suite stores none on a posting)',
  ]
    .filter(Boolean)
    .join('; ');
}

const RECORD_HINT = `EVAL_LIVE=1 ${RECORD_SWITCH}=1 npm run eval:match -- --live`;
/** The same recording with the rollback switch set: scorer v3, the scorer the new one is compared with. */
const RECORD_V3_HINT = `MATCH_SCORER_RUBRIC=fit_v3 ${RECORD_HINT}`;
/** "Not below the current scorer" (SM-8): a gate of its own, so it is reported per market in every case, never left for the report to guess. */
const GAIN_OVER_V3 = 'spearman_human_gain_over_v3';

/** The gated rows of one market, from a recording (the committed one, or the one this live run just wrote). */
async function marketMeasures(market: SuiteMarket, fixturesDir: string, recording: Recording | null, where: string): Promise<SuiteMeasure[]> {
  const out: SuiteMeasure[] = [];
  const stability = ['icc_3_runs', 'tier_flip_rate'] as const;
  // The comparison with scorer v3 needs everything `spearman_human` needs, and the v3 recording besides: where the
  // first cannot be read, neither can the second, and its row says the same reason.
  const all = [...stability, 'spearman_human', GAIN_OVER_V3] as const;
  if (!recording) {
    const note = `${where} is not on disk yet: record it with "${RECORD_HINT}", review it and copy it there`;
    for (const metric of all) out.push(unmeasured(metric, 'no_fixture', note, { market }));
    return out;
  }
  const result = await replayRecording(recording, fixturesDir);
  if (!result) {
    for (const metric of all) out.push(unmeasured(metric, 'no_fixture', `no personas, postings or labels for ${market} in fixtures/`, { market }));
    return out;
  }
  const note = recordingNote(recording, result);
  const known = result.total - result.unknown;
  if (known > 0 && result.changed / known > MAX_CHANGED_SHARE) {
    const why = `${note}: the recording is for other inputs than today's (the fixtures or the resume strip changed since); record it again with "${RECORD_HINT}"`;
    for (const metric of all) out.push(unmeasured(metric, 'no_fixture', why, { market }));
    return out;
  }
  // The sample itself is too small: a fixture problem, not a result of the scorer.
  if (result.usable < SCORER_MIN_PAIRS) {
    const why = `${note}: ${result.usable} pairs on today's inputs; ${SCORER_MIN_PAIRS} are needed before a value is held against its gate. Record it again with "${RECORD_HINT}"`;
    for (const metric of all) out.push(unmeasured(metric, 'no_fixture', why, { market }));
    return out;
  }
  // Every usable pair is in the flip rate: a run that gave nothing is a pair without one tier.
  out.push({ metric: 'tier_flip_rate', market, value: result.tierFlipRate, n: result.usable, labels: 'none', note });

  // A value over the pairs every run scored says something about the scorer only when those are nearly all of them.
  const survivors = survivorBias(result);
  if (survivors) out.push(unmeasured('icc_3_runs', 'no_fixture', `${note}: ${survivors}`, { market }));
  else out.push({ metric: 'icc_3_runs', market, value: result.icc, n: result.kept.length, labels: 'none', note });

  const audit = loadScorerAudit(fixturesDir, market);
  if (!audit) {
    const why = `fixtures/${SCORER_FIXTURES}/${SCORER_FILES.audit(market)} is not on disk: no recruiter has graded the recorded pairs yet`;
    for (const metric of ['spearman_human', GAIN_OVER_V3]) out.push(unmeasured(metric, 'no_fixture', why, { market }));
    return out;
  }
  const human = spearmanWithHuman(result, audit);
  const graded = `recruiter grades of ${audit.gradedAt.slice(0, 10)}`;
  const tooFew = (n: number) => `${n} graded pairs were scored in every run; ${SCORER_MIN_PAIRS} are needed (two pairs always give +1 or -1)`;
  if (survivors || human.n < SCORER_MIN_PAIRS) {
    for (const metric of ['spearman_human', GAIN_OVER_V3]) out.push(unmeasured(metric, 'no_fixture', `${graded}; ${note}: ${survivors ?? tooFew(human.n)}`, { market, labels: 'human', n: human.n }));
    return out;
  }
  out.push({ metric: 'spearman_human', market, value: human.value, n: human.n, labels: 'human', note: `${graded}; ${note}` });
  // "Not below the current scorer": the same correlation for scorer v3, recorded the same way. Without that
  // recording the comparison is NOT measured, and the row says which file is missing and how to make it: a
  // `spearman_human` that passes must never read as the whole of SM-8.
  const previousFile = `fixtures/${SCORER_FIXTURES}/${SCORER_FILES.recorded(market, 'scorer_v3')}`;
  const previous = loadRecording(fixturesDir, market, 'scorer_v3');
  if (!previous) {
    out.push(unmeasured(GAIN_OVER_V3, 'no_fixture', `${previousFile} is not on disk: record scorer v3 with "${RECORD_V3_HINT}", review it and copy it there`, { market, labels: 'human' }));
    return out;
  }
  const before = await replayRecording(previous, fixturesDir);
  const v3 = before ? spearmanWithHuman(before, audit) : null;
  if (!before || !v3) {
    out.push(unmeasured(GAIN_OVER_V3, 'no_fixture', `${previousFile}: no personas, postings or labels for ${market} in fixtures/`, { market, labels: 'human' }));
    return out;
  }
  const v3Note = recordingNote(previous, before);
  const v3Unreadable = survivorBias(before) ?? (v3.n < SCORER_MIN_PAIRS ? tooFew(v3.n) : null);
  if (v3Unreadable) {
    for (const metric of ['spearman_human_v3', GAIN_OVER_V3]) out.push(unmeasured(metric, 'no_fixture', `${v3Note}: ${v3Unreadable}`, { market, labels: 'human', n: v3.n }));
    return out;
  }
  out.push({ metric: 'spearman_human_v3', market, value: v3.value, n: v3.n, labels: 'human', note: v3Note });
  const gain = human.value !== null && v3.value !== null ? human.value - v3.value : null;
  out.push({ metric: GAIN_OVER_V3, market, value: gain, n: Math.min(human.n, v3.n), labels: 'human', note: 'scorer v4 minus scorer v3; must not be below 0' });
  return out;
}

/**
 * Why a value over the pairs every run scored is not read, or null when it
 * is: those pairs must be at least `MIN_MEASURED_SHARE` of the usable ones and
 * at least `SCORER_MIN_PAIRS`.
 */
export function survivorBias(result: ReplayResult): string | null {
  const share = result.usable ? result.kept.length / result.usable : 0;
  if (share < MIN_MEASURED_SHARE - 1e-9) {
    return `only ${result.kept.length} of ${result.usable} pairs (${Math.round(share * 1000) / 10}%) were scored in every run; under ${MIN_MEASURED_SHARE * 100}% a value over them describes the survivors, not the scorer (the others are counted in tier_flip_rate)`;
  }
  if (result.kept.length < SCORER_MIN_PAIRS) return `${result.kept.length} pairs were scored in every run; ${SCORER_MIN_PAIRS} are needed`;
  return null;
}

// ── The self-check ────────────────────────────────────────────────────────

const SELFCHECK_USER = 'selfcheck-user';

function selfcheckWorld(pair: SelfcheckPair): World {
  const base = defaultUserInputs();
  const job: MatchJobRecord = jobRecord({
    id: pair.id,
    market: pair.market,
    title: pair.posting.title,
    description: pair.posting.description,
    descriptionPlain: pair.posting.description,
    qualifications: pair.posting.qualifications,
    seniority: pair.posting.seniority,
    marketTags: (pair.posting.classYears ?? []).map((year) => ({ tag: `class_year:${year}`, evidenceQuote: pair.posting.classYearQuote ?? null })),
  });
  // A stored list is the posting's only for the text it was copied from: it carries the key of this posting's text
  // (`requirementListHash`: no skills, the key enrichment and the scorer both write).
  if (pair.posting.requirements) job.requirements = { v: 1, contentHash: requirementListHash(job), model: 'selfcheck', extractedAt: '2026-10-01T00:00:00.000Z', items: pair.posting.requirements };
  return createWorld({
    brand: pair.market === 'cn' ? 'goapply' : 'roboapply',
    jobs: [job],
    users: { [SELFCHECK_USER]: { ...base, profile: base.profile ? { ...base.profile, cnFields: pair.market === 'cn' && typeof pair.classYear === 'number' ? { graduationClass: pair.classYear } : null } : null } },
    resumes: [{ ...resumeRecord({ id: `rv-${pair.id}`, resumeMarkdown: pair.resume, resumeContentHash: resumeHash(pair.resume), parsedData: null }), userId: SELFCHECK_USER }],
  });
}

/** The edge a total is within 3 points of (the default edges: the self-check world sets none), or null. */
function nearEdge(total: number): number | null {
  const near = [EVAL_DEFAULT_TIERS.possible, EVAL_DEFAULT_TIERS.good, EVAL_DEFAULT_TIERS.great].filter((edge) => Math.abs(total - edge) < 3).sort((a, b) => Math.abs(total - a) - Math.abs(total - b));
  return near[0] ?? null;
}

export interface SelfcheckResult {
  icc: number | null;
  tierFlipRate: number | null;
  pairs: number;
  /** Why the pipeline is not stable or not right, pair by pair; empty when it is. */
  problems: string[];
  /** Pairs whose tier could not be held against the hand-written one (their estimate could not be put where the fixture says). */
  notes: string[];
}

/**
 * Three hand-written answers per pair, replayed like a recording. Identical
 * input must give the hand-computed total, the hand-computed components and
 * one tier, in all three spellings.
 */
export async function runSelfcheck(pairs: readonly SelfcheckPair[]): Promise<SelfcheckResult> {
  const scores: number[][] = Array.from({ length: SCORER_RUNS }, () => []);
  const tiers: Array<Array<string | null>> = Array.from({ length: SCORER_RUNS }, () => []);
  const problems: string[] = [];
  const notes: string[] = [];
  for (const pair of pairs) {
    // The estimate of the pair, put on the AI scale where the fixture says, so the tier rule has a known side to read.
    const calibration: MatchServiceDeps['calibration'] = async () => ({ map: { knots: [[0, pair.estimate], [100, pair.estimate]] }, priors: null });
    const before = await scoreOnce(selfcheckWorld(pair), { userId: SELFCHECK_USER, jobId: pair.id, locale: 'en', prompt: 'scorer_v4', answerer: { kind: 'replay', answer: null }, deps: { calibration }, allowModelCall: false });
    const estimate = typeof before.fit.score === 'number' ? before.fit.score : null;
    const edge = nearEdge(pair.expected.total);
    const sideKnown = edge === null || (estimate !== null && estimate >= edge === pair.estimate >= edge);
    if (!sideKnown) notes.push(`${pair.id}: the estimate reads ${estimate ?? 'none'}, not on the side of ${edge} the fixture's ${pair.estimate} is; its tier was not held against the hand-written one`);
    for (let run = 0; run < SCORER_RUNS; run += 1) {
      const once = await scoreOnce(selfcheckWorld(pair), { userId: SELFCHECK_USER, jobId: pair.id, locale: 'en', prompt: 'scorer_v4', answerer: { kind: 'replay', answer: pair.answers[run]! }, deps: { calibration } });
      if (once.score === null) {
        problems.push(`${pair.id}, answer ${run + 1}: no score (the checklist path did not run or refused the answer)`);
        continue;
      }
      scores[run]!.push(once.score);
      tiers[run]!.push(once.tier);
      if (once.score !== pair.expected.total) problems.push(`${pair.id}, answer ${run + 1}: total ${once.score}, worked out by hand as ${pair.expected.total}`);
      if (sideKnown && once.tier !== pair.expected.tier) problems.push(`${pair.id}, answer ${run + 1}: tier ${once.tier}, worked out by hand as ${pair.expected.tier}`);
      for (const key of ['title_level', 'skills', 'industry', 'career_path'] as const) {
        const got = once.fit.dimensions.find((d) => d.key === key)?.score ?? null;
        if (got !== pair.expected[key]) problems.push(`${pair.id}, answer ${run + 1}: ${key} ${got ?? 'not stated'}, worked out by hand as ${pair.expected[key] ?? 'not stated'}`);
      }
    }
  }
  const complete = scores.every((row) => row.length === pairs.length);
  const value = complete ? icc(scores) : null;
  const flips = complete ? tierFlipRate(tiers) : null;
  if (complete && value !== 1) problems.push(`the three answers of a pair must give one total: ICC ${value ?? 'n/a'}, not 1`);
  if (complete && flips !== 0) problems.push(`the three answers of a pair must give one tier: flip rate ${flips ?? 'n/a'}, not 0`);
  return { icc: value, tierFlipRate: flips, pairs: pairs.length, problems, notes };
}

// ── Live: record three runs of the real scorer ────────────────────────────

export interface RecordDeps {
  /** The scorer model of the brand in context, or null when none is configured. */
  resolveModel: () => Promise<string | null>;
  /** The scorer prompt pinned for the brand in context. */
  pinnedPrompt: (market: SuiteMarket) => Promise<FitPromptVersion>;
  /** One first score of one pair by the real scorer (tests give a fake). */
  score: (world: World, input: { userId: string; jobId: string; locale: string; prompt: FitPromptVersion; model: string }) => Promise<ScoredOnce>;
  maxPairs: number;
}

async function defaultResolveModel(): Promise<string | null> {
  try {
    const { resolvedJobMatchScorerModel } = await import('../../../../roboapply/v2/agents/RAJobMatchScorerAgent.js');
    return resolvedJobMatchScorerModel();
  } catch {
    return null;
  }
}

async function defaultPinnedPrompt(market: SuiteMarket): Promise<FitPromptVersion> {
  const { currentScorerPin } = await import('../../config.js');
  return currentScorerPin(market === 'cn' ? 'goapply' : 'roboapply', null).prompt;
}

/** The real scorer on the world's fakes: the real model, the brand's real route check, the pin of the environment. */
const defaultRecordScore: RecordDeps['score'] = (world, input) =>
  scoreOnce(world, { userId: input.userId, jobId: input.jobId, locale: input.locale, prompt: input.prompt, answerer: { kind: 'live' }, deps: { resolveModel: () => input.model, routeAllowed: undefined } });

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await work(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export type RecordOutcome = { recording: Recording; file: string; sheet: string | null } | { skipped: string };

/**
 * Three runs of the pinned scorer on a fixed draw of the market's pooled
 * synthetic pairs, written as a recording. Every answer is kept as the model
 * wrote it, also one that does not parse; a call that failed is null.
 */
export async function recordMarket(input: { market: SuiteMarket; fixturesDir: string; outDir: string; now: Date; deps?: Partial<RecordDeps> }): Promise<RecordOutcome> {
  const deps: RecordDeps = { resolveModel: defaultResolveModel, pinnedPrompt: defaultPinnedPrompt, score: defaultRecordScore, maxPairs: STABILITY_PAIRS, ...input.deps };
  const fx = loadMarketFixtures(input.market, input.fixturesDir);
  if (!fx) return { skipped: `no personas, postings or labels for ${input.market} in fixtures/` };
  const personas = new Map(fx.personas.map((p) => [p.id, p]));
  const postings = new Map(fx.postings.map((p) => [p.id, p]));
  const pooled = Object.entries(fx.labels.labels).flatMap(([personaId, byPosting]) => Object.keys(byPosting).map((postingId) => ({ personaId, postingId })));
  const drawn = stabilitySample(pooled.filter((p) => personas.has(p.personaId) && postings.has(p.postingId)), deps.maxPairs);
  if (drawn.length < 2) return { skipped: `fewer than two pooled pairs for ${input.market}` };

  const probe = fixtureWorld(input.market, fx.personas, fx.postings);
  const model = await probe.inBrand(() => deps.resolveModel());
  if (!model) return { skipped: `no scorer model is configured for ${input.market}` };
  const prompt = await probe.inBrand(() => deps.pinnedPrompt(input.market));

  const answers: Array<Array<string | null>> = drawn.map(() => []);
  const hashes: Array<string | null> = drawn.map(() => null);
  for (let run = 0; run < SCORER_RUNS; run += 1) {
    const world = fixtureWorld(input.market, fx.personas, fx.postings);
    const traces = await pool(drawn, RECORD_CONCURRENCY, async (pair) => {
      try {
        return (await deps.score(world, { userId: pair.personaId, jobId: pair.postingId, locale: personas.get(pair.personaId)!.locale, prompt, model })).trace;
      } catch {
        return { inputHash: null, raw: null } satisfies CallTrace;
      }
    });
    for (const [i, trace] of traces.entries()) {
      answers[i]!.push(trace.raw);
      hashes[i] = hashes[i] ?? trace.inputHash;
    }
  }
  if (answers.every((row) => row.every((a) => a === null))) return { skipped: `the scorer gave no answer for ${input.market} (no route this brand may use, or every call failed): nothing was written` };

  const recording: Recording = {
    _synthetic: true,
    _recordedBy: RECORD_HINT,
    market: input.market,
    scorer: { prompt, rubric: prompt === 'scorer_v4' ? 'fit_v4' : 'fit_v3', model },
    recordedAt: input.now.toISOString(),
    runs: SCORER_RUNS,
    pairs: drawn.map((pair, i) => ({ personaId: pair.personaId, postingId: pair.postingId, inputHash: hashes[i] ?? null, answers: answers[i]! })),
  };
  mkdirSync(input.outDir, { recursive: true });
  const file = path.join(input.outDir, SCORER_FILES.recorded(input.market, prompt));
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);

  // The sheet a recruiter grades: what the scorer saw of the person and the posting, and an empty grade column.
  const sheet = path.join(input.outDir, SCORER_FILES.auditSheet(input.market));
  writeFileSync(sheet, auditCsv(drawn.map((pair) => auditRow(input.market, personas.get(pair.personaId)!, postings.get(pair.postingId)!))));
  return { recording, file, sheet };
}

function auditRow(market: SuiteMarket, persona: Persona, posting: { id: string; title: string; description: string; qualifications: string | null }): AuditPair {
  return {
    personaId: persona.id,
    postingId: posting.id,
    market,
    judgeGrade: 0,
    personaSummary: `${persona.level.replace(/_/g, ' ')}; ${persona.yearsExperience} years of experience; ${persona.roleId.replace(/_/g, ' ')}`,
    personaResume: persona.resumeMarkdown,
    postingTitle: posting.title,
    postingText: [posting.description, posting.qualifications ?? ''].filter(Boolean).join('\n\n'),
  };
}

/** The recruiters' sheet, graded, as the audit fixture of a market (pairs with no grade are left out). */
export function scorerAuditFromCsv(csv: string, market: SuiteMarket, now: Date): ScorerAudit {
  const grades: ScorerAudit['grades'] = {};
  for (const row of parseAuditCsv(csv)) if (row.pairId && row.grade !== null) grades[row.pairId] = row.grade as 0 | 1 | 2 | 3;
  return { _synthetic: true, market, labels: 'human', gradedAt: now.toISOString(), grades };
}

// ── The suite ─────────────────────────────────────────────────────────────

const SELFCHECK_METRICS = ['selfcheck_icc_3_runs', 'selfcheck_tier_flip_rate'] as const;
const GATED_METRICS = ['icc_3_runs', 'tier_flip_rate', 'spearman_human', GAIN_OVER_V3] as const;

export async function run(ctx: SuiteContext): Promise<SuiteMeasure[]> {
  // The suite reads the fit through its seam: without it nothing here is built.
  try {
    await createWorld().fit();
  } catch (err) {
    if (!isSeamMissing(err)) throw err;
    return [...ctx.markets.flatMap((market) => GATED_METRICS.map((metric) => notBuiltOrThrow(metric, err, { market }))), ...SELFCHECK_METRICS.map((metric) => notBuiltOrThrow(metric, err, { market: 'all' }))];
  }

  const out: SuiteMeasure[] = [];
  const recordNow = ctx.live && process.env[RECORD_SWITCH] === '1';
  const outDir = path.join(ctx.evalDir, '.snapshots', ctx.now.toISOString().slice(0, 10), SCORER_FIXTURES);
  for (const market of ctx.markets) {
    const committed = `fixtures/${SCORER_FIXTURES}/${SCORER_FILES.recorded(market)}`;
    if (recordNow) {
      const recorded = await recordMarket({ market, fixturesDir: ctx.fixturesDir, outDir, now: ctx.now });
      if ('skipped' in recorded) {
        for (const metric of GATED_METRICS) out.push(unmeasured(metric, 'no_fixture', `not recorded: ${recorded.skipped}`, { market }));
        continue;
      }
      // Measured on what was just written. It becomes the committed fixture only after the owner reviewed and copied it.
      const rows = await marketMeasures(market, ctx.fixturesDir, recorded.recording, committed);
      const written = `written to ${path.relative(ctx.repoRoot, recorded.file)} (review it, then copy it to ${committed}); recruiters' sheet: ${recorded.sheet ? path.relative(ctx.repoRoot, recorded.sheet) : 'none'}`;
      out.push(...rows.map((m) => ({ ...m, note: [m.note, written].filter(Boolean).join('; ') })));
      continue;
    }
    out.push(...(await marketMeasures(market, ctx.fixturesDir, loadRecording(ctx.fixturesDir, market), committed)));
  }

  const selfcheck = loadSelfcheck(ctx.fixturesDir);
  if (!selfcheck) {
    for (const metric of SELFCHECK_METRICS) out.push(unmeasured(metric, 'no_fixture', `fixtures/${SCORER_FIXTURES}/${SCORER_FILES.selfcheck} is not on disk`, { market: 'all' }));
    return out;
  }
  const check = await runSelfcheck(selfcheck);
  // Identical input that does not give identical, hand-checked numbers is a broken pipeline: the command fails.
  if (check.problems.length) throw new Error(`scorer self-check failed: ${check.problems.slice(0, 6).join(' | ')}${check.problems.length > 6 ? ` | and ${check.problems.length - 6} more` : ''}`);
  const note = [`${check.pairs} hand-written pairs, ${SCORER_RUNS} hand-written answers each (no model): parser, verification, arithmetic and borderline rule`, ...check.notes].join('; ');
  out.push({ metric: 'selfcheck_icc_3_runs', market: 'all', value: check.icc, n: check.pairs, labels: 'none', note });
  out.push({ metric: 'selfcheck_tier_flip_rate', market: 'all', value: check.tierFlipRate, n: check.pairs, labels: 'none', note });
  return out;
}

// ── Importing the recruiters' sheet (a file conversion: no database, no model) ──
//
//   npx tsx server/src/features/match/eval/suites/scorer.suite.ts --import-audit <graded.csv> --market intl|cn

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function importAuditMain(argv: readonly string[], io: { log: (line: string) => void; now: () => Date; fixturesDir: string } = { log: (l) => console.log(l), now: () => new Date(), fixturesDir: FIXTURES_DIR }): number {
  const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const csv = at('--import-audit');
  const market = at('--market');
  if (!csv || (market !== 'intl' && market !== 'cn')) {
    io.log('Usage: npx tsx server/src/features/match/eval/suites/scorer.suite.ts --import-audit <graded.csv> --market intl|cn');
    return 2;
  }
  const audit = scorerAuditFromCsv(readFileSync(path.resolve(csv), 'utf8'), market, io.now());
  const file = path.join(scorerDir(io.fixturesDir), SCORER_FILES.audit(market));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(audit, null, 2)}\n`);
  io.log(`Stored ${Object.keys(audit.grades).length} recruiter grades for ${market} in ${file}.`);
  return 0;
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) process.exit(importAuditMain(process.argv.slice(2)));
