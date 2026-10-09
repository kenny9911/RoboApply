// server/src/features/jobs/enrich/reconcile.ts
//
// Pure step between the model's JSON and the `RAJob` update (ARCHITECTURE.md
// §4.5): decides whether the LLM is needed at all, then turns its output into
// column values under the honesty rules —
//   - deterministic values from ingest (taxonomy, seniority, education) win;
//     the model only fills what is missing, and its taxonomy id must be one of
//     the ≤15 candidates it was offered;
//   - sponsorship / citizenship / clearance / employer tags need a verified,
//     on-topic quote that agrees with the claim (quotes.ts); without one the
//     signal is unknown, never a guess. A re-enrichment removes earlier
//     evidence the changed posting no longer contains;
//   - a model skill is kept only when the posting names it (skillGrounded);
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
  reconcileRequirement,
  reconcileSponsorship,
  verifyEmployerTagQuote,
  verifyQuote,
} from './quotes.js';
import { countOccurrences } from './keywords.js';
import { mergeFraudFlags, toFraudFlags, type FraudFlag, type ScamSignal } from './scamSignals.js';
import { taxonomyIdsFor, type TaxonomyCandidate } from './candidates.js';
import {
  EDUCATION_LEVELS,
  EMPLOYER_TAG_IDS,
  ENRICH_VERSION,
  MAX_SUMMARY_CHARS,
  RULES_ONLY_MODEL,
  SENIORITY_LEVELS,
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
  sponsorship: string | null;
  sponsorshipEvidence: string | null;
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
}

