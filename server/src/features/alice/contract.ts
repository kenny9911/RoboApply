// server/src/features/alice/contract.ts
//
// Wire contract of Alice, the application agent (docs/alice/ALICE.md): what
// she has learned (the brief), the job profiles she writes, their versions,
// the conversation's typed blocks, the thread view, the turn actions and the
// stream events, plus the sanitizers every model answer goes through before
// it is stored or shown. The web mirrors the types through
// lib/api/contracts/alice.ts.
//
// D1: nothing here submits an application. D3: counts are the user's own
// rows; the diff between two versions is computed here, never taken from a
// model.

import { z } from 'zod';
import type { FeedItem } from '../feed/contract.js';
import { COMPANY_SIZES, JOB_TYPES, SENIORITY_LEVELS, WORK_MODELS } from '../search/contract.js';

// ── Enumerations ───────────────────────────────────────────────────────────

/** Stored stages. `drafting` exists only inside a running turn (a progress step), never on a row. */
export const ALICE_STAGES = ['intake', 'choosing', 'refining', 'saved'] as const;
export type AliceStage = (typeof ALICE_STAGES)[number];

/** What Alice asks about (skills/intakeTopics.ts holds the directives). `sponsorship` is RoboApply only. */
export const ALICE_TOPIC_IDS = [
  'roles',
  'level',
  'workSetting',
  'places',
  'pay',
  'industries',
  'companyKind',
  'companySize',
  'companies',
  'dreamJob',
  'values',
  'dealbreakers',
  'timing',
  'sponsorship',
] as const;
export type AliceTopicId = (typeof ALICE_TOPIC_IDS)[number];

/** The kinds of employer a profile can aim at. */
export const COMPANY_KINDS = ['startup', 'scaleup', 'enterprise', 'public_sector', 'nonprofit'] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

export const ALICE_PAY_PERIODS = ['year', 'month', 'hour'] as const;
export const ALICE_TIMINGS = ['now', 'soon', 'exploring'] as const;
export type AliceTiming = (typeof ALICE_TIMINGS)[number];

/** The axes two profiles differ on (skills/profileAxes.ts). */
export const ALICE_AXIS_IDS = ['scope', 'field', 'companyStage', 'workSetting', 'rolePath', 'payVsGrowth', 'breadth'] as const;
export type AliceAxisId = (typeof ALICE_AXIS_IDS)[number];

/** Progress steps a turn reports while a subagent or worker really runs. */
export const ALICE_STEPS = [
  'reading_resume',
  'thinking',
  'reading_goals',
  'writing_profiles',
  'revising',
  'saving',
  'finding_jobs',
  'checking_applications',
] as const;
export type AliceStep = (typeof ALICE_STEPS)[number];

/** The subagent or worker that wrote a message. */
export const ALICE_AGENT_IDS = ['intake', 'analyst', 'writer', 'editor', 'router', 'reporter', 'scout', 'reminders', 'system'] as const;
export type AliceAgentId = (typeof ALICE_AGENT_IDS)[number];

export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];
export type WorkModel = (typeof WORK_MODELS)[number];
export type CompanySize = (typeof COMPANY_SIZES)[number];
export type JobType = (typeof JOB_TYPES)[number];

// ── Limits ─────────────────────────────────────────────────────────────────

export const ALICE_LIMITS = {
  /** A message or quick-reply answer. */
  messageChars: 2000,
  /** A comment on a profile. */
  commentChars: 1000,
  /** Messages a thread view carries (the most recent). */
  messagesShown: 80,
  /** Turns one thread takes before Alice asks to start over. */
  turnsPerThread: 400,
  /** Intake answers after which Alice drafts anyway (once the roles are known). */
  intakeMaxAnswers: 12,
  /** Matches the Job scout returns. */
  matches: 8,
  /** Saved job profiles a user keeps (active and archived). */
  savedProfiles: 20,
  /** Versions a profile keeps (oldest dropped first, the first pick always kept). */
  revisions: 30,
  /** Quick replies under one question. */
  quickReplies: 6,
} as const;

// ── Small sanitizers (every model value goes through these) ────────────────

/** One line: whitespace folded, trimmed, cut to `max`. */
export function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '';
}

