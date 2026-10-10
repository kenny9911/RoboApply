// server/src/features/resume/tailor/claims.ts
//
// Claim extraction and "Verify details" decisions for tailoring (WP-36a;
// PRODUCT_PLAN.md F-RES-15; ruling C12; D3). Pure.
//
// Every added or rewritten line of the tailored version is checked against
// the base resume. A line becomes ONE `pending` claim when it has any of:
//   - a number the base resume does not have (CitationGuard: inventedNumbers);
//   - a keyword or skill the base resume does not show (the job's keywords and
//     skills, the keywords the user confirmed, and the hard-skill vocabulary);
//   - a new statement (a line that adds ≥ NEW_STATEMENT_WORDS content words, or
//     ≥ NEW_STATEMENT_CJK CJK bigrams, that the base does not have);
//   - words taken from the job posting (the employer's name, or a run of
//     POSTING_RUN_WORDS consecutive words of the posting the base does not have):
//     facts from the posting are never written as the candidate's own.
// A pure rewording of what the base already says is not a claim.
//
// Claims see EVERY change (diffChanges is called uncapped; only the view's
// change list is capped for display). When the AI writes the same line more
// than once (e.g. one bullet under two employers), it is one claim whose
// `copies` list every place it appears; the decision applies to each copy.
//
// Decisions (PATCH claims): kept (the user says it is true) · removed (each
// copy goes back to the base line it replaced, or a list loses the new
// terms, or a new line is deleted) · edited (the user's own text replaces
// every copy). A removed claim is final.

import { containsTerm, stripMarkdown } from '../check/resumeText.js';
import { inventedNumbers } from '../check/citationGuard.js';
import { HARD_SKILLS_CN, HARD_SKILLS_EN } from '../keywords/vocabulary.js';
import type { ClaimKind, ClaimReason, TailorClaim, TailorChange } from '../contract.js';
import { bulletPrefix, contentUnits, diffChanges, lineContent, normLine } from './blocks.js';

export const NEW_STATEMENT_WORDS = 2;
export const NEW_STATEMENT_CJK = 4;
export const POSTING_RUN_WORDS = 6;

export interface ClaimInput {
  baseMarkdown: string;
  resultMarkdown: string;
  /** The job's keywords and normalized skills. */
  jobTerms?: readonly string[];
  /** Missing keywords the user confirmed they have. */
  confirmedKeywords?: readonly string[];
  posting?: { text?: string | null; company?: string | null } | null;
}

function dedupe(list: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const raw of list) {
    const v = (raw ?? '').trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}

const VOCABULARY: readonly string[] = [...HARD_SKILLS_EN, ...HARD_SKILLS_CN];

function newTerms(line: string, basePlain: string, candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const term of candidates) {
    if (term.length < 2) continue;
    if (containsTerm(line, term) && !containsTerm(basePlain, term)) out.push(term);
  }
  // Keep the longest form when one term contains another ("React Native" over "React").
  return dedupe(out).filter((t, _i, all) => !all.some((o) => o !== t && o.length > t.length && o.toLowerCase().includes(t.toLowerCase())));
}

