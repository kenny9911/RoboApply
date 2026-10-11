#!/usr/bin/env node
// scripts/tw-jobno-catalog.mjs — the 通俗職業 code / name pairs in saved
// 台灣就業通 open-data responses (MKT-3E, JT-4).
//
// The 小類 → role map (server/src/features/jobs/taxonomy/twJobno.json) may hold
// only (code, name) pairs that were read from the API's own fields; a code is
// never typed from memory (D3). This script is how the pairs are read:
//
//   1. save one or more responses by hand, OUTSIDE the repository
//      (GET <endpoint>?CITY=<code>&COUNT=1000&T=CSV, one county per file);
//   2. node scripts/tw-jobno-catalog.mjs <file.csv | directory> [...]
//
// It prints the distinct 大類 and 小類 pairs with their row counts, says for
// each 小類 whether the map already holds it (and under which role), and lists
// every disagreement between a saved response and the map (a code whose name
// changed). `--json` prints the same as one JSON document; `--unmapped` lists
// only the 小類 the map does not hold yet.
//
// Reads local files only: no network, no database. It prints codes, names and
// counts, never a posting field. Do not commit the CSV files (they hold real
// postings).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_PATH = join(HERE, '..', 'server', 'src', 'features', 'jobs', 'taxonomy', 'twJobno.json');

/** 'OCCU_DESC（職務名稱）' → 'OCCU_DESC': the ASCII part before the bracket. */
export function asciiHeader(header) {
  return String(header ?? '')
    .replace(/^﻿/, '')
    .split(/[（(]/)[0]
    .trim()
    .toUpperCase();
}

/** Rows of one saved CSV response, keyed by the ASCII part of each header. */
export function readRows(text) {
  return parse(text, { bom: true, columns: (headers) => headers.map(asciiHeader), relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
}

/** Distinct (code, name) pairs of the two classification levels, with counts. */
export function catalog(rows) {
  const major = new Map();
  const minor = new Map();
  const bump = (map, code, name) => {
    const c = String(code ?? '').normalize('NFKC').trim();
    const n = String(name ?? '').trim();
    if (!c) return;
    const key = `${c}\u0000${n}`;
    const hit = map.get(key);
    if (hit) hit.count += 1;
    else map.set(key, { code: c, name: n, count: 1 });
  };
  for (const row of rows) {
    bump(major, row.CJOB1_COUNT, row.CJOB_NAME1);
    bump(minor, row.CJOB2_COUNT, row.CJOB_NAME2);
  }
  const sorted = (map) => [...map.values()].sort((a, b) => a.code.localeCompare(b.code) || b.count - a.count);
  return { major: sorted(major), minor: sorted(minor) };
}

/** Compares a catalog with the committed map: which pairs it holds, which it lacks, which disagree. */
export function compareWithMap(found, map) {
  const majorByCode = new Map((map.major ?? []).map((m) => [m.code, m]));
  const minorByCode = new Map((map.minor ?? []).map((m) => [m.code, m]));
  const disagreements = [];
  for (const m of found.major) {
    const known = majorByCode.get(m.code);
    if (!known) disagreements.push({ level: 'major', code: m.code, response: m.name, map: null });
    else if (known.name !== m.name) disagreements.push({ level: 'major', code: m.code, response: m.name, map: known.name });
  }
  const minor = found.minor.map((m) => {
    const known = minorByCode.get(m.code);
    if (known && known.name !== m.name) disagreements.push({ level: 'minor', code: m.code, response: m.name, map: known.name });
    return { ...m, taxonomyId: known?.taxonomyId ?? null };
  });
  return { major: found.major, minor, disagreements };
}

function csvFiles(paths) {
  const out = [];
  for (const p of paths) {
    const full = resolve(p);
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full).sort()) if (name.toLowerCase().endsWith('.csv')) out.push(join(full, name));
    } else out.push(full);
  }
  return out;
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const paths = argv.filter((a) => !a.startsWith('--'));
  if (paths.length === 0 || flags.has('--help')) {
    console.log('Usage: node scripts/tw-jobno-catalog.mjs [--json] [--unmapped] <file.csv | directory> [...]');
    return paths.length === 0 && !flags.has('--help') ? 1 : 0;
  }
  const files = csvFiles(paths);
  if (files.length === 0) {
    console.error('No .csv file found.');
    return 1;
  }
  const rows = [];
  for (const file of files) rows.push(...readRows(readFileSync(file, 'utf8')));
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const result = compareWithMap(catalog(rows), map);
  const minor = flags.has('--unmapped') ? result.minor.filter((m) => !m.taxonomyId) : result.minor;

  if (flags.has('--json')) {
    console.log(JSON.stringify({ files: files.length, rows: rows.length, major: result.major, minor, disagreements: result.disagreements }, null, 2));
    return result.disagreements.length ? 2 : 0;
  }
  console.log(`${files.length} file(s), ${rows.length} rows, ${result.major.length} 大類, ${result.minor.length} 小類 (${result.minor.filter((m) => m.taxonomyId).length} mapped)`);
  console.log('\n大類 (code, name, rows)');
  for (const m of result.major) console.log(`  ${m.code}\t${m.name}\t${m.count}`);
  console.log(`\n小類 (code, name, rows, mapped role)${flags.has('--unmapped') ? ' — unmapped only' : ''}`);
  for (const m of minor) console.log(`  ${m.code}\t${m.name}\t${m.count}\t${m.taxonomyId ?? '-'}`);
  if (result.disagreements.length) {
    console.log('\nDISAGREEMENTS between the responses and twJobno.json (fix the map from the response, never the other way round)');
    for (const d of result.disagreements) console.log(`  ${d.level} ${d.code}\tresponse: ${d.response}\tmap: ${d.map ?? '(not listed)'}`);
    return 2;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
