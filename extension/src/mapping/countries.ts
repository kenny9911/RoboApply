// extension/src/mapping/countries.ts — which countries (or regions) a question names.
//
// Work-authorization answers come from the user's own per-country rows. A row
// may answer a question only about that country, so we need to know every
// place a label names, not just the user's countries. Names come from the
// runtime's own region list (Intl.DisplayNames, English and Chinese) plus a
// few common short forms. Longer names are matched first and blanked out, so
// "Papua New Guinea" is not also read as "Guinea".

import { normalizeText } from '../adapters/_kit/options';

interface Entry {
  code: string;
  re: RegExp;
}

/** Short forms the region list does not carry. 'EU' never matches a user row. */
const ALIASES: Array<[string, string]> = [
  ['united states of america', 'US'],
  ['united states', 'US'],
  ['america', 'US'],
  ['usa', 'US'],
  ['the states', 'US'],
  ['uk', 'GB'],
  ['u k', 'GB'],
  ['great britain', 'GB'],
  ['britain', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['northern ireland', 'GB'],
  ['mainland china', 'CN'],
  ['prc', 'CN'],
  ['中国大陆', 'CN'],
  ['大陆', 'CN'],
  ['大陸', 'CN'],
  ['hong kong', 'HK'],
  ['香港', 'HK'],
  ['macau', 'MO'],
  ['macao', 'MO'],
  ['澳门', 'MO'],
  ['澳門', 'MO'],
  ['台湾', 'TW'],
  ['臺灣', 'TW'],
  ['台灣', 'TW'],
  ['south korea', 'KR'],
  ['korea', 'KR'],
  ['uae', 'AE'],
  // Continents name no single country, so they never match a user row.
  ['north america', 'XNA'],
  ['latin america', 'XLA'],
  ['south america', 'XSA'],
  ['eu', 'EU'],
  ['european union', 'EU'],
  ['europe', 'EU'],
  ['eea', 'EU'],
  ['schengen', 'EU'],
  ['欧盟', 'EU'],
  ['歐盟', 'EU'],
];

const CJK = /[㐀-鿿]/;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entry(name: string, code: string): Entry | null {
  const n = normalizeText(name);
  if (n.length < 2) return null;
  // Latin names must stand alone ("oman" is not in "woman"); CJK has no spaces.
  const re = CJK.test(n) ? new RegExp(escape(n), 'u') : new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`, 'u');
  return { code, re };
}

let index: Entry[] | null = null;

function buildIndex(): Entry[] {
  const names = new Map<string, string>();
  const put = (name: string, code: string) => {
    const n = normalizeText(name);
    if (n.length >= 2 && !names.has(n)) names.set(n, code);
  };
  for (const [name, code] of ALIASES) put(name, code);
  for (const locale of ['en', 'zh-Hans', 'zh-Hant']) {
    let dn: Intl.DisplayNames | null = null;
    try {
      dn = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      dn = null;
    }
    if (!dn) continue;
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        if (code === 'ZZ') continue;
        let name: string | undefined;
        try {
          name = dn.of(code);
        } catch {
          name = undefined;
        }
        if (!name || name === code) continue;
        put(name, code);
        // "Myanmar (Burma)" → also "Myanmar"; "Hong Kong SAR China" → also "Hong Kong".
        const short = name.split(/[(（]/)[0].replace(/\s+SAR\b.*$/, '').trim();
        if (short && short !== name) put(short, code);
      }
    }
  }
  const out: Entry[] = [];
  for (const [name, code] of [...names.entries()].sort((x, y) => y[0].length - x[0].length)) {
    const e = entry(name, code);
    if (e) out.push(e);
  }
  return out;
}

/** "U.S." / "US" / "U.S.A." written in capitals (lower-case "us" is a pronoun). */
const US_CAPS = /(?<![A-Za-z])U\.?\s?S\.?(?:\s?A\.?)?(?![A-Za-z])/;

/** ISO-3166 alpha-2 codes (plus 'EU') of every place the label names. */
export function countriesNamed(label: string): Set<string> {
  index ??= buildIndex();
  const found = new Set<string>();
  if (US_CAPS.test(label)) found.add('US');
  let n = normalizeText(label.replace(new RegExp(US_CAPS.source, 'g'), ' '));
  for (const e of index) {
    const m = e.re.exec(n);
    if (!m) continue;
    found.add(e.code);
    n = `${n.slice(0, m.index)}${' '.repeat(m[0].length)}${n.slice(m.index + m[0].length)}`;
  }
  return found;
}

/** A row's country as an alpha-2 code ('UK' is written 'GB' in ISO). */
export function normalizeCountryCode(code: string): string {
  const c = code.trim().toUpperCase();
  return c === 'UK' ? 'GB' : c;
}
