// server/src/features/jobs/sources/atsPublic/hooks.ts — public ATS boards and
// Taiwan market hooks (WP-42), statically imported by features/jobs/marketHooks.ts.
//
//   afterNormalize  ats_public postings (both markets): sourceName = company +
//                   job board ("Appier · Greenhouse"), no separate "original source".
//                   Every ingested or imported posting: the job board its link
//                   names becomes a candidate source (see Discovery below).
//   afterEnrich     Taiwan jobs: work-authorization tags (可協助申請工作許可,
//                   就業金卡) in RAJob.marketTags, each with a verbatim quote
//                   from the posting; tags whose quote left the posting go.
//                   The enrich service sends the row without its location
//                   or links (enrich/repository.ts JOB_SELECT), so when the
//                   posting has a permit sentence (or the row has our tags)
//                   the hook loads locationCountry/locations/sourceUrl/
//                   applyUrl by id before deciding.
//   cardMeta        Taiwan jobs: TwCardMeta for JobMetaTw — pay in the
//                   posting's words (面議 wording kept, never an amount we
//                   made up), the quoted permit tags and the source line.
//
// Honesty (TW-03, JT-1): a 面議 posting, and a 台灣就業通 row that says
// 依學經歷、證照核薪, is "pay not listed". Nothing here claims or implies that
// such a job pays the statutory threshold or more: the Art. 5 clause many of
// these postings repeat ("經常性薪資達4萬元或以上", at whatever amount the
// threshold stands) is removed from the card text and kept only as
// `pay.posted`, which the job page shows as the posting's own words next to
// the note explaining that rule. An amount in another currency or for another
// period ("年薪 USD 60,000 以上") is not that clause and stays. The wording
// list, the clause pattern and its two guards are the pay parser's
// (`CJK_NEGOTIABLE_SOURCE`, `TW_FLOOR_CLAUSE_SOURCE`, `TW_FLOOR_STATUTE_SOURCE`,
// `TW_FLOOR_OTHER_PAY_BEFORE_SOURCE`), imported from normalize/index.ts.
//
// Discovery (MARKET_STRATEGY 1.2, JI-3). afterNormalize also runs for every
// ingested or imported posting of either market: when its link points at a
// public job board, that board is recorded as a candidate source
// (./discovery.ts). It adds nothing to the job and can never fail it.
//
// Importing this module also registers the `ats_public` ingest adapter
// (./register.ts), because marketHooks is the module the pipeline always loads.

import { Prisma } from '../../../../generated/prisma/client.js';
import type { MarketHookContext, MarketHookJob, MarketHookSet } from '../../marketHooks.js';
import { CJK_NEGOTIABLE_SOURCE, TW_FLOOR_CLAUSE_SOURCE, TW_FLOOR_OTHER_PAY_BEFORE_SOURCE, TW_FLOOR_STATUTE_SOURCE } from '../../normalize/index.js';
import { TW_PERMIT_TAGS, type TwCardMeta, type TwPermitTag, type TwPermitTagView } from './contract.js';
import { noteDiscoveredBoard, type DiscoveryOutcome } from './discovery.js';
import { extractPermitTags, quoteInPosting, type PermitTagEvidence } from './permitTags.js';
import { atsSourceName, isPublicAts } from './shared.js';
import type { CareerSourceDb } from './sync.js';
import './register.js';

type HookDb = Pick<CareerSourceDb, 'rAJob'>;

export interface AtsPublicHookDeps {
  db?: () => Promise<HookDb> | HookDb;
  /** Records the board a posting's link names (default: the process-wide collector of ./discovery.ts). */
  discover?: (job: MarketHookJob, ctx: Pick<MarketHookContext, 'stage'>) => Promise<DiscoveryOutcome | void>;
  /** Longest a posting waits for that record (default DISCOVERY_WAIT_MS). */
  discoverWaitMs?: number;
}

/** A posting never waits longer than this for its board to be recorded; the record itself still completes. */
export const DISCOVERY_WAIT_MS = 1500;

/** Stages whose postings can name a board: the ingest run and a user's import. */
function discovers(ctx: Pick<MarketHookContext, 'stage'> | undefined): boolean {
  return ctx?.stage === 'ingest' || ctx?.stage === 'import';
}

