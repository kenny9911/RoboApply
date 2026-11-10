// server/src/features/growth/visitors.ts — the visitor record (visitor
// conversion): one RAVisitor row per visitor, saying where they came from and
// how far they got toward an account.
//
//   visitor → opened sign-up or sign-in → started (form sent or provider
//   chosen) → account created (→ finished setup, read from the profile by the
//   admin report, never stored here)
//
// Rows are written by the events ingest only (service.ts `ingestEvents` calls
// `record` with the batch it just stored); there is no route that writes one.
//
// Privacy rules (the same as events.ts; PRODUCT_PLAN.md §4.1 "Analytics"):
//   - A row is keyed by the first-party `ra_anon` id, so it exists only where
//     analytics linking is allowed. A RoboApply visitor in the EEA, the UK or
//     Switzerland who was not asked yet, or said no, gets no row: the consent
//     banner promises their page views are counted and linked to nothing.
//   - The User-Agent is reduced to desktop / mobile / tablet and the IP to the
//     edge country; neither string is stored.
//   - The account is linked only from the signed-in session of the same
//     browser (never from an e-mail address or any other guess).
//   - Rows go with the account (cascade + `deleteForUser`) and 13 months
//     after the last visit (`prune`; the `product_events` retention rule).
//
// First-touch fields (landing page, referrer, campaign, channel, country,
// device, locale) are set when the row is created and never overwritten;
// funnel stamps keep the first time; counters add up.

import type prismaClient from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import { ANON_ID_RE, EVENT_RETENTION_DAYS, type EventPropValue } from './events.js';

type PrismaClientLike = typeof prismaClient;
export type VisitorDb = Pick<PrismaClientLike, 'rAVisitor' | 'user'>;

// ── Vocabulary ───────────────────────────────────────────────────────────

/** How the visitor first arrived (`RAVisitor.channel`). */
export const VISITOR_CHANNELS = ['direct', 'search', 'ai', 'social', 'email', 'paid', 'campaign', 'invite', 'referral'] as const;
export type VisitorChannel = (typeof VISITOR_CHANNELS)[number];

export const VISITOR_DEVICES = ['desktop', 'mobile', 'tablet'] as const;
export type VisitorDevice = (typeof VISITOR_DEVICES)[number];

/** `signup_started.method` values kept on the row; anything else is dropped. */
export const SIGNUP_METHODS = ['email', 'google', 'line', 'phone', 'wechat'] as const;
export type SignupMethod = (typeof SIGNUP_METHODS)[number];

/**
 * An account created up to this long before the visitor row counts as this
 * visitor's sign-up. The row can start after the account does: a visitor in
 * the EEA who answers the consent banner right after signing up, or a browser
 * whose first batch was lost. Past it, the visitor was already a user.
 */
export const SIGNUP_GRACE_MS = 30 * 60 * 1000;

// ── Pure helpers ─────────────────────────────────────────────────────────

const BOT_UA_RE =
  /bot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|scrape|node-fetch|undici|curl|wget|python|axios|okhttp|java\/|go-http|phantom|puppeteer|playwright|selenium|facebookexternalhit|bytespider/i;

/** Automated clients are not visitors. No User-Agent at all is treated the same way. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent || !userAgent.trim()) return true;
  return BOT_UA_RE.test(userAgent);
}

/** Device class of a browser User-Agent; null when it cannot be told. */
export function deviceFromUserAgent(userAgent: string | null | undefined): VisitorDevice | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk|kindle/.test(ua) || (ua.includes('android') && !ua.includes('mobile'))) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone|harmonyos/.test(ua)) return 'mobile';
  return 'desktop';
}

/** `www.` and a port removed, lowercase; null for anything that is not a host name. */
export function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  return /^[a-z0-9.-]{1,253}$/.test(h) && h.includes('.') ? h : null;
}

const SEARCH_HOST_RE = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|sogou|naver|ecosia|startpage|qwant|kagi)\.|(^|\.)(so\.com|sm\.cn|search\.brave\.com|daum\.net)$/;
const AI_HOST_RE =
  /(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|anthropic\.com|copilot\.microsoft\.com|you\.com|phind\.com|poe\.com|kimi\.com|moonshot\.cn|doubao\.com|deepseek\.com|yuanbao\.tencent\.com|tongyi\.com|chatglm\.cn|metaso\.cn)$|^gemini\.google\.com$/;
