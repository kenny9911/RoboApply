// extension/scripts/tokens.mjs — copy the Clarity design tokens into the extension.
//
// Source of truth: app/globals.css (the first `:root` block with the Clarity
// tokens and `html[data-theme='dark']`) and styles/brands/goapply.css. The
// panel lives in a shadow root (`:host`), the popup in its own page (`:root`).
// Dark mode follows the visitor's system setting (`prefers-color-scheme`),
// because an employer's page has no data-theme of ours.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Declarations inside the first `<selector> {…}` block whose body contains `mustContain`. */
export function blockBody(css, selector, mustContain = '--') {
  let from = 0;
  for (;;) {
    const at = css.indexOf(`${selector} {`, from);
    if (at === -1) return null;
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        const body = css.slice(open + 1, i);
        if (body.includes(mustContain)) return body.replace(/\/\*[\s\S]*?\*\//g, '').trim();
        from = i;
        break;
      }
    }
  }
}

function decls(body) {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.startsWith('--') || d.startsWith('color-scheme'))
    .map((d) => `  ${d};`)
    .join('\n');
}

export function readClarity(repoRoot) {
  const globals = readFileSync(join(repoRoot, 'app/globals.css'), 'utf8');
  const goapply = readFileSync(join(repoRoot, 'styles/brands/goapply.css'), 'utf8');
  const light = blockBody(globals, ':root', '--action:');
  const dark = blockBody(globals, "html[data-theme='dark']", '--action:');
  const goLight = blockBody(goapply, "html[data-brand='goapply']", '--action:');
  const goDark = blockBody(goapply, "html[data-brand='goapply'][data-theme='dark']", '--action:');
  if (!light || !dark || !goLight || !goDark) throw new Error('tokens.mjs: could not find the Clarity token blocks');
  return { light: decls(light), dark: decls(dark), goLight: decls(goLight), goDark: decls(goDark) };
}

/**
 * Token CSS for a scope: 'host' (shadow root; brand from the host's data-brand)
 * or 'root' (extension page; brand from <html data-brand>).
 */
export function tokenCss(t, scope) {
  const base = scope === 'host' ? ':host' : ':root';
  const go = scope === 'host' ? ':host([data-brand="goapply"])' : ':root[data-brand="goapply"]';
  return [
    `${base} {\n${t.light}\n}`,
    `${go} {\n${t.goLight}\n}`,
    `@media (prefers-color-scheme: dark) {\n${base} {\n${t.dark}\n}\n${go} {\n${t.goDark}\n}\n}`,
  ].join('\n');
}
