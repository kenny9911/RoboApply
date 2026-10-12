// server/src/features/coverletter/letterBody.ts
//
// Pure helpers for the letter body, its per-sentence citations and its
// versions (WP-37). The body is plain text with paragraphs separated by a
// blank line:
//
//   <greeting>
//
//   <paragraph> …
//
//   <closing>
//   <name>            ← added by the server after the model ran (never in a prompt)
//
// Citations are stored per sentence of the body (`splitSentences`), carrying
// the sentence text so they survive edits: an unchanged sentence keeps its
// citations, a sentence the user wrote or changed becomes `user`, and the
// greeting / sign-off carry none.

import { normalizeText, splitSentences, isCjkLocale, type LetterSentence } from './claimCheck.js';
import {
  LetterCitationsSchema,
  LetterVersionsSchema,
  MAX_LETTER_VERSIONS,
  VERSION_REASONS,
  type LetterCitation,
  type LetterSentenceView,
  type LetterVersion,
  type LetterVersionView,
  type VersionReason,
} from './contract.js';

export interface LetterDraft {
  greeting: string;
  paragraphs: LetterSentence[][];
  closing: string;
}

/** Assemble the body text; `signature` (the candidate's name) is appended after the closing. */
export function assembleBody(draft: LetterDraft, locale: string, signature?: string | null): string {
  const joiner = isCjkLocale(locale) ? '' : ' ';
  const blocks: string[] = [];
  if (draft.greeting.trim()) blocks.push(draft.greeting.trim());
  for (const p of draft.paragraphs) {
    const text = p.map((s) => s.text.trim()).filter(Boolean).join(joiner);
    if (text) blocks.push(text);
  }
  const sign = [draft.closing.trim(), signature?.trim() ?? ''].filter(Boolean).join('\n');
  if (sign) blocks.push(sign);
  return blocks.join('\n\n');
}

/** The model's sentences in body order. */
export function draftSentences(draft: LetterDraft): LetterSentence[] {
  return draft.paragraphs.flat().filter((s) => s.text.trim().length > 0);
}

/**
 * Citations for a freshly written body: each body sentence inherits the cites
 * of the model sentence it belongs to (containment either way, so a model
 * sentence the splitter breaks in two still cites both halves).
 */
export function citationsForBody(body: string, sentences: readonly LetterSentence[]): LetterCitation[] {
  const pieces = splitSentences(body);
  const norm = sentences.map((s) => ({ s, n: normalizeText(s.text) }));
  const out: LetterCitation[] = [];
  pieces.forEach((piece, sentenceIdx) => {
    const p = normalizeText(piece);
    if (!p) return;
    const hit = norm.find(({ n }) => n && (n === p || n.includes(p) || p.includes(n)));
    if (!hit) return;
    for (const c of hit.s.cites) out.push({ sentenceIdx, source: c.source, ref: c.quote, sentence: piece });
  });
  return out;
}

/**
 * Re-map citations after the body changed: unchanged sentences keep theirs, a
 * sentence with no citations before (greeting, sign-off) stays uncited, and
 * every new or changed sentence is the user's own (`user`).
 */
export function remapCitations(previousBody: string, previous: readonly LetterCitation[], nextBody: string): LetterCitation[] {
  const bySentence = new Map<string, LetterCitation[]>();
  for (const c of previous) {
    const key = normalizeText(c.sentence ?? '');
    if (!key) continue;
    const list = bySentence.get(key) ?? [];
    list.push(c);
    bySentence.set(key, list);
  }
  const uncited = new Set(
    splitSentences(previousBody)
      .map(normalizeText)
      .filter((k) => !bySentence.has(k)),
  );
  const out: LetterCitation[] = [];
  splitSentences(nextBody).forEach((piece, sentenceIdx) => {
    const key = normalizeText(piece);
    const carried = bySentence.get(key);
    if (carried) {
      const seen = new Set<string>();
      for (const c of carried) {
        const dedupe = `${c.source}\u0000${c.ref}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({ sentenceIdx, source: c.source, ref: c.ref, sentence: piece });
      }
      return;
    }
    if (uncited.has(key)) return;
    out.push({ sentenceIdx, source: 'user', ref: '', sentence: piece });
  });
  return out;
}

/** The sentences the user wrote (citations with source `user`). */
export function userSentencesOf(citations: readonly LetterCitation[]): string[] {
  return citations.filter((c) => c.source === 'user' && c.sentence).map((c) => c.sentence!);
}

/** Sources panel rows, in body order. */
export function sentenceViews(body: string, citations: readonly LetterCitation[]): LetterSentenceView[] {
  const pieces = splitSentences(body);
  const byIdx = new Map<number, LetterSentenceView>();
  for (const c of citations) {
    if (c.sentenceIdx < 0 || c.sentenceIdx >= pieces.length) continue;
    const row = byIdx.get(c.sentenceIdx) ?? { index: c.sentenceIdx, text: pieces[c.sentenceIdx]!, sources: [] };
    if (!row.sources.some((s) => s.source === c.source && s.ref === c.ref)) row.sources.push({ source: c.source, ref: c.ref });
    byIdx.set(c.sentenceIdx, row);
  }
  return [...byIdx.values()].sort((a, b) => a.index - b.index);
}

export function parseCitations(raw: unknown): LetterCitation[] {
  const parsed = LetterCitationsSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

export function parseVersions(raw: unknown): LetterVersion[] {
  if (!Array.isArray(raw)) return [];
  const parsed = LetterVersionsSchema.safeParse(raw.slice(-MAX_LETTER_VERSIONS));
  return parsed.success ? parsed.data : [];
}

/** Coalesce window for autosaved edits: one `edit` version per 10 minutes of typing. */
export const EDIT_COALESCE_MS = 10 * 60_000;

/**
 * Append a version (newest last, at most MAX_LETTER_VERSIONS). An `edit` that
 * follows another `edit` inside EDIT_COALESCE_MS replaces it, so autosave does
 * not push every earlier version out.
 */
export function pushVersion(versions: readonly LetterVersion[], next: LetterVersion, now: Date): LetterVersion[] {
  const list = [...versions];
  const last = list[list.length - 1];
  if (next.reason === 'edit' && last?.reason === 'edit' && now.getTime() - new Date(last.createdAt).getTime() < EDIT_COALESCE_MS) {
    list[list.length - 1] = next;
  } else {
    list.push(next);
  }
  return list.slice(-MAX_LETTER_VERSIONS);
}

function reasonOf(r: string): VersionReason {
  return (VERSION_REASONS as readonly string[]).includes(r) ? (r as VersionReason) : 'edit';
}

const PREVIEW_CHARS = 140;

export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

export function versionViews(versions: readonly LetterVersion[], currentBody: string): LetterVersionView[] {
  let currentIdx = -1;
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    if (versions[i]!.body === currentBody) {
      currentIdx = i;
      break;
    }
  }
  return versions.map((v, index) => ({
    index,
    reason: reasonOf(v.reason),
    createdAt: v.createdAt,
    preview: previewOf(v.body),
    current: index === currentIdx,
  }));
}

/** The candidate's name from the resume's `# Name` line (placed by the server, never sent to a model). */
export function signatureFromResume(markdown: string): string | null {
  const m = /^\s*#\s+(.+?)\s*$/m.exec(markdown ?? '');
  if (!m) return null;
  const name = m[1]!.replace(/[*_`]/g, '').trim();
  return name && name.length <= 80 ? name : null;
}
