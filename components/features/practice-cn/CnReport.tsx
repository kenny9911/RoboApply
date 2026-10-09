'use client';

// CnReport — the GoApply AI面试 practice report blocks: communication / logic /
// behaviour dimensions, STAR completeness, filler-word counts (TASK_PLAN.md
// WP-66).
//
// STUB (FND-6b). Owner: WP-66. Renders nothing. WP-43's report page renders
// it on GoApply only (brand.market === 'cn'), next to the shared report; AI
// output in it carries AiGeneratedBadge.

export interface CnReportProps {
  /** The practice session the report belongs to. */
  sessionId: string;
}

export function CnReport(_props: CnReportProps): null {
  return null;
}

export default CnReport;
