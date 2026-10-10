// hooks/copilot — the Assistant's hooks (WP-51). Other areas import from here
// only (TASK_PLAN.md §2.1 rule 4). To open the Assistant from anywhere use
// `useOpenAssistant()` (hooks/shared); to offer a proactive nudge from a real
// signal use `offerAssistantNudge()`.

export { copilotKeys } from './keys';
export { useCopilotAvailability, useAiConsent, markAssistantAiUnavailable, __resetAssistantAvailability, AI_CONSENT_TYPE, type AiConsent, type CopilotAvailability } from './useCopilotAvailability';
export { useCopilotChat, type CopilotChat, type CopilotChip, type SendOptions } from './useCopilotChat';
export { chatReducer, fromServer, runningTool, INITIAL_CHAT, RETRYABLE_CODES, type ChatAction, type ChatMessage, type ChatState, type MessageStatus, type ToolActivity, type TurnError } from './turnState';
export { useThreads, useArchiveThread } from './useThreads';
export { useMemory, useDeleteMemory, useMemoryConsent, MEMORY_CONSENT_TYPE, type MemoryConsent } from './useMemory';
export { useProposal, proposalFailure, isExpired, MEMORY_CONSENT_REQUIRED, PROPOSAL_APPLYING, type ProposalOutcome, type ProposalStatus, type UseProposalOptions } from './useProposal';
export { useRailMemory, useUiStateQuery, RAIL_VALUE_KEY, FAB_DISMISS_KEY, type RailMemory, type RailMemoryOptions } from './useRailMemory';
export { offerAssistantNudge, markNudgeShown, clearAssistantNudge, usePendingNudge, nudgeSessionShown, isNudgeKind, NUDGE_KINDS, NUDGE_SESSION_KEY, __resetNudges, type AssistantNudge, type NudgeKind } from './nudges';
export { useServerNudge, NUDGE_QUERY_KEY, type ServerNudgeOptions } from './useServerNudge';
export { useVoiceInput, speechRecognitionCtor, type VoiceInput } from './useVoiceInput';
