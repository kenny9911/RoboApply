// @vitest-environment node
//
// FND-7 gates: scripts/check-api-boundary.mjs, check-extension-no-submit.mjs,
// check-zh-variants.mjs (stub) and the check-design.mjs additions.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as boundary from '../../scripts/check-api-boundary.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import * as noSubmit from '../../scripts/check-extension-no-submit.mjs';

const roots: string[] = [];
function tmp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function write(root: string, rel: string, text: string) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('check-api-boundary', () => {
  const BASELINE = JSON.stringify({ apiLiterals: [{ file: 'components/Old.tsx', count: 1, owner: 'WP-12' }] });

  function base(): string {
    const root = tmp('api-boundary-');
    write(root, 'scripts/api-boundary-baseline.json', BASELINE);
    write(root, 'components/Old.tsx', "export const u = '/api/v1/roboapply/legacy';\n");
    write(root, 'lib/api/offers.ts', "export const p = '/api/v1/roboapply/offers';\n");
    write(root, 'lib/server/publicApi.ts', 'export const p = `/api/v1/public/seo/page`;\n');
    return root;
  }

  it('passes on the baseline and on lib/api / lib/server/publicApi.ts', () => {
    expect(boundary.evaluate(base()).violations).toEqual([]);
  });

  it('fails on a new raw /api/v1/ literal outside lib/api (quotes and templates)', () => {
    const root = base();
    write(root, 'components/features/feed/Card.tsx', 'export const u = `/api/v1/roboapply/feed/${1}`;\n');
    write(root, 'hooks/useX.ts', 'export const u = "/api/v1/roboapply/x";\n');
    const v = boundary.evaluate(root).violations.join('\n');
    expect(v).toContain('components/features/feed/Card.tsx:1');
    expect(v).toContain('hooks/useX.ts:1');
  });

  it('fails when a baseline file grows a second literal', () => {
    const root = base();
    write(root, 'components/Old.tsx', "export const u = '/api/v1/a';\nexport const w = '/api/v1/b';\n");
    expect(boundary.evaluate(root).violations.join('\n')).toContain('baseline 1, owner WP-12');
  });

  it('ignores comments, and notes a baseline row that can be deleted', () => {
    const root = base();
    write(root, 'components/Old.tsx', "// was '/api/v1/roboapply/legacy'\n/* see /api/v1/x */\nexport const u = 1;\n");
    const r = boundary.evaluate(root);
    expect(r.violations).toEqual([]);
    expect(r.shrinkable.join('\n')).toContain('components/Old.tsx: clean now');
  });

  it('does not mistake a regex literal for a comment or a string', () => {
    const root = base();
    write(root, 'lib/x.ts', 'export const re = /\\/api\\/v1\\//; // matches /api/v1/\n');
    expect(boundary.evaluate(root).violations).toEqual([]);
  });

  it('fails on `prisma as any` in server/src/features and server/src/platform, not in comments', () => {
    const root = base();
    write(root, 'server/src/features/feed/service.ts', 'export const a = (prisma as any).rAJob;\n// prisma as any is banned\n');
    write(root, 'server/src/platform/x.ts', '/* prisma as any */ export const b = 1;\n');
    const v = boundary.evaluate(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('server/src/features/feed/service.ts:1');
  });

  it('this checkout passes (only the two baselined offenders exist)', () => {
    expect(boundary.evaluate(process.cwd()).violations).toEqual([]);
    const offenders = [...boundary.findOffenders(process.cwd()).apiLiterals.keys()].sort();
    expect(offenders).toEqual(['components/v3/shell/LanguageSwitcher.tsx', 'lib/resumeDownload.ts']);
  });
});

describe('check-extension-no-submit', () => {
  const GOOD_INTERACT = `
function assertNotSubmitLike(el) { if (el.closest('button')) throw new Error('submit-like'); }
export function openListbox(el) { assertNotSubmitLike(el); el.click(); }
export function chooseOption(el) { assertNotSubmitLike(el); el.click(); }
`;

  it('passes vacuously while extension/ is absent', () => {
    expect(noSubmit.checkExtension(tmp('ext-'))).toEqual({ vacuous: true, violations: [] });
  });

  it('passes a clean package and ignores comments', () => {
    const root = tmp('ext-');
    write(root, 'extension/src/adapters/_kit/interact.ts', GOOD_INTERACT);
    write(root, 'extension/src/adapters/greenhouse.ts', '// never call form.submit() here\nexport const id = "greenhouse";\n');
    expect(noSubmit.checkExtension(root).violations).toEqual([]);
  });

  it.each([
    ['button.click()', '.click('],
    ['form.submit()', '.submit('],
    ['form.requestSubmit()', 'requestSubmit('],
    ["el.dispatchEvent(new MouseEvent('click'))", "MouseEvent('click'"],
    ['el.dispatchEvent(new SubmitEvent("submit"))', 'SubmitEvent'],
    ["el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))", 'Enter'],
  ])('fails on %s outside interact.ts', (code, name) => {
    const root = tmp('ext-');
    write(root, 'extension/src/adapters/_kit/interact.ts', GOOD_INTERACT);
    write(root, 'extension/src/adapters/lever.ts', `export function f(el) { ${code}; }\n`);
    const v = noSubmit.checkExtension(root).violations.join('\n');
    expect(v).toContain('extension/src/adapters/lever.ts:1');
    expect(v).toContain(name);
  });

  it('fails when interact.ts exports anything else or skips the guard', () => {
    const root = tmp('ext-');
    write(
      root,
      'extension/src/adapters/_kit/interact.ts',
      'export function openListbox(el) { el.click(); }\nexport function chooseOption(el) { assertNotSubmitLike(el); }\nexport const clickAnything = (el) => el.click();\n',
    );
    const v = noSubmit.checkExtension(root).violations.join('\n');
    expect(v).toContain('exports "clickAnything"');
    expect(v).toContain('openListbox() must call assertNotSubmitLike');
    expect(v).not.toContain('chooseOption() must call');
  });
});

describe('check-zh-variants (stub until WP-12)', () => {
  it('exits 0', () => {
    const r = spawnSync(process.execPath, ['scripts/check-zh-variants.mjs'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

describe('check-design additions', () => {
  function designTree(): string {
    const root = tmp('design-');
    write(root, 'app/globals.css', ':root { --fs-body: 15px; }\n.a { font-size: var(--fs-body); }\n');
    write(root, 'styles/tokens.css', '.b { color: var(--text); }\n');
    return root;
  }
  const run = (root: string) => spawnSync(process.execPath, ['scripts/check-design.mjs', '--root', root], { encoding: 'utf8' });

  it('passes a clean tree', () => {
    expect(run(designTree()).status).toBe(0);
  });

  it('scans components/features/**/*.module.css', () => {
    const root = designTree();
    write(root, 'components/features/feed/Card.module.css', '.title { font-size: 13px; }\n');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('components/features/feed/Card.module.css:1');
  });

  it('restricts styles/brands/*.css to the identity and action tokens', () => {
    const root = designTree();
    write(
      root,
      'styles/brands/goapply.css',
      "html[data-brand='goapply'] {\n  --action: #1f57c8;\n  --brand-plane: #e6f4ee;\n}\nhtml[data-brand='goapply'] { --text: #000; color: red; }\n",
    );
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--text');
    expect(r.stderr).toContain('color');
    expect(r.stderr).not.toContain('--action —');
  });

  it('accepts a brand file that only redefines allowed tokens (light and dark)', () => {
    const root = designTree();
    write(
      root,
      'styles/brands/goapply.css',
      "/* GoApply identity */\nhtml[data-brand='goapply'] {\n  --action: #1f57c8;\n  --action-hover: #194aa9;\n}\n@media (prefers-color-scheme: dark) {\n  html[data-brand='goapply'] { --action: #a9c3ff; --grad-brand: linear-gradient(90deg, #a9c3ff, #7fd1ae); }\n}\n",
    );
    expect(run(root).status).toBe(0);
  });
});
