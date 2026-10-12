// server/src/features/jobs/enrich/reconcile.ts
//
// Pure step between the model's JSON and the `RAJob` update (ARCHITECTURE.md
// §4.5): decides whether the LLM is needed at all, then turns its output into
// column values under the honesty rules —
//   - deterministic seniority and education from ingest win; the model only
//     fills what is missing;
//   - the role (SM-2): a title that names its role outright (title match of
//     0.9 or more: the exact phrase, or a head noun that is the whole title)
//     decides it, whatever the row held and whatever the model says. Below
//     that the model decides, and may overrule the role the row holds; its id
//     must be one of the ≤15 candidates it was offered. The strength of the
//     title evidence is stored on every pass (`titleMatchScore`);
//   - the employer's industry (SM-10) is kept only with a verified quote that
//     names that industry's topic outside the company's own name and is not
//     about a recruiter's client; it is returned beside the update for the
//     company row, never written to the job;
//   - sponsorship / citizenship / clearance / employer tags need a verified,
//     on-topic quote that agrees with the claim (quotes.ts); without one the
//     signal is unknown, never a guess. A re-enrichment removes earlier
//     evidence the changed posting no longer contains;
//   - sponsorship names its source (JI-11): a value written with a verified
//     quote carries `sponsorshipSource = 'posting_quote'` (the posting's own
//     words win over a provider's reading); a provider's reading
//     (`'provider:<id>'`, written by ingest) is never cleared and never
//     written here;
//   - a model skill is kept only when the posting names it (skillGrounded);
//   - skills (SM-6): the row's own skill strings first, then the model's. Each
//     carries the canonical id the service mapped it to (`skillMap`, computed
//     before this function runs, which stays pure); two spellings of one skill
//     are one entry; `skillIds` holds the hard skills and certifications only,
//     required first; a soft skill stays in `skillsDetail` (shown) and out of
//     `skillIds` (never scored); a string a reviewer ruled out is not stored;
//   - requirement lines (SM-8) are the posting's own lines: verbatim, no
//     duplicate, in posting order, ids r1…rN. The part of a line that states
//     the applicant's age is taken out (the rest of the line stays), and a
//     line about the applicant's work authorization is not a requirement. The
//     list is stored once per TEXT of the posting: its key is the content hash
//     of the title and the requirement text, without the skill strings (those
//     change when ingest refreshes the row, and the lines do not depend on
//     them). It is replaced only when that text changed; a rules-only pass
//     writes none;
//   - an age limit a GoApply posting states is recorded as the market tag
//     `age_limit_stated` with its sentence, by rule, on every pass. It is
//     never an input of a score or a filter;
//   - the summary is cut to two sentences (UI labels it "Summary written by AI
//     from the job post", contract flag `aiWritten: true`);
//   - intl scam flags are always rule-based (scamSignals.ts) and merged into
//     `fraudFlags` without touching other rules.

import {
  EMPLOYER_TAG_TOPIC_CUES,
  REQUIREMENT_TOPIC_CUES,
  mentionsWorkAuthorization,
  normalizeForQuote,
  quoteMatchesRequirementTopic,
  reconcileIndustry,
  reconcileRequirement,
  reconcileSponsorship,
  verifyEmployerTagQuote,
  verifyQuote,
} from './quotes.js';
import { countOccurrences, type KeywordSkillInput } from './keywords.js';
import { AGE_LIMIT_TAG, ageLimitQuote, readAge } from './ageLimit.js';
import { skillMapKey, type SkillMap, type SkillMapping, type SkillVia } from './skills.js';
import type { JobRequirement } from '../../match/contract.js';
import { mergeFraudFlags, toFraudFlags, type FraudFlag, type ScamSignal } from './scamSignals.js';
import { taxonomyIdsFor, type TaxonomyCandidate } from './candidates.js';
import { roleFromTitle, titleEvidence, titleIsDecisive } from './titleEvidence.js';
import {
  EDUCATION_LEVELS,
  EMPLOYER_TAG_IDS,
  ENRICH_VERSION,
  MAX_SUMMARY_CHARS,
  RULES_ONLY_MODEL,
  SENIORITY_LEVELS,
  enrichRequirementsMax,
  type EnrichLlmOutput,
} from './schema.js';

/** Skills kept on `RAJob.skills` (schema: normalized lowercase, max 25). */
export const MAX_JOB_SKILLS = 25;
/** Deterministic coverage needs at least this many skills (ARCH §4.5 step 1). */
export const MIN_PROVIDER_SKILLS = 5;

/** The `RAJob` columns enrichment reads. */
export interface EnrichJobRecord {
  id: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  sourceBoard: string;
  title: string;
  titleNormalized: string;
  companyName: string;
  companyNameNormalized: string;
  description: string;
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  seniority: string | null;
  educationLevel: string | null;
  skills: string[];
  skillsDetail: unknown;
  /** Canonical skill ids the row holds (empty until its first enrichment at version 3). */
  skillIds?: string[] | null;
  /** The stored requirement list `{ v, contentHash, model, extractedAt, items }`, or null. */
  requirements?: unknown;
  sponsorship: string | null;
  sponsorshipEvidence: string | null;
  /** Who states `sponsorship`: 'posting_quote', 'provider:<provider id>' (ingest), or null (rows before JI-11). */
  sponsorshipSource?: string | null;
  citizenshipRequired: boolean | null;
  clearanceRequired: boolean | null;
  employerTags: string[];
  fraudFlags: unknown;
  marketTags: unknown;
  summary: string | null;
  enrichedAt: Date | null;
  enrichVersion: number | null;
  enrichModel: string | null;
  archivedAt: Date | null;
  /** The company row the employer's industry is written to (SM-10); absent on a job without one. */
  companyId?: string | null;
  /** How strong the title evidence for the role was at the last pass (not read by reconcile: it is worked out again). */
  titleMatchScore?: number | null;
  /** Place and links, passed through to the market hooks (not read by reconcile). */
  locationCountry?: string | null;
  locations?: unknown;
  sourceUrl?: string | null;
  applyUrl?: string | null;
}

