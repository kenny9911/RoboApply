// server/src/features/compliance/dataExport.ts
//
// Personal-data export (PIPL Art. 45 copy/portability; GDPR Art. 15/20;
// TW PDPA Art. 3): POST /compliance/export opens a `copy` request and
// enqueues `compliance.export`; the worker builds one JSON file, stores it,
// marks the request done and emails "your export is ready" (the email links
// to Settings → Privacy; the file itself is only served to the signed-in
// owner). Files are deleted after DATA_EXPORT_TTL_DAYS by compliance-daily.
//
// What goes in: the account and everything the user created or that we
// recorded about them, minus secrets (password hashes, token hashes, OAuth
// subjects). Other areas add their own tables through
// `registerExportSection()` (extension point, TASK_PLAN.md §2.1 rule 3).

import prisma from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../platform/http.js';
import { enqueue, kickDrain, PermanentWorkError, type LeasedWorkItem } from '../../platform/queue/index.js';
import { EMAIL_SEND_KIND, type EmailSendPayload } from '../../platform/email/index.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { COMPLIANCE_ERROR_CODES, DATA_EXPORT_TTL_DAYS, type ExportRequestResponse } from './contract.js';
import { DATA_EXPORT_READY_TEMPLATE } from './emails.js';
import { COMPLIANCE_WORK_KINDS } from './kinds.js';
import { createPiRequest, parseDetail } from './piRequests.js';
import { JOB_INTERACTION_KINDS_KEPT } from './retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;
/** Days after expiry the sweep keeps looking at a request. */
export const SWEEP_WINDOW_DAYS = 30;

export type ExportDb = typeof prisma;
export type ExportSection = (userId: string, db: ExportDb) => Promise<unknown>;

const sections = new Map<string, ExportSection>();

/** Add a section to every export (another area's own tables). Idempotent per name. */
export function registerExportSection(name: string, section: ExportSection): void {
  sections.set(name, section);
}

export function exportSectionNames(): string[] {
  return [...sections.keys()];
}

// ── Core sections ──────────────────────────────────────────────────────────

