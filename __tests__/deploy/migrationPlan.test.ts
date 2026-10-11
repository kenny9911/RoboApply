// @vitest-environment node
//
// WP-76: deploy/cn/migration/plan.mjs — the CN-0 → CN-1 migration plan
// generator. It only renders SQL for an operator; nothing here touches a
// database.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as planner from '../../deploy/cn/migration/plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIXTURE = `
// A comment with a // inside
model User {
  id        String   @id @default(cuid())
  brand     String   @default("roboapply")
  email     String   @unique // trailing comment
  teamId    String?
  team      Team?    @relation(fields: [teamId], references: [id])
  managerId String?
  manager   User?    @relation("Mgr", fields: [managerId], references: [id])
  reports   User[]   @relation("Mgr")
  resumes   Resume[]
  @@index([brand])
}

model Team {
  id      String @id
  name    String
  members User[]
}

model Resume {
  id        String    @id
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  title     String    @default("https://example.com//x")
  sections  Section[]
}

model Section {
  id       String  @id
  resumeId String
  resume   Resume  @relation(fields: [resumeId], references: [id])
  kind     Kind
  tags     String[]
  legacy   String? @ignore
}

model Session {
  id     String  @id
  brand  String?
  userId String
  user   User    @relation(fields: [userId], references: [id])
}

model Job {
  id          String  @id
  market      String  @default("intl")
  ownerUserId String?
  owner       User?   @relation("JobOwner", fields: [ownerUserId], references: [id])
}

model Profile {
  id     String @id
  market String
  userId String @unique
  user   User   @relation(fields: [userId], references: [id])
}

model Onboarding {
  id     String @id
  userId String
}

model Counter {
  id    Int    @id @default(autoincrement())
  key   String
}

model Hidden {
  id String @id
  @@ignore
}

model Audit {
  id          String  @id
  actorUserId String?
  payload     Json
}

model LetterCache {
  id       String @id
  resumeId String
  output   Json
}

model AnswerCache {
  id        String   @id
  hashKey   String   @unique
  payload   Json
  createdAt DateTime @default(now())
}

model Note {
  id   String @id
  body String @db.Text
}

