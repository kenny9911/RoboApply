// @vitest-environment node
//
// The raw SQL of the retrieval write path, against a database double that
// records every statement and its parameters (MKT-2H items 3 and 4).

import { describe, expect, it } from 'vitest';
import { VECTOR_DIMENSIONS, createRetrievalRepo, parseVector, vectorLiteral } from './repo.js';
import { fakeDb, indexJob, vector } from './testkit.js';

const TAG = 'openai/text-embedding-3-small@1024';

const AT = new Date('2026-10-11T08:00:00.000Z');

function kit(options: Parameters<typeof fakeDb>[0] = {}) {
  const f = fakeDb(options);
  return { ...f, repo: createRetrievalRepo(async () => f.db, () => AT) };
}

describe('writeSearchDoc', () => {
  it('writes searchDoc, searchTsv, contentHash and lang in ONE statement', async () => {
    const k = kit();
    await k.repo.writeSearchDoc('job_1', { searchDoc: 'senior backend engineer', contentHash: 'abc123', lang: 'en' });
    expect(k.statements).toHaveLength(1);
    const s = k.statements[0]!;
    expect(s.kind).toBe('execute');
    expect(s.text).toBe(`UPDATE "RAJob" SET "searchDoc" = $1, "searchTsv" = to_tsvector('simple', $2), "contentHash" = $3, "lang" = $4 WHERE "id" = $5`);
    // The tsvector is built from the very text that is stored: the two can never be written apart.
    expect(s.values).toEqual(['senior backend engineer', 'senior backend engineer', 'abc123', 'en', 'job_1']);
  });
});

describe('job vectors', () => {
  it('upserts by job id with the vector as a text literal cast to halfvec(1024)', async () => {
    const k = kit();
    const v = vector(3);
    await k.repo.upsertJobEmbedding('job_1', 'intl', TAG, 'cardhash', v);
    const s = k.statements[0]!;
    expect(s.kind).toBe('execute');
    expect(s.text).toContain('INSERT INTO "RAJobEmbedding" ("jobId", "market", "model", "contentHash", "embedding", "embeddedAt")');
    expect(s.text).toContain('$5::halfvec(1024)');
    expect(s.text).toContain('ON CONFLICT ("jobId") DO UPDATE SET');
    for (const column of ['market', 'model', 'contentHash', 'embedding', 'embeddedAt']) expect(s.text).toContain(`"${column}" = EXCLUDED."${column}"`);
    expect(s.values.slice(0, 4)).toEqual(['job_1', 'intl', TAG, 'cardhash']);
    expect(s.values[4]).toBe(`[${v.join(',')}]`);
    expect(typeof s.values[4]).toBe('string');
    // The time is bound from the application clock (UTC, like enrichedAt), never SQL now().
    expect(s.values[5]).toEqual(AT);
    expect(s.text).not.toContain('now()');
  });

  it('refuses a vector that is not exactly 1024 finite numbers before any statement', async () => {
    const k = kit();
    await expect(k.repo.upsertJobEmbedding('job_1', 'intl', TAG, 'h', vector(1, 1536))).rejects.toThrow(/exactly 1024/);
    await expect(k.repo.upsertJobEmbedding('job_1', 'intl', TAG, 'h', [...vector(1).slice(0, 1023), Number.NaN])).rejects.toThrow(/exactly 1024/);
    await expect(k.repo.upsertUserEmbedding('u1', 'intl', 'intent', TAG, 'h', vector(1, 3))).rejects.toThrow(/exactly 1024/);
    expect(k.statements).toHaveLength(0);
    expect(VECTOR_DIMENSIONS).toBe(1024);
  });

  it('reads the stored model and card hash of a set of jobs, and touches rows whose text is unchanged', async () => {
    const k = kit({ respond: (s) => (s.kind === 'query' ? [{ jobId: 'job_1', model: TAG, contentHash: 'h1' }] : 1) });
    const meta = await k.repo.jobEmbeddingMeta(['job_1', 'job_2']);
    expect(meta.get('job_1')).toEqual({ model: TAG, contentHash: 'h1' });
    expect(meta.has('job_2')).toBe(false);
    expect(k.statements[0]!.text).toBe('SELECT e."jobId", e."model", e."contentHash" FROM "RAJobEmbedding" e WHERE e."jobId" = ANY($1::text[])');
    await k.repo.touchJobEmbeddings(['job_1']);
    expect(k.statements[1]!.text).toBe('UPDATE "RAJobEmbedding" SET "embeddedAt" = $1 WHERE "jobId" = ANY($2::text[])');
    expect(k.statements[1]!.values).toEqual([AT, ['job_1']]);
    // Nothing to do: no statement.
    await k.repo.touchJobEmbeddings([]);
    expect(await k.repo.jobEmbeddingMeta([])).toEqual(new Map());
    expect(k.statements).toHaveLength(2);
  });
});

