// server/src/features/feed/testkit.ts — fixtures and an in-memory FeedRepo for feed tests (WP-32).
//
// No vitest imports: the file compiles with the server. The fake repo honours
// the parts of the SQL a service test depends on (posted-date windows, the
// (postedAt, id) keyset, firstSeenAt, ids, LIMIT, hidden state, market;
// ordering is newest first, then id descending, like the SQL); predicate SQL is covered by
// sql.test.ts snapshots instead.

import type { Prisma } from '../../generated/prisma/client.js';
import type { AffinityState } from './affinity.js';
import type { ActionJob, FeedRepo, FeedSessionRecord, InteractionWrite } from './repo.js';
import type { FeedJobRow } from './types.js';

export function feedRow(over: Partial<FeedJobRow> & { id: string }): FeedJobRow {
  return {
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    title: 'Backend Engineer',
    titleNormalized: 'backend engineer',
    companyName: `Company ${over.id}`,
    companyNameNormalized: `company ${over.id}`,
    companyId: null,
    companyLogoUrl: null,
    taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
    primaryTaxonomyId: 'backend_engineer',
    seniority: 'mid',
    roleType: 'ic',
    minYears: null,
    maxYears: null,
    educationLevel: null,
    skills: ['python', 'sql'],
    skillsDetail: null,
    workModel: 'remote',
    remoteScope: 'US',
    location: 'Remote, US',
    locationCity: null,
    locationCountry: 'US',
    geoLat: null,
    geoLng: null,
    employmentType: 'full_time',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryAnnualMin: null,
    salaryAnnualMax: null,
    salaryDisclosed: false,
    salaryText: null,
    salaryMonths: null,
    sponsorship: null,
    sponsorshipEvidence: null,
    citizenshipRequired: null,
    clearanceRequired: null,
    employerTags: [],
    marketTags: null,
    postedAt: new Date('2026-10-09T12:00:00Z'),
    postedAtEstimated: false,
    firstSeenAt: new Date('2026-10-09T12:00:00Z'),
    lastSeenAt: new Date('2026-10-10T06:00:00Z'),
    expiresAt: null,
    sourceBoard: 'activejobs',
    sourceName: 'Active Jobs DB',
    originalSourceName: null,
    atsType: 'greenhouse',
    isAgency: null,
    fromRecruiterBank: false,
    employerVerified: false,
    sourcePriority: 10,
    archivedAt: null,
    hasBenefits: false,
    descriptionLength: 1200,
    companyIndustries: [],
    companySizeBand: null,
    companyFacts: {},
    companyDisplayName: null,
    companyLogo: null,
    ...over,
  };
}

interface SqlLike {
  text: string;
  values: unknown[];
}

function valueAfter(sql: SqlLike, pattern: RegExp): unknown {
  const m = sql.text.match(pattern);
  return m ? sql.values[Number(m[1]) - 1] : undefined;
}

export class FakeFeedRepo implements FeedRepo {
  rows: FeedJobRow[] = [];
  hidden = new Map<string, { at: Date; reason: string }>();
  sessions = new Map<string, FeedSessionRecord>();
  interactions: InteractionWrite[] = [];
  impressions: Array<{ userId: string; jobIds: string[] }> = [];
  ratings: Array<{ userId: string; dayKey: string; score: number; reasons: string[] }> = [];
  affinity = new Map<string, AffinityState>();
  visits = new Map<string, Date>();
  closed: string[] = [];
  ai = new Map<string, { score: number; tier: string | null }>();
  tracker = new Map<string, string>();
  skills: string[] = [];
  goal: string | null = null;
  /** Count statements: return this (or a function of the statement). */
  countResponder: (sql: SqlLike) => number = () => 0;
  categoryCounts: Array<{ taxonomyId: string; count: number }> = [];
  queries: SqlLike[] = [];
  private seq = 0;

  private visible(userId: string | null, market: string | null) {
    return (r: FeedJobRow) =>
      (!market || r.market === market) && (r.visibility === 'public' || r.ownerUserId === userId) && !(userId && this.hidden.has(`${userId}:${r.id}`));
  }

  async queryRows(sql: Prisma.Sql) {
    const s = { text: sql.text, values: sql.values };
    this.queries.push(s);
    const market = valueAfter(s, /j\."market" = \$(\d+)/) as string | null;
    const user = (valueAfter(s, /s\."userId" = \$(\d+)/) as string | undefined) ?? null;
    let rows = this.rows.filter(this.visible(user, market ?? null));
    const ids = valueAfter(s, /j\."id" = ANY\(\$(\d+)/) as string[] | undefined;
    if (ids) return rows.filter((r) => ids.includes(r.id));
    const from = valueAfter(s, /j\."postedAt" >= \$(\d+)::timestamp\(3\)\s+(?:AND|ORDER)/) as Date | undefined;
    const to = valueAfter(s, /j\."postedAt" < \$(\d+)/) as Date | undefined;
    const keyTo = valueAfter(s, /\(j\."postedAt", j\."id"\) < \(\$(\d+)/) as Date | undefined;
    const keyId = valueAfter(s, /\(j\."postedAt", j\."id"\) < \(\$\d+::timestamp\(3\), \$(\d+)\)/) as string | undefined;
    const seen = valueAfter(s, /j\."firstSeenAt" > \$(\d+)/) as Date | undefined;
    if (from) rows = rows.filter((r) => r.postedAt && r.postedAt >= from);
    if (to) rows = rows.filter((r) => r.postedAt && r.postedAt < to);
    if (keyTo && keyId) {
      rows = rows.filter((r) => r.postedAt && (r.postedAt.getTime() < keyTo.getTime() || (r.postedAt.getTime() === keyTo.getTime() && r.id < keyId)));
    }
    if (seen) rows = rows.filter((r) => r.firstSeenAt && r.firstSeenAt > seen);
    rows = [...rows].sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0) || (a.id < b.id ? 1 : -1));
    const limit = valueAfter(s, /LIMIT \$(\d+)\s*$/) as number | undefined;
    return limit ? rows.slice(0, limit) : rows;
  }

