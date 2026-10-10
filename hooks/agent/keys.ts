// hooks/agent/keys.ts — TanStack keys of Ready to apply (WP-53). Every key is
// rooted at 'agent', so `useAddToReady` (hooks/job) refreshes them all.

export const agentKeys = {
  all: ['agent'] as const,
  settings: () => ['agent', 'settings'] as const,
  setup: () => ['agent', 'setup'] as const,
  queue: () => ['agent', 'queue'] as const,
  badge: () => ['agent', 'badge'] as const,
  kit: (id: string) => ['agent', 'kit', id] as const,
  history: (id: string) => ['agent', 'history', id] as const,
  suggestions: (limit?: number) => (limit === undefined ? (['agent', 'suggestions'] as const) : (['agent', 'suggestions', limit] as const)),
  answers: () => ['agent', 'answers'] as const,
  questions: () => ['agent', 'questions'] as const,
};
