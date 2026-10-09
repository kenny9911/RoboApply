// server/src/features/resume/check/aiPass.ts
//
// The AI half of the resume check (WP-22), pure parts: the wire shapes of the
// AI pass, its output parser and the issue builder. The agent itself is
// ResumeCheckAgent.ts (loaded lazily, only when AI is allowed).
//
// Output hygiene (CitationGuard): a reported word must appear verbatim in the
// text the model saw; anything else is dropped.

import type { GradeIssue, GradeProfile } from '../contract.js';
import { quotedIn } from './citationGuard.js';
import { anchorFor } from './rules.js';
import { ISSUE_DEFINITIONS } from './taxonomy.js';
import { parseResume, resumeForLlm, summaryTarget, summaryText } from './resumeText.js';

export interface AiPassInput {
  /** Already passed through resumeForLlm(). */
  resumeText: string;
  profile: GradeProfile;
  targetTitle?: string | null;
}

export interface AiPassOutput {
  spelling: Array<{ word: string; suggestion: string }>;
  summaryVague: boolean;
}

export const MAX_SPELLING = 5;

export function parseAiPassOutput(response: string): AiPassOutput {
  const empty: AiPassOutput = { spelling: [], summaryVague: false };
  if (!response) return empty;
  const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const p = parsed as { spelling?: unknown; summaryVague?: unknown };
  const spelling: AiPassOutput['spelling'] = [];
  if (Array.isArray(p.spelling)) {
    for (const item of p.spelling) {
      if (!item || typeof item !== 'object') continue;
      const word = String((item as { word?: unknown }).word ?? '').trim().slice(0, 60);
      const suggestion = String((item as { suggestion?: unknown }).suggestion ?? '').trim().slice(0, 60);
      if (word && suggestion && word.toLowerCase() !== suggestion.toLowerCase()) spelling.push({ word, suggestion });
    }
  }
  return { spelling, summaryVague: p.summaryVague === true };
}

/**
 * Turn the model's answer into issues. CitationGuard: a word that is not in
 * the text the model saw is dropped; duplicates collapse.
 */
export function aiIssues(output: AiPassOutput, markdown: string): Array<Omit<GradeIssue, 'id'>> {
  const seen = resumeForLlm(markdown);
  const out: Array<Omit<GradeIssue, 'id'>> = [];
  const words = new Set<string>();
  for (const s of output.spelling) {
    if (out.length >= MAX_SPELLING) break;
    const key = s.word.toLowerCase();
    if (words.has(key) || !quotedIn(s.word, seen)) continue;
    words.add(key);
    const d = ISSUE_DEFINITIONS.spelling;
    out.push({
      type: 'spelling',
      severity: d.severity,
      section: d.section,
      anchor: null,
      why: d.why,
      how: `${d.how} "${s.word}" → "${s.suggestion}"`,
      evidence: s.word,
      params: { word: s.word, suggestion: s.suggestion },
      source: 'ai',
      fixable: false,
    });
  }
  const parsed = parseResume(markdown);
  if (output.summaryVague && summaryText(parsed)) {
    const d = ISSUE_DEFINITIONS.summary_vague;
    const target = summaryTarget(parsed) ?? undefined;
    out.push({
      type: 'summary_vague',
      severity: d.severity,
      section: d.section,
      anchor: anchorFor(d.section),
      why: d.why,
      how: d.how,
      target,
      source: 'ai',
      fixable: Boolean(target),
    });
  }
  return out;
}
