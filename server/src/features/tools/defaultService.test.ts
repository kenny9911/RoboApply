// @vitest-environment node
//
// WP-57: the production wiring keeps the checked resume through
// RAResumeService.create (a base resume) and maps a full resume list to
// `resume_limit` (409 at the route).

import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class ResumeLimitError extends Error {
    readonly code = 'resume_limit_reached';
  }
  return { create: vi.fn(), ResumeLimitError };
});

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../roboapply/v2/services/RAResumeService.js', () => ({ raResumeService: { create: m.create }, ResumeLimitError: m.ResumeLimitError }));

import { getToolsService, keepResumeInAccount } from './defaultService.js';
import * as surface from './index.js';

describe('default tools service', () => {
  it('is one process-wide instance with every method', () => {
    const s = getToolsService();
    expect(getToolsService()).toBe(s);
    for (const k of ['config', 'run', 'getResult', 'claim', 'purge'] as const) expect(typeof s[k]).toBe('function');
    expect(typeof surface.toolsOpen).toBe('function');
    // No server-side claim by result id: a result is kept only from the browser that ran it.
    expect(surface).not.toHaveProperty('claimToolResult');
  });

  it('keeps the resume as a base resume and maps a full list to resume_limit', async () => {
    m.create.mockResolvedValueOnce({ id: 'rv_9' });
    await expect(keepResumeInAccount('u1', { name: 'cv', markdown: '# Sam' })).resolves.toEqual({ id: 'rv_9' });
    expect(m.create).toHaveBeenCalledWith('u1', { kind: 'base', name: 'cv', resumeMarkdown: '# Sam' });
    m.create.mockRejectedValueOnce(new m.ResumeLimitError('full'));
    await expect(keepResumeInAccount('u1', { name: 'cv', markdown: '# Sam' })).rejects.toMatchObject({ code: 'resume_limit' });
    m.create.mockRejectedValueOnce(new Error('db'));
    await expect(keepResumeInAccount('u1', { name: 'cv', markdown: '# Sam' })).rejects.toThrow('db');
  });
});
