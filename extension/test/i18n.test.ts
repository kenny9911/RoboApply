// Extension strings: every literal key resolves, bundles are brand-neutral,
// %BRAND% is substituted, locale choice.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { setBuildEnvForTests } from '../src/env';
import { deepMerge, englishKeys, pickLocale, translate, type Messages } from '../src/i18n/index';

const SRC = resolve(__dirname, '../src');
// English lives in src/i18n/en.json (WP-91 merged the staged strings into it);
// anything staged since is read on top, exactly as i18n/index.ts does.
const BUNDLE = resolve(__dirname, '../src/i18n/en.json');
const STAGING = resolve(__dirname, '../../i18n/staging/extension.en.json');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(full);
  }
  return out;
}

describe('extension strings', () => {
  it('every literal t() / translate() key resolves in English', () => {
    const keys = new Set(englishKeys());
    const missing: string[] = [];
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) if (!keys.has(`extension.${m[1]}`)) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/translate\(\s*'extension',\s*'([\w.]+)'/g)) if (!keys.has(`extension.${m[1]}`)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('template keys used with dynamic suffixes exist', () => {
    const keys = new Set(englishKeys());
    const families: Record<string, string[]> = {
      'fit.tier': ['great', 'good', 'possible', 'unlikely'],
      status: ['filled', 'needs_you', 'skipped'],
      source: ['profile', 'bank', 'resume', 'ai'],
      note: ['protected', 'no_value', 'no_option', 'not_pressed', 'resume_unavailable', 'cover_letter', 'file_failed', 'disabled', 'undone', 'ai_unavailable', 'draft_failed'],
      error: ['credits_exhausted', 'feature_disabled', 'not_connected', 'rate_limited', 'network', 'unknown'],
    };
    for (const [prefix, list] of Object.entries(families)) for (const k of list) expect(keys.has(`extension.${prefix}.${k}`), `${prefix}.${k}`).toBe(true);
  });

  it('the English bundle never names a brand and carries the D1 lines', () => {
    const files = [BUNDLE, STAGING].map((f) => readFileSync(f, 'utf8'));
    for (const text of files) expect(text).not.toMatch(/RoboApply|GoApply/i);
    const groups = files.map((text) => ((JSON.parse(text) as Messages).extension ?? {}) as Messages);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const en = deepMerge(deepMerge({}, groups[0]!), groups[1]!) as any;
    const raw = JSON.stringify(en);
    expect(Object.keys(en).length).toBeGreaterThan(5);
    expect(en.panel.submitYourself).toBe('Check the form, then submit it yourself.');
    expect(en.submitted.question).toBe('Did you submit this application?');
    expect(en.draft.use).toBe('Use this answer');
    expect(en.fit.note).toBe('This is not your chance of getting hired.');
    expect(en.manifest.description).toMatch(/submit the application yourself/);
    expect(raw).not.toMatch(/auto-?apply|one[- ]click apply|on your behalf|\bATS\b|\bmatch\b/i);
  });

  it('substitutes the brand per build', () => {
    expect(translate('extension', 'connect.open')).toBe('Open RoboApply to connect');
    const restore = setBuildEnvForTests({ brand: 'goapply' });
    expect(translate('extension', 'connect.open')).toBe('Open GoApply to connect');
    restore();
    expect(translate('extension', 'panel.summary', { filled: 3, total: 9 })).toBe('3 of 9 fields filled.');
  });

  it('picks the UI language when translated, else the brand default, else English', () => {
    expect(pickLocale('zh-TW', ['zh', 'zh-TW'], 'en')).toBe('zh-TW');
    expect(pickLocale('zh-HK', ['zh', 'zh-TW'], 'en')).toBe('zh-TW');
    expect(pickLocale('zh-CN', ['zh'], 'en')).toBe('zh');
    expect(pickLocale('ja-JP', ['ja'], 'en')).toBe('ja');
    expect(pickLocale('fr-FR', [], 'en')).toBe('en');
    expect(pickLocale('en-US', ['zh'], 'zh')).toBe('en');
    expect(pickLocale(null, ['zh'], 'zh')).toBe('zh');
    expect(pickLocale(null, [], 'zh')).toBe('en');
  });
});
