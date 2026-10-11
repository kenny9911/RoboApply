// server/src/features/retrieval/cardText.ts
//
// The text that is embedded for a job (MATCH 4.9 "what is embedded for a
// job"): title; role labels; level; required skills, then preferred; the
// enrichment summary; the first 1,200 characters of the requirement text. At
// most 2,000 characters (about 500 tokens). Not the company boilerplate,
// benefits or legal text.
//
// `cardHash` (sha1 of the card text) is `RAJobEmbedding.contentHash`: a job
// whose stored vector has the current model and this hash is not embedded again.

import { createHash } from 'node:crypto';
import { jobTextParts, type IndexJobRow, type JobTextDeps } from './jobText.js';

export const CARD_TEXT_MAX_CHARS = 2000;

export function buildCardText(row: IndexJobRow, deps: JobTextDeps = {}): string {
  const p = jobTextParts(row, deps);
  const lines = [
    p.title,
    p.roleLabels.join(' / '),
    p.level ?? '',
    p.requiredSkills.join(', '),
    p.preferredSkills.join(', '),
    p.summary ?? '',
    p.requirementsHead,
  ].filter(Boolean);
  return lines.join('\n').slice(0, CARD_TEXT_MAX_CHARS).trim();
}

export function cardHash(cardText: string): string {
  return createHash('sha1').update(cardText).digest('hex');
}
