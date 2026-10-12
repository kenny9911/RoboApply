// server/src/features/tools/entries.ts
//
// The requirement rows (WP-22 `keywordReport`) read a resume's job titles and
// dated roles from `###` entry headings — the shape the editor writes
// (`### Company · Title · 2020 – present`). A file a visitor has just
// uploaded never has that shape:
//   - the structured parse (GoHire, or the text model) renders a role as a
//     bold line: `**Title — Company** · March 2022 – Present · City`;
//   - the deterministic text pass keeps the file's own lines:
//       Senior Product Designer — Brightlane Logistics, Portland, OR
//       March 2022 – Present
// so the rows saw no entry at all: "Job title: Not met" for a resume whose
// current job is that title, and "No dated experience found" for ordinary
// date ranges.
//
// `withEntryHeadings` gives the rows a view of the same resume with those
// role lines written as entry headings, date range last. It is used for the
// rows only: the markdown a visitor keeps is never rewritten here. It adds no
// fact — a heading is made only of words and dates already on those lines, and
// a line with no readable date range is left as it is (so the row stays
// "Not listed", never a guess). Pure; no I/O.

/** Mirrors `sectionKeyOf(heading) === 'experience'` in features/resume/check/resumeText.ts (parity-tested). */
const SUMMARY_HEADING = /summary|profile|about|objective|自我评价|个人评价|自我介绍|个人总结|个人简介|个人优势|简介|自我評價|個人簡介/i;
const EXPERIENCE_HEADING = /experience|employment|work history|career|internship|工作经历|工作经验|实习|实践经历|职业经历|工作經歷|實習/i;

export function isExperienceHeading(heading: string): boolean {
  return !SUMMARY_HEADING.test(heading) && EXPERIENCE_HEADING.test(heading);
}

// Sections the reader files under "experience" because of the word, that are
// not jobs: "Volunteer Experience", "Academic Experience", "Leadership
// Experience" (clubs and societies on a graduate's resume), 社会实践经历. The
// years row compares the total with the years of work a posting asks for, so
// their dated lines are not made entries here and add nothing to it.
// Research, teaching and internship sections stay: they are employment on the
// resumes that have them. So does "Professional and Leadership Experience".
const NOT_WORK_HEADING = /volunteer|academic|extracurricular|community|志愿|义工|義工|志工|社会实践|社會實踐|校园|校園|在校|社团|社團/i;
const LEADERSHIP_HEADING = /leadership/i;
const WORK_WORD = /professional|executive|work|employment|career|management/i;

/** An experience section whose dated roles count as years of work. */
export function isWorkHeading(heading: string): boolean {
  if (!isExperienceHeading(heading) || NOT_WORK_HEADING.test(heading)) return false;
  return !LEADERSHIP_HEADING.test(heading) || WORK_WORD.test(heading);
}

// Words that head a section in one resume and label part of a role in another
// ("Achievements:", "Technologies", "Key Projects" under each job). The text
// pass (parse.ts) decides which it is; here such a line is never part of a
// role's heading.
const SUB_LABEL = /^(?:(?:key |notable |major )?achievements|accomplishments|responsibilities|technologies|tech stack|tools|training|courses|activities|qualifications|leadership|(?:selected |personal |academic |side |key )?projects?)[:：]?$/i;
/** The few of them that are common under a role; the others are nearly always sections. */
const ROLE_SUB_LABEL = /^(?:(?:key |notable |major )?achievements|accomplishments|responsibilities|technologies|tech stack|tools|(?:selected |key )?projects?)[:：]?$/i;

export function isSubLabel(line: string): boolean {
  return SUB_LABEL.test(line.trim());
}
export function isRoleSubLabel(line: string): boolean {
  return ROLE_SUB_LABEL.test(line.trim());
}

