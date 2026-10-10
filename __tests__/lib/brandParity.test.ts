// @vitest-environment node
//
// The web mirror lib/brand/registry.generated.ts must be a byte copy of the
// canonical server/src/platform/brand/registry.ts (ARCHITECTURE.md §1.2).
// Edit the server file, then `npm run gen:brand`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as server from '../../server/src/platform/brand/registry';
import * as web from '../../lib/brand/registry.generated';
// @ts-expect-error — plain .mjs script without type declarations
import { MIRROR_HEADER, mirrorText, stripMirrorHeader } from '../../scripts/gen-brand-mirror.mjs';

const ROOT = process.cwd();
const CANONICAL = join(ROOT, 'server/src/platform/brand/registry.ts');
const MIRROR = join(ROOT, 'lib/brand/registry.generated.ts');

describe('brand registry mirror', () => {
  it('is byte-equal to the canonical registry once the header line is stripped', () => {
    const canonical = readFileSync(CANONICAL, 'utf8');
    const mirror = readFileSync(MIRROR, 'utf8');
    expect(mirror.split('\n')[0]).toBe(
      '// GENERATED from server/src/platform/brand/registry.ts — do not edit',
    );
    expect(stripMirrorHeader(mirror)).toBe(canonical);
    expect(mirror).toBe(mirrorText(canonical));
  });

  it('the generator reports the mirror as current (--check exits 0)', () => {
    const out = execFileSync(process.execPath, ['scripts/gen-brand-mirror.mjs', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('up to date');
  });

  it('the header helpers detect a hand-edited mirror', () => {
    expect(MIRROR_HEADER.startsWith('// GENERATED')).toBe(true);
    expect(stripMirrorHeader('// something else\nexport {}')).toBeNull();
    expect(stripMirrorHeader(`${MIRROR_HEADER}\nexport const x = 1;\n`)).toBe('export const x = 1;\n');
  });

  it('the web mirror carries the D5 defaults (GOAPPLY_PARITY_PLAN §3.2)', () => {
    const go = web.BRANDS.goapply;
    const robo = web.BRANDS.roboapply;
    for (const key of ['coaching', 'interviewVoice', 'webPush', 'student'] as const) {
      expect(go.flags[key], key).toBe(true);
    }
    // Email + password first on both brands; Google and LINE stay RoboApply-only.
    expect(go.authMethods).toEqual(['email_password', 'phone_otp', 'wechat']);
    expect(robo.authMethods[0]).toBe('email_password');
    // Job sources are per market: no JSearch on GoApply, no LinkedIn anywhere.
    expect(go.jobProviders).toEqual(['bank_gohire', 'user_import']);
    expect(go.jobProviders).not.toContain('jsearch');
    expect(robo.jobProviders).toEqual(['activejobs', 'bank_robohire', 'jsearch', 'user_import']);
    // A product flag on for RoboApply is on for GoApply, except the two of its market.
    const roboFlags = robo.flags as unknown as Record<string, boolean | string>;
    const goFlags = go.flags as unknown as Record<string, boolean | string>;
    expect(Object.keys(roboFlags).filter((key) => roboFlags[key] === true && goFlags[key] !== true).sort()).toEqual(['eeoAnswers', 'h1bHistory']);
  });

  it('exports the same data and behaves the same at runtime', () => {
    expect(web.BRANDS).toEqual(server.BRANDS);
    expect(web.BRAND_IDS).toEqual(server.BRAND_IDS);
    expect(web.ALL_LOCALES).toEqual(server.ALL_LOCALES);
    expect(web.DEFAULT_BRAND).toBe(server.DEFAULT_BRAND);
    const hosts = [
      'roboapply.io',
      'www.roboapply.io:443',
      'goapply.top',
      'WWW.GOAPPLY.TOP',
      'goapply.localhost:3621',
      'localhost:3611',
      'preview-abc.vercel.app',
      'evil.example.com',
      '',
      null,
    ];
    for (const h of hosts) {
      expect(web.brandIdFromHost(h)).toBe(server.brandIdFromHost(h));
      expect(web.isDevOrPreviewHost(h)).toBe(server.isDevOrPreviewHost(h));
      expect(web.normalizeHost(h)).toBe(server.normalizeHost(h));
    }
  });
});
