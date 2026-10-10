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

export interface StructuredResume {
  contact: StructuredContact;
  targetTitle: string;
  summary: string;
  experiences: StructuredExperience[];
  education: StructuredEducation[];
  skills: string[];
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

function splitDateRange(s: string): { startDate: string; endDate: string } {
  const norm = s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const m = norm.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) return { startDate: m[1].trim(), endDate: m[2].trim() };
  return { startDate: norm, endDate: '' };
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

function parseBulletsAndHeading(body: string[]): {
  bullets: string[];
  inlineLines: string[];
} {
  const bullets: string[] = [];
  const inlineLines: string[] = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^[-*•]\s+(.+)$/);
    if (m) bullets.push(m[1].trim());
    else inlineLines.push(trimmed);
  }
  return { bullets, inlineLines };
}

function parseExperienceBlock(body: string[]): StructuredExperience[] {
  const out: StructuredExperience[] = [];
  // Group lines by h3 (`###`) or "**Title** · Company · Dates"-style bold lines.
  let group: string[] = [];
  const groups: string[][] = [];

  for (const raw of body) {
    const isHeader =
      /^###\s+/.test(raw.trim()) ||
      /^\*\*[^*]+\*\*\s*[·|·]\s*/.test(raw.trim());
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

    // ### Notion · Senior Software Engineer, AI · 2023 – present
    const h3 = headLine.match(/^###\s+(.+)$/);
    // **Senior Software Engineer, AI** · Notion · 2023 – Present
    const boldHead = headLine.match(/^\*\*([^*]+)\*\*\s*(.*)$/);

    if (h3) {
      const parts = h3[1].split(/\s+[·|]\s+/);
      if (parts.length >= 3) {
        company = parts[0];
        title = parts[1];
        dateRange = parts.slice(2).join(' · ');
      } else if (parts.length === 2) {
        company = parts[0];
        title = parts[1];
      } else {
        title = parts[0];
      }
    } else if (boldHead) {
      title = boldHead[1].trim();
      const after = boldHead[2].replace(/^[·|\s]+/, '');
      const parts = after.split(/\s+[·|]\s+/);
      company = parts[0] ?? '';
      dateRange = parts.slice(1).join(' · ');
    } else {
      // Best-effort: treat the line as a title only.
      title = headLine;
    }

    const { location, rest: restNoLoc } = extractLocationLine(rest);
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
    const headLine = lines[0]
      .replace(/^###\s+/, '')
      .replace(/^\*+/, '')
      .replace(/\*+$/, '')
      .trim();
    const parts = headLine.split(/\s+[·|]\s+/);

    let degree = '';
    let school = '';
    let dateRange = '';

    if (parts.length === 1) {
      // Try comma-split: "Degree, School · Year"
      const commaSplit = parts[0].split(/,\s*/);
      if (commaSplit.length >= 2) {
        degree = commaSplit[0];
        school = commaSplit.slice(1).join(', ');
      } else {
        degree = parts[0];
      }
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

function parseSkillsBlock(body: string[]): string[] {
  const flat = body
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' \n ');
  // Skill separators: ·, |, comma, newline.
  const out = flat
    .split(/[·|,\n]+/)
    .map((s) =>
      s
        .replace(/^\*+/, '')
        .replace(/\*+$/, '')
        .replace(/^[-•]\s*/, '')
        .replace(/^\w+:\s*/i, '') // "Languages:" prefix
        .trim(),
    )
    .filter((s) => s.length > 0 && s.length < 60);
  // De-dup while preserving order.
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      dedup.push(s);
    }
  }
  return dedup;
}

export function parseResumeMarkdown(md: string): StructuredResume {
  const { preamble, sections } = splitSections(md ?? '');
  const { contact, targetTitleHint } = parseContactFromPreamble(preamble);

  let summary = '';
  let experiences: StructuredExperience[] = [];
  let education: StructuredEducation[] = [];
  let skills: string[] = [];
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
      summary = sec.body
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join(' ')
        .trim();
    } else if (kind === 'experiences') {
      experiences = parseExperienceBlock(sec.body);
    } else if (kind === 'education') {
      education = parseEducationBlock(sec.body);
    } else if (kind === 'skills') {
      skills = parseSkillsBlock(sec.body);
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
      lines.push(s.skills.filter((sk) => sk.trim()).join(' · '));
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
