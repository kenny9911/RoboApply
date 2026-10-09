// server/src/features/coverletter/contract.ts
//
// Cover letters (ARCHITECTURE.md §2.9, §3.6; TASK_PLAN.md WP-37). Mount:
// /api/v1/roboapply/cover-letters. Credit `cover_letter` on create
// (Idempotency-Key); rewrite 20/day/letter, otherwise free.
//
// Honesty: every sentence carries a citation (`resume` | `posting`); a
// sentence that states a posting fact as the candidate's own experience is
// rejected by the claim checker. Label: "Written from the job post and your
// resume." The letter is never sent by us (D1).

import { z } from 'zod';

const Id = z.string().min(1).max(64);

export const LETTER_TONES = ['plain', 'warm', 'formal'] as const;
export const LETTER_LENGTHS = ['short', 'standard'] as const;
/** At most 20 stored versions per letter. */
export const MAX_LETTER_VERSIONS = 20;

const Jd = z.object({ title: z.string().trim().min(1).max(200), company: z.string().trim().max(200), text: z.string().trim().min(50).max(60_000) }).strict();

export const CreateLetterBodySchema = z
  .object({
    jobId: Id.optional(),
    jd: Jd.optional(),
    resumeVariantId: Id,
    tone: z.enum(LETTER_TONES).default('plain'),
    length: z.enum(LETTER_LENGTHS).default('standard'),
    trackerEntryId: Id.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.jobId) !== Boolean(v.jd), { message: 'Send either jobId or jd.' });

export const LetterParamsSchema = z.object({ id: Id });
export const ListLettersQuerySchema = z.object({ jobId: Id.optional(), cursor: z.string().max(64).optional() });
export const PatchLetterBodySchema = z
  .object({ bodyMarkdown: z.string().max(20_000).optional(), title: z.string().trim().max(200).optional(), trackerEntryId: Id.nullable().optional() })
  .strict();
export const RewriteLetterBodySchema = z.object({ instruction: z.string().trim().min(1).max(1000) }).strict();
export const RestoreLetterBodySchema = z.object({ versionIndex: z.number().int().min(0).max(MAX_LETTER_VERSIONS - 1) }).strict();
export const ExportLetterQuerySchema = z.object({ format: z.enum(['pdf', 'docx']) });

/** `RACoverLetter.versions`: `[{ body, reason, createdAt }]`, max 20. */
export const LetterVersionsSchema = z
  .array(z.object({ body: z.string(), reason: z.string(), createdAt: z.string() }).strict())
  .max(MAX_LETTER_VERSIONS);
/** `RACoverLetter.citations`: `[{ sentenceIdx, source, ref }]` */
export const LetterCitationsSchema = z.array(
  z.object({ sentenceIdx: z.number().int().min(0), source: z.enum(['resume', 'posting']), ref: z.string() }).strict(),
);

export interface CoverLetterView {
  id: string;
  title: string | null;
  jobId: string | null;
  resumeVariantId: string;
  trackerEntryId: string | null;
  tone: (typeof LETTER_TONES)[number];
  length: (typeof LETTER_LENGTHS)[number];
  locale: string;
  bodyMarkdown: string;
  citations: z.infer<typeof LetterCitationsSchema>;
  versions: Array<{ reason: string; createdAt: string }>;
  /** "Written from the job post and your resume." */
  aiWritten: true;
  updatedAt: string;
  createdAt: string;
}

export const COVER_LETTER_ERROR_CODES = {
  notFound: 'cover_letter_not_found',
  rewriteLimit: 'cover_letter_rewrite_limit',
  claimRejected: 'cover_letter_claim_rejected',
} as const;