enum Kind {
  A
  B
}
`;

const schema = planner.parsePrismaSchema(FIXTURE);
const scopes = planner.scopeModels(schema) as Map<string, { where: string; rule: string }>;

describe('parsePrismaSchema', () => {
  it('reads models, columns, relations and enums', () => {
    expect([...schema.models.keys()].sort()).toEqual(
      ['AnswerCache', 'Audit', 'Counter', 'Hidden', 'Job', 'LetterCache', 'Note', 'Onboarding', 'Profile', 'Resume', 'Section', 'Session', 'Team', 'User'].sort(),
    );
    const section = schema.models.get('Section');
    const cols = section.fields.filter((f: { isColumn: boolean }) => f.isColumn).map((f: { name: string }) => f.name);
    expect(cols).toEqual(['id', 'resumeId', 'kind', 'tags']); // relation field and @ignore column left out
    expect(section.fields.find((f: { name: string }) => f.name === 'resume').relation).toEqual({ model: 'Resume', fields: ['resumeId'], references: ['id'] });
    expect(schema.enums.has('Kind')).toBe(true);
    expect(schema.models.get('Hidden').ignored).toBe(true);
    expect(schema.models.get('Counter').fields[0].autoincrement).toBe(true);
    expect(schema.models.get('User').fields.find((f: { name: string }) => f.name === 'email').isColumn).toBe(true);
  });

  it('refuses an unclosed block', () => {
    expect(() => planner.parsePrismaSchema('model A {\n  id String @id\n')).toThrow(/Unclosed/);
  });
});

describe('scopeModels', () => {
  it('scopes by brand, market, user, plain userId and parent, in that order', () => {
    expect(scopes.get('User')).toMatchObject({ rule: 'brand', where: `"brand" = 'goapply'` });
    expect(scopes.get('Session')?.rule).toBe('brand+user');
    expect(scopes.get('Session')?.where).toContain(`"brand" IS NULL AND "userId" IN (SELECT "id" FROM "User" WHERE "brand" = 'goapply')`);
    expect(scopes.get('Resume')).toMatchObject({ rule: 'user' });
    expect(scopes.get('Onboarding')).toMatchObject({ rule: 'userId' });
    expect(scopes.get('Section')).toMatchObject({ rule: 'parent' });
    expect(scopes.get('Section')?.where).toBe(
      `"resumeId" IN (SELECT "id" FROM "Resume" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "brand" = 'goapply'))`,
    );
  });

  it('moves ownerless catalogue rows by market, but owned rows only with their GoApply owner', () => {
    expect(scopes.get('Job')).toMatchObject({ rule: 'market+owner' });
    expect(scopes.get('Job')?.where).toBe(
      `("market" = 'cn' AND "ownerUserId" IS NULL) OR "ownerUserId" IN (SELECT "id" FROM "User" WHERE "brand" = 'goapply')`,
    );
    // A required owner wins over the market column: a RoboApply user's row never moves.
    expect(scopes.get('Profile')).toMatchObject({ rule: 'user' });
  });

  it('leaves tables with no path to GoApply unscoped, and skips @@ignore models', () => {
    expect(scopes.has('Team')).toBe(false);
    expect(scopes.has('Counter')).toBe(false);
    expect(scopes.has('Hidden')).toBe(false);
  });

  it('applies reviewed manual scopes first', () => {
    const manual = planner.scopeModels(schema, { manual: { Team: { where: `"name" = 'x'`, reason: 'test' } } });
    expect(manual.get('Team')).toMatchObject({ rule: 'manual', where: `"name" = 'x'` });
  });

  it('expands {{goapply_users}} and {{scope:Table}} in manual scopes', () => {
    const manual = planner.scopeModels(schema, { manual: MANUAL });
    expect(manual.get('Audit')).toMatchObject({ rule: 'manual', where: `"actorUserId" IN (SELECT "id" FROM "User" WHERE "brand" = 'goapply')`, refs: ['User'] });
    expect(manual.get('LetterCache')?.where).toBe(
      `"resumeId" IN (SELECT "id" FROM "Resume" WHERE ("userId" IN (SELECT "id" FROM "User" WHERE "brand" = 'goapply')))`,
    );
    expect(manual.get('LetterCache')?.refs).toEqual(['Resume']);
    expect(() => planner.scopeModels(schema, { manual: { Note: { where: `"id" IN (SELECT "id" FROM "Team" WHERE {{scope:Team}})`, reason: 't' } } })).toThrow(/Team is not migrated/);
  });
});

const MANUAL = {
  Audit: { where: `"actorUserId" IN ({{goapply_users}})`, reason: 'test' },
  LetterCache: { where: `"resumeId" IN (SELECT "id" FROM "Resume" WHERE {{scope:Resume}})`, reason: 'test' },
};
const PURGE_ONLY = { AnswerCache: { reason: 'test cache' } };

describe('tables with no owner column (C-17: nothing of GoApply stays offshore)', () => {
  const { files, report } = planner.buildPlan(schema, { manual: MANUAL, purgeOnly: PURGE_ONLY }) as {
    files: Record<string, string>;
    report: { tables: Array<{ table: string }>; unscoped: string[]; purgeOnly: Array<{ table: string }>; issues: Array<{ table: string; kind: string }> };
  };
  const order = report.tables.map((t) => t.table);
  const purge = files['purge-source.sql']!;

  it('moves manual-scoped tables after the tables their scope reads, and purges them before', () => {
    expect(order.indexOf('Resume')).toBeLessThan(order.indexOf('LetterCache'));
    expect(order.indexOf('User')).toBeLessThan(order.indexOf('Audit'));
    expect(purge.indexOf('DELETE FROM "LetterCache"')).toBeLessThan(purge.indexOf('DELETE FROM "Resume"'));
    expect(purge.indexOf('DELETE FROM "Audit"')).toBeLessThan(purge.indexOf('DELETE FROM "User"'));
  });

  it('purges against a snapshot of the GoApply user ids taken before any delete', () => {
    const snapshot = purge.indexOf(`CREATE TEMP TABLE "cn_purge_goapply_user" ON COMMIT DROP AS SELECT "id" FROM "User" WHERE "brand" = 'goapply';`);
    expect(snapshot).toBeGreaterThan(purge.indexOf('BEGIN;'));
    expect(snapshot).toBeLessThan(purge.indexOf('DELETE FROM'));
    const deletes = purge.split('\n').filter((l) => l.startsWith('DELETE FROM'));
    for (const d of deletes) expect(d).not.toContain(`FROM "User" WHERE "brand" = 'goapply')`);
    expect(purge).toContain(`DELETE FROM "Onboarding" WHERE "userId" IN (SELECT "id" FROM pg_temp."cn_purge_goapply_user");`);
  });

  it('purges owner-less caches written before the freeze, and refuses to run without the freeze time', () => {
    expect(report.purgeOnly.map((t) => t.table)).toEqual(['AnswerCache']);
    expect(order).not.toContain('AnswerCache');
    expect(files['export.sql']).not.toContain('AnswerCache');
    expect(purge).toContain(`DELETE FROM "AnswerCache" WHERE "createdAt" < :'cn_freeze_at'::timestamptz;`);
    expect(purge.indexOf('\\if :{?cn_freeze_at}')).toBeLessThan(purge.indexOf('BEGIN;'));
    expect(purge).not.toMatch(/^COMMIT;/m);
  });

  it('verifies the purge in the same session against the same snapshot, covering every purged table', () => {
    const verify = files['verify-purge.sql']!;
    for (const t of [...order, 'AnswerCache']) expect(verify, t).toContain(`SELECT '${t}' AS "table"`);
    expect(verify).toContain('pg_temp."cn_purge_goapply_user"');
    expect(verify).not.toMatch(/^(DELETE|COMMIT|DROP)\b/m);
  });

  it('raises every other table with a payload or a user-like id as unscoped personal data', () => {
    const flagged = report.issues.filter((i) => i.kind === 'unscoped_personal_data').map((i) => i.table);
    expect(flagged.sort()).toEqual(['Note']); // @db.Text body; Team and Counter carry neither signal
    expect(report.unscoped).toEqual(['Counter', 'Note', 'Team']);
    const defaults = planner.buildPlan(schema) as { report: { issues: Array<{ table: string; kind: string }> } };
    expect(defaults.report.issues.filter((i) => i.kind === 'unscoped_personal_data').map((i) => i.table).sort()).toEqual(['AnswerCache', 'Audit', 'LetterCache', 'Note']);
    expect(defaults.report.issues.filter((i) => i.kind === 'stale_manual_entry').map((i) => i.table).sort()).toEqual(
      [...Object.keys(planner.MANUAL_SCOPES), ...Object.keys(planner.PURGE_ONLY)].sort(),
    );
  });
});

describe('buildPlan', () => {
  const { files, report } = planner.buildPlan(schema, { generatedAt: '2026-10-10T00:00:00.000Z' }) as {
    files: Record<string, string>;
    report: { tables: Array<{ table: string }>; unscoped: string[]; issues: Array<{ table: string; kind: string }> };
  };
  const order = report.tables.map((t) => t.table);

  it('imports parents before children', () => {
    expect(order.indexOf('User')).toBeLessThan(order.indexOf('Resume'));
    expect(order.indexOf('Resume')).toBeLessThan(order.indexOf('Section'));
    expect(order.indexOf('User')).toBeLessThan(order.indexOf('Job'));
    expect(report.unscoped).toEqual(['AnswerCache', 'Audit', 'Counter', 'LetterCache', 'Note', 'Team']);
  });

  it('flags what an operator must review', () => {
    const kinds = report.issues.map((i) => `${i.table}:${i.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(['User:optional_fk_to_unscoped', 'User:self_reference']));
  });

  it('exports in one read-only snapshot with explicit column lists', () => {
    const exp = files['export.sql']!;
    expect(exp).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    expect(exp).toContain(`\\copy (SELECT "id", "resumeId", "kind", "tags" FROM "Section" WHERE "resumeId" IN (`);
    expect(exp).toContain(`TO 'data/Section.csv' WITH (FORMAT csv, HEADER true)`);
    expect(exp).not.toMatch(/^(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/m);
  });

  it('imports in one transaction left open for the operator, after the schema push', () => {
    const imp = files['import.sql']!;
    expect(imp).toContain('BEGIN;');
    expect(imp).not.toMatch(/^COMMIT;/m);
    expect(imp).toContain(`\\copy "Section" ("id", "resumeId", "kind", "tags") FROM 'data/Section.csv' WITH (FORMAT csv, HEADER true)`);
    expect(imp).not.toMatch(/^(DROP|ALTER|TRUNCATE|DELETE)\b/m);
  });

  it('verifies counts on both sides and purges children first, never auto-committing', () => {
    expect(files['verify-source.sql']).toContain(`SELECT 'User' AS "table", count(*) AS "rows" FROM "User" WHERE "brand" = 'goapply'`);
    expect(files['verify-target.sql']).toContain(`SELECT 'User' AS "table", count(*) AS "rows" FROM "User"\n`);
    const purge = files['purge-source.sql']!;
    expect(purge.indexOf('DELETE FROM "Section"')).toBeLessThan(purge.indexOf('DELETE FROM "Resume"'));
    expect(purge.indexOf('DELETE FROM "Resume"')).toBeLessThan(purge.indexOf('DELETE FROM "User"'));
    expect(purge).not.toMatch(/^COMMIT;/m);
    expect(purge).not.toContain('DELETE FROM "Team"');
  });

  it('resets autoincrement sequences only for scoped tables', () => {
    expect(files['import.sql']).not.toContain('setval');
    const withCounter = planner.buildPlan(schema, { manual: { Counter: { where: `"key" LIKE 'cn:%'`, reason: 'test' } } });
    expect(withCounter.files['import.sql']).toContain(`SELECT setval(pg_get_serial_sequence('"Counter"', 'id')`);
  });
});

