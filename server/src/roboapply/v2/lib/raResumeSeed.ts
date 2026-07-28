// backend/src/roboapply/v2/lib/raResumeSeed.ts
//
// The deterministic resume → preference-draft seed. This is the reason step 2
// is a confirmation and not an interrogation.
//
// The old flow read the parsed resume, built display rows out of it, and then
// wrote `draftPreferences: {}` — so it asked seven questions whose answers
// were sitting in the document it had just parsed. Every such question is an
// admission the resume was not read.
//
// RULES THIS FILE OBEYS
//
//   1. NO LLM, NO DB, NO I/O. Pure function over the parse artifacts, single-
//      digit milliseconds. bootstrap() must be able to answer with a correct
//      screen before any model call returns — the LLM seed (see
//      RAOnboardingResumeSeedAgent) only ever ADDS to what is here.
//
//   2. EVERY seeded field carries a source and a confidence. `resume` means we
//      read it; `inferred` means we guessed it. The client renders the two
//      differently, and that is not decoration: a guessed city presented as a
//      fact is exactly how someone in Bangalore searching for remote EU/US
//      work ends up with an empty feed, because `location` is a substring
//      filter in RAJobIndexService and a wrong one deletes rows rather than
//      biasing them.
//
//   3. The city is therefore PROPOSED, never applied. It ships in
//      `proposedFields`, at confidence 0.5, and the client renders it as an
//      unselected suggestion chip. Nothing writes it to `preferences.cities`
//      unless the user taps it.
//
//   4. Salary is never seeded, never inferred, never asked. A stated floor
//      becomes `where.salaryMax >= min` downstream, and Prisma's `gte` does
//      not match NULL — so a guessed floor silently deletes every posting that
//      does not publish a range, which is most of them.
//
//   5. Seniority is seeded ONLY from an explicit level token in a real job
//      title. Years-to-level is a guess about a person, it is never shown, and
//      it lands in RACareerGoal.seniority where nobody would ever see it to
//      correct it. No token, no seniority.

import type {
  OnboardingDraftPreferences,
  OnboardingEmploymentType,
  OnboardingSeedEvidence,
  OnboardingSeedFieldMeta,
  OnboardingSeniority,
} from '../types/onboarding.js';
import { estimateYears } from './raOnboardingIngestRows.js';
import { normalizeDraftUpdates, normalizeEmploymentType } from './raOnboardingDraft.js';

// ─── Confidence constants (spec §5.1) ──────────────────────────────────

/** Roles came from `experience[].role` — the strongest signal on a resume. */
export const SEED_CONFIDENCE_ROLES = 0.8;
/** A level token was present in a real job title. */
export const SEED_CONFIDENCE_SENIORITY = 0.7;
/** Employment type as recorded on past entries — usually right, never shown. */
export const SEED_CONFIDENCE_EMPLOYMENT = 0.6;
/** Where the person HAS been, which is not where they want to work. */
export const SEED_CONFIDENCE_CITY = 0.5;

const MAX_SEED_ROLES = 3;
const MAX_EVIDENCE_EMPLOYERS = 3;
const MAX_CITY_LEN = 60;

export interface ResumeSeedResult {
  draft: OnboardingDraftPreferences;
  fieldMeta: Record<string, OnboardingSeedFieldMeta>;
  /** Seeded but NOT applied — the client shows these as suggestions. */
  proposedFields: string[];
  evidence: OnboardingSeedEvidence;
  /** No role could be derived. The client degrades to the thin-resume screen. */
  thin: boolean;
}

// ─── Small local readers (the parse is untrusted Json) ─────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s || null;
}

function pushUnique(out: string[], value: string | null, cap: number): void {
  if (!value) return;
  const key = value.toLowerCase();
  if (out.some((v) => v.toLowerCase() === key)) return;
  if (out.length >= cap) return;
  out.push(value);
}

// ─── Level tokens → RACareerGoal seniority vocabulary ──────────────────
//
// Ordered longest-phrase-first so "head of engineering" wins over "engineer"
// and "vice president" over "president". Matched as whole words against a
// lowercased title; a title with no token seeds nothing (rule 5).

