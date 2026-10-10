// server/src/features/resume/check/placeholders.ts
//
// Unfilled placeholders: "[X]", "[n=__]", "[before → after]". The rewrite
// agent never invents a number; where a figure is missing it writes one of
// these for the user to fill in (RAResumeRewriteAgent rule 1). A resume that
// still has one is not ready to send, so Resume check lists it first.
//
// Kept identical to `findPlaceholders` in lib/resumeAnalyzer.ts (the editor's
// warning); a test compares the two on the same lines. Pure.

const PLACEHOLDER_RE =
  /\[(?:\s*(?:x{1,3}|n|#|\?{1,3}|tbd|todo)\s*|[^\]\n]{0,30}_{2,}[^\]\n]{0,30}|[^\]\n]{0,24}(?:→|->)[^\]\n]{0,24}|\s*(?:number|amount|metric|percent(?:age)?|team size|数量|数字|数值|百分比|人数|金额|比例)\s*)\](?!\()/gi;

/** The placeholders in a text, in order (a markdown link "[text](url)" is not one). */
export function findPlaceholders(text: string): string[] {
  return Array.from((text ?? '').matchAll(PLACEHOLDER_RE), (m) => m[0]);
}
