// hooks/copilot/keys.ts — React Query keys of the Assistant area (WP-51).

export const copilotKeys = {
  all: ['copilot'] as const,
  threads: () => ['copilot', 'threads'] as const,
  messages: (threadId: string) => ['copilot', 'messages', threadId] as const,
  memory: () => ['copilot', 'memory'] as const,
};

/** Same key as the compliance area's consents query, so both share one cache entry per locale. */
export const consentsKey = (locale: string) => ['compliance', 'consents', locale] as const;
