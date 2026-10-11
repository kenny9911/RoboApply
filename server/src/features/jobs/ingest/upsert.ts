// server/src/features/jobs/ingest/upsert.ts — batch RAJob upsert and dedupe (ARCH §4.4).
//
// One raw statement per batch of ≤100 rows:
//   INSERT … ON CONFLICT ("externalId","sourceBoard") DO UPDATE SET "lastSeenAt" = now(), …
//   RETURNING "id", "externalId", "sourceBoard", (xmax = 0) AS "inserted"
// `xmax = 0` is true only for rows this statement inserted, so new rows are
// counted without a second query.
//
// Update rules (honesty):
//   - the posting's own fields are refreshed from the source;
//   - deterministic fields that enrichment may have filled (taxonomy,
//     seniority, years, skills, roleType, educationLevel) are kept when the
//     source now says nothing, never blanked;
//   - `educationLevel` is replaced by a level the source itself labels (a
//     bank's education field). A level the normalizer read from the posting
//     text fills an empty value and a row enrichment has not reached yet; it
//     never replaces the level of an enriched row (`toUpsertRow` with
//     `keepStoredEducation`), because enrichment read the whole posting;
//   - `applicantCount` is never written for 'linkedin' / 'jsearch' rows (the
//     normalizer drops it and `toUpsertRow` forces null again);
//   - `fraudFlags` and `marketTags` a market hook raised at normalize time
//     (GoApply keyword / blacklist fraud rules, 届别 and 校招 tags) are stored
//     with the row, so a flagged posting is out of the lists from its first
//     ingest and the GoApply filters work before enrichment runs. On a
//     re-ingest they are MERGED into what the row holds: every flag or tag
//     another module wrote (enrichment's scam rules and requirement tags, the
//     CN classifier, Taiwan work-permit tags) stays, an entry already there
//     keeps its original record, and only new entries are added. Entries the
//     posting no longer supports are removed by enrichment's own reconcile
//     (a changed posting is re-enriched), never blanked here;
//   - the role (`taxonomyIds`, `primaryTaxonomyId`) of a row enrichment has already ruled on is replaced
//     only by a decisive title (`titleMatchScore` >= 0.9) or after the title changed (`ROLE_FROM_INGEST`),
//     so a model's override of a weak title match survives the next listing; `titleMatchScore` itself is
//     always the incoming title's score;
//   - `visibility` and `firstSeenAt` never change; a private row (a user's own
//     import) is never touched (`WHERE "RAJob"."visibility" = 'public'`);
//   - a row archived because its source dropped it ('source_removed'), the
//     bank closed it ('bank_closed') or it had no page a candidate could open
//     ('no_apply_target': a bank row while its bank had no posting page) is
//     revived when the source lists it again; 'expired', 'reported' and
//     'duplicate' closures stand.
//   - `workType` (deprecated, NOT NULL) mirrors workModel; readers use workModel.
// Dedupe: per dedupeKey the canonical row is the lowest sourcePriority, then
// the most recent postedAt; the others point at it (`canonicalJobId`) and stay
// live as alternates (no closeReason).

import { createHash } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.js';
import type { Market } from '../../../platform/brand/index.js';
import { NO_APPLICANT_COUNT_PROVIDERS, type NormalizedJob, type NormalizeProvider } from '../normalize/index.js';
import type { SourceCloseReason } from '../sources/index.js';
import { TITLE_MATCH_TRUSTED } from '../taxonomy/index.js';
import { UPSERT_BATCH } from './config.js';
import { newId, type IngestDb } from './db.js';

/** md5(title | descriptionPlain) — the same value Postgres computes in `prefetchExisting`. */
export function contentHash(title: string, descriptionPlain: string): string {
  return createHash('md5').update(`${title}|${descriptionPlain}`, 'utf8').digest('hex');
}

export interface ExistingJobRow {
  id: string;
  externalId: string;
  sourceBoard: string;
  firstSeenAt: Date;
  contentHash: string;
  visibility: string;
  /** The row is enriched and holds an education level: a level read from the posting text never replaces it. */
  enrichedEducation?: boolean;
}