/** A short list of unique one-line strings. */
export function clipList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const s = clip(item, maxLen);
    const key = s.toLocaleLowerCase();
    if (s && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Values of `allowed` found in `value` (a list or a single string), in `allowed` order, unique. */
export function pickEnum<T extends string>(value: unknown, allowed: readonly T[], max = allowed.length): T[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const wanted = new Set(raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()));
  return allowed.filter((v) => wanted.has(v)).slice(0, max);
}

function oneEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value.trim()) ? (value.trim() as T) : null;
}

// ── Pay ────────────────────────────────────────────────────────────────────

export interface AlicePay {
  amount: number;
  /** ISO 4217, upper case. */
  currency: string;
  period: (typeof ALICE_PAY_PERIODS)[number];
}

export function cleanPay(value: unknown): AlicePay | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const amount = typeof v.amount === 'number' ? v.amount : typeof v.amount === 'string' ? Number(v.amount.replace(/[^\d.]/g, '')) : NaN;
  const currency = typeof v.currency === 'string' ? v.currency.trim().toUpperCase() : '';
  const period = oneEnum(v.period, ALICE_PAY_PERIODS);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 || !/^[A-Z]{3}$/.test(currency) || !period) return null;
  return { amount: Math.round(amount), currency, period };
}

// ── Places ─────────────────────────────────────────────────────────────────

/**
 * A place as the user named it, with the city and the country when the name
 * gives them ("Berlin" → Berlin, DE). A place with no country ("anywhere in
 * Europe") is kept for the profile's words and never becomes a search filter:
 * no geography is invented (profileFilters.ts).
 */
export interface AlicePlace {
  label: string;
  city: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string | null;
}

export function cleanPlaces(value: unknown, max: number): AlicePlace[] {
  if (!Array.isArray(value)) return [];
  const out: AlicePlace[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw: Record<string, unknown> = item && typeof item === 'object' ? (item as Record<string, unknown>) : { label: item };
    const label = clip(raw.label, 80) || clip(raw.city, 80);
    if (!label) continue;
    const key = label.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const country = typeof raw.country === 'string' && /^[A-Za-z]{2}$/.test(raw.country.trim()) ? raw.country.trim().toUpperCase() : null;
    out.push({ label, city: clip(raw.city, 80) || null, country });
    if (out.length >= max) break;
  }
  return out;
}

// ── The brief: what Alice has learned ──────────────────────────────────────

export interface AliceBrief {
  /** Job titles or kinds of work, in the user's words. */
  roles: string[];
  levels: SeniorityLevel[];
  workModels: WorkModel[];
  /** Places as the user names them ("Berlin", "anywhere in Europe"). */
  places: AlicePlace[];
  /** The pay they want, as a floor. */
  pay: AlicePay | null;
  industries: string[];
  avoidIndustries: string[];
  companyKinds: CompanyKind[];
  companySizes: CompanySize[];
  /** Companies they admire or want to work at. */
  companies: string[];
  avoidCompanies: string[];
  /** The dream job in their words. */
  dreamJob: string | null;
  /** What matters to them (growth, mission, stability, a good manager …). */
  values: string[];
  dealbreakers: string[];
  timing: AliceTiming | null;
  jobTypes: JobType[];
  /** RoboApply only; null = not asked or not said. */
  needsSponsorship: boolean | null;
  /** Anything else they said that a profile should respect. */
  notes: string[];
}

export const EMPTY_BRIEF: AliceBrief = Object.freeze({
  roles: [],
  levels: [],
  workModels: [],
  places: [],
  pay: null,
  industries: [],
  avoidIndustries: [],
  companyKinds: [],
  companySizes: [],
  companies: [],
  avoidCompanies: [],
  dreamJob: null,
  values: [],
  dealbreakers: [],
  timing: null,
  jobTypes: [],
  needsSponsorship: null,
  notes: [],
}) as AliceBrief;

