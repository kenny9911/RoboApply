'use client';

// AiGeneratedBadge — the explicit "AI generated" label on every block of AI
// output on GoApply (generative-AI labelling rules; TASK_PLAN.md §2.2, WP-13).
//
// STUB (FND-6b). Owner: WP-13. Renders nothing. Callers render it next to
// every AI block unconditionally; the badge itself decides to show only when
// brand.market === 'cn' (and stays silent on RoboApply), so no caller
// branches on market.

export interface AiGeneratedBadgeProps {
  /** What the block is, for the label wording and the label log. */
  kind?: 'text' | 'document' | 'audio';
}

export function AiGeneratedBadge(_props: AiGeneratedBadgeProps = {}): null {
  return null;
}

export default AiGeneratedBadge;
