// @vitest-environment node
//
// MKT-0 item 5: the additive-only classifier of scripts/check-schema-additive.mjs.
//
// The classifier is a pure function over SQL text (the --script output of
// `prisma migrate diff`); the KNOWN_DRIFT reader and the Unsupported comparison
// are pure functions over Markdown and schema text. These tests never start
// Prisma, never touch a database and never use the network: every input is a
// literal below, plus the two committed files the classifier is used on
// (KNOWN_DRIFT.md and market-additive.sql). Where `main` is called, the Prisma
// run is replaced by a function that returns a literal.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as checker from '../../../scripts/check-schema-additive.mjs';

interface Violation {
  rule: string;
  statement: string;
  line: number;
}
interface Classification {
  ok: boolean;
  statements: { text: string; line: number }[];
  violations: Violation[];
  ignored: { text: string; line: number }[];
  warnings: { rule: string; statement: string; line: number }[];
}
interface KnownDriftEntry {
  name: string;
  create: string | null;
}
interface UnsupportedChange {
  field: string;
  from: string;
  to: string;
}
interface SchemaDiff {
  sql: string;
  base: string | null;
  unsupportedChanges: UnsupportedChange[];
}
const classifyAdditive = checker.classifyAdditive as (sql: string, options?: { knownDrift?: (KnownDriftEntry | string)[] }) => Classification;
const parseKnownDrift = checker.parseKnownDrift as (markdown: string) => KnownDriftEntry[];
const knownDriftCreateMatches = checker.knownDriftCreateMatches as (statement: string, entry: KnownDriftEntry) => boolean;
const schemaFieldTypes = checker.schemaFieldTypes as (schemaText: string) => Map<string, string>;
const unsupportedTypeChanges = checker.unsupportedTypeChanges as (from: string, to: string) => UnsupportedChange[];
const withUnsupportedChanges = checker.withUnsupportedChanges as (result: Classification, changes: UnsupportedChange[]) => Classification;
const main = checker.main as (argv: string[], deps?: { schemaDiff?: (root: string, options: Record<string, unknown>) => SchemaDiff }) => number;
const RULES = checker.RULES as Record<string, string>;
const splitSqlStatements = checker.splitSqlStatements as (sql: string) => { text: string; line: number }[];
const splitGeneratedFile = checker.splitGeneratedFile as (text: string) => { header: string; base: string | null; sql: string } | null;
const GENERATED_MARKER = checker.GENERATED_MARKER as string;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIFFS_DIR = join(ROOT, 'docs', 'jobright-clone', 'schema-diffs');
const knownDriftMarkdown = readFileSync(join(DIFFS_DIR, 'KNOWN_DRIFT.md'), 'utf8');

const rulesOf = (result: Classification) => result.violations.map((v) => v.rule);

/** The shape `prisma migrate diff --script` prints for an additive change. */
const ADDITIVE_SQL = `
-- AlterTable
ALTER TABLE "RAJob" ADD COLUMN     "atsPostingKey" TEXT,
ADD COLUMN     "skillIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "searchTsv" tsvector;

-- AlterTable
ALTER TABLE "RACareerSiteSource" ADD COLUMN     "failCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'admin';

-- CreateTable
CREATE TABLE "RAJobEmbedding" (
    "jobId" TEXT NOT NULL,
    "embedding" halfvec(1024) NOT NULL,
    "embeddedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAJobEmbedding_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIN ("searchTsv");

-- CreateIndex
CREATE UNIQUE INDEX "RAJobEmbedding_jobId_key" ON "RAJobEmbedding"("jobId");

-- AddForeignKey
ALTER TABLE "RAJobEmbedding" ADD CONSTRAINT "RAJobEmbedding_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RAJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`;

/** The false positive recorded in KNOWN_DRIFT.md, as a database-to-schema diff prints it. */
const KNOWN_PAIR_SQL = `
-- DropIndex
DROP INDEX "RAJob_sourceBoard_externalId_idx";

-- CreateIndex
CREATE INDEX "RAJob_sourceBoard_externalId_idx" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops);
`;

