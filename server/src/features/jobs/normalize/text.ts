// server/src/features/jobs/normalize/text.ts
//
// Text helpers for the normalizers: control-character stripping (Postgres
// rejects NUL in TEXT), HTML → plain text, and the title / company name
// normalization used for dedupe keys, company upserts and search text.
//
// Title normalization keeps level words ("Senior", "II", 高级): two postings
// that differ only in level are different jobs and must not share a dedupe
// key. It removes what is noise for identity: case and width, bracketed
// location / work-model / gender / requisition notes, a trailing
// " - <place or work model>" segment, and hiring slogans (急招, "Urgent").

import { CITIES, SUBDIVISIONS, citiesNamed, countryByName, statedWorkModel } from '../geo/index.js';

/** Remove C0 control characters except tab, newline and carriage return. */
export function stripControl(input: string): string {
  let out = '';
  for (let k = 0; k < input.length; k += 1) {
    const c = input.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13 || c > 31) out += input[k];
  }
  return out;
}

/** NFKC, control characters removed, trimmed. Null/undefined → ''. */
export function cleanText(input: string | null | undefined): string {
  if (!input) return '';
  return stripControl(String(input).normalize('NFKC')).trim();
}

/**
 * Text kept as its author wrote it, for display: control characters removed
 * and trimmed, canonical composition only (NFC). Unlike `cleanText` it does
 * not fold compatibility forms, so Chinese full-width punctuation ("：", "，",
 * "（）") stays what the posting used. Parsing still reads the NFKC form.
 */
export function asWritten(input: string | null | undefined): string {
  if (!input) return '';
  return stripControl(String(input).normalize('NFC')).trim();
}

