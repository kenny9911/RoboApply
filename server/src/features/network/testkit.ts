// server/src/features/network/testkit.ts — an in-memory NetworkStore and service
// builder for tests (WP-54). No vitest imports; never used in production.

import { BRANDS, type HiringContactsMode, type ProductBrand } from '../../platform/brand/registry.js';
import type { CreditService } from '../../platform/credits/index.js';
import { normalizeCompanyName } from '../jobs/normalize/index.js';
import type { OutreachWriterInput, OutreachWriterOutput } from './OutreachDraftAgent.js';
import { NetworkService, type NetworkDeps } from './service.js';
import { importKey, type ContactRow, type DraftRow, type NetworkJobRow, type NetworkStore } from './store.js';

export interface MemoryNetworkStore extends NetworkStore {
  contacts: Array<ContactRow & { consentBasis?: string | null }>;
  imports: Array<{ id: string; userId: string; fileName: string; rowCount: number; importedCount: number; createdAt: Date }>;
  drafts: DraftRow[];
  jobs: Map<string, NetworkJobRow>;
  tracker: Array<{ id: string; userId: string; jobId: string | null }>;
  resumes: Map<string, string>;
}

export function createMemoryNetworkStore(clock: () => Date = () => new Date()): MemoryNetworkStore {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const contacts: MemoryNetworkStore['contacts'] = [];
  const imports: MemoryNetworkStore['imports'] = [];
  const drafts: DraftRow[] = [];
  const jobs = new Map<string, NetworkJobRow>();
  const tracker: MemoryNetworkStore['tracker'] = [];
  const resumes = new Map<string, string>();
  const own = (c: ContactRow) => c.source === 'user_connections_import' || c.source === 'user_added';
  const consented = (c: ContactRow & { consentBasis?: string | null }) => Boolean(c.consentBasis);
  const strip = (c: ContactRow & { consentBasis?: string | null }): ContactRow => {
    const { consentBasis, ...rest } = c;
    return { ...rest, consented: Boolean(consentBasis) };
  };
  return {
    contacts,
    imports,
    drafts,
    jobs,
    tracker,
    resumes,
    async loadJob(jobId) {
      return jobs.get(jobId) ?? null;
    },
    async ownContactsAtCompany(userId, market, company, limit) {
      return contacts.filter((c) => c.ownerUserId === userId && c.market === market && c.companyNameNormalized === company && own(c)).slice(0, limit).map(strip);
    },
    async consentedRecruiter(market, bank, recruiterId) {
      const c = contacts.find(
        (x) =>
          x.market === market &&
          x.source === 'bank_recruiter' &&
          x.ownerUserId === null &&
          consented(x) &&
          (x.sourceRef ?? '').startsWith(`${bank}:${recruiterId}|optin:`),
      );
      return c ? strip(c) : null;
    },
    async countImported(userId) {
      return contacts.filter((c) => c.ownerUserId === userId && c.source === 'user_connections_import').length;
    },
    async importStats(userId, since) {
      const mine = imports.filter((i) => i.userId === userId);
      const last = mine.reduce<Date | null>((acc, i) => (!acc || i.createdAt > acc ? i.createdAt : acc), null);
      return { importsSince: mine.filter((i) => i.createdAt >= since).length, lastImportAt: last };
    },
    async importedKeys(userId) {
      return new Set(contacts.filter((c) => c.ownerUserId === userId && c.source === 'user_connections_import').map((c) => importKey(c.fullName, c.companyNameNormalized)));
    },
    async saveImport({ userId, fileName, rowCount, contacts: rows }) {
      const importId = id('imp');
      imports.push({ id: importId, userId, fileName, rowCount, importedCount: rows.length, createdAt: clock() });
      for (const r of rows) {
        contacts.push({
          id: id('ct'),
          market: r.market,
          ownerUserId: userId,
          source: 'user_connections_import',
          sourceRef: importId,
          consented: false,
          companyNameNormalized: r.companyNameNormalized,
          companyId: r.companyId ?? null,
          fullName: r.fullName,
          firstName: r.firstName,
          title: r.title,
          linkedinUrl: null,
          connectedOn: r.connectedOn,
          schoolsNormalized: [],
          pastCompaniesNormalized: [],
          createdAt: clock(),
        });
      }
      return importId;
    },
    async deleteImportedContacts(userId) {
      let n = 0;
      for (let i = contacts.length - 1; i >= 0; i--) {
        if (contacts[i]!.ownerUserId === userId && contacts[i]!.source === 'user_connections_import') {
          contacts.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },
    async listOwnContacts(userId, { market, companyNameNormalized, limit }) {
      return contacts
        .filter((c) => c.ownerUserId === userId && c.market === market && own(c) && (!companyNameNormalized || c.companyNameNormalized === companyNameNormalized))
        .slice(0, limit)
        .map(strip);
    },
    async createOwnContact(input) {
      const row: ContactRow = {
        id: id('ct'),
        market: input.market,
        ownerUserId: input.ownerUserId,
        source: input.source,
        sourceRef: input.sourceRef,
        consented: false,
        companyNameNormalized: input.companyNameNormalized,
        companyId: input.companyId ?? null,
        fullName: input.fullName,
        firstName: input.firstName,
        title: input.title,
        linkedinUrl: input.linkedinUrl,
        connectedOn: input.connectedOn,
        schoolsNormalized: [],
        pastCompaniesNormalized: [],
        createdAt: clock(),
      };
      contacts.push(row);
      return { ...row };
    },
    async findVisibleContact(userId, market, cid) {
      const c = contacts.find((x) => x.id === cid && x.market === market);
      if (!c) return null;
      if (c.ownerUserId === userId && own(c)) return strip(c);
      if (c.ownerUserId === null && c.source === 'bank_recruiter' && consented(c)) return strip(c);
      return null;
    },
    async deleteOwnContact(userId, cid) {
      const i = contacts.findIndex((c) => c.id === cid && c.ownerUserId === userId && own(c));
      if (i < 0) return false;
      contacts.splice(i, 1);
      return true;
    },
    async trackerEntry(userId, tid) {
      const e = tracker.find((t) => t.id === tid && t.userId === userId);
      return e ? { id: e.id, jobId: e.jobId } : null;
    },
    async trackerEntryForJob(userId, jobId) {
      const e = tracker.find((t) => t.userId === userId && t.jobId === jobId);
      return e ? { id: e.id } : null;
    },
    async createDraft(input) {
      const row: DraftRow = { ...input, id: id('dr'), copiedAt: null, markedSentAt: null, createdAt: clock() };
      drafts.push(row);
      return { ...row };
    },
    async findDraft(userId, did) {
      const d = drafts.find((x) => x.id === did && x.userId === userId);
      return d ? { ...d } : null;
    },
    async updateDraft(did, data) {
      const d = drafts.find((x) => x.id === did);
      if (!d) throw new Error('not found');
      Object.assign(d, data);
      return { ...d };
    },
    async listDrafts(userId, filter, limit) {
      return drafts
        .filter((d) => d.userId === userId && (!filter.jobId || d.jobId === filter.jobId) && (!filter.trackerEntryId || d.trackerEntryId === filter.trackerEntryId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((d) => ({ ...d }));
    },
    async recentDraft(userId, jobId, channel, since) {
      return drafts.filter((d) => d.userId === userId && d.jobId === jobId && d.channel === channel && d.createdAt >= since).pop() ?? null;
    },
    async primaryResumeMarkdown(userId) {
      return resumes.get(userId) ?? null;
    },
  };
}

export function jobRow(over: Partial<NetworkJobRow> = {}): NetworkJobRow {
  return {
    id: 'job_1',
    title: 'Backend Engineer',
    companyName: 'Acme Analytics, Inc.',
    companyId: null,
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    externalId: 'bank_job_1',
    sourceBoard: 'robohire',
    fromRecruiterBank: true,
    descriptionPlain: 'We build payment rails in Go and Postgres. Contact jobs@acme.test.',
    ...over,
  };
}

export interface NetworkFixture {
  service: NetworkService;
  store: MemoryNetworkStore;
  write: (input: OutreachWriterInput) => Promise<OutreachWriterOutput>;
  calls: OutreachWriterInput[];
  state: { mode: HiringContactsMode; ai: boolean; brand: ProductBrand; now: Date };
  /** `<bank>:<bank Job.id>` → the recruiter who posted it (bank Job.userId). */
  posters: Map<string, string>;
}

export function createNetworkFixture(
  options: {
    credits: Pick<CreditService, 'withCredit'>;
    write?: (input: OutreachWriterInput) => Promise<OutreachWriterOutput>;
    mode?: HiringContactsMode;
    ai?: boolean;
    brand?: ProductBrand;
    now?: Date;
    overrides?: Partial<NetworkDeps>;
  },
): NetworkFixture {
  const state = {
    mode: options.mode ?? 'on',
    ai: options.ai ?? true,
    brand: options.brand ?? BRANDS.roboapply,
    now: options.now ?? new Date('2026-10-10T12:00:00Z'),
  };
  const store = createMemoryNetworkStore(() => state.now);
  // jobRow() is bank job `bank_job_1`, posted by recruiter u_9.
  const posters = new Map<string, string>([['robohire:bank_job_1', 'u_9']]);
  const calls: OutreachWriterInput[] = [];
  const write =
    options.write ??
    (async () => ({ subject: 'Backend Engineer at Acme', body: 'Hi [[NAME]], I build payment services in Go and saw the Backend Engineer role. Would you be open to a short chat?' }));
  const service = new NetworkService({
    store,
    credits: options.credits,
    brand: () => state.brand,
    mode: async () => state.mode,
    aiAvailable: async () => state.ai,
    postingVisible: () => true,
    peopleContext: async () => ({ pastCompanies: ['Globex'], schools: ['State University'] }),
    peopleSearchLinks: (job, ctx) => [
      { kind: 'role', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(job.companyName)}`, params: { company: job.companyName, title: job.title } },
      { kind: 'past_companies', url: null, params: { company: job.companyName, companies: ctx.pastCompanies.join(', ') } },
    ],
    normalizeCompany: (n) => normalizeCompanyName(n),
    jobPoster: async (bank, externalId) => posters.get(`${bank}:${externalId}`) ?? null,
    profileText: async () => 'Target roles: backend engineer',
    resumeForPrompt: (md) => md.replace(/Sam Lee/g, '[name]'),
    redact: (t) => t.replace(/[^\s@]+@[^\s@]+/g, '[email]'),
    write: async (input) => {
      calls.push(input);
      return write(input);
    },
    modelId: () => 'openrouter/test/model',
    now: () => state.now,
    ...options.overrides,
  });
  return { service, store, write, calls, state, posters };
}
