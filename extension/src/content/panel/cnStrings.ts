// extension/src/content/panel/cnStrings.ts — strings of the `extension-cn`
// namespace (一键填表: fill modes, the review line, cn notes, the AI label).
//
// Authored in i18n/staging/extension-cn.{en,zh}.json (TASK_PLAN §2.3, R-22).
// The locale follows the rest of the extension (i18n/index.ts currentLocale()
// and pickLocale()): a zh browser gets zh, an English one English. Until INT
// ships the translated extension bundles, a zh browser still gets this
// namespace's staged zh text (the line "请核对后自行提交" among it). A bundle
// INT merged for the active locale wins; zh / zh-TW then fall back to the
// staged zh text, every other locale to the staged English. `%BRAND%` and `{name}`
// are substituted like every other extension string.

import stagedEn from '../../../../i18n/staging/extension-cn.en.json';
import stagedZh from '../../../../i18n/staging/extension-cn.zh.json';
import { brandConfig } from '../../env';
import { currentLocale, format, pickLocale, translate, type Messages, type Params } from '../../i18n/index';

export const CN_NS = 'extension-cn';

const EN = (stagedEn as Messages)[CN_NS] as Messages;
const ZH = (stagedZh as Messages)[CN_NS] as Messages;

function lookup(bundle: Messages | undefined, key: string): string | null {
  let cur: string | Messages | undefined = bundle;
  for (const part of key.split('.')) {
    if (!cur || typeof cur === 'string') return null;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : null;
}

function uiLanguage(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) return chrome.i18n.getUILanguage();
  } catch {
    // not in an extension context (tests)
  }
  return typeof navigator !== 'undefined' ? navigator.language : 'en';
}

/** The locale for this namespace: the extension's own, or zh for a zh browser while no zh bundle is built in. */
export function cnLocale(): string {
  const locale = currentLocale();
  if (locale !== 'en') return locale;
  return pickLocale(uiLanguage(), ['zh'], brandConfig().defaultLocale);
}

/** One `extension-cn` string in the active locale. A missing key renders its path (tests fail on it). */
export function cnText(key: string, params?: Params): string {
  const locale = cnLocale();
  if (locale !== 'en' && currentLocale() === locale) {
    const merged = translate(CN_NS, key, params);
    if (merged !== `${CN_NS}.${key}`) return merged;
  }
  const zh = locale === 'zh' || locale === 'zh-TW' ? lookup(ZH, key) : null;
  const value = zh ?? lookup(EN, key);
  return value === null ? `${CN_NS}.${key}` : format(value, params);
}

/** Every leaf key of a staged bundle (tests: en/zh parity). */
export function cnKeys(lang: 'en' | 'zh'): string[] {
  const out: string[] = [];
  const walk = (m: Messages, prefix: string) => {
    for (const [k, v] of Object.entries(m)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') out.push(p);
      else walk(v, p);
    }
  };
  walk(lang === 'en' ? EN : ZH, '');
  return out.sort();
}
