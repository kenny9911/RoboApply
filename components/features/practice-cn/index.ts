// components/features/practice-cn — public surface of the GoApply practice report (WP-66).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   CnReport      — the blocks for an interview-engine session (`{ sessionId }`);
//   CnReportView  — the same blocks from a report block (the written practice
//                   renders it with the block its score returns, with `typed`);
//   CnQuestionTiming — the per-question timing line, from the numbers in
//                   blueprint.cnFormat (text-practice UI renders it);
//   buildCnPracticeReport / normalizeCnTurns — the client mirror of the rubric;
//   useLocalizeType / isCnFormatType / plannedMinutesForType / CN_FORMAT_DURATIONS
//                 — the format in the practice setup (its label, its 20–30 min rule);
//   cnTimingFor / asCnPracticeReport — reading what the written practice returns.

export { CnReport, type CnReportProps } from './CnReport';
export { CnReportView } from './CnReportView';
export { CnQuestionTiming } from './CnQuestionTiming';
export { cnReportFromEngine } from './fromSession';
export {
  CN_FORMAT_DURATIONS,
  asCnPracticeReport,
  cnTimingFor,
  isCnFormatType,
  plannedMinutesForType,
  useLocalizeType,
} from './format';
export {
  buildCnPracticeReport,
  normalizeCnTurns,
} from './rubric';
