// lib/resumeStructure.ts
//
// Bridge between the freeform `resumeMarkdown` stored on RAResumeVariant and
// the structured shape the V2 Resume Builder editor needs (Contact / Target
// Title / Summary / Work Experience / Education / Skills).
//
// Round-trip: parseResumeMarkdown(serializeResumeMarkdown(s)) ≈ s, modulo
// whitespace. We accept many incoming markdown styles (Teal-like h2/h3,
// double-asterisk titles, dashed contact, em-dashed dates) so existing
// fixture resumes — and resumes pasted by users — open without surprise.
//
// Unknown `##` sections (Projects, Certifications, Languages, Awards…) are
// NOT dropped: they round-trip through `extraSections` verbatim, each pinned
// to the known block it followed in the source so relative order survives
// serialize. Experience/education location lines (`*City, ST*` under the
// entry head) parse back into `location` — symmetric with the serializer.
//
// WP-65: Chinese section titles (教育背景, 实习经历, 自我评价, 專長…) are read as
// the known blocks, and both the original titles and the original section
// order are kept (`headings`, `order`), so a Chinese resume from the guided
// builder opens structured and saves back unchanged. Only the FIRST section of
// each kind is structured; a second one (实习经历 after 工作经历) stays an extra
// section verbatim, so nothing is ever merged away. A contact line that starts
// with the email or phone has no target title: what is left is the location.
// `sectionSequence` / `applySectionSequence` reorder sections (F-RES-12).
//
// Upload format (server/src/lib/candidateResumeIngest.ts `parsedResumeToMarkdown`):
// an uploaded resume is stored as
//   **Role — Company** · When · Location        (experience head)
//   **School · When** — Degree, Field           (education head)
//   **Tools:** Zendesk · Jira                   (one labelled skills line per group)
// The parser reads all three without loss, skill groups keep their labels
// (`skillGroups`), and serialize(parse(x)) is a fixed point: opening an upload
// in the editor and saving it once never moves a field into the wrong slot.
// Lines an earlier build already rewrote into the wrong slots
// ("### 2021 – Present · Lead — Acme · Austin", "### School · 2019** — B.A.")
// are read back into the right ones.
//
// All pure. No React, no I/O. Test from vitest.

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface StructuredContact {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
}

export interface StructuredExperience {
  id: string;
  company: string;
  title: string;
  location: string;
  startDate: string;
  endDate: string;
  bullets: string[];
}

export interface StructuredEducation {
  id: string;
  school: string;
  degree: string;
  location: string;
  startDate: string;
  endDate: string;
  bullets: string[];
}

/** The four `##` blocks the structured editor understands. */
export type KnownSectionKind = 'summary' | 'experiences' | 'education' | 'skills';

/** A `##` section the structured editor does NOT model (Projects,
 *  Certifications, Languages…). Preserved verbatim so the first autosave
 *  after an upload can never destroy it. */
export interface StructuredExtraSection {
  id: string;
  /** Original heading text, case preserved (e.g. "Projects"). */
  heading: string;
  /** Raw markdown body of the section, verbatim. Edited as plain text. */
  markdown: string;
  /** The known block this section followed in the source document — the
   *  serializer re-emits it right after that block, so the original relative
   *  order holds. null = appeared before any known section. */
  anchor: KnownSectionKind | null;
}

/** One labelled line of the skills section ("Tools: Zendesk · Jira"); label '' = no label. */
export interface StructuredSkillGroup {
  label: string;
  skills: string[];
}

export interface StructuredResume {
  contact: StructuredContact;
  targetTitle: string;
  summary: string;
  experiences: StructuredExperience[];
  education: StructuredEducation[];
  /** Every skill once, in document order — what the chip editor shows and edits. */
  skills: string[];
  /**
   * The skills section as written, when it has labelled lines. The serializer
   * writes these lines back with the skills still in `skills`; a skill added
   * in the editor goes on the unlabelled line. Absent = one plain line.
   */
  skillGroups?: StructuredSkillGroup[];
  extraSections: StructuredExtraSection[];
  /** Original titles of the known blocks (e.g. 实习经历); default English titles otherwise. */
  headings?: Partial<Record<KnownSectionKind, string>>;
  /** Order of the known blocks as written; missing kinds follow in the default order. */
  order?: KnownSectionKind[];
}

/** Default order and titles of the known blocks. */
export const KNOWN_SECTION_ORDER: readonly KnownSectionKind[] = ['summary', 'experiences', 'education', 'skills'];
export const DEFAULT_SECTION_HEADINGS: Record<KnownSectionKind, string> = {
  summary: 'Summary',
  experiences: 'Experience',
  education: 'Education',
  skills: 'Skills',
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Leading "(" included — otherwise "(555) 987-6543" parses as "555) 987-6543",
// leaving a stray "(" in the tagline that re-accumulates across autosaves.
const PHONE_RE = /(\+?\(?\d[\d\s().-]{7,}\d)/;
const URL_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s|·,]*)?/g;