// ── Dates ──────────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAME = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const YEAR = String.raw`(?:19|20)\d{2}`;
const MONTH_NUM = String.raw`(?:0?[1-9]|1[0-2])`;
/** One date: "March 2022", "2022年3月", "2022.03" / "2022-03(-15)", "03/2022", "2022". */
const POINT = [
  String.raw`${MONTH_NAME},?\s+${YEAR}`,
  String.raw`${YEAR}\s*年\s*${MONTH_NUM}\s*月?`,
  String.raw`${YEAR}\s*[./-]\s*${MONTH_NUM}(?:\s*[./-]\s*\d{1,2})?(?!\d)`,
  String.raw`${MONTH_NUM}\s*/\s*${YEAR}`,
  String.raw`${YEAR}\s*年?`,
].join('|');
const OPEN_END = String.raw`present|current|now|today|ongoing|date|至今|现在|現在|目前|今`;
const RANGE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9])(${POINT})\s*(?:[-–—~〜～]+|\bto\b|\buntil\b|至|到)\s*(${POINT}|${OPEN_END})(?![A-Za-z0-9])`,
  'iu',
);

interface DatePoint {
  year: number;
  /** 1–12, or null when the resume gives the year only. */
  month: number | null;
}

function pointOf(token: string): DatePoint | null {
  const t = token.trim().toLowerCase();
  let m = /^([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[1]!);
    return month >= 0 ? { year: Number(m[2]), month: month + 1 } : null;
  }
  m = /^(\d{4})\s*年\s*(\d{1,2})/.exec(t) ?? /^(\d{4})\s*[./-]\s*(\d{1,2})/.exec(t);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  m = /^(\d{1,2})\s*\/\s*(\d{4})$/.exec(t);
  if (m) return { year: Number(m[2]), month: Number(m[1]) };
  m = /^(\d{4})/.exec(t);
  return m ? { year: Number(m[1]), month: null } : null;
}

const written = (p: DatePoint): string => (p.month === null ? String(p.year) : `${p.year}.${String(p.month).padStart(2, '0')}`);
const ordinal = (p: DatePoint): number => p.year * 12 + ((p.month ?? 1) - 1);

export interface FoundRange {
  /** Where the range sits in the line. */
  index: number;
  length: number;
  /** The same dates in the editor's notation: `2022.03 – present`, `2019 – 2022`. */
  text: string;
}

/** The first date range on a line, or null (one date alone is not a range). */
export function findDateRange(line: string): FoundRange | null {
  const m = RANGE_RE.exec(line);
  if (!m) return null;
  const start = pointOf(m[1]!);
  if (!start) return null;
  const end = pointOf(m[2]!);
  // No date after the dash: it matched one of the "still there" words.
  if (!end) return { index: m.index, length: m[0].length, text: `${written(start)} – present` };
  // An end before the start is not a range. (A year-only end in the start's own year is kept as written.)
  if (end.year < start.year || (end.month !== null && ordinal(end) < ordinal(start))) return null;
  return { index: m.index, length: m[0].length, text: `${written(start)} – ${written(end)}` };
}

// ── Lines ──────────────────────────────────────────────────────────────────

const SEPARATORS = String.raw`[\s·|｜•,，;；:：~\-–—]`;
const EDGE_RE = new RegExp(`^${SEPARATORS}+|${SEPARATORS}+$`, 'g');

/** Text of a role line without markdown emphasis or the separators a removed date left behind. */
function tidy(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/^[*_]+|[*_]+$/g, '')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/\s*[·|｜•]\s*(?:[·|｜•]\s*)+/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_RE, '')
    .trim();
}

const without = (line: string, range: FoundRange): string => tidy(`${line.slice(0, range.index)} ${line.slice(range.index + range.length)}`);
const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;

/** Mirrors the reader's bullet rule (resumeText.ts `BULLET_RE`). */
const BULLET_RE = /^\s*(?:[-*•·]|\d+[.)、])\s+/;
const HEADING_RE = /^#{1,6}\s/;
const BOLD_LEAD_RE = /^\*\*(.+?)\*\*\s*(.*)$/;

const DATED_LINE_MAX = 160;
const HEADER_LINE_MAX = 100;
const HEADER_LINE_MAX_CJK = 40;

const COMPANY_SUFFIX_RE = /\b(?:inc|ltd|llc|co|corp|plc|gmbh|pty|bros|s\.a|l\.l\.c)\.$/i;

/**
 * A short line that can name a role or an employer: not a sentence, not a
 * dated line. ("Brightlane Logistics, Inc." is one; "Led the redesign of the
 * tracking dashboard used by dispatchers." is not.)
 */
function headerLike(raw: string): boolean {
  const t = raw.trim();
  if (!t || findDateRange(t) || isSubLabel(t)) return false;
  if (t.length > (/[㐀-鿿]/.test(t) ? HEADER_LINE_MAX_CJK : HEADER_LINE_MAX)) return false;
  if (/[。！？；;!?,:，：]$/.test(t)) return false;
  // A full stop ends a sentence, except after a company suffix.
  return !/\.$/.test(t) || COMPANY_SUFFIX_RE.test(t);
}

/**
 * `### <who and what> — <dates>`. The reader takes the text around the last
 * dash of a heading as its two dates, so the dates go last, after a dash of
 * their own; a heading without dates carries no dash at all, so that no word
 * of a title or an employer is ever read as a date.
 */
