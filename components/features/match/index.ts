// components/features/match — public surface (WP-18). Cross-area imports go
// through this file (TASK_PLAN.md §2.1 rule 4).
//
//   <FitScore fit={…} />            score + honesty line + Quick estimate / AI summary
//   <DimensionList dimensions={…} /> "What we compared"
//   <WhyYouFit /> <WhatYoureMissing /> overlap and gap (F-MATCH-02/03)
//   <FitAnalysisCard jobId />       the credit-backed fit analysis (F-ORION-03)
//   <KeywordCheck rows /> <JobKeywordCheck jobId />  requirement rows (F-RES-08)
//   <JobFit jobId />                the fit block for job detail (WP-34)
//   <CompetitivenessReport />       /jobs/report, "You and what employers ask" (WP-77)
//   <CompetitivenessReportView report />  the report body (props-driven)

export { FitScore, type FitScoreData, type FitScoreProps } from './FitScore';
export { DimensionList, DIMENSION_ORDER, type DimensionListProps } from './DimensionList';
export { WhyYouFit, WhatYoureMissing, type WhyYouFitProps, type WhatYoureMissingProps } from './WhyYouFit';
export { FitAnalysisCard, FitAnalysisView, type FitAnalysisCardProps, type FitAnalysisViewProps } from './FitAnalysisCard';
export { KeywordCheck, JobKeywordCheck, type KeywordCheckProps } from './KeywordCheck';
export { JobFit, JobFitView, type JobFitViewProps } from './JobFit';
export { CompetitivenessReport } from './CompetitivenessReport';
export { CompetitivenessReportView, type CompetitivenessReportViewProps, type BroadenState } from './CompetitivenessReportView';