function stripWrappers(s: string): string {
  return s
    .replace(/^\*+/, '')
    .replace(/\*+$/, '')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .trim();
}

/** A part of an entry head that is a date or a date range ("2021 – Present", "2023.09 - 2027.06", "至今"). */
export function looksLikeDate(s: string): boolean {
  return /(?:19|20)\d{2}|\b(?:present|current|now|ongoing)\b|至今|现在|現在|目前/i.test(s);
}

function splitDateRange(s: string): { startDate: string; endDate: string } {
  const norm = s.replace(/\s+/g, ' ').trim();
  // "2021.03至今" ends in a word, not in a separator plus "今".
  const open = norm.match(/^(.+?)\s*[-–—~～]?\s*(至今|现在|現在|目前)$/);
  if (open) return { startDate: open[1].trim(), endDate: open[2] };
  // A spaced separator first: "2021-07 - 2023-05" is two dates, not four.
  const spaced = norm.match(/^(.+?)\s+(?:[-–—~～至]|to)\s+(.+)$/i);
  if (spaced) return { startDate: spaced[1].trim(), endDate: spaced[2].trim() };
  const dashed = norm.match(/^(.+?)\s*[–—~～至]\s*(.+)$/);
  if (dashed) return { startDate: dashed[1].trim(), endDate: dashed[2].trim() };
  // One date written with hyphens ("2021-07") is not a range.
  if (/^\d{4}-\d{1,2}(?:-\d{1,2})?$/.test(norm)) return { startDate: norm, endDate: '' };
  const m = norm.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) return { startDate: m[1].trim(), endDate: m[2].trim() };
  return { startDate: norm, endDate: '' };
}

const DATE_WORD = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?|spring|summer|fall|autumn|winter|q[1-4]';
const DATE_TOKEN = `(?:(?:${DATE_WORD})\\s+)?(?:(?:19|20)\\d{2}(?:\\s*[./-]\\s*\\d{1,2}){0,2}(?:\\s*年(?:\\s*\\d{1,2}\\s*月)?)?|\\d{1,2}\\s*[./]\\s*(?:19|20)\\d{2})`;
const DATE_OPEN_END = '(?:present|current|now|ongoing|today|至今|现在|現在|目前|今)';
const DATE_PART_RE = new RegExp(`^${DATE_TOKEN}(\\s*(?:[-–—~～至]|to)\\s*(?:${DATE_TOKEN}|${DATE_OPEN_END}))?$`, 'i');

/**
 * A head part that is nothing but a date or a date range: "2021 – Present",
 * "June 2022 – Present", "2023.09 - 2027.06", "2021年3月 至今". Anchored on both
 * ends, unlike `looksLikeDate`: a name that merely contains a year or the word
 * "Current" ("Expo 2020 Dubai", "Current Health") is not a date.
 */
export function datePart(s: string): 'date' | 'range' | null {
  const m = s.replace(/\s+/g, ' ').trim().match(DATE_PART_RE);
  if (!m) return null;
  return m[1] ? 'range' : 'date';
}

/**
 * Split "Role — Company" at the last spaced em dash, the separator the upload
 * writes. An en dash is left alone: "Senior Engineer – Payments" is one title.
 */
function splitRoleCompany(s: string): { title: string; company: string } {
  const at = s.lastIndexOf(' — ');
  if (at < 0) return { title: s.trim(), company: '' };
  return { title: s.slice(0, at).trim(), company: s.slice(at + 3).trim() };
}

/** Parts after an entry's name: the first date-like one is the dates, the rest is the place. */
function splitWhenWhere(parts: string[]): { dateRange: string; location: string } {
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  const at = clean.findIndex(looksLikeDate);
  if (at < 0) return { dateRange: '', location: clean.join(' · ') };
  return { dateRange: clean[at]!, location: clean.filter((_, i) => i !== at).join(' · ') };
}

/** The serializer writes entry locations as a lone italic line under the
 *  entry head (`*San Francisco, CA*`). Read that back — symmetric round-trip. */
function extractLocationLine(rest: string[]): { location: string; rest: string[] } {
  for (let i = 0; i < rest.length; i++) {
    const trimmed = rest[i].trim();
    if (!trimmed) continue;
    const italic = trimmed.match(/^\*([^*]+)\*$/) ?? trimmed.match(/^_([^_]+)_$/);
    if (italic) {
      return {
        location: italic[1].trim(),
        rest: [...rest.slice(0, i), ...rest.slice(i + 1)],
      };
    }
    break; // only the first non-blank line can be the location
  }
  return { location: '', rest };
}

// ─────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────

interface RawSection {
  heading: string;
  body: string[];
}

