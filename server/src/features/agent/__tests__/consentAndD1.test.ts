// @vitest-environment node
//
// WP-52 acceptance:
//   - With AI consent off (`aiAllowed(user) = false`, the GoApply default
//     without an `ai_resume_parsing` grant), the production AI gate
//     (`defaultAgentDeps().aiAvailable`) keeps every LLM step off: a kit is
//     prepared from the user's own resume, revisions answer ai_unavailable,
//     and LLMService is never called.
//   - D1: this area never calls an employer endpoint — its sources make no
//     outbound HTTP request of their own, and nothing in it can produce a
//     "submitted" state.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chat, aiAllowedMock } = vi.hoisted(() => ({
  chat: vi.fn(async () => {
    throw new Error('LLMService must not be called');
  }),
  aiAllowedMock: vi.fn(async (_userId: string) => false),
}));

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/llm/LLMService.js', () => ({ llmService: { chat, chatStream: chat }, LLMService: class {} }));
vi.mock('../../../platform/consent/aiAllowed.js', () => ({ aiAllowed: (userId: string) => aiAllowedMock(userId) }));

import { defaultAgentDeps } from '../deps.js';
import { createAgentService } from '../service.js';
import { makeDb, makeDeps, seedItem } from './testkit.js';

beforeEach(() => {
  chat.mockClear();
  aiAllowedMock.mockReset().mockResolvedValue(false);
});

describe('AI consent off (production gate)', () => {
  function build() {
    const db = makeDb();
    const fakes = makeDeps(db, 'roboapply');
    const prod = defaultAgentDeps();
    // The production AI gate and the production LLM callers; every other seam is a fake.
    const service = createAgentService({
      ...fakes.deps,
      aiAvailable: prod.aiAvailable,
      tailor: prod.tailor,
      createLetter: prod.createLetter,
      rewriteLetter: prod.rewriteLetter,
      regenerateLetter: prod.regenerateLetter,
    });
    return { db, service, calls: fakes.calls };
  }

  it('prepares a kit with zero LLM calls and no AI credit lines', async () => {
    const { db, service } = build();
    const id = await seedItem(db, { jobId: 'j2' });
    const proposal = await service.prepare('u1', [id], true);
    expect(proposal.aiAvailable).toBe(false);
    expect(proposal.credits.map((c) => c.bucket)).toEqual(['ready_kits']);
    expect(await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' })).toBe('ready');
    const detail = await service.detail('u1', id);
    expect(detail.kit.aiAvailable).toBe(false);
    expect(detail.item).toMatchObject({ state: 'ready_for_review', resumeVariantId: 'rv_base', coverLetterId: null });
    await expect(service.confirmPart('u1', id, { part: 'resume', decision: 'revise' })).rejects.toMatchObject({ code: 'ai_unavailable' });
    await expect(service.confirmPart('u1', id, { part: 'letter', decision: 'revise', instruction: 'Shorter' })).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(chat).not.toHaveBeenCalled();
    expect(aiAllowedMock).toHaveBeenCalledWith('u1');
  });
});

describe('GoApply recruitment-info mode: the production visibility seam', () => {
  const jobs = [
    { id: 'gh', market: 'cn', visibility: 'public', ownerUserId: null },
    { id: 'own', market: 'cn', visibility: 'private', ownerUserId: 'u1' },
    { id: 'intl', market: 'intl', visibility: 'public', ownerUserId: null },
  ];
  const withMode = async <T,>(mode: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.CN_RECRUITMENT_INFO_MODE;
    if (mode === undefined) delete process.env.CN_RECRUITMENT_INFO_MODE;
    else process.env.CN_RECRUITMENT_INFO_MODE = mode;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CN_RECRUITMENT_INFO_MODE;
      else process.env.CN_RECRUITMENT_INFO_MODE = prev;
    }
  };

  it('CN_RECRUITMENT_INFO_MODE=off hides third-party postings and keeps the user\'s own imports', async () => {
    const visible = await withMode('off', () => defaultAgentDeps().visibleJobs(jobs, 'u1'));
    expect(visible.map((j) => j.id)).toEqual(['own', 'intl']);
  });

  it('nothing set: third-party postings are visible (D5: the feed is on by default)', async () => {
    const visible = await withMode(undefined, () => defaultAgentDeps().visibleJobs(jobs, 'u1'));
    expect(visible.map((j) => j.id)).toEqual(['gh', 'own', 'intl']);
  });
});

describe('D1: never submits, never calls an employer', () => {
  const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
    });

  it('makes no outbound HTTP request of its own', () => {
    const files = sources(DIR);
    expect(files.length).toBeGreaterThan(5);
    const banned = [/\bfetch\s*\(/, /\baxios\b/, /from\s+['"]node:https?['"]/, /from\s+['"]https?['"]/, /\bgot\s*\(/, /\bundici\b/, /XMLHttpRequest/];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const re of banned) expect(re.test(src), `${path.basename(file)} matches ${re}`).toBe(false);
    }
  });

  it('never writes a "submitted" state', () => {
    for (const file of sources(DIR)) {
      const src = readFileSync(file, 'utf8');
      expect(/state:\s*['"]submitted['"]/.test(src), path.basename(file)).toBe(false);
      expect(/['"]submitted['"]\s*\)/.test(src), path.basename(file)).toBe(false);
    }
  });
});
