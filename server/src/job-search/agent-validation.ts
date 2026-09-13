import type { AgentSearchInput, DatePosted, EmploymentType } from './types.js';
import { JobSearchValidationError, parseSearchInput } from './validation.js';

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
}

/** Strict schema validation: no executable instructions, extra tools, or API URLs. */
export function parseAgentPlan(raw: unknown): AgentPlan {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid planning object.');
  const body = value as Record<string, unknown>;
  const allowed = new Set(['queries', 'country', 'location', 'remote', 'datePosted', 'employmentTypes', 'unverifiedPreferences', 'linkedinOnly']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('Unexpected planning fields.');
  if (Array.isArray(body.queries) && body.queries.length === 0 && Array.isArray(body.unverifiedPreferences)
    && body.unverifiedPreferences.length === 0 && Object.keys(body).every(key => ['queries', 'unverifiedPreferences'].includes(key))) {
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
  return result;
}
