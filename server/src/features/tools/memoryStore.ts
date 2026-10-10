// server/src/features/tools/memoryStore.ts
//
// In-memory twins of the tools store and the rate-counter reader, for tests
// (WP-57). No vitest imports; compiles with the server.

import type { RateCounterReader, ToolResultRow, ToolsStore } from './store.js';

export interface MemoryAliasRow {
  brand: string;
  tokenHash: string;
  of: string;
  expiresAt: Date;
}

export interface MemoryToolsStore extends ToolsStore {
  rows: ToolResultRow[];
  aliases: MemoryAliasRow[];
}

export function createMemoryToolsStore(): MemoryToolsStore {
  const rows: ToolResultRow[] = [];
  const aliases: MemoryAliasRow[] = [];
  let seq = 0;
  const hashTaken = (h: string) => rows.some((r) => r.tokenHash === h) || aliases.some((a) => a.tokenHash === h);
  const clone = (r: ToolResultRow): ToolResultRow => structuredClone(r);
  const byId = (id: string) => rows.find((r) => r.id === id);
  return {
    rows,
    aliases,
    async findByCacheKey(brand, cacheKey, now) {
      const hit = rows
        .filter((r) => r.brand === brand && !r.consumedAt && r.expiresAt.getTime() > now.getTime() && r.payload.cacheKey === cacheKey)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return hit ? clone(hit) : null;
    },
    async findByTokenHash(brand, tokenHash) {
      const own = rows.find((r) => r.tokenHash === tokenHash);
      const alias = own ? null : aliases.find((a) => a.tokenHash === tokenHash);
      const hit = own ?? (alias ? byId(alias.of) : undefined);
      return hit && hit.brand === brand && (!alias || alias.brand === brand) ? clone(hit) : null;
    },
    async create(input) {
      if (hashTaken(input.tokenHash)) throw new Error('unique tokenHash');
      seq += 1;
      const row: ToolResultRow = {
        id: `tr_${seq}`,
        brand: input.brand,
        tokenHash: input.tokenHash,
        payload: structuredClone(input.payload),
        userId: null,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: new Date(input.expiresAt.getTime() - 24 * 3600_000),
      };
      rows.push(row);
      return clone(row);
    },
    async addTokenAlias(row, tokenHash) {
      if (hashTaken(tokenHash)) throw new Error('unique tokenHash');
      aliases.push({ brand: row.brand, tokenHash, of: row.id, expiresAt: row.expiresAt });
    },
    async markClaimed(id, userId, now) {
      const r = byId(id);
      if (!r || r.consumedAt) return false;
      r.consumedAt = now;
      r.userId = userId;
      return true;
    },
    async unclaim(id) {
      const r = byId(id);
      if (r) {
        r.consumedAt = null;
        r.userId = null;
      }
    },
    async savePayload(id, payload) {
      const r = byId(id);
      if (r) r.payload = structuredClone(payload);
    },
    async purgeExpired(brand, now) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.brand === brand && rows[i]!.expiresAt.getTime() <= now.getTime()) {
          rows.splice(i, 1);
          n += 1;
        }
      }
      for (let i = aliases.length - 1; i >= 0; i -= 1) {
        if (aliases[i]!.brand === brand && aliases[i]!.expiresAt.getTime() <= now.getTime()) {
          aliases.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },
  };
}

/** Counter reader over a plain map `key|windowStartISO → count`. */
export function createMemoryRateReader(counts: Map<string, number> = new Map()): RateCounterReader & { counts_: Map<string, number> } {
  return {
    counts_: counts,
    async counts(windows) {
      return windows.map((w) => counts.get(`${w.key}|${w.windowStart.toISOString()}`) ?? 0);
    },
  };
}
