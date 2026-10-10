// server/src/features/network/contract.ts
//
// People at {company}: connections, contacts, outreach drafts (ARCHITECTURE.md
// §2.10, §3.7; TASK_PLAN.md WP-54). Mount: /api/v1/roboapply/network.
//
// Gates (the `hiringContacts` mode is `off | deeplinks_only | on`, default
// `deeplinks_only` until OPS-A10 ships the recruiter opt-in):
//   - `on` only: the contact routes (/contacts*), the connections import
//     (POST /imports/linkedin-connections) and the people buckets of
//     GET /jobs/:id/connections;
//   - always: the LinkedIn search deep links, the outreach drafts, the import
//     status and "Delete all imported connections" (the user can always remove
//     what they gave us, whatever the mode);
//   - `contactEmailLookup` + a configured provider: the email lookup, which
//     answers `501 provider_not_configured` today (F-NET-05/07 are deferred).
//
// Honesty (D3, H15, H16): people shown are real records from a named source.
// A LinkedIn connections import keeps name, company, position and
// connected-on date only (the email and profile-URL columns are discarded at
// parse time). Bank recruiters appear only with an opt-in record read
// through the RoboHire/GoHire API (`consentBasis` is written by the
// contacts-sync alone). We never send a message: drafts are copied or opened
// in the user's own mail app (`mailto:`) and sent by the user.

import { z } from 'zod';
import type { HiringContactsMode } from '../../platform/brand/registry.js';

const Id = z.string().min(1).max(64);
export const NetworkJobParamsSchema = z.object({ id: Id });
export const ContactParamsSchema = z.object({ id: Id });
export const DraftParamsSchema = z.object({ id: Id });

export const CONTACT_SOURCES = ['user_connections_import', 'user_added', 'bank_recruiter'] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export interface ContactView {
  id: string;
  source: ContactSource;
  /** Plain English label of the source (for the Assistant); the web UI localizes from `source` + `sourceName`. */
  sourceLabel: string;
  /** The named source behind a bank recruiter ('RoboHire' | 'GoHire'); null for the user's own contacts. */
  sourceName: string | null;
  fullName: string;
  title: string | null;
  companyName: string;
  linkedinUrl: string | null;
  connectedOn: string | null;
  /** bank_recruiter only: when the recruiter opted in to being contactable (from the opt-in record). */
  optedInAt: string | null;
}

/** GET /network/jobs/:id/connections */
export interface ConnectionsForJobResponse {
  /** The user's own contacts (imported connections, people they added) at this company. */
  fromYourCompanies: ContactView[];
  /** The user's own contacts at this company who went to one of the user's schools. */
  fromYourSchools: ContactView[];
  /**
   * The job's hiring contact: the bank recruiter who posted THIS recruiter-bank job
   * (bank Job.userId for RAJob.externalId), only when they opted in to being
   * contactable. At most one; empty until OPS-A10 or when the poster has not opted in.
   */
  recruiters: ContactView[];
  /** LinkedIn people-search deep links built from the company name (always available on RoboApply). */
  searchLinks: Array<{ label: string; url: string }>;
  /** The resolved `hiringContacts` mode for this user. */
  mode: HiringContactsMode;
  /** The user's imported connections in total (0 → offer the import). */
  importedCount: number;
  /** AI drafting is available (the user's AI consent AND the brand's text model). */
  aiAvailable: boolean;
  /** Drafts the user already wrote for this job, newest first. */
  drafts: OutreachDraftView[];
}

/** POST /network/imports/linkedin-connections — multipart field `file` (the user's own `Connections.csv`); 3/day. */
export const LINKEDIN_IMPORT_LIMIT_PER_DAY = 3;
/** Largest accepted export (LinkedIn's Connections.csv is ~100 bytes a row). */
export const LINKEDIN_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Rows read from one file; the rest are ignored (LinkedIn caps connections at 30,000). */
export const LINKEDIN_IMPORT_MAX_ROWS = 30_000;
export const LINKEDIN_IMPORT_FIELD = 'file';
export interface ConnectionsImportResponse {
  /** Data rows in the file. */
  rowCount: number;
  /** New people saved (rows without a name or company and people already imported are skipped). */
  importedCount: number;
}

