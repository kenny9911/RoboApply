// components/features/practice — public surface of the practice entry area (WP-43).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
// WP-63a adds NetworkPrecheck.tsx to this folder in Wave 4.

export { RecordingConsentSheet, type RecordingConsentSheetProps } from './RecordingConsentSheet';
export { RecordingRow, type RecordingRowProps } from './RecordingRow';
export { PracticeJobBanner, type PracticeJobBannerProps } from './PracticeJobBanner';
export { PracticeNotices, PRACTICE_NOTICE_LINKS, type PracticeNoticeKind } from './PracticeNotices';
export { PracticeReportEnd, PRACTICE_PLANS_HREF, type PracticeReportEndProps } from './PracticeReportEnd';
export { TextPracticeRoom, type TextPracticeRoomProps } from './TextPracticeRoom';
export { setupNotices, type SetupNoticeInput } from './setupNotices';
