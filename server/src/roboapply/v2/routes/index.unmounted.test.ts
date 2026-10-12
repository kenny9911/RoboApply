// @vitest-environment node
// WP-75 (ARCH §10.6 step 4) and INT-13 (wave5 WP-93 #44, #46): the dead V2
// surfaces — incl. the legacy job score/detail routes and /search — are no
// longer served by the /api/v1/roboapply/v2 aggregate, and their files are gone. Auth is stubbed to always answer 401, so a
// path that is still mounted answers 401 and an unmounted one falls through to
// a 404 — no handler (and no database) is reached either way.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../middleware/auth.js', () => {
  const deny = (_req: unknown, res: { status(n: number): { json(b: unknown): void } }) => {
    res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
  };
  return {
    requireAuth: deny,
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: deny,
    rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    resolveUserFromTokens: async () => null,
  };
});
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let h: RouteHarness;

beforeAll(async () => {
  const { default: v2 } = await import('./index.js');
  h = await startRouteHarness({ mounts: [['/api/v1/roboapply/v2', v2]] });
});
afterAll(async () => {
  await h?.close();
});

describe('legacy V2 aggregate after WP-75 and INT-13', () => {
  it.each([
    ['GET', '/queue'],
    ['POST', '/queue/q1/send'],
    ['GET', '/activity'],
    ['GET', '/activity/orb-stats'],
    ['GET', '/integrations'],
    ['POST', '/integrations/gmail/connect'],
    ['POST', '/onboarding/bootstrap'],
    ['GET', '/onboarding/session'],
    ['GET', '/jobs/job1'],
    ['POST', '/jobs/job1/score'],
    ['POST', '/jobs/job1/save'],
    ['POST', '/search/run'],
    ['POST', '/search/saved'],
    ['GET', '/search/saved'],
    ['DELETE', '/search/saved/s1'],
  ] as const)('%s %s is no longer served (404)', async (method, path) => {
    const res = await h.request(method, `/api/v1/roboapply/v2${path}`, { body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(404);
  });

  it.each([
    ['GET', '/tracker'],
    ['GET', '/goal'],
    ['GET', '/preferences'],
    ['GET', '/insights/weekly'],
    // Owner decision pending (wave5 WP-93 #52): /discover stays mounted.
    ['POST', '/discover/run'],
  ] as const)('%s %s is still mounted (auth runs first)', async (method, path) => {
    const res = await h.request(method, `/api/v1/roboapply/v2${path}`, { body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(401);
  });

  it.each(['jobs.ts', 'jobs.score.test.ts', 'search.ts', '../services/RAJobIndexService.ts'])('%s is deleted', (rel) => {
    expect(fs.existsSync(path.join(HERE, rel))).toBe(false);
  });

  it('nothing under server/src imports (or mocks) the deleted modules', () => {
    const SRC = path.resolve(HERE, '../../..');
    // Resolved per file: `./jobs.js` and `./search.js` are also live modules in other folders.
    const DELETED = new Set([
      'roboapply/v2/routes/jobs.ts',
      'roboapply/v2/routes/search.ts',
      'roboapply/v2/services/RAJobIndexService.ts',
      'features/match/legacyView.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'generated') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(/(?:from|import\(|vi\.mock\()\s*['"](\.[^'"]+)\.js['"]/g)) {
          const target = path.relative(SRC, path.resolve(path.dirname(full), `${m[1]}.ts`));
          if (DELETED.has(target)) offenders.push(`${path.relative(SRC, full)} → ${target}`);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