/** GET /network/imports/linkedin-connections */
export interface ConnectionsImportStatus {
  importedCount: number;
  lastImportAt: string | null;
  importsToday: number;
  limitPerDay: number;
}

/** DELETE /network/imports/linkedin-connections */
export interface DeleteConnectionsResponse {
  deleted: number;
}

export const CONTACTS_PAGE_SIZE = 50;
export const ListContactsQuerySchema = z.object({ company: z.string().trim().max(160).optional(), cursor: z.string().max(64).optional() });
export const CreateContactBodySchema = z
  .object({
    fullName: z.string().trim().min(1).max(160),
    companyName: z.string().trim().min(1).max(160),
    title: z.string().trim().max(160).optional(),
    linkedinUrl: z.string().url().max(300).optional(),
  })
  .strict();
export interface ListContactsResponse {
  items: ContactView[];
  cursor: string | null;
}

export const OUTREACH_CHANNELS = ['linkedin_note', 'email', 'referral_ask', 'follow_up', 'wechat'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];
/** Channels per market: no LinkedIn note on GoApply, no WeChat message on RoboApply. */
export const OUTREACH_CHANNELS_BY_MARKET: Record<'intl' | 'cn', readonly OutreachChannel[]> = {
  intl: ['linkedin_note', 'email', 'referral_ask', 'follow_up'],
  cn: ['wechat', 'referral_ask', 'email', 'follow_up'],
};
/** LinkedIn connection note limit. */
export const LINKEDIN_NOTE_MAX_CHARS = 300;
/** Upper bound for every other channel. */
export const OUTREACH_BODY_MAX_CHARS = 5000;
export const OUTREACH_DRAFT_LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] as const;

/** POST /network/outreach-drafts (credit `outreach`, Idempotency-Key). */
export const CreateOutreachDraftBodySchema = z
  .object({
    contactId: Id.optional(),
    jobId: Id,
    channel: z.enum(OUTREACH_CHANNELS),
    trackerEntryId: Id.optional(),
    locale: z.enum(OUTREACH_DRAFT_LOCALES).optional(),
  })
  .strict();
export const PatchOutreachDraftBodySchema = z
  .object({ subject: z.string().max(200).nullable().optional(), body: z.string().max(OUTREACH_BODY_MAX_CHARS).optional() })
  .strict();
export const ListOutreachDraftsQuerySchema = z
  .object({ jobId: Id.optional(), trackerEntryId: Id.optional() })
  .refine((q) => Boolean(q.jobId || q.trackerEntryId), { message: 'jobId or trackerEntryId is required' });
export interface OutreachDraftView {
  id: string;
  channel: OutreachChannel;
  contactId: string | null;
  jobId: string | null;
  trackerEntryId: string | null;
  subject: string | null;
  body: string;
  copiedAt: string | null;
  markedSentAt: string | null;
  aiWritten: true;
  createdAt: string;
}
export interface ListOutreachDraftsResponse {
  items: OutreachDraftView[];
}

export const NETWORK_ERROR_CODES = {
  importLimit: 'connections_import_limit',
  badCsv: 'connections_csv_unreadable',
  fileMissing: 'connections_file_missing',
  fileTooLarge: 'connections_file_too_large',
  contactNotFound: 'contact_not_found',
  draftNotFound: 'outreach_draft_not_found',
  jobNotFound: 'job_not_found',
  trackerEntryNotFound: 'tracker_entry_not_found',
  channelNotAvailable: 'outreach_channel_not_available',
  draftEmpty: 'outreach_draft_empty',
} as const;
