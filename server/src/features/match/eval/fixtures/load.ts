// server/src/features/match/eval/fixtures/load.ts
//
// Read the committed fixtures by path, at run time, validated against
// fixtures/schema.ts. A missing file answers null (a suite then reports
// `no_fixture`); a file that is present and malformed throws, so a bad fixture
// can never be scored quietly.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  BaselinesFileSchema,
  FIXTURE_FILES,
  LabelsFileSchema,
  PersonasFileSchema,
  PostingsFileSchema,
  type BaselinesFile,
  type FixtureMarket,
  type LabelsFile,
  type Persona,
  type Posting,
} from './schema.js';

export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null;
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`fixture ${path.basename(file)} does not match its schema: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown issue'}`);
  }
  return parsed.data;
}

export function loadPersonas(market: FixtureMarket, dir: string = FIXTURES_DIR): Persona[] | null {
  return readJson(path.join(dir, FIXTURE_FILES.personas(market)), PersonasFileSchema)?.personas ?? null;
}

export function loadPostings(market: FixtureMarket, dir: string = FIXTURES_DIR): Posting[] | null {
  return readJson(path.join(dir, FIXTURE_FILES.postings(market)), PostingsFileSchema)?.postings ?? null;
}

export function loadLabels(market: FixtureMarket, dir: string = FIXTURES_DIR): LabelsFile | null {
  return readJson(path.join(dir, FIXTURE_FILES.labels(market)), LabelsFileSchema);
}

export function loadBaselines(dir: string = FIXTURES_DIR): BaselinesFile | null {
  return readJson(path.join(dir, FIXTURE_FILES.baselines), BaselinesFileSchema);
}

/** One hash over named file contents; the same for the generator's output and for the files on disk. */
export function hashFiles(files: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  for (const name of Object.keys(files).sort()) h.update(name).update('\0').update(files[name]!).update('\0');
  return h.digest('hex');
}

/** The hash of the six generated fixture files on disk (a missing file hashes as empty). */
export function fixtureFilesHash(dir: string = FIXTURES_DIR): string {
  const files: Record<string, string> = {};
  for (const market of ['intl', 'cn'] as const) {
    for (const name of [FIXTURE_FILES.personas(market), FIXTURE_FILES.postings(market), FIXTURE_FILES.labels(market)]) {
      const file = path.join(dir, name);
      files[name] = existsSync(file) ? readFileSync(file, 'utf8') : '';
    }
  }
  return hashFiles(files);
}

export interface MarketFixtures {
  market: FixtureMarket;
  personas: Persona[];
  postings: Posting[];
  labels: LabelsFile;
}

/** The three files of one market, or null when any of them is absent. */
export function loadMarketFixtures(market: FixtureMarket, dir: string = FIXTURES_DIR): MarketFixtures | null {
  const personas = loadPersonas(market, dir);
  const postings = loadPostings(market, dir);
  const labels = loadLabels(market, dir);
  if (!personas || !postings || !labels) return null;
  return { market, personas, postings, labels };
}
