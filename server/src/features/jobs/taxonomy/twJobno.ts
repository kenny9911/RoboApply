// server/src/features/jobs/taxonomy/twJobno.ts — 通俗職業分類 → our role tree
// (MKT-3E, JT-4; MARKET_STRATEGY §2.5 "Role tree").
//
// 台灣就業通's open data classifies every vacancy with its own occupation
// codes: a 2-digit 大類 (CJOB1) and a 6-digit 小類 (CJOB2). A mapped 小類
// gives the row its role from the source's own code (provider fields first,
// §1.5), so the title needs no guessing; an unmapped code answers null and
// the title dictionary decides, exactly as before.
//
// D3: `twJobno.json` holds only (code, name) pairs read from the API's own
// fields: the 22 大類 as observed in live data and the 小類 that appear in the
// research note or in a recorded response. A code is never typed from memory.
// A 小類 whose name spans two of our roles (會計/出納/記帳人員, 飯店、餐廳主管)
// is left out on purpose: an honest unknown beats a wrong role.

import data from './twJobno.json' with { type: 'json' };
import { getTaxonomyNode } from './taxonomy.js';

export interface TwJobnoMajor {
  /** 2-digit 大類 code ('01' to '22'), the API's `jobno` prefix. */
  code: string;
  name: string;
  /** The closest Explore category (L1) of our tree, or null when the 大類 spans several. */
  categoryId: string | null;
}

export interface TwJobnoMinor {
  /** 6-digit 小類 code (CJOB2_COUNT). */
  code: string;
  name: string;
  /** A role (L3) id of the tree. */
  taxonomyId: string;
  /** Where the pair was read: the research note or a live API response. */
  seen?: string;
}

export interface TwJobnoData {
  version: number;
  asOf: string;
  source: { name: string; url: string; retrievedOn: string; notes?: string };
  major: TwJobnoMajor[];
  minor: TwJobnoMinor[];
}

const TABLE = data as TwJobnoData;

export const TW_JOBNO_VERSION = TABLE.version;
export const TW_JOBNO_SOURCE: Readonly<TwJobnoData['source']> = TABLE.source;
/** The 22 大類 in code order: the third level of the open-data sweep's split. */
export const TW_JOBNO_MAJORS: readonly TwJobnoMajor[] = TABLE.major;
export const TW_JOBNO_MINORS: readonly TwJobnoMinor[] = TABLE.minor;

const minorByCode = new Map<string, TwJobnoMinor>(TW_JOBNO_MINORS.map((m) => [m.code, m]));
const majorByCode = new Map<string, TwJobnoMajor>(TW_JOBNO_MAJORS.map((m) => [m.code, m]));

function digits(code: unknown): string {
  return typeof code === 'string' || typeof code === 'number' ? String(code).normalize('NFKC').trim() : '';
}

/** The role (L3) id of a mapped 6-digit 小類; null for an unmapped, malformed or missing code. */
export function twRoleForJobno(code: string | number | null | undefined): string | null {
  const key = digits(code);
  if (!/^\d{6}$/.test(key)) return null;
  const hit = minorByCode.get(key);
  // The file is validated by the test; the level check keeps a bad edit from ever naming a non-role.
  return hit && getTaxonomyNode(hit.taxonomyId)?.level === 3 ? hit.taxonomyId : null;
}

/** The Explore category (L1) of a 大類: by its 2-digit code or by any longer code that starts with it. Null when unmapped. */
export function twCategoryForMajor(code: string | number | null | undefined): string | null {
  const key = digits(code);
  if (!/^\d{2}(\d{2}){0,2}$/.test(key)) return null;
  return majorByCode.get(key.slice(0, 2))?.categoryId ?? null;
}

/** Structural problems of a 通俗職業 map (empty when valid). Used by the test. */
export function validateTwJobno(table: TwJobnoData = TABLE): string[] {
  const problems: string[] = [];
  for (const key of ['name', 'url', 'retrievedOn'] as const) {
    if (typeof table.source?.[key] !== 'string' || !table.source[key].trim()) problems.push(`source.${key} is empty`);
  }
  const majors = new Set<string>();
  for (const m of table.major ?? []) {
    if (!/^\d{2}$/.test(m.code)) problems.push(`major code ${m.code} is not two digits`);
    if (majors.has(m.code)) problems.push(`duplicate major code ${m.code}`);
    majors.add(m.code);
    if (!m.name?.trim()) problems.push(`major ${m.code} has no name`);
    if (m.categoryId !== null && getTaxonomyNode(m.categoryId)?.level !== 1) problems.push(`major ${m.code}: ${m.categoryId} is not a category of the tree`);
  }
  const minors = new Set<string>();
  for (const m of table.minor ?? []) {
    if (!/^\d{6}$/.test(m.code)) problems.push(`minor code ${m.code} is not six digits`);
    if (minors.has(m.code)) problems.push(`duplicate minor code ${m.code}`);
    minors.add(m.code);
    if (!m.name?.trim()) problems.push(`minor ${m.code} has no name`);
    if (!majors.has(m.code.slice(0, 2))) problems.push(`minor ${m.code}: its 大類 ${m.code.slice(0, 2)} is not listed`);
    if (getTaxonomyNode(m.taxonomyId)?.level !== 3) problems.push(`minor ${m.code}: ${m.taxonomyId} is not a role of the tree`);
  }
  return problems;
}