const LEVEL_TOKENS: Array<[RegExp, OnboardingSeniority]> = [
  [/\bchief\b|\bc[teofp]o\b|\bcxo\b/i, 'cxo'],
  [/\bvice\s+president\b|\bvp\b|\bsvp\b|\bevp\b|副總裁|副总裁/i, 'vp'],
  [/\bdirector\b|總監|总监|ディレクター/i, 'director'],
  [/\bhead\s+of\b|\bmanager\b|\bem\b|\bteam\s+lead\b|\btech\s+lead\b|經理|经理|マネージャー/i, 'manager'],
  [/\bprincipal\b|\bdistinguished\b|\bfellow\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\bsenior\b|\bsr\.?\b|\blead\b|資深|资深|高級|高级|シニア/i, 'senior'],
  [/\bjunior\b|\bjr\.?\b|\bassociate\b|\bintern\b|\bentry\b|初級|初级|ジュニア/i, 'ic'],
];

/**
 * "Manager" is two different words. In "Engineering Manager" it is a level; in
 * "Product Manager", "Program Manager" or "Account Manager" it is a job
 * function performed by an individual contributor. Reading the second as the
 * first files every PM in the product under people management — and a
 * "Senior Product Manager" would come out as `manager` rather than `senior`,
 * which is worse than reading nothing at all.
 *
 * So these phrases are removed from the title before level matching. What is
 * left ("Senior", "Staff", or nothing) is the actual level claim.
 */
const FUNCTION_NOT_LEVEL =
  /\b(product|program|project|account|marketing|community|brand|category|partner|customer\s+success|social\s+media|office|product\s+marketing)\s+manager\b/gi;

export function seniorityFromTitle(title: string | null): OnboardingSeniority | null {
  if (!title) return null;
  const cleaned = title.replace(FUNCTION_NOT_LEVEL, ' ');
  for (const [pattern, seniority] of LEVEL_TOKENS) {
    if (pattern.test(cleaned)) return seniority;
  }
  return null;
}

// ─── City extraction ───────────────────────────────────────────────────

/**
 * Pull a city out of a free-form address line.
 *
 * Comma-split, then drop every part containing a digit — that removes the
 * street number ("123 Main St") and the postal code ("TX 78701") without
 * needing a country-by-country address grammar. The first survivor is the
 * city: "123 Main St, Austin, TX 78701" → "Austin"; "台北市, 台灣" → "台北市";
 * "Berlin" → "Berlin".
 *
 * Deliberately conservative. Returning null costs the user one tap on an add
 * input; returning a wrong city costs them the whole feed if they ever accept
 * it, which is why it is only ever offered as a suggestion.
 */
export function cityFromAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address
    .split(/[,，、|·]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= MAX_CITY_LEN && !/\d/.test(p));
  const city = parts[0] ?? null;
  if (!city) return null;
  // A single bare token that is obviously a country is not a city. We do not
  // ship a country list; this only catches the "Remote" convention, which is a
  // work mode the user states with a pill, not a place.
  if (/^(remote|anywhere|worldwide|遠端|远程|リモート)$/i.test(city)) return null;
  return city;
}

/** Last-resort city read from the top of the markdown, where contact lines
 *  live. Only the first 8 lines, and only a "City, XX" / "City, Country"
 *  shape — anything looser produces false cities from prose. */
