#!/usr/bin/env node
// scripts/check-api-boundary.mjs — keep API access behind its modules
// (AGENTS.md "Keep frontend API access behind modules in lib/api/";
// ARCHITECTURE.md §10.1.4; TASK_PLAN.md §2.1 rule 5).
//
// Fails on:
//   1. a raw `/api/v1/` string literal (quotes or template) in app/,
//      components/, hooks/ or lib/ outside `lib/api/**` and
//      `lib/server/publicApi.ts` — components call an area wrapper instead;
//   2. `prisma as any` in server/src/features/** or server/src/platform/**
//      (typed Prisma only in new code).
// Comments are ignored (a comment may name a path). Tests are not scanned.
//
// Today's offenders are recorded in scripts/api-boundary-baseline.json with
// the WP that removes them; the gate fails only on NEW offenders (a file not
// in the baseline, or more literals than its baseline count). When a WP
// removes an offender, it deletes the baseline row in the same change.
//
//   npm run check:api-boundary          (`--root <dir>` checks another tree)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB_DIRS = ['app', 'components', 'hooks', 'lib'];
export const SERVER_DIRS = ['server/src/features', 'server/src/platform'];
export const ALLOWED_PREFIXES = ['lib/api/'];
export const ALLOWED_FILES = ['lib/server/publicApi.ts'];
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.has(extname(full)) && !/\.(test|spec)\.[jt]sx?$/.test(full) && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Split source into code with comments blanked (strings kept), and the list
 * of string literals with their line numbers. A small scanner: handles
 * '…', "…", `…` (including `${…}` nesting), // and block comments, and
 * regex literals well enough not to mistake `/\/api\/v1\//` for a comment.
 */
export function scan(src) {
  const strings = [];
  let code = '';
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (ch) => {
    code += ch;
    if (ch === '\n') line++;
  };
  let lastSignificant = '';
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        code += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      code += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      code += '  ';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const startLine = line;
      let text = '';
      push(ch);
      i++;
      let depth = 0;
      while (i < n) {
        const c = src[i];
        if (c === '\\') {
          text += c + (src[i + 1] ?? '');
          push(c);
          if (i + 1 < n) push(src[i + 1]);
          i += 2;
          continue;
        }
        if (quote === '`' && c === '$' && src[i + 1] === '{') depth++;
        else if (quote === '`' && c === '}' && depth > 0) depth--;
        else if (c === quote && depth === 0) break;
        if (c === '\n' && quote !== '`') break;
        text += c;
        push(c);
        i++;
      }
      push(quote);
      i++;
      strings.push({ text, line: startLine });
      lastSignificant = quote;
      continue;
    }
    if (ch === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(lastSignificant)) {
      // A regex literal: copy it verbatim, it is neither a comment nor a string.
      push(ch);
      i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const c = src[i];
        push(c);
        i++;
        if (c === '\\') {
          if (i < n) push(src[i++]);
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      lastSignificant = '/';
      continue;
    }
    push(ch);
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }
  return { code, strings };
}

const toPosix = (p) => p.split(sep).join('/');

export function isAllowedApiFile(rel) {
  return ALLOWED_PREFIXES.some((p) => rel.startsWith(p)) || ALLOWED_FILES.includes(rel);
}

/** Current offenders: `{ apiLiterals: Map<file, lines[]>, prismaAsAny: Map<file, lines[]> }`. */
export function findOffenders(root) {
  const apiLiterals = new Map();
  const prismaAsAny = new Map();
  for (const dir of WEB_DIRS) {
    for (const abs of walk(join(root, dir))) {
      const rel = toPosix(relative(root, abs));
      if (isAllowedApiFile(rel)) continue;
      const { strings } = scan(readFileSync(abs, 'utf8'));
      const lines = strings.filter((s) => s.text.includes('/api/v1/')).map((s) => s.line);
      if (lines.length) apiLiterals.set(rel, lines);
    }
  }
  for (const dir of SERVER_DIRS) {
    for (const abs of walk(join(root, dir))) {
      const rel = toPosix(relative(root, abs));
      const { code } = scan(readFileSync(abs, 'utf8'));
      const lines = [];
      code.split('\n').forEach((l, idx) => {
        if (/\bprisma\s+as\s+any\b/.test(l)) lines.push(idx + 1);
      });
      if (lines.length) prismaAsAny.set(rel, lines);
    }
  }
  return { apiLiterals, prismaAsAny };
}

export function loadBaseline(root) {
  const file = join(root, 'scripts/api-boundary-baseline.json');
  if (!existsSync(file)) return { apiLiterals: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Compare offenders with the baseline. Returns `{ violations, shrinkable }`. */
export function evaluate(root) {
  const { apiLiterals, prismaAsAny } = findOffenders(root);
  const baseline = loadBaseline(root);
  const allowed = new Map((baseline.apiLiterals ?? []).map((e) => [e.file, e]));
  const violations = [];
  const shrinkable = [];
  for (const [file, lines] of apiLiterals) {
    const base = allowed.get(file);
    if (!base) {
      violations.push(`${file}:${lines.join(',')}  raw "/api/v1/" literal — call a wrapper in lib/api/<area>.ts`);
    } else if (lines.length > base.count) {
      violations.push(`${file}:${lines.join(',')}  ${lines.length} raw "/api/v1/" literals (baseline ${base.count}, owner ${base.owner}) — no new ones`);
    } else if (lines.length < base.count) {
      shrinkable.push(`${file}: ${lines.length} left (baseline ${base.count}) — lower the count in scripts/api-boundary-baseline.json`);
    }
  }
  for (const e of baseline.apiLiterals ?? []) {
    if (!apiLiterals.has(e.file)) shrinkable.push(`${e.file}: clean now — delete its row from scripts/api-boundary-baseline.json`);
  }
  for (const [file, lines] of prismaAsAny) {
    violations.push(`${file}:${lines.join(',')}  \`prisma as any\` — use the typed client`);
  }
  return { violations, shrinkable };
}

function rootFromArgs(argv) {
  const i = argv.indexOf('--root');
  return i === -1 ? fileURLToPath(new URL('..', import.meta.url)) : argv[i + 1];
}

export function main(argv = process.argv.slice(2), log = console) {
  const root = rootFromArgs(argv);
  const { violations, shrinkable } = evaluate(root);
  for (const s of shrinkable) log.log(`  note: ${s}`);
  if (violations.length) {
    log.error(`\n✗ ${violations.length} API-boundary violation(s)\n  ${violations.join('\n  ')}\n`);
    return 1;
  }
  log.log('✓ API boundary clean — no new raw /api/v1/ literals outside lib/api, no `prisma as any` in features/platform');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
