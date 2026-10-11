// server/src/features/jobs/enrich/schema.ts
//
// The one structured enrichment call per job (ARCHITECTURE.md §4.5,
// TASK_PLAN.md WP-17): the zod schema the model's JSON must pass, the
// enums it may use and the version stamped on every enriched row.
//
// Parsing is per field and forgiving: a bad enum or a malformed skill drops
// that field or entry (it becomes "not stated"), never the whole result, so
// one sloppy field does not throw away the rest of a paid call. Anything that
// is not a JSON object at the top level is rejected outright. Quote checks
// (substring of the posting, negation rule) happen later in `reconcile.ts`;
// this file only guarantees types and sizes.

import { z } from 'zod';
import { INDUSTRY_IDS, industryIdFor } from '../companies/contract.js';

/**
 * Bump when the prompt, schema or reconcile rules change materially; old rows
 * re-enrich (jobs-maintain queues them inside the daily enrichment budget and
 * they keep serving their old values until their turn).
 *   2 (SM-2, SM-10): the model may overrule a role whose title match is weak;
 *     `titleMatchScore` is stored; the employer's industry is read from a
 *     quoted line of the posting.
 */
export const ENRICH_VERSION = 2;

/**
 * `RAJob.enrichModel` when no model ran and a model pass is still owed: the
 * brand had no usable model, or LLM enrichment was switched off
 * (ENRICH_DAILY_JOBS=0). jobs-maintain queues these rows for one model pass
 * once a model and a budget exist.
 */
export const RULES_ONLY_MODEL = 'rules';

/**
 * `RAJob.enrichModel` when the row is rules-only and a model pass would not
 * change that at this ENRICH_VERSION: the posting has nothing a model could
 * add, the owner has not allowed AI, or the model call failed on its last
 * attempt. jobs-maintain never selects this value, so such a job is not
 * re-run every time its finished work item is pruned from the queue. A
 * changed posting or a new ENRICH_VERSION enriches the row again.
 */
export const RULES_CHECKED_MODEL = 'rules_checked';

/** Input cap for the posting text sent to the model (ARCH §4.5). */
export const ENRICH_INPUT_CHARS = 6000;
/** At most this many skills come back (ARCH §4.5). */
export const MAX_ENRICH_SKILLS = 15;
/** At most this many taxonomy candidates are offered to the model. */
export const MAX_TAXONOMY_CANDIDATES = 15;
/** Stored evidence quotes are capped at this length (`RAJob.sponsorshipEvidence`). */
export const MAX_QUOTE_CHARS = 240;
/** `RAJob.summary`: at most two sentences, and never longer than this. */
export const MAX_SUMMARY_CHARS = 400;

export const SENIORITY_LEVELS = ['intern_newgrad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec'] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export const EDUCATION_LEVELS = ['none', 'associate', 'bachelor', 'master', 'phd'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export const SPONSORSHIP_STATUSES = ['offered', 'not_offered', 'not_stated'] as const;
export type SponsorshipStatus = (typeof SPONSORSHIP_STATUSES)[number];

/** GoApply employer tags (FilterSet `employerTags`); each needs a quote from the posting. */
export const EMPLOYER_TAG_IDS = ['soe', 'bianzhi', 'hukou', 'foreign'] as const;
export type EmployerTagId = (typeof EMPLOYER_TAG_IDS)[number];

const quoteField = z
  .string()
  .transform((s) => s.trim())
  .nullable()
  .optional()
  .catch(null)
  .transform((s) => (s ? s : null));

export const EnrichSkillSchema = z.object({
  skill: z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(60)),
  kind: z.enum(['hard', 'soft']).catch('hard'),
  required: z.boolean().catch(false),
});
export type EnrichSkill = z.infer<typeof EnrichSkillSchema>;

const skillsField = z
  .array(z.unknown())
  .catch([])
  .optional()
  .transform((items) => {
    const out: EnrichSkill[] = [];
    for (const item of items ?? []) {
      const parsed = EnrichSkillSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
      if (out.length >= MAX_ENRICH_SKILLS) break;
    }
    return out;
  });

const sponsorshipField = z
  .object({
    status: z.enum(SPONSORSHIP_STATUSES).catch('not_stated'),
    quote: quoteField,
  })
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => v ?? { status: 'not_stated' as const, quote: null });

/** A yes/no requirement signal with the quote it rests on. */
const requirementField = z
  .object({
    value: z.boolean().nullable().catch(null),
    quote: quoteField,
  })
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => v ?? null);

const employerTagsField = z
  .array(z.unknown())
  .catch([])
  .optional()
  .transform((items) => {
    const out: Array<{ tag: EmployerTagId; quote: string | null }> = [];
    for (const item of items ?? []) {
      const parsed = z.object({ tag: z.enum(EMPLOYER_TAG_IDS), quote: quoteField }).safeParse(item);
      if (parsed.success && !out.some((t) => t.tag === parsed.data.tag)) out.push(parsed.data);
    }
    return out;
  });

/** The employer's industry ids the model may answer with (the closed list of the industries filter). */
export const ENRICH_INDUSTRY_IDS: readonly string[] = INDUSTRY_IDS;

/**
 * The employer's industry with the line of the posting that states it. A
 * value outside the closed list, or a missing quote, is "not stated" (null).
 */
const industryField = z
  .object({ value: z.string(), quote: quoteField })
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => {
    const value = v ? industryIdFor(v.value) : null;
    return value && v?.quote ? { value, quote: v.quote } : null;
  });

const nullableEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .enum(values)
    .nullable()
    .optional()
    .catch(null)
    .transform((v) => v ?? null);

/** The model's JSON (one object). Unknown keys are ignored. */
export const EnrichLlmOutputSchema = z.object({
  taxonomyId: z
    .string()
    .nullable()
    .optional()
    .catch(null)
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  seniority: nullableEnum(SENIORITY_LEVELS),
  educationLevel: nullableEnum(EDUCATION_LEVELS),
  skills: skillsField,
  sponsorship: sponsorshipField,
  citizenshipRequired: requirementField,
  clearanceRequired: requirementField,
  summary: z
    .string()
    .nullable()
    .optional()
    .catch(null)
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  employerTags: employerTagsField,
  industry: industryField,
});
export type EnrichLlmOutput = z.infer<typeof EnrichLlmOutputSchema>;

/** Validate a parsed JSON value. Throws `EnrichOutputError` when it is not an object. */
export function parseEnrichOutput(value: unknown): EnrichLlmOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnrichOutputError('enrichment output is not a JSON object');
  }
  const parsed = EnrichLlmOutputSchema.safeParse(value);
  if (!parsed.success) throw new EnrichOutputError(`enrichment output failed validation: ${parsed.error.message.slice(0, 200)}`);
  return parsed.data;
}

/** Extract and validate the JSON object from raw model text (fenced or bare). */
export function parseEnrichText(text: string): EnrichLlmOutput {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text);
  for (const c of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(c.trim());
    } catch {
      continue;
    }
    return parseEnrichOutput(value);
  }
  throw new EnrichOutputError(`enrichment output is not JSON: ${text.slice(0, 120)}`);
}

export class EnrichOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichOutputError';
  }
}

/** `job.enrich` work item payload. */
export const EnrichPayloadSchema = z.object({
  jobId: z.string().min(1).max(64),
  /** Re-run even when the row is already enriched at ENRICH_VERSION (material change). */
  force: z.boolean().optional(),
});
export type EnrichPayload = z.infer<typeof EnrichPayloadSchema>;
