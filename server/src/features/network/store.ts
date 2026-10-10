// server/src/features/network/store.ts — persistence for NET (WP-54).
//
// One narrow interface the service talks to, a Prisma implementation over
// RAContact / RAContactImport / RAOutreachDraft (ra-network.prisma) and the
// few reads it needs from jobs, tracker and resumes. Tests use the memory twin
// in testkit.ts.
//
// Consent rule (H15): this store NEVER writes `consentBasis`. Its only use of
// the column is the read filter below (`consentBasis: { not: null }`), so a
// bank recruiter without an opt-in record can never be returned. The one
// writer is contactsSync.ts (checked by consentBasis.test.ts).

import prisma from '../../lib/prisma.js';
import type { ContactSource, OutreachChannel } from './contract.js';

export interface ContactRow {
  id: string;
  market: string;
  ownerUserId: string | null;
  source: ContactSource | string;
  sourceRef: string | null;
  /** Read-only here: true when the row carries a consent basis (bank_recruiter). */
  consented: boolean;
  companyNameNormalized: string;
  companyId: string | null;
  fullName: string;
  firstName: string | null;
  title: string | null;
  linkedinUrl: string | null;
  connectedOn: Date | null;
  schoolsNormalized: string[];
  pastCompaniesNormalized: string[];
  createdAt: Date;
}

export interface NewOwnContact {
  market: string;
  ownerUserId: string;
  source: 'user_connections_import' | 'user_added';
  sourceRef: string | null;
  companyNameNormalized: string;
  companyId?: string | null;
  fullName: string;
  firstName: string | null;
  title: string | null;
  linkedinUrl: string | null;
  connectedOn: Date | null;
}

export interface DraftRow {
  id: string;
  userId: string;
  contactId: string | null;
  jobId: string | null;
  trackerEntryId: string | null;
  channel: OutreachChannel | string;
  subject: string | null;
  body: string;
  model: string | null;
  copiedAt: Date | null;
  markedSentAt: Date | null;
  createdAt: Date;
}

export interface NetworkJobRow {
  id: string;
  title: string;
  companyName: string;
  companyId: string | null;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  /** For recruiter-bank rows: the bank Job.id (RAJob.externalId). */
  externalId: string;
  sourceBoard: string;
  fromRecruiterBank: boolean;
  descriptionPlain: string;
}

export interface NetworkStore {
  loadJob(jobId: string): Promise<NetworkJobRow | null>;
  /** The user's own contacts (imported + added) at a company, in a market. */
  ownContactsAtCompany(userId: string, market: string, companyNameNormalized: string, limit: number): Promise<ContactRow[]>;
  /**
   * The opted-in contact of ONE bank recruiter (`<bank>:<recruiterId>|optin:…`), or null.
   * Rows without a consent basis are never returned.
   */
  consentedRecruiter(market: string, bank: string, recruiterId: string): Promise<ContactRow | null>;
  countImported(userId: string): Promise<number>;
  importStats(userId: string, since: Date): Promise<{ importsSince: number; lastImportAt: Date | null }>;
  /** `lower(fullName)|companyNameNormalized` of every imported connection the user already has. */
  importedKeys(userId: string): Promise<Set<string>>;
  /** Writes the import record and its new contacts together; returns the import id. */
  saveImport(input: { userId: string; fileName: string; rowCount: number; contacts: Array<Omit<NewOwnContact, 'sourceRef' | 'source'>> }): Promise<string>;
  deleteImportedContacts(userId: string): Promise<number>;
  listOwnContacts(userId: string, options: { market: string; companyNameNormalized?: string; cursor?: string; limit: number }): Promise<ContactRow[]>;
  createOwnContact(input: NewOwnContact): Promise<ContactRow>;
  /** An own contact, or an opted-in recruiter in the market; null otherwise. */
  findVisibleContact(userId: string, market: string, id: string): Promise<ContactRow | null>;
  deleteOwnContact(userId: string, id: string): Promise<boolean>;
  trackerEntry(userId: string, id: string): Promise<{ id: string; jobId: string | null } | null>;
  trackerEntryForJob(userId: string, jobId: string): Promise<{ id: string } | null>;
  createDraft(input: Omit<DraftRow, 'id' | 'createdAt' | 'copiedAt' | 'markedSentAt'>): Promise<DraftRow>;
  findDraft(userId: string, id: string): Promise<DraftRow | null>;
  updateDraft(id: string, data: Partial<Pick<DraftRow, 'subject' | 'body' | 'copiedAt' | 'markedSentAt'>>): Promise<DraftRow>;
  listDrafts(userId: string, filter: { jobId?: string; trackerEntryId?: string }, limit: number): Promise<DraftRow[]>;
  /** The newest draft for (user, job, channel) created at or after `since` (idempotent replays). */
  recentDraft(userId: string, jobId: string, channel: string, since: Date): Promise<DraftRow | null>;
  primaryResumeMarkdown(userId: string): Promise<string | null>;
}

