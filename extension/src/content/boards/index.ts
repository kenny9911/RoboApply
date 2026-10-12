// extension/src/content/boards/index.ts — job-board readers ("Check fit" / "Save").
//
// They run ONLY after the user clicks the toolbar button and then "Check fit"
// or "Save job" (the popup injects the content script under `activeTab`),
// never on page load, and they read only the fields that are sent: role,
// employer, location, description and the job's own URL. No job board ever
// gets a host permission or a registered content script (test/intl/boards).
// The fit chip comes from POST /ext/page-job, the app's own scorer: nothing
// here scores anything.

import type { PageJobBody } from '../../shared/contract';
import type { Market } from '../../brands/types';
import { brandConfig } from '../../env';
import { cakeReader } from './cake';
import { glassdoorReader } from './glassdoor';
import { indeedReader } from './indeed';
import { linkedinReader } from './linkedin';
import { tw104Reader } from './tw104';
import type { BoardReader } from './types';
import { wellfoundReader } from './wellfound';
import { zipRecruiterReader } from './ziprecruiter';

export type { BoardReader } from './types';

export const BOARD_READERS: readonly BoardReader[] = [linkedinReader, indeedReader, glassdoorReader, zipRecruiterReader, wellfoundReader, tw104Reader, cakeReader];

function buildMarket(): Market {
  try {
    return brandConfig().market;
  } catch {
    return 'intl';
  }
}

/** The reader for a job page on a board this brand build supports, or null. */
export function findBoardReader(url: URL, market: Market = buildMarket()): BoardReader | null {
  return BOARD_READERS.find((r) => r.markets.includes(market) && r.matches(url)) ?? null;
}

/** Every board host (tests assert none of them is a host permission or content-script match). */
export function boardDomains(): string[] {
  return [...new Set(BOARD_READERS.flatMap((r) => r.domains))];
}

const cap = (s: string | undefined, n: number) => (s ? s.slice(0, n) : s);

/**
 * What "Check fit" / "Save" send for the job on this board page: the job's
 * canonical URL (no search or tracking parameters), role, employer, location
 * and description. Null when the page does not name both role and employer.
 */
export function boardPageJob(href: string, doc: Document, market: Market = buildMarket()): PageJobBody | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const reader = findBoardReader(url, market);
  const job = reader?.readJob(doc, url);
  if (!reader || !job?.title || !job.company) return null;
  const body: PageJobBody = {
    url: reader.canonicalUrl(url).slice(0, 2000),
    title: job.title.slice(0, 200),
    company: job.company.slice(0, 200),
    descriptionText: (job.descriptionText ?? '').slice(0, 60_000),
  };
  const location = cap(job.location, 200);
  if (location) body.location = location;
  return body;
}