/** Existing rows for a batch (one query), keyed `<sourceBoard>\u0000<externalId>`. */
export async function prefetchExisting(db: IngestDb, keys: Array<{ externalId: string; sourceBoard: string }>): Promise<Map<string, ExistingJobRow>> {
  const out = new Map<string, ExistingJobRow>();
  if (keys.length === 0) return out;
  const boards = [...new Set(keys.map((k) => k.sourceBoard))];
  const ids = [...new Set(keys.map((k) => k.externalId))];
  const rows = await db.$queryRaw<ExistingJobRow[]>`
    SELECT "id", "externalId", "sourceBoard", "firstSeenAt", "visibility",
           md5(coalesce("title", '') || '|' || coalesce("descriptionPlain", '')) AS "contentHash",
           ("enrichedAt" IS NOT NULL AND "educationLevel" IS NOT NULL) AS "enrichedEducation"
    FROM "RAJob"
    WHERE "sourceBoard" = ANY(${boards}::text[]) AND "externalId" = ANY(${ids}::text[])`;
  for (const r of rows) out.set(existingKey(r.sourceBoard, r.externalId), r);
  return out;
}

export function existingKey(sourceBoard: string, externalId: string): string {
  return `${sourceBoard}\u0000${externalId}`;
}

/** The values one RAJob row is written with (column order = UPSERT_COLUMNS). */
export interface JobUpsertRow {
  id: string;
  externalId: string;
  sourceBoard: string;
  applyUrl: string;
  title: string;
  titleNormalized: string;
  companyName: string;
  companyNameNormalized: string;
  companyLogoUrl: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  workType: string;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  description: string;
  descriptionPlain: string;
  postedAt: Date | null;
  market: string;
  visibility: string;
  companyId: string | null;
  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  titleMatchScore: number | null;
  seniority: string | null;
  roleType: string | null;
  minYears: number | null;
  maxYears: number | null;
  skills: string[];
  workModel: string | null;
  remoteScope: string | null;
  locationRegion: string | null;
  locations: string;
  geoLat: number | null;
  geoLng: number | null;
  salarySource: string | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryMonths: number | null;
  salaryDisclosed: boolean;
  salaryText: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  originalSourceName: string | null;
  /** Host of the original posting (SCHEMA-2). */
  originalHost: string | null;
  atsType: string | null;
  isAgency: boolean | null;
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  applicantCount: number | null;
  applicantCountSource: string | null;
  applicantCountAt: Date | null;
  postedAtEstimated: boolean;
  expiresAt: Date | null;
  dedupeKey: string;
  sourcePriority: number;
  searchText: string;
  publicDisplay: boolean;
  /** JSON text of `[{ rule, evidence, at, method? }]` from the normalize-stage hooks, or null. */
  fraudFlags: string | null;
  /** JSON text of `[{ tag, evidenceQuote, evidenceUrl }]` from the normalize-stage hooks, or null. */
  marketTags: string | null;
  /** 'none' | 'associate' | 'bachelor' | 'master' | 'phd' as the source or the posting states it; null = not stated. */
  educationLevel: string | null;
}

/** Column order of every VALUES tuple (= JobUpsertRow key order); the last three columns are now(). */
export const UPSERT_COLUMNS = [
  'id', 'externalId', 'sourceBoard', 'applyUrl', 'title', 'titleNormalized', 'companyName', 'companyNameNormalized',
  'companyLogoUrl', 'location', 'locationCity', 'locationCountry', 'workType', 'employmentType',
  'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'description', 'descriptionPlain',
  'postedAt', 'market', 'visibility', 'companyId', 'taxonomyIds', 'primaryTaxonomyId', 'titleMatchScore',
  'seniority', 'roleType', 'minYears', 'maxYears', 'skills', 'workModel',
  'remoteScope', 'locationRegion', 'locations', 'geoLat', 'geoLng',
  'salarySource', 'salaryAnnualMin', 'salaryAnnualMax', 'salaryMonths', 'salaryDisclosed',
  'salaryText', 'sourceUrl', 'sourceName', 'originalSourceName', 'originalHost', 'atsType', 'isAgency',
  'fromRecruiterBank', 'employerVerified', 'applicantCount', 'applicantCountSource',
  'applicantCountAt', 'postedAtEstimated', 'expiresAt', 'dedupeKey', 'sourcePriority',
  'searchText', 'publicDisplay', 'fraudFlags', 'marketTags', 'educationLevel',
] as const satisfies readonly (keyof JobUpsertRow)[];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Valid fraud flags (`rule` + `evidence` strings) as JSON text; null when there are none. */
export function fraudFlagsJson(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const flags = value.filter((f) => isRecord(f) && typeof f.rule === 'string' && !!f.rule && typeof f.evidence === 'string');
  return flags.length ? JSON.stringify(flags) : null;
}

