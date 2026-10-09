// server/src/features/match/pii.ts
//
// Narrow adapter: strip personal data from a resume before it goes into the
// scorer prompt (ARCHITECTURE.md §4.7: "resume markdown, PII-stripped: name,
// email, phone and address removed"; TASK_PLAN.md §2.2: no photo, 籍贯,
// 政治面貌, gender, birth date or family members in any prompt).
//
// WP-15 owns the shared redactor (`server/src/platform/pii/redact.ts`), built
// in the same wave. Until it merges this module is the scorer's own,
// deliberately conservative stripper; INT switches `stripResumeForScoring`
// to call `redact()` and keeps these tests as the scorer's contract (handoff
// request to WP-15/INT).

const REMOVED = '[removed]';

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL = /\b(?:https?:\/\/|www\.)\S+/giu;
// Phone numbers: +country, separators, 7+ digits overall (dates like 2019-2023 are too short).
const PHONE = /(?<![\p{N}])(?:\+?\d[\d\s().\-]{6,}\d)(?![\p{N}])/gu;
// PRC resident ID (18), Taiwan national ID, US SSN.
const PRC_ID = /(?<![\p{N}])\d{17}[\dXx](?![\p{N}])/gu;
const TW_ID = /(?<![\p{L}\p{N}])[A-Z][12]\d{8}(?![\p{N}])/gu;
const SSN = /(?<![\p{N}])\d{3}-\d{2}-\d{4}(?![\p{N}])/gu;

/** Lines that carry fields no prompt may contain (labels in en / zh / zh-TW). */
const SENSITIVE_LINE_LATIN =
  /(?:^|[\s|•·*#>-])(?:gender|sex|date of birth|birth ?date|dob|age|marital status|nationality|religion|ethnicity|race|photo|address|home address)\s*[:：]/iu;
// CJK labels may carry a suffix before the colon (出生年月：, 家庭住址：).
const SENSITIVE_LINE_CJK =
  /(?:性别|性別|出生|生日|年龄|年齡|籍贯|籍貫|政治面貌|民族|婚姻|婚否|宗教|照片|家庭成员|家庭成員|住址|地址|身份证|身分證)[^:：\n]{0,6}[:：]/u;
const SENSITIVE_LINE = { test: (line: string) => SENSITIVE_LINE_LATIN.test(line) || SENSITIVE_LINE_CJK.test(line) };
const IMAGE = /!\[[^\]]*\]\([^)]*\)/gu;

/** A phone-shaped run is a phone only with 9–15 digits and no year-month pattern (resume dates). */
function phoneOrKeep(match: string): string {
  const digits = match.replace(/\D/g, '').length;
  if (digits < 9 || digits > 15) return match;
  if (/(?:19|20)\d{2}\s*[./年-]\s*\d{1,2}(?!\d{2,})/u.test(match) && !match.trim().startsWith('+')) return match;
  return REMOVED;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove contact details, ID numbers, images and sensitive-field lines; also
 * the person's name when known (profile names) and a leading `# Name` line.
 */
export function stripResumeForScoring(markdown: string, options: { names?: Array<string | null | undefined> } = {}): string {
  let text = markdown.replace(/\r\n?/g, '\n');
  text = text.replace(IMAGE, '');
  const lines = text.split('\n').filter((line) => !SENSITIVE_LINE.test(line));
  // A leading `# Name` heading (the resume's first heading, short, no digits) is the name.
  const first = lines.findIndex((l) => l.trim().length > 0);
  if (first >= 0 && /^#{1,2}\s+[^\d#]{2,60}$/u.test(lines[first]!.trim())) lines[first] = `# ${REMOVED}`;
  text = lines.join('\n');
  text = text.replace(EMAIL, REMOVED).replace(URL, REMOVED).replace(SSN, REMOVED).replace(PRC_ID, REMOVED).replace(TW_ID, REMOVED).replace(PHONE, phoneOrKeep);
  for (const pattern of namePatterns(options.names ?? [])) text = text.replace(pattern, REMOVED);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const HAN = /\p{Script=Han}/u;

/**
 * Regexes for the known names, longest first.
 * - Latin-script names match whole words only, so a short surname (He, Li,
 *   Ma, Wu, Ng, Al) never eats "the", "Helm" or "machine".
 * - Names with Han characters match as written (CJK has no word spaces) and
 *   also with the spaces removed in both orders ("伟 何" → 何伟 / 伟何).
 *   A single Han character is never matched on its own (it would strip 如何).
 */
export function namePatterns(names: Array<string | null | undefined>): RegExp[] {
  const forms = new Set<string>();
  for (const raw of names) {
    const n = raw?.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!n) continue;
    forms.add(n);
    if (HAN.test(n) && n.includes(' ')) {
      const parts = n.split(' ');
      forms.add(parts.join(''));
      forms.add([...parts].reverse().join(''));
    }
  }
  return [...forms]
    .filter((f) => [...f.replace(/\s/g, '')].length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((f) =>
      HAN.test(f)
        ? new RegExp(escapeRegExp(f), 'gu')
        : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(f).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu'),
    );
}
