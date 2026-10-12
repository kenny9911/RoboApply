// @vitest-environment node
//
// H15 (TASK_PLAN.md WP-54 acceptance): no code path writes
// `RAContact.consentBasis` except the contacts-sync. Scans every server
// source file (generated client and tests excluded): the column may be
// WRITTEN only in features/network/contactsSync.ts, and READ only as the
// `consentBasis: { not: null }` filter in features/network/store.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'generated' || name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.(ts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(SERVER_SRC, f).split(path.sep).join('/');

describe('consentBasis has one writer', () => {
  const files = walk(SERVER_SRC);
  // Code lines only: a comment that explains the rule is not a use.
  const codeLines = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const mentions = files.filter((f) => codeLines(f).some((l) => /consentBasis/.test(l))).map(rel);

  it('only the network store (read filter), the sync (writer) and the testkit mention it', () => {
    expect(mentions.sort()).toEqual(['features/network/contactsSync.ts', 'features/network/store.ts', 'features/network/testkit.ts']);
  });

  it('the store only filters on it, never writes it', () => {
    const lines = readFileSync(path.join(SERVER_SRC, 'features/network/store.ts'), 'utf8')
      .split('\n')
      .filter((l) => /consentBasis/.test(l) && !/^\s*(\/\/|\*|\/\*\*)/.test(l));
    for (const line of lines) {
      expect(line, line).toMatch(/consentBasis: \{ not: null \}|consentBasis: true|const \{ consentBasis, \.\.\.rest \}|consentBasis != null|consentBasis: string \| null/);
    }
  });

  it('the sync writes it only from an opt-in record', () => {
    const src = readFileSync(path.join(SERVER_SRC, 'features/network/contactsSync.ts'), 'utf8');
    expect(src).toMatch(/consentBasis: `recruiter_opt_in:\$\{record\.id\}/);
  });
});