const CONTACT_SELECT = {
  id: true,
  market: true,
  ownerUserId: true,
  source: true,
  sourceRef: true,
  consentBasis: true,
  companyNameNormalized: true,
  companyId: true,
  fullName: true,
  firstName: true,
  title: true,
  linkedinUrl: true,
  connectedOn: true,
  schoolsNormalized: true,
  pastCompaniesNormalized: true,
  createdAt: true,
} as const;

type SelectedContact = {
  id: string;
  market: string;
  ownerUserId: string | null;
  source: string;
  sourceRef: string | null;
  consentBasis: string | null;
  companyNameNormalized: string;
  companyId: string | null;
  fullName: string;
  firstName: string | null;
  title: string | null;
  linkedinUrl: string | null;
  connectedOn: Date | null;
  schoolsNormalized: string[];
  pastCompaniesNormalized: string[];
  createdAt: Date;
};

function toContact(row: SelectedContact): ContactRow {
  const { consentBasis, ...rest } = row;
  return { ...rest, consented: consentBasis != null && consentBasis !== '' };
}

const OWN_SOURCES = ['user_connections_import', 'user_added'];
const IMPORT_SOURCE = 'user_connections_import';
export const CREATE_CHUNK = 1_000;
/** Interactive-transaction bounds for saveImport (30 chunks at the 30,000-row cap). */
export const SAVE_IMPORT_TX = { timeout: 60_000, maxWait: 10_000 } as const;

export const importKey = (fullName: string, companyNameNormalized: string) =>
  `${fullName.trim().toLowerCase().replace(/\s+/g, ' ')}|${companyNameNormalized}`;

