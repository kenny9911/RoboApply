// hooks/copilot — the Assistant's hooks (WP-51). Other areas import from here
// only (TASK_PLAN.md §2.1 rule 4). To open the Assistant from anywhere use
// `useOpenAssistant()` (hooks/shared); to offer a proactive nudge from a real
// signal use `offerAssistantNudge()`.

export { copilotKeys } from './keys';
export { useCopilotAvailability, useAiConsent, __resetAssistantAvailability } from './useCopilotAvailability';
export { useCopilotChat, type CopilotChat, type CopilotChip } from './useCopilotChat';
export { chatReducer, fromServer, runningTool, INITIAL_CHAT, type ChatMessage, type ChatState } from './turnState';
export { useThreads, useArchiveThread } from './useThreads';
export { useMemory, useDeleteMemory, useMemoryConsent } from './useMemory';
export { useProposal, proposalFailure, isExpired, PROPOSAL_APPLYING } from './useProposal';
export { useRailMemory } from './useRailMemory';
export { offerAssistantNudge, markNudgeShown, clearAssistantNudge, usePendingNudge, NUDGE_KINDS, __resetNudges } from './nudges';
export { useServerNudge } from './useServerNudge';
export { useVoiceInput } from './useVoiceInput';