describe('classifyAdditive: additive statements pass', () => {
  it('accepts ADD COLUMN, CREATE TABLE, CREATE INDEX and ADD CONSTRAINT', () => {
    const result = classifyAdditive(ADDITIVE_SQL);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.statements).toHaveLength(6);
    expect(result.ignored).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts an empty diff', () => {
    expect(classifyAdditive('').ok).toBe(true);
    expect(classifyAdditive('-- This is an empty migration.\n').ok).toBe(true);
    expect(classifyAdditive('-- This is an empty migration.\n').statements).toEqual([]);
  });

  it('accepts the extension statement of server/prisma/sql', () => {
    expect(classifyAdditive('CREATE EXTENSION IF NOT EXISTS vector;').ok).toBe(true);
  });

  it('does not read keywords inside string literals, quoted names or comments', () => {
    const sql = `
-- DROP TABLE "User"; a comment is not a statement
ALTER TABLE "RAJob" ADD COLUMN "note" TEXT DEFAULT 'DROP TABLE; RENAME; SET NOT NULL',
ADD COLUMN "DROP COLUMN" TEXT;
/* ALTER TABLE "RAJob" DROP COLUMN "title"; */
`;
    const result = classifyAdditive(sql);
    expect(result.violations).toEqual([]);
    expect(result.statements).toHaveLength(1);
  });
});

describe('classifyAdditive: anything that removes, retypes or tightens fails', () => {
  const failing: [string, string, string][] = [
    ['a dropped index', 'DROP INDEX "RAJob_searchTsv_idx";', 'drop_index'],
    ['a dropped column', 'ALTER TABLE "RAJob" DROP COLUMN "searchDoc";', 'drop_column'],
    ['a dropped table', 'DROP TABLE "RAJobEmbedding";', 'drop_table'],
    ['a changed type', 'ALTER TABLE "RAJob" ALTER COLUMN "titleMatchScore" SET DATA TYPE DOUBLE PRECISION;', 'alter_column_type'],
    ['a changed type (short form)', 'ALTER TABLE "RAJob" ALTER COLUMN "salaryMin" TYPE BIGINT;', 'alter_column_type'],
    ['a tightened column', 'ALTER TABLE "RAJob" ALTER COLUMN "lang" SET NOT NULL;', 'set_not_null'],
    ['a removed default', 'ALTER TABLE "RACareerSiteSource" ALTER COLUMN "origin" DROP DEFAULT;', 'drop_default'],
    ['a renamed column', 'ALTER TABLE "RAJob" RENAME COLUMN "skills" TO "skillNames";', 'rename'],
    ['a renamed table', 'ALTER TABLE "AlipayOrder" RENAME TO "CnOrder";', 'rename'],
    ['a renamed index', 'ALTER INDEX "RAJob_skills_idx" RENAME TO "RAJob_skillNames_idx";', 'rename'],
    ['a dropped constraint', 'ALTER TABLE "RAJobEmbedding" DROP CONSTRAINT "RAJobEmbedding_jobId_fkey";', 'drop_other'],
    ['a loosened column', 'ALTER TABLE "RAJob" ALTER COLUMN "title" DROP NOT NULL;', 'drop_other'],
    ['a changed default', `ALTER TABLE "RAJob" ALTER COLUMN "market" SET DEFAULT 'cn';`, 'set_default'],
    ['a required column with no default', 'ALTER TABLE "RAJob" ADD COLUMN "lang" TEXT NOT NULL;', 'required_column_without_default'],
    ['a data change', `UPDATE "RAJob" SET "market" = 'cn';`, 'not_additive'],
    ['a delete', 'DELETE FROM "AlipayOrder";', 'not_additive'],
    ['a truncate', 'TRUNCATE TABLE "RAJob";', 'not_additive'],
  ];

  it.each(failing)('rejects %s', (_label, sql, rule) => {
    const result = classifyAdditive(sql);
    expect(result.ok).toBe(false);
    expect(rulesOf(result)).toContain(rule);
  });

  it('names the statement and its line', () => {
    const result = classifyAdditive(`${ADDITIVE_SQL}\n-- AlterTable\nALTER TABLE "RAJob" DROP COLUMN "searchDoc";\n`);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule).toBe('drop_column');
    expect(result.violations[0].statement).toContain('DROP COLUMN "searchDoc"');
    expect(result.violations[0].line).toBe(ADDITIVE_SQL.split('\n').length + 2);
  });

  it('reports one bad clause inside an otherwise additive ALTER TABLE', () => {
    const result = classifyAdditive('ALTER TABLE "RAJob" ADD COLUMN "a" TEXT,\nDROP COLUMN "b",\nADD COLUMN "c" INTEGER NOT NULL;');
    expect(rulesOf(result).sort()).toEqual(['drop_column', 'required_column_without_default']);
  });

  it('the redefine-table shape of a removed column or a changed type fails', () => {
    const removedColumn = `
-- AlterTable
ALTER TABLE "RATailorSession" DROP COLUMN "scoreAfter",
ADD COLUMN     "fitSnapshot" JSONB;
`;
    const changedType = `
-- AlterTable
ALTER TABLE "AlipayOrder" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(10,2);
`;
    expect(classifyAdditive(removedColumn).ok).toBe(false);
    expect(classifyAdditive(changedType).ok).toBe(false);
  });
});