/** One `RAJob.skillsDetail` entry: one skill of the posting, whatever its spellings. */
export interface SkillDetail {
  /** The posting's own string (as `RAJob.skills` writes it). Readers label a reviewed skill from the vocabulary. */
  skill: string;
  /** The vocabulary's kind when the skill is reviewed, else the model's. Every reader takes anything but `soft` as hard. */
  kind: 'hard' | 'soft' | 'certification';
  required: boolean;
  /** The canonical skill (RASkill id); null when the vocabulary holds none for the string. */
  skillId: string | null;
  /** How the id was found. `embedding` is a machine guess: never "not in your resume" on its strength. */
  via: SkillVia;
  /**
   * The other spellings of this skill the posting lists ("postgres" beside
   * "postgresql"), as `RAJob.skills` writes them; absent when there is none.
   * `RAJob.skills` keeps every spelling (search and typeahead read it), so a
   * reader that lists a posting's skills from `skills` and this array must
   * fold those strings into this entry: they are this skill, with this kind
   * and id, never a second skill and never a hard one when this is soft.
   */
  also?: string[];
}

/** `RAJob.sponsorshipSource` when the value rests on the posting's own words. */
export const SPONSORSHIP_SOURCE_QUOTE = 'posting_quote';
/** `RAJob.sponsorshipSource` of a provider's own reading starts with this (ingest writes it). */
export const PROVIDER_SPONSORSHIP_PREFIX = 'provider:';

/** `RAJob.requirements`: the posting's requirement lines, extracted once (MARKET_TASK_PLAN 3.3). */
export interface StoredRequirements {
  v: 1;
  /**
   * The text the lines were read from: `jobContentHash` of the title and the
   * requirement text with NO skills (`requirementsHashRow`). Not the row's
   * `RAJob.contentHash`, which also reads the skill strings.
   */
  contentHash: string;
  model: string;
  extractedAt: string;
  items: JobRequirement[];
}

export interface MarketTag {
  tag: string;
  evidenceQuote: string;
  evidenceUrl: string | null;
}

/** The `RAJob` columns enrichment writes (absent = unchanged). */
export interface EnrichUpdate {
  taxonomyIds?: string[];
  primaryTaxonomyId?: string | null;
  /** Score of the deterministic title match (0.6 to 1), null when the title names no role. */
  titleMatchScore?: number | null;
  seniority?: string | null;
  educationLevel?: string | null;
  skills?: string[];
  skillsDetail?: SkillDetail[] | null;
  /** Canonical ids of the hard skills and certifications, required first. */
  skillIds?: string[];
  /** The requirement list, or null to remove a list that belongs to an earlier text of the posting. */
  requirements?: StoredRequirements | null;
  /**
   * What the row's requirement list was when it was read: its content hash,
   * or null when the row had none. The repository writes `requirements` only
   * while that still holds, so a list the scorer stored in the meantime is
   * not overwritten (first writer wins). Absent: the write is unconditional
   * (the row held something this module cannot read).
   */
  requirementsWere?: string | null;
  sponsorship?: 'offered' | 'not_offered' | null;
  sponsorshipEvidence?: string | null;
  sponsorshipSource?: string | null;
  citizenshipRequired?: boolean | null;
  clearanceRequired?: boolean | null;
  employerTags?: string[];
  marketTags?: MarketTag[] | null;
  summary?: string | null;
  fraudFlags?: FraudFlag[] | null;
  searchText?: string;
  enrichedAt?: Date;
  enrichVersion?: number;
  enrichModel?: string;
}

// ── Posting text ────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Everything the posting says, as plain text: the description plus the
 * qualification / responsibility / benefit sections when they are not
 * already inside it. Quotes are verified against this text.
 */
export function postingTextOf(job: Pick<EnrichJobRecord, 'description' | 'descriptionPlain' | 'qualifications' | 'responsibilities' | 'benefits'>): string {
  const base = (job.descriptionPlain?.trim() ? job.descriptionPlain : stripHtml(job.description ?? '')).trim();
  const parts = [base];
  const normalizedBase = normalizeForQuote(base);
  for (const extra of [job.responsibilities, job.qualifications, job.benefits]) {
    const t = extra?.trim();
    if (t && !normalizedBase.includes(normalizeForQuote(t))) parts.push(t);
  }
  return parts.filter(Boolean).join('\n\n');
}

// ── Skip-LLM rule ───────────────────────────────────────────────────────

/** Any citizenship / clearance wording (the per-field cues in quotes.ts). */
function hasRequirementCue(text: string): boolean {
  const n = normalizeForQuote(text);
  return Object.values(REQUIREMENT_TOPIC_CUES).some((re) => re.test(n));
}

/** Any GoApply employer-tag wording (the per-tag cues in quotes.ts). */
function hasEmployerTagCue(text: string): boolean {
  const n = normalizeForQuote(text);
  return Object.values(EMPLOYER_TAG_TOPIC_CUES).some((re) => re.test(n));
}

/** True when ingest already covered taxonomy, seniority and ≥5 skills. */
export function deterministicCoverage(job: Pick<EnrichJobRecord, 'taxonomyIds' | 'primaryTaxonomyId' | 'seniority' | 'skills'>): boolean {
  const taxonomy = !!job.primaryTaxonomyId || job.taxonomyIds.length > 0;
  return taxonomy && !!job.seniority && job.skills.length >= MIN_PROVIDER_SKILLS;
}

export { roleFromTitle, titleEvidence, titleIsDecisive } from './titleEvidence.js';

/**
 * Does this job need the model? No when deterministic coverage is complete
 * (ARCH §4.5 step 1), the title names its role outright, AND the posting has
 * nothing only the model can cite: no work-authorization wording without a
 * provider sponsorship value, no citizenship/clearance wording, and (GoApply)
 * no employer-tag wording. A title that only half names a role ("Java Backend
 * Architect" under the building profession) is the model's to decide.
 */
export function needsLlm(job: EnrichJobRecord, postingText: string): { needed: boolean; reason: string } {
  if (!deterministicCoverage(job)) return { needed: true, reason: 'coverage_incomplete' };
  if (!titleIsDecisive(titleEvidence(job.title))) return { needed: true, reason: 'weak_title_match' };
  if (mentionsWorkAuthorization(postingText) && job.sponsorship == null) return { needed: true, reason: 'work_authorization_text' };
  if (hasRequirementCue(postingText)) return { needed: true, reason: 'requirement_text' };
  if (job.market === 'cn' && hasEmployerTagCue(postingText)) return { needed: true, reason: 'employer_tag_text' };
  return { needed: false, reason: 'covered' };
}

// ── Helpers ─────────────────────────────────────────────────────────────

const normSkill = skillMapKey;

/**
 * A stored `skillsDetail` entry as an earlier pass wrote it. `kind` is what a
 * model said (hard or soft): a pass maps every string anew, so a stored id or
 * a stored vocabulary kind decides nothing in it. `skillId` is undefined on an
 * entry written before ENRICH_VERSION 3.
 */
