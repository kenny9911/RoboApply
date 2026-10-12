// server/src/interview-engine/prep/contract.ts
//
// The interview-prep contract: what the setup screen asks for (a job search,
// an industry's roles, an interview plan) and what a session carries once the
// candidate starts (`StoredPrep`, kept in InterviewSession.blueprint.prep — no
// schema change).
//
// Everything a model wrote or a browser sent passes through the sanitizers
// here before it reaches a prompt: strings are trimmed, single-lined where
// they are names, length-capped, and enum fields are checked against the
// skill registry. A plan is the user's own input to their own practice (like
// a pasted job post), so it is cleaned, not trusted.

import { z } from 'zod';
import type { InterviewArchetype } from '../catalog/interviewArchetypes.js';
import { getFormat, type FormatMarket } from '../catalog/interviewFormats.js';
import {
  basePersonaFor,
  cleanPatternKeys,
  formatOrDefault,
  getMarketNorms,
  isArchetype,
  type InterviewMarketKey,
  type InterviewPatternKey,
} from '../skills/index.js';

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface PrepRoleSuggestion {
  /** The title shown, in the candidate's language. */
  title: string;
  /** The English title used for searching, when it differs. */
  titleEn: string | null;
  /** Where the suggestion came from: the job taxonomy or the role agent. */
  source: 'taxonomy' | 'ai';
  /** A short context line (the taxonomy path, or what the role does). */
  context: string | null;
  /** The job-taxonomy role id, when the suggestion is one (the client labels it in every locale). */
  taxonomyId?: string | null;
}

export type PrepPostingSource = 'index' | 'provider' | 'web';

export interface PrepPosting {
  /** Stable within a search: `job:<id>`, `ext:<provider>:<id>`, `web:<hash>`. */
  ref: string;
  source: PrepPostingSource;
  /** The upstream name for provider and web results (jsearch, activejobs, a host name). */
  provider: string | null;
  /** Our own job id (index results): the plan and the session load the post themselves. */
  jobId: string | null;
  title: string;
  company: string | null;
  location: string | null;
  postedAt: string | null;
  url: string | null;
  snippet: string | null;
  /** Provider and web results only: the post's text, clipped (the plan reads it). */
  description: string | null;
}

export type PrepSourceStatus = 'ok' | 'empty' | 'unavailable' | 'error' | 'skipped';

export interface PrepSearchResult {
  query: string;
  /** What the query was read as: canonical titles, best first. */
  understood: { titles: string[]; seniority: string | null; industry: string | null };
  roles: PrepRoleSuggestion[];
  postings: PrepPosting[];
  market: { key: InterviewMarketKey; country: string | null };
  sources: Array<{ id: 'index' | 'providers' | 'web'; status: PrepSourceStatus; count: number }>;
}

export interface PrepRequirements {
  summary: string;
  seniority: string;
  mustHave: string[];
  niceToHave: string[];
  responsibilities: string[];
  competencies: string[];
}

export interface PrepSource {
  title: string;
  url: string;
}

export interface PrepCompanyStyle {
  company: string;
  summary: string;
  stages: Array<{ name: string; description: string }>;
  values: string[];
  evaluates: string[];
  questionThemes: string[];
  tips: string[];
  patterns: InterviewPatternKey[];
  sources: PrepSource[];
  /** 'sources' = grounded on public pages found today; 'general' = none found, the usual practice for the role. */
  basis: 'sources' | 'general';
}

export interface PrepInterviewer {
  key: string;
  name: string;
  title: string;
  background: string;
  style: string;
  archetype: InterviewArchetype;
  /** 1 (gentle) .. 3 (demanding). */
  difficulty: 1 | 2 | 3;
  voiceGender: 'female' | 'male';
  /** The catalog persona the engine runs on (voice, base difficulty, older readers). */
  baseId: string;
  focusKeys: string[];
  patterns: InterviewPatternKey[];
}

export interface PrepFocus {
  key: string;
  label: string;
  description: string;
  /** An interview format id (interviewFormats.ts) valid on the market. */
  format: string;
  patterns: InterviewPatternKey[];
  topics: string[];
}