/** A trimmed, cleaned string or null when empty. */
export function cleanOrNull(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = cleanText(input);
  return s ? s : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower];
    if (lower.startsWith('#x')) {
      const n = parseInt(lower.slice(2), 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    if (lower.startsWith('#')) {
      const n = parseInt(lower.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

const looksLikeHtml = (s: string) => /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(s);

/** HTML (or plain text) → plain text with paragraph and list breaks kept. */
export function htmlToPlain(input: string | null | undefined): string {
  const s = cleanText(input);
  if (!s) return '';
  if (!looksLikeHtml(s) && !/&[a-z#0-9]+;/i.test(s)) return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  let out = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  out = decodeEntities(out);
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Titles ─────────────────────────────────────────────────────────────────

const GENDER_NOTE = /^(?:[mwfdhxi*]\s*\/\s*){1,3}[mwfdhxi*]$|^all genders?$|^gn$/i;
const REQ_NOTE = /^(?:req(?:uisition)?|job|id|ref|#)\s*[#:.-]?\s*[a-z0-9-]+$|^#?\d{3,}$/i;
const SLOGANS = /\b(urgent(?:ly)?(?: hiring)?|hiring now|immediate start|hot job)\b|急招|急聘|急徵|急征|诚聘|誠徵|高薪|热招|熱招|直招/gi;
const SLOGAN_TEST = new RegExp(SLOGANS.source, 'i');

/** True when a bracketed / trailing segment is a place, a work model, a gender or requisition note. */
function isTitleNoise(segment: string): boolean {
  const s = segment.trim().replace(/^[-–—:|]+|[-–—:|]+$/g, '').trim();
  if (!s) return true;
  if (GENDER_NOTE.test(s) || REQ_NOTE.test(s)) return true;
  if (statedWorkModel(s) && s.split(/\s+/).length <= 3) return true;
  if (citiesNamed(s).length || countryByName(s)) return true;
  const parts = s.split(/\s*[,/]\s*/).filter(Boolean);
  return parts.length > 1 && parts.every((p) => citiesNamed(p).length > 0 || countryByName(p) !== null || /^[A-Z]{2}$/.test(p) || statedWorkModel(p) !== null);
}

/**
 * Title as stored in RAJob.titleNormalized: lower case, width-folded, noise
 * removed, level words kept, punctuation folded (C++ / C# / .NET kept).
 */
export function normalizeJobTitle(title: string | null | undefined): string {
  let s = cleanText(title);
  if (!s) return '';
  // Bracketed notes that are noise: "(Remote)", "(m/w/d)", "【急招】", "(Req #123)".
  s = s.replace(/[(（[【]([^)）\]】]*)[)）\]】]/g, (m, inner: string) => (isTitleNoise(inner) || SLOGAN_TEST.test(inner) ? ' ' : m));
  s = s.replace(SLOGANS, ' ');
  // Trailing " - Austin, TX" / " | Remote" / " – Hybrid" segments.
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^(.*\S)\s+[-–—|]\s+([^-–—|]+)$/);
    if (!m || !isTitleNoise(m[2])) break;
    s = m[1];
  }
  s = s.toLowerCase().replace(/\.net\b/g, ' dotnet').replace(/node\.js/g, 'nodejs');
  s = s.replace(/[^\p{L}\p{N}+#.]+/gu, ' ');
  s = s.replace(/(^|\s)\.+|\.+(\s|$)/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// ── Companies ──────────────────────────────────────────────────────────────

/** Legal-form suffixes removed from the end of a company name (repeatedly). */
const LEGAL_SUFFIXES = [
  'incorporated', 'inc', 'llc', 'l l c', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'plc', 'gmbh',
  'ag', 'se', 'sa', 's a', 'sas', 's a s', 'sarl', 'srl', 'spa', 's p a', 'bv', 'b v', 'nv', 'n v', 'pty', 'pte',
  'kk', 'k k', 'oy', 'ab', 'as', 'a s', 'lp', 'llp', 'pllc', 'pc', 'holdings', 'holding',
];
const CJK_LEGAL_SUFFIXES = ['股份有限公司', '有限责任公司', '有限責任公司', '有限公司', '株式会社', '股份公司', '公司'];

/** Chinese place names (cities, provinces) that open a branch suffix: 北京分公司, 石家庄分行. */
const CJK_PLACES = new Set(
  [...CITIES.flatMap((c) => [c.zh, c.zhHant]), ...SUBDIVISIONS.flatMap((s) => [s.zh, s.zhHant])].filter((n): n is string => !!n && n.length >= 2 && n.length <= 4),
);

/** "…有限公司北京分公司" → "…有限公司"; "…银行上海分行" → "…银行". Unknown places: two characters. */
function stripBranchSuffix(s: string): string {
  const m = s.match(/^(.+?)分(?:公司|行)$/u);
  if (!m) return s;
  const head = m[1];
  for (const len of [4, 3, 2]) {
    const place = head.slice(-len);
    if (CJK_PLACES.has(place) || CJK_PLACES.has(place.replace(/[市省]$/, ''))) return head.slice(0, -len);
  }
  return /[\p{Script=Han}]{2}$/u.test(head) && head.length > 3 ? head.slice(0, -2) : s;
}

/**
 * Company name as stored in RACompany.nameNormalized / RAJob.companyNameNormalized:
 * lower case, width-folded, bracketed notes ("(深圳)", "(China)") and branch
 * suffixes ("北京分公司") removed, legal forms (Inc, Ltd, 有限公司, 株式会社) removed.
 */
export function normalizeCompanyName(name: string | null | undefined): string {
  let s = cleanText(name);
  if (!s) return '';
  s = s.replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ');
  s = s.replace(/株式会社/g, ' ');
  s = stripBranchSuffix(s);
  for (let changed = true; changed; ) {
    changed = false;
    for (const suf of CJK_LEGAL_SUFFIXES) {
      if (s.length > suf.length + 1 && s.trimEnd().endsWith(suf)) {
        s = s.trimEnd().slice(0, -suf.length);
        changed = true;
      }
    }
  }
  s = s.toLowerCase().replace(/\.com\b/g, ' ').replace(/[^\p{L}\p{N}&]+/gu, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^the\s+/, '');
  for (let changed = true; changed; ) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (s.endsWith(` ${suf}`) && s.length > suf.length + 2) {
        s = s.slice(0, -(suf.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s;
}

// ── URLs ───────────────────────────────────────────────────────────────────

/** An http(s) URL string (credentials and other schemes refused), or null. */
export function safeUrl(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Lower-case host without "www.", or null. */
export function hostOf(input: string | null | undefined): string | null {
  const url = safeUrl(input ?? null);
  if (!url) return null;
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
}

export function truncate(input: string, max: number): string {
  return input.length <= max ? input : input.slice(0, max).trimEnd();
}
