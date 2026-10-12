// server/src/test/fakePrisma.ts
//
// A small in-memory stand-in for the typed Prisma client, for service tests
// that need real reads-after-writes without a database (FND-2a; FND-3/FND-4
// extend it). Each model delegate (`fake.user`, `fake.rAEntitlementOverride`,
// …) is created on first access and supports:
//   findUnique, findFirst, findMany, count, create, createMany, update,
//   updateMany, upsert, delete, deleteMany
// with `where` (equality, null, AND/OR/NOT, and the operators equals, in,
// notIn, not, lt, lte, gt, gte, contains, startsWith, endsWith), `orderBy`
// (object or array), `take`, `skip` and a shallow `select`. Relations, nested
// writes and `include` are NOT modelled: seed the rows the code reads.
// `$transaction` runs callbacks against the same store (no isolation) and
// awaits arrays; raw SQL goes to a `createSqlRecorder()` (sqlSnapshot.ts).
// FND-3 additions: `sql` options for the recorder (queued results or a
// responder), `@updatedAt` emulation on update/updateMany/upsert
// (`updatedAtFields`), `createMany({ skipDuplicates })` against `uniqueFields`,
// and `failOn` to make one delegate method throw (e.g. a missing table).
//
// No vitest imports: the file compiles with the server.

import crypto from 'node:crypto';
import { createSqlRecorder, type SqlRecorder, type SqlRecorderOptions } from './sqlSnapshot.js';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

export interface FakePrismaOptions {
  /** Initial rows per delegate name (`{ user: [...], seekerConsentRecord: [...] }`). */
  seed?: Record<string, Row[]>;
  /** Fields that get `new Date()` on create when absent. */
  timestampFields?: string[];
  /** Fields set to `new Date()` on every update (Prisma `@updatedAt`). Default `['updatedAt']`. */
  updatedAtFields?: string[];
  /** Per delegate: fields that must be unique (create throws P2002; createMany skipDuplicates skips). */
  uniqueFields?: Record<string, string[]>;
  /** Options for the raw-SQL recorder. */
  sql?: SqlRecorderOptions;
  /** Make `<delegate>.<method>` throw this error (e.g. `{ 'rAEmailLog.create': new Error('no table') }`). */
  failOn?: Record<string, Error>;
  /** Per delegate: schema defaults applied on create when a field is absent (e.g. `{ rAWorkItem: { status: 'queued' } }`). */
  defaults?: Record<string, Row>;
}

export class FakePrismaUniqueError extends Error {
  code = 'P2002';
  constructor(model: string, field: string) {
    super(`Unique constraint failed on ${model}.${field}`);
    this.name = 'FakePrismaUniqueError';
  }
}

const OPERATOR_KEYS = new Set(['equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode']);

function comparable(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
}