interface StoredSkillDetail {
  skill: string;
  kind: 'hard' | 'soft';
  required: boolean;
  skillId?: string | null;
  storedKind?: SkillDetail['kind'];
  /** How the stored id was found; undefined on an entry written before ENRICH_VERSION 3. */
  via?: SkillVia;
  /** The entry's other spellings (`SkillDetail.also`). */
  also: string[];
}

const SKILL_VIAS: readonly SkillVia[] = ['alias', 'embedding', 'new', 'none'];

function readSkillsDetail(v: unknown): StoredSkillDetail[] {
  if (!Array.isArray(v)) return [];
  const out: StoredSkillDetail[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const { skill, kind, required, skillId, via, also } = item as Record<string, unknown>;
    if (typeof skill !== 'string' || !skill.trim()) continue;
    const name = normSkill(skill);
    const others = Array.isArray(also) ? [...new Set(also.filter((a): a is string => typeof a === 'string').map(normSkill))].filter((a) => a && a !== name) : [];
    const entry: StoredSkillDetail = { skill: name, kind: kind === 'soft' ? 'soft' : 'hard', required: required === true, also: others };
    if (typeof skillId === 'string' || skillId === null) {
      entry.skillId = skillId || null;
      entry.storedKind = kind === 'soft' || kind === 'certification' ? kind : 'hard';
      if ((SKILL_VIAS as readonly unknown[]).includes(via)) entry.via = via as SkillVia;
    }
    out.push(entry);
  }
  return out;
}

/** The canonical ids a row already holds: those of its stored skill entries and its `skillIds`. */
export function heldSkillIds(job: Pick<EnrichJobRecord, 'skillsDetail' | 'skillIds'>): Set<string> {
  const ids = new Set<string>(job.skillIds ?? []);
  for (const d of readSkillsDetail(job.skillsDetail)) if (d.skillId) ids.add(d.skillId);
  return ids;
}

function readMarketTags(v: unknown): MarketTag[] {
  if (!Array.isArray(v)) return [];
  const out: MarketTag[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const { tag, evidenceQuote, evidenceUrl } = item as Record<string, unknown>;
    if (typeof tag !== 'string' || typeof evidenceQuote !== 'string' || !evidenceQuote) continue;
    out.push({ tag, evidenceQuote, evidenceUrl: typeof evidenceUrl === 'string' ? evidenceUrl : null });
  }
  return out;
}

/** Requirement evidence tags this module owns in `RAJob.marketTags`. */
export const REQUIREMENT_TAGS = ['citizenship_required', 'citizenship_not_required', 'clearance_required', 'clearance_not_required'] as const;

const EMPLOYER_TAG_SET = new Set<string>(EMPLOYER_TAG_IDS);
const SKILL_FILLER = new Set(['and', 'the', 'for', 'with', 'of']);

/**
 * True when the posting itself names the skill: the exact phrase, the phrase
 * without punctuation or spaces ("node.js" ~ "nodejs", "ci/cd" ~ "ci cd"),
 * or, for a multi-word skill, every word by its stem ("stakeholder
 * management" ~ "manage stakeholders"). A model skill the posting never
 * names is not kept (D3: no invented requirements).
 */
