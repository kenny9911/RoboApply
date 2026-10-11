// server/src/features/feed/testkit.ts — fixtures and an in-memory FeedRepo for feed tests (WP-32).
//
// No vitest imports: the file compiles with the server. The fake repo honours
// the parts of the SQL a service test depends on (posted-date windows, the
// (postedAt, id) keyset, the age floor and its board/bank exemption, the bank
// posting-page rule, firstSeenAt, ids, LIMIT, hidden state, market, the
// public-only and publicDisplay scopes, a role (taxonomy) predicate; ordering
// is newest first, then id descending, like the SQL); the other predicates'
// SQL is covered by sql.test.ts snapshots instead.

import type { Prisma } from '../../generated/prisma/client.js';
import {
  DEFAULT_MATCH_PRIORS,
  DEFAULT_MATCH_TIERS,
  DEFAULT_MATCH_WEIGHTS,
  SCORER_PROMPT_VERSION,
  assembleFit,
  currentScorerPin,
  type CalibrationMap,
  type Fit,
  type MatchPriors,
  type MatchTiers,
  type MatchUser,
  type MatchWeights,
} from '../match/index.js';
import type { AffinityState } from './affinity.js';
import type { FeedServiceDeps } from './FeedQueryService.js';
import type { ActionJob, CardExtrasRow, FeedRepo, FeedSessionRecord, InteractionWrite } from './repo.js';
import { EMPLOYER_BOARD_SOURCES, GOHIRE_SOURCE_BOARD } from './sourceLine.js';
import { toMatchRecord, type FeedJobRow } from './types.js';

/**
 * Both recruiter banks with a candidate-facing posting page. A bank row is
 * listed (and carries an apply link) only then (sourceLine.ts `heldBankBoards`),
 * so a test that lists bank rows runs with these two settings.
 */