export interface PrepStrategy {
  summary: string;
  stages: Array<{ name: string; goal: string; share: number }>;
  tactics: string[];
  prepTips: string[];
}

export interface PrepPlan {
  v: 1;
  role: string;
  company: string | null;
  industry: string | null;
  market: InterviewMarketKey;
  /** The language the plan's text is written in (the UI language). */
  language: string;
  jobId: string | null;
  posting: { title: string; company: string | null; location: string | null; url: string | null } | null;
  requirements: PrepRequirements;
  companyStyle: PrepCompanyStyle | null;
  interviewers: PrepInterviewer[];
  focuses: PrepFocus[];
  recommended: { interviewerKey: string; focusKey: string };
  strategy: PrepStrategy;
  domain: { key: string; label: string } | null;
  sources: PrepSource[];
  generatedAt: string;
  /** True when the plan was assembled without the language model. */
  fallback?: boolean;
}

/** What a session keeps (InterviewSession.blueprint.prep / RAMockSession.blueprint.prep). */
export interface StoredPrep {
  v: 1;
  role: string;
  company: string | null;
  industry: string | null;
  market: InterviewMarketKey;
  requirements: PrepRequirements;
  companyStyle: PrepCompanyStyle | null;
  interviewer: PrepInterviewer;
  focus: PrepFocus;
  strategy: PrepStrategy;
}

// ─── Request bodies ─────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);

export const PrepSearchBodySchema = z.object({
  query: text(160).min(1),
  company: text(120).optional(),
  industry: text(80).optional(),
  /** Also ask the job boards and the web (default true). */
  external: z.boolean().optional(),
});
export type PrepSearchBody = z.infer<typeof PrepSearchBodySchema>;

export const PrepRolesBodySchema = z.object({
  industry: text(80).min(1),
});

// Long values are accepted and clipped where they are read (a pasted post or a
// tracking-laden apply link must never fail the plan); only absurd sizes are refused.
export const PrepPlanBodySchema = z.object({
  role: text(400).optional(),
  company: text(200).optional(),
  industry: text(160).optional(),
  jobId: text(64).optional(),
  jdText: text(60_000).optional(),
  posting: z
    .object({
      title: text(400),
      company: text(200).nullish(),
      location: text(400).nullish(),
      url: text(4096).nullish(),
    })
    .optional(),
  /** The session language (questions are written in it later); the plan's own text follows the UI locale. */
  language: text(10).optional(),
  durationMinutes: z.number().int().min(5).max(120).optional(),
});
export type PrepPlanBody = z.infer<typeof PrepPlanBodySchema>;

// ─── Sanitizers ─────────────────────────────────────────────────────────────

export function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '';
}

/** A multi-line clip: keeps line breaks (a post or a summary), caps length. */
export function clipBlock(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max).trim() : '';
}

export function clipList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = clip(item, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function safeUrl(value: unknown): string | null {
  const raw = clip(value, 600);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function cleanSources(value: unknown, max = 6): PrepSource[] {
  if (!Array.isArray(value)) return [];
  const out: PrepSource[] = [];
  for (const item of value) {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const url = safeUrl(row.url);
    const title = clip(row.title, 160);
    if (!url || out.some((s) => s.url === url)) continue;
    out.push({ title: title || new URL(url).hostname, url });
    if (out.length >= max) break;
  }
  return out;
}

export function cleanRequirements(value: unknown): PrepRequirements {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    summary: clip(row.summary, 600),
    seniority: clip(row.seniority, 200),
    mustHave: clipList(row.mustHave, 8, 140),
    niceToHave: clipList(row.niceToHave, 6, 140),
    responsibilities: clipList(row.responsibilities, 8, 180),
    competencies: clipList(row.competencies, 8, 120),
  };
}

export function cleanCompanyStyle(value: unknown): PrepCompanyStyle | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const company = clip(row.company, 120);
  const summary = clip(row.summary, 700);
  if (!company || !summary) return null;
  const stages = (Array.isArray(row.stages) ? row.stages : [])
    .map((s) => {
      const stage = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      return { name: clip(stage.name, 80), description: clip(stage.description, 240) };
    })
    .filter((s) => s.name)
    .slice(0, 6);
  const sources = cleanSources(row.sources, 6);
  return {
    company,
    summary,
    stages,
    values: clipList(row.values, 8, 120),
    evaluates: clipList(row.evaluates, 8, 160),
    questionThemes: clipList(row.questionThemes, 8, 160),
    tips: clipList(row.tips, 6, 200),
    patterns: cleanPatternKeys(row.patterns, 5),
    sources,
    // "From public sources" is only ever said with sources to show.
    basis: row.basis === 'sources' && sources.length > 0 ? 'sources' : 'general',
  };
}

