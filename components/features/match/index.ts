// components/features/match — public surface (WP-18). Cross-area imports go
// through this file (TASK_PLAN.md §2.1 rule 4).
//
//   <FitScore fit={…} />            score + honesty line + Quick estimate / AI summary
//   <DimensionList dimensions={…} /> "What we compared"
//   <WhyYouFit /> <WhatYoureMissing /> overlap and gap (F-MATCH-02/03)
//   <RequirementChecklist requirements /> "What the post asks for": must-haves first, with quotes (scorer v4)
//   <KeywordCheck rows /> <JobKeywordCheck jobId />  requirement rows (F-RES-08)
//   <JobFit jobId />                the fit block for job detail (WP-34)
//   <CompetitivenessReport />       /jobs/report, "You and what employers ask" (WP-77)
//   <CompetitivenessReportView report />  the report body (props-driven)

export { FitScore } from './FitScore';
export { DimensionList, notComparedKey } from './DimensionList';
export { RequirementChecklist, listedRequirements } from './RequirementChecklist';
export { WhyYouFit, WhatYoureMissing, skillCounts } from './WhyYouFit';
export { KeywordCheck, JobKeywordCheck, keywordCounts, keywordState } from './KeywordCheck';
export { JobFit, JobFitView } from './JobFit';
export { CompetitivenessReport } from './CompetitivenessReport';
export { CompetitivenessReportView } from './CompetitivenessReportView';