describe('jobsNeedingIndex', () => {
  it('lists live canonical enriched rows of one market that lack a document or a current vector: missing documents first, then newest', async () => {
    const k = kit({ respond: () => [{ id: 'job_b' }, { id: 'job_a' }] });
    expect(await k.repo.jobsNeedingIndex('intl', TAG, 960)).toEqual(['job_b', 'job_a']);
    const s = k.statements[0]!;
    expect(s.text).toContain('SELECT j."id" FROM "RAJob" j LEFT JOIN "RAJobEmbedding" e ON e."jobId" = j."id"');
    expect(s.text).toContain('j."market" = $1 AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL');
    expect(s.text).toContain('j."enrichedAt" IS NOT NULL');
    expect(s.text).toContain('j."searchDoc" IS NULL OR j."contentHash" IS NULL');
    expect(s.text).toContain(`(j."visibility" = 'public' AND (e."jobId" IS NULL OR e."model" <> $2 OR e."embeddedAt" < j."enrichedAt"))`);
    // Rows that lack the lexical part never wait behind rows that only lack a vector.
    expect(s.text).toContain('ORDER BY (j."searchDoc" IS NULL OR j."contentHash" IS NULL) DESC, j."firstSeenAt" DESC, j."id" DESC LIMIT $3');
    expect(s.values).toEqual(['intl', TAG, 960]);
    // Raw SQL on RAJob lists its columns and never returns the tsvector.
    expect(s.text).not.toMatch(/SELECT \*|j\.\*|"searchTsv"/);
  });

  it('asks only for missing documents when no model is configured', async () => {
    const k = kit();
    await k.repo.jobsNeedingIndex('cn', null, 10);
    const s = k.statements[0]!;
    expect(s.text).not.toContain('e."model"');
    expect(s.text).toContain('(j."searchDoc" IS NULL OR j."contentHash" IS NULL)');
    expect(s.values).toEqual(['cn', 10]);
  });
});

describe('nearestJobsByJob', () => {
  it('orders the public, canonical, open rows of the same market and model by exact distance to the job vector', async () => {
    const k = kit({ respond: () => [{ jobId: 'job_9', distance: '0.12' }, { jobId: 'job_4', distance: 0.3 }] });
    const near = await k.repo.nearestJobsByJob('job_1', { market: 'intl', country: 'US', modelTag: TAG, limit: 50 });
    expect(near).toEqual([{ jobId: 'job_9', distance: 0.12 }, { jobId: 'job_4', distance: 0.3 }]);
    const s = k.statements[0]!;
    expect(s.text).toContain('FROM "RAJobEmbedding" a JOIN "RAJobEmbedding" e ON e."market" = a."market" AND e."model" = a."model" AND e."jobId" <> a."jobId"');
    expect(s.text).toContain('WHERE a."jobId" = $1 AND a."market" = $2 AND a."model" = $3');
    expect(s.text).toContain(`j."market" = $4 AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL AND j."visibility" = 'public' AND j."locationCountry" = $5`);
    expect(s.text).toContain('ORDER BY e."embedding" <=> a."embedding", e."jobId" LIMIT $6');
    expect(s.values).toEqual(['job_1', 'intl', TAG, 'intl', 'US', 50]);
  });

  it('leaves the country out when none is given, and is empty when the job has no vector', async () => {
    const k = kit({ respond: () => [] });
    expect(await k.repo.nearestJobsByJob('job_1', { market: 'cn', modelTag: TAG, limit: 5 })).toEqual([]);
    expect(k.statements[0]!.text).not.toContain('locationCountry');
    expect(k.statements[0]!.values).toEqual(['job_1', 'cn', TAG, 'cn', 5]);
  });
});

