// server/src/platform/pii/redact.ts
//
// Deterministic PII redaction (TASK_PLAN.md WP-15, CN_TW_LAUNCH_PLAN.md
// WP-RESIDENCY, ruling H6). Pure functions, no I/O, no LLM.
//
// Two jobs use it:
//   1. Storage (GoApply CN-0): parsed resume text is redacted BEFORE it is
//      stored — PRC ID numbers (and other government IDs) and health details
//      never reach the database while GoApply runs offshore
//      (`platform/residency/uploadPolicy.ts` picks the kinds).
//   2. Prompts (both brands): resume text sent to a model is stripped of
//      contact details and government IDs (`LLM_PII_KINDS`; WP-18 and the
//      other prompt builders call `redactPii(text, { kinds: LLM_PII_KINDS })`).
//
// Kinds: email, phone (CN / TW / NANP / international), address (labelled
// values plus street-level patterns in en / zh / zh-TW), prc_id (PRC resident
// ID, 18-digit and labelled 15-digit), tw_id (TW national ID and resident
// certificate numbers), us_ssn, gov_id (labelled passport, 港澳/台胞 travel
// permit and military ID numbers), health (labelled health fields and a short
// list of unambiguous personal-health phrases), plus caller-supplied
// `knownValues` (e.g. the person's name; Latin-script values match whole
// words only, so "Li" never removes the start of "Linux").
//
// Detection is pattern based. It prefers removing a little too much over
// leaving a government ID in place: an 18-digit number with a valid birth
// date is treated as a PRC ID even when its check digit is wrong (a typo is
// still someone's ID).

export type PiiKind =
  | 'email'
  | 'phone'
  | 'address'
  | 'prc_id'
  | 'tw_id'
  | 'us_ssn'
  | 'gov_id'
  | 'health'
  | 'known_value';

export const ALL_PII_KINDS: readonly PiiKind[] = [
  'email',
  'phone',
  'address',
  'prc_id',
  'tw_id',
  'us_ssn',
  'gov_id',
  'health',
  'known_value',
];

/** Government identity numbers. */
export const GOVERNMENT_ID_KINDS: readonly PiiKind[] = ['prc_id', 'tw_id', 'us_ssn', 'gov_id'];

/**
 * What a prompt that carries resume text must not contain (ARCHITECTURE.md
 * §10 "PII to LLMs": name, email, phone and address; plus IDs and health).
 * Pass the person's name through `knownValues`.
 */
export const LLM_PII_KINDS: readonly PiiKind[] = [
  'email',
  'phone',
  'address',
  'prc_id',
  'tw_id',
  'us_ssn',
  'gov_id',
  'health',
  'known_value',
];

/**
 * What GoApply may not store while it runs offshore (CN-0): government IDs
 * and health details. Contact details stay — the person needs them on the
 * resume they send to employers.
 */
export const CN0_STORAGE_PII_KINDS: readonly PiiKind[] = ['prc_id', 'tw_id', 'us_ssn', 'gov_id', 'health'];

export type RedactionMarkerLocale = 'en' | 'zh' | 'zh-TW';

const MARKERS: Record<RedactionMarkerLocale, Record<PiiKind, string>> = {
  en: {
    email: '[email removed]',
    phone: '[phone removed]',
    address: '[address removed]',
    prc_id: '[ID number removed]',
    tw_id: '[ID number removed]',
    us_ssn: '[ID number removed]',
    gov_id: '[ID number removed]',
    health: '[health details removed]',
    known_value: '[removed]',
  },
  zh: {
    email: '[已移除邮箱]',
    phone: '[已移除电话]',
    address: '[已移除地址]',
    prc_id: '[已移除证件号]',
    tw_id: '[已移除证件号]',
    us_ssn: '[已移除证件号]',
    gov_id: '[已移除证件号]',
    health: '[已移除健康信息]',
    known_value: '[已移除]',
  },
  'zh-TW': {
    email: '[已移除電子郵件]',
    phone: '[已移除電話]',
    address: '[已移除地址]',
    prc_id: '[已移除證件號碼]',
    tw_id: '[已移除證件號碼]',
    us_ssn: '[已移除證件號碼]',
    gov_id: '[已移除證件號碼]',
    health: '[已移除健康資訊]',
    known_value: '[已移除]',
  },
};

/** The default marker for a kind in a locale. */
export function redactionMarker(kind: PiiKind, locale: RedactionMarkerLocale = 'en'): string {
  return (MARKERS[locale] ?? MARKERS.en)[kind];
}

