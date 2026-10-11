// server/src/features/match/eval/fixtures/schema.ts
//
// Shapes of the committed evaluation fixtures (MKT-1D; MARKET_STRATEGY.md 2.6).
// Every fixture file is SYNTHETIC and says so (`"_synthetic": true`): personas
// and postings are written by fixtures/build.ts from the hand-written tables
// in fixtures/seed/. Nothing is copied from a job board, a provider response
// or a database row, and a persona never reaches a user-facing surface (D3).
//
// Labels are graded 0-3 (0 not relevant, 1 related, 2 good match, 3 excellent
// match). The committed labels are `constructed`: recorded by the generator
// from how each posting was written. They are not judge or human labels and a
// report never mixes the kinds.

import { z } from 'zod';

export const FIXTURE_MARKETS = ['intl', 'cn'] as const;
export type FixtureMarket = (typeof FIXTURE_MARKETS)[number];

export const FIXTURE_LANGS = ['en', 'zh-TW', 'zh-CN', 'ja'] as const;
export type FixtureLang = (typeof FIXTURE_LANGS)[number];

/** Language subsets of the language gate. `cross`: the resume and the pooled postings are in different languages. */
export const FIXTURE_SUBSETS = ['en', 'zh-TW', 'zh-CN', 'cross'] as const;
export type FixtureSubset = (typeof FIXTURE_SUBSETS)[number];

/** The six SENIORITY_LEVELS of features/search/contract.ts (kept equal by fixtures.test.ts). */
export const FIXTURE_LEVELS = ['intern_newgrad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec'] as const;
export type FixtureLevel = (typeof FIXTURE_LEVELS)[number];

export const PERSONA_KINDS = ['standard', 'new_graduate', 'career_changer'] as const;
export type PersonaKind = (typeof PERSONA_KINDS)[number];

const Id = z.string().min(1).max(64);
const Country = z.string().regex(/^[A-Z]{2}$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);

export const PersonaSchema = z
  .object({
    id: Id,
    market: z.enum(FIXTURE_MARKETS),
    /** UI locale of the persona. */
    locale: z.enum(['en', 'zh', 'zh-TW', 'ja']),
    subset: z.enum(FIXTURE_SUBSETS),
    kind: z.enum(PERSONA_KINDS),
    /** Taxonomy v1 role id the resume shows. */
    roleId: Id,
    /** The role the persona is looking for: `roleId`, except for a career changer. */
    targetRoleId: Id,
    level: z.enum(FIXTURE_LEVELS),
    yearsExperience: z.number().min(0).max(40),
    skills: z.array(z.string().min(1)).min(1),
    /** `<groupId>:<index>` of each skill in seed/groups.json (the same key in every language). */
    skillKeys: z.array(z.string().min(3)).min(1),
    location: z.object({ label: z.string().min(1), city: z.string().min(1).optional(), country: Country, radiusKm: z.union([z.literal(0), z.literal(40)]) }).strict(),
    payFloor: z.object({ amount: z.number().positive(), currency: Currency, period: z.enum(['year', 'month']) }).strict(),
    /** RoboApply personas only. */
    needsSponsorship: z.boolean().optional(),
    /** GoApply personas only: 届别 (null when not a recent graduate). */
    classYear: z.number().int().min(2000).max(2100).nullable().optional(),
    degree: z.enum(['bachelor', 'master']),
    resumeLang: z.enum(FIXTURE_LANGS),
    /** Languages of the postings pooled for this persona. */
    poolLangs: z.array(z.enum(FIXTURE_LANGS)).min(1),
    resumeMarkdown: z.string().min(40),
    recentTitles: z.array(z.string().min(1)).min(1).max(2),
    experience: z
      .array(
        z
          .object({ title: z.string().min(1), company: z.string().min(1), start: z.string().regex(/^\d{4}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}$/).nullable(), current: z.boolean(), kind: z.enum(['work', 'internship']) })
          .strict(),
      )
      .min(1),
    education: z.array(z.object({ degree: z.enum(['bachelor', 'master']), label: z.string().min(1), field: z.string().min(1), endYear: z.number().int() }).strict()).min(1),
    employerIndustries: z.array(z.string()),
  })
  .strict();
export type Persona = z.infer<typeof PersonaSchema>;