function heading(parts: string[], range: FoundRange | null): string {
  const text = parts.map(tidy).filter(Boolean).join(' · ');
  if (!range) return `### ${text.replace(/\s*[–—]\s*|\s-\s/g, ' · ')}`;
  return `### ${[text, range.text].filter(Boolean).join(' — ')}`;
}

// A dated line that is plainly a degree, a certificate or a membership is not
// a job, whatever section it sits in: a "CREDENTIALS" or "MEMBERSHIPS &
// SERVICE" heading the text pass does not know leaves those lines inside the
// experience section, and they would be counted as years of work. Each pattern
// is narrow on purpose, because a job it wrongly matched would lose its years:
// "Team Member — Target", "Member of Technical Staff", "Scrum Master",
// "Certified Nursing Assistant", "Bootcamp Instructor", "MBA Intern" and
// "Designer — Acme, Boston, MA" are jobs, and none of them match. (The
// reader's own degree test, `educationFrom`, is too wide for this: it reads
// "MA", "BS" and "Master" anywhere on the line.)
const NOT_A_ROLE: RegExp[] = [
  // "Bachelor of Science", "Master's in Design", "Master's degree", "Doctor of Philosophy".
  /\b(?:bachelor|master)(?:'?s)?\s+(?:of|in)\s+\p{L}/iu,
  /\b(?:bachelor|master|doctoral|associate)(?:'?s)?\s+degree\b/i,
  /\bdoctor\s+of\s+(?:philosophy|medicine|education|science|law|business)\b/i,
  /本科|硕士|碩士|学士|學士|大专|专科|專科|博士(?![后後])/,
  // "Google UX Design Certificate", "PMP certification", "Diploma in …", a nanodegree.
  /\bcertificat(?:e|ion)s?\b|\bdiploma\b|\bnanodegree\b|证书|證書|资格证|資格證/i,
  // "Member, AIGA", "Student member of the ACM" — not "Team Member, Target" or "Member of Technical Staff".
  /(?:^|[·|｜,;—–]\s*|\s-\s)(?:(?:student|associate|professional|active|full|life(?:time)?|senior|charter)\s+)?member(?:ship)?(?:\s*(?:$|[,，;；:：·|｜(（—–])|\s+-\s|\s+of\s+(?!(?:the\s+)?(?:technical|founding|engineering|staff)\b))/i,
];
// A degree abbreviation counts only where it opens a line: "B.A. in Design",
// "MBA, State University"; or "BA History, State University" with a school
// named on the entry.
const DEGREE_OPENS = /^(?:B\.?A|B\.?Sc?|B\.?Eng|BFA|M\.?A|M\.?Sc?|M\.?Eng|MFA|MBA|Ph\.?D|LL\.?[BM])\b\.?(?:\s+in\s|\s*,)/i;
const DEGREE_THEN_SUBJECT = /^(?:B\.?A|B\.?Sc?|B\.?Eng|BFA|M\.?A|M\.?Sc?|M\.?Eng|MFA|LL\.?[BM])\b\.?\s+\S/i;
const SCHOOL = /\b(?:university|college|institute|school|academy|polytechnic)\b/i;

/** `parts`: the lines that would make one entry heading, dates removed. */
function notARole(parts: string[]): boolean {
  const lines = parts.map(tidy).filter(Boolean);
  const all = lines.join(' · ');
  if (NOT_A_ROLE.some((re) => re.test(all))) return true;
  return lines.some((l) => DEGREE_OPENS.test(l) || (DEGREE_THEN_SUBJECT.test(l) && SCHOOL.test(all)));
}

/** One run of consecutive plain lines of an experience section → the same lines, role lines as headings. */
function blockWithHeadings(block: string[]): string[] {
  const n = block.length;
  // `used`: the line belongs to a dated range (no other range may take it).
  // `merged`: it went into a heading, so it is not printed again.
  const used = new Array<boolean>(n).fill(false);
  const merged = new Array<boolean>(n).fill(false);
  const headings = new Array<string | null>(n).fill(null);

  // The upload parse's shape: `**Title — Company** · dates · place`.
  block.forEach((raw, k) => {
    const bold = BOLD_LEAD_RE.exec(raw.trim());
    if (!bold) return;
    const text = [bold[1], bold[2]].filter(Boolean).join(' ');
    const range = findDateRange(text);
    used[k] = true;
    const role = range ? without(text, range) : text;
    // A dated degree or certificate stays the line it was; an undated one adds no years either way.
    if (range && notARole([role])) return;
    headings[k] = heading([role], range);
    merged[k] = true;
  });

  // A file's own lines: a dated line, with the short lines that name the role around it.
  for (let k = 0; k < n; k += 1) {
    if (used[k]) continue;
    const line = block[k]!.trim();
    if (line.length > DATED_LINE_MAX) continue;
    const range = findDateRange(line);
    if (!range) continue;
    const own = without(line, range);
    const dateOnly = letters(own) < 3;

    // The line under a label ("Technologies" / "Figma, React") is that label's text, not the next role's name.
    const underLabel = (j: number): boolean => j > 0 && isSubLabel(block[j - 1]!);
    const before: number[] = [];
    for (let j = k - 1; j >= 0 && before.length < (dateOnly ? 2 : 1) && !used[j] && headerLike(block[j]!) && !underLabel(j); j -= 1) before.unshift(j);

    const after: number[] = [];
    const maxAfter = dateOnly ? (before.length > 0 ? 0 : 2) : 1;
    for (let j = k + 1; j < n && after.length < maxAfter && !used[j] && headerLike(block[j]!); j += 1) {
      // The line above a dates-only line names that role, not this one.
      const next = block[j + 1]?.trim();
      const nextRange = next ? findDateRange(next) : null;
      if (next && nextRange && letters(without(next, nextRange)) < 3) break;
      after.push(j);
    }

    const members = [...before, k, ...after];
    for (const j of members) used[j] = true;
    const parts = [...before.map((j) => block[j]!), own, ...after.map((j) => block[j]!)];
    // Not a job (see NOT_A_ROLE): the lines stay as they are, and no later
    // range takes them. All the lines are judged together — "B.A. Design" /
    // "State University" / "2013 – 2017" is one entry — so a certificate line
    // directly above a job's own lines keeps that job out too: a missing
    // number is the safer mistake.
    if (notARole(parts)) continue;
    for (const j of members) merged[j] = true;
    headings[members[0]!] = heading(parts, range);
  }

  const out: string[] = [];
  for (let k = 0; k < n; k += 1) {
    if (headings[k] !== null) out.push(headings[k]!);
    else if (!merged[k]) out.push(block[k]!);
  }
  return out;
}

/**
 * The resume with the role lines of its work-experience sections written as
 * `###` entry headings (see the header). Lines outside those sections, bullets,
 * existing headings and undated lines are returned unchanged; running it twice
 * changes nothing more.
 */
export function withEntryHeadings(markdown: string): string {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inExperience = false;
  const plain = (raw: string): boolean => raw.trim().length > 0 && !HEADING_RE.test(raw.trim()) && !BULLET_RE.test(raw);

  for (let i = 0; i < lines.length; ) {
    const raw = lines[i]!;
    const h2 = /^##\s+(.+)$/.exec(raw.trim());
    if (h2) inExperience = isWorkHeading(h2[1]!.replace(/[*_`#>|]/g, ' ').trim());
    if (!inExperience || !plain(raw)) {
      out.push(raw);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && plain(lines[j]!)) j += 1;
    out.push(...blockWithHeadings(lines.slice(i, j)));
    i = j;
  }
  return out.join('\n');
}
