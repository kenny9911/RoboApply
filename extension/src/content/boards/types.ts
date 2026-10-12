// extension/src/content/boards/types.ts — the job-board reader contract.
//
// A reader is chosen from the tab's URL by the popup (no page access), and
// reads the page only after the user clicks "Check fit" or "Save" (the popup
// injects the content script under `activeTab`). It reads exactly what Save
// and Check fit send — role, employer, location, description — and nothing
// else on the page (not the signed-in member, not other listings).

import type { JobOnPage } from '../../adapters/types';
import type { Market } from '../../brands/types';
import { hostIs } from '../../adapters/_kit/page';

export interface BoardReader {
  id: string;
  /** Display name of the board, shown as "Job on {site}". */
  siteName: string;
  /** Hosts (and their subdomains). Never a host permission or content-script match. */
  domains: readonly string[];
  /** Brand markets whose build offers this reader. */
  markets: readonly Market[];
  /** A page that shows one job (not the board's home page or a profile). */
  matches(url: URL): boolean;
  readJob(doc: Document, url?: URL): JobOnPage | null;
  /** The job's own address on the board, without search or tracking parameters. */
  canonicalUrl(url: URL): string;
}

export interface BoardSpec {
  id: string;
  siteName: string;
  domains: readonly string[];
  markets?: readonly Market[];
  /** On a matching host: is this a page with one job open? */
  isJobPage(url: URL): boolean;
  readJob(doc: Document, url?: URL): JobOnPage | null;
  canonicalUrl?(url: URL): string;
}

/** origin + path: drops the query and fragment (tracking, search terms). */
export function originAndPath(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function defineBoard(spec: BoardSpec): BoardReader {
  return {
    id: spec.id,
    siteName: spec.siteName,
    domains: spec.domains,
    markets: spec.markets ?? ['intl'],
    matches: (url) => (url.protocol === 'https:' || url.protocol === 'http:') && hostIs(url, [...spec.domains]) && spec.isJobPage(url),
    readJob: spec.readJob,
    canonicalUrl: spec.canonicalUrl ?? originAndPath,
  };
}