export const PostingSkillSchema = z
  .object({
    name: z.string().min(1),
    /** `<groupId>:<index>` for a skill of seed/groups.json; null for a hand-written special or a soft skill. */
    key: z.string().nullable(),
    kind: z.enum(['hard', 'soft']),
    required: z.boolean(),
  })
  .strict();

export const PostingSchema = z
  .object({
    id: Id,
    market: z.enum(FIXTURE_MARKETS),
    lang: z.enum(FIXTURE_LANGS),
    /** The role the posting was written for (what a correct enrichment stores). */
    roleId: Id,
    groupId: Id,
    categoryId: Id,
    title: z.string().min(1),
    companyName: z.string().min(1),
    /** Empty for most postings, as in the real index. */
    companyIndustries: z.array(z.string()),
    /** The level the posting states; null when it states none. */
    level: z.enum(FIXTURE_LEVELS).nullable(),
    employmentType: z.enum(['full_time', 'internship']),
    skills: z.array(PostingSkillSchema),
    minYears: z.number().int().min(0).max(30).nullable(),
    educationLevel: z.enum(['bachelor', 'master']).nullable(),
    location: z.object({ text: z.string().min(1), city: z.string().min(1).nullable(), country: Country }).strict(),
    workModel: z.enum(['onsite', 'remote']),
    remoteScope: Country.nullable(),
    pay: z
      .object({
        min: z.number().positive(),
        max: z.number().positive(),
        currency: Currency,
        period: z.enum(['year', 'month', 'hour']),
        months: z.number().int().nullable(),
        text: z.string().min(1),
        /** False for the hard negative whose figure cannot be pay for its period. */
        plausible: z.boolean(),
      })
      .strict()
      .nullable(),
    sponsorship: z.enum(['offered', 'not_offered']).nullable(),
    sponsorshipQuote: z.string().nullable(),
    classYears: z.array(z.number().int()),
    classYearQuote: z.string().nullable(),
    description: z.string().min(10),
    qualifications: z.string().nullable(),
    postedDaysAgo: z.number().int().min(0).max(120),
    /** What kind of hard negative the posting is, if any: internship, no_skills_no_level, country_only, remote, implausible_pay, head_noun, other_discipline. */
    tags: z.array(z.string()),
    /** True: not relevant for every persona outside the posting's own role group, whatever the category. */
    otherDiscipline: z.boolean(),
  })
  .strict();
export type Posting = z.infer<typeof PostingSchema>;

const Header = { _synthetic: z.literal(true), _generatedBy: z.string().min(1), _seed: z.number().int(), market: z.enum(FIXTURE_MARKETS) };

export const PersonasFileSchema = z.object({ ...Header, personas: z.array(PersonaSchema) }).strict();
export const PostingsFileSchema = z.object({ ...Header, postings: z.array(PostingSchema) }).strict();
export const LabelsFileSchema = z
  .object({
    ...Header,
    /** Constructed by the generator. Never `judged` or `human` in a committed fixture of this bundle. */
    _kind: z.literal('constructed'),
    _rule: z.string().min(1),
    /** persona id → posting id → grade 0-3. The keys of one persona are its pooled candidates. */
    labels: z.record(z.string(), z.record(z.string(), z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]))),
  })
  .strict();

export type PersonasFile = z.infer<typeof PersonasFileSchema>;
export type PostingsFile = z.infer<typeof PostingsFileSchema>;
export type LabelsFile = z.infer<typeof LabelsFileSchema>;

/** `fixtures/baselines.json`, written by `npm run eval:match -- --write-baseline`. Values to six decimals. */
export const BaselinesFileSchema = z
  .object({
    _generatedBy: z.string().min(1),
    writtenAt: z.string().min(1),
    /** What the values were measured on, in words (which order, on which commit). */
    source: z.string().min(1).optional(),
    /** Hash of the fixture files the values were measured on (`fixtureFilesHash`): a baseline for other fixtures is not compared. */
    fixturesHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** `<layer>/<metric>/<market>/<subset>` → value. */
    values: z.record(z.string(), z.number()),
  })
  .strict();
export type BaselinesFile = z.infer<typeof BaselinesFileSchema>;

export const FIXTURE_FILES = {
  personas: (market: FixtureMarket) => `personas.${market}.json`,
  postings: (market: FixtureMarket) => `postings.${market}.json`,
  labels: (market: FixtureMarket) => `labels.constructed.${market}.json`,
  baselines: 'baselines.json',
} as const;
