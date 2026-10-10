#!/usr/bin/env node
// deploy/cn/migration/plan.mjs — CN-0 → CN-1 data migration plan (WP-76;
// CN_TW_LAUNCH_PLAN.md C-17; docs/runbooks/cn-deploy.md §8).
//
// Reads the Prisma schema (server/prisma/schema/*.prisma) and writes the SQL an
// operator runs with psql to move GoApply's rows — and only GoApply's rows —
// from the offshore database (Neon, CN-0) to the mainland one (Aliyun RDS,
// CN-1). It never connects to a database and never runs anything.
//
// How a table is scoped to GoApply, first rule that applies:
//   1. MANUAL_SCOPES below (a reviewed, hand-written WHERE clause);
//   2. it has a `brand` column → brand = 'goapply' (a nullable brand also takes
//      rows with no brand whose user is a GoApply user);
//   3. it has a `market` column (shared catalogues: jobs, companies, campus
//      events, question bank) → market = 'cn', plus rows a GoApply user owns;
//   4. it has a foreign key to User → that user is a GoApply user;
//   5. it has a plain `userId` column (no foreign key) → a GoApply user;
//   6. it has a foreign key to an already-scoped table → the parent row is in scope.
// PURGE_ONLY below lists regenerable caches that hold users' text but have no
// owner column: they are not moved, and the purge deletes every row written
// before the CN-0 freeze (they refill on demand).
// Anything else is NOT migrated and is listed under "unscoped" in report.json;
// an unscoped table with a free-form payload (Json / @db.Text) or a user-like id
// column is also raised as an `unscoped_personal_data` issue for review.
//
//   node deploy/cn/migration/plan.mjs --out <dir> [--schema server/prisma/schema]
//
// Output (all in <dir>): export.sql (source, read-only snapshot), import.sql
// (target, one transaction left OPEN for the operator to COMMIT), verify-source.sql,
// verify-target.sql, purge-source.sql (source, transaction left open; it first
// snapshots the GoApply user ids so no scope depends on rows already deleted),
// verify-purge.sql (same session, before COMMIT: every count must be 0), report.json.
// The CSV files the export writes hold personal data: see the runbook for handling.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BRAND = 'goapply';
export const MARKET = 'cn';
export const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PASSES = 12;

/** The GoApply user ids, as a subquery. Every user-based scope is built on it. */
export const GOAPPLY_USERS_SQL = `SELECT "id" FROM "User" WHERE "brand" = '${BRAND}'`;
/** purge-source.sql snapshots those ids first, so deleting User rows changes no scope. */
export const PURGE_USERS_TABLE = 'cn_purge_goapply_user';
const PURGE_USERS_SQL = `SELECT "id" FROM pg_temp."${PURGE_USERS_TABLE}"`;
/** psql variable the operator sets to the CN-0 freeze time (runbook §8.3) before purging. */
export const FREEZE_VAR = 'cn_freeze_at';

/**
 * Reviewed, hand-written scopes for tables the generic rules miss or get wrong:
 * `{ Table: { where, reason } }`. In `where`, `{{goapply_users}}` is the GoApply
 * user-id subquery and `{{scope:Table}}` is another table's computed scope
 * (that table then imports first and is purged after). Add an entry, with its
 * reason, when report.json shows a table scoped the wrong way.
 */
export const MANUAL_SCOPES = Object.freeze({
  AIAuditLog: {
    where: `"actorUserId" IN ({{goapply_users}})`,
    reason: 'actorUserId has no foreign key (rows outlive the user); the audit rows of GoApply users move with them and are kept on the mainland.',
  },
  MemoryEntry: {
    where: `"scope" = 'user' AND "scopeId" IN ({{goapply_users}})`,
    reason: 'per-user memories are keyed by scope = user, scopeId = user id (no foreign key).',
  },
  RoboApplyCoverLetterCache: {
    where: `"resumeId" IN (SELECT "id" FROM "Resume" WHERE {{scope:Resume}})`,
    reason: 'generated cover letters keyed by resumeId (no foreign key); a GoApply resume takes its letters along.',
  },
});

