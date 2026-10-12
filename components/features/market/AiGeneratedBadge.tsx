'use client';

// AiGeneratedBadge — the explicit "AI generated" label (AI 辅助生成) on every
// block of AI output on GoApply (generative-AI labelling measures, CN-E-07;
// TASK_PLAN.md §2.2, WP-13).
//
// Callers render it next to every AI block unconditionally; the badge itself
// shows only when brand.market === 'cn' and renders nothing on RoboApply, so
// no caller branches on market. (RoboApply labels AI text with its own
// "AI-written" lines; exported files carry the machine-readable mark on both
// brands — server/src/features/compliance/aiLabel.ts.)

import { useBrand } from '../../../lib/brand';
import { AiBadgeView } from '../compliance';

export interface AiGeneratedBadgeProps {
  /** What the block is, for the label wording. */
  kind?: 'text' | 'document' | 'audio';
}

export function AiGeneratedBadge({ kind = 'text' }: AiGeneratedBadgeProps = {}) {
  const brand = useBrand();
  if (brand.market !== 'cn') return null;
  return <AiBadgeView kind={kind} />;
}

export default AiGeneratedBadge;
