// server/src/features/tw/index.ts — public surface of the Taiwan market area
// (WP-19 creates it with the profile deltas; TASK_PLAN.md R-02 places Taiwan
// market code under server/src/features/tw/). Other areas import from here only.

export {
  TW_ANYWHERE,
  TW_COUNTIES,
  TW_PAY_LIMITS,
  TW_WORK_PERMIT_STATUSES,
  TwDesiredPaySchema,
  TwProfileFieldsSchema,
  hasTwAnswers,
  isTaiwanRelevant,
  readTwProfileFields,
} from './profileFields.js';
export type { TwCounty, TwDesiredPay, TwProfileFields, TwWorkPermitStatus } from './profileFields.js';
