// server/src/features/cn/jobs/deeplinks.ts — external search deep links (CN L-5).
//
// BOSS直聘, 智联招聘 and 猎聘 are never integrated: no scraping, no fetching,
// no autofill, no greeting. The user may open a search on those sites for
// their OWN query: the link carries the query (and the city they typed, as
// part of the keyword) and nothing else — no user id, no profile data, no
// tracking parameter. The page opens it with rel="noopener noreferrer".

import type { CnExternalBoard, ExternalLinksResponse } from './contract.js';

interface BoardSpec {
  board: CnExternalBoard;
  /** The site's own name (a proper noun; shown as is). */
  label: string;
  url: (keyword: string) => string;
}

export const CN_EXTERNAL_BOARD_SPECS: readonly BoardSpec[] = [
  { board: 'boss', label: 'BOSS直聘', url: (k) => `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(k)}` },
  { board: 'zhaopin', label: '智联招聘', url: (k) => `https://sou.zhaopin.com/?kw=${encodeURIComponent(k)}` },
  { board: 'liepin', label: '猎聘', url: (k) => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(k)}` },
];

/** Hosts the links may point at (tests assert nothing else is ever built). */
export const CN_EXTERNAL_HOSTS = ['www.zhipin.com', 'sou.zhaopin.com', 'www.liepin.com'] as const;

/** The search keyword: the user's query, then the city they typed; control characters removed, spaces collapsed. */
export function externalKeyword(q: string, city?: string | null): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return [clean(q), clean(city ?? '')].filter(Boolean).join(' ');
}

export function buildExternalSearchLinks(q: string, city?: string | null): ExternalLinksResponse {
  const keyword = externalKeyword(q, city);
  if (!keyword) return { links: [] };
  return { links: CN_EXTERNAL_BOARD_SPECS.map((b) => ({ board: b.board, label: b.label, url: b.url(keyword) })) };
}