async function defaultDb(): Promise<HookDb> {
  return (await import('../../../../lib/prisma.js')).default;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A job in Taiwan: its country, or any of its locations, is TW. */
export function isTaiwanJob(job: MarketHookJob): boolean {
  if (s(job.locationCountry)?.toUpperCase() === 'TW') return true;
  const locs = Array.isArray(job.locations) ? job.locations : [];
  return locs.some((l) => !!l && typeof l === 'object' && s((l as Record<string, unknown>).country)?.toUpperCase() === 'TW');
}

interface MarketTag {
  tag: string;
  evidenceQuote: string;
  evidenceUrl: string | null;
}

export function readMarketTags(v: unknown): MarketTag[] {
  if (!Array.isArray(v)) return [];
  const out: MarketTag[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const { tag, evidenceQuote, evidenceUrl } = item as Record<string, unknown>;
    if (typeof tag !== 'string' || typeof evidenceQuote !== 'string' || !evidenceQuote) continue;
    out.push({ tag, evidenceQuote, evidenceUrl: typeof evidenceUrl === 'string' ? evidenceUrl : null });
  }
  return out;
}

const OWNED = new Set<string>(TW_PERMIT_TAGS);

// The "pay not listed" wording, the Art. 5 clause, the statute's own term and
// the other-currency guard are the pay parser's (normalize/salary.ts), imported
// through its index: one rule, one place. `TW_NEGOTIABLE_SOURCE` is the
// parser's Chinese list (面議, 依公司規定, 依學經歷、證照核薪 …); English
// "competitive salary" / "DOE" are not 面議 and get no note.
export const TW_NEGOTIABLE_SOURCE = CJK_NEGOTIABLE_SOURCE;
export { TW_FLOOR_CLAUSE_SOURCE, TW_FLOOR_OTHER_PAY_BEFORE_SOURCE, TW_FLOOR_STATUTE_SOURCE };
const TW_NEGOTIABLE_RE = new RegExp(TW_NEGOTIABLE_SOURCE);

const TW_FLOOR_CLAUSE_RE = new RegExp(TW_FLOOR_CLAUSE_SOURCE, 'g');
const TW_FLOOR_STATUTE_RE = new RegExp(TW_FLOOR_STATUTE_SOURCE);
const TW_FLOOR_OTHER_PAY_BEFORE_RE = new RegExp(TW_FLOOR_OTHER_PAY_BEFORE_SOURCE, 'i');
const EMPTY_BRACKETS_RE = /[(（【\[]\s*[)）】\]]/g;
const EDGE_PUNCT_RE = /^[\s，,、;；:：\-–—/|]+|[\s，,、;；:：\-–—/|]+$/g;

/** Is a clause-shaped match at `offset` an amount in another currency or for another period (so not the clause)? */
function otherPayBefore(text: string, offset: number): boolean {
  return TW_FLOOR_OTHER_PAY_BEFORE_RE.test(text.slice(0, offset));
}

/**
 * The pay text carries the statute's own clause ("每月經常性薪資達4萬元以上"): by
 * itself "pay not listed". The form without 以上 ("經常性薪資5萬元") is not: alone
 * it is an amount the posting states (the parser's kind `statute_open`).
 */
function hasStatuteClause(text: string): boolean {
  for (const m of text.matchAll(TW_FLOOR_CLAUSE_RE)) {
    if (TW_FLOOR_STATUTE_RE.test(m[0]) && /以上$/.test(m[0]) && !otherPayBefore(text, m.index ?? 0)) return true;
  }
  return false;
}

/**
 * Card pay text for a "pay not listed" posting of a job in Taiwan: the
 * posting's words without the Art. 5 clause (null when nothing is left).
 */
export function twNegotiableCardText(text: string): string | null {
  const out = text
    .replace(TW_FLOOR_CLAUSE_RE, (clause: string, offset: number, whole: string) => (otherPayBefore(whole, offset) ? clause : ''))
    .replace(EMPTY_BRACKETS_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(EDGE_PUNCT_RE, '');
  return out.trim() || null;
}

/**
 * True when the posting lists no amount and its pay text says 面議 /
 * 依公司規定 / 依學經歷、證照核薪 (Taiwan wording), or is the statute's own
 * clause standing alone.
 */
export function isTwNegotiable(text: string | null, disclosed: boolean): boolean {
  if (disclosed || !text) return false;
  const s = text.normalize('NFKC');
  return TW_NEGOTIABLE_RE.test(s) || hasStatuteClause(s);
}

/** The job's market tags with this module's permit tags replaced by `fresh`. */
export function mergePermitTags(existing: unknown, fresh: readonly PermitTagEvidence[]): MarketTag[] {
  return [...readMarketTags(existing).filter((t) => !OWNED.has(t.tag)), ...fresh];
}

function postingText(job: MarketHookJob): string | null {
  return s(job.descriptionPlain) ?? s(job.description);
}

/** ats_public postings: sourceName = company + job board; the posting is its own original source. */
export function withAtsSourceName(job: MarketHookJob): MarketHookJob {
  if (job.provider !== 'ats_public') return job;
  const board = s(job.sourceBoard)?.toLowerCase();
  const company = s(job.companyName);
  if (!isPublicAts(board) || !company) return job;
  return { ...job, sourceName: atsSourceName(company, board), originalSourceName: null };
}

/** Card meta for a Taiwan job (null otherwise). Pure; never throws on odd rows. */
export function twCardMeta(job: MarketHookJob): TwCardMeta | null {
  if (job.market !== 'intl' || !isTaiwanJob(job)) return null;
  const posted = s(job.salaryText);
  const disclosed = job.salaryDisclosed === true;
  const negotiable = isTwNegotiable(posted, disclosed);
  const text = negotiable && posted ? twNegotiableCardText(posted) : posted;
  const posting = postingText(job);
  const permitTags: TwPermitTagView[] = [];
  for (const t of readMarketTags(job.marketTags)) {
    if (!OWNED.has(t.tag) || permitTags.some((p) => p.tag === t.tag)) continue;
    // A tag shows only with its quote, and only while the posting still says it.
    if (posting && !quoteInPosting(t.evidenceQuote, posting)) continue;
    permitTags.push({ tag: t.tag as TwPermitTag, quote: t.evidenceQuote });
  }
  const board = s(job.atsType) ?? s(job.sourceBoard);
  return {
    country: 'TW',
    pay: { text, posted, disclosed, negotiable },
    permitTags,
    source: {
      name: s(job.sourceName),
      url: s(job.sourceUrl) ?? s(job.applyUrl),
      board: isPublicAts(board) ? board : null,
    },
  };
}

/** The fields afterEnrich needs that the enrich service does not send. */
const PLACE_AND_LINKS = { locationCountry: true, locations: true, sourceUrl: true, applyUrl: true } as const;

function hasPlace(job: MarketHookJob): boolean {
  return !!s(job.locationCountry) || (Array.isArray(job.locations) && job.locations.length > 0);
}

export function createAtsPublicHooks(deps: AtsPublicHookDeps = {}): MarketHookSet {
  return {
    id: 'ats_public',
    // ats_public postings of either market get their source name (company + job board).
    // Every ingested or imported posting, of either market and any provider, may name a board (discovery).
    // Every intl enrich call: the enrich row carries no location, so whether the job is in
    // Taiwan is decided inside afterEnrich (see header). The Taiwan parts stay international-only.
    appliesTo: (job, ctx) => job.provider === 'ats_public' || discovers(ctx) || (job.market === 'intl' && (ctx?.stage === 'enrich' || isTaiwanJob(job))),
    async afterNormalize(job, ctx) {
      const named = withAtsSourceName(job);
      if (discovers(ctx)) {
        // Never in the way: no throw reaches the caller, and a slow database is not waited for.
        const noted = Promise.resolve()
          .then(() => (deps.discover ?? noteDiscoveredBoard)(named, ctx))
          .catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deps.discoverWaitMs ?? DISCOVERY_WAIT_MS);
        });
        await Promise.race([noted, cap]);
        if (timer) clearTimeout(timer);
      }
      return named;
    },
    async afterEnrich(job) {
      const id = s(job.id);
      if (!id || job.market !== 'intl') return;
      const candidates = extractPermitTags(postingText(job));
      const before = readMarketTags(job.marketTags);
      // Nothing to add and none of our tags to re-check: no database work.
      if (!candidates.length && !before.some((t) => OWNED.has(t.tag))) return;
      let db: HookDb | null = null;
      let full: MarketHookJob = job;
      if (!hasPlace(job) || !(s(job.sourceUrl) ?? s(job.applyUrl))) {
        db = await (deps.db ?? defaultDb)();
        const row = await db.rAJob.findUnique({ where: { id }, select: PLACE_AND_LINKS });
        if (!row) return;
        full = {
          ...job,
          locationCountry: s(job.locationCountry) ?? row.locationCountry,
          locations: hasPlace(job) ? job.locations : row.locations,
          sourceUrl: s(job.sourceUrl) ?? row.sourceUrl,
          applyUrl: s(job.applyUrl) ?? row.applyUrl,
        };
      }
      const url = s(full.sourceUrl) ?? s(full.applyUrl);
      const fresh = isTaiwanJob(full) ? candidates.map((t) => ({ ...t, evidenceUrl: url })) : [];
      const next = mergePermitTags(job.marketTags, fresh);
      if (JSON.stringify(before) === JSON.stringify(next)) return;
      db ??= await (deps.db ?? defaultDb)();
      await db.rAJob.update({ where: { id }, data: { marketTags: next.length ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    },
    cardMeta: (job) => twCardMeta(job) as unknown as Record<string, unknown> | null,
  };
}

export const atsPublicHooks: MarketHookSet = createAtsPublicHooks();

