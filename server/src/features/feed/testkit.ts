// server/src/features/feed/testkit.ts — fixtures and an in-memory FeedRepo for feed tests (WP-32).
//
// No vitest imports: the file compiles with the server. The fake repo honours
// the parts of the SQL a service test depends on (posted-date windows, the
// (postedAt, id) keyset, the age floor and the boards it applies to, the bank
// posting-page rule, firstSeenAt, ids, LIMIT, hidden state, market, the
// public-only and publicDisplay scopes, a role (taxonomy) predicate; ordering
// is newest first, then id descending, like the SQL); the other predicates'
// SQL is covered by sql.test.ts snapshots instead.
//
// Hybrid retrieval (MKT-4F). The fake answers the three leg statements of
// hybridSql.ts from the same rows:
//   - `searchDocs` holds a job's search document as `RAJob.searchDoc` stores
//     it: the space-joined tokens retrieval `buildSearchDoc` wrote. A row
//     without one has no `searchTsv`: it is in no lexical leg and the wide
//     typed-query predicate can only find it through its thin searchText
//     (title, company, skills). The fake reads the document's lexemes the way
//     `to_tsvector('simple', searchDoc)` does (split on white space, lower
//     case) and never segments it a second time; the query is the string the
//     statement binds: the OR of the leg's tokens (`toTsQuery`, `'a' | 'b'`:
//     any token matches) or the AND of a typed query's tokens (the wide
//     predicate, sql.ts `allTokensTsQuery`, `'a' & 'b'`: every token must be
//     in the document). The rank is the number of occurrences of the query's
//     tokens in the document (ts_rank_cd-like).
//   - `vectors` holds a job's embedding under `vectorModel`. A row without one
//     is in no dense leg. The distance is the exact cosine distance.
// The emulation is exported (`lexicalMatch`, `cosineDistance`, `tsQueryTokens`)
// so the retrieval suite of the match harness runs on the same functions.

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
import { parseVector } from '../retrieval/index.js';
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

// ── In-memory twins of the lexical and dense legs ─────────────────────────

/** The model tag the fake's job vectors carry. */
export const FAKE_VECTOR_MODEL = 'test/embed@1024';

/** The tokens of a bound `to_tsquery` string (`'a' | 'b'` or `'a' & 'b'`), unquoted. */
export function tsQueryTokens(tsQuery: string): string[] {
  return tsQuery
    .split(/ [|&] /)
    .map((t) => t.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'").replace(/\\\\/g, '\\'))
    .filter(Boolean);
}

/** Does the bound query ask for EVERY token (`&`, the typed-query predicate) instead of any (`|`, a leg's query)? */
const needsEveryToken = (tsQuery: string): boolean => / & /.test(tsQuery);

/**
 * How a search document answers a lexical query, as `searchTsv @@ query` and
 * `ts_rank_cd` would: an OR query (`'a' | 'b'`) matches when any of its tokens
 * is a token of the document, an AND query (`'a' & 'b'`) when every one is;
 * `rank` is the number of occurrences of the query's tokens in the document.
 */
export function lexicalMatch(doc: string | null | undefined, tsQuery: string): { matches: boolean; rank: number } {
  if (!doc) return { matches: false, rank: 0 };
  const wanted = new Set(tsQueryTokens(tsQuery));
  const found = new Set<string>();
  let rank = 0;
  for (const token of docTokens(doc)) {
    if (!wanted.has(token)) continue;
    rank += 1;
    found.add(token);
  }
  const matches = needsEveryToken(tsQuery) ? wanted.size > 0 && found.size === wanted.size : rank > 0;
  return { matches, rank: matches ? rank : 0 };
}

const tokenCache = new Map<string, string[]>();

/**
 * The lexemes of a stored search document, as `to_tsvector('simple', doc)`
 * holds them: its own space-separated tokens, lower case. The document was
 * segmented when it was written; segmenting it again would add tokens
 * PostgreSQL never indexes (a long Chinese token would yield its bigrams twice).
 */
function docTokens(doc: string): string[] {
  let tokens = tokenCache.get(doc);
  if (!tokens) {
    tokens = doc.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokenCache.size >= 5000) tokenCache.clear();
    tokenCache.set(doc, tokens);
  }
  return tokens;
}

/** Exact cosine distance (`<=>`), 0 (same direction) to 2. NaN when either vector has no direction. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A 1024-number test vector whose first components are `head` (the rest zero). */
export function testVector(...head: number[]): number[] {
  const v = new Array<number>(1024).fill(0);
  head.forEach((n, i) => {
    v[i] = n;
  });
  return v;
}

