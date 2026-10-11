// server/src/features/match/eval/live/audit.ts
//
// The recruiter audit of the LLM judge (strategy 2.6): a 10% sample of the
// judged pairs of every market goes to RoboHire and GoHire recruiters as a CSV
// with an empty grade column; their grades come back, and the
// quadratic-weighted kappa of judge against human decides whether judge-based
// metrics may be trusted (0.6 or better on at least JUDGE_TRUST_MIN_PAIRS
// graded pairs). Until an audit says so, every judge-based metric prints
// `untrusted`.
//
// An audit is of ONE judge: the key and the stored result record the judge
// model, the prompt version and the market of every sampled pair. A value
// graded by another model, under another prompt version, or for a market the
// audit holds no pair of, stays untrusted (gates.ts `judgeDistrust`).
//
// The recruiter sees what the judge saw: the persona's summary and resume and
// the posting's title and text. The CSV never shows the judge's grade (the
// audit is blind). The judge's grades of the sample stay in `audit.key.json`
// next to it; both live under eval/.snapshots/ and are never committed.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JUDGE_TRUST_MIN_KAPPA, JUDGE_TRUST_MIN_PAIRS, judgeDistrust } from '../gates.js';
import { weightedKappa } from '../metrics.js';

export const AUDIT_SHARE = 0.1;
export const AUDIT_CSV = 'audit.sample.csv';
export const AUDIT_KEY = 'audit.key.json';
export const AUDIT_RESULT = 'audit.json';
export const AUDIT_COLUMNS = ['pair_id', 'persona_id', 'posting_id', 'persona_summary', 'persona_resume', 'posting_title', 'posting_text', 'human_grade_0_to_3'] as const;

export interface AuditPair {
  personaId: string;
  postingId: string;
  /** The market the pair was judged in (`intl`, `cn`). */
  market: string;
  judgeGrade: number;
  personaSummary: string;
  /** The synthetic resume the judge graded on. */
  personaResume: string;
  postingTitle: string;
  postingText: string;
}

/**
 * A stable 32-bit hash for deterministic samples: FNV-1a, then an avalanche
 * step. Without the last step ids that differ only at the end ("p01::job-1",
 * "p01::job-2") sort next to each other and a sample clusters on a few
 * personas.
 */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const pairId = (p: Pick<AuditPair, 'personaId' | 'postingId'>): string => `${p.personaId}::${p.postingId}`;

/** The pairs in a fixed pseudo-random order: by the hash of their id, then by the id. */
export function byPairHash<T extends Pick<AuditPair, 'personaId' | 'postingId'>>(pairs: readonly T[]): T[] {
  return [...pairs].sort((a, b) => hash32(pairId(a)) - hash32(pairId(b)) || pairId(a).localeCompare(pairId(b)));
}

/**
 * A deterministic sample of about `share` of the pairs of every market (at
 * least one per market that has any): the same pairs every time, and no market
 * of the run left out.
 */
export function auditSample<T extends Pick<AuditPair, 'personaId' | 'postingId'> & { market?: string }>(pairs: readonly T[], share: number = AUDIT_SHARE): T[] {
  const byMarket = new Map<string, T[]>();
  for (const p of pairs) byMarket.set(p.market ?? '', [...(byMarket.get(p.market ?? '') ?? []), p]);
  const out: T[] = [];
  for (const market of [...byMarket.keys()].sort()) {
    const list = byMarket.get(market)!;
    out.push(...byPairHash(list).slice(0, Math.max(1, Math.round(list.length * share))));
  }
  return out;
}

/**
 * One CSV cell. A cell that starts with = + - @ (or a tab or a return) is read
 * as a formula by Excel and WPS: posting text often starts with "- " or "+",
 * and third-party text must never be evaluated. Such a cell gets a leading
 * apostrophe, which a spreadsheet shows as plain text.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function auditCsv(sample: readonly AuditPair[]): string {
  const lines = [AUDIT_COLUMNS.join(',')];
  for (const p of sample) lines.push([pairId(p), p.personaId, p.postingId, p.personaSummary, p.personaResume, p.postingTitle, p.postingText, ''].map(cell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** RFC 4180 rows: quoted cells may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cur);
      cur = '';
      rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export interface HumanGrade {
  pairId: string;
  /** Null when the recruiter left the cell empty or wrote something that is not 0-3. */
  grade: number | null;
}

