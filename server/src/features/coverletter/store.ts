// server/src/features/coverletter/store.ts
//
// The narrow, typed Prisma adapter for cover letters (WP-37). The service
// talks to this interface only, so tests run against the in-memory twin
// (memoryStore.ts) and never touch the database. Every read is scoped to the
// user; deleted letters (`deletedAt`) are invisible.

import type { Prisma } from '../../generated/prisma/client.js';

export interface LetterRow {
  id: string;
  userId: string;
  jobId: string | null;
  trackerEntryId: string | null;
  resumeVariantId: string;
  title: string;
  tone: string;
  length: string;
  locale: string;
  bodyMarkdown: string;
  versions: unknown;
  citations: unknown;
  model: string | null;
  creditLedgerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewLetter {
  userId: string;
  jobId: string | null;
  trackerEntryId: string | null;
  resumeVariantId: string;
  title: string;
  tone: string;
  length: string;
  locale: string;
  bodyMarkdown: string;
  versions: unknown;
  citations: unknown;
  model: string | null;
  creditLedgerId: string | null;
}

export interface LetterUpdate {
  title?: string;
  tone?: string;
  length?: string;
  locale?: string;
  bodyMarkdown?: string;
  versions?: unknown;
  citations?: unknown;
  model?: string | null;
  trackerEntryId?: string | null;
  creditLedgerId?: string | null;
}

export interface VariantRow {
  id: string;
  userId: string;
  name: string;
  kind: string;
  resumeMarkdown: string;
}

export interface JobRow {
  id: string;
  title: string;
  companyName: string;
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
}

export interface NewArtifact {
  userId: string;
  trackerEntryId: string;
  coverLetterId: string;
  fileName: string;
  format: 'pdf' | 'docx';
  fileSha256: string;
  channel: 'download';
}

export interface CoverLetterStore {
  findVariant(userId: string, variantId: string): Promise<VariantRow | null>;
  /** A job the user may see: public in the brand's market, or one the user added. */
  findJob(userId: string, jobId: string, market: 'intl' | 'cn'): Promise<JobRow | null>;
  ownsTrackerEntry(userId: string, entryId: string): Promise<boolean>;
  createLetter(data: NewLetter): Promise<LetterRow>;
  findLetter(userId: string, letterId: string): Promise<LetterRow | null>;
  /** Null when the letter is gone (deleted or not the user's). */
  updateLetter(userId: string, letterId: string, data: LetterUpdate): Promise<LetterRow | null>;
  /** Newest first; `cursor` is the id of the last row of the previous page. */
  listLetters(userId: string, options: { jobId?: string; cursor?: string; limit: number }): Promise<LetterRow[]>;
  softDelete(userId: string, letterId: string, now: Date): Promise<boolean>;
  /**
   * Point `RATrackerEntry.coverLetterId` at the letter (the "files sent"
   * link of the application); `previousEntryId` is cleared when it still
   * points at this letter, and any other letter attached to `entryId` is
   * detached (an application has one letter).
   */
  linkTrackerEntry(userId: string, letterId: string, entryId: string | null, previousEntryId: string | null): Promise<void>;
  recordArtifact(data: NewArtifact): Promise<{ id: string }>;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

const LETTER_SELECT = {
  id: true,
  userId: true,
  jobId: true,
  trackerEntryId: true,
  resumeVariantId: true,
  title: true,
  tone: true,
  length: true,
  locale: true,
  bodyMarkdown: true,
  versions: true,
  citations: true,
  model: true,
  creditLedgerId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function updateData(data: LetterUpdate) {
  return {
    ...(data.title !== undefined ? { title: data.title } : {}),
    ...(data.tone !== undefined ? { tone: data.tone } : {}),
    ...(data.length !== undefined ? { length: data.length } : {}),
    ...(data.locale !== undefined ? { locale: data.locale } : {}),
    ...(data.bodyMarkdown !== undefined ? { bodyMarkdown: data.bodyMarkdown } : {}),
    ...(data.versions !== undefined ? { versions: json(data.versions) } : {}),
    ...(data.citations !== undefined ? { citations: json(data.citations) } : {}),
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.trackerEntryId !== undefined ? { trackerEntryId: data.trackerEntryId } : {}),
    ...(data.creditLedgerId !== undefined ? { creditLedgerId: data.creditLedgerId } : {}),
  };
}

export function createPrismaCoverLetterStore(): CoverLetterStore {
  const db = async () => (await import('../../lib/prisma.js')).default;
  return {
    async findVariant(userId, variantId) {
      const p = await db();
      return p.rAResumeVariant.findFirst({
        where: { id: variantId, userId, deletedAt: null },
        select: { id: true, userId: true, name: true, kind: true, resumeMarkdown: true },
      });
    },
    async findJob(userId, jobId, market) {
      const p = await db();
      return p.rAJob.findFirst({
        where: { id: jobId, OR: [{ visibility: 'public', market }, { ownerUserId: userId }] },
        select: { id: true, title: true, companyName: true, descriptionPlain: true, qualifications: true, responsibilities: true },
      });
    },
    async ownsTrackerEntry(userId, entryId) {
      const p = await db();
      const row = await p.rATrackerEntry.findFirst({ where: { id: entryId, userId, deletedAt: null }, select: { id: true } });
      return Boolean(row);
    },
    async createLetter(data) {
      const p = await db();
      return p.rACoverLetter.create({
        data: {
          userId: data.userId,
          jobId: data.jobId,
          trackerEntryId: data.trackerEntryId,
          resumeVariantId: data.resumeVariantId,
          title: data.title,
          tone: data.tone,
          length: data.length,
          locale: data.locale,
          bodyMarkdown: data.bodyMarkdown,
          versions: json(data.versions),
          citations: json(data.citations),
          model: data.model,
          creditLedgerId: data.creditLedgerId,
        },
        select: LETTER_SELECT,
      });
    },
    async findLetter(userId, letterId) {
      const p = await db();
      return p.rACoverLetter.findFirst({ where: { id: letterId, userId, deletedAt: null }, select: LETTER_SELECT });
    },
    async updateLetter(userId, letterId, data) {
      const p = await db();
      const res = await p.rACoverLetter.updateMany({ where: { id: letterId, userId, deletedAt: null }, data: updateData(data) });
      if (res.count === 0) return null;
      return p.rACoverLetter.findFirst({ where: { id: letterId, userId, deletedAt: null }, select: LETTER_SELECT });
    },
    async listLetters(userId, { jobId, cursor, limit }) {
      const p = await db();
      return p.rACoverLetter.findMany({
        where: { userId, deletedAt: null, ...(jobId ? { jobId } : {}) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: LETTER_SELECT,
      });
    },
    async softDelete(userId, letterId, now) {
      const p = await db();
      const res = await p.rACoverLetter.updateMany({ where: { id: letterId, userId, deletedAt: null }, data: { deletedAt: now } });
      if (res.count > 0) {
        await p.rATrackerEntry.updateMany({ where: { userId, coverLetterId: letterId }, data: { coverLetterId: null } });
      }
      return res.count > 0;
    },
    async linkTrackerEntry(userId, letterId, entryId, previousEntryId) {
      const p = await db();
      await p.$transaction(async (tx) => {
        if (previousEntryId && previousEntryId !== entryId) {
          await tx.rATrackerEntry.updateMany({ where: { id: previousEntryId, userId, coverLetterId: letterId }, data: { coverLetterId: null } });
        }
        if (entryId) {
          await tx.rATrackerEntry.updateMany({ where: { id: entryId, userId, deletedAt: null }, data: { coverLetterId: letterId } });
          // One letter per application: a letter attached before no longer points at it.
          await tx.rACoverLetter.updateMany({
            where: { userId, trackerEntryId: entryId, id: { not: letterId }, deletedAt: null },
            data: { trackerEntryId: null },
          });
        }
      });
    },
    async recordArtifact(data) {
      const p = await db();
      return p.rAApplicationArtifact.create({
        data: {
          userId: data.userId,
          trackerEntryId: data.trackerEntryId,
          kind: 'cover_letter',
          coverLetterId: data.coverLetterId,
          fileName: data.fileName,
          format: data.format,
          fileSha256: data.fileSha256,
          storageKey: null,
          channel: data.channel,
        },
        select: { id: true },
      });
    },
  };
}

// ── Pasted job posts (SR-37-1: RACoverLetter.postingSnapshot) ──────────────

/** `RACoverLetter.postingSnapshot`: the pasted job post a letter was written from. */
export interface StoredPosting {
  title: string;
  company: string;
  text: string;
}

/** The stored JSON as a posting, or null when the column is empty or not a posting. */
export function parseStoredPosting(raw: unknown): StoredPosting | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || typeof r.text !== 'string' || !r.text.trim()) return null;
  return { title: r.title, company: typeof r.company === 'string' ? r.company : '', text: r.text };
}

/** The slice of Prisma the posting store uses (tests pass a recording fake). */
export interface PostingDb {
  rACoverLetter: {
    findFirst(args: { where: { id: string; deletedAt: null }; select: { postingSnapshot: true } }): Promise<{ postingSnapshot: unknown } | null>;
    updateMany(args: { where: { id: string; deletedAt: null }; data: { postingSnapshot: Prisma.InputJsonValue } }): Promise<{ count: number }>;
  };
}

export interface PostingStore {
  read(letterId: string): Promise<StoredPosting | null>;
  write(letterId: string, snapshot: StoredPosting): Promise<void>;
}

/**
 * Keeps the pasted job post on its letter so rewrite and regenerate can read
 * it again. Letters written from a job id store nothing here (the post is
 * re-read from the job). The service reads the letter with the user's scope
 * before it reads or writes the snapshot.
 */
export function createPrismaPostingStore(getDb?: () => Promise<PostingDb>): PostingStore {
  const db = getDb ?? (async () => (await import('../../lib/prisma.js')).default as unknown as PostingDb);
  return {
    async read(letterId) {
      const p = await db();
      const row = await p.rACoverLetter.findFirst({ where: { id: letterId, deletedAt: null }, select: { postingSnapshot: true } });
      return parseStoredPosting(row?.postingSnapshot);
    },
    async write(letterId, snapshot) {
      const p = await db();
      await p.rACoverLetter.updateMany({
        where: { id: letterId, deletedAt: null },
        data: { postingSnapshot: json({ title: snapshot.title, company: snapshot.company, text: snapshot.text }) },
      });
    },
  };
}