describe('classifyAdditive: additive statements that can still fail on existing rows are warnings', () => {
  it('warns about a unique index on a table the diff does not create', () => {
    const result = classifyAdditive('CREATE UNIQUE INDEX "RAJob_slug_key" ON "RAJob"("slug");');
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.rule)).toEqual(['unique_on_existing_table']);
  });

  it('warns about a constraint on a table the diff does not create', () => {
    const result = classifyAdditive(
      'ALTER TABLE "RAJob" ADD CONSTRAINT "RAJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "RACompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.rule)).toEqual(['constraint_on_existing_table']);
  });
});

describe('KNOWN_DRIFT pairs', () => {
  const knownDrift = parseKnownDrift(knownDriftMarkdown);
  const LISTED = 'RAJob_sourceBoard_externalId_idx';
  const listed = knownDrift.find((entry) => entry.name === LISTED) as KnownDriftEntry;
  const pairWith = (create: string) => `DROP INDEX "${LISTED}";\n${create};\n`;

  it('reads the index names and their recorded definitions from the table in KNOWN_DRIFT.md', () => {
    expect(listed).toEqual({ name: LISTED, create: 'CREATE INDEX … ("sourceBoard", "externalId" text_pattern_ops)' });
    for (const entry of knownDrift) {
      expect(entry.name).toMatch(/^[A-Za-z0-9_]+$/);
      // Every committed row records its definition: a row without one excuses nothing.
      expect(entry.create, entry.name).toMatch(/^CREATE (UNIQUE )?INDEX (…|\.\.\.) /);
    }
  });

  it('reads nothing from prose, the header row or the third column', () => {
    const markdown = [
      '# Title with `RAJob_fake_idx`',
      '',
      '| Index | Reported as | Actual |',
      '|---|---|---|',
      '| `RAJob_a_idx` | `DROP INDEX` + `CREATE INDEX … USING GIN ("a")` | `CREATE INDEX … USING gin (a)` same |',
      '| `RAJob_b_idx` | a pair, no definition recorded | `CREATE INDEX … ("b")` |',
      '',
      'Prose naming `RAJob_c_idx` is not a row.',
    ].join('\n');
    expect(parseKnownDrift(markdown)).toEqual([
      { name: 'RAJob_a_idx', create: 'CREATE INDEX … USING GIN ("a")' },
      { name: 'RAJob_b_idx', create: null },
    ]);
  });

  it('ignores a listed DROP INDEX + CREATE INDEX pair whose definition is the recorded one', () => {
    const result = classifyAdditive(`${ADDITIVE_SQL}${KNOWN_PAIR_SQL}`, { knownDrift });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ignored).toHaveLength(2);
    expect(result.statements).toHaveLength(8);
  });

  it('does not ignore the same pair when the list is not given', () => {
    const result = classifyAdditive(KNOWN_PAIR_SQL);
    expect(rulesOf(result)).toEqual(['drop_index']);
  });

  it('does not ignore a listed index that is dropped without being created again', () => {
    const result = classifyAdditive(`DROP INDEX "${LISTED}";`, { knownDrift });
    expect(rulesOf(result)).toEqual(['drop_index']);
    expect(result.ignored).toEqual([]);
  });

  // The listed NAME is not a licence to change the index: the review finding this guards against
  // was a schema that dropped text_pattern_ops and still passed.
  const changed: [string, string][] = [
    ['without the operator class', `CREATE INDEX "${LISTED}" ON "RAJob"("sourceBoard", "externalId")`],
    ['with another column list', `CREATE INDEX "${LISTED}" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops, "market")`],
    ['with the columns in another order', `CREATE INDEX "${LISTED}" ON "RAJob"("externalId" text_pattern_ops, "sourceBoard")`],
    ['with another operator class', `CREATE INDEX "${LISTED}" ON "RAJob"("sourceBoard", "externalId" varchar_pattern_ops)`],
    ['with another index method', `CREATE INDEX "${LISTED}" ON "RAJob" USING HASH ("sourceBoard", "externalId" text_pattern_ops)`],
    ['as a partial index', `CREATE INDEX "${LISTED}" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops) WHERE "archivedAt" IS NULL`],
    ['as a unique index', `CREATE UNIQUE INDEX "${LISTED}" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops)`],
  ];
  it.each(changed)('a listed name recreated %s still fails', (_label, create) => {
    expect(knownDriftCreateMatches(create, listed)).toBe(false);
    const result = classifyAdditive(pairWith(create), { knownDrift });
    expect(result.ok).toBe(false);
    expect(rulesOf(result)).toContain('drop_index');
    expect(result.ignored).toEqual([]);
  });

  it('the recorded definition matches whatever the spacing, and only for its own index name', () => {
    expect(knownDriftCreateMatches(`CREATE INDEX "${LISTED}" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops)`, listed)).toBe(true);
    expect(knownDriftCreateMatches(`CREATE INDEX "${LISTED}"\n  ON "RAJob" ( "sourceBoard","externalId"   text_pattern_ops );`, listed)).toBe(true);
    expect(knownDriftCreateMatches(`CREATE INDEX "${LISTED}" ON "public"."RAJob"("sourceBoard", "externalId" text_pattern_ops)`, listed)).toBe(true);
    expect(knownDriftCreateMatches('CREATE INDEX "RAJob_other_idx" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops)', listed)).toBe(false);
  });

  it('a recorded GIN definition is matched with its method and operator class', () => {
    const entry = { name: 'RAJob_searchTsv_idx', create: 'CREATE INDEX … USING GIN ("searchTsv" tsvector_ops)' };
    expect(knownDriftCreateMatches('CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIN ("searchTsv" tsvector_ops)', entry)).toBe(true);
    expect(knownDriftCreateMatches('CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIN ("searchTsv")', entry)).toBe(false);
    expect(knownDriftCreateMatches('CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIST ("searchTsv" tsvector_ops)', entry)).toBe(false);
  });

  it('a row with no recorded definition, a bare name or a malformed definition excuses nothing', () => {
    for (const entry of [{ name: LISTED, create: null }, LISTED, { name: LISTED, create: 'CREATE INDEX …' }, { name: LISTED, create: '… ("sourceBoard")' }, { name: LISTED, create: 'CREATE INDEX "x" ON "RAJob"("sourceBoard")' }]) {
      const result = classifyAdditive(KNOWN_PAIR_SQL, { knownDrift: [entry] });
      expect(rulesOf(result), JSON.stringify(entry)).toEqual(['drop_index']);
      expect(result.ignored).toEqual([]);
    }
  });

  it('ignores nothing else: an unlisted pair still fails', () => {
    const sql = `
DROP INDEX "RAJob_searchTsv_idx";
CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIN ("searchTsv");
${KNOWN_PAIR_SQL}`;
    const result = classifyAdditive(sql, { knownDrift });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].statement).toContain('RAJob_searchTsv_idx');
    expect(result.ignored).toHaveLength(2);
  });

  it('a listed name does not excuse a drop of the table or of a column', () => {
    const result = classifyAdditive(`${KNOWN_PAIR_SQL}\nALTER TABLE "RAJob" DROP COLUMN "externalId";`, { knownDrift });
    expect(rulesOf(result)).toEqual(['drop_column']);
  });
});

