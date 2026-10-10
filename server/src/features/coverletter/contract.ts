// server/src/features/coverletter/contract.ts
//
// Cover letters (ARCHITECTURE.md §2.9, §3.6; PRODUCT_PLAN.md F-CL-01/02;
// TASK_PLAN.md WP-37). Mount: /api/v1/roboapply/cover-letters.
//
//   GET    /                     ?jobId&cursor → ListLettersResponse
//   POST   /                     CreateLetterBody → CoverLetterView          credit `cover_letter` (Idempotency-Key)
//   GET    /:id                  → CoverLetterView
//   PATCH  /:id                  { bodyMarkdown?, title?, trackerEntryId? }  (an edit is snapshotted as a version)
//   DELETE /:id                  → { deleted: true }
//   POST   /:id/rewrite          { instruction } → CoverLetterView           20/day/letter, otherwise free
//   POST   /:id/regenerate       { tone?, length?, locale? } → CoverLetterView credit `cover_letter` (Idempotency-Key)
//   POST   /:id/restore          { versionIndex } → CoverLetterView
//   GET    /:id/export           ?format=pdf|docx[&trackerEntryId] → file   (409 pdf_font_unavailable: PDF of CJK text without fonts)
//
// Honesty: every sentence of the AI text carries a citation (`resume` |
// `posting`; a sentence the user wrote is `user`); a sentence that states a
// posting fact as the candidate's own experience is rejected by the claim
// checker (claimCheck.ts) and the letter is not saved. Label: "Written from
// the job post and your resume." The letter is never sent by us (D1): the
// user copies or downloads it.

import { z } from 'zod';

const Id = z.string().min(1).max(64);

export const LETTER_TONES = ['plain', 'warm', 'formal'] as const;
export const LETTER_LENGTHS = ['short', 'standard'] as const;
/** Languages a letter can be written in (the nine product locales). */
export const LETTER_LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] as const;
/** At most 20 stored versions per letter (oldest dropped first). */
export const MAX_LETTER_VERSIONS = 20;
/** AI rewrites per letter per day (ARCH §3.6). */
export const REWRITES_PER_LETTER_PER_DAY = 20;
/** Letters per list page. */
export const LETTERS_PAGE_SIZE = 20;
/** Body cap (characters). */
export const MAX_LETTER_BODY = 20_000;

export type LetterTone = (typeof LETTER_TONES)[number];
export type LetterLength = (typeof LETTER_LENGTHS)[number];
export type LetterLocale = (typeof LETTER_LOCALES)[number];

const Jd = z.object({ title: z.string().trim().min(1).max(200), company: z.string().trim().max(200), text: z.string().trim().min(50).max(60_000) }).strict();

export const CreateLetterBodySchema = z
  .object({
    jobId: Id.optional(),
    jd: Jd.optional(),
    resumeVariantId: Id,
    tone: z.enum(LETTER_TONES).default('plain'),
    length: z.enum(LETTER_LENGTHS).default('standard'),
    /** Language of the letter; defaults to the request locale (GoApply: 中文 or English for 外企). */
    locale: z.enum(LETTER_LOCALES).optional(),
    trackerEntryId: Id.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.jobId) !== Boolean(v.jd), { message: 'Send either jobId or jd.' });

export const LetterParamsSchema = z.object({ id: Id });
export const ListLettersQuerySchema = z.object({ jobId: Id.optional(), cursor: z.string().max(64).optional() });
export const PatchLetterBodySchema = z
  .object({
    bodyMarkdown: z.string().max(MAX_LETTER_BODY).optional(),
    title: z.string().trim().max(200).optional(),
    /** Attach to (or, with null, detach from) a tracker entry the user owns. */
    trackerEntryId: Id.nullable().optional(),
  })
  .strict();
export const RewriteLetterBodySchema = z.object({ instruction: z.string().trim().min(1).max(1000) }).strict();
export const RegenerateLetterBodySchema = z
  .object({ tone: z.enum(LETTER_TONES).optional(), length: z.enum(LETTER_LENGTHS).optional(), locale: z.enum(LETTER_LOCALES).optional() })
  .strict();
export const RestoreLetterBodySchema = z.object({ versionIndex: z.number().int().min(0).max(MAX_LETTER_VERSIONS - 1) }).strict();
export const ExportLetterQuerySchema = z.object({
  format: z.enum(['pdf', 'docx']),
  /** When set and the letter is attached to this application, the exact file is recorded on it (RAApplicationArtifact). */
  trackerEntryId: Id.optional(),
});

