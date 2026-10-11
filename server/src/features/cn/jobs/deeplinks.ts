// server/src/features/cn/jobs/deeplinks.ts — external search deep links (CN L-5; MARKET_STRATEGY JC-5).
//
// Mainland job boards are never integrated: no scraping, no fetching, no
// autofill, no greeting. The user may open a search on those sites for their
// OWN query: the link carries the query (and the city they typed, as part of
// the keyword) and nothing else — no user id, no profile data, no tracking
// parameter. The page opens it with rel="noopener noreferrer".
//
// Nine boards are named here; a board is offered only once its search URL
// pattern has been confirmed (`verifiedOn`). To confirm one: open the
// candidate search URL with a test keyword in an ordinary browser, signed out,
// and check that the site's own search page loads with that keyword applied
// and that the URL carries nothing but the keyword. Then fill `host`, `url`
// and `verifiedOn` on its row. A pattern is never typed from memory (D3): an
// unconfirmed board has no URL in this file at all and is never returned.
//
// Order: the boards of the user's audience first (校招 users see the campus
// boards first), then the others; nothing is hidden. The response order is
// the display order.
//
// Board names are proper nouns and live in this server file, not in a locale
// bundle (the copy gate bans two of them in zh copy).
//
// This module has no static import besides types: the jobs pipeline loads the
// cn/jobs area through its market hooks, and it must not pull the onboarding
// area or the database client in with it. The one database read
// (`cnIdentityOf`) loads both when it is called, and the logger is loaded
// only when that read fails.

import type { CnBoardAudience, CnExternalBoard, CnLinkAudience, ExternalLinksResponse } from './contract.js';

/**
 * `verifiedOn` of the three boards WP-41 shipped before the confirmation rule
 * existed: no check date was recorded for them, and none is made up here.
 * Whoever confirms one of the three replaces the marker with that day's date.
 * No other board may carry it (deeplinks.test.ts).
 */
export const SHIPPED_BEFORE_VERIFICATION_RULE = 'wp41';

interface BoardBase {
  board: CnExternalBoard;
  /** The site's own name (a proper noun; shown as is). */
  label: string;
  /** Who the board is mainly for; decides the order, never whether it is shown. */
  audience: CnBoardAudience;
}

/** A board whose search URL pattern has been confirmed in a browser. */
export interface VerifiedBoardSpec extends BoardBase {
  /** The one host the search page lives on. A built URL on any other host is refused. */
  host: string;
  url: (keyword: string) => string;
  /** The day the pattern was confirmed ('YYYY-MM-DD'), or SHIPPED_BEFORE_VERIFICATION_RULE. */
  verifiedOn: string;
}

/** A board whose pattern nobody has confirmed yet: named, never linked. */
export interface UnverifiedBoardSpec extends BoardBase {
  host: null;
  url: null;
  verifiedOn: null;
}

export type BoardSpec = VerifiedBoardSpec | UnverifiedBoardSpec;

const unverified = (board: CnExternalBoard, label: string, audience: CnBoardAudience): UnverifiedBoardSpec => ({ board, label, audience, host: null, url: null, verifiedOn: null });

/**
 * The nine boards, each audience's in its display order (experienced: BOSS直聘,
 * 智联招聘, 猎聘, 前程无忧, 拉勾; campus: 实习僧, 牛客, 24365, 国聘).
 */
export const CN_EXTERNAL_BOARD_SPECS: readonly BoardSpec[] = [
  { board: 'boss', label: 'BOSS直聘', audience: 'experienced', host: 'www.zhipin.com', url: (k) => `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(k)}`, verifiedOn: SHIPPED_BEFORE_VERIFICATION_RULE },
  { board: 'zhaopin', label: '智联招聘', audience: 'experienced', host: 'sou.zhaopin.com', url: (k) => `https://sou.zhaopin.com/?kw=${encodeURIComponent(k)}`, verifiedOn: SHIPPED_BEFORE_VERIFICATION_RULE },
  { board: 'liepin', label: '猎聘', audience: 'experienced', host: 'www.liepin.com', url: (k) => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(k)}`, verifiedOn: SHIPPED_BEFORE_VERIFICATION_RULE },
  // Not confirmed yet (MARKET_TASK_PLAN, owner list, JC-5): check each from a
  // mainland network and fill host, url and verifiedOn.
  unverified('job51', '前程无忧', 'experienced'),
  unverified('lagou', '拉勾', 'experienced'),
  unverified('shixiseng', '实习僧', 'campus'),
  unverified('nowcoder', '牛客', 'campus'),
  unverified('ncss', '24365', 'campus'),
  unverified('iguopin', '国聘', 'campus'),
];

export const isVerified = (spec: BoardSpec): spec is VerifiedBoardSpec => spec.verifiedOn !== null;

/** The hosts of the boards that are offered: exactly these, nothing else is ever built. */
export function externalHosts(specs: readonly BoardSpec[] = CN_EXTERNAL_BOARD_SPECS): string[] {
  return [...new Set(specs.filter(isVerified).map((s) => s.host))];
}

/** Hosts the links may point at (tests assert nothing else is ever built). */
export const CN_EXTERNAL_HOSTS: readonly string[] = externalHosts();

/** The search keyword: the user's query, then the city they typed; control characters removed, spaces collapsed. */
export function externalKeyword(q: string, city?: string | null): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return [clean(q), clean(city ?? '')].filter(Boolean).join(' ');
}

/**
 * One board's search URL for a keyword. Refuses (throws) a URL that is not
 * https on the board's own host: a pattern can never send the user elsewhere,
 * whatever the keyword holds.
 */
export function boardSearchUrl(spec: VerifiedBoardSpec, keyword: string): string {
  const url = spec.url(keyword);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.host !== spec.host || parsed.username || parsed.password) {
    throw new Error(`cn deep link: the ${spec.board} pattern built a URL outside https://${spec.host}`);
  }
  return url;
}