export function cleanStrategy(value: unknown): PrepStrategy {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const stages = (Array.isArray(row.stages) ? row.stages : [])
    .map((s) => {
      const stage = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      const share = typeof stage.share === 'number' && Number.isFinite(stage.share) ? Math.min(1, Math.max(0, stage.share)) : 0;
      return { name: clip(stage.name, 60), goal: clip(stage.goal, 200), share };
    })
    .filter((s) => s.name)
    .slice(0, 6);
  return {
    summary: clip(row.summary, 500),
    stages,
    tactics: clipList(row.tactics, 6, 200),
    prepTips: clipList(row.prepTips, 6, 200),
  };
}

function keyOf(value: unknown, fallback: string): string {
  const key = clip(value, 24).replace(/[^A-Za-z0-9_-]/g, '');
  return key || fallback;
}

export function cleanFocus(value: unknown, index: number, market: FormatMarket): PrepFocus | null {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const label = clip(row.label, 80);
  if (!label) return null;
  return {
    key: keyOf(row.key, `f${index + 1}`),
    label,
    description: clip(row.description, 240),
    format: formatOrDefault(row.format, market),
    patterns: cleanPatternKeys(row.patterns, 3),
    topics: clipList(row.topics, 5, 120),
  };
}

export function cleanInterviewer(value: unknown, index: number): PrepInterviewer | null {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const name = clip(row.name, 60);
  const title = clip(row.title, 120);
  if (!name || !title) return null;
  const archetype: InterviewArchetype = isArchetype(row.archetype) ? row.archetype : 'behavioral';
  const rawDifficulty = typeof row.difficulty === 'number' ? Math.round(row.difficulty) : 2;
  const difficulty = (Math.min(3, Math.max(1, rawDifficulty)) as 1 | 2 | 3);
  const voiceGender = row.voiceGender === 'male' ? 'male' : 'female';
  return {
    key: keyOf(row.key, `i${index + 1}`),
    name,
    title,
    background: clip(row.background, 200),
    style: clip(row.style, 220),
    archetype,
    difficulty,
    voiceGender,
    baseId: basePersonaFor({ archetype, difficulty, voiceGender }).id,
    focusKeys: clipList(row.focusKeys, 6, 24),
    patterns: cleanPatternKeys(row.patterns, 3),
  };
}

function uniqueKeys<T extends { key: string }>(rows: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    let key = row.key;
    // A repeated key takes the row's position name, or the next one still free.
    for (let n = index + 1; seen.has(key); n += 1) key = `${prefix}${n}`;
    seen.add(key);
    return { ...row, key };
  });
}

export function cleanInterviewers(value: unknown, max = 4): PrepInterviewer[] {
  const rows = (Array.isArray(value) ? value : [])
    .map((row, index) => cleanInterviewer(row, index))
    .filter((row): row is PrepInterviewer => row !== null)
    .slice(0, max);
  return uniqueKeys(rows, 'i');
}

export function cleanFocuses(value: unknown, market: FormatMarket, max = 6): PrepFocus[] {
  const rows = (Array.isArray(value) ? value : [])
    .map((row, index) => cleanFocus(row, index, market))
    .filter((row): row is PrepFocus => row !== null)
    .slice(0, max);
  return uniqueKeys(rows, 'f');
}

export function marketKeyOr(value: unknown, fallback: InterviewMarketKey): InterviewMarketKey {
  return typeof value === 'string' && getMarketNorms(value) ? (value as InterviewMarketKey) : fallback;
}

/**
 * The prep a session keeps, from what the browser sends at Start: the plan it
 * was shown plus the interviewer and focus chosen. Null when the body names
 * none (an older client, an external caller): the session then runs exactly
 * as before.
 */