registerExportSection('account', (userId, db) =>
  db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, brand: true, phoneE164: true, phoneVerifiedAt: true, createdAt: true, lastActiveAt: true },
  }),
);
registerExportSection('seekerProfile', (userId, db) => db.seekerProfile.findUnique({ where: { userId } }));
registerExportSection('consents', (userId, db) =>
  db.seekerConsentRecord.findMany({
    where: { seekerProfile: { userId } },
    orderBy: { createdAt: 'asc' },
    select: { consentType: true, granted: true, proseVersion: true, proseHash: true, createdAt: true },
  }),
);
registerExportSection('profile', (userId, db) => db.rAProfile.findUnique({ where: { userId } }));
registerExportSection('signInMethods', (userId, db) =>
  db.rAAuthIdentity.findMany({ where: { userId }, select: { provider: true, email: true, createdAt: true, lastUsedAt: true } }),
);
// Two-step sign-in: whether it is on and since when. The sealed secret, the
// recovery-code hashes and the replay counter are credentials, never exported.
registerExportSection('twoStepSignIn', async (userId, db) => {
  const row = await db.rATwoFactor.findUnique({ where: { userId }, select: { enabledAt: true } });
  return { enabled: Boolean(row?.enabledAt), enrolledAt: row?.enabledAt ?? null };
});
// Student price: the school domain and when it was verified. The address
// itself is never stored (only its hash, which is not exported either).
registerExportSection('studentVerification', (userId, db) =>
  db.rAStudentVerification.findUnique({ where: { userId }, select: { schoolDomain: true, verifiedAt: true, expiresAt: true } }),
);
// Storage keys and upload idempotency tokens are internal; the content is exported.
registerExportSection('resumes', (userId, db) =>
  db.rAResumeVariant.findMany({ where: { userId }, take: ROW_CAP, omit: { originalFileKey: true, originalFileProvider: true, uploadIdempotencyKey: true } }),
);
registerExportSection('coverLetters', (userId, db) =>
  db.rACoverLetter.findMany({ where: { userId }, take: ROW_CAP, omit: { creditLedgerId: true } }),
);
registerExportSection('searchProfiles', (userId, db) => db.rASearchProfile.findMany({ where: { userId }, take: ROW_CAP }));
registerExportSection('applications', (userId, db) => db.rATrackerEntry.findMany({ where: { userId }, take: ROW_CAP }));
registerExportSection('applicationFiles', (userId, db) =>
  db.rAApplicationArtifact.findMany({
    where: { userId },
    take: ROW_CAP,
    select: { kind: true, fileName: true, format: true, fileSha256: true, channel: true, createdAt: true },
  }),
);
// Admin review decisions (kind 'admin_review', WP-74) are an operator record
// about a posting, not something this user did: they are left out.
registerExportSection('jobInteractions', (userId, db) =>
  db.rAJobInteraction.findMany({ where: { userId, kind: { notIn: [...JOB_INTERACTION_KINDS_KEPT] } }, orderBy: { createdAt: 'asc' }, take: ROW_CAP }),
);
registerExportSection('assistant', (userId, db) =>
  db.rACopilotThread.findMany({
    where: { userId },
    take: ROW_CAP,
    include: { messages: { orderBy: { createdAt: 'asc' }, select: { role: true, content: true, createdAt: true } } },
  }),
);
registerExportSection('assistantMemory', (userId, db) => db.rACopilotMemory.findMany({ where: { userId }, take: ROW_CAP }));
registerExportSection('savedSearches', (userId, db) =>
  db.rASavedSearch.findMany({ where: { userId }, take: ROW_CAP, select: { name: true, query: true, lastRunAt: true, createdAt: true, updatedAt: true } }),
);
registerExportSection('answerBank', (userId, db) =>
  db.rAAnswerBankItem.findMany({
    where: { userId },
    take: ROW_CAP,
    select: { questionKey: true, questionText: true, answer: true, source: true, locale: true, lastUsedAt: true, updatedAt: true },
  }),
);
registerExportSection('readyToApplyQueue', (userId, db) =>
  db.rAAgentQueueItem.findMany({
    where: { userId },
    take: ROW_CAP,
    select: {
      jobId: true,
      trackerEntryId: true,
      state: true,
      weekKey: true,
      resumeVariantId: true,
      coverLetterId: true,
      missingFields: true,
      addedVia: true,
      openedAt: true,
      completedAt: true,
      userMarkedSubmitted: true,
      createdAt: true,
      updatedAt: true,
    },
  }),
);
// Imported connections are third-party data the user brought in (name,
// company, position, connected-on only; H16) — part of their copy.
registerExportSection('contacts', (userId, db) =>
  db.rAContact.findMany({
    where: { ownerUserId: userId },
    take: ROW_CAP,
    select: { source: true, fullName: true, firstName: true, title: true, companyNameNormalized: true, linkedinUrl: true, connectedOn: true, createdAt: true },
  }),
);
// Messages the user drafted to people at a company (People, WP-54): the text
// and what they did with it. The model name and internal ids stay out.
registerExportSection('outreachDrafts', (userId, db) =>
  db.rAOutreachDraft.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: ROW_CAP,
    select: { channel: true, subject: true, body: true, jobId: true, trackerEntryId: true, copiedAt: true, markedSentAt: true, createdAt: true },
  }),
);
// 内推码 the user shared on GoApply (WP-54), with the review outcome they can
// see. Who reviewed it and how often it was reported are not the user's data.
registerExportSection('referralCodes', (userId, db) =>
  db.rACnReferralCode.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: ROW_CAP,
    select: { company: true, code: true, programme: true, expiresAt: true, note: true, status: true, rejectReason: true, createdAt: true, updatedAt: true },
  }),
);
// Invite a friend (WP-60): status and dates only. The other person's identity
// is their data, and the risk signals are not exported.
const REFERRAL_EXPORT_FIELDS = { status: true, createdAt: true, qualifiedAt: true, rewardedAt: true } as const;
registerExportSection('referrals', async (userId, db) => ({
  invited: await db.rAReferral.findMany({ where: { inviterUserId: userId }, orderBy: { createdAt: 'asc' }, take: ROW_CAP, select: REFERRAL_EXPORT_FIELDS }),
  invitedBy: await db.rAReferral.findUnique({ where: { inviteeUserId: userId }, select: REFERRAL_EXPORT_FIELDS }),
}));
registerExportSection('contactImports', (userId, db) =>
  db.rAContactImport.findMany({ where: { userId }, take: ROW_CAP, select: { kind: true, fileName: true, rowCount: true, importedCount: true, createdAt: true } }),
);
// Practice interviews: what was asked and said, and the report. No storage
// keys, room or dispatch ids, prompts, or costs.
registerExportSection('practiceInterviews', (userId, db) =>
  db.interviewSession.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: ROW_CAP,
    select: {
      role: true,
      interviewType: true,
      mode: true,
      language: true,
      plannedDurationMinutes: true,
      candidateName: true,
      resumeContext: true,
      jdText: true,
      questions: true,
      status: true,
      transcript: true,
      transcriptText: true,
      recordingDurationSec: true,
      overall: true,
      breakdown: true,
      strengths: true,
      gaps: true,
      summary: true,
      report: true,
      durationSec: true,
      startedAt: true,
      endedAt: true,
      createdAt: true,
    },
  }),
);
registerExportSection('productEvents', (userId, db) =>
  db.rAProductEvent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, take: ROW_CAP, select: { name: true, props: true, path: true, createdAt: true } }),
);
registerExportSection('personalInfoRequests', (userId, db) =>
  db.rAPersonalInfoRequest.findMany({ where: { userId }, select: { kind: true, status: true, dueAt: true, createdAt: true, closedAt: true } }),
);

