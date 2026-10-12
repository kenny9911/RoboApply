// server/src/features/network/service.ts — People at {company} (WP-54; ARCH §3.7, PRODUCT §5.11).
//
//   connectionsForJob   deep links (always) + the user's own contacts at the company + the job's
//                       hiring contact (mode `on`): the bank recruiter who POSTED this recruiter-bank
//                       job (bank Job.userId for RAJob.externalId), only when that recruiter opted
//                       in. Never "any opted-in recruiter at the same company". + drafts for the job
//   importConnections   the user's own LinkedIn Connections.csv: name, company, position and
//                       connected-on only (the email column is discarded by the parser); 3/day
//   deleteImported      "Delete all imported connections" (works in every mode)
//   contacts            the user's own contacts: list / add / delete
//   lookupEmail         501 provider_not_configured (F-NET-05/07 deferred: no email finder)
//   drafts              AI drafts (credit `outreach`): LinkedIn note within 300 characters,
//                       email, referral ask, follow-up, WeChat 内推请求; edit, copied, "I sent it".
//                       We never send anything: there is no send path.
//
// AI gate (TASK_PLAN.md §2.2): `aiAvailable` = aiAllowed(user) AND `ai.text`.
// When false, creating a draft answers 503 ai_unavailable before any credit or
// LLM call. Reading, editing and copying drafts keep working.

import { HttpError } from '../../platform/http.js';
import { CreditReplayError, type CreditService } from '../../platform/credits/index.js';
import type { HiringContactsMode, ProductBrand } from '../../platform/brand/registry.js';
import {
  CONTACTS_PAGE_SIZE,
  LINKEDIN_IMPORT_LIMIT_PER_DAY,
  NETWORK_ERROR_CODES as E,
  OUTREACH_CHANNELS_BY_MARKET,
  type ConnectionsForJobResponse,
  type ConnectionsImportResponse,
  type ConnectionsImportStatus,
  type ContactView,
  type DeleteConnectionsResponse,
  type ListContactsResponse,
  type ListOutreachDraftsResponse,
  type OutreachChannel,
  type OutreachDraftView,
} from './contract.js';
import { ConnectionsCsvError, parseLinkedInConnections } from './connectionsCsv.js';
import { finalizeDraft, greetingName, maxCharsFor } from './draftText.js';
import { importKey, type NewOwnContact, type ContactRow, type DraftRow, type NetworkJobRow, type NetworkStore } from './store.js';
import type { OutreachWriterInput, OutreachWriterOutput } from './OutreachDraftAgent.js';
import { recruiterIdOf, type BankId } from './contactsSync.js';

export interface PeopleLink {
  kind: 'role' | 'past_companies' | 'schools';
  url: string | null;
  params: Record<string, string | undefined>;
}