export function skillGrounded(postingText: string, skill: string): boolean {
  if (countOccurrences(postingText, skill) > 0) return true;
  const hay = postingText.normalize('NFKC').toLowerCase();
  const s = skill.normalize('NFKC').toLowerCase().trim();
  if (!s) return false;
  // "ci/cd" ~ "CI CD"; "node.js" ~ "nodejs" (and back).
  if (countOccurrences(hay.replace(/[./_-]+/g, ' '), s.replace(/[./_-]+/g, ' ')) > 0) return true;
  if (countOccurrences(hay.replace(/[./_-]+/g, ''), s.replace(/[\s./_-]+/g, '')) > 0) return true;
  // Multi-word skills: every word (≥3 letters) appears by its first 5 letters.
  const words = s.split(/[\s/]+/).filter((w) => w.length >= 3 && !SKILL_FILLER.has(w));
  if (words.length < 2) return false;
  return words.every((w) => {
    const stem = w.slice(0, 5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${stem}`).test(hay);
  });
}

/**
 * Evidence from an earlier enrichment that the posting no longer supports
 * (a forced re-enrichment of a changed posting). Only entries this module
 * wrote are checked: employer tags without an evidence URL (ingest cites a
 * source URL) and the requirement tags. Returns the market tags to keep and
 * the employer tags whose every piece of evidence went stale.
 */
function pruneStaleTags(
  job: EnrichJobRecord,
  priorTags: readonly MarketTag[],
  postingText: string,
): { kept: MarketTag[]; staleEmployerTags: Set<string>; staleRequirementFields: Set<'citizenship' | 'clearance'> } {
  const staleRequirementFields = new Set<'citizenship' | 'clearance'>();
  if (job.enrichedAt == null) return { kept: [...priorTags], staleEmployerTags: new Set(), staleRequirementFields };
  const kept: MarketTag[] = [];
  const dropped = new Set<string>();
  for (const p of priorTags) {
    if (EMPLOYER_TAG_SET.has(p.tag) && !p.evidenceUrl && !verifyEmployerTagQuote(p.tag, p.evidenceQuote, postingText)) {
      dropped.add(p.tag);
      continue;
    }
    if ((REQUIREMENT_TAGS as readonly string[]).includes(p.tag)) {
      const field = p.tag.startsWith('citizenship') ? 'citizenship' : 'clearance';
      const quote = verifyQuote(p.evidenceQuote, postingText);
      if (!quote || !quoteMatchesRequirementTopic(field, quote)) {
        staleRequirementFields.add(field);
        continue;
      }
    }
    kept.push(p);
  }
  const staleEmployerTags = new Set([...dropped].filter((t) => !kept.some((k) => k.tag === t)));
  return { kept, staleEmployerTags, staleRequirementFields };
}

/** True when the two tag lists hold the same tags in the same order. */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** At most two sentences, at most MAX_SUMMARY_CHARS. */
export function clampSummary(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+["'”’)]?|[^.!?。！？]+$/g) ?? [clean];
  let out = sentences.slice(0, 2).join('').replace(/\s+/g, ' ').trim();
  if (out.length > MAX_SUMMARY_CHARS) {
    const cut = out.slice(0, MAX_SUMMARY_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    out = `${(lastSpace > MAX_SUMMARY_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return out;
}

function searchTextFor(job: EnrichJobRecord, skills: string[]): string {
  return [job.titleNormalized, job.companyNameNormalized, ...skills.slice(0, 10)].filter(Boolean).join(' ').trim();
}

// ── Skills (SM-6) ───────────────────────────────────────────────────────

const NO_MAPPING: SkillMapping = { skillId: null, kind: null, status: 'unreviewed', via: 'none', labels: [] };
/** How sure an id is by the way it was found: a name the vocabulary knows, a skill made from the string, a neighbour's guess. */
const VIA_CERTAINTY: Record<SkillVia, number> = { alias: 3, new: 2, embedding: 1, none: 0 };

/** A skill string of the posting before the vocabulary is asked: where it came from and what that source said. */
interface SkillSource {
  skill: string;
  from: 'list' | 'detail' | 'model';
  kind?: 'hard' | 'soft';
  required?: boolean;
}

/**
 * The skill strings a pass may store, in source order: the row's own list
 * (the provider's skill field), the entries an earlier pass stored, then the
 * model's list, kept only where the posting names the skill. `dropped` are the
 * model's strings the posting never names (D3: no invented requirements).
 */
function skillSources(job: Pick<EnrichJobRecord, 'skills' | 'skillsDetail'>, postingText: string, output: Pick<EnrichLlmOutput, 'skills'> | null): { sources: SkillSource[]; dropped: string[] } {
  const sources: SkillSource[] = [];
  const dropped: string[] = [];
  for (const s of job.skills) {
    const skill = normSkill(s);
    if (skill) sources.push({ skill, from: 'list' });
  }
  // A stored entry speaks for every spelling it holds (ingest may have written the provider's list back over `skills` since).
  for (const d of readSkillsDetail(job.skillsDetail)) for (const skill of [d.skill, ...d.also]) sources.push({ skill, from: 'detail', kind: d.kind, required: d.required });
  for (const s of output?.skills ?? []) {
    const skill = normSkill(s.skill);
    if (!skill) continue;
    if (!skillGrounded(postingText, skill)) {
      dropped.push(skill);
      continue;
    }
    sources.push({ skill, from: 'model', kind: s.kind, required: s.required });
  }
  return { sources, dropped };
}

/**
 * The distinct skill strings of a posting that are sent to the vocabulary
 * (`canonicalizeMany`, once per job), provider strings first. A model string
 * the posting does not name is not among them: nothing the posting does not
 * say reaches the vocabulary, so no skill is created for it.
 */
export function skillTermsOf(job: Pick<EnrichJobRecord, 'skills' | 'skillsDetail'>, postingText: string, output: Pick<EnrichLlmOutput, 'skills'> | null): string[] {
  return [...new Set(skillSources(job, postingText, output).sources.map((s) => s.skill))];
}

/** How many of a pass's skills the vocabulary knows (the enrichment log line). */
export interface SkillCounts {
  /** Stored with the id of a reviewed skill. */
  canonical: number;
  /** Stored, shown and never scored: an unreviewed skill, or no canonical skill at all. */
  unreviewed: number;
  /** Not stored: a model string the posting never names, or a string a reviewer ruled is not a skill. */
  dropped: number;
}

interface ReconciledSkills {
  detail: SkillDetail[];
  skills: string[];
  skillIds: string[];
  droppedSkills: string[];
  counts: SkillCounts;
}

/**
 * One entry per skill. Two strings with one canonical id are one skill
 * ("postgres", "PostgreSQL"); the entry shows the spelling that is the skill's
 * own name when the posting uses it, else the first one seen, and names the
 * other spellings in `also` (they stay in `skills`, and a reader must be able
 * to tell that they are this skill without asking a vocabulary). What this pass's
 * model says about a skill (`required`, `kind`) replaces what an earlier pass
 * stored, and a skill is required when the model says so under any of its
 * spellings; the vocabulary's kind replaces both once the skill is reviewed.
 */
function reconcileSkills(job: EnrichJobRecord, postingText: string, output: EnrichLlmOutput | null, skillMap: SkillMap | undefined): ReconciledSkills {
  const { sources, dropped } = skillSources(job, postingText, output);
  const counts: SkillCounts = { canonical: 0, unreviewed: 0, dropped: dropped.length };
  interface Group {
    mapping: SkillMapping;
    strings: string[];
    stored?: SkillSource;
    model?: SkillSource;
    /** The model called the skill required under at least one of its spellings. */
    modelRequired: boolean;
  }
  const groups = new Map<string, Group>();
  const ruledOut = new Set<string>();
  const skills: string[] = [];
  for (const source of sources) {
    const mapping = skillMap?.get(source.skill) ?? NO_MAPPING;
    if (mapping.status === 'dropped') {
      ruledOut.add(source.skill);
      continue;
    }
    if (!skills.includes(source.skill)) skills.push(source.skill);
    const key = mapping.skillId ? `id:${mapping.skillId}` : `term:${source.skill}`;
    let group = groups.get(key);
    if (!group) {
      group = { mapping, strings: [], modelRequired: false };
      groups.set(key, group);
    }
    if (!group.strings.includes(source.skill)) group.strings.push(source.skill);
    // The entry is a machine guess only when no spelling of it is a name the vocabulary knows.
    if (VIA_CERTAINTY[mapping.via] > VIA_CERTAINTY[group.mapping.via]) group.mapping = mapping;
    if (source.from === 'detail') group.stored ??= source;
    if (source.from === 'model') {
      group.model ??= source;
      group.modelRequired ||= source.required === true;
    }
  }
  counts.dropped += ruledOut.size;

  const detail: SkillDetail[] = [];
  for (const group of [...groups.values()].slice(0, MAX_JOB_SKILLS)) {
    const { mapping } = group;
    const said = group.model ?? group.stored;
    const kind: SkillDetail['kind'] = mapping.status === 'reviewed' && mapping.kind ? mapping.kind : (said?.kind ?? 'hard');
    const shown = group.strings.find((s) => mapping.labels.includes(s)) ?? group.strings[0]!;
    const also = group.strings.filter((s) => s !== shown);
    detail.push({
      skill: shown,
      kind,
      required: group.model ? group.modelRequired : group.stored?.required === true,
      skillId: mapping.skillId,
      via: mapping.via,
      ...(also.length ? { also } : {}),
    });
    if (mapping.skillId && mapping.status === 'reviewed') counts.canonical += 1;
    else counts.unreviewed += 1;
  }
  // Scored skills only: a soft skill is shown (it stays in `detail`) and is never in the ids.
  const scored = detail.filter((d) => d.skillId && d.kind !== 'soft');
  const skillIds = [...new Set([...scored.filter((d) => d.required), ...scored.filter((d) => !d.required)].map((d) => d.skillId!))].slice(0, MAX_JOB_SKILLS);
  return { detail, skills: skills.slice(0, MAX_JOB_SKILLS), skillIds, droppedSkills: dropped, counts };
}

/** The columns a pass writes for its skills. */
export type SkillColumns = Pick<EnrichUpdate, 'skills' | 'skillsDetail' | 'skillIds' | 'searchText'>;

function skillColumns(job: EnrichJobRecord, reconciled: ReconciledSkills): SkillColumns {
  const columns: SkillColumns = { skillIds: reconciled.skillIds, searchText: searchTextFor(job, reconciled.skills) };
  if (reconciled.detail.length || job.skills.length) {
    columns.skills = reconciled.skills;
    columns.skillsDetail = reconciled.detail.length ? reconciled.detail : null;
  }
  return columns;
}

/** A JSON value with its object keys in one order (jsonb does not keep the order a value was written in). */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  return value;
}
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));

/**
 * Skill entries for comparing two passes. A skill a pass created is answered
 * `via: 'new'` by that pass and `via: 'alias'` by every later one (the
 * vocabulary knows the string by then): the same skill found the same way,
 * and no reason to write the row again.
 */
function settled(detail: unknown): unknown {
  if (!Array.isArray(detail)) return detail;
  return detail.map((d: unknown) => (d && typeof d === 'object' && (d as { via?: unknown }).via === 'new' ? { ...d, via: 'alias' } : d));
}

/**
 * The skill columns of a row that is already enriched, mapped anew (a
 * skills-only pass; service.ts `remapSkills`). No model output is read: the
 * strings are the row's own list and its stored entries, and `required` and
 * a model's kind are what the row stores. `changed` is false when the row
 * already holds exactly these values.
 */
export function reconcileSkillColumns(job: EnrichJobRecord, postingText: string, skillMap: SkillMap): { update: SkillColumns; counts: SkillCounts; changed: boolean } {
  const reconciled = reconcileSkills(job, postingText, null, skillMap);
  const update = skillColumns(job, reconciled);
  const changed =
    !sameJson(update.skillIds, job.skillIds ?? []) ||
    (update.skills !== undefined && !sameJson(update.skills, job.skills)) ||
    (update.skillsDetail !== undefined && !sameJson(settled(update.skillsDetail), settled(job.skillsDetail)));
  return { update, counts: reconciled.counts, changed };
}

/**
 * The skills of a row as the keyword list reads them (keywords.ts): the
 * entries this pass wrote, else what the row holds (a pass that stopped before
 * reconcile: over budget, or a failed model call that the queue retries).
 */
export function keywordSkillsOf(job: Pick<EnrichJobRecord, 'skills' | 'skillsDetail'>, update: Pick<EnrichUpdate, 'skillsDetail'>): KeywordSkillInput[] {
  // `null` is this pass's answer too: the posting has no skill left.
  if (update.skillsDetail !== undefined) return (update.skillsDetail ?? []).map((d) => ({ skill: d.skill, required: d.required, skillId: d.skillId, kind: d.kind, via: d.via }));
  const stored = readSkillsDetail(job.skillsDetail);
  // A spelling a stored entry already speaks for is not a second skill.
  const listed = new Set(stored.flatMap((d) => [d.skill, ...d.also]));
  return [
    // An entry of an earlier version-3 pass carries its id and kind; an older one is looked up by exact alias.
    ...stored.map((d): KeywordSkillInput => (d.skillId === undefined ? { skill: d.skill, required: d.required } : { skill: d.skill, required: d.required, skillId: d.skillId, kind: d.storedKind, ...(d.via ? { via: d.via } : {}) })),
    ...job.skills.map(normSkill).filter((s) => s && !listed.has(s)).map((skill): KeywordSkillInput => ({ skill, required: false })),
  ];
}

// ── Requirement lines (SM-8) ────────────────────────────────────────────

/** The posting fields the content hash reads (features/match `JobHashInput`). */
export interface RequirementHashInput {
  title: string;
  qualifications: string | null;
  descriptionPlain: string | null;
  skills: readonly string[];
}

/**
 * What the key of a stored requirement list is the hash of: the posting's
 * title and requirement text, and no skills. Every writer and reader of
 * `RAJob.requirements` hashes this row (`jobContentHash(requirementsHashRow(job))`).
 *
 * The skill strings are left out on purpose. Requirement lines are copied
 * from the text and do not depend on them, while `RAJob.skills` changes
 * without the text changing: enrichment adds the skills the posting names,
 * and the next ingest refresh writes the provider's list back. A key that
 * read the skills would call the list stale at every such refresh, and two
 * people scored on either side of it would be judged against different lists.
 */
export function requirementsHashRow(job: Pick<EnrichJobRecord, 'title' | 'qualifications' | 'descriptionPlain'>): RequirementHashInput {
  return { title: job.title, qualifications: job.qualifications, descriptionPlain: job.descriptionPlain, skills: [] };
}

/**
 * A requirement line about the applicant's own right to work or need of a
 * visa: logistics, read from the sponsorship fields, never a requirement a
 * resume is checked against. Two forms:
 *   - wording about the applicant's status ("authorized to work", "require
 *     sponsorship", "we do not offer sponsorship"): always logistics;
 *   - the bare subject ("work authorization", "visa sponsorship", 工作签证,
 *     工作许可): logistics, unless the line asks for skill in that work
 *     ("experience with visa sponsorship processes", 熟悉工作许可办理流程: HR,
 *     mobility and immigration roles), which stays a requirement.
 */
const WORK_STATUS_WORDING =
  /\b(?:authori[sz]ed to work|right to work|eligib(?:le|ility) to work|legally (?:authori[sz]ed|permitted|able|entitled) to work|(?:require|requires|required|requiring|need|needs|needing|without|provide|provides|offer|offers) (?:visa |work |employment )?sponsorship|sponsor (?:your |a |an |the )?(?:work )?visas?)\b/;
const WORK_PERMIT_SUBJECT = '(?:work authori[sz]ation|employment authori[sz]ation|visa sponsorship)';
const WORK_PERMIT_NOUN = new RegExp(`\\b${WORK_PERMIT_SUBJECT}\\b|工作签证|工作簽證|工作许可|工作許可`);
/** The line asks for skill in handling permits and visas: a word for knowing or doing it, before the subject, in the same sentence. */
const PERMIT_WORK_EN = new RegExp(
  `\\b(?:experience|experienced|knowledge|knowledgeable|familiar|familiarity|expertise|proficient|proficiency|processing|managing|management|handling|administering|administration|coordinating|coordination|preparing|filing|advising)\\b[^.;]{0,80}?\\b${WORK_PERMIT_SUBJECT}\\b`,
);
/** The same in Chinese. Not 办理 or 申请 alone: "协助办理工作签证" is what an employer offers, not work the applicant does. */
const PERMIT_WORK_ZH = /熟悉|负责|負責|精通|掌握|了解|瞭解|经验|經驗|流程|手续|手續|业务|業務/;
const HAN = /\p{Script=Han}/u;

/** True when a (normalized) requirement line is about the applicant's work authorization. */
function isWorkAuthorizationLine(line: string): boolean {
  if (WORK_STATUS_WORDING.test(line)) return true;
  if (!WORK_PERMIT_NOUN.test(line)) return false;
  return !(PERMIT_WORK_EN.test(line) || (HAN.test(line) && PERMIT_WORK_ZH.test(line)));
}

/** The stored requirement list when it has the shape this module writes; else null. */
export function readStoredRequirements(v: unknown): StoredRequirements | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.contentHash !== 'string' || !r.contentHash || !Array.isArray(r.items)) return null;
  return v as StoredRequirements;
}