function cityFromMarkdownHeader(markdown: string | null): string | null {
  if (!markdown) return null;
  for (const line of markdown.split('\n').slice(0, 8)) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (!trimmed || trimmed.length > 120) continue;
    const match = trimmed.match(/([A-Za-z一-鿿][A-Za-z一-鿿 .'-]{1,40})\s*,\s*[A-Za-z一-鿿]{2,}/);
    if (match) {
      const city = cityFromAddress(match[0]);
      if (city) return city;
    }
  }
  return null;
}

// ─── The seed ──────────────────────────────────────────────────────────

/**
 * Seed a preference draft from a parsed resume. Total: never throws, always
 * returns a usable result (an empty draft with `thin: true` in the worst case).
 *
 * `parsedData` is the raw `RAResumeVariant.parsedData` Json — untrusted shape.
 * `markdown` is `resumeMarkdown`, used only for the city fallback; role
 * extraction from markdown is deliberately NOT attempted, because a heading
 * heuristic that mistakes a section title for a job title seeds the single
 * field the whole screen is built around.
 */
export function seedDraftFromParsedResume(
  parsedData: unknown,
  markdown: string | null,
): ResumeSeedResult {
  const draft: OnboardingDraftPreferences = {};
  const fieldMeta: Record<string, OnboardingSeedFieldMeta> = {};
  const proposedFields: string[] = [];
  const evidence: OnboardingSeedEvidence = {};

  const parsed = asRecord(parsedData);
  const experience = Array.isArray(parsed?.experience)
    ? (parsed!.experience.filter((e) => asRecord(e) !== null) as Array<Record<string, unknown>>)
    : [];

  // ── Roles: the one field the confirm screen is actually about ──
  //
  // Most recent first (the parse preserves resume order), deduped
  // case-insensitively, capped at 3. Two identical titles at two employers is
  // one chip, not two.
  const roles: string[] = [];
  for (const entry of experience) {
    pushUnique(roles, nonEmpty(entry.role) ?? nonEmpty(entry.title), MAX_SEED_ROLES);
    if (roles.length >= MAX_SEED_ROLES) break;
  }
  if (roles.length > 0) {
    draft.targetRoles = roles;
    fieldMeta.targetRoles = { source: 'resume', confidence: SEED_CONFIDENCE_ROLES };
    evidence.roles = [...roles];
  }

  // ── Employment types: recorded fact, never shown, never a filter ──
  //
  // Seeded because it is free and correct, not because anyone will look at it.
  // preferencesToFilters() deliberately does not send employmentType, so this
  // cannot narrow the feed; it only makes Settings → Hunt accurate on day one.
  const employmentTypes: OnboardingEmploymentType[] = [];
  for (const entry of experience) {
    const norm = normalizeEmploymentType(entry.employmentType ?? entry.employment_type);
    if (norm && !employmentTypes.includes(norm)) employmentTypes.push(norm);
  }
  if (employmentTypes.length > 0) {
    draft.employmentTypes = employmentTypes;
    fieldMeta.employmentTypes = { source: 'resume', confidence: SEED_CONFIDENCE_EMPLOYMENT };
  }

  // ── Seniority: explicit level token in the most recent title only ──
  const seniority = seniorityFromTitle(roles[0] ?? null);
  if (seniority) {
    draft.seniority = seniority;
    fieldMeta.seniority = { source: 'resume', confidence: SEED_CONFIDENCE_SENIORITY };
  }

  // ── City: proposed, not applied (rule 3) ──
  const city =
    cityFromAddress(nonEmpty(parsed?.address) ?? nonEmpty(parsed?.location)) ??
    cityFromAddress(experience[0] ? nonEmpty(experience[0].location) : null) ??
    cityFromMarkdownHeader(markdown);
  if (city) {
    draft.locations = { cities: [city] };
    fieldMeta.locations = { source: 'inferred', confidence: SEED_CONFIDENCE_CITY };
    proposedFields.push('locations');
    evidence.city = city;
  }

  // ── Evidence extras (display only; never persisted as preferences) ──
  const years = estimateYears(experience);
  if (years != null) evidence.years = years;
  const employers: string[] = [];
  for (const entry of experience) {
    pushUnique(employers, nonEmpty(entry.company), MAX_EVIDENCE_EMPLOYERS);
  }
  if (employers.length > 0) evidence.employers = employers;

  // Final pass through the shared normalizer so the seed and the extractor
  // can never produce differently-shaped drafts (enum tables, caps, trims).
  return {
    draft: normalizeDraftUpdates(draft),
    fieldMeta,
    proposedFields,
    evidence,
    thin: roles.length === 0,
  };
}
