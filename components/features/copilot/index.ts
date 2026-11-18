// components/features/copilot — public surface of the Assistant area (WP-51).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4). To open the
// Assistant use `useOpenAssistant()` (hooks/shared); for a proactive nudge
// use `offerAssistantNudge()` (hooks/copilot).

export { CopilotRail } from './CopilotRail';
export { SettingsSection as CopilotSettingsSection } from './SettingsSection';
export { AssistantPage } from './AssistantPage';
export { CopilotCardView } from './cards';