/** Map any app locale to a marker locale (zh-TW keeps traditional script; other zh → simplified). */
export function markerLocaleFor(locale: string | null | undefined): RedactionMarkerLocale {
  const l = (locale ?? '').trim().toLowerCase();
  if (l === 'zh-tw' || l === 'zh-hant' || l === 'zh-hk' || l === 'zh-mo') return 'zh-TW';
  if (l === 'zh' || l.startsWith('zh-')) return 'zh';
  return 'en';
}

export interface RedactOptions {
  /** Kinds to remove (default: every kind). */
  kinds?: readonly PiiKind[];
  /** Locale of the built-in markers (default 'en'). */
  markerLocale?: RedactionMarkerLocale;
  /** Custom marker; overrides `markerLocale`. */
  marker?: (kind: PiiKind) => string;
  /** Exact strings to remove wherever they appear (case-insensitive), e.g. the person's name. */
  knownValues?: ReadonlyArray<string | null | undefined>;
}

export type PiiCounts = Record<PiiKind, number>;

export interface RedactResult {
  text: string;
  counts: PiiCounts;
  /** Total replacements. */
  total: number;
}

function emptyCounts(): PiiCounts {
  return { email: 0, phone: 0, address: 0, prc_id: 0, tw_id: 0, us_ssn: 0, gov_id: 0, health: 0, known_value: 0 };
}

// ── Validators ───────────────────────────────────────────────────────────

const PRC_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const PRC_CHECK = '10X98765432';

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

/** True for a structurally valid 18-character PRC resident ID with a correct check digit. */
export function isValidPrcId(raw: string): boolean {
  const id = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[1-8]\d{16}[\dX]$/.test(id)) return false;
  if (!validDate(Number(id.slice(6, 10)), Number(id.slice(10, 12)), Number(id.slice(12, 14)))) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(id[i]) * PRC_WEIGHTS[i]!;
  return PRC_CHECK[sum % 11] === id[17];
}

const TW_LETTER_CODES: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};

/** True for a TW national ID / new-format resident certificate number with a correct check digit. */
export function isValidTwNationalId(raw: string): boolean {
  const id = raw.trim().toUpperCase();
  if (!/^[A-Z][1289]\d{8}$/.test(id)) return false;
  const code = TW_LETTER_CODES[id[0]!]!;
  const digits = [Math.floor(code / 10), code % 10, ...id.slice(1).split('').map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0);
  return sum % 10 === 0;
}

// ── Patterns ─────────────────────────────────────────────────────────────
// Every pattern is global; boundaries are explicit look-arounds so CJK text
// (no spaces) works and digits are never cut out of a longer number.

const NOT_ALNUM_BEFORE = '(?<![0-9A-Za-z])';
const NOT_ALNUM_AFTER = '(?![0-9A-Za-z])';

/** 18-digit PRC ID (6 + 8 + 4, optional single space/hyphen between groups). */
const PRC_ID_18 = new RegExp(
  `${NOT_ALNUM_BEFORE}[1-8]\\d{5}[ -]?(?:18|19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])[ -]?\\d{3}[\\dXx]${NOT_ALNUM_AFTER}`,
  'g',
);

/**
 * Labels of other government ID documents (zh / zh-TW / en): passports,
 * Hong Kong–Macau and Taiwan travel permits, military IDs. Their numbers are
 * `gov_id`.
 */
const DOC_ID_LABEL =
  '(?:护照(?:号码|号)?|護照(?:號碼|號)?|(?:往来)?港澳通行证(?:号码|号)?|(?:往來)?港澳通行證(?:號碼|號)?|' +
  '台胞证(?:号码|号)?|台胞證(?:號碼|號)?|大陆居民往来台湾通行证|军官证(?:号码|号)?|軍官證(?:號碼|號)?|' +
  '(?<![A-Za-z])passport(?:\\s*(?:no\\.?|number|#))?)';

/** ID-number labels (zh / zh-TW / en). The value after them is removed whatever its shape. */
const ID_LABEL =
  '(?:身份证(?:号码|号)?|身份證(?:號碼|號)?|身分證(?:字號|號碼|號)?|居民身份证|证件号码|證件號碼|证件号|居留证号|居留證號|' +
  DOC_ID_LABEL +
  '|(?<![A-Za-z])(?:(?:national|resident|citizen)\\s+id(?:\\s*(?:no\\.?|number|#))?|id\\s*(?:no\\.?|number|#)|id\\s+card(?:\\s+(?:no\\.?|number))?))';