export interface SkillDetail {
  skill: string;
  kind: 'hard' | 'soft';
  required: boolean;
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
  seniority?: string | null;
  educationLevel?: string | null;
  skills?: string[];
  skillsDetail?: SkillDetail[] | null;
  sponsorship?: 'offered' | 'not_offered' | null;
  sponsorshipEvidence?: string | null;
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

/**
 * Does this job need the model? No when deterministic coverage is complete
 * (ARCH §4.5 step 1) AND the posting has nothing only the model can cite: no
 * work-authorization wording without a provider sponsorship value, no
 * citizenship/clearance wording, and (GoApply) no employer-tag wording.
 */
export function needsLlm(job: EnrichJobRecord, postingText: string): { needed: boolean; reason: string } {
  if (!deterministicCoverage(job)) return { needed: true, reason: 'coverage_incomplete' };
  if (mentionsWorkAuthorization(postingText) && job.sponsorship == null) return { needed: true, reason: 'work_authorization_text' };
  if (hasRequirementCue(postingText)) return { needed: true, reason: 'requirement_text' };
  if (job.market === 'cn' && hasEmployerTagCue(postingText)) return { needed: true, reason: 'employer_tag_text' };
  return { needed: false, reason: 'covered' };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function normSkill(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function readSkillsDetail(v: unknown): SkillDetail[] {
  if (!Array.isArray(v)) return [];
  const out: SkillDetail[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const { skill, kind, required } = item as Record<string, unknown>;
    if (typeof skill !== 'string' || !skill.trim()) continue;
    out.push({ skill: normSkill(skill), kind: kind === 'soft' ? 'soft' : 'hard', required: required === true });
  }
  return out;
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
}

export interface ReconcileReport {
  sponsorshipCorrected: string | null;
  droppedQuotes: string[];
  /** Model skills the posting never names (not stored). */
  droppedSkills: string[];
  /** Evidence from an earlier enrichment that the posting no longer supports (removed). */
  staleEvidence: string[];
  taxonomyRejected: boolean;
}

/** The fraud-flag part of an update (intl only; CN flags belong to WP-41). */
export function fraudFlagUpdate(job: EnrichJobRecord, signals: readonly ScamSignal[], now: Date): Pick<EnrichUpdate, 'fraudFlags'> {
  if (job.market !== 'intl') return {};
  return { fraudFlags: mergeFraudFlags(job.fraudFlags, toFraudFlags(signals, now)) };
}

/** Column values for a finished enrichment (LLM or rules only). */
export function reconcile(input: ReconcileInput): { update: EnrichUpdate; report: ReconcileReport } {
  const { job, postingText, output, candidates, scamSignals, now } = input;
  const report: ReconcileReport = { sponsorshipCorrected: null, droppedQuotes: [], droppedSkills: [], staleEvidence: [], taxonomyRejected: false };
  const wasEnriched = job.enrichedAt != null;
  const update: EnrichUpdate = {
    ...fraudFlagUpdate(job, scamSignals, now),
    enrichedAt: now,
    enrichVersion: ENRICH_VERSION,
    enrichModel: output ? (input.model ?? 'unknown') : RULES_ONLY_MODEL,
  };

  // Skills: provider/ingest skills first, then the model's (≤15) that the
  // posting actually names, deduped.
  const priorDetail = readSkillsDetail(job.skillsDetail);
  const modelDetail: SkillDetail[] = [];
  for (const s of output?.skills ?? []) {
    const skill = normSkill(s.skill);
    if (!skill) continue;
    if (!skillGrounded(postingText, skill)) {
      report.droppedSkills.push(skill);
      continue;
    }
    modelDetail.push({ skill, kind: s.kind, required: s.required });
  }
  const detail: SkillDetail[] = [];
  for (const d of [...priorDetail, ...modelDetail]) if (d.skill && !detail.some((x) => x.skill === d.skill)) detail.push(d);
  const skills: string[] = [];
  for (const s of [...job.skills.map(normSkill), ...detail.map((d) => d.skill)]) {
    if (s && !skills.includes(s)) skills.push(s);
    if (skills.length >= MAX_JOB_SKILLS) break;
  }
  if (modelDetail.length) {
    update.skills = skills;
    update.skillsDetail = detail.slice(0, MAX_JOB_SKILLS);
  }
  update.searchText = searchTextFor(job, skills);

  const priorTags = readMarketTags(job.marketTags);
  const pruned = pruneStaleTags(job, priorTags, postingText);
  for (const t of pruned.staleEmployerTags) report.staleEvidence.push(`employerTag:${t}`);
  for (const f of pruned.staleRequirementFields) report.staleEvidence.push(f);

  if (!output) {
    // Rules only. A re-enrichment still removes evidence the posting no
    // longer supports; nothing new is claimed.
    if (!wasEnriched) return { update, report };
    if (job.sponsorship != null && job.sponsorshipEvidence && !verifyQuote(job.sponsorshipEvidence, postingText)) {
      update.sponsorship = null;
      update.sponsorshipEvidence = null;
      report.staleEvidence.push('sponsorship');
    }
    for (const field of pruned.staleRequirementFields) update[field === 'citizenship' ? 'citizenshipRequired' : 'clearanceRequired'] = null;
    const employerTags = job.employerTags.filter((t) => !pruned.staleEmployerTags.has(t));
    if (!sameTags(employerTags, job.employerTags)) update.employerTags = employerTags;
    if (pruned.kept.length !== priorTags.length) update.marketTags = pruned.kept.length ? pruned.kept : null;
    return { update, report };
  }

  // Taxonomy: deterministic match wins; the model may only pick a candidate.
  if (!job.primaryTaxonomyId && job.taxonomyIds.length === 0 && output.taxonomyId) {
    if (candidates.some((c) => c.id === output.taxonomyId)) {
      const ids = taxonomyIdsFor(output.taxonomyId);
      if (ids.length) {
        update.taxonomyIds = ids;
        update.primaryTaxonomyId = output.taxonomyId;
      }
    } else {
      report.taxonomyRejected = true;
    }
  }
  if (!job.seniority && output.seniority && (SENIORITY_LEVELS as readonly string[]).includes(output.seniority)) update.seniority = output.seniority;
  if (!job.educationLevel && output.educationLevel && (EDUCATION_LEVELS as readonly string[]).includes(output.educationLevel)) {
    update.educationLevel = output.educationLevel;
  }

  // Sponsorship (H36). A previous enrichment's value is replaced; a provider
  // value on a never-enriched row is kept when the model finds nothing.
  const sponsorship = reconcileSponsorship(output.sponsorship.status, output.sponsorship.quote, postingText);
  report.sponsorshipCorrected = sponsorship.corrected;
  if (sponsorship.corrected === 'quote_not_in_posting') report.droppedQuotes.push('sponsorship');
  if (sponsorship.status !== 'not_stated') {
    update.sponsorship = sponsorship.status;
    update.sponsorshipEvidence = sponsorship.quote;
  } else if (wasEnriched || job.sponsorship == null) {
    update.sponsorship = null;
    update.sponsorshipEvidence = null;
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
  const owned = new Set<string>(REQUIREMENT_TAGS);
  const nextTags = [...pruned.kept.filter((p) => !owned.has(p.tag)), ...employerTagEvidence, ...requirementTags];
  update.marketTags = nextTags.length ? nextTags : null;

  const summary = clampSummary(output.summary);
  if (summary) update.summary = summary;

  return { update, report };
}
