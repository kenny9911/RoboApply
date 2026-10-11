// server/src/features/match/jobHash.ts — the content hash a fit depends on
// (MARKET_STRATEGY 2.2, 2.3 step 4; MARKET_TASK_PLAN 3.3).
//
// One function for two uses:
//   - the fit key: `RAJobMatchScore.jobContentHash` is the hash of the posting
//     an AI score was written for; when the posting's title, requirement text
//     or skills change, the hash changes and the stored score is stale: it
//     keeps serving, flagged, until precompute or the next allowed on-demand
//     call scores the posting as it is now (fit.ts);
//   - the index: `RAJob.contentHash`, written with the search document.
//
// The hash is sha1 over three normalised parts: the title, the requirement
// text (the qualifications, else the head of the plain description) and the
// sorted skills. Normalising means NFKC, lower case and single spaces, so
// re-ingesting the same posting with other spacing, another letter case or the
// skills in another order gives the same hash. Pay, location, dates and the
// company are not part of it: they do not change what the posting asks of a
// person (logistics are recomputed on every read).
//
// The head of the description is cut BEFORE it is normalised: the first
// `JOB_HASH_DESCRIPTION_READ_CHARS` characters are read, normalised and cut to
// `JOB_HASH_DESCRIPTION_CHARS`. So a long description is never normalised
// whole, and a reader that only fetched that head from the database
// (`left("descriptionPlain", 8000)`) computes the same hash as one that holds
// the full row.

import { createHash } from 'node:crypto';

/** The posting fields the hash reads (an RAJob projection). */
export interface JobHashInput {
  title: string;
  qualifications?: string | null;
  descriptionPlain?: string | null;
  skills?: readonly string[] | null;
}

/** Characters of the normalised plain description hashed when the posting has no qualifications section. */
export const JOB_HASH_DESCRIPTION_CHARS = 4000;
/** Characters of the plain description read (and normalised) for that; nothing past them can change the hash. */
export const JOB_HASH_DESCRIPTION_READ_CHARS = 8000;
/** Bumped only when the recipe changes (every stored hash then differs, which is a planned re-score). */
const JOB_HASH_VERSION = 'v1';

function norm(text: string | null | undefined): string {
  return typeof text === 'string' ? text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/** The requirement text the hash reads: the qualifications, else the head of the plain description. */
export function requirementTextOf(row: Pick<JobHashInput, 'qualifications' | 'descriptionPlain'>): string {
  const qualifications = norm(row.qualifications);
  if (qualifications) return qualifications;
  const head = typeof row.descriptionPlain === 'string' ? row.descriptionPlain.slice(0, JOB_HASH_DESCRIPTION_READ_CHARS) : '';
  return norm(head).slice(0, JOB_HASH_DESCRIPTION_CHARS);
}

/** sha1 (hex) of the normalised title, the requirement text and the sorted skills. */
export function jobContentHash(row: JobHashInput): string {
  const skills = [...new Set((row.skills ?? []).map((s) => norm(s)).filter(Boolean))].sort();
  const parts = [JOB_HASH_VERSION, norm(row.title), requirementTextOf(row), skills.join('\u001f')];
  return createHash('sha1').update(parts.join('\u001e')).digest('hex');
}

/**
 * The posting's current hash for a row that carries its text (a full row):
 * the stored `RAJob.contentHash` when the row has one (written with the search
 * document by this same function), else computed from the row's own text. A
 * list row carries no text and gets no computed hash: see `storedJobHash`.
 */
export function currentJobHash(row: JobHashInput & { contentHash?: string | null }): string {
  return typeof row.contentHash === 'string' && row.contentHash ? row.contentHash : jobContentHash(row);
}

/** The stored `RAJob.contentHash` of a row, when it has one; null otherwise (nothing is computed). */
export function storedJobHash(row: { contentHash?: string | null }): string | null {
  return typeof row.contentHash === 'string' && row.contentHash ? row.contentHash : null;
}
