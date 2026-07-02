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

export interface StructuredResume {
  contact: StructuredContact;
  targetTitle: string;
  summary: string;
  experiences: StructuredExperience[];
  education: StructuredEducation[];
  skills: string[];
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
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
      current = { heading: h2[1].toLowerCase(), body: [] };
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
  // parse, accumulating without bound across autosaves.
  const urlSearchText = emailMatch ? rest.split(emailMatch[0]).join(' ') : rest;
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
  let tagline = stripWrappers(taglineLine);
  if (emailMatch) tagline = tagline.replace(emailMatch[0], '');
  if (phoneMatch) tagline = tagline.replace(phoneMatch[0], '');
  for (const link of links) tagline = tagline.replace(link, '');
  // Strip the email's bare domain too — on already-polluted resumes the domain
  // leaked into the contact line as repeated standalone tokens; without this
  // they'd survive as a junk "target title" instead of as junk links.
  if (emailDomain) tagline = tagline.split(emailDomain).join(' ');
  tagline = tagline
    .replace(/[·|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[,;\-–—]/g, ' ')
    .trim();

  // Location heuristic — pick a leftover "City, State" or "City, Country" chunk.
  let location = '';
  const locMatch = rest.match(/([A-Z][A-Za-z\s]+,\s*[A-Za-z]{2,})/);
  if (locMatch && !links.some((l) => l.includes(locMatch[1]))) {
    location = locMatch[1].trim();
    tagline = tagline.replace(location, '').replace(/\s+/g, ' ').trim();
  }

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

function classifySection(heading: string): keyof StructuredResume | null {
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

    const { bullets } = parseBulletsAndHeading(rest);
    const { startDate, endDate } = splitDateRange(dateRange);

    out.push({
      id: newId('exp'),
      company: stripWrappers(company),
      title: stripWrappers(title),
      location: '',
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

    const rest = lines.slice(1);
    const { bullets } = parseBulletsAndHeading(rest);
    const { startDate, endDate } = splitDateRange(dateRange);

    out.push({
      id: newId('edu'),
      degree: stripWrappers(degree),
      school: stripWrappers(school),
      location: '',
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

  for (const sec of sections) {
    const kind = classifySection(sec.heading);
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
    }
  }

  return {
    contact,
    targetTitle: targetTitleHint,
    summary,
    experiences,
    education,
    skills,
  };
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

  if (s.summary.trim()) {
    lines.push('## Summary');
    lines.push('');
    lines.push(s.summary.trim());
    lines.push('');
  }

  if (s.experiences.length) {
    lines.push('## Experience');
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

  if (s.education.length) {
    lines.push('## Education');
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

  if (s.skills.length) {
    lines.push('## Skills');
    lines.push('');
    lines.push(s.skills.filter((sk) => sk.trim()).join(' · '));
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
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
