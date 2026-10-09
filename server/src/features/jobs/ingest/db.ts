// server/src/features/jobs/ingest/db.ts — the typed database surface ingest uses (WP-16b).
//
// A structural Pick of the Prisma client, so tests pass `createFakePrisma()`
// (server/src/test/fakePrisma.ts) with its raw-SQL recorder. Typed delegates
// only (untyped client casts are banned in features/**).

import { randomBytes } from 'node:crypto';
import type prisma from '../../../lib/prisma.js';

export type IngestDb = Pick<
  typeof prisma,
  'rAJob' | 'rACompany' | 'rAIngestQuery' | 'rAProviderUsage' | 'rASearchProfile' | 'user' | 'rAH1bEmployerStat' | '$queryRaw' | '$executeRaw'
>;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
let counter = Math.floor(Math.random() * 1_679_616);

/**
 * A cuid-shaped id for rows created through raw SQL (Prisma's @default(cuid())
 * runs client-side, so raw INSERTs must bring their own). 25 lowercase
 * alphanumerics starting with 'c' and NO hyphen: public job URLs are
 * `<id>-<slug>` (TASK_PLAN.md R-05) and split on the first hyphen.
 */
export function newId(now: number = Date.now()): string {
  counter = (counter + 1) % 1_679_616;
  const time = now.toString(36).padStart(8, '0').slice(-8);
  const count = counter.toString(36).padStart(4, '0');
  const bytes = randomBytes(12);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 36];
  return `c${time}${count}${rand}`;
}

/** 'YYYY-MM-DD' (UTC) — RAProviderUsage.dayKey. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
