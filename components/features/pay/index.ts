// components/features/pay — public surface of the pay check (/pay; "Pay check").
// Cross-area imports go through this file (TASK_PLAN.md §2.1 rule 4).
//
//   <PayCheckPage initialTitle initialLocation />   the /pay page body (flag `jobs.feed`)
//   <PayCheckResult data asked onAsk />              one answer: counts, window, ranges per currency
//   <PayRange entry />                               one currency's 25th–75th band and median
//   payCheckHref(ask) / payCheckHrefForJob(job)       links into the page (the job page's entry point)

export { PayCheckPage, savedSearchTitle } from './PayCheckPage';
export {
  formatMoney,
  payCheckHref,
  payCheckHrefForJob,
  rangeBar,
} from './format';
