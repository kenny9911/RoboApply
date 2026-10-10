// @vitest-environment node
//
// WP-32 index proof.
//   - Always: every index the feed SQL relies on is declared in the Prisma
//     schema (names derived the way Prisma names them), and the EXPLAIN plan
//     walker finds index names.
//   - With FEED_INDEX_PROOF=1 (run by the orchestrator against the clone Neon
//     branch; read-only): pg_indexes lists them, and EXPLAIN under
//     `SET LOCAL enable_seqscan = off` uses them.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLANNED_FEED_INDEXES, REQUESTED_FEED_INDEXES, REQUESTED_INDEX_STATEMENT, indexNamesInPlan, proofStatements, runIndexProof } from './indexProof.js';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prisma/schema');

/** Index names Prisma generates for every model (`_pkey`, `_key`, `_idx`). */
function declaredIndexNames(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'))) {
    const src = readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const [, model, body] = m;
      for (const line of body!.split('\n')) {
        const t = line.trim();
        const block = t.match(/^@@(id|unique|index)\(\[([^\]]*)\]/);
        if (block) {
          const fields = block[2]!.split(',').map((f) => f.trim().replace(/\(.*$/, ''));
          const suffix = block[1] === 'id' ? 'pkey' : block[1] === 'unique' ? 'key' : 'idx';
          out.add(block[1] === 'id' ? `${model}_pkey` : `${model}_${fields.join('_')}_${suffix}`);
          continue;
        }
        const field = t.match(/^(\w+)\s+\S+.*@unique/);
        if (field) out.add(`${model}_${field[1]}_key`);
        if (/^\w+\s+\S+.*@id\b/.test(t)) out.add(`${model}_pkey`);
      }
    }
  }
  return out;
}

describe('feed index plan', () => {
  const declared = declaredIndexNames();

  it.each(Object.keys(PLANNED_FEED_INDEXES))('%s is declared in the schema', (name) => {
    expect(declared.has(name)).toBe(true);
  });

  it('SR-32-1: RAJob @@index([market, isCanonical, archivedAt, firstSeenAt(sort: Desc)]) for new-count', () => {
    expect(PLANNED_FEED_INDEXES).toHaveProperty('RAJob_market_isCanonical_archivedAt_firstSeenAt_idx');
    expect(declared.has('RAJob_market_isCanonical_archivedAt_firstSeenAt_idx')).toBe(true);
  });
  it('SR-32-2: RAJob @@index([employerTags], type: Gin) for GoApply employer-tag / 户口 filters', () => {
    expect(PLANNED_FEED_INDEXES).toHaveProperty('RAJob_employerTags_idx');
    expect(declared.has('RAJob_employerTags_idx')).toBe(true);
  });
  it('SR-32-3: RAJob @@index([geoLat, geoLng]) for the radius bounding box', () => {
    expect(PLANNED_FEED_INDEXES).toHaveProperty('RAJob_geoLat_geoLng_idx');
    expect(declared.has('RAJob_geoLat_geoLng_idx')).toBe(true);
  });

  it('no feed index is still waiting on a schema request (SCHEMA-3 applied SR-32-1…3)', () => {
    expect(REQUESTED_FEED_INDEXES).toEqual({});
  });

  it('finds index names anywhere in an EXPLAIN (FORMAT JSON) plan', () => {
    const plan = [{ Plan: { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'RAJob_market_isCanonical_archivedAt_postedAt_idx', Plans: [{ 'Index Name': 'RAJobUserState_pkey' }] }] } }];
    expect(indexNamesInPlan(plan)).toEqual(['RAJobUserState_pkey', 'RAJob_market_isCanonical_archivedAt_postedAt_idx']);
  });

  it('explains the real retrieval, keyset refill and count statements, plus one per requested index', () => {
    const s = proofStatements(new Date('2026-10-10T00:00:00Z'));
    expect(Object.keys(s)).toEqual(['retrieval', 'refill', 'count', 'newCount', 'cnEmployerTags', 'geo']);
    expect(s.retrieval.text).toContain('ORDER BY j."postedAt" DESC');
    expect(s.refill.text).toContain('(j."postedAt", j."id") < (');
    expect(s.newCount.text).toContain('j."firstSeenAt" >');
    expect(s.cnEmployerTags.text).toContain('j."employerTags" @>');
    expect(s.geo.text).toContain('j."geoLat" BETWEEN');
    for (const [index, statement] of Object.entries(REQUESTED_INDEX_STATEMENT)) {
      expect(PLANNED_FEED_INDEXES).toHaveProperty(index);
      expect(s).toHaveProperty(statement);
    }
  });
});

describe.skipIf(process.env.FEED_INDEX_PROOF !== '1')('index proof against the database (FEED_INDEX_PROOF=1, read-only)', () => {
  it('pg_indexes lists every planned index and EXPLAIN uses them with seqscan off', async () => {
    const prisma = (await import('../../lib/prisma.js')).default;
    const result = await runIndexProof(prisma);
    // eslint-disable-next-line no-console
    console.log('[feed index proof]', JSON.stringify(result, null, 2));
    expect(result.missing).toEqual([]);
    expect(result.plans.retrieval).toContain('RAJob_market_isCanonical_archivedAt_postedAt_idx');
    expect(result.plans.retrieval.some((n) => n === 'RAJobUserState_pkey' || n === 'RAJobUserState_userId_hiddenAt_idx')).toBe(true);
    expect(result.plans.refill).toContain('RAJob_market_isCanonical_archivedAt_postedAt_idx');
    expect(result.plans.count.length).toBeGreaterThan(0);
    // SCHEMA-3 indexes (SR-32-1…3): each statement must use its index.
    expect(result.missingRequested).toEqual([]);
    for (const [index, statement] of Object.entries(REQUESTED_INDEX_STATEMENT)) {
      expect(result.plans[statement]).toContain(index);
    }
  });
});
