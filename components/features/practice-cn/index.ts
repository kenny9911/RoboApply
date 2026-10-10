// components/features/practice-cn — public surface of the GoApply practice report (WP-66).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   CnReport      — the blocks for an interview-engine session (`{ sessionId }`);
//   CnReportView  — the same blocks from a report block (the written practice
//                   can render it with the block its score returns);
//   CnQuestionTiming — the per-question timing line, from the numbers in
//                   blueprint.cnFormat (text-practice UI renders it);
//   buildCnPracticeReport / normalizeCnTurns — the client mirror of the rubric.

export { CnReport, type CnReportProps } from './CnReport';
export { CnReportView, type CnReportViewProps } from './CnReportView';
export { CnQuestionTiming, type CnQuestionTimingProps } from './CnQuestionTiming';
export { cnReportFromEngine } from './fromSession';
export {
  buildCnPracticeReport,
  normalizeCnTurns,
  type CnAreaBasis,
  type CnAreaKey,
  type CnAreaScore,
  type CnPracticeReport,
  type StarPart,
} from './rubric';
