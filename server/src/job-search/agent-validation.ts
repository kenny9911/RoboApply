import type { AgentSearchInput, DatePosted, EmploymentType } from './types.js';
import { JobSearchValidationError, parseSearchInput } from './validation.js';
// The one rule for "this phrase states a requirement, it is not a topic": the feed's own (a pure function).
import { isConstraintPhrase } from '../features/feed/filterDiff.js';

const FILTER_KEYS = ['country', 'location', 'remote', 'datePosted', 'employmentTypes', 'providers', 'limit'] as const;
const INPUT_KEYS = new Set<string>(['request', 'locale', 'linkedinOnly', ...FILTER_KEYS]);

/** Preserve absence: an omitted form field cannot overwrite an extracted fact. */
export function parseAgentSearchInput(raw: unknown): AgentSearchInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JobSearchValidationError('input', 'Agent search must be an object.');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!INPUT_KEYS.has(key)) throw new JobSearchValidationError(key, `Unsupported agent field: ${key}.`);
  if (typeof value.request !== 'string') throw new JobSearchValidationError('request', 'Describe the jobs you are looking for.');
  const request = value.request.trim();
  if (request.length < 10 || request.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(request)) {
    throw new JobSearchValidationError('request', 'Describe your job search in 10–2000 characters.');
  }
  if (value.remote !== undefined && typeof value.remote !== 'boolean') throw new JobSearchValidationError('remote', 'remote must be a boolean.');
  if (value.limit !== undefined && typeof value.limit !== 'number') throw new JobSearchValidationError('limit', 'limit must be an integer.');
  for (const key of ['providers', 'employmentTypes']) if (value[key] !== undefined && !Array.isArray(value[key])) throw new JobSearchValidationError(key, `${key} must be an array.`);
  const filters = Object.fromEntries(FILTER_KEYS.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const parsed = parseSearchInput({ query: 'agent search', ...filters });
  const result: AgentSearchInput = { request };
  for (const key of FILTER_KEYS) if (value[key] !== undefined) Object.assign(result, { [key]: parsed[key] });
  if (value.remote !== undefined) result.remote = value.remote;
  if (value.location !== undefined) result.location = parsed.location ?? '';
  if (value.linkedinOnly !== undefined) {
    if (typeof value.linkedinOnly !== 'boolean') throw new JobSearchValidationError('linkedinOnly', 'linkedinOnly must be a boolean.');
    result.linkedinOnly = value.linkedinOnly;
  }
  if (value.locale !== undefined) {
    if (typeof value.locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(value.locale)) throw new JobSearchValidationError('locale', 'locale must be a supported language tag.');
    result.locale = value.locale;
  }
  return result;
}

export interface AgentPlan {
  queries: string[];
  country?: string;
  location?: string;
  remote?: boolean;
  datePosted?: DatePosted;
  employmentTypes?: EmploymentType[];
  unverifiedPreferences: string[];
  linkedinOnly?: boolean;
  /**
   * Topics of the request that are not filters and that a result list may be
   * ORDERED by ("climate startups", "Rust"): never a filter, never a checked
   * fact about a job, and never a requirement (parseAgentPlan moves those to
   * `unverifiedPreferences`). Absent when the planner names none.
   */
  relevanceTerms?: string[];
}

/** Most topics a plan is ranked by, and the shortest and longest one. */
export const RELEVANCE_MAX_TERMS = 5;
export const RELEVANCE_TERM_MIN_CHARS = 2;
export const RELEVANCE_TERM_MAX_CHARS = 60;
/**
 * The terms joined by a space are the text a search is ordered by, and the
 * feed accepts at most this many characters of it (features/feed/contract.ts
 * `FEED_RELEVANCE_MAX_CHARS`; agent-validation.test.ts holds the two equal).
 * A term that no longer fits is dropped, so every term a plan keeps is used.
 */
export const RELEVANCE_MAX_CHARS = 240;

/**
 * A phrase that states a requirement of a job (pay, visa or work
 * authorization, benefits, hours, time zone, commute) and is therefore never
 * a thing to rank by. Default: the feed's `isConstraintPhrase`, so the app and
 * the API hold one rule.
 */
export type ConditionRule = (phrase: string) => boolean;

/** Most requirement phrases moved out of `relevanceTerms` in one plan (the size of the preference list itself). */
export const RELEVANCE_MOVED_MAX = 12;

/**
 * The usable strings of the planner's `relevanceTerms`, once each (whatever
 * the letter case), in the planner's order: 2 to 60 characters, no control
 * character, no URL. Anything else is dropped, never fatal.
 */
function usableTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const term = item.trim();
    if (term.length < RELEVANCE_TERM_MIN_CHARS || term.length > RELEVANCE_TERM_MAX_CHARS) continue;
    if (/[\u0000-\u001f\u007f]/.test(term) || /(?:https?:)?\/\/|\bwww\./i.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** At most 5 terms, and together (joined by a space) at most the feed's relevance text: a term that no longer fits is dropped. */
function withinLimits(terms: readonly string[]): string[] {
  const out: string[] = [];
  let joined = 0;
  for (const term of terms) {
    const length = joined + (out.length ? 1 : 0) + term.length;
    if (length > RELEVANCE_MAX_CHARS) continue;
    out.push(term);
    joined = length;
    if (out.length === RELEVANCE_MAX_TERMS) break;
  }
  return out;
}

/**
 * The planner's `relevanceTerms`, kept lenient on purpose: they only order a
 * list, so a bad value is DROPPED and the plan stays usable (a strict failure
 * would turn a model's sloppy extra into a failed search). Kept: strings of
 * 2 to 60 characters with no control character and no URL, once each
 * (whatever the letter case), at most 5, in the planner's order.
 */
export function parseRelevanceTerms(raw: unknown): string[] {
  return withinLimits(usableTerms(raw));
}

/**
 * The planner's terms, told apart: `topics` may order a list (the limits of
 * `parseRelevanceTerms` apply to them), `conditions` state a requirement the
 * model filed under the wrong field. A condition is looked for among ALL the
 * usable terms, before the cap of 5, so one named ninth is not lost either.
 */
export function splitRelevanceTerms(raw: unknown, isCondition: ConditionRule = isConstraintPhrase): { topics: string[]; conditions: string[] } {
  const usable = usableTerms(raw);
  return {
    topics: withinLimits(usable.filter((term) => !isCondition(term))),
    conditions: usable.filter((term) => isCondition(term)).slice(0, RELEVANCE_MOVED_MAX),
  };
}

/**
 * Strict schema validation: no executable instructions, extra tools, or API URLs.
 * `relevanceTerms` is the one lenient field (see parseRelevanceTerms).
 *
 * The prompt's rule is enforced here, for every reader of a plan (the search
 * API and the feed's natural-language query both parse through this function):
 * a requirement the model named as a topic ("visa sponsorship", "paying over
 * 150k") is never a relevance term. It is moved to `unverifiedPreferences`,
 * where each reader already turns it into a filter it supports or shows it as
 * not checked. Ranking by closeness to it would read as if it had been
 * checked, and dropping it would lose a wish the user stated.
 */
export function parseAgentPlan(raw: unknown, isCondition: ConditionRule = isConstraintPhrase): AgentPlan {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid planning object.');
  const body = value as Record<string, unknown>;
  const allowed = new Set(['queries', 'country', 'location', 'remote', 'datePosted', 'employmentTypes', 'unverifiedPreferences', 'linkedinOnly', 'relevanceTerms']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('Unexpected planning fields.');
  // The roleless sentinel. A topic to rank by is not a role, so `relevanceTerms` beside it changes nothing.
  if (Array.isArray(body.queries) && body.queries.length === 0 && Array.isArray(body.unverifiedPreferences)
    && body.unverifiedPreferences.length === 0 && Object.keys(body).every(key => ['queries', 'unverifiedPreferences', 'relevanceTerms'].includes(key))) {
    throw new JobSearchValidationError('request', 'Include a job role or occupational keyword in your request.');
  }
  if (!Array.isArray(body.queries) || body.queries.length < 1 || body.queries.length > 2) throw new Error('Plan must have one or two role queries.');
  const queries = body.queries.map(query => {
    if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 80 || query.trim().split(/\s+/).length > 10 || /[\n\r\u0000-\u001f]|https?:\/\//i.test(query)) throw new Error('Role query is invalid.');
    return parseSearchInput({ query }).query;
  });
  if (new Set(queries.map(query => query.toLowerCase())).size !== queries.length) throw new Error('Role queries must be distinct.');
  if (!Array.isArray(body.unverifiedPreferences) || body.unverifiedPreferences.length > 12 || body.unverifiedPreferences.some(item => typeof item !== 'string' || !item.trim() || item.length > 240 || /[\u0000-\u001f]/.test(item))) throw new Error('Unverified preferences are invalid.');
  const filters: Record<string, unknown> = {};
  for (const key of ['country', 'location', 'remote', 'datePosted', 'employmentTypes']) if (body[key] !== undefined) filters[key] = body[key];
  // Model output is strictly typed even though the compatibility search parser
  // also accepts strings in a few fields for older HTTP consumers.
  if (body.remote !== undefined && typeof body.remote !== 'boolean') throw new Error('remote must be boolean.');
  if (body.employmentTypes !== undefined && !Array.isArray(body.employmentTypes)) throw new Error('employmentTypes must be an array.');
  const parsed = parseSearchInput({ query: queries[0], ...filters });
  const result: AgentPlan = { queries, unverifiedPreferences: [...new Set((body.unverifiedPreferences as string[]).map(item => item.trim()))] };
  for (const key of ['country', 'location', 'datePosted', 'employmentTypes'] as const) if (body[key] !== undefined) Object.assign(result, { [key]: parsed[key] });
  if (body.remote !== undefined) result.remote = body.remote as boolean;
  if (body.linkedinOnly !== undefined) {
    if (typeof body.linkedinOnly !== 'boolean') throw new Error('linkedinOnly must be boolean.');
    result.linkedinOnly = body.linkedinOnly;
  }
  // Never fatal: see parseRelevanceTerms. Left off when no topic was named.
  const { topics, conditions } = splitRelevanceTerms(body.relevanceTerms, isCondition);
  if (topics.length) result.relevanceTerms = topics;
  // After the planner's own preferences, and only when it has not stated the phrase there already (whatever the
  // letter case). The strict cap of 12 above is on what the model wrote in that field.
  const stated = new Set(result.unverifiedPreferences.map(item => item.toLowerCase()));
  for (const condition of conditions) if (!stated.has(condition.toLowerCase())) result.unverifiedPreferences.push(condition);
  return result;
}
