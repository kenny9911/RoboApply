// components/features/today — /today, the signed-in home ("the desk";
// docs/agent-driven/REDESIGN.md §5). Other areas import from here only.
//
//   TodayPage    the route body: gathers the reads (hooks/today) and draws the desk
//   TodayDesk    the desk itself, from the reads it is handed (tests, previews)
//   todayModel   pure: what waits (order, cap), the title, the counts, the goal line

export { TodayPage } from './TodayPage';
export { TodayDesk, type TodayDeskProps } from './TodayDesk';
export { WaitingList, waitingHref, PICKS_ANCHOR, type WaitingListProps } from './WaitingList';
export { JobSearchLane, jobHref, shownPicks, useHeldPicks, type JobSearchLaneProps } from './JobSearchLane';
export { ApplicationsLane, type ApplicationsLaneProps } from './ApplicationsLane';
export { ResumeLane, ASKED_LIMIT, type ResumeLaneProps } from './ResumeLane';
export { AskBox, ASK_MAX_LENGTH } from './AskBox';
export { GoalLine, SEARCH_SETTINGS_HREF, type GoalLineProps } from './GoalLine';
export {
  GOAL_GROUP_LIMIT,
  WAITING_LIMIT,
  applicationNumbers,
  goalFacts,
  goalIsEmpty,
  sentThisWeek,
  titleOf,
  waitingOf,
  weekOfNow,
  type ApplicationNumbers,
  type GoalFacts,
  type TitleState,
  type WaitingItem,
  type WaitingKind,
  type WaitingSources,
  type WaitingState,
} from './todayModel';