/** What became of the model's requirement lines (the enrichment log line). */
export interface RequirementCounts {
  /** Lines of the posting that were kept. */
  kept: number;
  /** Lines the posting does not contain (not stored). */
  notInPosting: number;
  /** Lines about the applicant's age and nothing else (never a requirement). A line that also asks for something else keeps that part and is not counted here. */
  age: number;
  /** Lines about work authorization (logistics, computed elsewhere). */
  logistics: number;
}

/**
 * The model's requirement lines that are the posting's own: a verbatim
 * substring after `normalizeForQuote`, no duplicate, in posting order, with
 * ids r1…rN.
 *
 * A line is not kept whole when part of it states the applicant's age
 * ("年龄25-35岁，大专及以上学历，3年以上机械维修经验"): the age clause is taken out
 * and what else the line asks for stays, each remaining run as the posting
 * writes it (ageLimit.ts `readAge`). Only a line that is about age and nothing
 * else is dropped and counted as `age`.
 */
function verifiedRequirements(output: EnrichLlmOutput, postingText: string): { items: JobRequirement[]; counts: RequirementCounts } {
  const counts: RequirementCounts = { kept: 0, notInPosting: 0, age: 0, logistics: 0 };
  const posting = normalizeForQuote(postingText);
  const seen = new Set<string>();
  const found: Array<{ at: number; order: number; item: Omit<JobRequirement, 'id'> }> = [];
  output.requirements.forEach((r, order) => {
    const line = r.text.replace(/\s+/g, ' ').trim();
    const normalizedLine = normalizeForQuote(line);
    const lineAt = normalizedLine.length >= 2 ? posting.indexOf(normalizedLine) : -1;
    if (lineAt < 0) {
      counts.notInPosting += 1;
      return;
    }
    if (seen.has(normalizedLine)) return;
    seen.add(normalizedLine);
    const reading = readAge(line);
    if (reading.age && !reading.rest.length) {
      counts.age += 1;
      return;
    }
    // Without an age clause the line itself; with one, what is left of it.
    for (const text of reading.age ? reading.rest : [line]) {
      const normalized = normalizeForQuote(text);
      // A run of the line is the posting's own words too; its place in the posting orders the list.
      const at = normalized.length >= 2 ? posting.indexOf(normalized, lineAt) : -1;
      if (at < 0) {
        counts.notInPosting += 1;
        continue;
      }
      if (reading.age) {
        if (seen.has(normalized)) continue;
        seen.add(normalized);
      }
      if (isWorkAuthorizationLine(normalized)) {
        counts.logistics += 1;
        continue;
      }
      found.push({ at, order, item: { kind: r.kind, text, importance: r.importance } });
    }
  });
  found.sort((a, b) => a.at - b.at || a.order - b.order);
  const items = found.slice(0, enrichRequirementsMax()).map((f, i) => ({ id: `r${i + 1}`, ...f.item }));
  counts.kept = items.length;
  return { items, counts };
}