/** A stored or model-written brief, cleaned. Missing fields are empty. */
export function cleanBrief(value: unknown): AliceBrief {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const dream = clip(v.dreamJob, 500);
  return {
    roles: clipList(v.roles, 8, 80),
    levels: pickEnum(v.levels, SENIORITY_LEVELS, 3),
    workModels: pickEnum(v.workModels, WORK_MODELS),
    places: cleanPlaces(v.places, 8),
    pay: cleanPay(v.pay),
    industries: clipList(v.industries, 8, 60),
    avoidIndustries: clipList(v.avoidIndustries, 8, 60),
    companyKinds: pickEnum(v.companyKinds, COMPANY_KINDS),
    companySizes: pickEnum(v.companySizes, COMPANY_SIZES),
    companies: clipList(v.companies, 12, 80),
    avoidCompanies: clipList(v.avoidCompanies, 12, 80),
    dreamJob: dream || null,
    values: clipList(v.values, 8, 80),
    dealbreakers: clipList(v.dealbreakers, 8, 120),
    timing: oneEnum(v.timing, ALICE_TIMINGS),
    jobTypes: pickEnum(v.jobTypes, JOB_TYPES),
    needsSponsorship: typeof v.needsSponsorship === 'boolean' ? v.needsSponsorship : null,
    notes: clipList(v.notes, 8, 160),
  };
}

const LIST_BRIEF_FIELDS = ['roles', 'places', 'industries', 'avoidIndustries', 'companies', 'avoidCompanies', 'values', 'dealbreakers', 'notes'] as const;
/** Brief fields a "take back" (`cleared`) may name. */
export const BRIEF_FIELDS = [...LIST_BRIEF_FIELDS, 'levels', 'workModels', 'companyKinds', 'companySizes', 'jobTypes', 'pay', 'dreamJob', 'timing', 'needsSponsorship'] as const;
const ENUM_BRIEF_FIELDS = ['levels', 'workModels', 'companyKinds', 'companySizes', 'jobTypes'] as const;

/**
 * Fold what the Intake interviewer learned from one answer into the brief.
 * A list the model returns replaces the stored list only when it is not
 * empty (the model answers with the whole list as it now stands); scalars
 * replace when set. `cleared` names fields the user took back ("not remote
 * after all"): those are emptied.
 */
export function mergeBrief(base: AliceBrief, learned: Partial<AliceBrief>, cleared: readonly string[] = []): AliceBrief {
  const next: AliceBrief = { ...base };
  const clean = cleanBrief({ ...base, ...learned });
  for (const f of LIST_BRIEF_FIELDS) if (Array.isArray(learned[f]) && (learned[f] as unknown[]).length) (next as unknown as Record<string, unknown>)[f] = clean[f];
  for (const f of ENUM_BRIEF_FIELDS) if (Array.isArray(learned[f]) && (learned[f] as unknown[]).length) (next as unknown as Record<string, unknown>)[f] = clean[f];
  if (learned.pay !== undefined && clean.pay) next.pay = clean.pay;
  if (typeof learned.dreamJob === 'string' && clean.dreamJob) next.dreamJob = clean.dreamJob;
  if (learned.timing !== undefined && clean.timing) next.timing = clean.timing;
  if (typeof learned.needsSponsorship === 'boolean') next.needsSponsorship = learned.needsSponsorship;
  for (const f of cleared) {
    if ((LIST_BRIEF_FIELDS as readonly string[]).includes(f) || (ENUM_BRIEF_FIELDS as readonly string[]).includes(f)) (next as unknown as Record<string, unknown>)[f] = [];
    else if (f === 'pay' || f === 'dreamJob' || f === 'timing' || f === 'needsSponsorship') (next as unknown as Record<string, unknown>)[f] = null;
  }
  return next;
}

// ── Job profiles ───────────────────────────────────────────────────────────

export interface AliceProfileCompany {
  name: string;
  /** `you` = the user named it; `alice` = an example Alice added (labelled hers, D3). */
  source: 'you' | 'alice';
}

export interface AliceJobProfile {
  /** 'a' | 'b' for the two drafts; the saved profile's id once saved. */
  id: string;
  /** A short name ("Steady climb"). */
  label: string;
  /** One line: the job, the level, the kind of company. */
  headline: string;
  /** Two or three sentences. */
  summary: string;
  /** Titles in the person's language, as shown. */
  titles: string[];
  /**
   * The same titles as postings in the job market write them (English in most
   * international markets), for the search. Not shown, not in the diff; empty
   * = search with `titles`.
   */
  searchTitles: string[];
  levels: SeniorityLevel[];
  workModels: WorkModel[];
  places: AlicePlace[];
  pay: AlicePay | null;
  industries: string[];
  companyKinds: CompanyKind[];
  companySizes: CompanySize[];
  companies: AliceProfileCompany[];
  skills: string[];
  mustHaves: string[];
  niceToHaves: string[];
  dealbreakers: string[];
  /** Evidence from the resume and the answers. */
  whyItFits: string[];
  /** What this profile gives up. */
  tradeoff: string;
  jobTypes: JobType[];
}

