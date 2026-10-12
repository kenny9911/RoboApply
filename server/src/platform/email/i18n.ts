// server/src/platform/email/i18n.ts
//
// Email strings (ARCHITECTURE.md §8.1, TASK_PLAN.md §2.3). Bundles live in
// server/src/i18n/email/<locale>.json (inside server/src so Vercel's
// `includeFiles: server/**` ships them); feature WPs write new English keys to
// server/src/i18n/email/staging/<area>.en.json (`{ "<area>": { … } }`).
//
// Resolution for locale L:  en.json  ←  staging/*.en.json  ←  L.json
// so a key that is not translated yet renders in English until INT merges
// and translates it. `%BRAND%` / `%OTHER_BRAND%` are substituted per brand;
// messages use a small ICU subset: `{name}`, `{n, plural, =0 {…} one {# …} other {…}}`
// and `{x, select, a {…} other {…}}`.
//
// A missing key throws EmailI18nError: an email must never ship a raw key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_LOCALES, getBrand, type ProductBrand, type RoboLocale } from '../brand/registry.js';

export type Messages = { [key: string]: string | Messages };

export const EMAIL_LOCALES: readonly RoboLocale[] = ALL_LOCALES;

export class EmailI18nError extends Error {
  readonly key: string;
  constructor(message: string, key: string) {
    super(message);
    this.name = 'EmailI18nError';
    this.key = key;
  }
}

// ── Locating the bundles ─────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
let dirOverride: string | null = null;
let resolvedDir: string | null = null;

/** Tests only: read bundles from another directory (and drop the cache). */
export function setEmailI18nDirForTests(dir: string | null): void {
  dirOverride = dir;
  resolvedDir = null;
  cache.clear();
}

export function resetEmailI18nCache(): void {
  cache.clear();
}

/** server/src/platform/email → server/src/i18n/email (source) or server/dist/platform/email → server/src/i18n/email (build). */
export function emailI18nDir(): string {
  if (dirOverride) return dirOverride;
  if (resolvedDir) return resolvedDir;
  const candidates = [
    path.resolve(HERE, '../../i18n/email'),
    path.resolve(HERE, '../../../src/i18n/email'),
    path.resolve(process.cwd(), 'server/src/i18n/email'),
  ];
  resolvedDir = candidates.find((c) => fs.existsSync(path.join(c, 'en.json'))) ?? candidates[0]!;
  return resolvedDir;
}

function readJson(file: string): Messages {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`email i18n: ${file} must contain a JSON object`);
  }
  return parsed as Messages;
}

/** Deep merge `over` onto a copy of `base` (objects merge, strings replace). */
export function mergeMessages(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (v && typeof v === 'object' && cur && typeof cur === 'object') out[k] = mergeMessages(cur, v);
    else out[k] = v;
  }
  return out;
}

/** English base with every `staging/*.en.json` merged over it (sorted by file name). */
export function loadEnglishWithStaging(dir: string = emailI18nDir()): Messages {
  let messages = readJson(path.join(dir, 'en.json'));
  const stagingDir = path.join(dir, 'staging');
  if (fs.existsSync(stagingDir)) {
    const files = fs
      .readdirSync(stagingDir)
      .filter((f) => f.endsWith('.en.json'))
      .sort();
    for (const f of files) messages = mergeMessages(messages, readJson(path.join(stagingDir, f)));
  }
  return messages;
}

const cache = new Map<string, Messages>();

export function normalizeEmailLocale(locale: string | null | undefined, brand?: ProductBrand): RoboLocale {
  const l = (locale ?? '').trim();
  const known = (EMAIL_LOCALES as readonly string[]).includes(l) ? (l as RoboLocale) : null;
  if (brand) {
    if (known && brand.locales.includes(known)) return known;
    return brand.defaultLocale;
  }
  return known ?? 'en';
}

/** Merged messages for a locale (memoized). */
export function loadEmailMessages(locale: RoboLocale): Messages {
  const hit = cache.get(locale);
  if (hit) return hit;
  const dir = emailI18nDir();
  const english = loadEnglishWithStaging(dir);
  const merged = locale === 'en' ? english : mergeMessages(english, readJson(path.join(dir, `${locale}.json`)));
  cache.set(locale, merged);
  return merged;
}