/** Record what the row's list was when it was read, so the write holds only while that is still true. */
function setRequirementsGuard(update: EnrichUpdate, stored: StoredRequirements | null, hadSomething: boolean): void {
  if (stored) update.requirementsWere = stored.contentHash;
  else if (!hadSomething) update.requirementsWere = null;
}

/**
 * The `requirements` column. A list belongs to one text of the posting (the
 * hash of `requirementsHashRow`): it is written when the row has none for this
 * text, kept when the text is the same (whatever became of the row's skill
 * strings since), and removed when the text changed and this pass has no list
 * of its own (rules only, or a model that returned none). The scorer then
 * extracts the lines itself and stores them, first writer wins. Without the
 * hash function nothing is written.
 */
function reconcileRequirements(input: ReconcileInput, update: EnrichUpdate, report: ReconcileReport): void {
  const { job, output, postingText, now } = input;
  if (!input.contentHash) return;
  const contentHash = input.contentHash(requirementsHashRow(job));
  const stored = readStoredRequirements(job.requirements);
  const current = stored?.contentHash === contentHash;
  const hadSomething = job.requirements != null;
  if (!output) {
    if (hadSomething && !current) {
      update.requirements = null;
      setRequirementsGuard(update, stored, hadSomething);
    }
    return;
  }
  const { items, counts } = verifiedRequirements(output, postingText);
  report.requirements = counts;
  if (current) return;
  if (items.length) update.requirements = { v: 1, contentHash, model: input.model ?? 'unknown', extractedAt: now.toISOString(), items };
  else if (hadSomething) update.requirements = null;
  if (update.requirements !== undefined) setRequirementsGuard(update, stored, hadSomething);
}

// ── Market tags this module writes by rule ──────────────────────────────

/** The age-limit tag of a GoApply posting (ageLimit.ts), or null. Never a requirement, a score input or a filter. */
function ageLimitTag(job: Pick<EnrichJobRecord, 'market'>, postingText: string): MarketTag | null {
  if (job.market !== 'cn') return null;
  const quote = ageLimitQuote(postingText);
  return quote ? { tag: AGE_LIMIT_TAG, evidenceQuote: quote, evidenceUrl: null } : null;
}

function sameMarketTags(a: readonly MarketTag[], b: readonly MarketTag[]): boolean {
  return a.length === b.length && a.every((t, i) => t.tag === b[i]!.tag && t.evidenceQuote === b[i]!.evidenceQuote && t.evidenceUrl === b[i]!.evidenceUrl);
}

// ── Reconcile ───────────────────────────────────────────────────────────