/** Valid market tags (`tag` + a non-empty `evidenceQuote`: a tag never renders without its quote) as JSON text; null when none. */
export function marketTagsJson(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const tags = value.filter((t) => isRecord(t) && typeof t.tag === 'string' && !!t.tag && typeof t.evidenceQuote === 'string' && !!t.evidenceQuote.trim());
  return tags.length ? JSON.stringify(tags) : null;
}

const int = (v: number | null): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v));

/**
 * NormalizedJob (+ company id) → the row written. Requires applyUrl (callers skip rows without one).
 * `keepStoredEducation`: the stored row is enriched and holds a level, so a
 * level that comes only from the posting text is not sent (the statement's
 * COALESCE then keeps the stored one). A provider's own label is always sent.
 */
export function toUpsertRow(
  job: NormalizedJob,
  companyId: string | null,
  id: string = newId(),
  options: { keepStoredEducation?: boolean } = {},
): JobUpsertRow {
  const educationFromText = job.fieldSources.educationLevel === 'posting_text';
  const noCount = (NO_APPLICANT_COUNT_PROVIDERS as readonly NormalizeProvider[]).includes(job.provider) || job.provider === 'user_import';
  return {
    id,
    externalId: job.externalId,
    sourceBoard: job.sourceBoard,
    applyUrl: job.applyUrl ?? '',
    title: job.title,
    titleNormalized: job.titleNormalized,
    companyName: job.companyName,
    companyNameNormalized: job.companyNameNormalized,
    companyLogoUrl: job.companyLogoUrl,
    location: job.location,
    locationCity: job.locationCity,
    locationCountry: job.locationCountry,
    // Deprecated NOT NULL column: mirrors workModel; 'onsite' only as the column's legacy placeholder.
    workType: job.workModel ?? 'onsite',
    employmentType: job.employmentType,
    salaryMin: int(job.salaryMin),
    salaryMax: int(job.salaryMax),
    salaryCurrency: job.salaryCurrency,
    salaryPeriod: job.salaryPeriod,
    description: job.description,
    descriptionPlain: job.descriptionPlain,
    postedAt: job.postedAt,
    market: job.market,
    visibility: job.visibility,
    companyId,
    taxonomyIds: job.taxonomyIds,
    primaryTaxonomyId: job.primaryTaxonomyId,
    titleMatchScore: typeof job.titleMatchScore === 'number' && Number.isFinite(job.titleMatchScore) ? job.titleMatchScore : null,
    seniority: job.seniority,
    roleType: job.roleType,
    minYears: int(job.minYears),
    maxYears: int(job.maxYears),
    skills: job.skills,
    workModel: job.workModel,
    remoteScope: job.remoteScope,
    locationRegion: job.locationRegion,
    locations: JSON.stringify(
      job.locations.map((l) => ({ city: l.city, region: l.region, country: l.country, lat: l.lat, lng: l.lng })),
    ),
    geoLat: job.geoLat,
    geoLng: job.geoLng,
    salarySource: job.salarySource,
    salaryAnnualMin: int(job.salaryAnnualMin),
    salaryAnnualMax: int(job.salaryAnnualMax),
    salaryMonths: int(job.salaryMonths),
    salaryDisclosed: job.salaryDisclosed,
    salaryText: job.salaryText,
    sourceUrl: job.sourceUrl,
    sourceName: job.sourceName,
    originalSourceName: job.originalSourceName,
    originalHost: job.originalHost,
    atsType: job.atsType,
    isAgency: job.isAgency,
    fromRecruiterBank: job.fromRecruiterBank,
    employerVerified: job.fromRecruiterBank && job.employerVerified,
    applicantCount: noCount ? null : int(job.applicantCount),
    applicantCountSource: noCount ? null : job.applicantCountSource,
    applicantCountAt: noCount ? null : job.applicantCountAt,
    postedAtEstimated: job.postedAtEstimated,
    expiresAt: job.expiresAt,
    dedupeKey: job.dedupeKey,
    sourcePriority: job.sourcePriority,
    searchText: job.searchText,
    publicDisplay: job.publicDisplay,
    fraudFlags: fraudFlagsJson(job.fraudFlags),
    marketTags: marketTagsJson(job.marketTags),
    educationLevel: options.keepStoredEducation && educationFromText ? null : (job.educationLevel ?? null),
  };
}

