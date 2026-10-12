// server/src/features/retrieval/testkit.ts — fixtures and fakes for the retrieval tests (no vitest import).
//
// SYNTHETIC: every posting, person and vector here is made up for the tests.

import type { Prisma } from '../../generated/prisma/client.js';
import type { EmbedOptions, EmbedResult } from '../../platform/embeddings/index.js';
import type { IndexJobRow } from './jobText.js';
import type { RetrievalDb } from './repo.js';

export function indexJob(overrides: Partial<IndexJobRow> = {}): IndexJobRow {
  return {
    id: 'job_1',
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    title: 'Senior Backend Engineer',
    primaryTaxonomyId: 'backend_engineer',
    seniority: 'senior',
    skills: ['Go', 'PostgreSQL', 'Kubernetes', 'Communication'],
    skillsDetail: [
      { skill: 'Go', required: true },
      { skill: 'PostgreSQL', required: true },
      { skill: 'Kubernetes', required: false },
      { skill: 'Communication', required: true, kind: 'soft' },
    ],
    skillIds: [],
    summary: 'Build payment services for a growing fintech. Own the ledger and its APIs.',
    qualifications: 'Five years of backend work. Strong Go. Experience with relational databases and distributed systems.',
    descriptionPlain: 'About us: we are a friendly company. Benefits: free lunch, gym membership and unlimited vacation. Equal opportunity employer.',
    archivedAt: null,
    ...overrides,
  };
}

/** A 1024-number vector whose values depend on `seed`. */
export function vector(seed = 1, length = 1024): number[] {
  return Array.from({ length }, (_, i) => Math.round((((seed * 31 + i * 7) % 200) - 100) / 100 * 1000) / 1000);
}

export interface RecordedSql {
  kind: 'query' | 'execute';
  /** The statement with $1… placeholders, whitespace collapsed. */
  text: string;
  values: unknown[];
}

/** A database double that records every raw statement and answers queries from `respond`. */
export function fakeDb(options: { respond?: (sql: RecordedSql) => unknown; jobs?: IndexJobRow[]; config?: Record<string, string> } = {}) {
  const statements: RecordedSql[] = [];
  const config = new Map(Object.entries(options.config ?? {}));
  const record = (kind: RecordedSql['kind'], query: Prisma.Sql): RecordedSql => {
    const entry = { kind, text: query.text.replace(/\s+/g, ' ').trim(), values: [...query.values] };
    statements.push(entry);
    return entry;
  };
  const db: RetrievalDb = {
    async $queryRaw<T>(query: Prisma.Sql): Promise<T> {
      const entry = record('query', query);
      return (options.respond?.(entry) ?? []) as T;
    },
    async $executeRaw(query: Prisma.Sql): Promise<number> {
      const entry = record('execute', query);
      const out = options.respond?.(entry);
      return typeof out === 'number' ? out : 1;
    },
    rAJob: {
      async findMany(args) {
        const ids = new Set(args.where.id.in);
        return (options.jobs ?? []).filter((j) => ids.has(j.id));
      },
    },
    appConfig: {
      async findUnique(args) {
        const value = config.get(args.where.key);
        return value === undefined ? null : { value };
      },
      async upsert(args) {
        config.set(args.where.key, args.create.value);
        return {};
      },
    },
  };
  return { db, statements, config };
}

/** An embeddings double: one vector per text, or the given answer. */
export function fakeEmbed(answer?: EmbedResult | ((texts: readonly string[]) => EmbedResult), model = 'openai/text-embedding-3-small@1024') {
  const calls: Array<{ brand: string; texts: string[]; options: EmbedOptions }> = [];
  const embed = async (brand: string, texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> => {
    calls.push({ brand, texts: [...texts], options });
    if (typeof answer === 'function') return answer(texts);
    if (answer) return answer;
    return { vectors: texts.map((_, i) => vector(i + 1)), model, tokens: texts.length * 100 };
  };
  return { embed, calls };
}
