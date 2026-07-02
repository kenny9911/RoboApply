// Typed wrappers around the runs endpoints. Mounted at
// /api/v1/roboapply/runs/*.

import { roboApi } from './client';
import type { RoboRun, RoboRunStatus } from './types';

export interface ListRunsInput {
  status?: RoboRunStatus | RoboRunStatus[];
  from?: string;
  to?: string;
  limit?: number;
}

function toQuery(input: ListRunsInput): string {
  const parts: string[] = [];
  if (input.status) {
    const statuses = Array.isArray(input.status)
      ? input.status
      : [input.status];
    for (const s of statuses) parts.push(`status=${encodeURIComponent(s)}`);
  }
  if (input.from) parts.push(`from=${encodeURIComponent(input.from)}`);
  if (input.to) parts.push(`to=${encodeURIComponent(input.to)}`);
  if (input.limit) parts.push(`limit=${input.limit}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function listRuns(input: ListRunsInput = {}) {
  return roboApi.get<{ runs: RoboRun[]; total: number }>(
    `/api/v1/roboapply/runs${toQuery(input)}`,
  );
}

export function getRun(id: string) {
  return roboApi.get<RoboRun>(`/api/v1/roboapply/runs/${encodeURIComponent(id)}`);
}

export function skipRun(id: string) {
  return roboApi.post<RoboRun>(
    `/api/v1/roboapply/runs/${encodeURIComponent(id)}/skip`,
  );
}

export function applyEarly(id: string) {
  return roboApi.post<RoboRun>(
    `/api/v1/roboapply/runs/${encodeURIComponent(id)}/apply-early`,
  );
}

export function undoRun(id: string) {
  return roboApi.post<RoboRun>(
    `/api/v1/roboapply/runs/${encodeURIComponent(id)}/undo`,
  );
}

export interface RunPrompt {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}

/**
 * Returns the literal cover-letter prompt (system + user) for transparency.
 * Backend route per arch §5: POST /runs/:id/show-prompt
 */
export function getRunPrompt(id: string) {
  return roboApi.post<RunPrompt>(
    `/api/v1/roboapply/runs/${encodeURIComponent(id)}/show-prompt`,
  );
}