function lookup(messages: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

// ── ICU subset ───────────────────────────────────────────────────────────

type Node =
  | { t: 'text'; v: string }
  | { t: 'arg'; name: string }
  | { t: 'pound' }
  | { t: 'plural'; name: string; cases: Record<string, Node[]> }
  | { t: 'select'; name: string; cases: Record<string, Node[]> };

class Parser {
  i = 0;
  constructor(readonly src: string) {}

  parse(inPlural: boolean, untilBrace: boolean): Node[] {
    const nodes: Node[] = [];
    let text = '';
    const pushText = () => {
      if (text) nodes.push({ t: 'text', v: text });
      text = '';
    };
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === "'") {
        const next = this.src[this.i + 1];
        if (next === "'") {
          text += "'";
          this.i += 2;
          continue;
        }
        if (next === '{' || next === '}' || (inPlural && next === '#')) {
          const end = this.src.indexOf("'", this.i + 1);
          if (end === -1) throw new Error('unterminated quote');
          text += this.src.slice(this.i + 1, end);
          this.i = end + 1;
          continue;
        }
        text += ch;
        this.i += 1;
        continue;
      }
      if (ch === '}') {
        if (!untilBrace) throw new Error(`unexpected } at ${this.i}`);
        pushText();
        return nodes;
      }
      if (ch === '#' && inPlural) {
        pushText();
        nodes.push({ t: 'pound' });
        this.i += 1;
        continue;
      }
      if (ch === '{') {
        pushText();
        this.i += 1;
        nodes.push(this.parseArgument());
        continue;
      }
      text += ch;
      this.i += 1;
    }
    if (untilBrace) throw new Error('unterminated {');
    pushText();
    return nodes;
  }

  private readUntil(stops: string): string {
    const start = this.i;
    while (this.i < this.src.length && !stops.includes(this.src[this.i]!)) this.i += 1;
    return this.src.slice(start, this.i).trim();
  }

  private parseArgument(): Node {
    const name = this.readUntil(',}');
    if (!/^[A-Za-z_][\w.]*$/.test(name)) throw new Error(`invalid argument name "${name}"`);
    if (this.src[this.i] === '}') {
      this.i += 1;
      return { t: 'arg', name };
    }
    this.i += 1; // ','
    const type = this.readUntil(',}');
    if (type !== 'plural' && type !== 'select') {
      throw new Error(`unsupported argument type "${type}"`);
    }
    if (this.src[this.i] !== ',') throw new Error(`missing cases for ${name}`);
    this.i += 1;
    const cases: Record<string, Node[]> = {};
    for (;;) {
      while (/\s/.test(this.src[this.i] ?? '')) this.i += 1;
      if (this.src[this.i] === '}') {
        this.i += 1;
        break;
      }
      const sel = this.readUntil('{}');
      if (!sel || this.src[this.i] !== '{') throw new Error(`invalid case in ${name}`);
      this.i += 1;
      cases[sel] = this.parse(type === 'plural', true);
      this.i += 1; // closing '}' of the case
    }
    if (!cases.other) throw new Error(`${type} for ${name} needs an "other" case`);
    return { t: type, name, cases };
  }
}

const astCache = new Map<string, Node[]>();

export function parseMessage(pattern: string): Node[] {
  const hit = astCache.get(pattern);
  if (hit) return hit;
  const nodes = new Parser(pattern).parse(false, false);
  astCache.set(pattern, nodes);
  return nodes;
}

/** True when `pattern` parses under the supported ICU subset. */
export function isValidMessage(pattern: string): boolean {
  try {
    parseMessage(pattern);
    return true;
  } catch {
    return false;
  }
}

export function intlLocale(locale: RoboLocale): string {
  return locale === 'zh' ? 'zh-CN' : locale;
}

export type MessageParams = Record<string, string | number | Date | null | undefined>;

function formatValue(value: MessageParams[string], locale: RoboLocale): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return new Intl.NumberFormat(intlLocale(locale)).format(value);
  if (value instanceof Date) {
    return new Intl.DateTimeFormat(intlLocale(locale), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(value);
  }
  return String(value);
}

function render(nodes: Node[], params: MessageParams, locale: RoboLocale, pound: number | null): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += n.v;
        break;
      case 'pound':
        out += pound === null ? '#' : new Intl.NumberFormat(intlLocale(locale)).format(pound);
        break;
      case 'arg':
        out += formatValue(params[n.name], locale);
        break;
      case 'plural': {
        const num = Number(params[n.name] ?? 0);
        const exact = n.cases[`=${num}`];
        const cat = new Intl.PluralRules(intlLocale(locale)).select(num);
        out += render(exact ?? n.cases[cat] ?? n.cases.other!, params, locale, num);
        break;
      }
      case 'select': {
        const v = String(params[n.name] ?? 'other');
        out += render(n.cases[v] ?? n.cases.other!, params, locale, pound);
        break;
      }
    }
  }
  return out;
}

/** Substitute `%BRAND%` / `%OTHER_BRAND%`. */
export function substituteBrand(text: string, brand: ProductBrand): string {
  return text.replaceAll('%BRAND%', brand.name).replaceAll('%OTHER_BRAND%', getBrand(brand.otherBrand).name);
}

export function formatMessage(pattern: string, params: MessageParams, locale: RoboLocale): string {
  return render(parseMessage(pattern), params, locale, null);
}

export interface EmailTranslator {
  locale: RoboLocale;
  brand: ProductBrand;
  (key: string, params?: MessageParams): string;
  has(key: string): boolean;
}

/** `t(key, params)` for one brand × locale; throws EmailI18nError on a missing key. */
export function createEmailTranslator(brand: ProductBrand, locale: string | null | undefined): EmailTranslator {
  const loc = normalizeEmailLocale(locale, brand);
  const messages = loadEmailMessages(loc);
  const t = ((key: string, params: MessageParams = {}) => {
    const pattern = lookup(messages, key);
    if (pattern === undefined) throw new EmailI18nError(`Missing email string "${key}"`, key);
    return substituteBrand(formatMessage(pattern, params, loc), brand);
  }) as EmailTranslator;
  t.locale = loc;
  t.brand = brand;
  t.has = (key: string) => lookup(messages, key) !== undefined;
  return t;
}
