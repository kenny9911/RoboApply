// server/src/features/network/contract.ts
//
// People at {company}: connections, contacts, outreach drafts (ARCHITECTURE.md
// §2.10, §3.7; TASK_PLAN.md WP-54). Mount: /api/v1/roboapply/network.
// Contact routes are gated by the `hiringContacts` mode (`off |
// deeplinks_only | on`, default `deeplinks_only`): only `on` serves them;
// the connections endpoint always returns the LinkedIn search deep links.
//
// Honesty (D3, H16): people shown are real records from a named source; a
// LinkedIn connections import keeps name, company, position and connected-on
// date only (the email column is discarded at parse time); bank recruiters
// appear only with an opt-in record read through the RoboHire/GoHire API.
// We never send a message: drafts are copied and sent by the user.

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const NetworkJobParamsSchema = z.object({ id: Id });
export const ContactParamsSchema = z.object({ id: Id });
export const DraftParamsSchema = z.object({ id: Id });

export const CONTACT_SOURCES = ['user_connections_import', 'user_added', 'bank_recruiter'] as const;
export interface ContactView {
  id: string;
  source: (typeof CONTACT_SOURCES)[number];
  /** Display name of the source, e.g. "Your LinkedIn connections", "{sourceName} recruiter". */
  sourceLabel: string;
  fullName: string;
  title: string | null;
  companyName: string;
  linkedinUrl: string | null;
  connectedOn: string | null;
}

/** GET /network/jobs/:id/connections */
export interface ConnectionsForJobResponse {
  fromYourCompanies: ContactView[];
  fromYourSchools: ContactView[];
  recruiters: ContactView[];
  /** LinkedIn people-search deep links built from the company name (always available). */
  searchLinks: Array<{ label: string; url: string }>;
}

/** POST /network/imports/linkedin-connections — multipart `Connections.csv` (the user's own export); 3/day. */
export const LINKEDIN_IMPORT_LIMIT_PER_DAY = 3;
export interface ConnectionsImportResponse {
  rowCount: number;
  importedCount: number;
}

export const ListContactsQuerySchema = z.object({ company: z.string().trim().max(160).optional(), cursor: z.string().max(64).optional() });
export const CreateContactBodySchema = z
  .object({
    fullName: z.string().trim().min(1).max(160),
    companyName: z.string().trim().min(1).max(160),
    title: z.string().trim().max(160).optional(),
    linkedinUrl: z.string().url().max(300).optional(),
  })
  .strict();

export const OUTREACH_CHANNELS = ['linkedin_note', 'email', 'referral_ask', 'follow_up', 'wechat'] as const;
/** LinkedIn connection note limit. */
export const LINKEDIN_NOTE_MAX_CHARS = 300;
/** POST /network/outreach-drafts (credit `outreach`, Idempotency-Key). */
export const CreateOutreachDraftBodySchema = z
  .object({ contactId: Id.optional(), jobId: Id, channel: z.enum(OUTREACH_CHANNELS), trackerEntryId: Id.optional() })
  .strict();
export const PatchOutreachDraftBodySchema = z
  .object({ subject: z.string().max(200).nullable().optional(), body: z.string().max(5000).optional() })
  .strict();
export interface OutreachDraftView {
  id: string;
  channel: (typeof OUTREACH_CHANNELS)[number];
  contactId: string | null;
  jobId: string | null;
  subject: string | null;
  body: string;
  copiedAt: string | null;
  markedSentAt: string | null;
  aiWritten: true;
  createdAt: string;
}

export const NETWORK_ERROR_CODES = {
  importLimit: 'connections_import_limit',
  badCsv: 'connections_csv_unreadable',
  contactNotFound: 'contact_not_found',
} as const;
