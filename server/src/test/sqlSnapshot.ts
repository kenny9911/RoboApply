// server/src/test/sqlSnapshot.ts
//
// Records raw SQL sent through Prisma's `$queryRaw` / `$executeRaw` (tagged
// templates or `Prisma.sql` objects) and their `*Unsafe` variants, so tests can
// assert on the statement text (e.g. `FOR UPDATE SKIP LOCKED`) without a DB.
// FND-3 (queue lease) and FND-4 (credit reserve) build on it.
//
//   const sql = createSqlRecorder({ results: [[{ id: 'a' }]] });
//   const prisma = { ...sql.client };
//   await prisma.$queryRaw`SELECT * FROM "X" WHERE id = ${id}`;
//   sql.last()?.text   // 'SELECT * FROM "X" WHERE id = $1'
//   sql.last()?.values // [id]

export interface RecordedSql {
  method: '$queryRaw' | '$executeRaw' | '$queryRawUnsafe' | '$executeRawUnsafe';
  /** Statement with `$1..$n` placeholders, whitespace collapsed. */
  text: string;
  values: unknown[];
}

interface SqlLike {
  strings?: readonly string[];
  values?: readonly unknown[];
  sql?: string;
  text?: string;
}

/** Collapse runs of whitespace and trim, so indentation never breaks a snapshot. */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function joinTemplate(strings: readonly string[]): string {
  return strings.reduce((acc, part, i) => (i === 0 ? part : `${acc}$${i}${part}`), '');
}

/** Turn a tagged-template call or a Prisma.Sql object into text + values. */
export function toRecordedSql(method: RecordedSql['method'], first: unknown, rest: unknown[]): RecordedSql {
  if (typeof first === 'string') {
    return { method, text: normalizeSql(first), values: rest };
  }
  if (Array.isArray(first) && 'raw' in (first as object)) {
    return { method, text: normalizeSql(joinTemplate(first as readonly string[])), values: rest };
  }
  const obj = (first ?? {}) as SqlLike;
  if (obj.strings) {
    return { method, text: normalizeSql(joinTemplate(obj.strings)), values: [...(obj.values ?? [])] };
  }
  return { method, text: normalizeSql(obj.text ?? obj.sql ?? ''), values: [...(obj.values ?? [])] };
}

export interface SqlRecorderOptions {
  /** Results returned in order by each call; when exhausted, `defaultResult`. */
  results?: unknown[];
  defaultResult?: unknown;
  /**
   * Dynamic responder (FND-3): called for every statement after the queued
   * `results` run out; return `undefined` to fall back to `defaultResult`.
   * Throwing simulates a database error.
   */
  respond?: (call: RecordedSql, index: number) => unknown;
}

export interface SqlRecorder {
  calls: RecordedSql[];
  client: {
    $queryRaw: (first: unknown, ...rest: unknown[]) => Promise<unknown>;
    $executeRaw: (first: unknown, ...rest: unknown[]) => Promise<unknown>;
    $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
    $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
  };
  last(): RecordedSql | undefined;
  /** Every recorded statement text, in order. */
  texts(): string[];
  reset(): void;
}

export function createSqlRecorder(options: SqlRecorderOptions = {}): SqlRecorder {
  const calls: RecordedSql[] = [];
  const queue = [...(options.results ?? [])];
  const next = (method: RecordedSql['method'], call: RecordedSql) => {
    if (queue.length > 0) return queue.shift();
    if (options.respond) {
      const r = options.respond(call, calls.length - 1);
      if (r !== undefined) return r;
    }
    if ('defaultResult' in options) return options.defaultResult;
    return method.startsWith('$execute') ? 0 : [];
  };
  const record = (method: RecordedSql['method']) => async (first: unknown, ...rest: unknown[]) => {
    const call = toRecordedSql(method, first, rest);
    calls.push(call);
    return next(method, call);
  };
  return {
    calls,
    client: {
      $queryRaw: record('$queryRaw'),
      $executeRaw: record('$executeRaw'),
      $queryRawUnsafe: record('$queryRawUnsafe') as (sql: string, ...values: unknown[]) => Promise<unknown>,
      $executeRawUnsafe: record('$executeRawUnsafe') as (sql: string, ...values: unknown[]) => Promise<unknown>,
    },
    last: () => calls[calls.length - 1],
    texts: () => calls.map((c) => c.text),
    reset: () => {
      calls.length = 0;
    },
  };
}