/** Where a sentence comes from: the resume, the job post, or the user's own edit. */
export const CITATION_SOURCES = ['resume', 'posting', 'user'] as const;
export type CitationSource = (typeof CITATION_SOURCES)[number];

/** `RACoverLetter.citations`: `[{ sentenceIdx, source, ref, sentence? }]` */
export const LetterCitationSchema = z
  .object({
    sentenceIdx: z.number().int().min(0),
    source: z.enum(CITATION_SOURCES),
    /** The verbatim line of the source (empty for `user`). */
    ref: z.string(),
    /** The sentence text the citation belongs to (re-maps citations after an edit). */
    sentence: z.string().optional(),
  })
  .strict();
export const LetterCitationsSchema = z.array(LetterCitationSchema);
export type LetterCitation = z.infer<typeof LetterCitationSchema>;

export const VERSION_REASONS = ['generated', 'edit', 'rewrite', 'regenerate', 'restore'] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];

/** `RACoverLetter.versions`: `[{ body, reason, createdAt, citations? }]`, max 20, newest last. */
export const LetterVersionSchema = z
  .object({ body: z.string(), reason: z.string(), createdAt: z.string(), citations: LetterCitationsSchema.optional() })
  .strict();
export const LetterVersionsSchema = z.array(LetterVersionSchema).max(MAX_LETTER_VERSIONS);
export type LetterVersion = z.infer<typeof LetterVersionSchema>;

export interface LetterVersionView {
  /** Index into the stored versions (what `restore` takes). */
  index: number;
  reason: VersionReason;
  createdAt: string;
  /** First characters of that version, for the list. */
  preview: string;
  /** True for the version the body currently shows. */
  current: boolean;
}

/** One sentence of the body with where it came from (the Sources panel). */
export interface LetterSentenceView {
  index: number;
  text: string;
  sources: Array<{ source: CitationSource; ref: string }>;
}

export interface CoverLetterView {
  id: string;
  title: string | null;
  jobId: string | null;
  resumeVariantId: string;
  trackerEntryId: string | null;
  tone: LetterTone;
  length: LetterLength;
  locale: string;
  bodyMarkdown: string;
  citations: LetterCitation[];
  /** The cited sentences, in body order (greeting and sign-off excluded). */
  sentences: LetterSentenceView[];
  versions: LetterVersionView[];
  /** "Written from the job post and your resume." */
  aiWritten: true;
  /** True once the user changed the AI text by hand. */
  userEdited: boolean;
  /** False when AI actions (rewrite, regenerate) are off for this user (consent, or no model for the brand). */
  aiAvailable: boolean;
  /** Rewrites left today for this letter, or null when unknown. */
  rewritesLeftToday: number | null;
  /**
   * False when the job post this letter was written from cannot be read again
   * (a pasted post that was not kept, SR-37-1): rewrite and regenerate are not
   * possible, and the UI does not offer them.
   */
  postingAvailable: boolean;
  /** False when a PDF of this letter cannot print its characters yet (no CJK font bundled); Word still works. */
  pdfAvailable: boolean;
  updatedAt: string;
  createdAt: string;
}

/** Row of the letters list (no body). */
export interface CoverLetterSummary {
  id: string;
  title: string | null;
  jobId: string | null;
  trackerEntryId: string | null;
  tone: LetterTone;
  length: LetterLength;
  locale: string;
  preview: string;
  updatedAt: string;
  createdAt: string;
}

export interface ListLettersResponse {
  items: CoverLetterSummary[];
  cursor: string | null;
  /** False when writing a new letter is not possible (AI consent off or no model). */
  aiAvailable: boolean;
}

export interface DeleteLetterResponse {
  deleted: true;
}

export const COVER_LETTER_ERROR_CODES = {
  notFound: 'cover_letter_not_found',
  rewriteLimit: 'cover_letter_rewrite_limit',
  claimRejected: 'cover_letter_claim_rejected',
  resumeUnverified: 'resume_unverified_claims',
  resumeTooShort: 'resume_too_short',
  versionNotFound: 'cover_letter_version_not_found',
  trackerEntryNotFound: 'tracker_entry_not_found',
  jobNotFound: 'job_not_found',
  postingUnavailable: 'posting_unavailable',
  pdfUnavailable: 'pdf_font_unavailable',
} as const;
