// components/features/visitor — public surface of the visitor area (WP-78).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//   VisitorFeed       browse pages (WP-56) render it under their list
//   VisitorAssistant  the signed-out assistant launcher (VisitorFeed mounts it;
//                     INT may mount it on /job/* too)
//   JobAlertsForm     /tools/job-alerts
//   AlertConfirm      /alerts/confirm/[token]

export { VisitorFeed, visitorFeedQueryKey, type VisitorFeedProps, type VisitorFeedQuery } from './VisitorFeed';
export { VisitorAssistant, type VisitorAssistantProps, type VisitorPageContext } from './VisitorAssistant';
export { VisitorJobCard, type VisitorJobCardProps } from './VisitorJobCard';
export { JobAlertsForm, type JobAlertsFormProps } from './JobAlertsForm';
export { AlertConfirm, type AlertConfirmProps } from './AlertConfirm';
export { alertFilters, alertsHref, signupHref as visitorSignupHref, visitorJobHref, VISITOR_FEED_LIMIT } from './model';
