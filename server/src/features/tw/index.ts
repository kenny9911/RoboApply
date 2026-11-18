// server/src/features/tw/index.ts — public surface of the Taiwan market area
// (WP-19 creates it with the profile deltas; TASK_PLAN.md R-02 places Taiwan
// market code under server/src/features/tw/). Other areas import from here only.
// MKT-5F adds the pay-disclosure rule read from config (payRule.ts; JT-6), the
// county and district table for the district filter (districts.ts; JT-7) and
// the routes that serve both (routes.ts, mounted by features/index.ts).

export {
  TW_COUNTIES,
  TW_WORK_PERMIT_STATUSES,
  TwProfileFieldsSchema,
  hasTwAnswers,
  isTaiwanRelevant,
  readTwProfileFields,
} from './profileFields.js';
export type { TwProfileFields } from './profileFields.js';

export * from './contract.js';
// routes.ts is imported by features/index.ts only (the mount point), like every area's routers: this index
// stays free of Express and the auth chains for the areas that read the profile fields or the rule.
