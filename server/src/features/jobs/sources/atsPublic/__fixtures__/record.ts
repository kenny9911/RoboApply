// server/src/features/jobs/sources/atsPublic/__fixtures__/record.ts — records
// one real response per public ATS API into `<vendor>.recorded.json`, for the
// recorded-fixture contract tests in ../atsPublic.test.ts (WP-42).
//
// Run by OPS / INT on a machine with network access (tests never do):
//
//   npx tsx server/src/features/jobs/sources/atsPublic/__fixtures__/record.ts \
//     --greenhouse <boardToken> --lever <site> --ashby <org> --smartrecruiters <companyId>
//
// Any subset of vendors may be given. Requests go through ../http.ts, so only
// the four documented API hosts are reachable and redirects are refused. Each
// recording keeps the vendor's full response structure but only the first
// MAX_KEPT postings, and `recorded-meta.json` notes the endpoint and the date.
// Pick public boards whose postings may be stored in the repo, or replace the
// posting text before committing (keep every key and value type as recorded).

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getJson } from '../http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_KEPT = 3;
const enc = encodeURIComponent;

export const RECORDED_VENDORS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;
export type RecordedVendor = (typeof RECORDED_VENDORS)[number];

export interface RecordedMeta {
  endpoint: string;
  boardToken: string;
  recordedAt: string;
  postingsListed: number;
  postingsKept: number;
}

const trimArray = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_KEPT) : []);

async function record(vendor: RecordedVendor, token: string): Promise<{ body: unknown; meta: Omit<RecordedMeta, 'recordedAt'> }> {
  switch (vendor) {
    case 'greenhouse': {
      const endpoint = `https://boards-api.greenhouse.io/v1/boards/${enc(token)}/jobs?content=true`;
      const body = (await getJson(endpoint)) as { jobs?: unknown[] };
      const listed = body.jobs?.length ?? 0;
      return { body: { ...body, jobs: trimArray(body.jobs) }, meta: { endpoint, boardToken: token, postingsListed: listed, postingsKept: Math.min(listed, MAX_KEPT) } };
    }
    case 'lever': {
      const endpoint = `https://api.lever.co/v0/postings/${enc(token)}?mode=json&skip=0&limit=100`;
      const body = await getJson(endpoint);
      const listed = Array.isArray(body) ? body.length : 0;
      return { body: trimArray(body), meta: { endpoint, boardToken: token, postingsListed: listed, postingsKept: Math.min(listed, MAX_KEPT) } };
    }
    case 'ashby': {
      const endpoint = `https://api.ashbyhq.com/posting-api/job-board/${enc(token)}?includeCompensation=true`;
      const body = (await getJson(endpoint)) as { jobs?: unknown[] };
      const listed = body.jobs?.length ?? 0;
      return { body: { ...body, jobs: trimArray(body.jobs) }, meta: { endpoint, boardToken: token, postingsListed: listed, postingsKept: Math.min(listed, MAX_KEPT) } };
    }
    case 'smartrecruiters': {
      const endpoint = `https://api.smartrecruiters.com/v1/companies/${enc(token)}/postings?limit=100&offset=0`;
      const list = (await getJson(endpoint)) as { content?: unknown[] };
      const kept = trimArray(list.content);
      const details: Record<string, unknown> = {};
      for (const row of kept) {
        const id = (row as { id?: unknown })?.id;
        if (typeof id !== 'string') continue;
        details[id] = await getJson(`https://api.smartrecruiters.com/v1/companies/${enc(token)}/postings/${enc(id)}`);
      }
      const listed = list.content?.length ?? 0;
      return {
        body: { list: { ...list, content: kept, totalFound: kept.length }, details },
        meta: { endpoint, boardToken: token, postingsListed: listed, postingsKept: kept.length },
      };
    }
  }
}

export async function recordFixtures(tokens: Partial<Record<RecordedVendor, string>>, now: Date = new Date()): Promise<RecordedVendor[]> {
  const metaPath = join(HERE, 'recorded-meta.json');
  const allMeta: Record<string, RecordedMeta> = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, RecordedMeta>) : {};
  const done: RecordedVendor[] = [];
  for (const vendor of RECORDED_VENDORS) {
    const token = tokens[vendor];
    if (!token) continue;
    const { body, meta } = await record(vendor, token);
    writeFileSync(join(HERE, `${vendor}.recorded.json`), `${JSON.stringify(body, null, 2)}\n`);
    allMeta[vendor] = { ...meta, recordedAt: now.toISOString() };
    done.push(vendor);
  }
  writeFileSync(metaPath, `${JSON.stringify(allMeta, null, 2)}\n`);
  return done;
}

function parseArgs(argv: readonly string[]): Partial<Record<RecordedVendor, string>> {
  const out: Partial<Record<RecordedVendor, string>> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!.replace(/^--/, '') as RecordedVendor;
    const value = argv[i + 1];
    if ((RECORDED_VENDORS as readonly string[]).includes(key) && value && !value.startsWith('--')) {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tokens = parseArgs(process.argv.slice(2));
  if (Object.keys(tokens).length === 0) {
    console.error('Usage: record.ts --greenhouse <token> --lever <site> --ashby <org> --smartrecruiters <companyId>');
    process.exit(2);
  }
  recordFixtures(tokens)
    .then((done) => console.log(`Recorded: ${done.join(', ')}`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