const SOCIAL_HOST_RE =
  /(^|\.)(facebook\.com|fb\.com|instagram\.com|threads\.net|x\.com|twitter\.com|t\.co|linkedin\.com|lnkd\.in|reddit\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.com|medium\.com|quora\.com|discord\.com|telegram\.org|t\.me|line\.me|ptt\.cc|dcard\.tw|weibo\.com|weibo\.cn|zhihu\.com|xiaohongshu\.com|douyin\.com|bilibili\.com|weixin\.qq\.com|douban\.com|news\.ycombinator\.com|producthunt\.com)$/;
const PAID_MEDIUM_RE = /^(cpc|ppc|cpm|cpa|paid|paidsearch|paid[-_]social|display|ads?|sem|affiliate|sponsored)$/;
const EMAIL_MEDIUM_RE = /^(e-?mail|newsletter|edm)$/;
const INVITE_PATH_RE = /^\/r\/[^/]+/;

/**
 * The channel of a first touch. A campaign label wins over the referrer (a
 * paid search click carries both); the AI check runs before search because
 * `gemini.google.com` is a Google host.
 */
export function classifyChannel(touch: {
  referrerHost?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  landingPath?: string | null;
}): VisitorChannel {
  const medium = touch.utmMedium?.trim().toLowerCase() ?? '';
  if (medium && PAID_MEDIUM_RE.test(medium)) return 'paid';
  if (medium && EMAIL_MEDIUM_RE.test(medium)) return 'email';
  if (touch.utmSource || touch.utmCampaign || medium) return 'campaign';
  if (touch.landingPath && INVITE_PATH_RE.test(touch.landingPath)) return 'invite';
  const host = normalizeHost(touch.referrerHost);
  if (!host) return 'direct';
  if (AI_HOST_RE.test(host)) return 'ai';
  if (SEARCH_HOST_RE.test(host)) return 'search';
  if (SOCIAL_HOST_RE.test(host)) return 'social';
  return 'referral';
}

// `/signup`, `/login`, with an optional locale prefix (`/zh-TW/signup`).
const AUTH_ENTRY_PATH_RE = /^(?:\/[a-z]{2}(?:-[A-Za-z]{2,4})?)?\/(signup|login)\/?$/;

/** Is this the sign-up or sign-in page? */
export function isAuthEntryPath(path: string | null | undefined): boolean {
  return !!path && AUTH_ENTRY_PATH_RE.test(path);
}

/** One stored event, as the ingest wrote it (already sanitized). */
export interface VisitEvent {
  name: string;
  props?: Record<string, EventPropValue> | null;
  path?: string | null;
  at: Date;
}

/** What one batch says about the visit. */
export interface VisitSummary {
  firstAt: Date;
  lastAt: Date;
  pageViews: number;
  landingPath: string | null;
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  locale: string | null;
  signupViewedAt: Date | null;
  signupFrom: string | null;
  signupStartedAt: Date | null;
  signupMethod: SignupMethod | null;
}

/** Pages one `visit_entry` may add (a page load does not view more before the banner is answered). */
const MAX_ENTRY_PAGES = 200;

function str(value: EventPropValue | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, max);
  return s || null;
}