describe('Unsupported("...") fields: what prisma migrate diff cannot see', () => {
  const BASE = `
// a comment naming Unsupported("ignored") is not a field
model RAJob {
  id          String                   @id
  title       String // trailing comment with Unsupported("nope")
  url         String                   @default("https://example.test//path")
  /// to_tsvector('simple', searchDoc)
  searchTsv   Unsupported("tsvector")?
  tags        String[]                 @default([])

  @@index([searchTsv], type: Gin)
}

model RAJobEmbedding {
  jobId     String                       @id
  embedding Unsupported("halfvec(1024)")
}

enum Kind {
  searchTsv
}
`;
  const edit = (from: string, to: string) => {
    expect(BASE).toContain(from);
    return BASE.replace(from, to);
  };

  it('reads the declared type of every model field, comments and attributes aside', () => {
    const types = schemaFieldTypes(BASE);
    expect(Object.fromEntries(types)).toEqual({
      'RAJob.id': 'String',
      'RAJob.title': 'String',
      'RAJob.url': 'String',
      'RAJob.searchTsv': 'Unsupported("tsvector")?',
      'RAJob.tags': 'String[]',
      'RAJobEmbedding.jobId': 'String',
      'RAJobEmbedding.embedding': 'Unsupported("halfvec(1024)")',
    });
  });

  it('reports nothing when the schemas agree, when a field is added and when an ordinary field changes', () => {
    expect(unsupportedTypeChanges(BASE, BASE)).toEqual([]);
    expect(unsupportedTypeChanges(BASE, edit('  tags ', '  vec  Unsupported("halfvec(1024)")?\n  tags '))).toEqual([]);
    // An ordinary retype prints SQL, so the SQL rules catch it; it is not this rule's business.
    expect(unsupportedTypeChanges(BASE, edit('title       String', 'title       Int'))).toEqual([]);
    // A removed Unsupported field prints DROP COLUMN.
    expect(unsupportedTypeChanges(BASE, edit('  searchTsv   Unsupported("tsvector")?\n', ''))).toEqual([]);
  });

  it('reports a changed vector dimension, another raw type, a dropped ? and a move into or out of Unsupported', () => {
    expect(unsupportedTypeChanges(BASE, edit('halfvec(1024)', 'halfvec(1536)'))).toEqual([
      { field: 'RAJobEmbedding.embedding', from: 'Unsupported("halfvec(1024)")', to: 'Unsupported("halfvec(1536)")' },
    ]);
    expect(unsupportedTypeChanges(BASE, edit('Unsupported("tsvector")?', 'Unsupported("jsonb")?'))).toEqual([
      { field: 'RAJob.searchTsv', from: 'Unsupported("tsvector")?', to: 'Unsupported("jsonb")?' },
    ]);
    expect(unsupportedTypeChanges(BASE, edit('Unsupported("tsvector")?', 'Unsupported("tsvector")')).map((c) => c.to)).toEqual(['Unsupported("tsvector")']);
    expect(unsupportedTypeChanges(BASE, edit('Unsupported("tsvector")?', 'Json?')).map((c) => c.to)).toEqual(['Json?']);
    expect(unsupportedTypeChanges(BASE, edit('title       String', 'title       Unsupported("citext")')).map((c) => c.field)).toEqual(['RAJob.title']);
  });

  it('an empty migration with a changed Unsupported type is not additive', () => {
    const empty = classifyAdditive('-- This is an empty migration.\n');
    expect(empty.ok).toBe(true);
    expect(withUnsupportedChanges(empty, [])).toBe(empty);
    const result = withUnsupportedChanges(empty, unsupportedTypeChanges(BASE, edit('halfvec(1024)', 'halfvec(1536)')));
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { rule: 'unsupported_type_changed', statement: 'RAJobEmbedding.embedding: Unsupported("halfvec(1024)") -> Unsupported("halfvec(1536)")', line: 0 },
    ]);
    expect(RULES.unsupported_type_changed).toMatch(/add a new column/);
  });
});

