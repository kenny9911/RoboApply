// server/src/features/resume/check/score.ts
//
// The rubric (WP-22): a checklist score out of 100 and a label. It measures
// how the resume does against the checklist in taxonomy.ts; it is never a
// chance of passing a screen or getting hired, and the UI says so.
//
//   penalty per issue: Fix first 15 · Important 8 · Nice to have 2
//   each issue type costs at most 2× its per-issue penalty (twenty weak
//   openers are one problem, not twenty)
//   label: Excellent ≥ 85 · Good ≥ 70 · Fair ≥ 50 · Needs work < 50;
//   any "Fix first" issue caps the label at Fair.

import type { GradeCounts, GradeIssue, GradeLabel, IssueSeverity } from '../contract.js';

export const SEVERITY_PENALTY: Record<IssueSeverity, number> = { urgent: 15, critical: 8, optional: 2 };
export const LABEL_FLOORS: Array<[GradeLabel, number]> = [
  ['excellent', 85],
  ['good', 70],
  ['fair', 50],
  ['needs_work', 0],
];

export function countBySeverity(issues: readonly GradeIssue[]): GradeCounts {
  const counts: GradeCounts = { urgent: 0, critical: 0, optional: 0 };
  for (const i of issues) counts[i.severity] += 1;
  return counts;
}

export function scoreIssues(issues: readonly GradeIssue[]): number {
  const byType = new Map<string, { severity: IssueSeverity; n: number }>();
  for (const i of issues) {
    const cur = byType.get(i.type) ?? { severity: i.severity, n: 0 };
    cur.n += 1;
    byType.set(i.type, cur);
  }
  let penalty = 0;
  for (const { severity, n } of byType.values()) penalty += SEVERITY_PENALTY[severity] * Math.min(n, 2);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function labelFor(score: number, counts: GradeCounts): GradeLabel {
  let label: GradeLabel = 'needs_work';
  for (const [l, floor] of LABEL_FLOORS) {
    if (score >= floor) {
      label = l;
      break;
    }
  }
  if (counts.urgent > 0 && (label === 'excellent' || label === 'good')) label = 'fair';
  return label;
}

export function gradeIssues(issues: readonly GradeIssue[]): { score: number; label: GradeLabel; counts: GradeCounts } {
  const counts = countBySeverity(issues);
  const score = scoreIssues(issues);
  return { score, label: labelFor(score, counts), counts };
}
