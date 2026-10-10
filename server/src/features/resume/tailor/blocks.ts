// server/src/features/resume/tailor/blocks.ts
//
// Pure helpers for tailoring (WP-36a): split resume markdown into blocks
// (the header above the first `##`, then one block per `##` section), merge
// the model's tailored text back into the base resume section by section,
// and list the line changes between two versions. No I/O.
//
// Why merge instead of taking the model's markdown as is:
//   - the prompt carries `resumeForLlm(base)` (no name, contact block,
//     photo, 籍贯, 政治面貌, birth date…), so the model's text has no header;
//     the base header and every sensitive line are placed back here, after the
//     model ran (TASK_PLAN.md §2.2);
//   - only the sections the user picked may change; every other section is
//     the base text, byte for byte;
//   - `###` entry lines (employer · title · dates) never change: a changed one
//     is replaced with the base line at the same position.

import { isSensitiveLine, sectionKeyOf, stripMarkdown } from '../check/resumeText.js';
import type { ResumeSectionKey, TailorChange, TailorSection } from '../contract.js';

export interface Block {
  /** null for the header block (lines above the first `##`). */
  heading: string | null;
  /** The raw `## …` line, or null for the header block. */
  headingLine: string | null;
  key: ResumeSectionKey | 'header';
  /** Body lines (without the heading line). */
  lines: string[];
}

const H2_RE = /^\s*##\s+(.+?)\s*$/;
const H3_RE = /^\s*###\s+/;
const BULLET_PREFIX_RE = /^(\s*(?:[-*•·]|\d+[.)、])\s+)/;