/**
 * Regenerable caches with users' text and no owner column (hash-keyed). They do
 * not move; the purge deletes every row created before the freeze, when no
 * GoApply request can have written one any more. RoboApply rows of the same age
 * are dropped too and simply recomputed on the next request.
 */
export const PURGE_ONLY = Object.freeze({
  InterviewTranscriptSegment: { reason: 'per-interview Q&A units with candidates\' answer text, keyed by a hash; schema comment: cache-only, safe to truncate.' },
  InterviewGraderResult: { reason: 'graded interview results cached by a hash of the transcript; regenerable.' },
});
const PURGE_ONLY_WHERE = `"createdAt" < :'${FREEZE_VAR}'::timestamptz`;

/** Column names that usually hold a person's id. */
const PERSONISH_ID_RE = /^(userId|scopeId|actorId)$|(User|Actor|Owner|Candidate|Seeker)Id$/;

function q(ident) {
  if (!IDENT_RE.test(ident)) throw new Error(`Unexpected identifier in schema: ${JSON.stringify(ident)}`);
  return `"${ident}"`;
}

function stripComment(line) {
  // Field and type never contain quotes; cut at the first `//` outside a string.
  let inString = false;
  for (let i = 0; i < line.length - 1; i += 1) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inString = !inString;
    if (!inString && c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function listArg(attr, key) {
  const m = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(attr);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
}

/** Parse model and enum blocks from one or more .prisma texts. */
export function parsePrismaSchema(texts) {
  const blocks = [];
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    let current = null;
    for (const raw of text.split('\n')) {
      const line = stripComment(raw).trim();
      if (!current) {
        const open = /^(model|enum|view|type)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
        if (open) current = { kind: open[1], name: open[2], lines: [] };
        continue;
      }
      if (line === '}') {
        blocks.push(current);
        current = null;
        continue;
      }
      if (line) current.lines.push(line);
    }
    if (current) throw new Error(`Unclosed block ${current.kind} ${current.name}`);
  }
  const enums = new Set(blocks.filter((b) => b.kind === 'enum').map((b) => b.name));
  const modelNames = new Set(blocks.filter((b) => b.kind === 'model').map((b) => b.name));
  const models = new Map();
  for (const b of blocks.filter((x) => x.kind === 'model')) {
    const fields = [];
    let ignored = false;
    for (const line of b.lines) {
      if (line.startsWith('@@')) {
        if (/^@@ignore\b/.test(line)) ignored = true;
        continue;
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)(\[\])?(\?)?(.*)$/.exec(line);
      if (!m) continue;
      const [, name, baseType, list, optional, rest] = m;
      if (/(^|\s)@ignore\b/.test(rest)) continue;
      const isModel = modelNames.has(baseType);
      const field = {
        name,
        type: baseType,
        list: Boolean(list),
        optional: Boolean(optional),
        relation: null,
        autoincrement: /@default\(\s*autoincrement\(\)\s*\)/.test(rest),
        isColumn: !isModel,
        isEnum: enums.has(baseType),
        dbText: /@db\.Text\b/.test(rest),
      };
      if (isModel) {
        const rel = /@relation\(([^)]*)\)/.exec(rest);
        const fkFields = rel ? listArg(rel[1], 'fields') : null;
        const refs = rel ? listArg(rel[1], 'references') : null;
        field.relation = fkFields && refs ? { model: baseType, fields: fkFields, references: refs } : { model: baseType, fields: null, references: null };
      }
      fields.push(field);
    }
    models.set(b.name, { name: b.name, fields, ignored });
  }
  return { models, enums };
}

function fkRelations(model) {
  return model.fields.filter((f) => f.relation?.fields?.length);
}

function columnOf(model, name) {
  return model.fields.find((f) => f.name === name && f.isColumn) ?? null;
}