/** The audience's own boards first (a board for both counts as its own), then the others; table order inside each part. */
export function orderForAudience<T extends { audience: CnBoardAudience }>(specs: readonly T[], audience: CnLinkAudience): T[] {
  const own = (s: T) => s.audience === audience || s.audience === 'both';
  return [...specs.filter(own), ...specs.filter((s) => !own(s))];
}

/**
 * The audience of a GoApply identity answer (onboarding G2): 在校生 and 应届
 * are campus users; 社招, any other value and no answer are experienced. Age
 * and graduation year are never read for this.
 */
export function audienceForIdentity(identity: string | null | undefined): CnLinkAudience {
  return identity === 'zaixiao' || identity === 'yingjie' ? 'campus' : 'experienced';
}

export function buildExternalSearchLinks(
  q: string,
  city?: string | null,
  audience: CnLinkAudience = 'experienced',
  specs: readonly BoardSpec[] = CN_EXTERNAL_BOARD_SPECS,
): ExternalLinksResponse {
  const keyword = externalKeyword(q, city);
  if (!keyword) return { links: [] };
  return {
    links: orderForAudience(specs.filter(isVerified), audience).map((s) => ({ board: s.board, label: s.label, url: boardSearchUrl(s, keyword), audience: s.audience })),
  };
}

// ── The signed-in user's identity (for the default order) ────────────────

/** The slice of the Prisma client read here. */
export interface CnIdentityDb {
  rAProfile: { findUnique(args: { where: { userId: string }; select: { cnFields: true } }): Promise<{ cnFields: unknown } | null> };
  seekerProfile: { findUnique(args: { where: { userId: string }; select: { onboardingAnswers: true } }): Promise<{ onboardingAnswers: unknown } | null> };
}

/**
 * The user's GoApply identity ('yingjie' | 'zaixiao' | 'shezhao'), or null
 * when they never answered. The profile's value wins (the identity step
 * writes it and the profile page can correct it later); the stored onboarding
 * answer is the fallback. Both are read through onboarding-cn's `identityFrom`,
 * so one rule decides what a valid identity is.
 */
export async function cnIdentityOf(userId: string, db?: CnIdentityDb): Promise<string | null> {
  const { identityFrom } = await import('../../onboarding-cn/index.js');
  const d = db ?? ((await import('../../../lib/prisma.js')).default as unknown as CnIdentityDb);
  const [profile, seeker] = await Promise.all([
    d.rAProfile.findUnique({ where: { userId }, select: { cnFields: true } }),
    d.seekerProfile.findUnique({ where: { userId }, select: { onboardingAnswers: true } }),
  ]);
  const fields = profile?.cnFields;
  const fromProfile = fields && typeof fields === 'object' && !Array.isArray(fields) ? identityFrom({ identity: { cnIdentity: (fields as Record<string, unknown>).identity } }) : null;
  const answers = seeker?.onboardingAnswers;
  return fromProfile ?? identityFrom(answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null);
}

/**
 * The audience for a request: an explicit `?audience=` wins; otherwise the
 * signed-in user's identity decides. A failed identity read never fails the
 * links (they are the same links in another order): it answers the
 * experienced order and logs one warning.
 */
export async function resolveLinkAudience(
  explicit: CnLinkAudience | undefined,
  userId: string,
  identityOf: (userId: string) => Promise<string | null> = cnIdentityOf,
): Promise<CnLinkAudience> {
  if (explicit) return explicit;
  try {
    return audienceForIdentity(await identityOf(userId));
  } catch (err) {
    await warnIdentityReadFailed(err);
    return 'experienced';
  }
}

/**
 * One warning per failed identity read, so a read that keeps failing (a
 * missing column, a broken import) shows in the logs instead of silently
 * putting every campus user on the experienced order. It names no user, and
 * a logger that cannot be loaded never fails the links either.
 */
async function warnIdentityReadFailed(err: unknown): Promise<void> {
  try {
    const { logger } = await import('../../../services/LoggerService.js');
    logger.warn('CN_JOBS', 'deep links: the identity read failed; answering the experienced order', { error: err instanceof Error ? err.message : String(err) });
  } catch {
    // Best effort.
  }
}