export function parseAuditCsv(text: string): HumanGrade[] {
  const rows = parseCsv(text);
  const head = rows[0] ?? [];
  const idCol = head.indexOf('pair_id');
  const gradeCol = head.indexOf('human_grade_0_to_3');
  if (idCol < 0 || gradeCol < 0) throw new Error(`audit CSV: the columns pair_id and human_grade_0_to_3 are required (found: ${head.join(', ') || 'none'})`);
  return rows.slice(1).map((r) => {
    // A spreadsheet may keep the apostrophe of a text cell, or put one before a digit.
    const raw = (r[gradeCol] ?? '').trim().replace(/^'/, '');
    const n = /^[0-3]$/.test(raw) ? Number(raw) : null;
    return { pairId: (r[idCol] ?? '').replace(/^'(?=[=+\-@\t\r])/, ''), grade: n };
  });
}

/** `audit.key.json`: the judge's grades of the sample and which judge gave them. Never shown to the recruiters. */
export interface AuditKey {
  judgeModel: string;
  promptVersion: string;
  pairs: Record<string, { grade: number; market: string }>;
}

function readKey(file: string): AuditKey {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AuditKey> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.judgeModel !== 'string' || typeof raw.promptVersion !== 'string' || !raw.pairs || typeof raw.pairs !== 'object') {
    throw new Error(`${path.basename(file)} does not say which judge model and prompt version gave its grades: export the audit sample again (--live --export-audit)`);
  }
  return { judgeModel: raw.judgeModel, promptVersion: raw.promptVersion, pairs: raw.pairs };
}

/** Write the blind CSV and its key. Answers the CSV path. */
export function exportAudit(input: { pairs: readonly AuditPair[]; dir: string; judgeModel: string; promptVersion: string; share?: number }): { csvFile: string; keyFile: string; sampled: number; markets: Record<string, number> } {
  const sample = auditSample(input.pairs, input.share);
  mkdirSync(input.dir, { recursive: true });
  const csvFile = path.join(input.dir, AUDIT_CSV);
  const keyFile = path.join(input.dir, AUDIT_KEY);
  const key: AuditKey = { judgeModel: input.judgeModel, promptVersion: input.promptVersion, pairs: Object.fromEntries(sample.map((p) => [pairId(p), { grade: p.judgeGrade, market: p.market }])) };
  const markets: Record<string, number> = {};
  for (const p of sample) markets[p.market] = (markets[p.market] ?? 0) + 1;
  writeFileSync(csvFile, auditCsv(sample));
  writeFileSync(keyFile, `${JSON.stringify(key, null, 2)}\n`);
  return { csvFile, keyFile, sampled: sample.length, markets };
}

export interface AuditResult {
  /** Quadratic-weighted kappa of judge against human over the graded pairs; null when it cannot be computed. */
  kappa: number | null;
  pairs: number;
  /** Rows of the CSV with no usable grade. */
  ungraded: number;
  /** The judge whose grades were audited. */
  judgeModel: string;
  promptVersion: string;
  /** Graded pairs per market. */
  markets: Record<string, number>;
  /** True when the agreement is enough: this judge's values in those markets are trusted. */
  trusted: boolean;
  /** Why not, in words; null when trusted. */
  distrust: string | null;
  threshold: number;
  minPairs: number;
  importedAt: string;
  source: string;
}

export function auditKappa(key: Record<string, number>, human: readonly HumanGrade[]): { kappa: number | null; pairs: number; ungraded: number; graded: string[] } {
  const judge: number[] = [];
  const person: number[] = [];
  const graded: string[] = [];
  let ungraded = 0;
  for (const h of human) {
    const j = key[h.pairId];
    if (h.grade === null || typeof j !== 'number') {
      ungraded += 1;
      continue;
    }
    judge.push(j);
    person.push(h.grade);
    graded.push(h.pairId);
  }
  return { kappa: weightedKappa(judge, person, [0, 1, 2, 3]), pairs: judge.length, ungraded, graded };
}

/**
 * Read the recruiters' CSV back, compare with the judge's grades of the same
 * pairs (the key written at export, beside the CSV or in the snapshots
 * folder) and store `<snapshotsDir>/audit.json`.
 */
export function importAudit(input: { csvFile: string; snapshotsDir: string; now: Date; keyFile?: string }): AuditResult {
  if (!existsSync(input.csvFile)) throw new Error(`audit CSV not found: ${input.csvFile}`);
  // The key is written next to the exported CSV, in the dated folder of that run: look beside the file that came back, then in the newest run.
  const dated = existsSync(input.snapshotsDir)
    ? readdirSync(input.snapshotsDir)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()
        .map((d) => path.join(input.snapshotsDir, d, AUDIT_KEY))
    : [];
  const keyFile = [input.keyFile, path.join(path.dirname(input.csvFile), AUDIT_KEY), path.join(input.snapshotsDir, AUDIT_KEY), ...dated].find((f): f is string => !!f && existsSync(f));
  if (!keyFile) throw new Error(`the judge's grades of the audit sample (${AUDIT_KEY}) were not found beside the CSV or in ${input.snapshotsDir}`);
  const key = readKey(keyFile);
  const k = auditKappa(Object.fromEntries(Object.entries(key.pairs).map(([id, v]) => [id, v.grade])), parseAuditCsv(readFileSync(input.csvFile, 'utf8')));
  const markets: Record<string, number> = {};
  for (const id of k.graded) {
    const m = key.pairs[id]!.market;
    markets[m] = (markets[m] ?? 0) + 1;
  }
  const distrust = judgeDistrust({ kappa: k.kappa, pairs: k.pairs });
  const result: AuditResult = {
    kappa: k.kappa,
    pairs: k.pairs,
    ungraded: k.ungraded,
    judgeModel: key.judgeModel,
    promptVersion: key.promptVersion,
    markets,
    trusted: distrust === null,
    distrust,
    threshold: JUDGE_TRUST_MIN_KAPPA,
    minPairs: JUDGE_TRUST_MIN_PAIRS,
    importedAt: input.now.toISOString(),
    source: path.basename(input.csvFile),
  };
  mkdirSync(input.snapshotsDir, { recursive: true });
  writeFileSync(path.join(input.snapshotsDir, AUDIT_RESULT), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