/** One VALUES tuple, every parameter explicitly cast (NULLs and empty arrays need a type). */
function valuesTuple(r: JobUpsertRow): Prisma.Sql {
  return Prisma.sql`(${r.id}, ${r.externalId}, ${r.sourceBoard}, ${r.applyUrl}, ${r.title}, ${r.titleNormalized}, ${r.companyName}, ${r.companyNameNormalized},
    ${r.companyLogoUrl}::text, ${r.location}::text, ${r.locationCity}::text, ${r.locationCountry}::text, ${r.workType}, ${r.employmentType}::text,
    ${r.salaryMin}::int, ${r.salaryMax}::int, ${r.salaryCurrency}::text, ${r.salaryPeriod}::text, ${r.description}, ${r.descriptionPlain},
    ${r.postedAt}::timestamp(3), ${r.market}, ${r.visibility}, ${r.companyId}::text, ${r.taxonomyIds}::text[], ${r.primaryTaxonomyId}::text, ${r.titleMatchScore}::real,
    ${r.seniority}::text, ${r.roleType}::text, ${r.minYears}::int, ${r.maxYears}::int, ${r.skills}::text[], ${r.workModel}::text,
    ${r.remoteScope}::text, ${r.locationRegion}::text, ${r.locations}::jsonb, ${r.geoLat}::double precision, ${r.geoLng}::double precision,
    ${r.salarySource}::text, ${r.salaryAnnualMin}::int, ${r.salaryAnnualMax}::int, ${r.salaryMonths}::int, ${r.salaryDisclosed}::boolean,
    ${r.salaryText}::text, ${r.sourceUrl}::text, ${r.sourceName}::text, ${r.originalSourceName}::text, ${r.originalHost}::text, ${r.atsType}::text, ${r.isAgency}::boolean,
    ${r.fromRecruiterBank}::boolean, ${r.employerVerified}::boolean, ${r.applicantCount}::int, ${r.applicantCountSource}::text,
    ${r.applicantCountAt}::timestamp(3), ${r.postedAtEstimated}::boolean, ${r.expiresAt}::timestamp(3), ${r.dedupeKey}, ${r.sourcePriority}::int,
    ${r.searchText}, ${r.publicDisplay}::boolean, ${r.fraudFlags}::jsonb, ${r.marketTags}::jsonb, ${r.educationLevel}::text, now(), now(), now())`;
}

/**
 * ON CONFLICT value of a JSON-list column the row shares with other writers:
 * the stored list plus the incoming entries it does not hold yet (same
 * `keys`). Nothing incoming → the stored value is kept untouched; nothing
 * stored → the incoming list. An entry already stored keeps its own record
 * (its original `at`, or the quote another module verified).
 */
function mergeJsonListSql(column: 'fraudFlags' | 'marketTags', keys: readonly string[]): Prisma.Sql {
  const col = Prisma.raw(`"${column}"`);
  const same = Prisma.raw(keys.map((k) => `o.e->>'${k}' = n.e->>'${k}'`).join(' AND '));
  return Prisma.sql`CASE
        WHEN EXCLUDED.${col} IS NULL OR jsonb_typeof(EXCLUDED.${col}) <> 'array' OR jsonb_array_length(EXCLUDED.${col}) = 0 THEN "RAJob".${col}
        WHEN "RAJob".${col} IS NULL OR jsonb_typeof("RAJob".${col}) <> 'array' THEN EXCLUDED.${col}
        ELSE "RAJob".${col} || COALESCE((
          SELECT jsonb_agg(n.e) FROM jsonb_array_elements(EXCLUDED.${col}) AS n(e)
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements("RAJob".${col}) AS o(e) WHERE ${same})), '[]'::jsonb)
      END`;
}

/**
 * When a refresh may replace the role a stored row holds (MKT-1E request 1, applied at the M1 gate).
 * Enrichment may give a row a role the title alone does not decide (a title match under
 * `TITLE_MATCH_TRUSTED`); the row is not enriched again at the same version, so a refresh that rewrote the
 * role from the same weak match would undo the model's decision each time the provider lists the posting.
 * Ingest's role therefore replaces the stored one only when one of these holds:
 *   - the row was never enriched, or holds no role;
 *   - the title is decisive (score >= 0.9: enrichment itself lets a decisive title win);
 *   - the title changed since the row was stored (the stored role was decided for another title).
 * The column is a 4-byte float: compare with `::real`, never a bare 0.9 (a stored 0.9 reads back as
 * 0.89999998). In ON CONFLICT ... SET, "RAJob".<column> is the stored value before this update.
 */