function splitSections(md: string): {
  preamble: string[];
  sections: RawSection[];
} {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const preamble: string[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let sawFirstH2 = false;

  for (const raw of lines) {
    const line = raw;
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      sawFirstH2 = true;
      if (current) sections.push(current);
      // Original case preserved — classifySection lowercases; unknown
      // sections re-emit the heading verbatim.
      current = { heading: h2[1], body: [] };
      continue;
    }
    if (current) {
      current.body.push(line);
    } else if (!sawFirstH2) {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

function parseContactFromPreamble(preamble: string[]): {
  contact: StructuredContact;
  targetTitleHint: string;
} {
  let fullName = '';
  const lines = preamble.filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && !fullName) {
      fullName = h1[1].trim();
      break;
    }
  }
  const rest = lines.filter((l) => !l.startsWith('# ')).join('\n');

  const emailMatch = rest.match(EMAIL_RE);
  const phoneMatch = rest.match(PHONE_RE);

  // Remove the email before scanning for URLs — otherwise the email's own
  // domain (e.g. "126.com" inside "user@126.com") is mis-detected as a link,
  // appended to the contact line on serialize, and re-extracted on the next
  // parse, accumulating without bound across autosaves. Emphasis markers are
  // blanked too: the contact line's closing `*`/`_` would otherwise be
  // captured into the last link's path and grow by one every round-trip.
  const urlSearchText = (emailMatch ? rest.split(emailMatch[0]).join(' ') : rest)
    .replace(/[*_]/g, ' ');
  const emailDomain = emailMatch
    ? (emailMatch[0].split('@')[1] || '').toLowerCase()
    : '';
  const normalizeLink = (u: string): string =>
    u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

  const urls = Array.from(urlSearchText.matchAll(URL_RE)).map((m) => m[0]);
  // Keep obvious URL/handle-shaped strings only (strip stray dotted locations
  // like "San Francisco, CA"); drop anything that is merely the email's own
  // domain; de-dup so the serialize→parse round-trip is stable.
  const seenLinks = new Set<string>();
  const links: string[] = [];
  for (const u of urls) {
    const looksLikeLink =
      /\.(com|io|ai|org|net|dev|co|me|app|xyz)(\/|$)/i.test(u) || u.startsWith('http');
    if (!looksLikeLink) continue;
    const norm = normalizeLink(u);
    if (emailDomain && norm === emailDomain) continue;
    if (seenLinks.has(norm)) continue;
    seenLinks.add(norm);
    links.push(u);
  }

  // Take the first non-h1, non-blank line. Strip wrappers and the email/phone/url
  // — what remains is the candidate's target/current title.
  const taglineLine =
    rest.split('\n').find((l) => l.trim().length > 0) ?? '';
  // WP-65: the serializer writes the title first. When the line starts with
  // the email or phone there is no title, and the leftover part is the
  // location (a CJK city such as 上海 has no "City, ST" shape).
  const parts = stripWrappers(taglineLine)
    .split(/\s+[·|｜]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const isContactBit = (p: string) =>
    EMAIL_RE.test(p) ||
    (PHONE_RE.test(p) && p.replace(/\D/g, '').length >= 7 && p.replace(PHONE_RE, '').trim().length === 0) ||
    links.some((l) => p.includes(l));
  const noTitle = parts.length > 1 && isContactBit(parts[0]);
  const leftover = noTitle ? parts.filter((p) => !isContactBit(p)) : [];
  let tagline = stripWrappers(taglineLine);
  if (emailMatch) tagline = tagline.replace(emailMatch[0], '');
  if (phoneMatch) tagline = tagline.replace(phoneMatch[0], '');
  for (const link of links) tagline = tagline.replace(link, '');
  // Strip the email's bare domain too — on already-polluted resumes the domain
  // leaked into the contact line as repeated standalone tokens; without this
  // they'd survive as a junk "target title" instead of as junk links.
  if (emailDomain) tagline = tagline.split(emailDomain).join(' ');

  // Location heuristic — pick a leftover "City, State" or "City, Country"
  // chunk. Stripped from the tagline BEFORE punctuation collapses below;
  // stripping after (the old order) de-commas "Seattle, WA" first, so the
  // replace misses and the city re-accumulates in the title every autosave.
  let location = '';
  const locMatch = rest.match(/([A-Z][A-Za-z\s]+,\s*[A-Za-z]{2,})/);
  if (locMatch && !links.some((l) => l.includes(locMatch[1]))) {
    location = locMatch[1].trim();
    tagline = tagline.split(location).join(' ');
  }
  if (noTitle) {
    if (!location && leftover.length) location = leftover.join(', ');
    tagline = '';
  }

  tagline = tagline
    .replace(/[·|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[,;\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    contact: {
      fullName,
      email: emailMatch?.[0] ?? '',
      phone: phoneMatch?.[0] ?? '',
      location,
      links,
    },
    targetTitleHint: tagline,
  };
}

export function classifySection(heading: string): KnownSectionKind | null {
  const h = heading.trim().toLowerCase();
  if (/^summary|^professional summary|^profile|^about/.test(h)) return 'summary';
  if (
    /^experience|^professional experience|^work experience|^work history|^employment/.test(
      h,
    )
  )
    return 'experiences';
  if (/^education|^academic/.test(h)) return 'education';
  if (/^skills|^technical skills|^expertise|^stack/.test(h)) return 'skills';
  // Chinese titles (WP-65). 技能证书 / 證照 hold certificate lines and stay
  // verbatim; only a plain skills title is read as the skills line.
  if (/^(个人总结|個人總結|个人简介|個人簡介|個人摘要|自我评价|自我評價|自我介绍|自我介紹)$/.test(h)) return 'summary';
  if (/^(工作经历|工作經歷|工作经验|工作經驗|实习经历|實習經歷|实习经验|實習經驗)$/.test(h)) return 'experiences';
  if (/^(教育背景|教育经历|教育經歷|学历|學歷)$/.test(h)) return 'education';
  if (/^(专业技能|專業技能|技能|专长|專長)$/.test(h)) return 'skills';
  return null;
}

/**
 * The lines under an entry head as bullets, in order. A line with no bullet
 * mark (a description paragraph, "GPA: 3.8") is kept as a bullet too: the
 * editor has nowhere else to hold it, and dropping it would delete the
 * user's text on the next save.
 */
function parseBulletsAndHeading(body: string[]): {
  bullets: string[];
} {
  const bullets: string[] = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^[-*•]\s+(.+)$/);
    // A bullet glyph kept from the source file ("- · 负责…") is not text:
    // left in, the export prints two marks ("• ·").
    const text = (m ? m[1] : trimmed).replace(/^[·•▪◦●○■□◆▶➢]\s*/, '').trim();
    if (text) bullets.push(text);
  }
  return { bullets };
}

function parseExperienceBlock(body: string[]): StructuredExperience[] {
  const out: StructuredExperience[] = [];
  // Group lines by h3 (`###`) or "**Title** · Company · Dates"-style bold lines.
  let group: string[] = [];
  const groups: string[][] = [];

  for (const raw of body) {
    // `###`, "**Title** · Company · Dates", or a line that is bold from end
    // to end ("**Role — Company**": an upload head with no dates).
    const isHeader =
      /^###\s+/.test(raw.trim()) ||
      /^\*\*[^*]+\*\*\s*[·|·]\s*/.test(raw.trim()) ||
      /^\*\*[^*]+\*\*$/.test(raw.trim());
    if (isHeader && group.length > 0) {
      groups.push(group);
      group = [];
    }
    group.push(raw);
  }
  if (group.length) groups.push(group);

  for (const g of groups) {
    const cleaned = g.filter((l) => l.trim().length > 0);
    if (!cleaned.length) continue;
    const headLine = cleaned[0].trim();
    const rest = cleaned.slice(1);

    let company = '';
    let title = '';
    let dateRange = '';
    let headLocation = '';

    // ### Notion · Senior Software Engineer, AI · 2023 – present
    const h3 = headLine.match(/^###\s+(.+)$/);
    // **Senior Software Engineer, AI** · Notion · 2023 – Present   (pasted)
    // **Support Team Lead — Acme** · 2021 – Present · Austin, TX   (upload)
    const boldHead = headLine.match(/^\*\*([^*]+)\*\*\s*(.*)$/);

    if (h3) {
      const parts = h3[1].split(/\s+[·|]\s+/);
      // An upload head an earlier build rewrote with the dates first:
      // "### 2021 – Present · Support Team Lead — Acme · Austin, TX".
      // The editor itself writes "### Company · Title · Dates", so this
      // reading is taken only when the first part is nothing but a date
      // (never a company that has a year or "Current" in its name) and the
      // rest still looks like the upload: a "Role — Company" part, or a
      // date range with no dates after it.
      const firstIsDate = parts.length >= 2 ? datePart(parts[0]) : null;
      const datesFirst =
        firstIsDate !== null &&
        !looksLikeDate(parts[1]) &&
        (parts[1].includes(' — ') || (firstIsDate === 'range' && !parts.slice(2).some(looksLikeDate)));
      if (datesFirst) {
        dateRange = parts[0];
        ({ title, company } = splitRoleCompany(parts[1]));
        headLocation = parts.slice(2).join(' · ');
      } else if (parts.length >= 3) {
        company = parts[0];
        title = parts[1];
        dateRange = parts.slice(2).join(' · ');
      } else if (parts.length === 2 && looksLikeDate(parts[1])) {
        // Written by the serializer for an entry with one name: keep it the title.
        title = parts[0];
        dateRange = parts[1];
      } else if (parts.length === 2) {
        company = parts[0];
        title = parts[1];
      } else {
        title = parts[0];
      }
    } else if (boldHead) {
      const after = boldHead[2].replace(/^[·|\s]+/, '');
      const parts = after ? after.split(/\s+[·|]\s+/) : [];
      const named = splitRoleCompany(boldHead[1]);
      // Upload shape: the bold part names the role (and company); what follows
      // is the dates and the place. Pasted shape: the bold part is the whole
      // title and the company comes next, then the dates. A date straight
      // after the bold means upload; a date further along means the part in
      // between is the company ("**Nurse** · Current Health · 2020 – 2022",
      // "**Senior Engineer – Payments** · Stripe · 2021 – Present").
      const laterDate = parts.slice(1).some(looksLikeDate);
      const uploadShape =
        parts.length === 0 ||
        datePart(parts[0]) !== null ||
        (!laterDate && (Boolean(named.company) || looksLikeDate(parts[0])));
      if (uploadShape) {
        title = named.title;
        company = named.company;
        ({ dateRange, location: headLocation } = splitWhenWhere(parts));
      } else {
        title = boldHead[1].trim();
        company = parts[0] ?? '';
        ({ dateRange, location: headLocation } = splitWhenWhere(parts.slice(1)));
      }
    } else {
      // Best-effort: treat the line as a title only.
      title = headLine;
    }

    const italic = extractLocationLine(rest);
    const location = italic.location || headLocation.trim();
    const restNoLoc = italic.rest;
    const { bullets } = parseBulletsAndHeading(restNoLoc);
    const { startDate, endDate } = splitDateRange(dateRange);

    out.push({
      id: newId('exp'),
      company: stripWrappers(company),
      title: stripWrappers(title),
      location,
      startDate,
      endDate,
      bullets,
    });
  }
  return out;
}

function looksLikeSchool(s: string): boolean {
  return /universit|college|school|institut|academy|polytechnic|大学|大學|学院|學院|学校|學校|中学|中學/i.test(s);
}

function looksLikeDegree(s: string): boolean {
  return /\b(?:b\.?\s?[as]c?|m\.?\s?[as]c?|ph\.?\s?d|mba|bachelor|master|doctor|associate|diploma|degree|certificate)\b|本科|硕士|碩士|博士|学士|學士|大专|大專|专科|專科/i.test(s);
}

function parseEducationBlock(body: string[]): StructuredEducation[] {
  const out: StructuredEducation[] = [];
  // Common shapes:
  //   "B.S. Computer Science, University of California Berkeley · 2019"
  //   "**Bachelor of Science in Computer Science** · UC Berkeley · 2019"
  //   "### Stanford · BS Computer Science · 2018 – 2022"
  const blocks: string[] = [];
  let buf: string[] = [];
  for (const raw of body) {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (buf.length) blocks.push(buf.join('\n'));
      buf = [];
      continue;
    }
    buf.push(trimmed);
  }
  if (buf.length) blocks.push(buf.join('\n'));

  for (const blk of blocks) {
    const lines = blk.split('\n');
    const isH3 = /^###\s+/.test(lines[0]);
    const rawHead = lines[0].replace(/^###\s+/, '').trim();
    const headLine = rawHead.replace(/^\*+/, '').replace(/\*+$/, '').trim();
    const parts = headLine.split(/\s+[·|]\s+/);

    let degree = '';
    let school = '';
    let dateRange = '';

    // Upload shape: "**School · When** — Degree, Field" (also after an earlier
    // build turned it into "### School · When** — Degree, Field"), or a head
    // that is bold from end to end: "**School · When**".
    const upload = rawHead.match(/^(?:\*\*)?([^*]+)\*\*\s*[—–-]\s*(.+)$/);
    const allBold = rawHead.match(/^\*\*([^*]+)\*\*$/);
    if (upload || allBold) {
      const inner = (upload ? upload[1] : allBold![1]).split(/\s+[·|]\s+/).map((p) => p.trim()).filter(Boolean);
      const at = inner.length > 1 ? inner.findIndex(looksLikeDate) : -1;
      if (at >= 0) dateRange = inner[at]!;
      school = inner.filter((_, i) => i !== at).join(' · ');
      degree = upload ? upload[2].trim() : '';
    } else if (parts.length === 1) {
      // Try comma-split: "Degree, School · Year". Never on a `###` head: the
      // serializer writes "### B.S., Statistics" for an entry with no school.
      const commaSplit = isH3 ? [parts[0]] : parts[0].split(/,\s*/);
      if (commaSplit.length >= 2) {
        degree = commaSplit[0];
        school = commaSplit.slice(1).join(', ');
      } else if (isH3 && looksLikeSchool(parts[0])) {
        school = parts[0];
      } else {
        degree = parts[0];
      }
    } else if (parts.length === 2 && isH3 && looksLikeDate(parts[1])) {
      // "### Oregon State University · 2020" / "### B.S., Statistics · 2020".
      if (looksLikeSchool(parts[0]) || !looksLikeDegree(parts[0])) school = parts[0];
      else degree = parts[0];
      dateRange = parts[1];
    } else if (parts.length === 2) {
      degree = parts[0];
      school = parts[1];
    } else {
      degree = parts[0];
      school = parts[1];
      dateRange = parts.slice(2).join(' · ');
    }

    // Trailing year if degree contains it.
    if (!dateRange) {
      const yrMatch = school.match(/(\d{4})\s*[-–—]?\s*(\d{4}|present)?\s*$/i);
      if (yrMatch) {
        dateRange = yrMatch[0];
        school = school.replace(yrMatch[0], '').trim();
      }
    }

    const { location, rest } = extractLocationLine(lines.slice(1));
    const { bullets } = parseBulletsAndHeading(rest);
    const { startDate, endDate } = splitDateRange(dateRange);

    out.push({
      id: newId('edu'),
      degree: stripWrappers(degree),
      school: stripWrappers(school),
      location,
      startDate,
      endDate,
      bullets,
    });
  }
  return out;
}

/** Split a run of skills. A line that uses "·" is split on "·" only, so "Python (pandas, numpy)" stays one skill. */
function splitSkillItems(text: string): string[] {
  const sep = text.includes('·') ? /[·\n]+/ : /[|｜,，、;；\n]+/;
  return text
    .split(sep)
    .map((x) => x.replace(/^[-•]\s*/, '').replace(/^\*+/, '').replace(/\*+$/, '').trim())
    .filter((x) => x.length > 0);
}

/** "**Tools:**" / "**框架：**" anywhere in a line, or a plain "Languages:" at its start. */
const SKILL_LABEL_RE = /\*\*\s*([^*\n]{1,40}?)\s*[:：]\s*\*\*|\*\*\s*([^*\n]{1,40}?)\s*\*\*\s*[:：]/g;

/**
 * The skills section as labelled lines. Each "**Label:** a · b" (the upload
 * format, one per line — or several on one line after an earlier build joined
 * them) is one group; text with no label is a group with label ''.
 */
function parseSkillGroups(body: string[]): StructuredSkillGroup[] {
  const groups: StructuredSkillGroup[] = [];
  const add = (label: string, text: string) => {
    const skills = splitSkillItems(text);
    if (!skills.length) return;
    const prev = groups.find((g) => g.label === label);
    // One unlabelled group at most; a repeated label keeps its own line.
    if (prev && label === '') prev.skills.push(...skills);
    else groups.push({ label, skills });
  };
  for (const raw of body) {
    const line = raw.trim().replace(/^[-*•]\s+(?=\*\*|\S)/, '');
    if (!line) continue;
    const marks = Array.from(line.matchAll(SKILL_LABEL_RE));
    if (!marks.length) {
      // "Languages: SQL, Python" — a short plain label at the start of the line.
      const plain = line.match(/^([\p{L}][\p{L} &/+-]{0,30})[:：]\s*(.+)$/u);
      if (plain) add(plain[1].trim(), plain[2]);
      else add('', line);
      continue;
    }
    add('', line.slice(0, marks[0]!.index));
    marks.forEach((m, i) => {
      const from = m.index! + m[0].length;
      const to = i + 1 < marks.length ? marks[i + 1]!.index! : line.length;
      add((m[1] ?? m[2] ?? '').trim(), line.slice(from, to));
    });
  }
  return groups;
}

/** Every skill once, in order. */
function flattenSkillGroups(groups: StructuredSkillGroup[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    for (const sk of g.skills) {
      const k = sk.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(sk);
    }
  }
  return out;
}

/**
 * The skills lines to write: each group with the skills still in `skills`
 * (a removed chip leaves every group), and chips added in the editor on the
 * unlabelled line. With no labelled group it is the one plain line.
 */
export function skillLines(s: Pick<StructuredResume, 'skills' | 'skillGroups'>): string[] {
  const skills = s.skills.map((sk) => sk.trim()).filter(Boolean);
  const groups = s.skillGroups ?? [];
  if (!groups.some((g) => g.label)) return skills.length ? [skills.join(' · ')] : [];
  const kept = new Set(skills.map((sk) => sk.toLowerCase()));
  const grouped = new Set<string>();
  for (const g of groups) for (const sk of g.skills) grouped.add(sk.toLowerCase());
  const added = skills.filter((sk) => !grouped.has(sk.toLowerCase()));
  const lines: string[] = [];
  let wroteAdded = false;
  for (const g of groups) {
    const items = g.skills.filter((sk) => kept.has(sk.toLowerCase()));
    if (!g.label) {
      items.push(...added);
      wroteAdded = true;
    }
    if (!items.length) continue;
    // A CJK label keeps its full-width colon ("**框架：**").
    const colon = /[\u3400-\u9fff]/.test(g.label) ? '：' : ':';
    lines.push(g.label ? `**${g.label}${colon}** ${items.join(' · ')}` : items.join(' · '));
  }
  if (!wroteAdded && added.length) lines.push(added.join(' · '));
  return lines;
}

/** Summary lines as one paragraph; no space is put between two CJK lines. */
function joinSummaryLines(body: string[]): string {
  const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
  let out = '';
  for (const line of body.map((l) => l.trim()).filter((l) => l.length > 0)) {
    if (!out) out = line;
    else out += (CJK.test(out.slice(-1)) && CJK.test(line[0]!) ? '' : ' ') + line;
  }
  return out.trim();
}

export function parseResumeMarkdown(md: string): StructuredResume {
  const { preamble, sections } = splitSections(md ?? '');
  const { contact, targetTitleHint } = parseContactFromPreamble(preamble);

  let summary = '';
  let experiences: StructuredExperience[] = [];
  let education: StructuredEducation[] = [];
  let skills: string[] = [];
  let skillGroups: StructuredSkillGroup[] = [];
  const extraSections: StructuredExtraSection[] = [];

  // Anchor extras to the last KNOWN section seen, so serialize can put them
  // back at (approximately) the same spot in the document.
  let lastKnown: KnownSectionKind | null = null;
  let extraIdx = 0;
  const headings: Partial<Record<KnownSectionKind, string>> = {};
  const order: KnownSectionKind[] = [];

  for (const sec of sections) {
    const classified = classifySection(sec.heading);
    // Only the first section of a kind is structured; a repeat stays verbatim.
    const kind = classified && !order.includes(classified) ? classified : null;
    if (kind) {
      order.push(kind);
      const heading = sec.heading.trim();
      if (heading && heading !== DEFAULT_SECTION_HEADINGS[kind]) headings[kind] = heading;
    }
    if (kind === 'summary') {
      summary = joinSummaryLines(sec.body);
    } else if (kind === 'experiences') {
      experiences = parseExperienceBlock(sec.body);
    } else if (kind === 'education') {
      education = parseEducationBlock(sec.body);
    } else if (kind === 'skills') {
      skillGroups = parseSkillGroups(sec.body);
      skills = flattenSkillGroups(skillGroups);
    } else {
      // Unknown section — preserve verbatim rather than dropping it.
      extraSections.push({
        // Index-based id: deterministic across re-parses so React keys hold.
        id: `extra_${extraIdx++}`,
        heading: sec.heading.trim(),
        markdown: sec.body.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''),
        anchor: lastKnown,
      });
      continue; // extras don't advance the known-section anchor
    }
    lastKnown = kind;
  }

  const out: StructuredResume = {
    contact,
    targetTitle: targetTitleHint,
    summary,
    experiences,
    education,
    skills,
    extraSections,
  };
  if (skillGroups.some((g) => g.label)) out.skillGroups = skillGroups;
  if (Object.keys(headings).length) out.headings = headings;
  if (order.length && order.some((k, i) => k !== KNOWN_SECTION_ORDER.filter((x) => order.includes(x))[i])) out.order = order;
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Serializer (StructuredResume → markdown)
// ─────────────────────────────────────────────────────────────────────

function joinDateRange(start: string, end: string): string {
  const a = start.trim();
  const b = end.trim();
  if (a && b) return `${a} – ${b}`;
  if (a) return a;
  if (b) return b;
  return '';
}

export function serializeResumeMarkdown(s: StructuredResume): string {
  const lines: string[] = [];
  const name = s.contact.fullName.trim() || 'Your Name';
  lines.push(`# ${name}`);
  const contactBits: string[] = [];
  if (s.targetTitle.trim()) contactBits.push(s.targetTitle.trim());
  if (s.contact.email.trim()) contactBits.push(s.contact.email.trim());
  if (s.contact.phone.trim()) contactBits.push(s.contact.phone.trim());
  if (s.contact.location.trim()) contactBits.push(s.contact.location.trim());
  for (const link of s.contact.links) if (link.trim()) contactBits.push(link.trim());
  if (contactBits.length) lines.push(`*${contactBits.join(' · ')}*`);
  lines.push('');

  // Extra (unknown) sections re-emit verbatim right after the known block
  // they followed in the source, so relative order survives the round-trip.
  const extras = s.extraSections ?? [];
  const emitExtras = (anchor: KnownSectionKind | null) => {
    for (const x of extras) {
      if (x.anchor !== anchor) continue;
      lines.push(`## ${x.heading.trim() || 'Section'}`);
      lines.push('');
      const body = x.markdown.replace(/^\n+/, '').replace(/\s+$/, '');
      if (body) lines.push(body);
      lines.push('');
    }
  };

  emitExtras(null);

  const title = (kind: KnownSectionKind) => s.headings?.[kind]?.trim() || DEFAULT_SECTION_HEADINGS[kind];
  const emitKnown = (kind: KnownSectionKind) => {
    if (kind === 'summary' && s.summary.trim()) {
      lines.push(`## ${title('summary')}`);
      lines.push('');
      lines.push(s.summary.trim());
      lines.push('');
    }
    if (kind === 'experiences' && s.experiences.length) {
      lines.push(`## ${title('experiences')}`);
      lines.push('');
      for (const e of s.experiences) {
        const head = [e.company, e.title, joinDateRange(e.startDate, e.endDate)]
          .filter(Boolean)
          .join(' · ');
        lines.push(`### ${head}`);
        if (e.location.trim()) lines.push(`*${e.location.trim()}*`);
        for (const b of e.bullets) {
          if (b.trim()) lines.push(`- ${b.trim()}`);
        }
        lines.push('');
      }
    }
    if (kind === 'education' && s.education.length) {
      lines.push(`## ${title('education')}`);
      lines.push('');
      for (const ed of s.education) {
        const head = [ed.degree, ed.school, joinDateRange(ed.startDate, ed.endDate)]
          .filter(Boolean)
          .join(' · ');
        lines.push(`### ${head}`);
        if (ed.location.trim()) lines.push(`*${ed.location.trim()}*`);
        for (const b of ed.bullets) {
          if (b.trim()) lines.push(`- ${b.trim()}`);
        }
        lines.push('');
      }
    }
    if (kind === 'skills' && s.skills.length) {
      lines.push(`## ${title('skills')}`);
      lines.push('');
      lines.push(...skillLines(s));
      lines.push('');
    }
    emitExtras(kind);
  };
  for (const kind of knownOrder(s)) emitKnown(kind);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** The known blocks in emission order: `order` first, then the rest by default. */
export function knownOrder(s: Pick<StructuredResume, 'order'>): KnownSectionKind[] {
  const seen = new Set<KnownSectionKind>();
  const out: KnownSectionKind[] = [];
  for (const k of [...(s.order ?? []), ...KNOWN_SECTION_ORDER]) {
    if (!KNOWN_SECTION_ORDER.includes(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Section order (F-RES-12 reorder; WP-65)
// ─────────────────────────────────────────────────────────────────────

export type SectionRef =
  | { kind: 'known'; key: KnownSectionKind }
  | { kind: 'extra'; id: string };

/** True when the known block has content (and so appears in the document). */
function hasKnownContent(s: StructuredResume, k: KnownSectionKind): boolean {
  if (k === 'summary') return s.summary.trim().length > 0;
  if (k === 'experiences') return s.experiences.length > 0;
  if (k === 'education') return s.education.length > 0;
  return s.skills.length > 0;
}

/** The sections in document order, as the serializer will write them. */
export function sectionSequence(s: StructuredResume): SectionRef[] {
  const out: SectionRef[] = [];
  const extras = s.extraSections ?? [];
  const pushExtras = (anchor: KnownSectionKind | null) => {
    for (const x of extras) if (x.anchor === anchor) out.push({ kind: 'extra', id: x.id });
  };
  pushExtras(null);
  for (const k of knownOrder(s)) {
    if (hasKnownContent(s, k)) out.push({ kind: 'known', key: k });
    pushExtras(k);
  }
  return out;
}

/**
 * Put the sections in `seq` order: known blocks get that order, and each extra
 * section is anchored to the known block before it. Content never changes.
 */
export function applySectionSequence(s: StructuredResume, seq: SectionRef[]): StructuredResume {
  const order: KnownSectionKind[] = [];
  const anchors = new Map<string, KnownSectionKind | null>();
  const extraOrder: string[] = [];
  let last: KnownSectionKind | null = null;
  for (const ref of seq) {
    if (ref.kind === 'known') {
      order.push(ref.key);
      last = ref.key;
    } else {
      anchors.set(ref.id, last);
      extraOrder.push(ref.id);
    }
  }
  // Known blocks with no content keep their place after the listed ones.
  for (const k of knownOrder(s)) if (!order.includes(k)) order.push(k);
  const byId = new Map(s.extraSections.map((x) => [x.id, x]));
  const extras = [
    ...extraOrder.map((id) => byId.get(id)).filter((x): x is StructuredExtraSection => Boolean(x)),
    ...s.extraSections.filter((x) => !extraOrder.includes(x.id)),
  ].map((x) => (anchors.has(x.id) ? { ...x, anchor: anchors.get(x.id) ?? null } : x));
  return { ...s, order, extraSections: extras };
}

/** Move one section up (-1) or down (+1) in the document. */
export function moveSection(s: StructuredResume, ref: SectionRef, dir: -1 | 1): StructuredResume {
  const seq = sectionSequence(s);
  const idx = seq.findIndex((r) => (r.kind === 'known' && ref.kind === 'known' ? r.key === ref.key : r.kind === 'extra' && ref.kind === 'extra' && r.id === ref.id));
  const to = idx + dir;
  if (idx < 0 || to < 0 || to >= seq.length) return s;
  const next = [...seq];
  [next[idx], next[to]] = [next[to]!, next[idx]!];
  return applySectionSequence(s, next);
}

// ─────────────────────────────────────────────────────────────────────
// Factory: blank structured resume
// ─────────────────────────────────────────────────────────────────────

export function blankStructuredResume(): StructuredResume {
  return {
    contact: { fullName: '', email: '', phone: '', location: '', links: [] },
    targetTitle: '',
    summary: '',
    experiences: [],
    education: [],
    skills: [],
    extraSections: [],
  };
}

export function blankExperience(): StructuredExperience {
  return {
    id: newId('exp'),
    company: '',
    title: '',
    location: '',
    startDate: '',
    endDate: '',
    bullets: [''],
  };
}

export function blankEducation(): StructuredEducation {
  return {
    id: newId('edu'),
    school: '',
    degree: '',
    location: '',
    startDate: '',
    endDate: '',
    bullets: [],
  };
}
