// lib/api/cnJobs.ts — GoApply jobs: deep links, fraud review, blacklist.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-41.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/cn/jobs/external-links
//   GET    /api/v1/roboapply/admin/cn/jobs/fraud
//   POST   /api/v1/roboapply/admin/cn/jobs/fraud/:jobId/resolve
//   GET    /api/v1/roboapply/admin/cn/jobs/blacklist
//   POST   /api/v1/roboapply/admin/cn/jobs/blacklist
//   DELETE /api/v1/roboapply/admin/cn/jobs/blacklist/:id

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as CJ from './contracts/cn/jobs';
import { feedIsThin, feedSources } from './feed';

/** A blacklist row (admin). */
export type BlacklistEntryView = CJ.BlacklistEntryView;

/**
 * `cnJobs.externalLinks` — GET /api/v1/roboapply/cn/jobs/external-links
 *
 * `query.audience` ('campus' | 'experienced') is optional: it chooses whose
 * job sites come first. Without it the server uses the signed-in user's
 * identity answer. The links arrive in display order.
 */
export function getExternalLinks(query: In<typeof CJ.ExternalLinksQuerySchema>, opts?: CallOptions): Promise<CJ.ExternalLinksResponse> {
  return call<CJ.ExternalLinksResponse>('GET', withQuery(`/api/v1/roboapply/cn/jobs/external-links`, query), opts);
}

/** One search link as the server sends it (`audience` may be missing on an older response). */
export type ExternalLinkView = Omit<CJ.ExternalLink, 'audience'> & { audience?: CJ.CnBoardAudience };

/** The links of one audience, in the order the server sent them. */
export interface ExternalLinkGroup {
  audience: CJ.CnLinkAudience;
  links: ExternalLinkView[];
}

/**
 * The search links in groups, for display. The server's order is the display
 * order, so the groups come in the order their first link arrived: the user's
 * own group first. A link for both audiences joins the first group; a link
 * with no audience (or one this build does not know) counts as `experienced`.
 * One audience → one group; no links → no group.
 */
export function groupExternalLinks(links: readonly ExternalLinkView[] | null | undefined): ExternalLinkGroup[] {
  const list = Array.isArray(links) ? links.filter((l) => l && typeof l.url === 'string' && typeof l.label === 'string') : [];
  const own = (l: ExternalLinkView): CJ.CnLinkAudience | null => (l.audience === 'both' ? null : l.audience === 'campus' ? 'campus' : 'experienced');
  const first = list.map(own).find((a) => a !== null) ?? 'experienced';
  const groups: ExternalLinkGroup[] = [];
  for (const l of list) {
    const audience = own(l) ?? first;
    const group = groups.find((g) => g.audience === audience);
    if (group) group.links.push(l);
    else groups.push({ audience, links: [l] });
  }
  return groups;
}

/** `cnJobs.admin.fraudQueue` — GET /api/v1/roboapply/admin/cn/jobs/fraud */
export function adminListFraudQueue(query?: In<typeof CJ.FraudQueueQuerySchema>, opts?: CallOptions): Promise<CJ.FraudQueueResponse> {
  return call<CJ.FraudQueueResponse>('GET', withQuery(`/api/v1/roboapply/admin/cn/jobs/fraud`, query), opts);
}

/** `cnJobs.admin.resolve` — POST /api/v1/roboapply/admin/cn/jobs/fraud/:jobId/resolve */
export function adminResolveFraud(jobId: string, body: In<typeof CJ.ResolveFraudBodySchema>, opts?: CallOptions): Promise<CJ.ResolveFraudResponse> {
  return call<CJ.ResolveFraudResponse>('POST', `/api/v1/roboapply/admin/cn/jobs/fraud/${seg(jobId)}/resolve`, { ...opts, body });
}

/** `cnJobs.admin.blacklist` — GET /api/v1/roboapply/admin/cn/jobs/blacklist */
export function adminListBlacklist(opts?: CallOptions): Promise<CJ.BlacklistListResponse> {
  return call<CJ.BlacklistListResponse>('GET', `/api/v1/roboapply/admin/cn/jobs/blacklist`, opts);
}

/** `cnJobs.admin.addBlacklist` — POST /api/v1/roboapply/admin/cn/jobs/blacklist */
export function adminAddBlacklist(body: In<typeof CJ.BlacklistEntryBodySchema>, opts?: CallOptions): Promise<CJ.BlacklistAddResponse> {
  return call<CJ.BlacklistAddResponse>('POST', `/api/v1/roboapply/admin/cn/jobs/blacklist`, { ...opts, body });
}

/** `cnJobs.admin.removeBlacklist` — DELETE /api/v1/roboapply/admin/cn/jobs/blacklist/:id */
export function adminRemoveBlacklist(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/admin/cn/jobs/blacklist/${seg(id)}`, opts);
}

/**
 * The GoApply list header, built only from what the feed response says its
 * rows come from (D3; MARKET_STRATEGY §1.4). It never claims the whole market:
 *   boards            来自 N 家企业招聘官网
 *   gohire_and_boards 来自 GoHire 与 N 家企业招聘官网   (only when GoHire rows are listed)
 *   gohire            来自 GoHire                       (GoHire rows, no board row)
 * null when the response carries no `sources` or names no source at all: the
 * header then says nothing rather than something untrue.
 */
export type CnFeedHeader =
  | { kind: 'boards'; boards: number }
  | { kind: 'gohire_and_boards'; boards: number }
  | { kind: 'gohire' };

export interface CnFeedSummary {
  header: CnFeedHeader | null;
  /** The server marked the result set thin: offer the search links on other job sites. */
  thin: boolean;
}

export function cnFeedSummary(response: unknown): CnFeedSummary {
  const sources = feedSources(response);
  const thin = feedIsThin(response);
  if (!sources) return { header: null, thin };
  const boards = sources.employerBoards;
  if (sources.gohire) return { header: boards > 0 ? { kind: 'gohire_and_boards', boards } : { kind: 'gohire' }, thin };
  return { header: boards > 0 ? { kind: 'boards', boards } : null, thin };
}

/** Every wrapper of this area, for callers that prefer one import. */
export const cnJobsApi = {
  getExternalLinks,
  adminListFraudQueue,
  adminResolveFraud,
  adminListBlacklist,
  adminAddBlacklist,
  adminRemoveBlacklist,
};
