// `extension-cn` strings (i18n/staging/extension-cn.{en,zh}.json): en/zh parity,
// every literal cnText() key resolves, brand-neutral, the required zh lines,
// none of the banned wordings, and the locale rule.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CN_NOTES } from '../../src/content/panel/CnControls';
import { cnKeys, cnLocale, cnText } from '../../src/content/panel/cnStrings';
import { setBuildEnvForTests } from '../../src/env';
import { setLocale } from '../../src/i18n/index';

const SRC = resolve(__dirname, '../../src');
const STAGING = resolve(__dirname, '../../../i18n/staging');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(full);
  }
  return out;
}

afterEach(() => setLocale(null));

describe('extension-cn strings', () => {
  it('en and zh have the same keys', () => {
    expect(cnKeys('zh')).toEqual(cnKeys('en'));
    expect(cnKeys('en').length).toBeGreaterThan(20);
  });

  it('every literal cnText() key and every dynamic family resolves', () => {
    const keys = new Set(cnKeys('en'));
    const missing: string[] = [];
    for (const f of walk(SRC)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/cnText\(\s*'([\w.]+)'/g)) if (!keys.has(m[1])) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
    for (const k of CN_NOTES) expect(keys.has(`note.${k}`)).toBe(true);
    for (const k of ['no_selection', 'no_fields_in_selection']) expect(keys.has(`error.${k}`)).toBe(true);
    for (const m of ['all', 'blank', 'selection']) {
      expect(keys.has(`modes.${m}`)).toBe(true);
      expect(keys.has(`modes.${m}Hint`)).toBe(true);
    }
  });

  it('the zh bundle carries the agreed product wording', () => {
    const zh = JSON.parse(readFileSync(join(STAGING, 'extension-cn.zh.json'), 'utf8'))['extension-cn'];
    expect(zh.review.title).toBe('请核对后自行提交');
    expect([zh.modes.all, zh.modes.blank, zh.modes.selection]).toEqual(['全部填写', '只填空白', '填写选中区域']);
    expect(zh.panel.title).toBe('一键填表');
    expect(zh.aiBadge).toBe('AI 辅助生成');
  });

  it('is brand-neutral and avoids the banned wording (D1, affiliation, auto-apply)', () => {
    for (const lang of ['en', 'zh']) {
      const raw = readFileSync(join(STAGING, `extension-cn.${lang}.json`), 'utf8');
      expect(raw).not.toMatch(/RoboApply|GoApply|RoboHire|GoHire/i);
      expect(raw).not.toMatch(/北森|牛客|一键网申|一键投递|自动投递|代投|海投|自动打招呼|无限/);
      expect(raw).not.toMatch(/auto-?apply|one[- ]click apply|on your behalf|\bATS\b|unlimited|guarantee/i);
    }
  });

  it('substitutes %BRAND% per build', () => {
    setLocale('zh');
    const restore = setBuildEnvForTests({ brand: 'goapply' });
    expect(cnText('launcher.label')).toBe('打开 GoApply 一键填表');
    restore();
    setLocale('en');
    expect(cnText('launcher.label')).toBe('Open RoboApply to fill this form');
  });

  it('a zh browser gets zh before the translated extension bundles exist; English stays English', () => {
    const nav = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');
    try {
      Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'zh-CN' });
      expect(cnLocale()).toBe('zh');
      expect(cnText('review.title')).toBe('请核对后自行提交');
      Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'en-US' });
      expect(cnLocale()).toBe('en');
      expect(cnText('review.title')).toBe('Check everything, then submit it yourself.');
      // GoApply's default locale is zh: a browser language without a bundle falls back to it.
      const restore = setBuildEnvForTests({ brand: 'goapply' });
      Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'ko-KR' });
      expect(cnLocale()).toBe('zh');
      restore();
    } finally {
      delete (navigator as unknown as Record<string, unknown>).language;
      if (nav) Object.defineProperty(Navigator.prototype, 'language', nav);
    }
  });

  it('a missing key renders its path (so tests catch it)', () => {
    expect(cnText('nope.missing')).toBe('extension-cn.nope.missing');
  });
});