/** Read a batch of stored events, oldest first. Null for an empty batch. */
export function summarizeVisit(events: readonly VisitEvent[]): VisitSummary | null {
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: VisitSummary = {
    firstAt: sorted[0]!.at,
    lastAt: sorted[sorted.length - 1]!.at,
    pageViews: 0,
    landingPath: null,
    referrerHost: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    locale: null,
    signupViewedAt: null,
    signupFrom: null,
    signupStartedAt: null,
    signupMethod: null,
  };
  let campaignSeen = false;
  let landingSeen = false;
  for (const ev of sorted) {
    const props = ev.props ?? {};
    // `visit_entry`: how this visit began, sent after "Allow" for the pages
    // that were counted without an id. It reads like the first page view,
    // and adds the number of pages it stands for.
    const entry = ev.name === 'visit_entry';
    if (ev.name === 'page_viewed' || entry) {
      if (entry) {
        const pages = typeof props.pages === 'number' && Number.isFinite(props.pages) ? Math.floor(props.pages) : 0;
        out.pageViews += Math.min(Math.max(pages, 0), MAX_ENTRY_PAGES);
      } else {
        out.pageViews += 1;
      }
      if (!landingSeen) {
        landingSeen = true;
        out.landingPath = ev.path ?? null;
      }
      out.referrerHost ??= normalizeHost(str(props.referrerHost, 253));
      out.locale ??= str(props.locale, 16);
      // The campaign of the first page opened with one (all three from the same view).
      if (!campaignSeen && (props.utmSource || props.utmMedium || props.utmCampaign)) {
        campaignSeen = true;
        out.utmSource = str(props.utmSource, 120);
        out.utmMedium = str(props.utmMedium, 120);
        out.utmCampaign = str(props.utmCampaign, 120);
      }
      if (!out.signupViewedAt && isAuthEntryPath(ev.path)) {
        out.signupViewedAt = ev.at;
        out.signupFrom = str(props.from, 80);
      }
    } else if (ev.name === 'signup_started' && !out.signupStartedAt) {
      out.signupStartedAt = ev.at;
      const method = str(props.method, 20);
      out.signupMethod = (SIGNUP_METHODS as readonly string[]).includes(method ?? '') ? (method as SignupMethod) : null;
    }
  }
  return out;
}

/**
 * Was the account created by this visitor (after they were first seen, with
 * `SIGNUP_GRACE_MS` of slack), or did they already have it?
 */
export function accountOutcome(firstSeenAt: Date, accountCreatedAt: Date): { signedUpAt: Date | null; knownUser: boolean } {
  const converted = accountCreatedAt.getTime() >= firstSeenAt.getTime() - SIGNUP_GRACE_MS;
  return converted ? { signedUpAt: accountCreatedAt, knownUser: false } : { signedUpAt: null, knownUser: true };
}

// ── Recorder ─────────────────────────────────────────────────────────────

export interface RecordVisitInput {
  brand: string;
  /** The `ra_anon` id the ingest accepted (linking allowed), else null. */
  anonId: string | null;
  /** The session user the ingest may link (linking allowed), else null. */
  userId: string | null;
  /** Edge country (uppercase ISO-3166 alpha-2), or null. */
  country: string | null;
  userAgent: string | null;
  /** The client's in-memory id of this page load. */
  visitId: string | null;
  events: readonly VisitEvent[];
}

export type RecordVisitResult = 'recorded' | 'skipped' | 'unavailable';

export interface VisitorRecorder {
  /** Create or update the visitor row of a stored batch. Never throws. */
  record(input: RecordVisitInput): Promise<RecordVisitResult>;
  /** Account wipe: rows of the user, and unlinked rows of their anonymous ids. */
  deleteForUser(userId: string, anonIds: readonly string[]): Promise<number>;
  /** Retention: rows last seen before the cutoff (default ≈13 months ago). */
  prune(options?: { now?: Date; retentionDays?: number }): Promise<number>;
}

export interface VisitorRecorderDeps {
  db?: VisitorDb | (() => Promise<VisitorDb>);
  now?: () => Date;
}

/** Prisma: the table (P2021) or a column (P2022) is not in the database yet. */
function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'P2021' || code === 'P2022';
}

/** After a missing-table error, writes are skipped this long before trying again. */
export const VISITOR_TABLE_RETRY_MS = 5 * 60 * 1000;

