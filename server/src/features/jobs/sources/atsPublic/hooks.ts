// server/src/features/jobs/sources/atsPublic/hooks.ts — public ATS boards and
// Taiwan market hooks (WP-42), statically imported by features/jobs/marketHooks.ts.
//
//   afterNormalize  ats_public postings (both markets): sourceName = company +
//                   job board ("Appier · Greenhouse"), no separate "original source".
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
// Honesty (TW-03): a 面議 posting is "pay not listed". Nothing here claims or
// implies that such a job pays NT$40,000 or more: the Art. 5 floor clause many
// 面議 postings repeat ("經常性薪資達4萬元或以上") is removed from the card
// text and kept only as `pay.posted`, which the job page shows as the
// posting's own words next to the note explaining that rule.
//
// Importing this module also registers the `ats_public` ingest adapter
// (./register.ts), because marketHooks is the module the pipeline always loads.

import { Prisma } from '../../../../generated/prisma/client.js';
import type { MarketHookJob, MarketHookSet } from '../../marketHooks.js';
import { TW_PERMIT_TAGS, type TwCardMeta, type TwPermitTag, type TwPermitTagView } from './contract.js';
import { extractPermitTags, quoteInPosting, type PermitTagEvidence } from './permitTags.js';
import { atsSourceName, isPublicAts } from './shared.js';
import type { CareerSourceDb } from './sync.js';
import './register.js';

type HookDb = Pick<CareerSourceDb, 'rAJob'>;

export interface AtsPublicHookDeps {
  db?: () => Promise<HookDb> | HookDb;
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

/** Taiwan "pay not listed" wording. English "competitive salary" / "DOE" are not 面議 and get no note. */
const TW_NEGOTIABLE_RE = /待遇面議|薪資面議|薪资面议|薪酬面议|面議|面议|依公司規定|依公司规定|按公司規定|按公司规定/;

/**
 * The Employment Services Act Art. 5 floor clause a 面議 posting repeats
 * ("經常性薪資達4萬元或以上", "月薪 NT$40,000 以上"). Digit look-behinds keep a
 * real figure such as "104萬以上" or "140,000以上" out of it.
 */
const TW_FLOOR_CLAUSE_RE = new RegExp(
  String.raw`(?:經常性|经常性)?(?:薪資|薪资|月薪)?\s*(?:達|达)?\s*(?:新台幣|新臺幣|新台币|NT\$|NTD)?\s*` +
    String.raw`(?:(?<![\d０-９.,，〇一二三四五六七八九十百千])[4４四]\s*[萬万]|(?<![\d０-９.,，])[4４][0０][,，]?[0０]{3})` +
    String.raw`\s*元?\s*(?:[(（]含[)）])?\s*(?:或)?\s*以上`,
  'g',
);
const EMPTY_BRACKETS_RE = /[(（【\[]\s*[)）】\]]/g;
const EDGE_PUNCT_RE = /^[\s，,、;；:：\-–—/|]+|[\s，,、;；:：\-–—/|]+$/g;

/** Card pay text for a 面議 posting: the posting's words without the Art. 5 floor clause (null when nothing is left). */
export function twNegotiableCardText(text: string): string | null {
  const out = text.replace(TW_FLOOR_CLAUSE_RE, '').replace(EMPTY_BRACKETS_RE, '').replace(/\s{2,}/g, ' ').replace(EDGE_PUNCT_RE, '');
  return out.trim() || null;
}

/** True when the pay text says 面議 / 依公司規定 (Taiwan wording) and the posting lists no amount. */
export function isTwNegotiable(text: string | null, disclosed: boolean): boolean {
  return !disclosed && !!text && TW_NEGOTIABLE_RE.test(text.normalize('NFKC'));
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
    // Every intl enrich call: the enrich row carries no location, so whether
    // the job is in Taiwan is decided inside afterEnrich (see header).
    // ats_public postings of either market get their source name (company + job board);
    // the Taiwan parts below stay international-only.
    appliesTo: (job, ctx) => job.provider === 'ats_public' || (job.market === 'intl' && (ctx?.stage === 'enrich' || isTaiwanJob(job))),
    afterNormalize: (job) => withAtsSourceName(job),
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

