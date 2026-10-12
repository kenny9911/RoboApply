// server/src/features/agent/kinds.ts — queue work kinds of Ready to apply (WP-52).
// Kept apart from workers.ts so the seams (deps.ts) can name the kind without
// importing the worker (which imports the service).

export const AGENT_WORK_KINDS = { agentPrepare: 'agent.prepare', agentRecordFiles: 'agent.record-files' } as const;
