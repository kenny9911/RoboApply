import type { SearchInput, DatePosted, EmploymentType } from './types.js';

export const KNOWN_PROVIDER_IDS = ['activejobs', 'hiringindex', 'linkedin', 'jsearch'] as const;
export const EMPLOYMENT_TYPES: readonly EmploymentType[] = ['full_time', 'part_time', 'contract', 'internship'];
const DATES: readonly DatePosted[] = ['all', 'today', '3days', 'week', 'month'];
const COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

export class JobSearchValidationError extends Error {
  readonly code = 'INVALID_SEARCH';
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'JobSearchValidationError';
  }
}

function fail(field: string, message: string): never { throw new JobSearchValidationError(field, message); }

function textField(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail(field, `${field} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) fail(field, `${field} is invalid or too long.`);
  return clean;
}

function list(value: unknown, field: string, allowed: readonly string[]): string[] {
  const values = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(values) || values.length > allowed.length || values.length === 0) fail(field, `${field} must be a nonempty supported list.`);
  if (values.some((v) => typeof v !== 'string' || !allowed.includes(v.trim()))) fail(field, `${field} contains an unsupported value.`);
  return [...new Set(values.map((v) => (v as string).trim()))].sort();
}

/** Accepts HTTP query values or JSON, rejects unsupported filters before any paid call. */
export function parseSearchInput(value: unknown): SearchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('input', 'Search input must be an object.');
  const raw = value as Record<string, unknown>;
  const allowed = ['query', 'location', 'country', 'remote', 'datePosted', 'employmentTypes', 'providers', 'limit'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(key, `Unsupported search field: ${key}.`);
  const query = textField(raw.query, 'query', 160);
  if (query.length < 2 || !/[\p{L}\p{N}]/u.test(query)) fail('query', 'query must contain at least two characters and a letter or number.');
  const country = raw.country === undefined ? 'us' : textField(raw.country, 'country', 2).toLowerCase();
  if (!COUNTRIES.has(country.toUpperCase())) fail('country', 'country must be an ISO 3166-1 alpha-2 code.');
  const input: SearchInput = { query, country, datePosted: 'all', limit: 20 };
  if (raw.location !== undefined) {
    const location = textField(raw.location, 'location', 120);
    if (location) input.location = location;
  }
  if (raw.remote !== undefined) {
    if (![true, false, 'true', 'false'].includes(raw.remote as boolean)) fail('remote', 'remote must be a boolean.');
    // false means unrestricted work arrangement; only true requests remote-only.
    if (raw.remote === true || raw.remote === 'true') input.remote = true;
  }
  if (raw.datePosted !== undefined) {
    if (typeof raw.datePosted !== 'string' || !DATES.includes(raw.datePosted as DatePosted)) fail('datePosted', 'datePosted is unsupported.');
    input.datePosted = raw.datePosted as DatePosted;
  }
  if (raw.employmentTypes !== undefined) input.employmentTypes = list(raw.employmentTypes, 'employmentTypes', EMPLOYMENT_TYPES) as EmploymentType[];
  if (raw.providers !== undefined) input.providers = list(raw.providers, 'providers', KNOWN_PROVIDER_IDS);
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' && typeof raw.limit !== 'string') fail('limit', 'limit must be an integer between 1 and 50.');
    const limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('limit', 'limit must be an integer between 1 and 50.');
    input.limit = limit;
  }
  return input;
}

export function countryCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toUpperCase();
  if (COUNTRIES.has(value)) return value;
  if (value === 'UK' || value === 'UNITED KINGDOM') return 'GB';
  if (value === 'USA' || value === 'UNITED STATES OF AMERICA') return 'US';
  return countryByName.get(value.toLowerCase()) ?? null;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryByName = new Map([...COUNTRIES].map((code) => [(regionNames.of(code) ?? code).toLowerCase(), code]));
