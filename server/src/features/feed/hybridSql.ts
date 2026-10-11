// server/src/features/feed/hybridSql.ts — the three retrieval legs of the feed list
// (MKT-4F; MARKET_STRATEGY 2.1 point 3, SEARCH_RETRIEVE_MATCH 4.9; SM-7).
//
// Pure builders, like sql.ts: each returns a `Prisma.Sql` and touches no
// database. The three statements share ONE set of scope and filter predicates
// (`legPredicates`) and differ only in:
//
//   leg         order                                   extra                        the typed q
//   A recency   postedAt DESC                           the window (14 or 45 days)   wide predicate
//   B lexical   ts_rank_cd(searchTsv, query) DESC       searchTsv @@ query           wide predicate
//   C dense     embedding <=> vector (exact distance)   JOIN "RAJobEmbedding"        wide predicate
//
// Leg A is `retrievalSql` of sql.ts, unchanged. Legs B and C reach back to the
// list's age floor (`ageFloorSql`: 120 days, or the search's "posted within"),
// not to the 14-day first window, so the best match that is not among the
// newest rows can be found.
//
// The typed `q` is a FILTER of the list, so every leg applies it: each is
// built with the filter fields minus `q`, and the one q rule
// (`wideQPredicateSql(q)`: the search document holds every word of the query,
// OR the thin searchText matches; sql.ts) is added to all three. A leg that
// skipped it would return its 200 nearest (or newest) rows of everything the
// other filters leave, and the list would hold postings the count does not
// (M4 cross-review: with fewer than 200 vector rows under a search, a typed
// keyword filtered nothing under Recommended and Best fit). What leg C adds
// under a typed `q` is ORDER: among the postings that carry the words, the
// ones nearest in meaning first. With no typed `q` (the ranking words of a
// natural-language search, or the person's own vector) it is unconstrained:
// that is where it finds synonyms, adjacent titles and other languages.
//
// Two queries, two jobs. The FILTER of a typed `q` needs every word (the AND
// of its tokens, `allTokensTsQuery`). Leg B's own `@@` and its ORDER BY use the
// OR of the tokens of the leg's query text (`toTsQuery`), so a posting that
// carries more of the words ranks higher; with a typed `q` the filter above
// still decides which rows the leg may return.
//
// `profileQueryText` is the text leg B asks for when the list has no query
// text of its own: the person's recent titles and top skills.
//
// Parameters: the lexical query (`toTsQuery`: the OR of the segmented tokens,
// the function that segmented the document) and the vector literal
// (`vectorLiteral`, checked for 1024 finite numbers) are bound values, never
// text spliced into the statement. Raw SQL on RAJob lists its columns
// (FEED_COLUMNS) and never returns `searchTsv`; the embedding table is read
// with raw SQL only, always inside one market and one model tag, so vectors
// never cross markets and vectors of two models are never compared
// (server/prisma/sql/README.md).

import { Prisma } from '../../generated/prisma/client.js';
import type { Market } from '../../platform/brand/registry.js';
import { taxonomyLabel } from '../jobs/taxonomy/index.js';
import type { MatchUser } from '../match/index.js';
import { FILTER_FIELDS, type FilterField, type FilterSet } from '../search/index.js';
import { FEED_COLUMNS, ageFloorSql, filterPredicates, retrievalSql, scopePredicates, wideQPredicateSql, type SqlScope } from './sql.js';

export interface LegSqlInput {
  scope: SqlScope;
  filters: FilterSet;
  /** The filter fields to apply (default: all). `q` is always taken out and applied by the q rule. */
  fields?: readonly FilterField[];
  limit: number;
}

export interface RecencyLegSqlInput extends LegSqlInput {
  /** postedAt ≥ from: the window start (a hard bound for every row). */
  from: Date;
}

export interface WideLegSqlInput extends LegSqlInput {
  /** The list's age floor (FeedQueryService `floorOf`), applied with `ageFloorSql`. */
  ageFloor: Date;
}

export interface LegPredicates {
  /** Scope and filter predicates: the same for every leg of one input. */
  shared: Prisma.Sql[];
  /** The typed-query rule, applied by every leg; null when no `q` is typed. */
  q: Prisma.Sql | null;
}

const FROM = Prisma.sql`FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId"`;

const withoutQ = (fields: readonly FilterField[] | undefined): FilterField[] => (fields ?? FILTER_FIELDS).filter((f) => f !== 'q');