/** The profile fields, in the order the comparison shows them. */
export const PROFILE_FIELDS = [
  'label',
  'headline',
  'summary',
  'titles',
  'levels',
  'workModels',
  'places',
  'pay',
  'industries',
  'companyKinds',
  'companySizes',
  'companies',
  'skills',
  'mustHaves',
  'niceToHaves',
  'dealbreakers',
  'whyItFits',
  'tradeoff',
  'jobTypes',
] as const satisfies readonly (keyof AliceJobProfile)[];
export type AliceProfileField = (typeof PROFILE_FIELDS)[number];

/**
 * How a company's label is decided. A list (the brief's companies) is for a
 * model-written profile: a company is the person's only when they named it.
 * `'stored'` is for a profile read back after it was cleaned and approved: it
 * keeps the labels it was stored with.
 */
export type CompanyLabels = readonly string[] | 'stored';

function cleanCompanies(value: unknown, named: CompanyLabels): AliceProfileCompany[] {
  if (!Array.isArray(value)) return [];
  const namedKeys = named === 'stored' ? null : new Set(named.map((n) => n.toLocaleLowerCase()));
  const out: AliceProfileCompany[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw: Record<string, unknown> = item && typeof item === 'object' ? (item as Record<string, unknown>) : { name: item };
    const name = clip(raw.name, 80);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    // A company the user named is theirs whatever the model says; any other is Alice's example (D3).
    const source: AliceProfileCompany['source'] = namedKeys ? (namedKeys.has(key) ? 'you' : 'alice') : raw.source === 'you' ? 'you' : 'alice';
    out.push({ name, source });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * A model-written or stored profile, cleaned. `named` decides the company
 * labels (CompanyLabels). Returns null when the profile has no title at all
 * (nothing to search).
 */
export function cleanProfile(value: unknown, id: string, named: CompanyLabels = []): AliceJobProfile | null {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const titles = clipList(v.titles, 6, 80);
  if (titles.length === 0) return null;
  const headline = clip(v.headline, 140) || titles[0];
  return {
    id,
    label: clip(v.label, 40) || headline.slice(0, 40),
    headline,
    summary: clip(v.summary, 600),
    titles,
    searchTitles: clipList(v.searchTitles, 6, 80),
    levels: pickEnum(v.levels, SENIORITY_LEVELS, 3),
    workModels: pickEnum(v.workModels, WORK_MODELS),
    places: cleanPlaces(v.places, 6),
    pay: cleanPay(v.pay),
    industries: clipList(v.industries, 6, 60),
    companyKinds: pickEnum(v.companyKinds, COMPANY_KINDS),
    companySizes: pickEnum(v.companySizes, COMPANY_SIZES),
    companies: cleanCompanies(v.companies, named),
    skills: clipList(v.skills, 10, 60),
    mustHaves: clipList(v.mustHaves, 6, 120),
    niceToHaves: clipList(v.niceToHaves, 6, 120),
    dealbreakers: clipList(v.dealbreakers, 6, 120),
    whyItFits: clipList(v.whyItFits, 4, 200),
    tradeoff: clip(v.tradeoff, 240),
    jobTypes: pickEnum(v.jobTypes, JOB_TYPES),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields that differ between two versions, in PROFILE_FIELDS order (computed, never a model's word). */
export function diffProfiles(before: AliceJobProfile | null, after: AliceJobProfile): AliceProfileField[] {
  if (!before) return [];
  return PROFILE_FIELDS.filter((f) => !sameValue(before[f], after[f]));
}

// ── Versions ───────────────────────────────────────────────────────────────

export const REVISION_ORIGINS = ['pick', 'edit', 'restore', 'saved_profile'] as const;
export type AliceRevisionOrigin = (typeof REVISION_ORIGINS)[number];

export interface AliceRevision {
  /** 1-based. */
  version: number;
  profile: AliceJobProfile;
  /** The user's comment that produced this version; null for a pick or a restore. */
  comment: string | null;
  /** Alice's notes on what she changed and why (explain the diff; they do not define it). */
  notes: string[];
  /** Fields that differ from the version before (computed). */
  changed: AliceProfileField[];
  origin: AliceRevisionOrigin;
  /** For `restore`: the version brought back. */
  restoredFrom?: number;
  at: string;
}

// ── Analysis ───────────────────────────────────────────────────────────────

export interface AliceDirection {
  id: 'a' | 'b';
  label: string;
  summary: string;
}

export interface AliceAnalysis {
  /** Alice's reading of the goal, in two or three sentences. */
  summary: string;
  strengths: string[];
  motivations: string[];
  constraints: string[];
  /** The axis the two profiles differ on. */
  axis: AliceAxisId;
  /** The open question, in plain words. */
  question: string;
  directions: [AliceDirection, AliceDirection];
}

export function cleanAnalysis(value: unknown): AliceAnalysis | null {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const axis = oneEnum(v.axis, ALICE_AXIS_IDS) ?? 'scope';
  const dirs = Array.isArray(v.directions) ? v.directions : [];
  const dir = (raw: unknown, id: 'a' | 'b'): AliceDirection | null => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const label = clip(r.label, 40);
    const summary = clip(r.summary, 300);
    return label ? { id, label, summary } : null;
  };
  const a = dir(dirs[0], 'a');
  const b = dir(dirs[1], 'b');
  if (!a || !b) return null;
  return {
    summary: clip(v.summary, 600),
    strengths: clipList(v.strengths, 4, 160),
    motivations: clipList(v.motivations, 4, 160),
    constraints: clipList(v.constraints, 4, 160),
    axis,
    question: clip(v.question, 220),
    directions: [a, b],
  };
}

// ── The open question ──────────────────────────────────────────────────────

export interface AlicePending {
  topic: AliceTopicId | null;
  quickReplies: string[];
  /** More than one quick reply may be picked. */
  multiSelect: boolean;
}

export function cleanPending(value: unknown): AlicePending | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const quickReplies = clipList(v.quickReplies, ALICE_LIMITS.quickReplies, 60);
  const topic = oneEnum(v.topic, ALICE_TOPIC_IDS);
  if (!topic && quickReplies.length === 0) return null;
  return { topic, quickReplies, multiSelect: v.multiSelect === true && quickReplies.length > 1 };
}

// ── Message blocks ─────────────────────────────────────────────────────────

/** Short system lines the web words (never a model's text). */
export const ALICE_NOTICE_CODES = [
  'agent_failed',
  'nothing_changed',
  'search_full',
  'resume_unreadable',
  'turn_limit',
  'draft_limit',
  'enough_questions',
  'no_applications',
  'no_profile',
  'reminder_ambiguous',
  'reminder_unknown',
] as const;
export type AliceNoticeCode = (typeof ALICE_NOTICE_CODES)[number];

/** User-side actions shown as a localized line in the conversation. */
export const ALICE_ACTION_LINES = ['resume', 'skip_resume', 'draft_now', 'choose', 'regenerate', 'restore', 'save', 'find_jobs', 'report', 'edit_profile'] as const;
export type AliceActionLine = (typeof ALICE_ACTION_LINES)[number];

export interface AliceSearchRef {
  id: string;
  name: string;
  /** What saving did to it. */
  mode: 'updated' | 'created' | 'replaced' | 'kept';
}

export interface AliceReportFacts {
  /** Applications not closed (every non-terminal stage, saved jobs included). */
  active: number;
  /** At Applied, waiting for a reply. */
  waiting: number;
  /** In a call or an interview round. */
  interviewing: number;
  offers: number;
  /** Things that need the user today (the board's list). */
  needsYou: number;
  /** Applied 10 days or more ago and still at Applied. */
  noReply: number;
  /** Follow-up dates due today or past. */
  remindersDue: number;
  /** Applications prepared and waiting for the user's check (Ready to apply); null when that list is off. */
  readyToCheck: number | null;
  /** Moved to Applied in the last 7 days. */
  appliedThisWeek: number;
}

export type AliceBlock =
  | { type: 'greeting'; hasResume: boolean; resumeName: string | null }
  | { type: 'resume'; resumeName: string; roles: string[]; years: number | null }
  | { type: 'learned'; topics: AliceTopicId[] }
  | { type: 'profiles'; labels: [string, string] }
  | { type: 'revision'; version: number; changed: AliceProfileField[] }
  | { type: 'restored'; version: number }
  | { type: 'saved'; profileId: string; name: string; search: AliceSearchRef | null }
  | { type: 'matches'; profileId: string; count: number }
  | { type: 'report'; facts: AliceReportFacts }
  | { type: 'reminder'; entryId: string; company: string | null; title: string | null; date: string | null }
  /** Several applications matched a reminder request: each option sets (or, with `date` null, clears) that one. */
  | { type: 'choice'; date: string | null; options: Array<{ entryId: string; company: string | null; title: string | null }> }
  | { type: 'action'; action: AliceActionLine; label?: string; version?: number }
  | { type: 'notice'; code: AliceNoticeCode };

export interface AliceMessageView {
  id: string;
  role: 'user' | 'alice';
  text: string;
  blocks: AliceBlock[];
  agent: AliceAgentId | null;
  at: string;
}

// ── Saved profiles ─────────────────────────────────────────────────────────

export interface AliceSavedProfileView {
  id: string;
  name: string;
  profile: AliceJobProfile;
  version: number;
  status: 'active' | 'archived';
  /** The saved search it drives, while that search exists. */
  search: { id: string; name: string; isActive: boolean } | null;
  /** The search's filters were replaced and can be put back. */
  canUndoReplace: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What "Save" will do to the user's saved searches (shown on the save card before the tap). */
export interface AliceSaveTarget {
  /** `update` the linked search · `create` a new one · `choose` (no room: replace one, or save without a search). */
  mode: 'update' | 'create' | 'choose';
  /** The search updated (`update`) or offered for replacing (`choose`: the active one). */
  search: { id: string; name: string } | null;
}

// ── The thread view ────────────────────────────────────────────────────────

export interface AliceTopicsView {
  /** Topics that apply on this brand, in asking order. */
  all: AliceTopicId[];
  /** Topics drafting needs (the readiness rule's four, as topic ids). */
  required: AliceTopicId[];
  covered: AliceTopicId[];
  declined: AliceTopicId[];
}

export interface AliceThreadView {
  id: string;
  stage: AliceStage;
  locale: string;
  resume: { id: string; name: string; updatedAt: string } | null;
  resumeSkipped: boolean;
  brief: AliceBrief;
  topics: AliceTopicsView;
  /** Enough is known to write the two profiles. */
  ready: boolean;
  pending: AlicePending | null;
  analysis: AliceAnalysis | null;
  drafts: AliceJobProfile[];
  revisions: AliceRevision[];
  currentVersion: number;
  savedProfile: AliceSavedProfileView | null;
  /** While refining: what Save will do. Null in other stages or when it could not be read. */
  saveTarget: AliceSaveTarget | null;
  messages: AliceMessageView[];
  createdAt: string;
  updatedAt: string;
}

// ── Turn actions (POST /alice/turn) ────────────────────────────────────────

const Text = z.string().trim().min(1).max(ALICE_LIMITS.messageChars);
const Comment = z.string().trim().min(1).max(ALICE_LIMITS.commentChars);
const Id = z.string().trim().min(1).max(64);

export const AliceTurnBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), text: Text }).strict(),
  z.object({ kind: z.literal('replies'), replies: z.array(z.string().trim().min(1).max(80)).min(1).max(ALICE_LIMITS.quickReplies), text: Text.optional() }).strict(),
  z.object({ kind: z.literal('resume'), resumeVariantId: Id }).strict(),
  z.object({ kind: z.literal('skip_resume') }).strict(),
  z.object({ kind: z.literal('draft_now') }).strict(),
  z.object({ kind: z.literal('choose'), draftId: z.enum(['a', 'b']), comment: Comment.optional() }).strict(),
  z.object({ kind: z.literal('regenerate'), comment: Comment.optional() }).strict(),
  z.object({ kind: z.literal('refine'), comment: Comment }).strict(),
  z.object({ kind: z.literal('restore'), version: z.number().int().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('save'), name: z.string().trim().min(1).max(60).optional(), search: z.enum(['auto', 'replace', 'none']).default('auto') }).strict(),
  z.object({ kind: z.literal('find_jobs') }).strict(),
  z.object({ kind: z.literal('report') }).strict(),
  z.object({ kind: z.literal('restart') }).strict(),
  z.object({ kind: z.literal('edit_profile'), profileId: Id }).strict(),
]);
export type AliceTurnBody = z.infer<typeof AliceTurnBodySchema>;
export type AliceTurnKind = AliceTurnBody['kind'];

