// server/src/features/cn/interview/index.ts — public surface of the GoApply
// AI-interview practice format (WP-66). Other areas import from here only
// (TASK_PLAN.md §2.1 rule 4).
//
//   - format: `buildCnScript`, `CN_QUESTION_SETS`, `usesCnFormat`, the
//     model-facing directive/lens (registered in interview-engine
//     catalog/interviewFormats.ts for market `cn`);
//   - rubric: `checkStar`, `countFillers`, `isStoryQuestion`, `scoreAreas`;
//   - report: `buildCnPracticeReport`, `normalizeCnTurns` — the `report.cn`
//     block on a GoApply practice (interview-engine scoring, text practice).

export * from './contract.js';
export {
  CN_FORMAT_BLUEPRINT_DIRECTIVE,
  CN_FORMAT_EVALUATION_LENS,
  CN_FORMAT_FOCUS_AREAS,
  CN_QUESTION_SETS,
  CN_SCRIPT_SECTIONS,
  allCnQuestions,
  buildCnScript,
  clampCnMinutes,
  cnScriptLanguage,
  fitsCnFormatMinutes,
  cnStrategyPhases,
  questionHint,
  questionText,
  questionTip,
  scriptSeconds,
  storyQuestionCount,
  usesCnFormat,
} from './format.js';
export type { BuildCnScriptInput } from './format.js';
export {
  FILLER_RULES,
  STAR_CUES,
  STAR_PART_ORDER,
  answerLength,
  checkStar,
  countFillers,
  isChineseText,
  isFollowUp,
  isStoryQuestion,
  scoreAreas,
  summarizeStar,
} from './rubric.js';
export { buildCnPracticeReport, groupAnswers, normalizeCnTurns } from './report.js';
export type { BuildCnReportInput } from './report.js';
