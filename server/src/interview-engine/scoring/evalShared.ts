// backend/src/interview-engine/scoring/evalShared.ts
//
// Small shared helpers for the LLM evaluation agents (Holistic / DeepDive /
// Recommendations): string clipping, score clamping, transcript rendering for
// the prompt, and robust JSON extraction. Mirrors the parse robustness used by
// InterviewBlueprintAgent so a slightly-malformed LLM reply still parses.

import type { TranscriptTurn } from '../types.js';

/** Trim + cap a value to a string of at most `max` chars. */
export function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Coerce to an array of non-empty clipped strings, capped. */
export function strArr(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = clip(v, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Round + clamp a number into 0..100; non-finite → fallback. */
export function clampScore(n: unknown, fallback = 0): number {
  const v = typeof n === 'number' ? n : Number.parseFloat(String(n ?? ''));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// 48k chars ≈ 12-16k tokens of transcript — fits comfortably alongside the
// agents' 12k completion budgets. The old 16k cap cut off 30-55 min English
// sessions mid-interview, so DeepDive falsely marked late questions as missed.
const MAX_TRANSCRIPT_CHARS = 48000;

/**
 * Marker appended when the rendered transcript hits the cap. Exported so agent
 * prompts can name it and instruct the model how to treat the cut-off (e.g.
 * DeepDive must not grade questions that fall beyond it).
 */
export const TRANSCRIPT_TRUNCATION_MARKER = '[transcript truncated — the interview continued beyond this point]';

/**
 * Render the transcript for the LLM: drop interim + system turns, label each
 * turn by speaker, and cap the total size. Keeps chronological order so the
 * model can align questions to answers. When over the cap we keep the head
 * (Q&A flows forward) and mark the truncation.
 */
export function renderTranscriptForLLM(turns: TranscriptTurn[], candidateName?: string): string {
  const who = candidateName?.trim() || 'Candidate';
  const lines: string[] = [];
  for (const t of turns) {
    if (t.interim || t.role === 'system') continue;
    const text = (t.text ?? '').trim();
    if (!text) continue;
    const label = t.role === 'candidate' ? who : 'Interviewer';
    lines.push(`${label}: ${text}`);
  }
  const joined = lines.join('\n\n');
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  return `${joined.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n${TRANSCRIPT_TRUNCATION_MARKER}`;
}

/** Strict-JSON-then-regex extraction of a JSON OBJECT. Returns null on failure. */
export function parseJsonObject(response: string): Record<string, unknown> | null {
  const cleaned = (response || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const p = JSON.parse(cleaned);
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch { /* fall through */ }
  }
  return null;
}

/** Strict-JSON-then-regex extraction of a JSON ARRAY. Returns null on failure. */
export function parseJsonArray(response: string): unknown[] | null {
  const cleaned = (response || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const p = JSON.parse(cleaned);
    if (Array.isArray(p)) return p;
    // Some models wrap the array in { "items": [...] } / { "questions": [...] }.
    if (p && typeof p === 'object') {
      for (const v of Object.values(p as Record<string, unknown>)) {
        if (Array.isArray(v)) return v;
      }
    }
  } catch { /* fall through */ }
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (Array.isArray(p)) return p;
    } catch { /* fall through */ }
  }
  return null;
}
