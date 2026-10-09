// @vitest-environment node
//
// FND-5: platform/queue/registry.ts imports every area's workers.ts and
// registers them once; app.ts imports it for its side effect.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREA_WORKERS, registerAllWorkers, resetAreaWorkerRegistrationForTests } from './registry.js';
import { registeredKinds, resetWorkerRegistryForTests } from './drain.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('queue worker registry', () => {
  afterEach(() => {
    resetWorkerRegistryForTests();
    resetAreaWorkerRegistrationForTests();
  });

  it('covers every area workers.ts listed in TASK_PLAN §4.1.c', () => {
    expect(Object.keys(AREA_WORKERS).sort()).toEqual(
      ['agent', 'cn/jobs', 'compliance', 'copilot', 'extension', 'growth', 'jobs/enrich', 'jobs/ingest', 'match', 'notifications', 'onboarding', 'push', 'resume', 'seo'].sort(),
    );
    for (const area of Object.keys(AREA_WORKERS)) {
      const file = path.resolve(here, '../../features', area, 'workers.ts');
      expect(readFileSync(file, 'utf8'), area).toContain('export const workers');
    }
  });

  it('registers once and is idempotent', () => {
    resetWorkerRegistryForTests();
    resetAreaWorkerRegistrationForTests();
    const total = Object.values(AREA_WORKERS).reduce((n, defs) => n + defs.length, 0);
    expect(registerAllWorkers()).toBe(total);
    expect(registerAllWorkers()).toBe(0);
    const kinds = Object.values(AREA_WORKERS).flatMap((defs) => defs.map((d) => d.kind));
    expect(registeredKinds()).toEqual([...new Set(kinds)].sort());
  });

  it('has no duplicate kinds across areas', () => {
    const kinds = Object.values(AREA_WORKERS).flatMap((defs) => defs.map((d) => d.kind));
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
