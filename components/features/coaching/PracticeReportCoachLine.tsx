'use client';

// PracticeReportCoachLine — one line at the end of a practice report:
// "Prefer a person? See coaches" (TASK_PLAN.md WP-72; rulings F17 + C28).
//
// STUB (FND-6b). Owner: WP-72. Renders nothing. WP-43's report page renders
// it for every finished session; it shows only when the `coaching` flag is on
// AND the brand's roster has at least one active coach (real people only).

export interface PracticeReportCoachLineProps {
  /** The practice session the report belongs to. */
  sessionId: string;
  /** The job the session practised for, when there was one. */
  jobId?: string | null;
}

export function PracticeReportCoachLine(_props: PracticeReportCoachLineProps): null {
  return null;
}

export default PracticeReportCoachLine;