export const BANK_PAGES_ENV: Readonly<Record<string, string>> = {
  GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://jobs.gohire.example/p/{id}',
  ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://jobs.robohire.example/p/{id}',
};

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
    applyUrl: `https://jobs.example.com/apply/${over.id}`,
    sourceUrl: `https://jobs.example.com/posting/${over.id}`,
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
    skillIds: [],
    contentHash: null,
    lang: null,
    titleMatchScore: null,
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
  /**
   * Stored AI scores by job id. Not a repo read any more: the feed gets its
   * fits from match `getFits`, and `fakeFeedMatch` serves these as that
   * person's stored scores.
   */
  ai = new Map<string, { score: number; tier: string | null; dimensions?: unknown; modelUsed?: string; promptVersion?: string | null; jobContentHash?: string | null }>();
  /** Ids whose `publicDisplay` is false (the visitor list's SQL scope drops them). */
  notPublicDisplay = new Set<string>();
  /** Ids the public-page re-check refuses (archived, closed, expired, flagged, source no longer allowed). */
  notPublicPage = new Set<string>();
  /** Boards still allowed to be redisplayed publicly (seo `allowedPublicBoards`); the default row's board is one. */
  allowedBoards: string[] = ['activejobs'];
  /** `cardExtrasSql` rows by job id. */
  cardExtras = new Map<string, Partial<CardExtrasRow>>();
  /** Admin decisions: the interaction count when each was made (reports logged before it are decided). */
  private decidedAtSeq = new Map<string, number>();
  tracker = new Map<string, string>();
  skills: string[] = [];
  goal: string | null = null;
  /** `sourcesSql` statements seen (the header facts are computed from `rows` with the statement's market and visibility scope). */
  sourceQueries: SqlLike[] = [];
  /** Make the header-facts statement fail (the list must still answer). */
  failSources = false;
  /** Count statements: return this (or a function of the statement). */
  countResponder: (sql: SqlLike) => number = () => 0;
  categoryCounts: Array<{ taxonomyId: string; count: number }> = [];
  queries: SqlLike[] = [];
  private seq = 0;

  private visible(userId: string | null, market: string | null, owner: string | null) {
    return (r: FeedJobRow) =>
      (!market || r.market === market) && (r.visibility === 'public' || (!!owner && r.ownerUserId === owner)) && !(userId && this.hidden.has(`${userId}:${r.id}`));
  }

  /** An admin decided on the job's reports so far (kept or closed). */
  decide(jobId: string) {
    this.decidedAtSeq.set(jobId, this.interactions.length);
  }

  async queryRows(sql: Prisma.Sql) {
    const s = { text: sql.text, values: sql.values };
    this.queries.push(s);
    return this.select(s);
  }

  async queryIds(sql: Prisma.Sql) {
    const s = { text: sql.text, values: sql.values };
    this.queries.push(s);
    return this.select(s).map((r) => r.id);
  }

  async queryCardExtras(sql: Prisma.Sql): Promise<CardExtrasRow[]> {
    const s = { text: sql.text, values: sql.values };
    this.queries.push(s);
    const ids = (valueAfter(s, /j\."id" = ANY\(\$(\d+)/) as string[] | undefined) ?? [];
    return ids
      .filter((id) => this.rows.some((r) => r.id === id))
      .map((id) => ({ id, sourceUrl: null, applyUrl: null, locations: null, fraudFlags: null, descriptionPlain: null, ...(this.cardExtras.get(id) ?? {}) }));
  }

  async querySources(sql: Prisma.Sql) {
    const s = { text: sql.text, values: sql.values };
    this.queries.push(s);
    this.sourceQueries.push(s);
    if (this.failSources) throw new Error('sources unavailable');
    // Only the scope is honoured here (market, public rows, the apply-link guard, the age floor); the filter SQL is snapshot-tested.
    const rows = this.select({ text: s.text.replace(/LIMIT \$\d+\s*$/, ''), values: s.values }).filter((r) => r.visibility === 'public');
    const boards = new Set(rows.filter((r) => !r.fromRecruiterBank && EMPLOYER_BOARD_SOURCES.includes(r.sourceBoard)).map((r) => `${r.sourceBoard}:${r.companyNameNormalized}`));
    return { gohire: rows.some((r) => r.fromRecruiterBank && r.sourceBoard === GOHIRE_SOURCE_BOARD), employerBoards: boards.size, listed: rows.length };
  }

  async publicPageIds(ids: string[]) {
    return new Set(ids.filter((id) => !this.notPublicPage.has(id)));
  }

  async publicBoards() {
    return [...this.allowedBoards];
  }

  private select(s: SqlLike): FeedJobRow[] {
    const market = valueAfter(s, /j\."market" = \$(\d+)/) as string | null;
    const user = (valueAfter(s, /s\."userId" = \$(\d+)/) as string | undefined) ?? null;
    // `(visibility = 'public' OR ownerUserId = $n)` shows the owner's imports; a bare `visibility = 'public'` does not.
    const owner = (valueAfter(s, /j\."ownerUserId" = \$(\d+)/) as string | undefined) ?? null;
    let rows = this.rows.filter(this.visible(user, market ?? null, owner));
    // The mainland apply-link guard of `scopePredicates`: a public row is listed only with an http(s) apply link.
    if (/j\."visibility" <> 'public' OR j\."applyUrl" ~\* /.test(s.text)) rows = rows.filter((r) => r.visibility !== 'public' || /^\s*https?:\/\//i.test(r.applyUrl ?? ''));
    if (/j\."publicDisplay" = true/.test(s.text)) rows = rows.filter((r) => !this.notPublicDisplay.has(r.id));
    const notExpiredAt = valueAfter(s, /j\."expiresAt" IS NULL OR j\."expiresAt" > \$(\d+)/) as Date | undefined;
    if (notExpiredAt) rows = rows.filter((r) => !r.expiresAt || r.expiresAt > notExpiredAt);
    const boards = valueAfter(s, /j\."fromRecruiterBank" = true OR j\."sourceBoard" = ANY\(\$(\d+)/) as string[] | undefined;
    if (boards) rows = rows.filter((r) => r.fromRecruiterBank || boards.includes(r.sourceBoard));
    // The bank rule of `scopePredicates`: a recruiter-bank row whose bank has no posting page is never listed.
    const heldBanks = valueAfter(s, /NOT \(j\."fromRecruiterBank" = true AND j\."sourceBoard" = ANY\(\$(\d+)/) as string[] | undefined;
    if (heldBanks) rows = rows.filter((r) => !(r.fromRecruiterBank && heldBanks.includes(r.sourceBoard)));
    const ids = valueAfter(s, /j\."id" = ANY\(\$(\d+)/) as string[] | undefined;
    if (ids) return rows.filter((r) => ids.includes(r.id));
    // The browse category predicate only (a bare AND part; a search's role predicate sits in parentheses with its title match).
    const roles = valueAfter(s, /AND j\."taxonomyIds" && \$(\d+)::text\[\]/) as string[] | undefined;
    if (roles) rows = rows.filter((r) => (r.taxonomyIds ?? []).some((t) => roles.includes(t)));
    const undatedFrom = valueAfter(s, /\(j\."postedAt" IS NULL OR j\."postedAt" >= \$(\d+)::timestamp\(3\)\)/) as Date | undefined;
    if (undatedFrom) rows = rows.filter((r) => !r.postedAt || r.postedAt >= undatedFrom);
    const from = valueAfter(s, /(?<!OR )j\."postedAt" >= \$(\d+)::timestamp\(3\)\s+(?:AND|ORDER)/) as Date | undefined;
    const to = valueAfter(s, /j\."postedAt" < \$(\d+)/) as Date | undefined;
    const keyTo = valueAfter(s, /\(j\."postedAt", j\."id"\) < \(\$(\d+)/) as Date | undefined;
    const keyId = valueAfter(s, /\(j\."postedAt", j\."id"\) < \(\$\d+::timestamp\(3\), \$(\d+)\)/) as string | undefined;
    const seen = valueAfter(s, /j\."firstSeenAt" > \$(\d+)/) as Date | undefined;
    if (from) rows = rows.filter((r) => r.postedAt && r.postedAt >= from);
    // The age floor (`ageFloorSql`): an aggregator row must be at or above it; a dated board or bank row passes at any age.
    const ageFloor = valueAfter(s, /\(j\."postedAt" >= \$(\d+)::timestamp\(3\) OR \(j\."postedAt" IS NOT NULL AND/) as Date | undefined;
    const ageFree = valueAfter(s, /j\."postedAt" IS NOT NULL AND \(j\."sourceBoard" = ANY\(\$(\d+)/) as string[] | undefined;
    if (ageFloor) rows = rows.filter((r) => r.postedAt && (r.postedAt >= ageFloor || r.fromRecruiterBank || (ageFree ?? []).includes(r.sourceBoard)));
    if (to) rows = rows.filter((r) => r.postedAt && r.postedAt < to);
    if (keyTo && keyId) {
      rows = rows.filter((r) => r.postedAt && (r.postedAt.getTime() < keyTo.getTime() || (r.postedAt.getTime() === keyTo.getTime() && r.id < keyId)));
    }
    if (seen) rows = rows.filter((r) => r.firstSeenAt && r.firstSeenAt > seen);
    const at = /ORDER BY j\."firstSeenAt" DESC/.test(s.text) ? (r: FeedJobRow) => r.firstSeenAt?.getTime() ?? 0 : (r: FeedJobRow) => r.postedAt?.getTime() ?? 0;
    rows = [...rows].sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1));
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
    const decided = this.decidedAtSeq.get(jobId) ?? 0;
    return new Set(
      this.interactions
        .map((i, seq) => ({ i, seq }))
        .filter(({ i, seq }) => seq >= decided && i.jobId === jobId && i.kind === 'report' && reasons.includes(i.reasonCode ?? ''))
        .map(({ i }) => i.userId),
    ).size;
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
    return this.rows.filter((r) => r.ownerUserId === userId && r.sourceBoard === 'user_import' && r.market === market && !r.archivedAt).length;
  }

  async careerGoal() {
    return this.goal;
  }
}

// ── The match dependency (fits) ───────────────────────────────────────────

/** The scorer model the fake stored scores were "written" by. */
export const FAKE_SCORER_MODEL = 'test/model-a';

type FeedMatchContext = Awaited<ReturnType<FeedServiceDeps['match']['userContext']>>;

export interface FakeFeedMatchOptions {
  repo: FakeFeedRepo;
  /** The person's side, as match `userContext` answers it. */
  context: (userId: string) => FeedMatchContext | Promise<FeedMatchContext>;
  config?: () => { weights: MatchWeights; tiers: MatchTiers; priors: MatchPriors };
  /** The market's calibration map (default: none, so ranking uses the blend). */
  map?: () => CalibrationMap | null;
  now?: () => Date;
}

export type FakeFeedMatch = FeedServiceDeps['match'] & {
  /** `rowsHanded`: per `getFits` call, how many of the asked ids came with their row (the feed hands its window over). */
  calls: { userContext: number; getFits: string[][]; rowsHanded: number[] };
};

/**
 * The feed's match dependency for tests: the REAL fit assembly (match/fit.ts
 * `assembleFit`, the function production `getFits` runs) over the fake repo's
 * rows, with `repo.ai` as the person's stored AI scores. No model, no
 * database. A stored score given without components gets one component that
 * carries its total, so the total is the number the test wrote.
 */
export function fakeFeedMatch(opts: FakeFeedMatchOptions): FakeFeedMatch {
  const calls = { userContext: 0, getFits: [] as string[][], rowsHanded: [] as number[] };
  const config = opts.config ?? (() => ({ weights: { ...DEFAULT_MATCH_WEIGHTS }, tiers: { ...DEFAULT_MATCH_TIERS }, priors: { ...DEFAULT_MATCH_PRIORS } }));
  const now = opts.now ?? (() => new Date());
  const pin = currentScorerPin('roboapply', FAKE_SCORER_MODEL);
  return {
    calls,
    async userContext(userId) {
      calls.userContext += 1;
      return opts.context(userId);
    },
    config,
    async calibrationMap() {
      return opts.map ? opts.map() : null;
    },
    async getFits(userId, jobIds, o) {
      calls.getFits.push([...jobIds]);
      const { user, resume } = o?.context ?? (await opts.context(userId));
      const cfg = config();
      const out = new Map<string, Fit>();
      const handed = new Map((o?.rows ?? []).map((r) => [r.id, r]));
      calls.rowsHanded.push(jobIds.filter((id) => handed.has(id)).length);
      for (const id of jobIds) {
        // As production `getFits`: a row the caller handed over is used as it is; any other is read.
        const read = opts.repo.rows.find((r) => r.id === id);
        const job = handed.get(id) ?? (read ? toMatchRecord(read) : null);
        if (!job) continue;
        const ai = opts.repo.ai.get(id);
        out.set(
          id,
          assembleFit({
            job,
            // A list knows the posting's hash only when the row stores one (no description is read here).
            jobContentHash: job.contentHash ?? null,
            user: user as MatchUser,
            resume,
            stored:
              ai && resume
                ? {
                    resumeVariantId: resume.id,
                    score: ai.score,
                    tier: ai.tier,
                    dimensions: ai.dimensions ?? [{ key: 'title_level', weight: cfg.weights.title_level, score: ai.score, status: 'scored', evidence: [] }],
                    generatedAt: new Date('2026-10-09T00:00:00.000Z'),
                    modelUsed: ai.modelUsed ?? FAKE_SCORER_MODEL,
                    promptVersion: ai.promptVersion === undefined ? SCORER_PROMPT_VERSION : ai.promptVersion,
                    jobContentHash: ai.jobContentHash ?? null,
                    rubricVersion: null,
                    searchProfileVersion: user.searchProfileVersion,
                    resumeContentHashAtScore: resume.resumeContentHash,
                  }
                : null,
            config: cfg,
            pin,
            map: opts.map ? opts.map() : null,
            now: now(),
          }),
        );
      }
      return out;
    },
  };
}