describe('user vectors', () => {
  it('upserts by (userId, market, kind) with the halfvec cast', async () => {
    const k = kit();
    await k.repo.upsertUserEmbedding('u1', 'cn', 'resume', TAG, 'srchash', vector(2));
    const s = k.statements[0]!;
    expect(s.text).toContain('INSERT INTO "RAUserEmbedding" ("userId", "market", "kind", "model", "sourceHash", "embedding", "updatedAt")');
    expect(s.text).toContain('$6::halfvec(1024)');
    expect(s.text).toContain('ON CONFLICT ("userId", "market", "kind") DO UPDATE SET');
    expect(s.values.slice(0, 5)).toEqual(['u1', 'cn', 'resume', TAG, 'srchash']);
    expect(s.values[6]).toEqual(AT);
    expect(s.text).not.toContain('now()');
  });

  it('deletes the vectors of one person in one market only', async () => {
    const k = kit({ respond: () => 2 });
    expect(await k.repo.deleteUserEmbeddings('u1', 'cn')).toBe(2);
    expect(k.statements[0]!.text).toBe('DELETE FROM "RAUserEmbedding" WHERE "userId" = $1 AND "market" = $2');
    expect(k.statements[0]!.values).toEqual(['u1', 'cn']);
    await k.repo.deleteUserEmbeddings('u1', 'cn', ['resume']);
    expect(k.statements[1]!.text).toBe('DELETE FROM "RAUserEmbedding" WHERE "userId" = $1 AND "market" = $2 AND "kind" = ANY($3::text[])');
    expect(await k.repo.deleteUserEmbeddings('u1', 'cn', [])).toBe(0);
    expect(k.statements).toHaveLength(2);
  });

  it('userVector answers the resume vector, else the intent vector, else null, and filters on market and model tag', async () => {
    const resume = vector(7);
    const intent = vector(8);
    const both = kit({ respond: () => [{ kind: 'intent', embedding: `[${intent.join(',')}]` }, { kind: 'resume', embedding: `[${resume.join(',')}]` }] });
    expect(await both.repo.userVector('u1', 'intl', TAG)).toEqual(resume);
    const s = both.statements[0]!;
    expect(s.text).toContain('u."embedding"::text AS "embedding"');
    expect(s.text).toContain('WHERE u."userId" = $1 AND u."market" = $2 AND u."model" = $3');
    expect(s.values).toEqual(['u1', 'intl', TAG]);

    const onlyIntent = kit({ respond: () => [{ kind: 'intent', embedding: `[${intent.join(',')}]` }] });
    expect(await onlyIntent.repo.userVector('u1', 'intl', TAG)).toEqual(intent);
    // A vector of another model is never returned: the statement filters on the tag, so nothing comes back.
    expect(await kit({ respond: () => [] }).repo.userVector('u1', 'intl', 'other-model@1024')).toBeNull();
    // A stored value that is not a 1024-number vector is not handed on.
    expect(await kit({ respond: () => [{ kind: 'resume', embedding: '[1,2,3]' }] }).repo.userVector('u1', 'intl', TAG)).toBeNull();
  });

  it('lists the people with a vector made from their data in a market (their own, or of a private import), after a cursor', async () => {
    const k = kit({ respond: () => [{ userId: 'u2' }, { userId: 'u3' }] });
    expect(await k.repo.embeddedUserIds('cn', 'u1', 200)).toEqual(['u2', 'u3']);
    expect(k.statements[0]!.text).toBe(
      'SELECT x."userId" FROM ( SELECT u."userId" FROM "RAUserEmbedding" u WHERE u."market" = $1 UNION SELECT j."ownerUserId" AS "userId" FROM "RAJobEmbedding" e JOIN "RAJob" j ON j."id" = e."jobId" ' +
        `WHERE e."market" = $2 AND j."visibility" = 'private' AND j."ownerUserId" IS NOT NULL ) x WHERE x."userId" > $3 ORDER BY x."userId" LIMIT $4`,
    );
    expect(k.statements[0]!.values).toEqual(['cn', 'cn', 'u1', 200]);
    await k.repo.embeddedUserIds('cn', null, 200);
    expect(k.statements[1]!.text).not.toContain('x."userId" >');
    expect(k.statements[1]!.values).toEqual(['cn', 'cn', 200]);
  });

  it("deletes the vectors of a person's own private imports in one market, and of nothing else", async () => {
    const k = kit({ respond: () => 3 });
    expect(await k.repo.deleteJobEmbeddingsOfOwner('u1', 'cn')).toBe(3);
    const s = k.statements[0]!;
    expect(s.kind).toBe('execute');
    expect(s.text).toBe(`DELETE FROM "RAJobEmbedding" e USING "RAJob" j WHERE j."id" = e."jobId" AND j."ownerUserId" = $1 AND j."visibility" = 'private' AND e."market" = $2`);
    expect(s.values).toEqual(['u1', 'cn']);
  });
});