export function splitBlocks(markdown: string): Block[] {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let current: Block = { heading: null, headingLine: null, key: 'header', lines: [] };
  for (const line of lines) {
    const h2 = H2_RE.exec(line);
    if (h2 && !H3_RE.test(line)) {
      blocks.push(current);
      const heading = stripMarkdown(h2[1]!);
      current = { heading, headingLine: line.trimEnd(), key: sectionKeyOf(heading), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  blocks.push(current);
  return blocks;
}

export function joinBlocks(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.headingLine !== null) out.push(b.headingLine);
    out.push(...b.lines);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Lowercase, collapse spaces, drop trailing punctuation. */
export function normLine(s: string): string {
  return stripMarkdown(s.replace(BULLET_PREFIX_RE, ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:。；，]+$/, '')
    .trim();
}

/** The line without its bullet prefix and outer whitespace. */
export function lineContent(line: string): string {
  return line.replace(BULLET_PREFIX_RE, '').trim();
}

/** The bullet prefix of a line ('- ', '1. ', …), or ''. */
export function bulletPrefix(line: string): string {
  return BULLET_PREFIX_RE.exec(line)?.[1] ?? '';
}

const SECTION_KEYS: Record<TailorSection, ResumeSectionKey> = {
  summary: 'summary',
  experience: 'experience',
  skills: 'skills',
  projects: 'projects',
  education: 'education',
};

function headingNorm(h: string | null): string {
  return (h ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Keep the base `###` entry lines: a changed or new one becomes the base line at that position. */
function pinEntryLines(baseLines: string[], tailoredLines: string[]): string[] {
  const baseEntries = baseLines.filter((l) => H3_RE.test(l));
  const baseSet = new Set(baseEntries.map((l) => normLine(l)));
  let entryIndex = -1;
  const out: string[] = [];
  for (const line of tailoredLines) {
    if (!H3_RE.test(line)) {
      out.push(line);
      continue;
    }
    entryIndex += 1;
    if (baseSet.has(normLine(line))) out.push(line);
    else if (baseEntries[entryIndex] !== undefined) out.push(baseEntries[entryIndex]!);
    // A new entry the base does not have (an invented employer) is dropped.
  }
  return out;
}

/**
 * The tailored resume: the base resume with the picked sections replaced by
 * the model's version of them. Sensitive lines of a replaced section stay.
 */
export function mergeTailored(baseMarkdown: string, tailoredMarkdown: string, sections: readonly TailorSection[]): string {
  const allowed = new Set(sections.map((s) => SECTION_KEYS[s]));
  const base = splitBlocks(baseMarkdown);
  const tailored = splitBlocks(tailoredMarkdown).filter((b) => b.heading !== null);
  const used = new Set<Block>();

  const findTailored = (b: Block): Block | undefined => {
    const byHeading = tailored.find((t) => !used.has(t) && headingNorm(t.heading) === headingNorm(b.heading));
    if (byHeading) return byHeading;
    if (b.key === 'other') return undefined;
    return tailored.find((t) => !used.has(t) && t.key === b.key);
  };

  const merged: Block[] = base.map((b) => {
    if (b.key === 'header' || b.key === 'contact' || !allowed.has(b.key as ResumeSectionKey)) return b;
    const t = findTailored(b);
    if (!t) return b;
    used.add(t);
    const sensitive = b.lines.filter((l) => l.trim() && isSensitiveLine(l));
    const body = pinEntryLines(b.lines, t.lines).filter((l) => !isSensitiveLine(l));
    return { ...b, lines: withTrailingBlank([...sensitive, ...body]) };
  });

  // A summary the base did not have may be added ("add a tailored objective").
  if (allowed.has('summary') && !base.some((b) => b.key === 'summary')) {
    const t = tailored.find((x) => !used.has(x) && x.key === 'summary');
    if (t) {
      used.add(t);
      const at = merged.findIndex((b) => b.key !== 'header');
      const block: Block = { ...t, lines: withTrailingBlank(t.lines.filter((l) => !isSensitiveLine(l))) };
      merged.splice(at < 0 ? merged.length : at, 0, block);
    }
  }
  return joinBlocks(merged);
}

function withTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  while (out.length && !out[0]!.trim()) out.shift();
  return ['', ...out, ''];
}

// ── word units (Latin words and CJK bigrams) ─────────────────────────────

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'our', 'your', 'their', 'its', 'was', 'were', 'are', 'has', 'have', 'had',
  'via', 'per', 'using', 'used', 'use', 'across', 'within', 'while', 'through', 'which', 'who', 'all', 'new', 'more', 'than', 'also', 'such', 'other',
]);
const CJK_RE = /[㐀-鿿豈-﫿]/;

/** Content units of a text: Latin words (≥3 letters, not stop words) and CJK character bigrams. */
export function contentUnits(text: string): Set<string> {
  const plain = stripMarkdown(text ?? '').toLowerCase();
  const units = new Set<string>();
  for (const w of plain.split(/[^\p{L}\p{N}+#.]+/u)) {
    const word = w.replace(/^\.+|\.+$/g, '');
    if (!word || CJK_RE.test(word)) continue;
    if (word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word)) units.add(word);
  }
  const cjkRuns = plain.match(/[㐀-鿿豈-﫿]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) units.add(run.slice(i, i + 2));
  }
  return units;
}

/** Jaccard similarity of two lines' content units (0–1). */
export function similarity(a: string, b: string): number {
  const ua = contentUnits(a);
  const ub = contentUnits(b);
  if (ua.size === 0 && ub.size === 0) return normLine(a) === normLine(b) ? 1 : 0;
  let inter = 0;
  for (const u of ua) if (ub.has(u)) inter += 1;
  return inter / (ua.size + ub.size - inter);
}

// ── line changes ─────────────────────────────────────────────────────────

/** A rewritten line must share this much with the base line it replaces. */
export const REWRITE_SIMILARITY = 0.3;
/** How many changes the session view lists (display only; claims always see every change). */
export const MAX_CHANGES = 60;

function contentLines(block: Block): string[] {
  return block.lines.filter((l) => l.trim() && !H3_RE.test(l)).map((l) => l.trim());
}

/**
 * Line changes from `baseMarkdown` to `resultMarkdown`, per section: an added
 * line, a removed line, or a rewritten line paired with the most similar
 * base line of the same section. Reordered lines are not changes.
 *
 * `limit` caps the list for display only. Claim extraction must call this
 * uncapped (the default), so no added line past the cap goes unchecked.
 */
export function diffChanges(baseMarkdown: string, resultMarkdown: string, headerLabel = '', limit = Infinity): TailorChange[] {
  const base = splitBlocks(baseMarkdown);
  const result = splitBlocks(resultMarkdown);
  const usedBase = new Set<Block>();
  const changes: TailorChange[] = [];

  for (const r of result) {
    const b =
      base.find((x) => !usedBase.has(x) && x.key === r.key && headingNorm(x.heading) === headingNorm(r.heading)) ??
      (r.key !== 'other' && r.key !== 'header' ? base.find((x) => !usedBase.has(x) && x.key === r.key) : undefined);
    if (b) usedBase.add(b);
    const section = r.heading ?? headerLabel;
    const rLines = contentLines(r);
    const bLines = b ? contentLines(b) : [];
    const bNorm = new Set(bLines.map(normLine));
    const rNorm = new Set(rLines.map(normLine));
    const freeBase = bLines.filter((l) => !rNorm.has(normLine(l)));
    const pairedBase = new Set<string>();
    for (const line of rLines) {
      if (bNorm.has(normLine(line))) continue;
      let best: string | null = null;
      let bestSim = 0;
      for (const cand of freeBase) {
        if (pairedBase.has(cand)) continue;
        const sim = similarity(cand, line);
        if (sim > bestSim) {
          bestSim = sim;
          best = cand;
        }
      }
      if (best && bestSim >= REWRITE_SIMILARITY) {
        pairedBase.add(best);
        changes.push({ section, before: lineContent(best), after: lineContent(line), kind: 'rewrite' });
      } else {
        changes.push({ section, before: '', after: lineContent(line), kind: 'add' });
      }
    }
    for (const line of freeBase) {
      if (!pairedBase.has(line)) changes.push({ section, before: lineContent(line), after: '', kind: 'remove' });
    }
  }
  for (const b of base) {
    if (usedBase.has(b)) continue;
    for (const line of contentLines(b)) changes.push({ section: b.heading ?? headerLabel, before: lineContent(line), after: '', kind: 'remove' });
  }
  return Number.isFinite(limit) ? changes.slice(0, Math.max(0, limit)) : changes;
}
