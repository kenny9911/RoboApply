// server/src/features/retrieval/searchDoc.ts
//
// `RAJob.searchDoc`: the lexical document of a posting (MATCH 4.9; SM-7).
// Space-joined tokens of `segmentForSearch`, in this order: title; role labels
// (English, Chinese, and the Taiwan label when the role has one); level;
// skills, required first (canonical labels plus the posting's own spellings
// when it has canonical ids); the enrichment summary; the first 1,200 characters
// of the requirement text. At most 4,000 characters, cut on a token boundary.
//
// Written together with `searchTsv = to_tsvector('simple', searchDoc)` in one
// statement (repo.ts `writeSearchDoc`). It is a search copy: Traditional
// Chinese is folded to Simplified in it, and it is never displayed.

import { jobTextParts, type IndexJobRow, type JobTextDeps } from './jobText.js';
import { segmentForSearch } from './segment.js';

export const SEARCH_DOC_MAX_CHARS = 4000;

export function buildSearchDoc(row: IndexJobRow, deps: JobTextDeps = {}): string {
  const parts = jobTextParts(row, deps);
  const sections = [parts.title, ...parts.roleLabels, parts.level ?? '', ...parts.requiredSkills, ...parts.preferredSkills, ...parts.skillAliases, parts.summary ?? '', parts.requirementsHead];
  let doc = '';
  for (const section of sections) {
    for (const token of segmentForSearch(section)) {
      const next = doc ? `${doc} ${token}` : token;
      if (next.length > SEARCH_DOC_MAX_CHARS) return doc;
      doc = next;
    }
  }
  return doc;
}
