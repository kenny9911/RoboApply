// server/src/features/match/eval/live/judge.ts
//
// The LLM judge with its cache. One call per (persona, posting) pair; the
// answer is cached on disk under sha1(prompt version, persona id, persona
// content hash, posting content hash), so a second run costs nothing. The two
// content hashes cover everything the prompt shows the judge: a persona whose
// resume was regenerated under the same id, or a posting whose employer, place
// or pay line changed, is judged again. An entry written by another judge
// model is not reused.
//
// Rules: the judge model comes from EVAL_JUDGE_MODEL and must differ from the
// production scorer's model of the market being judged (a model must not grade
// its own homework); with no judge model nothing is judged. The call goes
// through the platform LLM service, so its cost lands in the existing usage
// log. Only synthetic personas are sent.

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JUDGE_PROMPT_VERSION, buildJudgeMessages, type JudgeMessage, type JudgePersona, type JudgePosting } from './judgePrompt.js';

export class JudgeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeRefused';
  }
}

export type JudgeGrade = 0 | 1 | 2 | 3;

export interface JudgeVerdict {
  personaId: string;
  postingId: string;
  grade: JudgeGrade;
  reason: string;
  model: string;
  promptVersion: string;
  /** Hash of the posting as the judge read it. */
  contentHash: string;
  /** Hash of the persona as the judge read it. */
  personaHash: string;
  cached: boolean;
}

export type JudgeCall = (messages: JudgeMessage[], options: { model: string }) => Promise<unknown>;

export interface JudgeDeps {
  /** EVAL_JUDGE_MODEL. */
  judgeModel: string | null | undefined;
  /** The model the production scorer resolves to for the brand of the pairs' market (LLM_MATCHING_MODEL, else the brand's default). */
  scorerModel: string | null | undefined;
  call: JudgeCall;
  cacheDir: string;
}

const norm = (m: string | null | undefined): string => (m ?? '').trim().toLowerCase();

/** The judge model to use, or a refusal: unset, or the same model as the scorer. */
export function assertJudgeModel(judgeModel: string | null | undefined, scorerModel: string | null | undefined): string {
  const judge = (judgeModel ?? '').trim();
  if (!judge) throw new JudgeRefused('EVAL_JUDGE_MODEL is not set: nothing is judged.');
  // A provider prefix does not make it another model ("openrouter/x/y" and "x/y").
  const bare = (m: string) => norm(m).replace(/^openrouter\//, '');
  if (scorerModel && bare(judge) === bare(scorerModel)) {
    throw new JudgeRefused(`EVAL_JUDGE_MODEL (${judge}) is the model the scorer uses. The judge must be a different, stronger model.`);
  }
  return judge;
}

const sha1 = (parts: ReadonlyArray<string | null>): string => crypto.createHash('sha1').update(parts.map((p) => p ?? '').join('\n\u0000')).digest('hex');

/** The hash of everything the prompt shows of a posting: a posting changed in any shown field is judged again. */
export function postingContentHash(posting: Omit<JudgePosting, 'id'>): string {
  return sha1([posting.title, posting.companyName, posting.location, posting.payText, posting.description, posting.qualifications]);
}

/** The hash of everything the prompt shows of a persona: a regenerated resume under the same id is judged again. */
export function personaContentHash(persona: Omit<JudgePersona, 'id'>): string {
  return sha1([persona.summary, persona.resumeMarkdown]);
}

export function judgeCacheKey(promptVersion: string, personaId: string, personaHash: string, contentHash: string): string {
  return crypto.createHash('sha1').update(`${promptVersion}\n${personaId}\n${personaHash}\n${contentHash}`).digest('hex');
}

export function parseJudgeAnswer(raw: unknown): { grade: JudgeGrade; reason: string } {
  let v: unknown = raw;
  if (typeof v === 'string') {
    const m = v.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('the judge answered no JSON object');
    v = JSON.parse(m[0]);
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const grade = Number(o.grade);
  if (!Number.isInteger(grade) || grade < 0 || grade > 3) throw new Error(`the judge answered grade ${JSON.stringify(o.grade)} (expected 0, 1, 2 or 3)`);
  return { grade: grade as JudgeGrade, reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 400) : '' };
}

interface CacheEntry {
  personaId: string;
  postingId: string;
  grade: JudgeGrade;
  reason: string;
  model: string;
  promptVersion: string;
  contentHash: string;
  personaHash: string;
}

function readCache(file: string): CacheEntry | null {
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry;
    return Number.isInteger(v.grade) && v.grade >= 0 && v.grade <= 3 && typeof v.model === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Grade one pair, from the cache when it holds this judge's answer for this posting text. */
export async function judgePair(persona: JudgePersona, posting: JudgePosting, deps: JudgeDeps): Promise<JudgeVerdict> {
  const model = assertJudgeModel(deps.judgeModel, deps.scorerModel);
  const contentHash = postingContentHash(posting);
  const personaHash = personaContentHash(persona);
  const file = path.join(deps.cacheDir, `${judgeCacheKey(JUDGE_PROMPT_VERSION, persona.id, personaHash, contentHash)}.json`);
  const hit = readCache(file);
  if (hit && norm(hit.model) === norm(model) && hit.promptVersion === JUDGE_PROMPT_VERSION && hit.personaHash === personaHash && hit.contentHash === contentHash) {
    return { ...hit, personaId: persona.id, postingId: posting.id, cached: true };
  }
  const answer = parseJudgeAnswer(await deps.call(buildJudgeMessages(persona, posting), { model }));
  const entry: CacheEntry = { personaId: persona.id, postingId: posting.id, grade: answer.grade, reason: answer.reason, model, promptVersion: JUDGE_PROMPT_VERSION, contentHash, personaHash };
  mkdirSync(deps.cacheDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  return { ...entry, cached: false };
}

export interface JudgedBatch {
  verdicts: JudgeVerdict[];
  calls: number;
  cacheHits: number;
  /** Pairs the judge could not grade (a malformed answer, a failed call); never given a grade. */
  failed: Array<{ personaId: string; postingId: string; error: string }>;
}

export async function judgePairs(pairs: ReadonlyArray<{ persona: JudgePersona; posting: JudgePosting }>, deps: JudgeDeps): Promise<JudgedBatch> {
  assertJudgeModel(deps.judgeModel, deps.scorerModel);
  const out: JudgedBatch = { verdicts: [], calls: 0, cacheHits: 0, failed: [] };
  for (const { persona, posting } of pairs) {
    try {
      const v = await judgePair(persona, posting, deps);
      out.verdicts.push(v);
      if (v.cached) out.cacheHits += 1;
      else out.calls += 1;
    } catch (err) {
      if (err instanceof JudgeRefused) throw err;
      out.failed.push({ personaId: persona.id, postingId: posting.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * The production call: the platform LLM service (per-brand policy, usage
 * log). `runLive` makes it inside the brand of the market being judged.
 * Personas are synthetic: no user data.
 */
export const defaultJudgeCall: JudgeCall = async (messages, options) => {
  const { llmService } = await import('../../../../services/llm/LLMService.js');
  return llmService.chatWithJsonResponse<unknown>(messages, { model: options.model, task: 'eval_judge', carriesUserData: false, temperature: 0 });
};