/** The predicates every leg shares, and the q rule every leg adds when a `q` is typed. */
export function legPredicates(input: Pick<LegSqlInput, 'scope' | 'filters' | 'fields'>): LegPredicates {
  const q = input.filters.q?.trim();
  return {
    shared: [...scopePredicates(input.scope), ...filterPredicates(input.filters, input.scope, withoutQ(input.fields))],
    q: q ? wideQPredicateSql(q) : null,
  };
}

function where(parts: Prisma.Sql[]): Prisma.Sql {
  return Prisma.sql`WHERE ${Prisma.join(parts, '\n  AND ')}`;
}

/** Leg A: today's window, newest first (`retrievalSql`), with the q rule. */
export function recencyLegSql(input: RecencyLegSqlInput): Prisma.Sql {
  const { q } = legPredicates(input);
  return retrievalSql({
    scope: input.scope,
    filters: input.filters,
    fields: withoutQ(input.fields),
    extra: q ? [q] : undefined,
    from: input.from,
    to: null,
    limit: input.limit,
  });
}

/**
 * Leg B: rows whose search document matches `tsQuery` (the caller's
 * `toTsQuery(text)`, never null here), best `ts_rank_cd` first, then newest.
 * A row with no search document yet (`searchTsv` null) is not in this leg; the
 * recency leg still lists it.
 */
export function lexicalLegSql(input: WideLegSqlInput, tsQuery: string): Prisma.Sql {
  const { shared, q } = legPredicates(input);
  const parts = [...shared, ...(q ? [q] : []), ageFloorSql(input.ageFloor), Prisma.sql`j."searchTsv" @@ to_tsquery('simple', ${tsQuery})`];
  return Prisma.sql`SELECT ${FEED_COLUMNS}
${FROM}
${where(parts)}
ORDER BY ts_rank_cd(j."searchTsv", to_tsquery('simple', ${tsQuery})) DESC, j."postedAt" DESC NULLS LAST, j."id" DESC
LIMIT ${input.limit}`;
}

/**
 * Leg C: rows that have a vector of `modelTag` in this market, nearest to the
 * vector first: an exact distance over the rows the filters leave, no
 * approximate index. `vectorLiteral` is the text form of a checked 1024-number
 * vector (retrieval `vectorLiteral`). A typed `q` filters this leg like the
 * other two (the list holds what the count counts); with none the leg is
 * bounded by the other filters only.
 */
export function denseLegSql(input: WideLegSqlInput, vectorLiteral: string, modelTag: string): Prisma.Sql {
  const { shared, q } = legPredicates(input);
  const parts = [...shared, ...(q ? [q] : []), ageFloorSql(input.ageFloor)];
  return Prisma.sql`SELECT ${FEED_COLUMNS}
${FROM}
JOIN "RAJobEmbedding" e ON e."jobId" = j."id" AND e."model" = ${modelTag} AND e."market" = ${input.scope.market}
${where(parts)}
ORDER BY e."embedding" <=> ${vectorLiteral}::halfvec(1024), j."id" DESC
LIMIT ${input.limit}`;
}

// ── The lexical query of a list with no query text ────────────────────────

/** Skills of the person that join their recent titles in the profile query. */
export const PROFILE_QUERY_SKILLS = 8;

/**
 * What leg B asks for when a personalised list has no typed query and no
 * text to rank by: the person's most recent title, the names of the roles
 * their record shows (in the market's languages, as the search document
 * carries them), then their top skills. The caller turns it into a query with
 * `toTsQuery`, which keeps the first 24 distinct tokens, so the titles lead.
 * Null for a person with none of them. Never built for a list that is not
 * personalised (FeedQueryService).
 */
export function profileQueryText(user: Pick<MatchUser, 'recentTitle' | 'evidenceRoleIds' | 'skills'> | null | undefined, market: Market): string | null {
  if (!user) return null;
  const roles = (user.evidenceRoleIds ?? []).slice(0, 2);
  const locales = market === 'cn' ? ['zh', 'en'] : ['en', 'zh-TW'];
  const parts = [
    user.recentTitle ?? '',
    ...roles.flatMap((id) => locales.map((l) => taxonomyLabel(id, l) ?? '')),
    ...(user.skills ?? []).slice(0, PROFILE_QUERY_SKILLS),
  ]
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(' ') : null;
}
