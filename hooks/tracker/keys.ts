// hooks/tracker/keys.ts — TanStack keys of the applications tracker (WP-38).
// The board itself lives under `pipelineKeys` (hooks/usePipelineBoard.ts).

export const trackerKeys = {
  all: ['tracker'] as const,
  followUps: () => ['tracker', 'follow-ups'] as const,
  entry: (id: string) => ['tracker', 'entry', id] as const,
  events: (id: string) => ['tracker', 'events', id] as const,
  artifacts: (id: string) => ['tracker', 'artifacts', id] as const,
  weekly: (weekStartUtc?: string) => ['tracker', 'weekly', weekStartUtc ?? 'current'] as const,
};