describe('main: which mode applies what (the Prisma run is replaced by a literal)', () => {
  let dir: string;
  const diffOf = (sql: string, unsupportedChanges: UnsupportedChange[] = []) => ({
    schemaDiff: () => ({ sql, base: null, unsupportedChanges }),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-schema-additive-test-'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('--sql (a database diff) applies KNOWN_DRIFT: the recorded pair passes, a changed definition does not', () => {
    const recorded = join(dir, 'recorded.sql');
    const changed = join(dir, 'changed.sql');
    writeFileSync(recorded, `${ADDITIVE_SQL}${KNOWN_PAIR_SQL}`);
    writeFileSync(changed, KNOWN_PAIR_SQL.replace(' text_pattern_ops', ''));
    expect(main(['--sql', recorded])).toBe(0);
    expect(main(['--sql', changed])).toBe(1);
  });

  it('a schema-to-schema diff never applies KNOWN_DRIFT: introspection drift cannot occur there', () => {
    expect(main(['--from-dir', dir, '--to-dir', dir, '--quiet'], diffOf(KNOWN_PAIR_SQL))).toBe(1);
    expect(main(['--from-dir', dir, '--to-dir', dir, '--quiet'], diffOf(ADDITIVE_SQL))).toBe(0);
  });

  it('a schema-to-schema diff fails on a changed Unsupported type even when the SQL is empty', () => {
    const change = { field: 'RAJobEmbedding.embedding', from: 'Unsupported("halfvec(1024)")', to: 'Unsupported("halfvec(1536)")' };
    expect(main(['--from-dir', dir, '--to-dir', dir, '--quiet'], diffOf('-- This is an empty migration.\n', [change]))).toBe(1);
    expect(main(['--from-dir', dir, '--to-dir', dir, '--quiet'], diffOf('-- This is an empty migration.\n'))).toBe(0);
  });

  it('--out is not written for a diff that is not additive', () => {
    const out = join(dir, 'out.sql');
    const change = { field: 'RAJob.searchTsv', from: 'Unsupported("tsvector")?', to: 'Unsupported("jsonb")?' };
    expect(main(['--from-dir', dir, '--to-dir', dir, '--quiet', '--out', out], diffOf(ADDITIVE_SQL, [change]))).toBe(1);
    expect(() => readFileSync(out, 'utf8')).toThrow();
    expect(main(['--from-dir', dir, '--to-dir', dir, '--quiet', '--out', out], diffOf(ADDITIVE_SQL))).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain(GENERATED_MARKER);
  });
});