// ── Stream events ──────────────────────────────────────────────────────────

export type AliceStreamEvent =
  | { event: 'progress'; data: { step: AliceStep; state: 'running' | 'done' } }
  | { event: 'message'; data: { message: AliceMessageView } }
  | { event: 'thread'; data: { thread: AliceThreadView } }
  | { event: 'error'; data: { code: string; reason?: string; message: string } }
  | { event: 'done'; data: Record<string, never> };

// ── Other routes ───────────────────────────────────────────────────────────

export const AliceProfileParamsSchema = z.object({ id: Id }).strict();
export const AliceEntryParamsSchema = z.object({ entryId: Id }).strict();

export const AlicePatchProfileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    status: z.enum(['active', 'archived']).optional(),
    /** Put the search's previous filters back (undo a replace). */
    undoReplace: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.status !== undefined || b.undoReplace === true, { message: 'Nothing to change.' });
export type AlicePatchProfileBody = z.infer<typeof AlicePatchProfileBodySchema>;

export const AliceMatchesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(ALICE_LIMITS.matches).optional() }).strict();

export const AliceReminderBodySchema = z
  .object({
    /** YYYY-MM-DD in the user's calendar. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type AliceReminderBody = z.infer<typeof AliceReminderBodySchema>;

export interface AliceProfilesResponse {
  items: AliceSavedProfileView[];
}

export interface AliceMatchView {
  job: FeedItem;
  /** The profile fields this job meets (title, level, setting, place, pay, industry, company). */
  meets: AliceProfileField[];
  /** The company is one the user named. */
  atNamedCompany: boolean;
}

export interface AliceMatchesResponse {
  profileId: string;
  items: AliceMatchView[];
  /** The saved search the profile drives; null when it drives none. */
  searchId: string | null;
}

export const ALICE_NEEDS_KINDS = ['interview_tomorrow', 'deadline_soon', 'follow_up_due', 'no_reply_10d', 'ready_to_check'] as const;
export type AliceNeedsKind = (typeof ALICE_NEEDS_KINDS)[number];

export interface AliceNeedsYouItem {
  kind: AliceNeedsKind;
  /** The tracker entry (null for an application still being prepared). */
  entryId: string | null;
  /** The Ready to apply item (only `ready_to_check`). */
  queueItemId: string | null;
  company: string | null;
  title: string | null;
  /** The date the fact is about. */
  at: string;
  /** Days since applying (`no_reply_10d`) or days left (`deadline_soon`); null otherwise. */
  days: number | null;
}

export interface AliceReminderView {
  entryId: string;
  company: string | null;
  title: string | null;
  status: string;
  /** YYYY-MM-DD. */
  date: string;
  /** The date is today or past. */
  due: boolean;
}

export interface AliceStageCount {
  status: string;
  count: number;
}

export interface AliceApplicationsView {
  market: 'intl' | 'cn';
  /** The market's ladder, in order, with the user's counts. */
  stages: AliceStageCount[];
  facts: AliceReportFacts;
  needsYou: AliceNeedsYouItem[];
  reminders: AliceReminderView[];
  /** Applications open for a follow-up date (not closed), most recent first, for the reminder picker. */
  open: Array<{ entryId: string; company: string | null; title: string | null; status: string; followUpAt: string | null }>;
  asOf: string;
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** `details.reason` values the Alice routes answer, besides the platform codes. */
export const ALICE_ERROR_REASONS = {
  /** The database has no Alice tables yet (SCHEMA-10 not applied). */
  notReady: 'alice_not_ready',
  /** AI may not run for this user (GoApply without the AI consent). */
  aiOff: 'alice_ai_off',
  /** The action does not fit the thread's stage. */
  wrongStage: 'alice_wrong_stage',
  resumeNotFound: 'alice_resume_not_found',
  profileNotFound: 'alice_profile_not_found',
  entryNotFound: 'alice_entry_not_found',
  /** No room for another saved search, and the save did not say what to do. */
  searchFull: 'alice_search_full',
  /** Another turn of this thread is running. */
  busy: 'alice_busy',
  /** The subagent failed after its retries. */
  agentFailed: 'alice_agent_failed',
  /** The saved-profile cap is reached. */
  profileLimit: 'alice_profile_limit',
} as const;
export type AliceErrorReason = (typeof ALICE_ERROR_REASONS)[keyof typeof ALICE_ERROR_REASONS];
