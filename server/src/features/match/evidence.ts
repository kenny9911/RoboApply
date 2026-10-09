// server/src/features/match/evidence.ts
//
// CitationGuard for scorer evidence (ARCHITECTURE.md §4.7): every evidence
// string the model returns must be a substring, after whitespace and
// punctuation-width normalization, of the resume or the posting it claims to
// quote. Anything else is dropped — we never show a quote nobody wrote.

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
  const normalized = { resume: normalizeForGuard(sources.resume), posting: normalizeForGuard(sources.posting) };
  const out: MatchEvidence[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const { text, source } = raw as { text?: unknown; source?: unknown };
    if (typeof text !== 'string' || (source !== 'resume' && source !== 'posting')) continue;
    const clean = stripQuoteMarks(text.trim()).slice(0, 240);
    const needle = normalizeForGuard(clean);
    if (needle.length < MIN_EVIDENCE_CHARS) continue;
    if (!normalized[source].includes(needle)) continue;
    out.push({ text: clean, source });
    if (out.length >= MAX_EVIDENCE_PER_DIMENSION) break;
  }
  return out;
}
