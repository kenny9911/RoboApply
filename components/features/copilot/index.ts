// components/features/copilot — public surface of the Assistant area (WP-51).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4). To open the
// Assistant use `useOpenAssistant()` (hooks/shared); for a proactive nudge
// use `offerAssistantNudge()` (hooks/copilot).

export { CopilotRail, isRailShortcut, type CopilotRailProps } from './CopilotRail';
export { SettingsSection as CopilotSettingsSection } from './SettingsSection';
export { AssistantPage } from './AssistantPage';
export { CopilotThread, type CopilotThreadProps } from './CopilotThread';
export { MessageList, type MessageListProps } from './MessageList';
export { ChipBar, ASK_CHIPS, type ChipBarProps } from './ChipBar';
export { Cheatsheet, CHEATSHEET_GROUPS } from './Cheatsheet';
export { VoiceInput } from './VoiceInput';
export { ACTION_CARD_CAPS, CopilotCardView, CARD_COMPONENTS, type CardContext } from './cards';