function matchField(value: unknown, cond: unknown): boolean {
  if (!isPlainObject(cond) || !Object.keys(cond).some((k) => OPERATOR_KEYS.has(k))) {
    if (cond === null) return value === null || value === undefined;
    return comparable(value) === comparable(cond);
  }
  const insensitive = cond.mode === 'insensitive';
  const str = (v: unknown) => (insensitive ? String(v).toLowerCase() : String(v));
  for (const [op, arg] of Object.entries(cond)) {
    const a = comparable(arg);
    const v = comparable(value);
    switch (op) {
      case 'mode':
        break;
      case 'equals':
        if (!matchField(value, arg)) return false;
        break;
      case 'in':
        if (!(arg as unknown[]).map(comparable).includes(v)) return false;
        break;
      case 'notIn':
        if ((arg as unknown[]).map(comparable).includes(v)) return false;
        break;
      case 'not':
        if (matchField(value, arg)) return false;
        break;
      case 'lt':
        if (!(v !== null && v !== undefined && (v as number) < (a as number))) return false;
        break;
      case 'lte':
        if (!(v !== null && v !== undefined && (v as number) <= (a as number))) return false;
        break;
      case 'gt':
        if (!(v !== null && v !== undefined && (v as number) > (a as number))) return false;
        break;
      case 'gte':
        if (!(v !== null && v !== undefined && (v as number) >= (a as number))) return false;
        break;
      case 'contains':
        if (typeof value !== 'string' || !str(value).includes(str(arg))) return false;
        break;
      case 'startsWith':
        if (typeof value !== 'string' || !str(value).startsWith(str(arg))) return false;
        break;
      case 'endsWith':
        if (typeof value !== 'string' || !str(value).endsWith(str(arg))) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'AND') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matchesWhere(row, w as Where))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matchesWhere(row, w as Where))) return false;
      continue;
    }
    // Compound unique input, e.g. { brand_phoneE164: { brand, phoneE164 } }.
    if (key.includes('_') && isPlainObject(cond) && !(key in row) && Object.keys(cond).every((k) => !OPERATOR_KEYS.has(k))) {
      if (!matchesWhere(row, cond)) return false;
      continue;
    }
    if (!matchField(row[key], cond)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, 'asc' | 'desc'>[];
  return [...rows].sort((x, y) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const a = comparable(x[field]) as number | string | null | undefined;
        const b = comparable(y[field]) as number | string | null | undefined;
        if (a === b) continue;
        if (a === null || a === undefined) return dir === 'asc' ? -1 : 1;
        if (b === null || b === undefined) return dir === 'asc' ? 1 : -1;
        const cmp = a < b ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function project(row: Row | null, select: Record<string, unknown> | undefined): Row | null {
  if (!row) return null;
  const copy = { ...row };
  if (!select) return copy;
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = copy[k];
  return out;
}

/** Prisma.DbNull / Prisma.JsonNull: a database reads them back as null. */
function isPrismaNullSentinel(v: unknown): boolean {
  const name = (v as { constructor?: { name?: string } } | null)?.constructor?.name;
  return typeof v === 'object' && v !== null && (name === 'DbNull' || name === 'JsonNull');
}

function applyUpdate(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (isPrismaNullSentinel(v)) {
      row[k] = null;
    } else if (isPlainObject(v) && ('increment' in v || 'decrement' in v || 'set' in v || 'multiply' in v)) {
      const cur = Number(row[k] ?? 0);
      if ('set' in v) row[k] = v.set;
      else if ('increment' in v) row[k] = cur + Number(v.increment);
      else if ('decrement' in v) row[k] = cur - Number(v.decrement);
      else if ('multiply' in v) row[k] = cur * Number(v.multiply);
    } else if (v !== undefined) {
      row[k] = v;
    }
  }
}

export class FakePrismaNotFoundError extends Error {
  code = 'P2025';
  constructor(model: string) {
    super(`No ${model} record found`);
    this.name = 'FakePrismaNotFoundError';
  }
}

interface Args {
  where?: Where;
  data?: Row | Row[];
  select?: Record<string, unknown>;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  create?: Row;
  update?: Row;
}

interface DelegateConfig {
  timestampFields: string[];
  updatedAtFields: string[];
  uniqueFields: string[];
  failOn: Record<string, Error>;
  defaults: Row;
}

function createDelegate(name: string, tables: Map<string, Row[]>, config: DelegateConfig) {
  const { timestampFields, updatedAtFields, uniqueFields } = config;
  const guard = (method: string) => {
    const err = config.failOn[`${name}.${method}`];
    if (err) throw err;
  };
  const touch = (row: Row) => {
    for (const f of updatedAtFields) if (f in row || timestampFields.includes(f)) row[f] = new Date();
  };
  const duplicateOf = (data: Row): string | null => {
    for (const f of uniqueFields) {
      const v = data[f];
      if (v === undefined || v === null) continue;
      if (table().some((r) => comparable(r[f]) === comparable(v))) return f;
    }
    return null;
  };
  const table = () => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const query = (args: Args = {}) => {
    let rows = table().filter((r) => matchesWhere(r, args.where));
    rows = sortRows(rows, args.orderBy);
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = args.take >= 0 ? rows.slice(0, args.take) : rows.slice(args.take);
    return rows;
  };
  const insert = (data: Row) => {
    const dup = duplicateOf(data);
    if (dup) throw new FakePrismaUniqueError(name, dup);
    const row: Row = { id: crypto.randomUUID(), ...config.defaults, ...data };
    for (const f of timestampFields) if (row[f] === undefined) row[f] = new Date();
    table().push(row);
    return row;
  };
  return {
    findUnique: async (args: Args) => {
      guard('findUnique');
      return project(query(args)[0] ?? null, args.select);
    },
    findUniqueOrThrow: async (args: Args) => {
      guard('findUniqueOrThrow');
      const row = query(args)[0];
      if (!row) throw new FakePrismaNotFoundError(name);
      return project(row, args.select);
    },
    findFirst: async (args: Args = {}) => {
      guard('findFirst');
      return project(query(args)[0] ?? null, args.select);
    },
    findMany: async (args: Args = {}) => {
      guard('findMany');
      return query(args).map((r) => project(r, args.select)!);
    },
    count: async (args: Args = {}) => {
      guard('count');
      return query({ where: args.where }).length;
    },
    create: async (args: Args) => {
      guard('create');
      return project(insert(args.data as Row), args.select);
    },
    createMany: async (args: Args & { skipDuplicates?: boolean }) => {
      guard('createMany');
      const list = (Array.isArray(args.data) ? args.data : [args.data]) as Row[];
      let count = 0;
      for (const data of list) {
        if (args.skipDuplicates && duplicateOf(data)) continue;
        insert(data);
        count += 1;
      }
      return { count };
    },
    update: async (args: Args) => {
      guard('update');
      const row = query({ where: args.where })[0];
      if (!row) throw new FakePrismaNotFoundError(name);
      applyUpdate(row, args.data as Row);
      touch(row);
      return project(row, args.select);
    },
    updateMany: async (args: Args) => {
      guard('updateMany');
      const rows = query({ where: args.where });
      rows.forEach((r) => {
        applyUpdate(r, args.data as Row);
        touch(r);
      });
      return { count: rows.length };
    },
    upsert: async (args: Args) => {
      guard('upsert');
      const row = query({ where: args.where })[0];
      if (row) {
        applyUpdate(row, args.update ?? {});
        touch(row);
        return project(row, args.select);
      }
      return project(insert({ ...(args.create ?? {}) }), args.select);
    },
    delete: async (args: Args) => {
      guard('delete');
      const rows = table();
      const idx = rows.findIndex((r) => matchesWhere(r, args.where));
      if (idx === -1) throw new FakePrismaNotFoundError(name);
      const [removed] = rows.splice(idx, 1);
      return project(removed!, args.select);
    },
    deleteMany: async (args: Args = {}) => {
      guard('deleteMany');
      const rows = table();
      const keep = rows.filter((r) => !matchesWhere(r, args.where));
      const count = rows.length - keep.length;
      tables.set(name, keep);
      return { count };
    },
  };
}

export type FakeDelegate = ReturnType<typeof createDelegate>;

export interface FakePrisma {
  [model: string]: unknown;
  $sql: SqlRecorder;
  /** Live rows of one delegate (mutable; for assertions). */
  $rows(model: string): Row[];
  $transaction<T>(arg: ((tx: FakePrisma) => Promise<T>) | Promise<unknown>[]): Promise<T | unknown[]>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
}

/**
 * Create a fake client. Cast at the boundary: `const prisma = createFakePrisma() as unknown as typeof realPrisma`.
 */
export function createFakePrisma(options: FakePrismaOptions = {}): FakePrisma & Record<string, FakeDelegate> {
  const tables = new Map<string, Row[]>();
  for (const [model, rows] of Object.entries(options.seed ?? {})) tables.set(model, rows.map((r) => ({ ...r })));
  const timestampFields = options.timestampFields ?? ['createdAt', 'updatedAt'];
  const updatedAtFields = options.updatedAtFields ?? ['updatedAt'];
  const sql = createSqlRecorder(options.sql);
  const delegates = new Map<string, FakeDelegate>();

  const base: Record<string, unknown> = {
    $sql: sql,
    $rows: (model: string) => {
      if (!tables.has(model)) tables.set(model, []);
      return tables.get(model)!;
    },
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    ...sql.client,
  };

  const proxy: FakePrisma & Record<string, FakeDelegate> = new Proxy(base, {
    get(target, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined; // not a thenable
      if (prop === '$transaction') {
        return async (arg: unknown) => {
          if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(proxy);
          return Promise.all(arg as Promise<unknown>[]);
        };
      }
      if (prop in target) return target[prop];
      if (prop.startsWith('$')) return undefined;
      if (!delegates.has(prop)) {
        delegates.set(
          prop,
          createDelegate(prop, tables, {
            timestampFields,
            updatedAtFields,
            uniqueFields: options.uniqueFields?.[prop] ?? [],
            failOn: options.failOn ?? {},
            defaults: options.defaults?.[prop] ?? {},
          }),
        );
      }
      return delegates.get(prop);
    },
  }) as unknown as FakePrisma & Record<string, FakeDelegate>;
  return proxy;
}