export function storedPrepFromBody(value: unknown, market: FormatMarket, fallbackMarket: InterviewMarketKey): StoredPrep | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const plan = (body.plan && typeof body.plan === 'object' ? body.plan : null) as Record<string, unknown> | null;
  if (!plan) return null;
  const interviewers = cleanInterviewers(plan.interviewers);
  const focuses = cleanFocuses(plan.focuses, market);
  const interviewerKey = clip(body.interviewerKey, 24);
  const focusKey = clip(body.focusKey, 24);
  const interviewer = interviewers.find((row) => row.key === interviewerKey) ?? interviewers[0];
  const focus = focuses.find((row) => row.key === focusKey) ?? focuses[0];
  if (!interviewer || !focus) return null;
  return {
    v: 1,
    role: clip(plan.role, 200),
    company: clip(plan.company, 120) || null,
    industry: clip(plan.industry, 80) || null,
    market: marketKeyOr(plan.market, fallbackMarket),
    requirements: cleanRequirements(plan.requirements),
    companyStyle: cleanCompanyStyle(plan.companyStyle),
    interviewer,
    focus,
    strategy: cleanStrategy(plan.strategy),
  };
}

/** A stored prep read back from a session row (null for sessions without one). */
export function readStoredPrep(blueprint: unknown, market: FormatMarket = 'intl'): StoredPrep | null {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) return null;
  const raw = (blueprint as Record<string, unknown>).prep;
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const interviewer = cleanInterviewer(row.interviewer, 0);
  // A stored focus keeps the format it was created with (a GoApply session may run a cn-only format).
  const storedFormat = row.focus && typeof row.focus === 'object' ? (row.focus as Record<string, unknown>).format : null;
  const focusMarket: FormatMarket = typeof storedFormat === 'string' && getFormat(storedFormat)?.markets?.includes('cn') ? 'cn' : market;
  const focus = cleanFocus(row.focus, 0, focusMarket);
  if (!interviewer || !focus) return null;
  return {
    v: 1,
    role: clip(row.role, 200),
    company: clip(row.company, 120) || null,
    industry: clip(row.industry, 80) || null,
    market: marketKeyOr(row.market, 'us'),
    requirements: cleanRequirements(row.requirements),
    companyStyle: cleanCompanyStyle(row.companyStyle),
    interviewer: { ...interviewer, baseId: clip((row.interviewer as Record<string, unknown>).baseId, 40) || interviewer.baseId },
    focus,
    strategy: cleanStrategy(row.strategy),
  };
}

/** Allowed practice lengths (minutes) and the default. */
export const PRACTICE_DURATIONS = [15, 20, 30] as const;
export const DEFAULT_PRACTICE_MINUTES = 20;

/** Snap a requested length onto the offered ones (nearest; ties go shorter). */
export function snapPracticeMinutes(value: unknown, allowed: readonly number[] = PRACTICE_DURATIONS): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_PRACTICE_MINUTES;
  let best = allowed[0];
  for (const option of allowed) {
    if (Math.abs(option - n) < Math.abs(best - n)) best = option;
  }
  return best;
}

/** A company style condensed for a planner or blueprint prompt. */
export function describeCompanyStyle(style: PrepCompanyStyle): string {
  const lines: string[] = [];
  lines.push(
    style.basis === 'sources'
      ? `${style.company} (from public sources): ${style.summary}`
      : `${style.company}: no reliable public description of its interviews was found; usual practice for this kind of company and role: ${style.summary}`,
  );
  if (style.stages.length) lines.push(`Stages: ${style.stages.map((stage) => `${stage.name} — ${stage.description}`).join('; ')}`);
  if (style.values.length) lines.push(`Published values it assesses: ${style.values.join('; ')}`);
  if (style.evaluates.length) lines.push(`Looks for: ${style.evaluates.join('; ')}`);
  if (style.questionThemes.length) lines.push(`Question themes: ${style.questionThemes.join('; ')}`);
  if (style.patterns.length) lines.push(`Patterns: ${style.patterns.join(', ')}`);
  return lines.join('\n');
}