/** Build the export document. A section that fails is reported, not silently dropped. */
export async function buildUserDataExport(userId: string, db: ExportDb = prisma, now: Date = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { exportedAt: now.toISOString(), format: 'roboapply.data-export.v1' };
  const failed: string[] = [];
  for (const [name, section] of sections) {
    try {
      out[name] = await section(userId, db);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length) out.sectionsUnavailable = failed;
  return out;
}

// ── Storage ────────────────────────────────────────────────────────────────

export interface StoredExportRef {
  provider: string;
  key: string;
}

export interface ExportStore {
  save(input: { userId: string; buffer: Buffer; fileName: string }): Promise<StoredExportRef | null>;
  read(ref: StoredExportRef): Promise<Buffer>;
  remove(ref: StoredExportRef): Promise<boolean>;
}

/** Default store: the private object storage the resume originals use, in its own keyspace. */
export const defaultExportStore: ExportStore = {
  async save({ userId, buffer, fileName }) {
    const { resumeOriginalFileStorageService: s } = await import('../../services/ResumeOriginalFileStorageService.js');
    const stored = await s.saveFile({ buffer, fileName, mimeType: 'application/json', size: buffer.length, userId, keyspace: 'data-exports' });
    return stored ? { provider: stored.provider, key: stored.key } : null;
  },
  async read(ref) {
    const { resumeOriginalFileStorageService: s } = await import('../../services/ResumeOriginalFileStorageService.js');
    const file = await s.readFile({ provider: ref.provider, key: ref.key, fileName: 'export.json', mimeType: 'application/json' });
    return file.buffer;
  },
  async remove(ref) {
    const { resumeOriginalFileStorageService: s } = await import('../../services/ResumeOriginalFileStorageService.js');
    return s.deleteFile({ provider: ref.provider, key: ref.key, fileName: 'export.json', mimeType: 'application/json' });
  },
};

export interface DataExportDeps {
  db?: ExportDb;
  store?: ExportStore;
  now?: () => Date;
  enqueue?: typeof enqueue;
  kick?: (kinds: string[]) => unknown;
}

// ── Request (route) ────────────────────────────────────────────────────────

/** Start an export. `kind` is the right the user invoked (a copy, or portability); it is stored as filed. */
export async function requestDataExport(
  userId: string,
  brand: BrandId,
  deps: DataExportDeps = {},
  kind: 'copy' | 'portability' = 'copy',
): Promise<ExportRequestResponse> {
  const request = await createPiRequest({ userId, brand, kind }, { db: deps.db, now: deps.now });
  const item = await (deps.enqueue ?? enqueue)(
    COMPLIANCE_WORK_KINDS.dataExport,
    { requestId: request.id },
    { brand, userId, dedupeKey: `compliance.export:${request.id}` },
  );
  (deps.kick ?? kickDrain)([COMPLIANCE_WORK_KINDS.dataExport]);
  return { exportId: item.id, requestId: request.id, status: 'queued' };
}

// ── Worker ─────────────────────────────────────────────────────────────────

export interface DataExportPayload {
  requestId: string;
}

export async function handleDataExport(item: Pick<LeasedWorkItem<unknown>, 'payload'>, deps: DataExportDeps = {}): Promise<void> {
  const db = deps.db ?? prisma;
  const store = deps.store ?? defaultExportStore;
  const now = (deps.now ?? (() => new Date()))();
  const payload = item.payload as Partial<DataExportPayload> | null;
  if (!payload?.requestId) throw new PermanentWorkError('compliance.export: missing requestId');
  const request = await db.rAPersonalInfoRequest.findUnique({ where: { id: payload.requestId } });
  if (!request || !request.userId || request.status === 'done' || request.status === 'rejected') return;

  await db.rAPersonalInfoRequest.update({ where: { id: request.id }, data: { status: 'in_progress' } });
  const doc = await buildUserDataExport(request.userId, db, now);
  const buffer = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
  const fileName = `data-export-${now.toISOString().slice(0, 10)}.json`;
  const ref = await store.save({ userId: request.userId, buffer, fileName });
  const detail = parseDetail(request.detail);
  if (!ref) {
    detail.handlingNotes = [...(detail.handlingNotes ?? []), { at: now.toISOString(), by: 'system', note: 'storage_unavailable' }];
    await db.rAPersonalInfoRequest.update({ where: { id: request.id }, data: { status: 'open', detail: detail as Prisma.InputJsonValue } });
    throw new PermanentWorkError('compliance.export: storage is not configured');
  }
  detail.export = { provider: ref.provider, key: ref.key, bytes: buffer.length, expiresAt: new Date(now.getTime() + DATA_EXPORT_TTL_DAYS * DAY_MS).toISOString() };
  await db.rAPersonalInfoRequest.update({
    where: { id: request.id },
    data: { status: 'done', closedAt: now, detail: detail as Prisma.InputJsonValue },
  });
  const email: EmailSendPayload = { template: DATA_EXPORT_READY_TEMPLATE, userId: request.userId, params: { days: DATA_EXPORT_TTL_DAYS } };
  await (deps.enqueue ?? enqueue)(EMAIL_SEND_KIND, email, {
    brand: request.brand as BrandId,
    userId: request.userId,
    dedupeKey: `compliance.export.email:${request.id}`,
  });
}

// ── Download (route) ───────────────────────────────────────────────────────

export async function readExportForOwner(
  userId: string,
  requestId: string,
  deps: DataExportDeps = {},
): Promise<{ buffer: Buffer; fileName: string }> {
  const db = deps.db ?? prisma;
  const store = deps.store ?? defaultExportStore;
  const now = (deps.now ?? (() => new Date()))();
  const request = await db.rAPersonalInfoRequest.findUnique({ where: { id: requestId } });
  if (!request || request.userId !== userId) throw new HttpError('not_found');
  const exp = parseDetail(request.detail).export;
  if (request.status !== 'done' || !exp) throw new HttpError('not_found');
  if (exp.purgedAt || Date.parse(exp.expiresAt) <= now.getTime()) {
    throw new HttpError('not_found', 'This export has expired. Request a new one.', { reason: COMPLIANCE_ERROR_CODES.exportExpired });
  }
  const buffer = await store.read({ provider: exp.provider, key: exp.key });
  return { buffer, fileName: `data-export-${(request.closedAt ?? request.createdAt).toISOString().slice(0, 10)}.json` };
}

// ── Sweep (cron) ───────────────────────────────────────────────────────────

/** Delete export files past their TTL; returns files removed. */
export async function sweepExpiredExports(deps: DataExportDeps & { brand: BrandId }): Promise<number> {
  const db = deps.db ?? prisma;
  const store = deps.store ?? defaultExportStore;
  const now = (deps.now ?? (() => new Date()))();
  const rows = await db.rAPersonalInfoRequest.findMany({
    // Window: past the TTL, within the last 30 days of expiries (a missed run is
    // caught next day; already-swept rows age out of the window).
    where: {
      brand: deps.brand,
      kind: { in: ['copy', 'portability'] },
      status: 'done',
      closedAt: {
        lt: new Date(now.getTime() - DATA_EXPORT_TTL_DAYS * DAY_MS),
        gte: new Date(now.getTime() - (DATA_EXPORT_TTL_DAYS + SWEEP_WINDOW_DAYS) * DAY_MS),
      },
    },
    select: { id: true, detail: true },
    take: 200,
  });
  let removed = 0;
  for (const row of rows) {
    const detail = parseDetail(row.detail);
    if (!detail.export || detail.export.purgedAt) continue;
    const ok = await store.remove({ provider: detail.export.provider, key: detail.export.key });
    if (!ok) continue;
    detail.export = { ...detail.export, purgedAt: now.toISOString() };
    await db.rAPersonalInfoRequest.update({ where: { id: row.id }, data: { detail: detail as Prisma.InputJsonValue } });
    removed += 1;
  }
  return removed;
}