/** Decide which rows of each table belong to GoApply. */
export function scopeModels(schema, { manual = MANUAL_SCOPES, purgeOnly = PURGE_ONLY } = {}) {
  const { models } = schema;
  const scopes = new Map();
  const goapplyUsers = GOAPPLY_USERS_SQL;
  const tableRefs = (where) => [...where.matchAll(/\{\{scope:([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]);
  const resolveManual = (name, override) => {
    let where = override.where.replaceAll('{{goapply_users}}', goapplyUsers);
    const refs = new Set(override.where.includes('{{goapply_users}}') ? ['User'] : []);
    for (const ref of tableRefs(override.where)) {
      const target = scopes.get(ref);
      if (!target) throw new Error(`MANUAL_SCOPES.${name} refers to {{scope:${ref}}}, but ${ref} is not migrated.`);
      where = where.replaceAll(`{{scope:${ref}}}`, `(${target.where})`);
      refs.add(ref);
    }
    return { where, rule: 'manual', via: override.reason, refs: [...refs] };
  };
  const deferred = [];
  const userFk = (model) => {
    const rels = fkRelations(model).filter((f) => f.relation.model === 'User' && f.relation.fields.length === 1 && f.relation.references[0] === 'id');
    rels.sort((a, b) => Number(a.optional) - Number(b.optional));
    return rels;
  };

  for (const model of models.values()) {
    if (model.ignored || purgeOnly[model.name]) continue;
    const override = manual[model.name];
    if (override) {
      // Scopes that build on another table's scope are resolved at the end.
      if (tableRefs(override.where).length) deferred.push(model.name);
      else scopes.set(model.name, resolveManual(model.name, override));
      continue;
    }
    const brand = columnOf(model, 'brand');
    if (brand) {
      const users = userFk(model);
      if (brand.optional && users.length) {
        const fk = users[0].relation.fields[0];
        scopes.set(model.name, {
          where: `"brand" = '${BRAND}' OR ("brand" IS NULL AND ${q(fk)} IN (${goapplyUsers}))`,
          rule: 'brand+user',
          via: fk,
        });
      } else {
        scopes.set(model.name, { where: `"brand" = '${BRAND}'`, rule: 'brand', via: 'brand' });
      }
      continue;
    }
    const users = userFk(model);
    const plainUserId = columnOf(model, 'userId');
    const owner = users[0]
      ? { column: users[0].relation.fields[0], optional: users[0].optional }
      : plainUserId && plainUserId.type === 'String' && !plainUserId.list
        ? { column: 'userId', optional: plainUserId.optional }
        : null;
    const market = columnOf(model, 'market');
    // Shared catalogues carry a market instead of a brand (GoApply = market cn).
    // A row with an owner always follows its owner: a RoboApply user's row never
    // moves because of its market value. Only ownerless rows go by market.
    if (market && (!owner || owner.optional)) {
      scopes.set(model.name, {
        where: owner
          ? `("market" = '${MARKET}' AND ${q(owner.column)} IS NULL) OR ${q(owner.column)} IN (${goapplyUsers})`
          : `"market" = '${MARKET}'`,
        rule: owner ? 'market+owner' : 'market',
        via: owner ? `market (ownerless rows), ${owner.column}` : 'market',
        multipleUserRelations: users.length > 1,
      });
      continue;
    }
    if (users.length) {
      const fk = users[0].relation.fields[0];
      scopes.set(model.name, { where: `${q(fk)} IN (${goapplyUsers})`, rule: 'user', via: fk, multipleUserRelations: users.length > 1 });
      continue;
    }
    // A user id kept without a foreign key (e.g. onboarding sessions).
    const userId = columnOf(model, 'userId');
    if (userId && userId.type === 'String' && !userId.list) {
      scopes.set(model.name, { where: `"userId" IN (${goapplyUsers})`, rule: 'userId', via: 'userId (no foreign key)', refs: ['User'] });
    }
  }

  // Children of scoped tables, until nothing changes.
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let added = 0;
    for (const model of models.values()) {
      if (model.ignored || scopes.has(model.name) || purgeOnly[model.name] || manual[model.name]) continue;
      const parents = fkRelations(model)
        .filter((f) => f.relation.fields.length === 1 && f.relation.model !== model.name && scopes.has(f.relation.model))
        .sort((a, b) => Number(a.optional) - Number(b.optional));
      if (!parents.length) continue;
      const rel = parents[0];
      const parent = scopes.get(rel.relation.model);
      scopes.set(model.name, {
        where: `${q(rel.relation.fields[0])} IN (SELECT ${q(rel.relation.references[0])} FROM ${q(rel.relation.model)} WHERE ${parent.where})`,
        rule: 'parent',
        via: `${rel.relation.fields[0]} → ${rel.relation.model}`,
      });
      added += 1;
    }
    if (!added) break;
  }
  for (const name of deferred) scopes.set(name, resolveManual(name, manual[name]));
  return scopes;
}

/** Parents before children among scoped tables; cycles are appended and reported. */
export function importOrder(schema, scopes) {
  const names = [...scopes.keys()].sort();
  const deps = new Map(
    names.map((n) => [
      n,
      new Set(
        [...fkRelations(schema.models.get(n)).map((f) => f.relation.model), ...(scopes.get(n).refs ?? [])].filter(
          (m) => m !== n && scopes.has(m),
        ),
      ),
    ]),
  );
  const order = [];
  const done = new Set();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const n of names) {
      if (done.has(n)) continue;
      if ([...deps.get(n)].every((d) => done.has(d))) {
        order.push(n);
        done.add(n);
        progressed = true;
      }
    }
  }
  const cyclic = names.filter((n) => !done.has(n));
  return { order: [...order, ...cyclic], cyclic };
}

/** Everything an operator must look at before running the plan. */
export function reviewIssues(schema, scopes, cyclic, { manual = MANUAL_SCOPES, purgeOnly = PURGE_ONLY } = {}) {
  const issues = [];
  for (const name of [...Object.keys(manual), ...Object.keys(purgeOnly)]) {
    if (!schema.models.has(name)) issues.push({ table: name, kind: 'stale_manual_entry', detail: `${name} is listed in MANUAL_SCOPES / PURGE_ONLY but no longer exists in the schema; remove the entry.` });
  }
  for (const model of schema.models.values()) {
    if (model.ignored || scopes.has(model.name) || purgeOnly[model.name]) continue;
    const ids = model.fields.filter((f) => f.isColumn && PERSONISH_ID_RE.test(f.name)).map((f) => f.name);
    const payload = model.fields.filter((f) => f.isColumn && (f.type === 'Json' || f.dbText)).map((f) => f.name);
    if (!ids.length && !payload.length) continue;
    issues.push({
      table: model.name,
      kind: 'unscoped_personal_data',
      detail: `not migrated and not purged, but ${[ids.length ? `has user-like id column(s) ${ids.join(', ')}` : '', payload.length ? `free-form payload column(s) ${payload.join(', ')}` : ''].filter(Boolean).join(' and ')}. Confirm it holds no GoApply user's data, or add a reviewed MANUAL_SCOPES / PURGE_ONLY entry and regenerate.`,
    });
  }
  for (const name of scopes.keys()) {
    const model = schema.models.get(name);
    for (const f of fkRelations(model)) {
      const target = f.relation.model;
      if (target === name) {
        issues.push({ table: name, kind: 'self_reference', detail: `${f.relation.fields.join(',')} → ${name}: rows must be imported parents-first (or with FK checks relaxed by an RDS privileged account).` });
      } else if (!scopes.has(target)) {
        issues.push({
          table: name,
          kind: f.optional ? 'optional_fk_to_unscoped' : 'required_fk_to_unscoped',
          detail: `${f.relation.fields.join(',')} → ${target} (${target} is not migrated). ${f.optional ? 'Set the column to NULL on import, or migrate the referenced rows.' : 'The import fails unless the referenced rows exist on the mainland.'}`,
        });
      }
    }
    if (scopes.get(name).multipleUserRelations) {
      issues.push({ table: name, kind: 'multiple_user_relations', detail: `scoped by ${scopes.get(name).via}; rows that also point at a RoboApply user would break the no-cross-brand rule.` });
    }
  }
  for (const name of cyclic) issues.push({ table: name, kind: 'fk_cycle', detail: 'part of a foreign-key cycle; import order inside the cycle is not guaranteed.' });
  return issues;
}

function columns(model) {
  return model.fields.filter((f) => f.isColumn).map((f) => q(f.name));
}

/** Render every file of the plan. Returns { files: {name: text}, report }. */
export function buildPlan(schema, { manual = MANUAL_SCOPES, purgeOnly = PURGE_ONLY, generatedAt = null } = {}) {
  const scopes = scopeModels(schema, { manual, purgeOnly });
  const { order, cyclic } = importOrder(schema, scopes);
  const issues = reviewIssues(schema, scopes, cyclic, { manual, purgeOnly });
  const purgeTables = Object.keys(purgeOnly).filter((n) => schema.models.has(n) && !schema.models.get(n).ignored).sort();
  const unscoped = [...schema.models.values()].filter((m) => !m.ignored && !scopes.has(m.name) && !purgeOnly[m.name]).map((m) => m.name).sort();
  // In the purge, scopes read the snapshot of GoApply user ids, never the live User table.
  const purgeWhere = (n) => scopes.get(n).where.split(GOAPPLY_USERS_SQL).join(PURGE_USERS_SQL);
  const stamp = `-- GENERATED by deploy/cn/migration/plan.mjs${generatedAt ? ` at ${generatedAt}` : ''}. Review before running (docs/runbooks/cn-deploy.md §8).`;

  const exportLines = [
    stamp,
    '-- SOURCE (offshore Neon), read-only. One consistent snapshot for every table:',
    '--   psql "$SOURCE_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f export.sql',
    '-- Writes data/<Table>.csv next to where psql runs. The files hold personal data.',
    '\\! mkdir -p data',
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
    ...order.map((n) => `\\copy (SELECT ${columns(schema.models.get(n)).join(', ')} FROM ${q(n)} WHERE ${scopes.get(n).where}) TO 'data/${n}.csv' WITH (FORMAT csv, HEADER true)`),
    'COMMIT;',
  ];

  const sequences = order.flatMap((n) =>
    schema.models
      .get(n)
      .fields.filter((f) => f.autoincrement)
      .map((f) => `SELECT setval(pg_get_serial_sequence('${q(n)}', '${f.name}'), COALESCE((SELECT MAX(${q(f.name)}) FROM ${q(n)}), 1));`),
  );
  const importLines = [
    stamp,
    '-- TARGET (Aliyun RDS, cn-shanghai), after the owner-confirmed schema push. Run INTERACTIVELY:',
    '--   psql "$TARGET_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1',
    '--   \\i import.sql      then  \\i verify-target.sql  and compare with verify-source.sql',
    '--   COMMIT;            only when every count matches (otherwise ROLLBACK;)',
    'BEGIN;',
    ...order.map((n) => `\\copy ${q(n)} (${columns(schema.models.get(n)).join(', ')}) FROM 'data/${n}.csv' WITH (FORMAT csv, HEADER true)`),
    ...sequences,
    '-- The transaction is still open. COMMIT; or ROLLBACK;',
  ];

  const countQuery = (where) => order.map((n) => `SELECT '${n}' AS "table", count(*) AS "rows" FROM ${q(n)}${where ? ` WHERE ${scopes.get(n).where}` : ''}`).join('\nUNION ALL\n');
  const verifySource = [stamp, '-- SOURCE: rows in scope per table.', `${countQuery(true)}\nORDER BY 1;`];
  const verifyTarget = [stamp, '-- TARGET: rows per table (the mainland database holds only GoApply rows).', `${countQuery(false)}\nORDER BY 1;`];

  const freezeGuard = [
    `\\if :{?${FREEZE_VAR}}`,
    '\\else',
    `\\echo 'Stopped: set the psql variable ${FREEZE_VAR} to the CN-0 freeze time in UTC (runbook step 8.3) first.'`,
    '\\quit',
    '\\endif',
  ];
  const purgeLines = [
    stamp,
    '-- SOURCE (offshore Neon), ONLY after the verification window and the owner\'s written go-ahead.',
    '-- Take a Neon branch/backup first. Children before parents. Run INTERACTIVELY and COMMIT yourself:',
    '--   psql "$SOURCE_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1',
    `--   \\set ${FREEZE_VAR} '<freeze time, UTC>'   then   \\i purge-source.sql   then   \\i verify-purge.sql`,
    ...freezeGuard,
    'BEGIN;',
    '-- Snapshot the GoApply user ids, so no scope below depends on rows this script already deleted.',
    `CREATE TEMP TABLE ${q(PURGE_USERS_TABLE)} ON COMMIT DROP AS ${GOAPPLY_USERS_SQL};`,
    ...[...order].reverse().map((n) => `DELETE FROM ${q(n)} WHERE ${purgeWhere(n)};`),
    '-- Regenerable caches with no owner column (PURGE_ONLY): every row written before the freeze.',
    ...purgeTables.map((n) => `DELETE FROM ${q(n)} WHERE ${PURGE_ONLY_WHERE};`),
    '-- The transaction is still open. Run verify-purge.sql now (same session): every count must be 0. Then COMMIT; (or ROLLBACK;)',
  ];
  const verifyPurge = [
    stamp,
    '-- SOURCE, in the SAME psql session as purge-source.sql and BEFORE COMMIT (it reads the user-id snapshot).',
    '-- Every count must be 0.',
    ...freezeGuard,
    `${[
      ...order.map((n) => `SELECT '${n}' AS "table", count(*) AS "rows" FROM ${q(n)} WHERE ${purgeWhere(n)}`),
      ...purgeTables.map((n) => `SELECT '${n}' AS "table", count(*) AS "rows" FROM ${q(n)} WHERE ${PURGE_ONLY_WHERE}`),
    ].join('\nUNION ALL\n')}\nORDER BY 1;`,
  ];

  const report = {
    brand: BRAND,
    tables: order.map((n) => ({ table: n, rule: scopes.get(n).rule, via: scopes.get(n).via, where: scopes.get(n).where })),
    purgeOnly: purgeTables.map((n) => ({ table: n, reason: purgeOnly[n].reason, where: PURGE_ONLY_WHERE })),
    unscoped,
    issues,
    counts: { models: schema.models.size, scoped: order.length, purgeOnly: purgeTables.length, unscoped: unscoped.length, issues: issues.length },
  };
  return {
    files: {
      'export.sql': `${exportLines.join('\n')}\n`,
      'import.sql': `${importLines.join('\n')}\n`,
      'verify-source.sql': `${verifySource.join('\n')}\n`,
      'verify-target.sql': `${verifyTarget.join('\n')}\n`,
      'purge-source.sql': `${purgeLines.join('\n')}\n`,
      'verify-purge.sql': `${verifyPurge.join('\n')}\n`,
      'report.json': `${JSON.stringify(report, null, 2)}\n`,
    },
    report,
  };
}

export function readSchemaDir(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.prisma'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'));
}

export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const opts = { out: null, schema: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--schema') opts.schema = argv[++i];
    else {
      io.error(`Unknown argument: ${argv[i]}`);
      return 2;
    }
  }
  if (!opts.out) {
    io.error('Usage: node deploy/cn/migration/plan.mjs --out <dir> [--schema server/prisma/schema]');
    return 2;
  }
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const schemaDir = resolve(opts.schema ?? join(repo, 'server/prisma/schema'));
  const { files, report } = buildPlan(parsePrismaSchema(readSchemaDir(schemaDir)), { generatedAt: new Date().toISOString() });
  mkdirSync(opts.out, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(opts.out, name), text);
  io.log(
    `Plan written to ${opts.out}: ${report.counts.scoped} tables in scope, ${report.counts.purgeOnly} caches purged only, ${report.counts.unscoped} not migrated, ${report.counts.issues} issues to review (report.json).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
