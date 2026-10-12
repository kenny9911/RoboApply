// server/src/features/match/evidence.ts
//
// CitationGuard for scorer evidence (ARCHITECTURE.md §4.7): every evidence
// string the model returns must be a substring, after whitespace and
// punctuation-width normalization, of the resume or the posting it claims to
// quote. Anything else is dropped — we never show a quote nobody wrote.
//
// The resume the model reads is markdown, so a quote can carry its markup
// ("**Technical:** TypeScript", "- Led the rewrite…"). Markup is not what the
// person wrote: it is removed from the quote that is shown and ignored on
// both sides of the comparison (`plainQuote`).

import type { MatchEvidence } from './contract.js';

/** NFKC, lower case, straight quotes, one kind of dash, collapsed whitespace. */
export function normalizeForGuard(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[•·▪●◦]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A quote without markdown markup: list bullets and numbers, heading and
 * quote marks at the start of a line, bold / italic / code markers, and
 * `[text](url)` links (the text is kept). Words and punctuation are untouched.
 */
export function plainQuote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+•▪●◦]|\d{1,3}[.)])\s+)+/, '')
        .replace(/\[([^\]\n]+)\]\((?:[^)\n]*)\)/g, '$1')
        .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
        .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*|__|`/g, ''),
    )
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Trim decoration a model adds around a quote ("…", quotes, ellipses). */
function stripQuoteMarks(text: string): string {
  return text.replace(/^[\s"'`“”‘’「」『』]+|[\s"'`“”‘’「」『』]+$/g, '').replace(/^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/g, '');
}

export interface EvidenceSources {
  resume: string;
  posting: string;
}

/** Shortest evidence worth showing (shorter strings match by accident). */
export const MIN_EVIDENCE_CHARS = 3;
export const MAX_EVIDENCE_PER_DIMENSION = 3;

/** Keep evidence whose text appears verbatim (normalized) in its declared source; at most 3. */
export function guardEvidence(items: unknown, sources: EvidenceSources): MatchEvidence[] {
  if (!Array.isArray(items)) return [];
  const normalized = { resume: normalizeForGuard(plainQuote(sources.resume)), posting: normalizeForGuard(plainQuote(sources.posting)) };
  // A quote that runs across a bullet is still found in the text as written.
  const asWritten = { resume: normalizeForGuard(sources.resume), posting: normalizeForGuard(sources.posting) };
  const out: MatchEvidence[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const { text, source } = raw as { text?: unknown; source?: unknown };
    if (typeof text !== 'string' || (source !== 'resume' && source !== 'posting')) continue;
    const clean = stripQuoteMarks(plainQuote(stripQuoteMarks(text.trim()))).slice(0, 240);
    const needle = normalizeForGuard(clean);
    if (needle.length < MIN_EVIDENCE_CHARS) continue;
    if (!normalized[source].includes(needle) && !asWritten[source].includes(normalizeForGuard(stripQuoteMarks(text.trim())))) continue;
    out.push({ text: clean, source });
    if (out.length >= MAX_EVIDENCE_PER_DIMENSION) break;
  }
  return out;
}
