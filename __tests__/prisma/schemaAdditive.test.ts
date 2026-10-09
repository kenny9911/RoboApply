// @vitest-environment node
//
// FND-1b acceptance: the schema change for db push #1 (and every later
// SCHEMA-n step) is additive. This runs the G1 diff (a) of
// docs/jobright-clone/TASK_PLAN.md §4.0 offline —
//   prisma migrate diff --from-schema <pre-clone schema.prisma> --to-schema server/prisma/schema --script
// — with the pre-clone single-file schema taken from git (11e102f, the commit
// the branch was cut from; main's schema.prisma was unchanged through 8278e5f),
// and asserts the SQL only creates things: no DROP, no column type change, no
// SET NOT NULL on existing columns, no rename; existing tables only gain
// nullable/defaulted columns, indexes and FKs; enums only gain values.
// No database is contacted (--from-schema / --to-schema are both files).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from './schemaModel';

const BASE_COMMIT = '11e102fa433eeb0df2de7f655761fde0047285a5';

function baselineSchema(): string | null {
  try {
    return execFileSync('git', ['show', `${BASE_COMMIT}:server/prisma/schema.prisma`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const baseline = baselineSchema();
let dir = '';
let sql = '';

/** Split the script into statements (comment lines dropped). */
function statements(script: string): string[] {
  return script
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Tables that exist before the clone (every CREATE TABLE in the baseline). */
function baselineTables(): Set<string> {
  return new Set([...(baseline ?? '').matchAll(/^model (\w+) \{/gm)].map((m) => m[1]));
}

// Needs git history containing BASE_COMMIT. Where it is missing (a shallow
// clone) the suite is skipped; the orchestrator's G1/SCHEMA-n diff still runs.
describe.skipIf(baseline === null)('FND-1b additive schema diff (G1 diff a)', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fnd1b-'));
    const base = join(dir, 'schema.prisma');
    writeFileSync(base, baseline as string);
    sql = execFileSync(
      'npx',
      ['prisma', 'migrate', 'diff', '--from-schema', base, '--to-schema', join('server', 'prisma', 'schema'), '--script'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('is not empty (FND-1b adds the planned models)', () => {
    expect(sql).toMatch(/CREATE TABLE "RAWorkItem"/);
    expect(sql).toMatch(/CREATE TABLE "RASearchProfile"/);
  });

  it('drops, renames and retypes nothing', () => {
    const bad = statements(sql).filter((s) =>
      /\bDROP\b|\bRENAME\b|ALTER COLUMN|SET NOT NULL|SET DATA TYPE|\bTRUNCATE\b|\bDELETE\b|\bUPDATE "/i.test(
        s.replace(/ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION)|ON UPDATE CASCADE/g, ''),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('only creates tables that did not exist before', () => {
    const existing = baselineTables();
    const created = statements(sql)
      .map((s) => /^CREATE TABLE "(\w+)"/.exec(s)?.[1])
      .filter((n): n is string => Boolean(n));
    expect(created.length).toBeGreaterThan(0);
    expect(created.filter((n) => existing.has(n))).toEqual([]);
  });

  it('alters existing tables only by adding nullable/defaulted columns or FK constraints', () => {
    const bad: string[] = [];
    for (const s of statements(sql)) {
      const m = /^ALTER TABLE "(\w+)" (.*)$/.exec(s);
      if (!m) continue;
      if (/^ADD CONSTRAINT "\w+" FOREIGN KEY/.test(m[2])) continue;
      for (const clause of m[2].split(/,\s*(?=ADD )/)) {
        const col = /^ADD COLUMN "(\w+)" (.*)$/.exec(clause.trim());
        if (!col) {
          bad.push(`${m[1]}: ${clause}`);
          continue;
        }
        const def = col[2];
        if (/NOT NULL/.test(def) && !/DEFAULT/.test(def)) bad.push(`${m[1]}.${col[1]}: NOT NULL without DEFAULT`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('changes enums only by adding values', () => {
    const enumOps = statements(sql).filter((s) => /^ALTER TYPE/.test(s));
    expect(enumOps.filter((s) => !/^ALTER TYPE "\w+" ADD VALUE '\w+'$/.test(s))).toEqual([]);
    expect(enumOps).toContain(`ALTER TYPE "SeekerSubscriptionTier" ADD VALUE 'pro'`);
  });

  it('allows only CREATE TABLE / CREATE [UNIQUE] INDEX / ALTER TABLE / ALTER TYPE statements', () => {
    const other = statements(sql).filter(
      (s) => !/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|ALTER TYPE) /.test(s),
    );
    expect(other).toEqual([]);
  });

  it('declares the trigram index (the owner runs 000_extensions.sql first)', () => {
    expect(sql).toContain('CREATE INDEX "RAJob_searchText_idx" ON "RAJob" USING GIN ("searchText" gin_trgm_ops)');
  });
});
