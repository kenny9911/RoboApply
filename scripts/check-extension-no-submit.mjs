#!/usr/bin/env node
// scripts/check-extension-no-submit.mjs — the D1 guarantee for the browser
// extension, enforced in CI (ARCHITECTURE.md §6.6; FND-7 creates it, WP-55b
// owns it with the extension package).
//
// The extension fills forms; the user presses the employer's Submit. The gate
// fails when, under extension/src:
//   1. any file other than src/adapters/_kit/interact.ts contains `.click(`,
//      `.submit(`, `requestSubmit(`, `dispatchEvent(new MouseEvent('click'`,
//      `dispatchEvent(new SubmitEvent`, or a KeyboardEvent carrying `Enter`;
//   2. interact.ts exports anything other than `openListbox` and `chooseOption`;
//   3. either of those functions does not call the submit-like guard
//      (`assertNotSubmitLike(...)`), which refuses buttons, submit inputs,
//      role=button, and elements named submit/apply/next/continue/review/
//      提交/投递/下一步 (ancestors up to 3 levels).
// Comments are ignored. While extension/ does not exist the check passes
// vacuously (Wave 1–3).
//
//   npm run check:extension             (`--root <dir>` checks another tree)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INTERACT = 'src/adapters/_kit/interact.ts';
export const ALLOWED_EXPORTS = ['openListbox', 'chooseOption'];
export const GUARD = 'assertNotSubmitLike';

export const FORBIDDEN = [
  { name: '.click(', re: /\.click\s*\(/ },
  { name: '.submit(', re: /\.submit\s*\(/ },
  { name: 'requestSubmit(', re: /requestSubmit\s*\(/ },
  { name: "dispatchEvent(new MouseEvent('click'", re: /dispatchEvent\s*\(\s*new\s+MouseEvent\s*\(\s*['"`]click/ },
  { name: 'dispatchEvent(new SubmitEvent', re: /dispatchEvent\s*\(\s*new\s+SubmitEvent/ },
  { name: "KeyboardEvent with 'Enter'", re: /new\s+KeyboardEvent\s*\([^)]*['"`]Enter['"`]/s },
];

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.has(extname(full))) out.push(full);
  }
  return out;
}

/** Blank out comments, keep everything else (line numbers preserved). */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Function body text for `export function name(` (brace matching). */
function functionBody(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src) ?? new RegExp(`${name}\\s*=\\s*(?:async\\s*)?\\(`).exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

export function checkExtension(root) {
  const ext = join(root, 'extension');
  if (!existsSync(ext)) return { vacuous: true, violations: [] };
  const violations = [];
  const files = walk(join(ext, 'src')).filter((f) => !/\.(test|spec)\.[jt]sx?$/.test(f));
  for (const abs of files) {
    const rel = relative(ext, abs).split(sep).join('/');
    const src = stripComments(readFileSync(abs, 'utf8'));
    if (rel === INTERACT) continue;
    for (const rule of FORBIDDEN) {
      const m = rule.re.exec(src);
      if (m) violations.push(`extension/${rel}:${lineOf(src, m.index)}  ${rule.name} — only ${INTERACT} may interact, and never with submit-like controls (D1)`);
    }
  }
  const interactFile = join(ext, INTERACT);
  if (existsSync(interactFile)) {
    const src = stripComments(readFileSync(interactFile, 'utf8'));
    const exported = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+)(\w+)/g)) exported.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) exported.add(name);
      }
    }
    if (/export\s+default/.test(src)) exported.add('default');
    for (const name of exported) {
      if (!ALLOWED_EXPORTS.includes(name)) violations.push(`extension/${INTERACT}: exports "${name}" — only ${ALLOWED_EXPORTS.join(' and ')} are allowed`);
    }
    for (const name of ALLOWED_EXPORTS) {
      if (!exported.has(name)) continue;
      const body = functionBody(src, name);
      if (!body || !new RegExp(`\\b${GUARD}\\s*\\(`).test(body)) {
        violations.push(`extension/${INTERACT}: ${name}() must call ${GUARD}(el) before touching the element`);
      }
    }
  }
  return { vacuous: false, violations };
}

function rootFromArgs(argv) {
  const i = argv.indexOf('--root');
  return i === -1 ? fileURLToPath(new URL('..', import.meta.url)) : argv[i + 1];
}

export function main(argv = process.argv.slice(2), log = console) {
  const { vacuous, violations } = checkExtension(rootFromArgs(argv));
  if (vacuous) {
    log.log('✓ extension no-submit — no extension/ package yet (passes vacuously)');
    return 0;
  }
  if (violations.length) {
    log.error(`\n✗ ${violations.length} extension no-submit violation(s) (D1: the user presses Submit)\n  ${violations.join('\n  ')}\n`);
    return 1;
  }
  log.log('✓ extension no-submit — nothing clicks, submits or presses Enter outside the guarded interact.ts');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
