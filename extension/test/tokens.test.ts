// @vitest-environment node
// Build helpers: Clarity tokens copied into the shadow root / popup, icons, locale messages.

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs build script
import { manifestMessages, parseArgs, tilePng } from '../scripts/build.mjs';
// @ts-expect-error — plain .mjs build script
import { readClarity, tokenCss } from '../scripts/tokens.mjs';

const REPO = resolve(__dirname, '../..');

describe('Clarity tokens', () => {
  const t = readClarity(REPO);

  it('reads the light, dark and GoApply blocks from the app stylesheets', () => {
    expect(t.light).toMatch(/--action: #4F3DCA;/);
    expect(t.light).toMatch(/--fs-body:/);
    expect(t.dark).toMatch(/--bg: #171622;/);
    expect(t.goLight).toMatch(/--action: #1F57C8;/);
    expect(t.goDark).toMatch(/--action: #A9C3FF;/);
  });

  it('scopes them to the shadow host, with dark mode and both brands', () => {
    const css = tokenCss(t, 'host');
    expect(css).toMatch(/^:host \{/);
    expect(css).toContain(':host([data-brand="goapply"]) {');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    const root = tokenCss(t, 'root');
    expect(root).toContain(':root[data-brand="goapply"] {');
  });
});

describe('build helpers', () => {
  it('parses flags', () => {
    expect(parseArgs(['--brand=goapply', '--target=edge', '--dev'])).toMatchObject({ brand: 'goapply', target: 'edge', dev: true });
    expect(() => parseArgs(['--brand=other'])).toThrow();
  });

  it('writes a PNG', () => {
    const png = tilePng(16, '#4F3DCA') as Buffer;
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('fills the manifest name and description per brand and target', () => {
    const en = { extension: { manifest: { nameChrome: '%BRAND% for Chrome', nameEdge: '%BRAND% for Edge', shortName: '%BRAND%', description: 'You submit it yourself.', actionTitle: 'Fill this form' } } };
    expect(manifestMessages(en, en, 'RoboApply', 'chrome').extName.message).toBe('RoboApply for Chrome');
    expect(manifestMessages(en, en, 'GoApply', 'edge').extName.message).toBe('GoApply for Edge');
  });
});