export interface NetworkDeps {
  store: NetworkStore;
  credits: Pick<CreditService, 'withCredit'>;
  brand: () => ProductBrand;
  mode: (userId: string) => Promise<HiringContactsMode>;
  /** aiAllowed(user) AND isEnabled('ai.text'). */
  aiAvailable: (userId: string) => Promise<boolean>;
  /** A posting the viewer may see under the GoApply recruitment-info mode (cnPostingVisible). */
  postingVisible: (job: NetworkJobRow, userId: string) => boolean;
  peopleContext: (userId: string) => Promise<{ pastCompanies: string[]; schools: string[] }>;
  peopleSearchLinks: (job: { title: string; companyName: string }, ctx: { pastCompanies: string[]; schools: string[] }, market: string) => PeopleLink[];
  normalizeCompany: (name: string) => string;
  /**
   * The recruiter who posted a bank job: bank `Job.userId` for `Job.id = externalId`,
   * read-only through bankClients. null when the bank is off/unreachable or the job is gone.
   */
  jobPoster: (bank: BankId, externalId: string) => Promise<string | null>;
  /** profileSnapshotForLlm(userId).text; '' when unavailable. */
  profileText: (userId: string) => Promise<string>;
  /** Resume text for a prompt: resumeForLlm + PII redaction. */
  resumeForPrompt: (markdown: string) => string;
  /** Free text for a prompt (the job post): PII redaction. */
  redact: (text: string) => string;
  write: (input: OutreachWriterInput) => Promise<OutreachWriterOutput>;
  modelId: () => string | null;
  /** GoApply: record the AI-content label for a generated draft (soft). */
  logAiLabel?: (input: { userId: string; draftId: string; model: string | null; brand: ProductBrand }) => Promise<void>;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_LIMIT = 25;
const DRAFT_LIST_LIMIT = 30;
/** A replayed Idempotency-Key within this window returns the draft the first attempt wrote. */
const REPLAY_WINDOW_MS = 15 * 60 * 1000;

const SOURCE_NAMES: Record<string, string> = { intl: 'RoboHire', cn: 'GoHire' };

function notFound(reason: string, message = 'Not found.'): HttpError {
  return new HttpError('not_found', message, { reason });
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** `<bank>:<recruiterId>|optin:<recordId>@<ISO>` → the opt-in time (contactsSync.ts writes it). */
export function optedInAtOf(sourceRef: string | null): string | null {
  const m = /\|optin:[^@|]+@([0-9T:.\-Z+]+)$/.exec(sourceRef ?? '');
  if (!m) return null;
  const d = new Date(m[1]!);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The recruiter bank a recruiter-bank RAJob came from (sourceBoard 'robohire' | 'gohire'). */
export function bankOfJob(job: Pick<NetworkJobRow, 'sourceBoard' | 'fromRecruiterBank'>): BankId | null {
  if (!job.fromRecruiterBank) return null;
  const board = job.sourceBoard.replace(/^bank_/, '');
  return board === 'robohire' || board === 'gohire' ? board : null;
}

/** A bank recruiter is shown only with BOTH a consent basis and an opt-in record reference. */
export function hasOptInRecord(row: Pick<ContactRow, 'source' | 'consented' | 'sourceRef' | 'ownerUserId'>): boolean {
  return row.source === 'bank_recruiter' && row.ownerUserId === null && row.consented && optedInAtOf(row.sourceRef) !== null;
}

export class NetworkService {
  constructor(private readonly deps: NetworkDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private market(): 'intl' | 'cn' {
    return this.deps.brand().market === 'cn' ? 'cn' : 'intl';
  }

  // ── Views ──────────────────────────────────────────────────────────────

  /**
   * `companyName` is the job's company on a job page; elsewhere pass nothing
   * and the name the source wrote (`RAContact.companyName`, SR-54-2) is shown,
   * falling back to the normalized name on rows from before that column.
   */
  contactView(row: ContactRow, companyName: string = displayCompanyName(row)): ContactView {
    const market = row.market === 'cn' ? 'cn' : 'intl';
    const sourceName = row.source === 'bank_recruiter' ? SOURCE_NAMES[market]! : null;
    const sourceLabel =
      row.source === 'bank_recruiter'
        ? `${sourceName} recruiter who chose to be contactable`
        : row.source === 'user_connections_import'
          ? 'Your LinkedIn connections'
          : 'Added by you';
    return {
      id: row.id,
      source: row.source as ContactView['source'],
      sourceLabel,
      sourceName,
      fullName: row.fullName,
      title: row.title,
      companyName,
      linkedinUrl: row.linkedinUrl,
      connectedOn: iso(row.connectedOn),
      optedInAt: row.source === 'bank_recruiter' ? optedInAtOf(row.sourceRef) : null,
    };
  }

  draftView(row: DraftRow): OutreachDraftView {
    return {
      id: row.id,
      channel: row.channel as OutreachChannel,
      contactId: row.contactId,
      jobId: row.jobId,
      trackerEntryId: row.trackerEntryId,
      subject: row.subject,
      body: row.body,
      copiedAt: iso(row.copiedAt),
      markedSentAt: iso(row.markedSentAt),
      aiWritten: true,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ── Job access ─────────────────────────────────────────────────────────

  /** The job as the user may see it (market, visibility, GoApply mode); 404 otherwise (no existence leak). */
  async visibleJob(userId: string, jobId: string): Promise<NetworkJobRow> {
    const row = await this.deps.store.loadJob(jobId);
    if (!row || row.market !== this.market()) throw notFound(E.jobNotFound);
    const visible = row.visibility === 'public' || (row.visibility === 'private' && row.ownerUserId === userId);
    if (!visible || !this.deps.postingVisible(row, userId)) throw notFound(E.jobNotFound);
    return row;
  }

  // ── Connections for a job ─────────────────────────────────────────────

  async connectionsForJob(userId: string, jobId: string): Promise<ConnectionsForJobResponse> {
    const job = await this.visibleJob(userId, jobId);
    const market = this.market();
    const [mode, ctx, aiAvailable, drafts] = await Promise.all([
      this.deps.mode(userId),
      this.deps.peopleContext(userId).catch(() => ({ pastCompanies: [], schools: [] })),
      this.deps.aiAvailable(userId),
      this.deps.store.listDrafts(userId, { jobId }, DRAFT_LIST_LIMIT),
    ]);
    const searchLinks =
      mode === 'off'
        ? []
        : this.deps
            .peopleSearchLinks(job, ctx, market)
            .filter((l): l is PeopleLink & { url: string } => typeof l.url === 'string' && l.url.length > 0)
            .map((l) => ({ label: searchLabel(l), url: l.url }));
    const base: ConnectionsForJobResponse = {
      fromYourCompanies: [],
      fromYourSchools: [],
      recruiters: [],
      searchLinks,
      mode,
      importedCount: 0,
      aiAvailable,
      drafts: drafts.map((d) => this.draftView(d)),
    };
    if (mode !== 'on') return base;

    const company = this.deps.normalizeCompany(job.companyName);
    const [own, recruiters, importedCount] = await Promise.all([
      company ? this.deps.store.ownContactsAtCompany(userId, market, company, BUCKET_LIMIT * 2) : Promise.resolve([]),
      this.hiringContact(job, market),
      this.deps.store.countImported(userId),
    ]);
    const schools = new Set(ctx.schools.map((s) => this.deps.normalizeCompany(s)).filter(Boolean));
    const pastCompanies = new Set(ctx.pastCompanies.map((c) => this.deps.normalizeCompany(c)).filter(Boolean));
    const fromSchools: ContactRow[] = [];
    const fromCompanies: ContactRow[] = [];
    for (const row of own) {
      if (row.ownerUserId !== userId) continue; // defence in depth: never another user's private rows
      if (row.schoolsNormalized.some((s) => schools.has(s))) fromSchools.push(row);
      else fromCompanies.push(row);
    }
    // People who also worked at one of the user's past companies first.
    fromCompanies.sort((a, b) => Number(b.pastCompaniesNormalized.some((c) => pastCompanies.has(c))) - Number(a.pastCompaniesNormalized.some((c) => pastCompanies.has(c))));
    return {
      ...base,
      importedCount,
      fromYourCompanies: fromCompanies.slice(0, BUCKET_LIMIT).map((r) => this.contactView(r, job.companyName)),
      fromYourSchools: fromSchools.slice(0, BUCKET_LIMIT).map((r) => this.contactView(r, job.companyName)),
      // H15: a recruiter without an opt-in record is never returned.
      recruiters: recruiters.map((r) => this.contactView(r, job.companyName)),
    };
  }

  /**
   * The job's hiring contact (PRODUCT F-NET-02): the bank recruiter who posted
   * this recruiter-bank job, and only when that recruiter has an opt-in record.
   * A colleague at the same company, or anyone whose profile company merely
   * matches, is never returned. Any failure reading the bank → no contact.
   */
  private async hiringContact(job: NetworkJobRow, market: string): Promise<ContactRow[]> {
    const bank = bankOfJob(job);
    if (!bank || !job.externalId) return [];
    const posterId = await this.deps.jobPoster(bank, job.externalId).catch(() => null);
    if (!posterId) return [];
    const row = await this.deps.store.consentedRecruiter(market, bank, posterId);
    if (!row || !hasOptInRecord(row) || recruiterIdOf(bank, row.sourceRef) !== posterId) return [];
    return [row];
  }

  // ── Connections import ────────────────────────────────────────────────

  async importStatus(userId: string): Promise<ConnectionsImportStatus> {
    const since = new Date(this.now().getTime() - DAY_MS);
    const [importedCount, stats] = await Promise.all([this.deps.store.countImported(userId), this.deps.store.importStats(userId, since)]);
    return { importedCount, lastImportAt: iso(stats.lastImportAt), importsToday: stats.importsSince, limitPerDay: LINKEDIN_IMPORT_LIMIT_PER_DAY };
  }

  async importConnections(userId: string, file: { text: string; fileName: string }): Promise<ConnectionsImportResponse> {
    const now = this.now();
    const stats = await this.deps.store.importStats(userId, new Date(now.getTime() - DAY_MS));
    if (stats.importsSince >= LINKEDIN_IMPORT_LIMIT_PER_DAY) {
      throw new HttpError('rate_limited', `You can import your connections ${LINKEDIN_IMPORT_LIMIT_PER_DAY} times a day.`, {
        reason: E.importLimit,
        retryAfterSec: 60 * 60,
        limit: LINKEDIN_IMPORT_LIMIT_PER_DAY,
      });
    }
    let parsed;
    try {
      parsed = parseLinkedInConnections(file.text);
    } catch (err) {
      if (err instanceof ConnectionsCsvError) throw new HttpError('invalid_request', err.message, { reason: E.badCsv });
      throw err;
    }
    const market = this.market();
    const existing = await this.deps.store.importedKeys(userId);
    const fresh: Array<Omit<NewOwnContact, 'sourceRef' | 'source'>> = [];
    for (const c of parsed.connections) {
      const companyNameNormalized = this.deps.normalizeCompany(c.company);
      if (!companyNameNormalized) continue;
      const key = importKey(c.fullName, companyNameNormalized);
      if (existing.has(key)) continue;
      existing.add(key);
      fresh.push({
        market,
        ownerUserId: userId,
        companyNameNormalized,
        companyName: cleanCompanyName(c.company),
        fullName: c.fullName,
        firstName: c.firstName || null,
        title: c.position,
        linkedinUrl: null,
        connectedOn: c.connectedOn,
      });
    }
    const fileName = (file.fileName || 'Connections.csv').replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120);
    await this.deps.store.saveImport({ userId, fileName, rowCount: parsed.rowCount, contacts: fresh });
    return { rowCount: parsed.rowCount, importedCount: fresh.length };
  }

  async deleteImported(userId: string): Promise<DeleteConnectionsResponse> {
    return { deleted: await this.deps.store.deleteImportedContacts(userId) };
  }

  // ── Contacts ──────────────────────────────────────────────────────────

  async listContacts(userId: string, query: { company?: string; cursor?: string }): Promise<ListContactsResponse> {
    const company = query.company ? this.deps.normalizeCompany(query.company) : undefined;
    const rows = await this.deps.store.listOwnContacts(userId, {
      market: this.market(),
      companyNameNormalized: company || undefined,
      cursor: query.cursor,
      limit: CONTACTS_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, CONTACTS_PAGE_SIZE);
    return {
      items: page.map((r) => this.contactView(r)),
      cursor: rows.length > CONTACTS_PAGE_SIZE ? page[page.length - 1]!.id : null,
    };
  }

  async createContact(userId: string, body: { fullName: string; companyName: string; title?: string; linkedinUrl?: string }): Promise<ContactView> {
    const companyNameNormalized = this.deps.normalizeCompany(body.companyName);
    if (!companyNameNormalized) throw new HttpError('invalid_request', 'Add the company name.', { reason: 'company_required' });
    const linkedinUrl = body.linkedinUrl && /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\//i.test(body.linkedinUrl) ? body.linkedinUrl : null;
    const row = await this.deps.store.createOwnContact({
      market: this.market(),
      ownerUserId: userId,
      source: 'user_added',
      sourceRef: null,
      companyNameNormalized,
      companyName: cleanCompanyName(body.companyName),
      fullName: body.fullName,
      firstName: body.fullName.split(/\s+/)[0] ?? null,
      title: body.title?.trim() || null,
      linkedinUrl,
      connectedOn: null,
    });
    return this.contactView(row);
  }

  async deleteContact(userId: string, id: string): Promise<{ deleted: true }> {
    if (!(await this.deps.store.deleteOwnContact(userId, id))) throw notFound(E.contactNotFound);
    return { deleted: true };
  }

  /** F-NET-05/07 are deferred (no licensed people-data provider): there is no email finder. */
  async lookupEmail(): Promise<never> {
    throw new HttpError('provider_not_configured', 'Email lookup is not available.', { reason: 'contact_email_provider_not_configured' });
  }

  // ── Outreach drafts ───────────────────────────────────────────────────

  async listDrafts(userId: string, filter: { jobId?: string; trackerEntryId?: string }): Promise<ListOutreachDraftsResponse> {
    const rows = await this.deps.store.listDrafts(userId, filter, DRAFT_LIST_LIMIT);
    return { items: rows.map((r) => this.draftView(r)) };
  }

  async createDraft(
    userId: string,
    body: { contactId?: string; jobId: string; channel: OutreachChannel; trackerEntryId?: string; locale?: string },
    options: { idempotencyKey?: string | null; requestLocale?: string | null } = {},
  ): Promise<OutreachDraftView> {
    const market = this.market();
    if (!OUTREACH_CHANNELS_BY_MARKET[market].includes(body.channel)) {
      throw new HttpError('invalid_request', 'This kind of message is not available here.', { reason: E.channelNotAvailable });
    }
    // AI gate first: no credit, no model call when the user's AI is off.
    if (!(await this.deps.aiAvailable(userId))) throw new HttpError('ai_unavailable');

    const job = await this.visibleJob(userId, body.jobId);
    let contact: ContactRow | null = null;
    if (body.contactId) {
      // Contacts are served only in mode `on`; a recruiter needs an opt-in record.
      const mode = await this.deps.mode(userId);
      contact = mode === 'on' ? await this.deps.store.findVisibleContact(userId, market, body.contactId) : null;
      if (contact && contact.source === 'bank_recruiter' && !hasOptInRecord(contact)) contact = null;
      if (!contact) throw notFound(E.contactNotFound);
    }
    let trackerEntryId: string | null = null;
    if (body.trackerEntryId) {
      const entry = await this.deps.store.trackerEntry(userId, body.trackerEntryId);
      if (!entry || (entry.jobId !== null && entry.jobId !== job.id)) throw notFound(E.trackerEntryNotFound);
      trackerEntryId = entry.id;
    } else {
      // Drafts are saved on the job's tracker entry when there is one.
      trackerEntryId = (await this.deps.store.trackerEntryForJob(userId, job.id))?.id ?? null;
    }

    const idempotencyKey = options.idempotencyKey ?? `outreach:${job.id}:${body.channel}:${this.now().getTime()}`;
    try {
      return await this.deps.credits.withCredit(
        { userId, bucket: 'outreach', idempotencyKey, refType: 'outreach_draft', refId: job.id, brand: this.deps.brand().id },
        async () => {
          const [profileText, resume] = await Promise.all([
            this.deps.profileText(userId).catch(() => ''),
            this.deps.store.primaryResumeMarkdown(userId).catch(() => null),
          ]);
          const locale = body.locale ?? options.requestLocale ?? this.deps.brand().defaultLocale ?? 'en';
          const raw = await this.deps.write({
            channel: body.channel,
            locale,
            market,
            job: { title: job.title, company: job.companyName, text: this.deps.redact(job.descriptionPlain ?? '') },
            resumeText: resume ? this.deps.resumeForPrompt(resume) : '',
            profileText,
            recipient: {
              kind: !contact ? 'none' : contact.source === 'bank_recruiter' ? 'recruiter' : contact.source === 'user_connections_import' ? 'connection' : 'added',
              title: contact?.title ?? null,
            },
            maxChars: maxCharsFor(body.channel),
          });
          const draft = finalizeDraft(raw, body.channel, greetingName(contact));
          if (!draft.body.trim()) {
            throw new HttpError('internal_error', 'The draft came back empty. Try again.', { reason: E.draftEmpty });
          }
          const model = this.deps.modelId();
          const row = await this.deps.store.createDraft({
            userId,
            contactId: contact?.id ?? null,
            jobId: job.id,
            trackerEntryId,
            channel: body.channel,
            subject: draft.subject,
            body: draft.body,
            model,
          });
          if (market === 'cn' && this.deps.logAiLabel) {
            await this.deps.logAiLabel({ userId, draftId: row.id, model, brand: this.deps.brand() }).catch(() => undefined);
          }
          return this.draftView(row);
        },
      );
    } catch (err) {
      if (err instanceof CreditReplayError) {
        // A retried request: hand back what the first attempt wrote, never charge twice.
        const prior = await this.deps.store.recentDraft(userId, job.id, body.channel, new Date(this.now().getTime() - REPLAY_WINDOW_MS));
        if (prior) return this.draftView(prior);
        throw new HttpError('conflict', 'This request is still running.', { reason: err.code });
      }
      throw err;
    }
  }

  private async ownDraft(userId: string, id: string): Promise<DraftRow> {
    const row = await this.deps.store.findDraft(userId, id);
    if (!row) throw notFound(E.draftNotFound);
    return row;
  }

  async patchDraft(userId: string, id: string, body: { subject?: string | null; body?: string }): Promise<OutreachDraftView> {
    const row = await this.ownDraft(userId, id);
    const data: { subject?: string | null; body?: string } = {};
    if (body.subject !== undefined) data.subject = body.subject?.trim() ? body.subject.trim() : null;
    if (body.body !== undefined) {
      const max = maxCharsFor(row.channel as OutreachChannel);
      if (Array.from(body.body).length > max) {
        throw new HttpError('invalid_request', `Keep it within ${max} characters.`, { reason: 'outreach_draft_too_long', max });
      }
      data.body = body.body;
    }
    if (!Object.keys(data).length) return this.draftView(row);
    return this.draftView(await this.deps.store.updateDraft(row.id, data));
  }

  /** The user copied the draft (or opened it in their mail app). */
  async markCopied(userId: string, id: string): Promise<OutreachDraftView> {
    const row = await this.ownDraft(userId, id);
    return this.draftView(row.copiedAt ? row : await this.deps.store.updateDraft(row.id, { copiedAt: this.now() }));
  }

  /** The user says they sent it themselves. */
  async markSent(userId: string, id: string): Promise<OutreachDraftView> {
    const row = await this.ownDraft(userId, id);
    return this.draftView(row.markedSentAt ? row : await this.deps.store.updateDraft(row.id, { markedSentAt: this.now() }));
  }
}

/** A company name as written, trimmed to the column's display length; null when empty. */
export function cleanCompanyName(name: string | null | undefined): string | null {
  const s = (name ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 160) : null;
}

/** The name to show for a contact's company outside a job page. */
export function displayCompanyName(row: Pick<ContactRow, 'companyName' | 'companyNameNormalized'>): string {
  return row.companyName?.trim() || row.companyNameNormalized;
}

function searchLabel(l: PeopleLink): string {
  const company = l.params.company ?? '';
  if (l.kind === 'role') return `People in this role at ${company}`;
  if (l.kind === 'past_companies') return `People at ${company} who worked at ${l.params.companies ?? 'your past companies'}`;
  return `Alumni of ${l.params.schools ?? 'your schools'} at ${company}`;
}