describe('the real schema', () => {
  it('parses every model and scopes the GoApply core tables', () => {
    const real = planner.parsePrismaSchema(planner.readSchemaDir(join(ROOT, 'server/prisma/schema')));
    const realScopes = planner.scopeModels(real) as Map<string, { rule: string }>;
    expect(real.models.size).toBeGreaterThan(100);
    expect(realScopes.get('User')?.rule).toBe('brand');
    for (const t of ['SeekerProfile', 'InterviewSession', 'AlipayOrder', 'RAJob', 'SeekerConsentRecord']) {
      expect(realScopes.has(t), t).toBe(true);
    }
    const { report } = planner.buildPlan(real);
    expect(report.counts.scoped + report.counts.purgeOnly + report.counts.unscoped).toBe(
      [...real.models.values()].filter((m: { ignored: boolean }) => !m.ignored).length,
    );
  });

  it('leaves no known GoApply personal data offshore on the real schema', () => {
    const real = planner.parsePrismaSchema(planner.readSchemaDir(join(ROOT, 'server/prisma/schema')));
    const { report } = planner.buildPlan(real) as {
      report: { tables: Array<{ table: string; rule: string; where: string }>; purgeOnly: Array<{ table: string }>; unscoped: string[]; issues: Array<{ table: string; kind: string }> };
    };
    const byTable = new Map(report.tables.map((t) => [t.table, t]));
    expect(byTable.get('AIAuditLog')).toMatchObject({ rule: 'manual', where: `"actorUserId" IN (SELECT "id" FROM "User" WHERE "brand" = 'goapply')` });
    expect(byTable.get('MemoryEntry')?.where).toBe(`"scope" = 'user' AND "scopeId" IN (SELECT "id" FROM "User" WHERE "brand" = 'goapply')`);
    expect(byTable.get('RoboApplyCoverLetterCache')?.where).toMatch(/^"resumeId" IN \(SELECT "id" FROM "Resume" WHERE /);
    expect(report.purgeOnly.map((t) => t.table).sort()).toEqual(['InterviewGraderResult', 'InterviewTranscriptSegment']);
    for (const t of ['AIAuditLog', 'MemoryEntry', 'RoboApplyCoverLetterCache', 'InterviewGraderResult', 'InterviewTranscriptSegment']) {
      expect(report.unscoped, t).not.toContain(t);
    }
    // Every MANUAL_SCOPES / PURGE_ONLY entry still names a real table.
    expect(report.issues.filter((i) => i.kind === 'stale_manual_entry')).toEqual([]);
  });

  // MKT-0 request O-7 (applied at the PAR gate): GoApply's RAJob rows keep their skillIds,
  // so the shared vocabulary they point to is copied whole, and is never deleted offshore,
  // where RoboApply still uses it.
  it('copies the shared skill vocabulary to the mainland and never purges it offshore', () => {
    const real = planner.parsePrismaSchema(planner.readSchemaDir(join(ROOT, 'server/prisma/schema')));
    const { files, report } = planner.buildPlan(real) as {
      files: Record<string, string>;
      report: { tables: Array<{ table: string; rule: string; where: string; copyOnly?: boolean }>; unscoped: string[] };
    };
    expect(report.tables.find((t) => t.table === 'RASkill')).toMatchObject({ rule: 'manual', where: 'TRUE', copyOnly: true });
    expect(report.unscoped).not.toContain('RASkill');
    expect(files['export.sql']).toMatch(/\\copy \(SELECT .* FROM "RASkill" WHERE TRUE\) TO 'data\/RASkill\.csv'/);
    expect(files['import.sql']).toContain(`\\copy "RASkill" (`);
    expect(files['verify-source.sql']).toContain(`FROM "RASkill" WHERE TRUE`);
    expect(files['verify-target.sql']).toContain(`FROM "RASkill"`);
    expect(files['purge-source.sql']).not.toMatch(/DELETE FROM "RASkill"/);
    expect(files['purge-source.sql']).toContain('Copied to the mainland and kept here');
    expect(files['verify-purge.sql']).not.toContain(`'RASkill'`);
    // It is the only table kept offshore after being copied; every other scoped table is purged.
    expect(report.tables.filter((t) => t.copyOnly).map((t) => t.table)).toEqual(['RASkill']);
    for (const t of report.tables.filter((x) => !x.copyOnly)) expect(files['purge-source.sql'], t.table).toContain(`DELETE FROM "${t.table}" WHERE `);
  });

  it('writes the plan files with --out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cn-plan-'));
    try {
      const logs: string[] = [];
      expect(planner.main(['--out', dir], { log: (l: string) => logs.push(l), error: () => {} })).toBe(0);
      for (const f of ['export.sql', 'import.sql', 'verify-source.sql', 'verify-target.sql', 'purge-source.sql', 'verify-purge.sql', 'report.json']) {
        expect(readFileSync(join(dir, f), 'utf8').length, f).toBeGreaterThan(50);
      }
      expect(logs[0]).toMatch(/tables in scope/);
      expect(planner.main([], { log: () => {}, error: () => {} })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