const DOC_ID_LABEL_ONLY = new RegExp(`^${DOC_ID_LABEL}$`, 'i');
const LABELLED_ID = new RegExp(
  // Optional "南字第" style prefix (military ID numbers).
  `(${ID_LABEL})(\\s*[:：#]?\\s*)((?:[\\u4e00-\\u9fa5]{1,2}字第)?[0-9A-Za-z](?:[0-9A-Za-z]|[ -](?=\\d)){5,21})${NOT_ALNUM_AFTER}`,
  'gi',
);

/** TW national ID (A123456789), new resident certificate (A800000014), old ARC (AB12345678). */
const TW_ID = new RegExp(`${NOT_ALNUM_BEFORE}[A-Z][1289A-D]\\d{8}${NOT_ALNUM_AFTER}`, 'g');

/** US SSN with a separator; area 000/666/9xx, group 00 and serial 0000 never issued. */
const SSN_SEPARATED = /(?<![\d-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/g;
const SSN_LABELLED = /((?:SSN|Social\s+Security(?:\s+(?:Number|No\.?|#))?)\s*[:#]?\s*)(\d{9})(?!\d)/gi;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** +CC international numbers (8–15 digits). */
const PHONE_INTL = /(?<![\w+])\+[1-9]\d{0,2}(?:[\s.-]?\(?\d{1,4}\)?){2,6}(?!\d)/g;
/** Mainland mobile, optional 86 / 0086 prefix. */
const PHONE_CN_MOBILE = /(?<![\d+])(?:(?:00)?86[\s-]?)?1[3-9]\d(?:[\s-]?\d{4}){2}(?!\d)/g;
/** Taiwan mobile 09xx-xxx-xxx. */
const PHONE_TW_MOBILE = /(?<![\d+])09\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g;
/** Landline with a trunk 0 (CN 010-12345678, TW 02-2345-6789, (021) 1234 5678). */
const PHONE_LANDLINE = /(?<![\d+])(?:\(0\d{1,3}\)\s?|0\d{1,3}[\s-])\d{3,4}[\s-]?\d{4}(?!\d)/g;
/** NANP (US/CA): (415) 555-2671, 415-555-2671, 415.555.2671, 4155552671, +1 … */
const PHONE_NANP = /(?<![\d+])(?:1[\s.-]?)?(?:\([2-9]\d{2}\)\s?|[2-9]\d{2}[\s.-]?)[2-9]\d{2}[\s.-]?\d{4}(?!\d)/g;

/** Labelled address values (to the end of the field). */
const ADDRESS_LABEL =
  '(?:(?:家庭|通讯|通訊|联系|聯絡|居住|户籍|戶籍|现居|現居|现住|現住|通信|邮寄|郵寄)?(?:地址|住址)|' +
  '(?<![A-Za-z][ \\t]?)(?:(?:home|mailing|street|postal|residential|current|permanent)\\s+)?address)';
const FIELD_END = '(?=\\s{2,}|\\s*[|｜;；]|\\s+[\\u4e00-\\u9fa5A-Za-z]{1,10}[:：]|$)';
const LABELLED_ADDRESS = new RegExp(`(${ADDRESS_LABEL})(\\s*[:：]\\s*)([^\\n|｜;；]+?)${FIELD_END}`, 'gim');

/** US street address with optional unit and "City, ST 12345". */
const ADDRESS_US = new RegExp(
  '(?<![\\w])\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z][A-Za-z0-9\'.-]*\\s+){1,4}' +
    '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Highway|Hwy|Circle|Cir)\\b\\.?' +
    '(?:,?\\s+(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?\\s*[A-Za-z0-9-]+)?' +
    '(?:,\\s*[A-Z][A-Za-z .\'-]+,\\s*[A-Z]{2}\\s+\\d{5}(?:-\\d{4})?)?',
  'g',
);

/**
 * Street-level Chinese address: road + number + 号/號, with TW 段/巷/弄/之
 * and a trailing floor/room. Province/city/district names stay (city level is
 * not a precise address).
 */
const ADDRESS_ZH = new RegExp(
  '[^\\s\\d省市区區县縣镇鎮乡鄉，,。:：;；()（）在于於住到位]{1,6}(?:路|街|大道|巷|弄|胡同)' +
    '(?:[0-9一二三四五六七八九十]+段)?(?:\\d+巷)?(?:\\d+弄)?\\d+(?:[-之]\\d+)?[号號]' +
    '(?:[A-Za-z0-9\\u4e00-\\u9fa5-]{0,12}?\\d+(?:室|楼|樓|层|層|F|f)(?:之\\d+)?)?',
  'g',
);

/** Labelled health fields: the value is removed. */
const HEALTH_LABEL =
  '(?:健康状况|健康狀況|健康情况|健康情況|身体状况|身體狀況|身体情况|身體情況|既往病史|病史|疾病史|残疾情况|殘疾情況|残疾类别|' +
  '身心障礙|殘障|血型|婚育状况|婚育狀況|生育状况|生育狀況|' +
  '(?<![A-Za-z][ \\t]?)(?:health(?:\\s+(?:status|condition|conditions))?|medical\\s+(?:history|conditions?)|disability\\s+status|pregnancy(?:\\s+status)?|blood\\s+type))';
const LABELLED_HEALTH = new RegExp(`(${HEALTH_LABEL})(\\s*[:：]\\s*)([^\\n|｜;；]+?)${FIELD_END}`, 'gim');

/** Unambiguous personal-health phrases; the clause that contains one is removed. */
const HEALTH_TERMS =
  '(?:乙肝|乙型肝炎|大三阳|大三陽|小三阳|小三陽|艾滋病(?:病毒)?(?:携带|攜帶|感染)|HIV\\s*(?:阳性|陽性|携带|攜帶)|梅毒|肺结核|肺結核|癫痫|癲癇|抑郁症|憂鬱症|精神病史|' +
  '怀孕|懷孕|已孕|备孕|備孕|孕期|残疾证|殘疾證|身心障礙證明|殘障手冊|' +
  'HIV[- ]positive|hepatitis\\s+[BC]\\b|tuberculosis|epilepsy|\\bpregnan(?:t|cy)\\b|diagnosed\\s+with)';
const HEALTH_CLAUSE = new RegExp(`[^。！？!?；;\\n]*${HEALTH_TERMS}[^。！？!?；;\\n]*`, 'gi');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Latin letters (incl. accented) and digits: the characters a Latin-script word is made of. */
const LATIN_WORD_CHAR = /[A-Za-z0-9\u00C0-\u024F]/;
const LATIN_WORD_CLASS = 'A-Za-z0-9\\u00C0-\\u024F';

/**
 * Case-insensitive global pattern for one caller-supplied value. An edge that
 * is a Latin letter or digit must sit on a word boundary ("Li" matches
 * "Li Wei" and "李 Li", never "Linux"); a CJK edge matches anywhere, since CJK
 * text has no spaces between words. Null for values shorter than 2 characters.
 */
export function knownValuePattern(value: string): RegExp | null {
  const v = (value ?? '').trim();
  if (v.length < 2) return null;
  const before = LATIN_WORD_CHAR.test(v[0]!) ? `(?<![${LATIN_WORD_CLASS}])` : '';
  const after = LATIN_WORD_CHAR.test(v[v.length - 1]!) ? `(?![${LATIN_WORD_CLASS}])` : '';
  return new RegExp(`${before}${escapeRegExp(v)}${after}`, 'gi');
}

function digitsIn(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

// ── Engine ───────────────────────────────────────────────────────────────

/** Redact `text` and report what was removed. Never throws for string input. */
export function redactPii(text: string, options: RedactOptions = {}): RedactResult {
  const kinds = new Set<PiiKind>(options.kinds ?? ALL_PII_KINDS);
  const markerLocale = options.markerLocale ?? 'en';
  const mark = options.marker ?? ((k: PiiKind) => redactionMarker(k, markerLocale));
  const counts = emptyCounts();
  if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', counts, total: 0 };

  // Markers must not be re-detected by later passes; protect them as opaque tokens.
  const placeholders: string[] = [];
  const hold = (kind: PiiKind): string => {
    counts[kind] += 1;
    placeholders.push(mark(kind));
    return `\u0000${placeholders.length - 1}\u0000`;
  };
  const has = (k: PiiKind) => kinds.has(k);
  let out = text;

  if (has('known_value') && options.knownValues?.length) {
    const values = [...new Set(options.knownValues.map((v) => (v ?? '').trim()).filter((v) => v.length >= 2))].sort(
      (a, b) => b.length - a.length,
    );
    for (const v of values) {
      const re = knownValuePattern(v);
      if (re) out = out.replace(re, () => hold('known_value'));
    }
  }

  // Labelled IDs first: the label says what the value is, whatever its shape.
  if (has('prc_id') || has('tw_id') || has('us_ssn') || has('gov_id')) {
    out = out.replace(LABELLED_ID, (whole, label: string, sep: string, value: string) => {
      const compact = value.replace(/[\s-]/g, '');
      const kind = labelledIdKind(label, compact);
      if (!has(kind) || digitsIn(compact) < 6) return whole;
      return `${label}${sep}${hold(kind)}`;
    });
  }
  if (has('prc_id')) out = out.replace(PRC_ID_18, () => hold('prc_id'));
  if (has('tw_id')) out = out.replace(TW_ID, () => hold('tw_id'));
  if (has('us_ssn')) {
    out = out.replace(SSN_LABELLED, (_w, label: string) => `${label}${hold('us_ssn')}`);
    out = out.replace(SSN_SEPARATED, () => hold('us_ssn'));
  }

  if (has('email')) out = out.replace(EMAIL, () => hold('email'));

  if (has('address')) {
    out = out.replace(LABELLED_ADDRESS, (whole, label: string, sep: string, value: string) =>
      value.trim() ? `${label}${sep}${hold('address')}` : whole,
    );
    out = out.replace(ADDRESS_ZH, () => hold('address'));
    out = out.replace(ADDRESS_US, () => hold('address'));
  }

  if (has('phone')) {
    out = out.replace(PHONE_INTL, (m) => {
      const n = digitsIn(m);
      return n >= 8 && n <= 15 ? hold('phone') : m;
    });
    out = out.replace(PHONE_CN_MOBILE, () => hold('phone'));
    out = out.replace(PHONE_TW_MOBILE, () => hold('phone'));
    out = out.replace(PHONE_LANDLINE, () => hold('phone'));
    out = out.replace(PHONE_NANP, () => hold('phone'));
  }

  if (has('health')) {
    out = out.replace(LABELLED_HEALTH, (whole, label: string, sep: string, value: string) =>
      value.trim() ? `${label}${sep}${hold('health')}` : whole,
    );
    out = out.replace(HEALTH_CLAUSE, (m) => {
      const lead = /^\s*/.exec(m)?.[0] ?? '';
      return `${lead}${hold('health')}`;
    });
  }

  // eslint-disable-next-line no-control-regex
  const restored = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => placeholders[Number(i)] ?? '');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: restored, counts, total };
}

/** Convenience: the redacted text only. */
export function redactText(text: string, options: RedactOptions = {}): string {
  return redactPii(text, options).text;
}

/** Which kinds are present in `text` (nothing is changed). */
export function detectPii(text: string, kinds: readonly PiiKind[] = ALL_PII_KINDS): PiiKind[] {
  const { counts } = redactPii(text, { kinds });
  return (Object.keys(counts) as PiiKind[]).filter((k) => counts[k] > 0);
}

/** Object keys whose value is itself a health detail (e.g. `otherSections["健康状况"]`). */
const HEALTH_KEY = new RegExp(`^\\s*${HEALTH_LABEL}\\s*$`, 'i');
/** Object keys whose value is itself a government ID. */
const ID_KEY = new RegExp(`^\\s*${ID_LABEL}\\s*$`, 'i');

/** Kind of a labelled ID value: travel documents are gov_id; a TW-shaped number tw_id; else prc_id. */
function labelledIdKind(label: string, compact: string): PiiKind {
  if (DOC_ID_LABEL_ONLY.test(label.trim())) return 'gov_id';
  return /^[A-Z][1289A-D]\d{8}$/i.test(compact) ? 'tw_id' : 'prc_id';
}

export interface RedactDeepResult<T> {
  value: T;
  counts: PiiCounts;
  total: number;
}

/**
 * Redact every string inside a JSON-like value (arrays and plain objects are
 * copied, never mutated). A key that names a health field or an ID field has
 * its whole string value replaced, since the value alone ("良好", "A+") does
 * not look like PII.
 */
export function redactDeep<T>(value: T, options: RedactOptions = {}): RedactDeepResult<T> {
  const kinds = new Set<PiiKind>(options.kinds ?? ALL_PII_KINDS);
  const markerLocale = options.markerLocale ?? 'en';
  const mark = options.marker ?? ((k: PiiKind) => redactionMarker(k, markerLocale));
  const counts = emptyCounts();

  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') {
      if (key !== null && v.trim()) {
        if (kinds.has('health') && HEALTH_KEY.test(key)) {
          counts.health += 1;
          return mark('health');
        }
        if (ID_KEY.test(key)) {
          const kind = labelledIdKind(key, v.replace(/[\s-]/g, ''));
          if (kinds.has(kind)) {
            counts[kind] += 1;
            return mark(kind);
          }
        }
      }
      const r = redactPii(v, options);
      for (const k of Object.keys(r.counts) as PiiKind[]) counts[k] += r.counts[k];
      return r.text;
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, null));
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = walk(inner, k);
      return out;
    }
    return v;
  };

  const result = walk(value, null) as T;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { value: result, counts, total };
}