  async queryCount(sql: Prisma.Sql) {
    const s = { text: sql.text, values: sql.values };
    this.queries.push(s);
    return this.countResponder(s);
  }

  async queryCategoryCounts(sql: Prisma.Sql) {
    this.queries.push({ text: sql.text, values: sql.values });
    return this.categoryCounts;
  }

  async aiScores(_userId: string, jobIds: string[], resume: { id: string } | null) {
    const out = new Map<string, { score: number; tier: string | null }>();
    if (!resume) return out;
    for (const id of jobIds) if (this.ai.has(id)) out.set(id, this.ai.get(id)!);
    return out;
  }

  async trackerStates(_userId: string, jobIds: string[]) {
    return new Map([...this.tracker].filter(([id]) => jobIds.includes(id)));
  }

  async createSession(data: Omit<FeedSessionRecord, 'id' | 'createdAt'>) {
    const rec: FeedSessionRecord = { ...data, id: `sess${++this.seq}`, createdAt: new Date(data.expiresAt.getTime() - 30 * 60_000) };
    this.sessions.set(rec.id, rec);
    return rec;
  }

  async getSession(id: string, userId: string) {
    const s = this.sessions.get(id);
    return s && s.userId === userId ? { ...s } : null;
  }

  async updateSession(id: string, data: Partial<Pick<FeedSessionRecord, 'jobIds' | 'ranks' | 'totalEstimate' | 'windowEndsAt' | 'windowEndsId'>>) {
    const s = this.sessions.get(id);
    if (s) this.sessions.set(id, { ...s, ...data });
  }

  async actionJob(jobId: string): Promise<ActionJob | null> {
    const r = this.rows.find((x) => x.id === jobId);
    if (!r) return null;
    return {
      id: r.id,
      market: r.market,
      visibility: r.visibility,
      ownerUserId: r.ownerUserId,
      title: r.title,
      companyName: r.companyName,
      companyNameNormalized: r.companyNameNormalized,
      primaryTaxonomyId: r.primaryTaxonomyId,
      taxonomyIds: r.taxonomyIds,
      skills: r.skills,
      seniority: r.seniority,
      salaryDisclosed: r.salaryDisclosed,
      salaryMin: r.salaryMin,
      salaryMax: r.salaryMax,
      salaryCurrency: r.salaryCurrency,
      salaryPeriod: r.salaryPeriod,
      archivedAt: r.archivedAt,
      closedAt: this.closed.includes(r.id) ? new Date() : null,
    };
  }

  async setHidden(userId: string, jobId: string, hidden: { at: Date; reason: string } | null) {
    if (hidden) this.hidden.set(`${userId}:${jobId}`, hidden);
    else this.hidden.delete(`${userId}:${jobId}`);
  }

  async logInteractions(rows: InteractionWrite[]) {
    this.interactions.push(...rows);
  }

  async distinctReporters(jobId: string, reasons: readonly string[]) {
    return new Set(this.interactions.filter((i) => i.jobId === jobId && i.kind === 'report' && reasons.includes(i.reasonCode ?? '')).map((i) => i.userId)).size;
  }

  async closeAsReported(jobId: string) {
    if (this.closed.includes(jobId)) return false;
    this.closed.push(jobId);
    return true;
  }

  async recordImpressions(userId: string, jobIds: string[]) {
    this.impressions.push({ userId, jobIds });
  }

  async createRating(row: { userId: string; dayKey: string; score: number; reasons: string[] }) {
    if (this.ratings.some((r) => r.userId === row.userId && r.dayKey === row.dayKey)) return false;
    this.ratings.push(row);
    return true;
  }

  async getAffinity(userId: string) {
    return this.affinity.get(userId) ?? null;
  }

  async saveAffinity(userId: string, state: AffinityState) {
    this.affinity.set(userId, state);
  }

  async lastFeedVisit(userId: string) {
    return this.visits.get(userId) ?? null;
  }

  async stampFeedVisit(userId: string, at: Date) {
    this.visits.set(userId, at);
  }

  async profileSkills() {
    return this.skills;
  }

  async trackerCounts() {
    return { saved: [...this.tracker.values()].filter((s) => s === 'bookmarked').length, applied: [...this.tracker.values()].filter((s) => s === 'applied').length };
  }

  async importedCount(userId: string, market: string) {
    return this.rows.filter((r) => r.ownerUserId === userId && r.visibility === 'private' && r.market === market).length;
  }

  async careerGoal() {
    return this.goal;
  }
}
