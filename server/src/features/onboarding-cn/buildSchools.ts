// server/src/features/onboarding-cn/buildSchools.ts — import the full MOE school list into data/schools.json.
//
//   npx tsx server/src/features/onboarding-cn/buildSchools.ts <moe-list.csv> --as-of 2025-06-20
//
// Input: the Ministry of Education's 全国高等学校名单 saved as CSV (UTF-8),
// columns 序号,学校名称,学校标识码,主管部门,所在地,办学层次,备注, with the
// province header rows ("北京市（92所）") as published. Existing entries keep
// their official 985 / 211 / 双一流 marks; new schools get none (never guessed).
// Offline only: nothing imports this file and it makes no network call.
// After checking the marks against the official lists, set `verified: true`
// and `asOf` (the lists' publication date) at the top of schools.json by hand.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CnSchool } from './contract.js';
import { schoolKey } from './data.js';

export interface MoeRow {
  name: string;
  code: string | null;
  province: string;
}

const PROVINCE_HEADER = /^(.+?)(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区)?（\d+所）$/;

function shortProvince(raw: string): string {
  return raw.replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/, '');
}

/** Parse the CSV text into rows (province taken from the latest header row). */
export function parseMoeCsv(text: string): MoeRow[] {
  const rows: MoeRow[] = [];
  let province = '';
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const header = cells.find((c) => PROVINCE_HEADER.test(c));
    if (header && !cells[1]) {
      province = shortProvince(header.replace(/（\d+所）$/, ''));
      continue;
    }
    const [seq, name, code] = cells;
    if (!seq || !/^\d+$/.test(seq) || !name) continue;
    rows.push({ name, code: code && /^\d{10}$/.test(code) ? code : null, province });
  }
  return rows;
}

/** Merge MOE rows into the listed schools; marks come only from the existing official lists. */
export function mergeMoeRows(existing: readonly CnSchool[], rows: readonly MoeRow[]): Array<CnSchool & { moeCode?: string }> {
  const byKey = new Map(existing.map((s) => [schoolKey(s.name), { ...s } as CnSchool & { moeCode?: string }]));
  for (const r of rows) {
    const key = schoolKey(r.name);
    const hit = byKey.get(key);
    if (hit) {
      if (r.code) hit.moeCode = r.code;
      continue;
    }
    byKey.set(key, { id: r.name, name: r.name, province: r.province, tags: [], ...(r.code ? { moeCode: r.code } : {}) });
  }
  return [...byKey.values()];
}

function main(argv: string[]): void {
  const file = argv[0];
  const asOfAt = argv.indexOf('--as-of');
  const asOf = asOfAt >= 0 ? argv[asOfAt + 1] : null;
  if (!file || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    console.error('usage: buildSchools.ts <moe-list.csv> --as-of YYYY-MM-DD');
    process.exit(2);
  }
  const target = join(dirname(fileURLToPath(import.meta.url)), 'data', 'schools.json');
  const data = JSON.parse(readFileSync(target, 'utf8')) as { schools: CnSchool[]; fullMoeList: Record<string, unknown>; coverage: string };
  const rows = parseMoeCsv(readFileSync(file, 'utf8'));
  const merged = mergeMoeRows(data.schools, rows);
  const out = {
    ...data,
    // The MOE rows come from the official file; the 985/211/双一流 marks keep
    // their own `verified` state (top level), which this script never sets.
    coverage: `The MOE 全国高等学校名单 (${asOf}) plus the 985, 211 and second-round 双一流 marks${(data as { verified?: boolean }).verified ? '' : ' (marks not yet checked against the official lists)'}.`,
    fullMoeList: { ...data.fullMoeList, imported: true, asOf, rows: rows.length },
    schools: merged,
  };
  writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
  console.log(`schools.json: ${merged.length} schools (${rows.length} MOE rows, as of ${asOf}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