export interface ReconcileInput {
  job: EnrichJobRecord;
  postingText: string;
  /** Null when no model ran (rules only). */
  output: EnrichLlmOutput | null;
  candidates: readonly TaxonomyCandidate[];
  scamSignals: readonly ScamSignal[];
  /** The model that produced `output`; ignored when output is null. */
  model: string | null;
  now: Date;
  /**
   * What the vocabulary says about each string of `skillTermsOf(job,
   * postingText, output)`, keyed by `skillMapKey`. Computed by the service
   * (one `canonicalizeMany` per job). Absent: no string has a canonical id.
   */
  skillMap?: SkillMap;
  /**
   * `jobContentHash` of features/match, handed in so this module does not load
   * the match area. It is called with `requirementsHashRow(job)` (no skills).
   * Absent: the requirement list is left as it is.
   */
  contentHash?: (row: RequirementHashInput) => string;
}

export interface ReconcileReport {
  sponsorshipCorrected: string | null;
  droppedQuotes: string[];
  /** Model skills the posting never names (not stored). */
  droppedSkills: string[];
  /** Evidence from an earlier enrichment that the posting no longer supports (removed). */
  staleEvidence: string[];
  taxonomyRejected: boolean;
  /**
   * Set when the role the row held was replaced: by the model's pick (the
   * title match was weak) or by the title itself (it names another role
   * outright, or the held role came from a one-word match that no longer
   * exists; `to` is null when the title then names no role and the held one
   * is removed). Null when the role is new or unchanged.
   */
  taxonomyOverridden: { from: string; to: string | null; by: 'model' | 'title' } | null;
  /** Canonical, unreviewed and dropped skills of this pass. */
  skillCounts: SkillCounts;
  /** What became of the model's requirement lines; null when no model ran or the list is not this caller's to write. */
  requirements: RequirementCounts | null;
}

/** The employer's industry as the posting states it (SM-10), for the company row. */
export interface CompanyIndustryClaim {
  /** One of ENRICH_INDUSTRY_IDS. */
  industry: string;
  /** The verified line of the posting. */
  quote: string;
}

/**
 * The industry claim under the quote rules of quotes.ts `reconcileIndustry`:
 * in the posting, more than the employer's name, not about a recruiter's
 * client, and on the topic of the industry it claims.
 */
function verifyIndustry(claim: EnrichLlmOutput['industry'], job: EnrichJobRecord, postingText: string): { claim: CompanyIndustryClaim | null; dropped: string | null } {
  const verified = reconcileIndustry(claim, job.companyName ?? '', postingText);
  if (!verified) return { claim: null, dropped: null };
  if (verified.value === null) return { claim: null, dropped: verified.dropped === 'quote_not_in_posting' ? 'industry' : `industry:${verified.dropped}` };
  return { claim: { industry: verified.value, quote: verified.quote }, dropped: null };
}

/** The fraud-flag part of an update (intl only; CN flags belong to WP-41). */
export function fraudFlagUpdate(job: EnrichJobRecord, signals: readonly ScamSignal[], now: Date): Pick<EnrichUpdate, 'fraudFlags'> {
  if (job.market !== 'intl') return {};
  return { fraudFlags: mergeFraudFlags(job.fraudFlags, toFraudFlags(signals, now)) };
}

/** The role the row holds: its primary id, else the last of its ids. */
function storedRole(job: Pick<EnrichJobRecord, 'primaryTaxonomyId' | 'taxonomyIds'>): string | null {
  return job.primaryTaxonomyId ?? job.taxonomyIds[job.taxonomyIds.length - 1] ?? null;
}

/**
 * The role columns (SM-2), in this order:
 *   1. a decisive title names the role, on every pass and whatever the model says;
 *   2. otherwise the model's pick is taken when it is one of the candidates it was offered;
 *   3. otherwise a held role that only a retired one-word match explains gives
 *      way to what the title says today (a weaker match, or nothing);
 *   4. otherwise the row keeps what it holds.
 */
function reconcileRole(input: Pick<ReconcileInput, 'job' | 'output' | 'candidates'>, update: EnrichUpdate, report: ReconcileReport): void {
  const { job, output, candidates } = input;
  const held = storedRole(job);
  const ruling = roleFromTitle(job.title, held);
  update.titleMatchScore = ruling.det ? ruling.det.score : null;
  const modelPick = output?.taxonomyId ?? null;
  const offered = !!modelPick && candidates.some((c) => c.id === modelPick);
  // An id the model was never offered is dropped, whoever decides the role.
  if (modelPick && !offered) report.taxonomyRejected = true;
  let next: string | null | undefined = ruling.role;
  let by: 'model' | 'title' = 'title';
  if (!ruling.decisive && offered) {
    next = modelPick;
    by = 'model';
  }
  if (next === undefined || next === held) return;
  const ids = next ? taxonomyIdsFor(next) : [];
  if (next && !ids.length) return;
  update.taxonomyIds = ids;
  update.primaryTaxonomyId = next;
  if (held) report.taxonomyOverridden = { from: held, to: next, by };
}

/** True when the stored sponsorship value is a provider's own reading (ingest wrote it; JI-7). */
function isProviderReading(job: Pick<EnrichJobRecord, 'sponsorshipSource'>): boolean {
  return typeof job.sponsorshipSource === 'string' && job.sponsorshipSource.startsWith(PROVIDER_SPONSORSHIP_PREFIX);
}

/**
 * Column values for a finished enrichment (LLM or rules only), and beside
 * them the employer's industry when the posting states it (for the company
 * row; null on a rules-only pass).
 */