/** The thin `RAJob.searchText` of a row: title, company and its first ten skills, lower case. */
function thinSearchText(r: FeedJobRow): string {
  return [r.title, r.companyName, ...(r.skills ?? []).slice(0, 10)].join(' ').toLowerCase();
}

export type FeedLeg = 'recency' | 'lexical' | 'dense';

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
  /** Search documents by job id (see the header). */
  searchDocs = new Map<string, string>();
  /** Job vectors by job id, all of `vectorModel`. */
  vectors = new Map<string, number[]>();
  vectorModel = FAKE_VECTOR_MODEL;
  /** Make one leg's statement fail (the list must still answer from the others). */
  failLeg: FeedLeg | null = null;
  /**
   * `RAJobUserState` as the impression rules read and write it, by `<userId>:<jobId>`. `recordImpressions`
   * raises `impressions` once per job and feed session, like the SQL (`lastImpressionAt` before the session's start).
   */
  impressionRows = new Map<string, { impressions: number; viewedAt: Date | null; lastImpressionAt?: Date | null }>();
  /** Count statements answer the number of rows the statement selects, instead of `countResponder`. */
  countFromRows = false;
  private seq = 0;

  /** Which retrieval leg a recorded statement is; null for any other statement. */
  static legOf(s: SqlLike): FeedLeg | null {
    if (/JOIN "RAJobEmbedding" e/.test(s.text)) return 'dense';
    if (/ORDER BY ts_rank_cd\(/.test(s.text)) return 'lexical';
    if (/^SELECT j\."id", j\."market"/.test(s.text) && /ORDER BY j\."postedAt" DESC NULLS LAST/.test(s.text) && !/j\."id" = ANY\(/.test(s.text)) return 'recency';
    return null;
  }

  /** The legs of the list statements run so far, in order. */
  legsRun(): FeedLeg[] {
    return this.queries.map((q) => FakeFeedRepo.legOf(q)).filter((l): l is FeedLeg => l !== null);
  }

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
    const leg = FakeFeedRepo.legOf(s);
    if (leg && leg === this.failLeg) throw new Error(`${leg} leg unavailable`);
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
    // The board hold of `scopePredicates` (`SqlScope.heldBoards`): rows of a source the reader cannot credit yet.
    // (The age floor names boards too, after "IS NOT NULL AND": that is not this predicate.)
    const heldBoards = valueAfter(s, /(?<!IS NOT NULL AND )NOT \(j\."sourceBoard" = ANY\(\$(\d+)/) as string[] | undefined;
    if (heldBoards) rows = rows.filter((r) => !heldBoards.includes(r.sourceBoard));
    const ids = valueAfter(s, /j\."id" = ANY\(\$(\d+)/) as string[] | undefined;
    if (ids) return rows.filter((r) => ids.includes(r.id));
    // The typed-query predicate (sql.ts): the wide form matches a search document that holds EVERY token of the
    // query (the bound value is the AND of them) OR the thin searchText; the narrow form (a query under three
    // Latin characters) the thin searchText only. Substring match only: the trigram half is not emulated.
    const wideTs = valueAfter(s, /\(j\."searchTsv" @@ to_tsquery\('simple', \$(\d+)\) OR \(j\."searchText" ILIKE/) as string | undefined;
    const like = valueAfter(s, /\(j\."searchText" ILIKE \$(\d+)/) as string | undefined;
    if (like !== undefined) {
      const needle = like.replace(/^%/, '').replace(/%$/, '').replace(/\\([\\%_])/g, '$1');
      rows = rows.filter((r) => thinSearchText(r).includes(needle) || (wideTs !== undefined && lexicalMatch(this.searchDocs.get(r.id), wideTs).matches));
    }
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
    // The age floor (`ageFloorSql`): a row of the named boards (aggregators, own imports, 台灣就業通) must be at or
    // above it; a dated row of any other source passes at any age.
    const ageFloor = valueAfter(s, /\(j\."postedAt" >= \$(\d+)::timestamp\(3\) OR \(j\."postedAt" IS NOT NULL AND/) as Date | undefined;
    const floorBoards = valueAfter(s, /j\."postedAt" IS NOT NULL AND NOT \(j\."sourceBoard" = ANY\(\$(\d+)/) as string[] | undefined;
    if (ageFloor) rows = rows.filter((r) => r.postedAt && (r.postedAt >= ageFloor || !(floorBoards ?? []).includes(r.sourceBoard)));
    if (to) rows = rows.filter((r) => r.postedAt && r.postedAt < to);
    if (keyTo && keyId) {
      rows = rows.filter((r) => r.postedAt && (r.postedAt.getTime() < keyTo.getTime() || (r.postedAt.getTime() === keyTo.getTime() && r.id < keyId)));
    }
    if (seen) rows = rows.filter((r) => r.firstSeenAt && r.firstSeenAt > seen);
    const limit = valueAfter(s, /LIMIT \$(\d+)\s*$/) as number | undefined;
    const cut = (list: FeedJobRow[]) => (limit ? list.slice(0, limit) : list);
    const posted = (r: FeedJobRow) => r.postedAt?.getTime() ?? 0;
    // Leg B (`lexicalLegSql`): rows whose search document matches, best rank first, then newest, then id.
    const legQuery = valueAfter(s, /ORDER BY ts_rank_cd\(j\."searchTsv", to_tsquery\('simple', \$(\d+)\)\)/) as string | undefined;
    if (legQuery !== undefined) {
      const ranked = rows.map((r) => ({ r, m: lexicalMatch(this.searchDocs.get(r.id), legQuery) })).filter((x) => x.m.matches);
      ranked.sort((a, b) => b.m.rank - a.m.rank || posted(b.r) - posted(a.r) || (a.r.id < b.r.id ? 1 : -1));
      return cut(ranked.map((x) => x.r));
    }
    // Leg C (`denseLegSql`): rows with a vector of the statement's model tag and market, nearest first, then id.
    const denseModel = valueAfter(s, /JOIN "RAJobEmbedding" e ON e\."jobId" = j\."id" AND e\."model" = \$(\d+)/) as string | undefined;
    if (denseModel !== undefined) {
      const query = parseVector(valueAfter(s, /ORDER BY e\."embedding" <=> \$(\d+)::halfvec\(1024\)/));
      if (!query || denseModel !== this.vectorModel) return [];
      const near = rows
        .filter((r) => this.vectors.has(r.id))
        .map((r) => ({ r, d: cosineDistance(this.vectors.get(r.id)!, query) }))
        .filter((x) => Number.isFinite(x.d));
      near.sort((a, b) => a.d - b.d || (a.r.id < b.r.id ? 1 : -1));
      return cut(near.map((x) => x.r));
    }
    const at = /ORDER BY j\."firstSeenAt" DESC/.test(s.text) ? (r: FeedJobRow) => r.firstSeenAt?.getTime() ?? 0 : posted;
    rows = [...rows].sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1));
    return cut(rows);
  }

  async queryCount(sql: Prisma.Sql) {
    const s = { text: sql.text, values: sql.values };
    this.queries.push(s);
    if (!this.countFromRows) return this.countResponder(s);
    // The count statement wraps the list's predicates in `SELECT 1 … LIMIT cap + 1`: count what they select.
    return this.select(s).length;
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
      titleNormalized: r.titleNormalized,
      companyName: r.companyName,
      companyNameNormalized: r.companyNameNormalized,
      primaryTaxonomyId: r.primaryTaxonomyId,
      taxonomyIds: r.taxonomyIds,
      skills: r.skills,
      skillIds: r.skillIds ?? [],
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

  async recordImpressions(userId: string, jobIds: string[], at: Date, sessionStartedAt: Date) {
    this.impressions.push({ userId, jobIds });
    const stamp = at.getTime() >= sessionStartedAt.getTime() ? at : sessionStartedAt;
    for (const id of jobIds) {
      const key = `${userId}:${id}`;
      const row = this.impressionRows.get(key) ?? { impressions: 0, viewedAt: null, lastImpressionAt: null };
      // ON CONFLICT … WHERE "lastImpressionAt" IS NULL OR "lastImpressionAt" < the session's start.
      if (row.lastImpressionAt && row.lastImpressionAt.getTime() >= sessionStartedAt.getTime()) continue;
      this.impressionRows.set(key, { ...row, impressions: row.impressions + 1, lastImpressionAt: stamp });
    }
  }

  async impressionStates(userId: string, jobIds: string[]) {
    const out = new Map<string, { impressions: number; viewedAt: Date | null }>();
    for (const id of jobIds) {
      const row = this.impressionRows.get(`${userId}:${id}`);
      if (row && row.impressions > 0) out.set(id, { impressions: row.impressions, viewedAt: row.viewedAt });
    }
    return out;
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