const ROLE_FROM_INGEST = Prisma.raw(
  `"RAJob"."enrichedAt" IS NULL OR cardinality("RAJob"."taxonomyIds") = 0` +
    ` OR EXCLUDED."titleMatchScore" >= ${TITLE_MATCH_TRUSTED}::real` +
    ` OR "RAJob"."titleNormalized" IS DISTINCT FROM EXCLUDED."titleNormalized"`,
);

/** The batch statement (exported for the SQL snapshot test). */
export function buildJobUpsertSql(rows: JobUpsertRow[]): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "RAJob" ("id", "externalId", "sourceBoard", "applyUrl", "title", "titleNormalized", "companyName", "companyNameNormalized",
      "companyLogoUrl", "location", "locationCity", "locationCountry", "workType", "employmentType",
      "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod", "description", "descriptionPlain",
      "postedAt", "market", "visibility", "companyId", "taxonomyIds", "primaryTaxonomyId", "titleMatchScore",
      "seniority", "roleType", "minYears", "maxYears", "skills", "workModel",
      "remoteScope", "locationRegion", "locations", "geoLat", "geoLng",
      "salarySource", "salaryAnnualMin", "salaryAnnualMax", "salaryMonths", "salaryDisclosed",
      "salaryText", "sourceUrl", "sourceName", "originalSourceName", "originalHost", "atsType", "isAgency",
      "fromRecruiterBank", "employerVerified", "applicantCount", "applicantCountSource",
      "applicantCountAt", "postedAtEstimated", "expiresAt", "dedupeKey", "sourcePriority",
      "searchText", "publicDisplay", "fraudFlags", "marketTags", "educationLevel", "firstSeenAt", "lastSeenAt", "updatedAt")
    VALUES ${Prisma.join(rows.map(valuesTuple))}
    ON CONFLICT ("externalId", "sourceBoard") DO UPDATE SET
      "lastSeenAt" = now(),
      "updatedAt" = now(),
      "applyUrl" = EXCLUDED."applyUrl",
      "title" = EXCLUDED."title",
      "titleNormalized" = EXCLUDED."titleNormalized",
      "companyName" = EXCLUDED."companyName",
      "companyNameNormalized" = EXCLUDED."companyNameNormalized",
      "companyLogoUrl" = EXCLUDED."companyLogoUrl",
      "location" = EXCLUDED."location",
      "locationCity" = EXCLUDED."locationCity",
      "locationCountry" = EXCLUDED."locationCountry",
      "locationRegion" = EXCLUDED."locationRegion",
      "locations" = EXCLUDED."locations",
      "geoLat" = EXCLUDED."geoLat",
      "geoLng" = EXCLUDED."geoLng",
      "workType" = EXCLUDED."workType",
      "workModel" = EXCLUDED."workModel",
      "remoteScope" = EXCLUDED."remoteScope",
      "employmentType" = COALESCE(EXCLUDED."employmentType", "RAJob"."employmentType"),
      "salaryMin" = EXCLUDED."salaryMin",
      "salaryMax" = EXCLUDED."salaryMax",
      "salaryCurrency" = EXCLUDED."salaryCurrency",
      "salaryPeriod" = EXCLUDED."salaryPeriod",
      "salarySource" = EXCLUDED."salarySource",
      "salaryAnnualMin" = EXCLUDED."salaryAnnualMin",
      "salaryAnnualMax" = EXCLUDED."salaryAnnualMax",
      "salaryMonths" = EXCLUDED."salaryMonths",
      "salaryDisclosed" = EXCLUDED."salaryDisclosed",
      "salaryText" = EXCLUDED."salaryText",
      "description" = EXCLUDED."description",
      "descriptionPlain" = EXCLUDED."descriptionPlain",
      "postedAt" = EXCLUDED."postedAt",
      "postedAtEstimated" = EXCLUDED."postedAtEstimated",
      "expiresAt" = EXCLUDED."expiresAt",
      "market" = EXCLUDED."market",
      "companyId" = COALESCE(EXCLUDED."companyId", "RAJob"."companyId"),
      "taxonomyIds" = CASE
        WHEN cardinality(EXCLUDED."taxonomyIds") = 0 THEN "RAJob"."taxonomyIds"
        WHEN ${ROLE_FROM_INGEST} THEN EXCLUDED."taxonomyIds"
        ELSE "RAJob"."taxonomyIds" END,
      "primaryTaxonomyId" = CASE
        WHEN EXCLUDED."primaryTaxonomyId" IS NULL THEN "RAJob"."primaryTaxonomyId"
        WHEN ${ROLE_FROM_INGEST} THEN EXCLUDED."primaryTaxonomyId"
        ELSE "RAJob"."primaryTaxonomyId" END,
      "titleMatchScore" = EXCLUDED."titleMatchScore",
      "seniority" = COALESCE(EXCLUDED."seniority", "RAJob"."seniority"),
      "roleType" = COALESCE(EXCLUDED."roleType", "RAJob"."roleType"),
      "minYears" = COALESCE(EXCLUDED."minYears", "RAJob"."minYears"),
      "maxYears" = COALESCE(EXCLUDED."maxYears", "RAJob"."maxYears"),
      "skills" = CASE WHEN cardinality(EXCLUDED."skills") > 0 THEN EXCLUDED."skills" ELSE "RAJob"."skills" END,
      "educationLevel" = COALESCE(EXCLUDED."educationLevel", "RAJob"."educationLevel"),
      "sourceUrl" = EXCLUDED."sourceUrl",
      "sourceName" = EXCLUDED."sourceName",
      "originalSourceName" = EXCLUDED."originalSourceName",
      "originalHost" = EXCLUDED."originalHost",
      "atsType" = EXCLUDED."atsType",
      "isAgency" = COALESCE(EXCLUDED."isAgency", "RAJob"."isAgency"),
      "fromRecruiterBank" = EXCLUDED."fromRecruiterBank",
      "employerVerified" = EXCLUDED."employerVerified",
      "applicantCount" = EXCLUDED."applicantCount",
      "applicantCountSource" = EXCLUDED."applicantCountSource",
      "applicantCountAt" = EXCLUDED."applicantCountAt",
      "dedupeKey" = EXCLUDED."dedupeKey",
      "sourcePriority" = EXCLUDED."sourcePriority",
      "searchText" = EXCLUDED."searchText",
      "publicDisplay" = EXCLUDED."publicDisplay",
      "fraudFlags" = ${mergeJsonListSql('fraudFlags', ['rule', 'evidence'])},
      "marketTags" = ${mergeJsonListSql('marketTags', ['tag'])},
      "archivedAt" = CASE WHEN "RAJob"."closeReason" IN ('source_removed', 'bank_closed', 'no_apply_target') THEN NULL ELSE "RAJob"."archivedAt" END,
      "closedAt" = CASE WHEN "RAJob"."closeReason" IN ('source_removed', 'bank_closed', 'no_apply_target') THEN NULL ELSE "RAJob"."closedAt" END,
      "closeReason" = CASE WHEN "RAJob"."closeReason" IN ('source_removed', 'bank_closed', 'no_apply_target') THEN NULL ELSE "RAJob"."closeReason" END
    WHERE "RAJob"."visibility" = 'public'
    RETURNING "id", "externalId", "sourceBoard", (xmax = 0) AS "inserted"`;
}

export interface UpsertedJob {
  id: string;
  externalId: string;
  sourceBoard: string;
  inserted: boolean;
}

/** Writes rows in batches of 100. */
export async function upsertJobRows(db: IngestDb, rows: JobUpsertRow[]): Promise<UpsertedJob[]> {
  const out: UpsertedJob[] = [];
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const chunk = rows.slice(i, i + UPSERT_BATCH);
    const result = await db.$queryRaw<UpsertedJob[]>(buildJobUpsertSql(chunk));
    for (const r of result) out.push({ ...r, inserted: r.inserted === true });
  }
  return out;
}

// ── Dedupe ────────────────────────────────────────────────────────────────

export interface DedupeCandidate {
  id: string;
  sourcePriority: number;
  postedAt: Date | null;
  firstSeenAt?: Date | null;
}

/** The canonical ordering: lowest sourcePriority, then newest postedAt (nulls last), then first seen, then id. */
export function compareForCanonical(a: DedupeCandidate, b: DedupeCandidate): number {
  if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
  const pa = a.postedAt?.getTime() ?? null;
  const pb = b.postedAt?.getTime() ?? null;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa;
  }
  const fa = a.firstSeenAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const fb = b.firstSeenAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (fa !== fb) return fa - fb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The canonical row of one dedupe group (null for an empty group). */
export function pickCanonical<T extends DedupeCandidate>(rows: readonly T[]): T | null {
  return rows.length ? [...rows].sort(compareForCanonical)[0]! : null;
}

/**
 * Recomputes isCanonical / canonicalJobId for live public rows of the given
 * keys (`keys` null = every key touched in the last two days: the
 * maintenance repair). Only rows whose flags change are written.
 */
export function buildDedupeSql(market: Market, keys: string[] | null): Prisma.Sql {
  const scope =
    keys === null
      ? Prisma.sql`"dedupeKey" IN (SELECT DISTINCT "dedupeKey" FROM "RAJob" WHERE "market" = ${market} AND "dedupeKey" IS NOT NULL AND "updatedAt" > now() - interval '2 days')`
      : Prisma.sql`"dedupeKey" = ANY(${keys}::text[])`;
  return Prisma.sql`
    WITH ranked AS (
      SELECT "id",
             row_number() OVER w AS rn,
             first_value("id") OVER w AS canon
      FROM "RAJob"
      WHERE "market" = ${market} AND "visibility" = 'public' AND "archivedAt" IS NULL AND ${scope}
      WINDOW w AS (PARTITION BY "dedupeKey" ORDER BY "sourcePriority" ASC, "postedAt" DESC NULLS LAST, "firstSeenAt" ASC, "id" ASC)
    )
    UPDATE "RAJob" AS j
    SET "isCanonical" = (r.rn = 1),
        "canonicalJobId" = CASE WHEN r.rn = 1 THEN NULL ELSE r.canon END
    FROM ranked r
    WHERE j."id" = r."id"
      AND (j."isCanonical" IS DISTINCT FROM (r.rn = 1)
           OR j."canonicalJobId" IS DISTINCT FROM (CASE WHEN r.rn = 1 THEN NULL ELSE r.canon END))`;
}

export async function applyDedupe(db: IngestDb, market: Market, keys: string[] | null): Promise<number> {
  if (keys !== null && keys.length === 0) return 0;
  return db.$executeRaw(buildDedupeSql(market, keys === null ? null : [...new Set(keys)]));
}

/**
 * Archives the postings a source closed itself: a recruiter bank that closed,
 * unpublished or re-drafted a job ('bank_closed', the default), a public job
 * board that stopped listing one ('source_removed'), or a posting with no page
 * a candidate can open ('no_apply_target'). All three are revived by the
 * upsert if the source lists the posting again.
 */
export async function archiveClosedBankJobs(
  db: IngestDb,
  sourceBoard: string,
  externalIds: string[],
  now: Date,
  closeReason: SourceCloseReason = 'bank_closed',
): Promise<number> {
  if (externalIds.length === 0) return 0;
  let count = 0;
  // Chunked: a listing can close thousands of rows at once.
  for (let i = 0; i < externalIds.length; i += 1000) {
    const res = await db.rAJob.updateMany({
      where: { sourceBoard, externalId: { in: externalIds.slice(i, i + 1000) }, archivedAt: null, visibility: 'public' },
      data: { archivedAt: now, closedAt: now, closeReason },
    });
    count += res.count;
  }
  return count;
}

/** Most open rows one listing diff compares (more than any source we read lists). */
const LISTING_DIFF_LIMIT = 20_000;

/**
 * The listing diff (the rule the employer boards use, sources/atsPublic/sync.ts):
 * archives the open public rows of `sourceBoard` in `market` whose externalId
 * is NOT in `listedExternalIds`, the source's complete listing. Call it only
 * with a listing read to its end: a failed or cut-short pass must close
 * nothing. Rows already archived are left alone (their reason stands).
 */
export async function archiveUnlistedJobs(
  db: IngestDb,
  market: Market,
  sourceBoard: string,
  listedExternalIds: readonly string[],
  now: Date,
  closeReason: SourceCloseReason = 'bank_closed',
): Promise<number> {
  const open = await db.rAJob.findMany({
    where: { market, sourceBoard, archivedAt: null, visibility: 'public' },
    select: { externalId: true },
    take: LISTING_DIFF_LIMIT,
  });
  const listed = new Set(listedExternalIds);
  const gone = open.map((r) => r.externalId).filter((id) => !listed.has(id));
  return archiveClosedBankJobs(db, sourceBoard, gone, now, closeReason);
}
