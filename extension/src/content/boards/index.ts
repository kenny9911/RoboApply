// extension/src/content/boards/index.ts — job-board readers ("Check fit" / "Save").
//
// Seam created by WP-55b and intentionally empty: WP-70 owns this folder and
// adds readers (LinkedIn, Indeed, …). They run ONLY after the user clicks the
// toolbar button (the popup injects the content script under `activeTab`),
// never on page load, and they read only the fields the user saves. No job
// board ever gets a host permission or a registered content script.

import type { JobOnPage } from '../../adapters/types';

export interface BoardReader {
  id: string;
  /** Display name of the board, e.g. shown as "Job on {site}". */
  siteName: string;
  matches(url: URL): boolean;
  readJob(doc: Document): JobOnPage | null;
}

export const BOARD_READERS: readonly BoardReader[] = [];

export function findBoardReader(url: URL): BoardReader | null {
  return BOARD_READERS.find((r) => r.matches(url)) ?? null;
}
