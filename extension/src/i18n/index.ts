// extension/src/i18n/index.ts — extension UI strings.
//
// English is authored in i18n/staging/extension.en.json (TASK_PLAN §2.3);
// `npm run i18n:merge` (INT) folds it into extension/src/i18n/en.json and
// writes the translated bundles next to it (extension/src/i18n/<locale>.json).
// At runtime staged English is merged over en.json, exactly like the web app,
// so a new key renders in English until INT translates it. Translated bundles
// reach the build through `__EXT_LOCALE_BUNDLES__` (scripts/build.mjs reads
// every src/i18n/<locale>.json), so a new locale needs no code change.
//
// Bundles never name the product: `%BRAND%` / `%OTHER_BRAND%` are substituted
// from the brand registry. Parameters use `{name}`.

import baseEn from './en.json';
import stagedEn from '../../../i18n/staging/extension.en.json';
import { brandConfig } from '../env';

export type Messages = { [key: string]: string | Messages };

declare const __EXT_LOCALE_BUNDLES__: Record<string, Messages> | undefined;

const isObj = (v: unknown): v is Messages => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(dst: Messages, src: Messages): Messages {
  for (const [k, v] of Object.entries(src ?? {})) {
    const prev = dst[k];
    if (isObj(v) && isObj(prev)) deepMerge(prev, v);
    else dst[k] = isObj(v) ? deepMerge({}, v) : v;
  }
  return dst;
}

function englishBundle(): Messages {
  return deepMerge(deepMerge({}, baseEn as Messages), stagedEn as Messages);
}

function localeBundles(): Record<string, Messages> {
  return typeof __EXT_LOCALE_BUNDLES__ !== 'undefined' && __EXT_LOCALE_BUNDLES__ ? __EXT_LOCALE_BUNDLES__ : {};
}

/**
 * The locale to render: the browser UI language when a bundle exists for it
 * (exact, then the zh script variants, then the base language), else the
 * brand's default locale, else English.
 */
export function pickLocale(uiLanguage: string | null | undefined, available: readonly string[], brandDefault: string): string {
  const has = (l: string) => l === 'en' || available.includes(l);
  const raw = (uiLanguage ?? '').replace('_', '-');
  if (raw) {
    const lower = raw.toLowerCase();
    if (lower.startsWith('zh')) {
      const tw = /zh-(tw|hk|mo|hant)/.test(lower);
      if (tw && has('zh-TW')) return 'zh-TW';
      if (!tw && has('zh')) return 'zh';
    } else {
      const exact = available.find((l) => l.toLowerCase() === lower);
      if (exact) return exact;
      const base = lower.split('-')[0];
      if (has(base)) return base;
    }
  }
  return has(brandDefault) ? brandDefault : 'en';
}

let activeLocale: string | null = null;
let cache: { locale: string; messages: Messages } | null = null;

export function setLocale(locale: string | null): void {
  activeLocale = locale;
  cache = null;
}

export function currentLocale(): string {
  if (activeLocale) return activeLocale;
  const ui = typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage ? chrome.i18n.getUILanguage() : typeof navigator !== 'undefined' ? navigator.language : 'en';
  return pickLocale(ui, Object.keys(localeBundles()), brandConfig().defaultLocale);
}

function messages(): Messages {
  const locale = currentLocale();
  if (cache?.locale === locale) return cache.messages;
  const merged = englishBundle();
  const overlay = locale === 'en' ? null : localeBundles()[locale];
  if (overlay) deepMerge(merged, overlay);
  cache = { locale, messages: merged };
  return merged;
}

function lookup(bundle: Messages, path: string): string | null {
  let cur: string | Messages | undefined = bundle;
  for (const part of path.split('.')) {
    if (!isObj(cur)) return null;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : null;
}

export type Params = Record<string, string | number>;

export function format(template: string, params: Params = {}): string {
  const brand = brandConfig();
  return template
    .replace(/%BRAND%/g, brand.name)
    .replace(/%OTHER_BRAND%/g, brand.otherBrandName)
    .replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** `translate('extension', 'panel.title')`. A missing key renders the key path (and fails the copy check). */
export function translate(ns: string, key: string, params?: Params): string {
  const path = `${ns}.${key}`;
  const value = lookup(messages(), path);
  return format(value ?? path, params);
}

export type TFunction = (key: string, params?: Params) => string;

/**
 * Namespaced translator. Named like next-intl's hook so `npm run check:copy`
 * verifies every literal `t('…')` key in extension/src against the bundles.
 */
export function useTranslations(ns: 'extension'): TFunction {
  return (key, params) => translate(ns, key, params);
}

/** Every leaf path of the merged English bundle (tests). */
export function englishKeys(): string[] {
  const out: string[] = [];
  const walk = (m: Messages, prefix: string) => {
    for (const [k, v] of Object.entries(m)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (isObj(v)) walk(v, p);
      else out.push(p);
    }
  };
  walk(englishBundle(), '');
  return out;
}
