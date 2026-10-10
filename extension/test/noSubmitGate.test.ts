// scripts/check-extension-no-submit.mjs: passes on this package, fails on a planted press.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script without types
import { checkExtension, INTERACT, main } from '../../scripts/check-extension-no-submit.mjs';

const REPO = resolve(__dirname, '../..');
const EXT_SRC = resolve(REPO, 'extension/src');
const dirs: string[] = [];

function copyTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'ra-ext-gate-'));
  dirs.push(root);
  cpSync(EXT_SRC, join(root, 'extension/src'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-extension-no-submit', () => {
  it('passes on the extension package as written', () => {
    const res = checkExtension(REPO);
    expect(res.vacuous).toBe(false);
    expect(res.violations).toEqual([]);
    const log = { log: () => {}, error: () => {} };
    expect(main(['--root', REPO], log)).toBe(0);
  });

  const PLANTS: Array<[string, string]> = [
    ['a planted .click()', "export function x(el: HTMLElement) { el.click(); }"],
    ['a planted form.submit()', "export function x(f: HTMLFormElement) { f.submit(); }"],
    ['a planted requestSubmit()', "export function x(f: HTMLFormElement) { f.requestSubmit(); }"],
    ['a planted synthetic click', "export function x(el: HTMLElement) { el.dispatchEvent(new MouseEvent('click')); }"],
    ['a planted SubmitEvent', "export function x(el: HTMLElement) { el.dispatchEvent(new SubmitEvent('submit')); }"],
    ['a planted Enter key', "export function x(el: HTMLElement) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); }"],
    ['a planted submit listener', "export function x(d: Document) { d.addEventListener('submit', () => {}); }"],
    ['a planted onsubmit handler', "export function x(f: HTMLFormElement) { f.onsubmit = () => {}; }"],
    ['HTMLElement.prototype.click.call(el)', "export function x(el: HTMLElement) { HTMLElement.prototype.click.call(el); }"],
    ['el.click.apply(el)', "export function x(el: HTMLElement) { el.click.apply(el); }"],
    ['an aliased click', "export function x(el: HTMLElement) { const press = el.click.bind(el); press(); }"],
    ["el['click']()", "export function x(el: HTMLElement) { el['click'](); }"],
    ['el[`submit`]()', "export function x(f: HTMLFormElement) { f[`submit`](); }"],
    ['HTMLFormElement.prototype.submit.call(form)', "export function x(f: HTMLFormElement) { HTMLFormElement.prototype.submit.call(f); }"],
    ['HTMLFormElement.prototype.requestSubmit.call(form)', "export function x(f: HTMLFormElement) { HTMLFormElement.prototype.requestSubmit.call(f); }"],
    ["form.dispatchEvent(new Event('submit'))", "export function x(f: HTMLFormElement) { f.dispatchEvent(new Event('submit', { bubbles: true })); }"],
    ["new CustomEvent('submit')", "export function x(f: HTMLFormElement) { const e = new CustomEvent('submit'); f.dispatchEvent(e); }"],
    ['a SubmitEvent held in a variable', "export function x(f: HTMLFormElement) { const e = new SubmitEvent('submit'); f.dispatchEvent(e); }"],
    ["new PointerEvent('click')", "export function x(el: HTMLElement) { el.dispatchEvent(new PointerEvent('click', { bubbles: true })); }"],
    ["new MouseEvent('mouseup') held in a variable", "export function x(el: HTMLElement) { const e = new MouseEvent('mouseup'); el.dispatchEvent(e); }"],
    ["new PointerEvent('pointerup')", "export function x(el: HTMLElement) { el.dispatchEvent(new PointerEvent('pointerup')); }"],
    ['a KeyboardEvent whose Enter init is in a variable', "const init = { key: 'Enter' };\nexport function x(el: HTMLElement) { el.dispatchEvent(new KeyboardEvent('keydown', init)); }"],
  ];
  for (const [name, code] of PLANTS) {
    it(`fails on ${name} outside interact.ts`, () => {
      const root = copyTree();
      writeFileSync(join(root, 'extension/src/content/planted.ts'), code);
      const res = checkExtension(root);
      expect(res.violations.length).toBeGreaterThan(0);
      expect(res.violations.join('\n')).toContain('extension/src/content/planted.ts');
      expect(main(['--root', root], { log: () => {}, error: () => {} })).toBe(1);
    });
  }

  it('ignores a press that only appears in a comment', () => {
    const root = copyTree();
    writeFileSync(join(root, 'extension/src/content/commented.ts'), '// el.click() is not allowed here\nexport const n = 1;\n');
    expect(checkExtension(root).violations).toEqual([]);
  });

  it('fails when interact.ts exports anything else', () => {
    const root = copyTree();
    const file = join(root, 'extension', INTERACT);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport function pressAnything(el: HTMLElement) { el.click(); }\n`);
    expect(checkExtension(root).violations.join('\n')).toMatch(/exports "pressAnything"/);
  });

  it('fails when chooseOption loses its guard', () => {
    const root = copyTree();
    const file = join(root, 'extension', INTERACT);
    const src = readFileSync(file, 'utf8').replace(/export function chooseOption\(el: Element\): void \{[\s\S]*?\n\}/, 'export function chooseOption(el: Element): void {\n  (el as HTMLElement).click();\n}');
    writeFileSync(file, src);
    expect(checkExtension(root).violations.join('\n')).toMatch(/chooseOption\(\) must call assertNotSubmitLike/);
  });
});
