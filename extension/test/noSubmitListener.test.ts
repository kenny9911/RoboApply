// The extension never listens for form submits on employer pages (D1; R-19):
// "submitted" is only what the user tells the panel.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(full);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

describe('no submit listeners', () => {
  const files = walk(SRC);

  it('scans the whole package', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no source file adds a 'submit' listener or assigns onsubmit", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = strip(readFileSync(f, 'utf8'));
      if (/addEventListener\s*\(\s*['"`]submit['"`]/.test(src) || /\.onsubmit\s*=/.test(src) || /['"`]formdata['"`]/.test(src)) hits.push(relative(SRC, f));
    }
    expect(hits).toEqual([]);
  });

  it('code that runs on employer pages (content, adapters, mapping) has no onSubmit handler at all', () => {
    const hits = files
      .filter((f) => /\/(content|adapters|mapping)\//.test(f))
      .filter((f) => /onSubmit\b/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it('nothing outside interact.ts calls click(), submit() or requestSubmit()', () => {
    const hits = files
      .filter((f) => !f.endsWith('adapters/_kit/interact.ts'))
      .filter((f) => /\.(click|submit|requestSubmit)\s*\(/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