export function createPrismaNetworkStore(db: typeof prisma = prisma): NetworkStore {
  return {
    async loadJob(jobId) {
      return db.rAJob.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          title: true,
          companyName: true,
          companyId: true,
          market: true,
          visibility: true,
          ownerUserId: true,
          externalId: true,
          sourceBoard: true,
          fromRecruiterBank: true,
          descriptionPlain: true,
        },
      });
    },

    async ownContactsAtCompany(userId, market, companyNameNormalized, limit) {
      const rows = await db.rAContact.findMany({
        where: { ownerUserId: userId, market, companyNameNormalized, source: { in: OWN_SOURCES } },
        orderBy: [{ connectedOn: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        select: CONTACT_SELECT,
      });
      return rows.map(toContact);
    },

    async consentedRecruiter(market, bank, recruiterId) {
      const row = await db.rAContact.findFirst({
        where: {
          market,
          source: 'bank_recruiter',
          ownerUserId: null,
          consentBasis: { not: null },
          sourceRef: { startsWith: `${bank}:${recruiterId}|optin:` },
        },
        orderBy: { updatedAt: 'desc' },
        select: CONTACT_SELECT,
      });
      return row ? toContact(row) : null;
    },

    async countImported(userId) {
      return db.rAContact.count({ where: { ownerUserId: userId, source: IMPORT_SOURCE } });
    },

    async importStats(userId, since) {
      const [importsSince, last] = await Promise.all([
        db.rAContactImport.count({ where: { userId, createdAt: { gte: since } } }),
        db.rAContactImport.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      ]);
      return { importsSince, lastImportAt: last?.createdAt ?? null };
    },

    async importedKeys(userId) {
      const rows = await db.rAContact.findMany({
        where: { ownerUserId: userId, source: IMPORT_SOURCE },
        select: { fullName: true, companyNameNormalized: true },
      });
      return new Set(rows.map((r) => importKey(r.fullName, r.companyNameNormalized)));
    },

    // One interactive transaction so a failed chunk leaves no half import.
    // LINKEDIN_IMPORT_MAX_ROWS (30,000) means up to 30 createMany calls of
    // 1,000 rows; Prisma's default 5 s timeout / 2 s maxWait abort that with
    // P2028 on a slow database, so the bounds are explicit (store.test.ts).
    async saveImport({ userId, fileName, rowCount, contacts }) {
      return db.$transaction(async (tx) => {
        const record = await tx.rAContactImport.create({
          data: { userId, kind: 'linkedin_connections_csv', fileName, rowCount, importedCount: contacts.length },
          select: { id: true },
        });
        for (let i = 0; i < contacts.length; i += CREATE_CHUNK) {
          await tx.rAContact.createMany({
            data: contacts.slice(i, i + CREATE_CHUNK).map((c) => ({
              market: c.market,
              ownerUserId: userId,
              source: IMPORT_SOURCE,
              sourceRef: record.id,
              companyNameNormalized: c.companyNameNormalized,
              companyId: c.companyId ?? null,
              fullName: c.fullName,
              firstName: c.firstName,
              title: c.title,
              linkedinUrl: null,
              connectedOn: c.connectedOn,
            })),
          });
        }
        return record.id;
      }, SAVE_IMPORT_TX);
    },

    async deleteImportedContacts(userId) {
      const res = await db.rAContact.deleteMany({ where: { ownerUserId: userId, source: IMPORT_SOURCE } });
      return res.count;
    },

    async listOwnContacts(userId, { market, companyNameNormalized, cursor, limit }) {
      const rows = await db.rAContact.findMany({
        where: { ownerUserId: userId, market, source: { in: OWN_SOURCES }, ...(companyNameNormalized ? { companyNameNormalized } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: CONTACT_SELECT,
      });
      return rows.map(toContact);
    },

    async createOwnContact(input) {
      const row = await db.rAContact.create({
        data: {
          market: input.market,
          ownerUserId: input.ownerUserId,
          source: input.source,
          sourceRef: input.sourceRef,
          companyNameNormalized: input.companyNameNormalized,
          companyId: input.companyId ?? null,
          fullName: input.fullName,
          firstName: input.firstName,
          title: input.title,
          linkedinUrl: input.linkedinUrl,
          connectedOn: input.connectedOn,
        },
        select: CONTACT_SELECT,
      });
      return toContact(row);
    },

    async findVisibleContact(userId, market, id) {
      const row = await db.rAContact.findFirst({
        where: {
          id,
          market,
          OR: [
            { ownerUserId: userId, source: { in: OWN_SOURCES } },
            { ownerUserId: null, source: 'bank_recruiter', consentBasis: { not: null } },
          ],
        },
        select: CONTACT_SELECT,
      });
      return row ? toContact(row) : null;
    },

    async deleteOwnContact(userId, id) {
      const res = await db.rAContact.deleteMany({ where: { id, ownerUserId: userId, source: { in: OWN_SOURCES } } });
      return res.count > 0;
    },

    async trackerEntry(userId, id) {
      return db.rATrackerEntry.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true, jobId: true } });
    },

    async trackerEntryForJob(userId, jobId) {
      return db.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    },

    async createDraft(input) {
      return db.rAOutreachDraft.create({ data: input });
    },

    async findDraft(userId, id) {
      return db.rAOutreachDraft.findFirst({ where: { id, userId } });
    },

    async updateDraft(id, data) {
      return db.rAOutreachDraft.update({ where: { id }, data });
    },

    async listDrafts(userId, filter, limit) {
      return db.rAOutreachDraft.findMany({
        where: { userId, ...(filter.jobId ? { jobId: filter.jobId } : {}), ...(filter.trackerEntryId ? { trackerEntryId: filter.trackerEntryId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    },

    async recentDraft(userId, jobId, channel, since) {
      return db.rAOutreachDraft.findFirst({ where: { userId, jobId, channel, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' } });
    },

    async primaryResumeMarkdown(userId) {
      const row = await db.rAResumeVariant.findFirst({
        where: { userId, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
        select: { resumeMarkdown: true },
      });
      return row?.resumeMarkdown ?? null;
    },
  };
}