describe('splitSqlStatements', () => {
  it('splits on semicolons outside quotes and comments and keeps the first line of each statement', () => {
    const statements = splitSqlStatements(`-- one\nCREATE TABLE "a;b" ("x" TEXT DEFAULT 'p;q');\n\n/* two; */\nCREATE INDEX "i" ON "a;b"("x");`);
    expect(statements.map((s) => s.line)).toEqual([2, 5]);
    expect(statements[0].text).toBe(`CREATE TABLE "a;b" ("x" TEXT DEFAULT 'p;q')`);
    expect(statements[1].text).toBe('CREATE INDEX "i" ON "a;b"("x")');
  });
});

describe('the committed diff of the market wave (docs/jobright-clone/schema-diffs/market-additive.sql)', () => {
  const file = readFileSync(join(DIFFS_DIR, 'market-additive.sql'), 'utf8');
  const parts = splitGeneratedFile(file);

  it('has a reviewer header, the marker and the base commit it was generated from', () => {
    expect(file).toContain(GENERATED_MARKER);
    expect(parts).not.toBeNull();
    expect(parts?.base).toMatch(/^[0-9a-f]{40}$/);
    // The header names every addition beyond MARKET_STRATEGY section 7 item 11 for the owner.
    for (const name of [
      'RAJob.sponsorshipSource',
      'RAJob.locationDistrict',
      'RAJob.workShift',
      'RACareerSiteSource.failCount',
      'RACareerSiteSource.lastChangeAt',
      'RACareerSiteSource.nextSyncAt',
      'RACareerSiteSource.disabledAt',
      'RAUserAffinity.titleWeights',
      'RATailorSession.fitSnapshot',
      'RASponsorRegisterEntry',
      'RABillingRefund',
      'RABillingConsentArchive',
    ]) {
      expect(parts?.header, name).toContain(name);
    }
  });

  it('is additive only, with no known-drift pair needed', () => {
    const result = classifyAdditive(file);
    expect(result.violations).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('creates exactly the six new tables and never touches AlipayOrder', () => {
    const created = [...file.matchAll(/^CREATE TABLE "([^"]+)"/gm)].map((m) => m[1]).sort();
    expect(created).toEqual(
      ['RABillingConsentArchive', 'RABillingRefund', 'RAJobEmbedding', 'RASkill', 'RASponsorRegisterEntry', 'RAUserEmbedding'].sort(),
    );
    const altered = [...new Set([...file.matchAll(/^ALTER TABLE "([^"]+)" ADD COLUMN/gm)].map((m) => m[1]))].sort();
    expect(altered).toEqual(['RACareerSiteSource', 'RAJob', 'RAJobMatchScore', 'RATailorSession', 'RAUserAffinity']);
    expect(parts?.sql).not.toMatch(/"AlipayOrder"|"SeekerSubscription"|"RACreditLedger"|"RACreditGrant"/);
  });

  it('adds two foreign keys, both ON DELETE CASCADE, and the two text-search and skill GIN indexes', () => {
    const foreignKeys = [...file.matchAll(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT .*$/gm)];
    expect(foreignKeys.map((m) => m[1]).sort()).toEqual(['RAJobEmbedding', 'RAUserEmbedding']);
    for (const fk of foreignKeys) expect(fk[0]).toContain('ON DELETE CASCADE');
    expect(file).toContain('CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIN ("searchTsv");');
    expect(file).toContain('CREATE INDEX "RAJob_skillIds_idx" ON "RAJob" USING GIN ("skillIds");');
    expect(file).toContain('"searchTsv" tsvector');
    expect(file).not.toMatch(/GENERATED ALWAYS/i);
  });
});