describe('index statistics, job rows and config', () => {
  it('counts live public rows, missing documents and vectors of the tag', async () => {
    const k = kit({ respond: () => [{ live: 100n, missingDoc: 4, withTag: '90', missingVector: 10, missingVectorChars: 12000 }] });
    expect(await k.repo.indexStats('intl', TAG)).toEqual({ live: 100, missingDoc: 4, withTag: 90, missingVector: 10, missingVectorChars: 12000 });
    const s = k.statements[0]!;
    expect(s.text).toContain(`j."visibility" = 'public' AND j."enrichedAt" IS NOT NULL`);
    expect(s.text).not.toMatch(/SELECT \*|"searchTsv"/);
    expect(await kit({ respond: () => [] }).repo.indexStats('cn', null)).toEqual({ live: 0, missingDoc: 0, withTag: 0, missingVector: 0, missingVectorChars: 0 });
  });

  it('loads the columns indexing reads through the typed client, never the tsvector', async () => {
    const k = kit({ jobs: [indexJob({ id: 'job_1' }), indexJob({ id: 'job_2' })] });
    expect((await k.repo.loadIndexJobs(['job_2', 'missing'])).map((j) => j.id)).toEqual(['job_2']);
    expect(await k.repo.loadIndexJobs([])).toEqual([]);
    expect(k.statements).toHaveLength(0);
  });

  it('reads and writes AppConfig values', async () => {
    const k = kit({ config: { a: '1' } });
    expect(await k.repo.getConfig('a')).toBe('1');
    expect(await k.repo.getConfig('b')).toBeNull();
    await k.repo.setConfig('b', '2');
    expect(await k.repo.getConfig('b')).toBe('2');
  });
});

describe('vector text form', () => {
  it('round-trips a 1024-number vector and refuses anything else', () => {
    const v = vector(5);
    expect(parseVector(vectorLiteral(v))).toEqual(v);
    expect(parseVector('[1,2]')).toBeNull();
    expect(parseVector(null)).toBeNull();
    expect(parseVector(`[${[...v.slice(0, 1023), 'x'].join(',')}]`)).toBeNull();
    expect(() => vectorLiteral([1, 2, 3])).toThrow(/exactly 1024/);
  });
});