export function createVisitorRecorder(deps: VisitorRecorderDeps = {}): VisitorRecorder {
  const now = deps.now ?? (() => new Date());
  let unavailableUntil = 0;

  async function db(): Promise<VisitorDb> {
    if (typeof deps.db === 'function') return deps.db();
    if (deps.db) return deps.db;
    return (await import('../../lib/prisma.js')).default;
  }

  async function write(input: RecordVisitInput & { anonId: string }, visit: VisitSummary): Promise<void> {
    const d = await db();
    const where = { brand: input.brand, anonId: input.anonId };
    const select = { id: true, firstSeenAt: true, lastSeenAt: true, lastVisitId: true, signupViewedAt: true, signupStartedAt: true, userId: true } as const;
    let row = await d.rAVisitor.findFirst({ where, select });

    if (!row) {
      const data: Prisma.RAVisitorUncheckedCreateInput = {
        ...where,
        firstSeenAt: visit.firstAt,
        lastSeenAt: visit.lastAt,
        landingPath: visit.landingPath,
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
        channel: classifyChannel(visit),
        country: input.country,
        device: deviceFromUserAgent(input.userAgent),
        locale: visit.locale,
        pageViews: visit.pageViews,
        visits: 1,
        lastVisitId: input.visitId,
        signupViewedAt: visit.signupViewedAt,
        signupFrom: visit.signupFrom,
        signupStartedAt: visit.signupStartedAt,
        signupMethod: visit.signupMethod,
      };
      try {
        row = await d.rAVisitor.create({ data, select });
      } catch (err) {
        // Another batch of the same visitor created the row first: update it instead.
        if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
        row = await d.rAVisitor.findFirst({ where, select });
        if (!row) throw err;
        await update(d, row, input, visit);
      }
    } else {
      await update(d, row, input, visit);
    }

    // The account: linked once, from the signed-in session of this browser.
    if (input.userId && !row.userId) {
      const user = await d.user.findUnique({ where: { id: input.userId }, select: { createdAt: true } });
      if (user) {
        const firstSeenAt = visit.firstAt < row.firstSeenAt ? visit.firstAt : row.firstSeenAt;
        await d.rAVisitor.update({ where: { id: row.id }, data: { userId: input.userId, ...accountOutcome(firstSeenAt, user.createdAt) } });
      }
    }
  }

  async function update(
    d: VisitorDb,
    row: { id: string; firstSeenAt: Date; lastSeenAt: Date; lastVisitId: string | null; signupViewedAt: Date | null; signupStartedAt: Date | null },
    input: RecordVisitInput,
    visit: VisitSummary,
  ): Promise<void> {
    const data: Prisma.RAVisitorUncheckedUpdateInput = {};
    if (visit.firstAt < row.firstSeenAt) data.firstSeenAt = visit.firstAt;
    if (visit.lastAt > row.lastSeenAt) data.lastSeenAt = visit.lastAt;
    if (visit.pageViews) data.pageViews = { increment: visit.pageViews };
    if (input.visitId && input.visitId !== row.lastVisitId) {
      data.visits = { increment: 1 };
      data.lastVisitId = input.visitId;
    }
    if (!row.signupViewedAt && visit.signupViewedAt) {
      data.signupViewedAt = visit.signupViewedAt;
      data.signupFrom = visit.signupFrom;
    }
    if (!row.signupStartedAt && visit.signupStartedAt) {
      data.signupStartedAt = visit.signupStartedAt;
      data.signupMethod = visit.signupMethod;
    }
    if (Object.keys(data).length) await d.rAVisitor.update({ where: { id: row.id }, data });
  }

  return {
    async record(input) {
      if (!input.anonId || !ANON_ID_RE.test(input.anonId)) return 'skipped';
      if (isBotUserAgent(input.userAgent)) return 'skipped';
      const visit = summarizeVisit(input.events);
      if (!visit) return 'skipped';
      if (now().getTime() < unavailableUntil) return 'unavailable';
      try {
        await write({ ...input, anonId: input.anonId }, visit);
        return 'recorded';
      } catch (err) {
        // The visitor record must never break event ingest (or the page behind it).
        if (isMissingTable(err)) {
          unavailableUntil = now().getTime() + VISITOR_TABLE_RETRY_MS;
          logger.warn('GROWTH', 'visitor table is not in the database yet (SCHEMA-9 not applied); visitors are not recorded');
        } else {
          logger.warn('GROWTH', 'visitor record failed', { error: err instanceof Error ? err.message : String(err) });
        }
        return 'unavailable';
      }
    },

    async deleteForUser(userId, anonIds) {
      const ids = [...new Set(anonIds)].filter((id) => ANON_ID_RE.test(id));
      // Like the events: an anonymous id's row goes only while no account holds
      // it (on a shared browser it can belong to someone else).
      const where: Prisma.RAVisitorWhereInput = ids.length ? { OR: [{ userId }, { anonId: { in: ids }, userId: null }] } : { userId };
      const { count } = await (await db()).rAVisitor.deleteMany({ where });
      return count;
    },

    async prune(options = {}) {
      const days = options.retentionDays ?? EVENT_RETENTION_DAYS;
      const cutoff = new Date((options.now ?? now()).getTime() - days * 24 * 60 * 60 * 1000);
      const { count } = await (await db()).rAVisitor.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
      return count;
    },
  };
}

export const visitorRecorderImpl: VisitorRecorder = createVisitorRecorder();