export function reconcile(input: ReconcileInput): { update: EnrichUpdate; report: ReconcileReport; companyIndustry: CompanyIndustryClaim | null } {
  const { job, postingText, output, scamSignals, now } = input;
  const report: ReconcileReport = {
    sponsorshipCorrected: null,
    droppedQuotes: [],
    droppedSkills: [],
    staleEvidence: [],
    taxonomyRejected: false,
    taxonomyOverridden: null,
    skillCounts: { canonical: 0, unreviewed: 0, dropped: 0 },
    requirements: null,
  };
  const wasEnriched = job.enrichedAt != null;
  const update: EnrichUpdate = {
    ...fraudFlagUpdate(job, scamSignals, now),
    enrichedAt: now,
    enrichVersion: ENRICH_VERSION,
    enrichModel: output ? (input.model ?? 'unknown') : RULES_ONLY_MODEL,
  };
  reconcileRole(input, update, report);

  // Skills: what the row holds first, then the model's (≤15) that the posting names; one entry per canonical skill.
  const reconciled = reconcileSkills(job, postingText, output, input.skillMap);
  report.droppedSkills = reconciled.droppedSkills;
  report.skillCounts = reconciled.counts;
  Object.assign(update, skillColumns(job, reconciled));

  reconcileRequirements(input, update, report);

  const priorTags = readMarketTags(job.marketTags);
  const pruned = pruneStaleTags(job, priorTags, postingText);
  for (const t of pruned.staleEmployerTags) report.staleEvidence.push(`employerTag:${t}`);
  for (const f of pruned.staleRequirementFields) report.staleEvidence.push(f);
  const ageTag = ageLimitTag(job, postingText);
  const providerReading = isProviderReading(job);

  if (!output) {
    // Rules only. A re-enrichment still removes evidence the posting no
    // longer supports; nothing new is claimed. The age-limit tag is a rule and
    // is written on a first pass too.
    const tagsOf = (kept: readonly MarketTag[]): MarketTag[] => [...kept.filter((p) => p.tag !== AGE_LIMIT_TAG), ...(ageTag ? [ageTag] : [])];
    if (!wasEnriched) {
      const next = tagsOf(priorTags);
      if (!sameMarketTags(next, priorTags)) update.marketTags = next.length ? next : null;
      return { update, report, companyIndustry: null };
    }
    if (job.sponsorship != null && job.sponsorshipEvidence) {
      if (verifyQuote(job.sponsorshipEvidence, postingText)) {
        // The stored value rests on words the posting still has: its source is the posting, whatever the row said.
        if (job.sponsorshipSource !== SPONSORSHIP_SOURCE_QUOTE) update.sponsorshipSource = SPONSORSHIP_SOURCE_QUOTE;
      } else {
        // The quote is gone. A provider's reading stays, labelled as the provider's; anything else goes with its quote.
        update.sponsorshipEvidence = null;
        if (!providerReading) {
          update.sponsorship = null;
          update.sponsorshipSource = null;
        }
        report.staleEvidence.push('sponsorship');
      }
    }
    for (const field of pruned.staleRequirementFields) update[field === 'citizenship' ? 'citizenshipRequired' : 'clearanceRequired'] = null;
    const employerTags = job.employerTags.filter((t) => !pruned.staleEmployerTags.has(t));
    if (!sameTags(employerTags, job.employerTags)) update.employerTags = employerTags;
    const next = tagsOf(pruned.kept);
    if (!sameMarketTags(next, priorTags)) update.marketTags = next.length ? next : null;
    return { update, report, companyIndustry: null };
  }

  if (!job.seniority && output.seniority && (SENIORITY_LEVELS as readonly string[]).includes(output.seniority)) update.seniority = output.seniority;
  if (!job.educationLevel && output.educationLevel && (EDUCATION_LEVELS as readonly string[]).includes(output.educationLevel)) {
    update.educationLevel = output.educationLevel;
  }

  // Sponsorship (H36, JI-11). A value with a verified quote is the posting's own word: it replaces whatever the
  // row held, a provider's reading included. Without a quote a provider's reading is left exactly as it is (only
  // a quote an earlier enrichment stored beside it goes); an earlier enrichment's own value is replaced; a value
  // on a never-enriched row that names no source is kept.
  const sponsorship = reconcileSponsorship(output.sponsorship.status, output.sponsorship.quote, postingText);
  report.sponsorshipCorrected = sponsorship.corrected;
  if (sponsorship.corrected === 'quote_not_in_posting') report.droppedQuotes.push('sponsorship');
  if (sponsorship.status !== 'not_stated') {
    update.sponsorship = sponsorship.status;
    update.sponsorshipEvidence = sponsorship.quote;
    update.sponsorshipSource = SPONSORSHIP_SOURCE_QUOTE;
  } else if (providerReading) {
    if (wasEnriched && job.sponsorshipEvidence) update.sponsorshipEvidence = null;
  } else if (wasEnriched || job.sponsorship == null) {
    update.sponsorship = null;
    update.sponsorshipEvidence = null;
    update.sponsorshipSource = null;
  }

  // Citizenship / clearance, with their quotes in marketTags. The quote must
  // be on topic and agree with the value (quotes.ts reconcileRequirement).
  const requirementTags: MarketTag[] = [];
  for (const [field, signal] of [
    ['citizenship', output.citizenshipRequired],
    ['clearance', output.clearanceRequired],
  ] as const) {
    const verified = reconcileRequirement(field, signal, postingText);
    if (verified && verified.value === null) report.droppedQuotes.push(verified.dropped === 'quote_not_in_posting' ? field : `${field}:${verified.dropped}`);
    const column = field === 'citizenship' ? 'citizenshipRequired' : 'clearanceRequired';
    if (verified && verified.value !== null) {
      update[column] = verified.value;
      requirementTags.push({ tag: `${field}_${verified.value ? 'required' : 'not_required'}`, evidenceQuote: verified.quote, evidenceUrl: null });
    } else if (wasEnriched || job[column] == null) {
      update[column] = null;
    }
  }

  // Employer tags (GoApply only), each with an on-topic, non-negated quote.
  // Ingest's tags (with a source URL, or with no evidence row) are kept; on a
  // re-enrichment, a tag whose earlier quote is no longer in the posting is
  // removed with its evidence (pruneStaleTags).
  const employerTags = new Set(job.employerTags.filter((t) => !pruned.staleEmployerTags.has(t)));
  const employerTagEvidence: MarketTag[] = [];
  if (job.market === 'cn') {
    for (const t of output.employerTags) {
      const quote = verifyEmployerTagQuote(t.tag, t.quote, postingText);
      if (!quote) {
        report.droppedQuotes.push(`employerTag:${t.tag}`);
        continue;
      }
      employerTags.add(t.tag);
      if (!pruned.kept.some((p) => p.tag === t.tag) && !employerTagEvidence.some((p) => p.tag === t.tag)) {
        employerTagEvidence.push({ tag: t.tag, evidenceQuote: quote, evidenceUrl: null });
      }
    }
  }
  const nextEmployerTags = [...employerTags];
  if (!sameTags(nextEmployerTags, job.employerTags)) update.employerTags = nextEmployerTags;
  const owned = new Set<string>([...REQUIREMENT_TAGS, AGE_LIMIT_TAG]);
  const nextTags = [...pruned.kept.filter((p) => !owned.has(p.tag)), ...employerTagEvidence, ...requirementTags, ...(ageTag ? [ageTag] : [])];
  update.marketTags = nextTags.length ? nextTags : null;

  const summary = clampSummary(output.summary);
  if (summary) update.summary = summary;

  const industry = verifyIndustry(output.industry, job, postingText);
  if (industry.dropped) report.droppedQuotes.push(industry.dropped);

  return { update, report, companyIndustry: industry.claim };
}
