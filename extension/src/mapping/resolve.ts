// extension/src/mapping/resolve.ts — what goes into a field, and where it came from.
//
// Values come only from the user's own data: the profile (`source:'profile'`)
// or the user's saved application answers (`source:'bank'`). AI drafts are not
// resolved here; they appear in the panel and enter a field only when the user
// clicks "Use this answer" (content/fill.ts enforces it).
// Sensitive answers (EEO) exist in the payload only with the user's
// `autofill_sensitive` consent and are marked for review.

import { normalizeText } from '../adapters/_kit/options';
import { countriesNamed, normalizeCountryCode } from './countries';
import { authQuestionShape } from './questions';
import type { FieldHandle, FieldKey, FieldValue } from '../adapters/types';
import type { AutofillProfile, BankAnswer, ProtectedQuestionType, WorkAuthEntry } from '../shared/contract';

export type ValueSource = 'profile' | 'bank';

export interface Resolution {
  value: FieldValue;
  source: ValueSource;
  /** An equal-opportunity or other sensitive answer: highlighted for the user to check. */
  sensitive?: boolean;
}

function str(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

let regionNames: Intl.DisplayNames | null | undefined;
export function countryName(code: string | null): string | null {
  if (!code) return null;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

function link(p: AutofillProfile, key: string): string | null {
  const nested = (p.profile.links && typeof p.profile.links === 'object' ? (p.profile.links as Record<string, unknown>) : null) ?? null;
  return str(p.links as Record<string, unknown>, key) ?? str(nested, key);
}

/** The job marked current. None marked → null: a past employer is not "current". */
function currentJob(p: AutofillProfile): Record<string, unknown> | null {
  return p.experience.find((e) => e.current === true) ?? null;
}

/** The text value for a canonical key, or null when the profile does not have it. */
export function profileValue(key: FieldKey, p: AutofillProfile): string | null {
  const pr = p.profile;
  switch (key) {
    case 'firstName':
      return str(pr, 'firstName');
    case 'lastName':
      return str(pr, 'lastName');
    case 'preferredName':
      return str(pr, 'preferredName');
    case 'fullName': {
      const parts = [str(pr, 'firstName'), str(pr, 'middleName'), str(pr, 'lastName')].filter(Boolean);
      return parts.length ? parts.join(' ') : str(pr, 'fullName', 'name');
    }
    case 'email':
      return str(pr, 'contactEmail', 'email');
    case 'phone':
      return str(pr, 'phoneE164', 'phone');
    case 'addressLine1':
      return str(pr, 'addressLine1');
    case 'city':
      return str(pr, 'city');
    case 'region':
      return str(pr, 'region');
    case 'postalCode':
      return str(pr, 'postalCode');
    case 'country':
      return countryName(str(pr, 'country'));
    case 'location': {
      const city = str(pr, 'city');
      const tail = str(pr, 'region') ?? countryName(str(pr, 'country'));
      return city ? [city, tail].filter(Boolean).join(', ') : null;
    }
    case 'linkedin':
    case 'github':
    case 'portfolio':
    case 'website':
    case 'x':
      return link(p, key);
    case 'currentCompany':
      return str(currentJob(p), 'company');
    case 'currentTitle':
      return str(currentJob(p), 'title');
    case 'school':
      return str(p.education[0] ?? null, 'school');
    case 'degree':
      return str(p.education[0] ?? null, 'degree');
    case 'discipline':
      return str(p.education[0] ?? null, 'major', 'discipline');
    case 'resume':
    case 'coverLetter':
      return null;
  }
}

function tokens(s: string): Set<string> {
  return new Set(normalizeText(s).split(' ').filter((t) => t.length > 1));
}

function sameCountries(a: string, b: string): boolean {
  const x = countriesNamed(a);
  const y = countriesNamed(b);
  if (x.size !== y.size) return false;
  for (const c of x) if (!y.has(c)) return false;
  return true;
}

/**
 * The user's saved answer to this question: same text, or ≥ 80% word overlap
 * naming the same countries. `exactOnly` (protected questions: legal, EEO,
 * pay) accepts only the same text or key — "…work in the United Kingdom?"
 * never answers "…work in the United States?".
 */
export function bankAnswerFor(label: string, answers: readonly BankAnswer[], opts: { exactOnly?: boolean } = {}): BankAnswer | null {
  const n = normalizeText(label);
  if (!n) return null;
  const exact = answers.find((a) => normalizeText(a.questionText) === n || normalizeText(a.questionKey.replace(/[_-]+/g, ' ')) === n);
  if (exact) return exact;
  if (opts.exactOnly) return null;
  const want = tokens(label);
  if (want.size < 2) return null;
  let best: { a: BankAnswer; score: number } | null = null;
  for (const a of answers) {
    const have = tokens(a.questionText);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const score = shared / (want.size + have.size - shared);
    if (score >= 0.8 && (!best || score > best.score) && sameCountries(label, a.questionText)) best = { a, score };
  }
  return best?.a ?? null;
}

/**
 * The work-authorization row the question is about. A label that names a
 * country is answered only by that country's row; a label that names no
 * country is answered by the user's only row. Anything else → null.
 */
export function workAuthFor(label: string, rows: readonly WorkAuthEntry[]): WorkAuthEntry | null {
  const named = countriesNamed(label);
  if (named.size === 0) return rows.length === 1 ? rows[0] : null;
  if (named.size > 1) return null;
  const [code] = named;
  const matching = rows.filter((r) => normalizeCountryCode(r.country) === code);
  return matching.length === 1 ? matching[0] : null;
}

const FUTURE_RE = /future|will you|将来|將來|未来|未來/;

/** Yes / No for a work-authorization or sponsorship question, or null (Needs you). */
function workAuthAnswer(label: string, row: WorkAuthEntry): 'Yes' | 'No' | null {
  const shape = authQuestionShape(label);
  const future = FUTURE_RE.test(normalizeText(label));
  switch (shape) {
    case 'authorization':
      return row.authorized === null ? null : row.authorized ? 'Yes' : 'No';
    case 'sponsorship':
      if (row.sponsorship === null) return null;
      if (row.sponsorship === 'later') return future ? 'Yes' : null;
      return row.sponsorship === 'no' ? 'No' : 'Yes';
    case 'without_sponsorship':
      // Yes only when the user is authorized AND needs no sponsorship.
      if (row.sponsorship === 'now') return 'No';
      if (row.sponsorship === 'later') return future ? 'No' : null;
      if (row.authorized === false) return 'No';
      if (row.authorized === true && row.sponsorship === 'no') return 'Yes';
      return null;
    case 'unclear':
      return null;
  }
}

function asValue(field: FieldHandle, text: string): FieldValue {
  return field.kind === 'select' || field.kind === 'radio' || field.kind === 'combobox' ? { kind: 'option', option: text } : { kind: 'text', text };
}

const EEO_KEYS: Partial<Record<ProtectedQuestionType, Array<[RegExp, string[]]>>> = {
  eeo: [
    [/hispanic|latin/, ['hispanicLatino', 'hispanic']],
    [/race|ethnic/, ['race', 'ethnicity']],
    [/gender|sex/, ['gender']],
    [/orientation/, ['sexualOrientation']],
    [/transgender/, ['transgender']],
    [/pronoun/, ['pronouns']],
  ],
  veteran: [[/./, ['veteran', 'veteranStatus']]],
  disability: [[/./, ['disability', 'disabilityStatus']]],
};

function sensitiveAnswer(type: ProtectedQuestionType, label: string, sensitive: Record<string, unknown> | null): string | null {
  if (!sensitive) return null;
  const rules = EEO_KEYS[type];
  if (!rules) return null;
  const eeo = (sensitive.eeo && typeof sensitive.eeo === 'object' ? (sensitive.eeo as Record<string, unknown>) : sensitive) ?? {};
  const n = normalizeText(label);
  for (const [re, keys] of rules) if (re.test(n)) return str(eeo, ...keys);
  return null;
}

/**
 * Resolve a field to the user's own value. `key` is the classified profile
 * field (null for questions); `protectedType` marks questions that never get
 * an AI answer. Returns null when the user's data does not answer it.
 */
export function resolveField(field: FieldHandle, key: FieldKey | null, protectedType: ProtectedQuestionType | null, p: AutofillProfile): Resolution | null {
  if (key && key !== 'resume' && key !== 'coverLetter') {
    const v = profileValue(key, p);
    if (v) return { value: asValue(field, v), source: 'profile' };
    // A field whose label looks like a profile field may still be a saved question.
  }
  const isSensitive = protectedType === 'eeo' || protectedType === 'veteran' || protectedType === 'disability';
  // Equal-opportunity answers fill only with the `autofill_sensitive` consent
  // (the server sends `sensitive: null` without it) — saved answers included.
  if (isSensitive && p.sensitive === null) return null;
  const bank = bankAnswerFor(field.label, p.answers, { exactOnly: protectedType !== null });
  if (bank) return { value: asValue(field, bank.answer), source: 'bank', sensitive: isSensitive };
  if (!protectedType) return null;
  if (protectedType === 'work_authorization' || protectedType === 'sponsorship') {
    const row = workAuthFor(field.label, p.workAuth);
    const answer = row ? workAuthAnswer(field.label, row) : null;
    return answer ? { value: asValue(field, answer), source: 'profile' } : null;
  }
  const s = sensitiveAnswer(protectedType, field.label, p.sensitive);
  return s ? { value: asValue(field, s), source: 'profile', sensitive: true } : null;
}