function wordsOf(s: string): string[] {
  return stripMarkdown(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter(Boolean);
}

/** True when `line` copies POSTING_RUN_WORDS consecutive words of the posting that the base does not have. */
export function copiesPosting(line: string, postingText: string, basePlain: string): boolean {
  const lw = wordsOf(line);
  if (lw.length < POSTING_RUN_WORDS || !postingText) return false;
  const posting = ` ${wordsOf(postingText).join(' ')} `;
  const base = ` ${wordsOf(basePlain).join(' ')} `;
  for (let i = 0; i + POSTING_RUN_WORDS <= lw.length; i++) {
    const run = ` ${lw.slice(i, i + POSTING_RUN_WORDS).join(' ')} `;
    if (posting.includes(run) && !base.includes(run)) return true;
  }
  return false;
}

function kindFor(reasons: Set<ClaimReason>): ClaimKind {
  if (reasons.has('new_statement') || reasons.has('posting_text')) return 'claim';
  if (reasons.has('new_number')) return 'number';
  return 'keyword';
}

/** The pending claims of a tailored version, one per line that needs the user's check. */
export function extractClaims(input: ClaimInput, changes?: TailorChange[]): TailorClaim[] {
  const basePlain = stripMarkdown(input.baseMarkdown ?? '');
  const baseUnits = contentUnits(input.baseMarkdown ?? '');
  const candidates = dedupe([...(input.jobTerms ?? []), ...(input.confirmedKeywords ?? []), ...VOCABULARY]);
  const company = input.posting?.company?.trim() ?? '';
  const postingText = input.posting?.text ?? '';
  const list = changes ?? diffChanges(input.baseMarkdown, input.resultMarkdown);
  const claims: TailorClaim[] = [];
  /** normLine → the claim already raised for that line (or null when the line needed no check). */
  const seenLines = new Map<string, TailorClaim | null>();

  for (const change of list) {
    if (!change.after || change.kind === 'remove') continue;
    const line = change.after;
    const key = normLine(line);
    if (!key) continue;
    if (seenLines.has(key)) {
      // The same line again: one claim, one more copy to act on.
      const claim = seenLines.get(key);
      if (claim) {
        const first = { section: claim.section, original: claim.original ?? null };
        claim.copies = [...(claim.copies ?? [first]), { section: change.section, original: change.before ? change.before : null }];
      }
      continue;
    }

    const reasons = new Set<ClaimReason>();
    const terms: string[] = [];

    const numbers = inventedNumbers(line, [input.baseMarkdown]);
    if (numbers.length) {
      reasons.add('new_number');
      terms.push(...numbers);
    }
    const kw = newTerms(line, basePlain, candidates);
    if (kw.length) {
      reasons.add('new_keyword');
      terms.push(...kw);
    }
    const novel = [...contentUnits(line)].filter((u) => !baseUnits.has(u) && !kw.some((k) => k.toLowerCase().includes(u)));
    const novelCjk = novel.filter((u) => /[\u3400-\u9fff\uf900-\ufaff]/.test(u)).length;
    if (novel.length - novelCjk >= NEW_STATEMENT_WORDS || novelCjk >= NEW_STATEMENT_CJK) reasons.add('new_statement');
    if (company && containsTerm(line, company) && !containsTerm(basePlain, company)) {
      reasons.add('posting_text');
      terms.push(company);
    } else if (postingText && copiesPosting(line, postingText, basePlain)) {
      reasons.add('posting_text');
    }
    if (reasons.size === 0) {
      seenLines.set(key, null);
      continue;
    }

    const claim: TailorClaim = {
      id: `c${claims.length + 1}`,
      text: line,
      kind: kindFor(reasons),
      status: 'pending',
      terms: dedupe(terms),
      reasons: [...reasons],
      section: change.section,
      original: change.before ? change.before : null,
    };
    seenLines.set(key, claim);
    claims.push(claim);
  }
  return claims;
}

export function pendingCount(claims: readonly TailorClaim[]): number {
  return claims.filter((c) => c.status === 'pending').length;
}

// ── decisions ────────────────────────────────────────────────────────────

export class ClaimDecisionError extends Error {
  constructor(readonly reason: 'claim_locked' | 'target_changed') {
    super(reason === 'claim_locked' ? 'This detail was already removed.' : 'This line changed since it was written. Reload the result.');
    this.name = 'ClaimDecisionError';
  }
}

const LIST_SEPARATORS = /\s*(?:,|，|、|;|；|\||·|\/)\s*/;

/** Every line index whose text is `text`, in document order. */
function findLines(lines: string[], text: string): number[] {
  const target = normLine(text);
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.trim() && normLine(l) === target) out.push(i);
  });
  return out;
}

function stripTerms(content: string, terms: readonly string[]): string | null {
  if (!LIST_SEPARATORS.test(content)) return null;
  const sep = /[，、；]/.test(content) ? '、' : ', ';
  const lead = /^([^:：]+[:：]\s*)/.exec(content)?.[1] ?? '';
  const items = content.slice(lead.length).split(LIST_SEPARATORS).filter(Boolean);
  const kept = items.filter((item) => !terms.some((t) => item.trim().toLowerCase() === t.trim().toLowerCase()));
  if (kept.length === items.length || kept.length === 0) return null;
  return `${lead}${kept.join(sep)}`;
}

export interface DecisionResult {
  markdown: string;
  claim: TailorClaim;
}

/** Apply one "Verify details" decision to the tailored markdown. */
export function applyClaimDecision(
  markdown: string,
  claim: TailorClaim,
  decision: { status: 'kept' | 'removed' | 'edited'; text?: string },
): DecisionResult {
  if (claim.status === 'removed') throw new ClaimDecisionError('claim_locked');
  if (decision.status === 'kept') return { markdown, claim: { ...claim, status: 'kept' } };

  const lines = markdown.split('\n');
  const at = findLines(lines, claim.text);
  if (at.length === 0) throw new ClaimDecisionError('target_changed');
  const shape = (i: number) => {
    const prefix = bulletPrefix(lines[i]!);
    return { prefix, indent: prefix ? '' : (/^\s*/.exec(lines[i]!)?.[0] ?? '') };
  };

  if (decision.status === 'edited') {
    const text = (decision.text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
    for (const i of at) {
      const { prefix, indent } = shape(i);
      lines[i] = `${indent}${prefix}${text}`;
    }
    return {
      markdown: lines.join('\n'),
      claim: { ...claim, status: 'edited', proposed: claim.proposed ?? claim.text, text },
    };
  }

  // removed — every copy, last first so deletions keep the earlier indexes valid.
  const originals = claim.copies?.map((c) => c.original) ?? [claim.original ?? null];
  for (let n = at.length - 1; n >= 0; n--) {
    const i = at[n]!;
    const { prefix, indent } = shape(i);
    const original = originals[n] ?? null;
    if (original) {
      lines[i] = `${indent}${prefix}${original}`;
    } else {
      const stripped = claim.kind === 'keyword' ? stripTerms(lineContent(lines[i]!), claim.terms ?? []) : null;
      if (stripped) lines[i] = `${indent}${prefix}${stripped}`;
      else lines.splice(i, 1);
    }
  }
  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n'), claim: { ...claim, status: 'removed' } };
}
