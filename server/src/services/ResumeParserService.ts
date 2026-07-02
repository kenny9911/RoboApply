import { llmService } from './llm/LLMService.js';
import { logger } from './LoggerService.js';
import { getModelSetting } from '../lib/llm/llmModels.js';

// Read per-call (not a module const) so an admin's DB override applies without a
// restart. DB override ?? env LLM_EXTRACT ?? undefined (→ llmService default).
const extractModel = (): string | undefined => getModelSetting('extract');

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ContactInfo {
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  github?: string | null;
  linkedin?: string | null;
  website?: string | null;
  other?: string[];
}

export interface Education {
  degree: string;
  institution: string;
  location?: string | null;
  period: string;
  gpa?: string | null;
  details?: string[];
}

export interface Experience {
  title: string;
  company: string;
  department?: string | null;
  location?: string | null;
  period: string;
  highlights: string[];
}

export interface Project {
  name: string;
  organization?: string | null;
  period?: string | null;
  description?: string | null;
  highlights: string[];
  technologies?: string[];
  links?: string[];
}

export interface Award {
  title: string;
  issuer?: string | null;
  date?: string | null;
  description?: string | null;
}

export interface LanguageSkill {
  language: string;
  proficiency: string;
}

export interface SkillCategory {
  category: string;
  skills: string[];
}

export interface ParsedResume {
  candidateName: string;
  contact: ContactInfo;
  objective?: string | null;
  summary?: string | null;
  education: Education[];
  experience: Experience[];
  projects: Project[];
  skills: SkillCategory[];
  languages?: LanguageSkill[];
  awards?: Award[];
  certifications?: string[];
  publications?: string[];
  interests?: string[];
  other?: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const BULLET_GLYPH_REGEX = /[■□▪▫◆◇◼◻◾◽]/g;
const BULLET_ONLY_REGEX = /^[\s•●○◦▪■□◆◇◼◻◾◽‣⁃∙]+$/;
const BULLET_PREFIX_REGEX = /^\s*[•●○◦▪■□◆◇◼◻◾◽‣⁃∙]+\s*/;
const DASH_BULLET_PREFIX_REGEX = /^\s*[-–—*]\s+/;
const LEADING_MIDDOT_BULLET_REGEX = /^\s*·\s+/;
const PAGE_MARKER_REGEX = /^\d{1,2}\s*\/\s*\d{1,2}$/;
const PAGE_LABEL_REGEX = /^page\s*\d+(\s*of\s*\d+)?$/i;
const CHINESE_PAGE_REGEX = /^第?\s*\d+\s*页$/;
// Match long alphanumeric gibberish tokens (watermarks, tracking codes, base64-like strings)
const GIBBERISH_TOKEN_REGEX = /^[A-Za-z0-9+/=_-]{28,}$/;

const isPageMarkerLine = (line: string, prevLine: string, nextLine: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === '/' || trimmed === '／') return true;
  if (PAGE_MARKER_REGEX.test(trimmed)) return true;
  if (PAGE_LABEL_REGEX.test(trimmed)) return true;
  if (CHINESE_PAGE_REGEX.test(trimmed)) return true;
  if (/^\d{1,2}$/.test(trimmed)) {
    const prev = prevLine.trim();
    const next = nextLine.trim();
    if (prev === '/' || prev === '／' || next === '/' || next === '／') return true;
    if (/^\d{1,2}$/.test(prev) || /^\d{1,2}$/.test(next)) return true;
    if (PAGE_LABEL_REGEX.test(prev) || PAGE_LABEL_REGEX.test(next)) return true;
  }
  return false;
};

/**
 * JSON schema for structured resume output
 */
const RESUME_JSON_SCHEMA = `{
  "candidateName": "string (required - the person's full name)",
  "contact": {
    "email": "string or null",
    "phone": "string or null",
    "location": "string or null (city, state/province, country)",
    "github": "string or null (GitHub URL or username)",
    "linkedin": "string or null (LinkedIn URL)",
    "website": "string or null",
    "other": ["array of other contact info strings"]
  },
  "objective": "string or null (career objective/goal statement)",
  "summary": "string or null (professional summary)",
  "education": [
    {
      "degree": "string (degree name and major)",
      "institution": "string (school/university name)",
      "location": "string or null",
      "period": "string (e.g., '2019.09–2023.06' or 'Sep 2019 - Jun 2023')",
      "gpa": "string or null",
      "details": ["array of additional details, courses, research areas"]
    }
  ],
  "experience": [
    {
      "title": "string (job title/position)",
      "company": "string (company name)",
      "department": "string or null",
      "location": "string or null",
      "period": "string",
      "highlights": ["array of accomplishments and responsibilities"]
    }
  ],
  "projects": [
    {
      "name": "string (project name)",
      "organization": "string or null (company/university/personal)",
      "period": "string or null",
      "description": "string or null (brief description)",
      "highlights": ["array of key achievements and technical details"],
      "technologies": ["array of technologies used"],
      "links": ["array of relevant URLs"]
    }
  ],
  "skills": [
    {
      "category": "string (e.g., 'Programming Languages', '编程语言')",
      "skills": ["array of skill items"]
    }
  ],
  "languages": [
    {
      "language": "string (e.g., 'English', '中文')",
      "proficiency": "string (e.g., 'Native', 'IELTS 7.5')"
    }
  ],
  "awards": [
    {
      "title": "string",
      "issuer": "string or null",
      "date": "string or null",
      "description": "string or null"
    }
  ],
  "certifications": ["array of certification strings"],
  "publications": ["array of publication strings"],
  "interests": ["array of interest/hobby strings"],
  "other": ["array of any other content that doesn't fit above categories"]
}`;

// ── Text Normalization ─────────────────────────────────────────────────────────

export function normalizeExtractedText(rawText: string): string {
  let text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  const lines = text.split('\n');
  const cleaned: string[] = [];
  let pendingBullet = false;
  let prevNonEmpty = '';
  const nextNonEmpty: string[] = new Array(lines.length).fill('');
  let nextLine = '';

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].replace(/[ \t]+/g, ' ').trim();
    nextNonEmpty[i] = nextLine;
    if (trimmed) nextLine = trimmed;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const originalLine = lines[i];
    let line = originalLine.replace(/[ \t]+/g, ' ').trim();
    const nextCandidate = nextNonEmpty[i];

    if (!line) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') {
        cleaned.push('');
      }
      pendingBullet = false;
      continue;
    }

    if (isPageMarkerLine(line, prevNonEmpty, nextCandidate)) {
      prevNonEmpty = line;
      continue;
    }

    // Filter out gibberish tokens (watermarks, tracking codes)
    if (GIBBERISH_TOKEN_REGEX.test(line)) {
      continue;
    }

    // Filter out single character lines (often extraction artifacts)
    if (line.length === 1 && /^[A-Za-z]$/.test(line)) {
      continue;
    }

    prevNonEmpty = line;

    line = line.replace(BULLET_GLYPH_REGEX, '•');

    if (BULLET_ONLY_REGEX.test(line)) {
      pendingBullet = true;
      continue;
    }

    if (pendingBullet && !line.startsWith('•')) {
      line = `• ${line}`;
    }
    if (pendingBullet) {
      pendingBullet = false;
    }

    if (BULLET_PREFIX_REGEX.test(line)) {
      line = line.replace(BULLET_PREFIX_REGEX, '• ');
    } else if (DASH_BULLET_PREFIX_REGEX.test(line)) {
      line = line.replace(DASH_BULLET_PREFIX_REGEX, '• ');
    } else if (LEADING_MIDDOT_BULLET_REGEX.test(line)) {
      line = line.replace(LEADING_MIDDOT_BULLET_REGEX, '• ');
    }

    line = line.replace(/^•\s*•\s*/, '• ');

    if (cleaned.length > 0) {
      const prev = cleaned[cleaned.length - 1];
      if (prev && /[A-Za-z]-$/.test(prev) && /^[a-z]/.test(line)) {
        cleaned[cleaned.length - 1] = prev.slice(0, -1) + line;
        continue;
      }
    }

    cleaned.push(line);
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Structured-to-Markdown Fallback ────────────────────────────────────────────

export function convertStructuredToMarkdown(data: ParsedResume): string {
  const lines: string[] = [];

  // Name
  lines.push(`# ${data.candidateName}`);
  lines.push('');

  // Contact
  const contactParts: string[] = [];
  if (data.contact.email) contactParts.push(data.contact.email);
  if (data.contact.phone) contactParts.push(data.contact.phone);
  if (data.contact.location) contactParts.push(data.contact.location);
  if (data.contact.github) contactParts.push(data.contact.github);
  if (data.contact.linkedin) contactParts.push(data.contact.linkedin);
  if (data.contact.website) contactParts.push(data.contact.website);
  if (contactParts.length > 0) {
    lines.push(contactParts.join(' • '));
    lines.push('');
  }

  // Objective/Summary
  if (data.objective) {
    lines.push('## 职业目标 / Objective');
    lines.push(data.objective);
    lines.push('');
  }
  if (data.summary) {
    lines.push('## 个人简介 / Summary');
    lines.push(data.summary);
    lines.push('');
  }

  // Education
  if (data.education.length > 0) {
    lines.push('## 教育背景 / Education');
    for (const edu of data.education) {
      if (edu.institution && edu.degree) {
        lines.push(`### ${edu.institution} | ${edu.degree}`);
      } else {
        lines.push(`### ${edu.institution || edu.degree}`);
      }
      if (edu.period) lines.push(`*${edu.period}*`);
      if (edu.location) lines.push(`📍 ${edu.location}`);
      if (edu.gpa) lines.push(`GPA: ${edu.gpa}`);
      if (edu.details) {
        for (const detail of edu.details) {
          lines.push(`• ${detail}`);
        }
      }
      lines.push('');
    }
  }

  // Experience
  if (data.experience.length > 0) {
    lines.push('## 工作经历 / Experience');
    for (const exp of data.experience) {
      if (exp.company && exp.title) {
        lines.push(`### ${exp.company} | ${exp.title}`);
      } else {
        lines.push(`### ${exp.company || exp.title}`);
      }
      if (exp.department) lines.push(`${exp.department}`);
      if (exp.period) lines.push(`*${exp.period}*`);
      if (exp.location) lines.push(`📍 ${exp.location}`);
      for (const highlight of exp.highlights) {
        lines.push(`• ${highlight}`);
      }
      lines.push('');
    }
  }

  // Projects
  if (data.projects.length > 0) {
    lines.push('## 项目经历 / Projects');
    for (const proj of data.projects) {
      const projHeader = proj.organization
        ? `### ${proj.name} — ${proj.organization}`
        : `### ${proj.name}`;
      lines.push(projHeader);
      if (proj.period) lines.push(`*${proj.period}*`);
      if (proj.description) lines.push(proj.description);
      for (const highlight of proj.highlights) {
        lines.push(`• ${highlight}`);
      }
      if (proj.technologies && proj.technologies.length > 0) {
        lines.push(`**技术栈:** ${proj.technologies.join(', ')}`);
      }
      if (proj.links && proj.links.length > 0) {
        lines.push(`**链接:** ${proj.links.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Skills
  if (data.skills.length > 0) {
    lines.push('## 专业技能 / Skills');
    for (const category of data.skills) {
      lines.push(`**${category.category}:** ${category.skills.join(', ')}`);
    }
    lines.push('');
  }

  // Languages
  if (data.languages && data.languages.length > 0) {
    lines.push('## 语言能力 / Languages');
    for (const lang of data.languages) {
      lines.push(`• ${lang.language}: ${lang.proficiency}`);
    }
    lines.push('');
  }

  // Awards
  if (data.awards && data.awards.length > 0) {
    lines.push('## 荣誉奖项 / Awards');
    for (const award of data.awards) {
      const awardLine = award.date
        ? `• ${award.title} (${award.date})`
        : `• ${award.title}`;
      lines.push(awardLine);
      if (award.issuer) lines.push(`  ${award.issuer}`);
      if (award.description) lines.push(`  ${award.description}`);
    }
    lines.push('');
  }

  // Certifications
  if (data.certifications && data.certifications.length > 0) {
    lines.push('## 证书 / Certifications');
    for (const cert of data.certifications) {
      lines.push(`• ${cert}`);
    }
    lines.push('');
  }

  // Interests
  if (data.interests && data.interests.length > 0) {
    lines.push('## 兴趣爱好 / Interests');
    lines.push(data.interests.join(', '));
    lines.push('');
  }

  return lines.join('\n');
}

// ── Service Class ──────────────────────────────────────────────────────────────

export class ResumeParserService {
  /**
   * Parse resume text into structured JSON using LLM.
   */
  async parseResumeStructured(text: string, requestId?: string): Promise<ParsedResume> {
    const systemPrompt = `You are a professional resume parser. Parse the following resume text into a structured JSON format.

IMPORTANT RULES:
1. Extract ALL information from the resume - do not skip or summarize anything
2. DO NOT translate - keep all text in its original language (Chinese stays Chinese, English stays English)
3. The candidateName must be the PERSON's name, NOT a university or company name
4. If information for a field doesn't exist, use null or empty array []
5. Preserve all technical terms, company names, and terminology exactly as written

OUTPUT FORMAT (JSON):
${RESUME_JSON_SCHEMA}

Parse this resume and return ONLY valid JSON (no markdown, no explanation):`;

    logger.info('RESUME_PARSER', 'Calling LLM to parse resume into structured JSON...', {}, requestId);
    const startTime = Date.now();

    const response = await llmService.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      { temperature: 0.0, requestId, model: extractModel() }
    );

    const duration = Date.now() - startTime;
    logger.info('RESUME_PARSER', `Structured parse completed in ${duration}ms`, {}, requestId);

    try {
      // Strip markdown code fences if present
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(jsonStr) as ParsedResume;
      logger.info('RESUME_PARSER', `Successfully parsed resume for: ${parsed.candidateName}`, {}, requestId);
      return parsed;
    } catch (parseError) {
      logger.warn('RESUME_PARSER', 'Failed to parse structured JSON from LLM response', { error: String(parseError) }, requestId);
      return {
        candidateName: 'Unknown',
        contact: {},
        education: [],
        experience: [],
        projects: [],
        skills: [],
      };
    }
  }

  /**
   * Format structured resume data into professional markdown using LLM.
   * Falls back to convertStructuredToMarkdown() if LLM call fails.
   */
  async formatResumeMarkdown(data: ParsedResume, requestId?: string): Promise<string> {
    const systemPrompt = `You are a professional resume formatter. Convert the following structured resume data into beautifully formatted Markdown.

FORMATTING RULES:
1. Start with the candidate's name as a large heading (# Name)
2. Contact info should be on one line, separated by • symbols
3. Use ## for section headings (教育背景, 工作经历, 项目经历, 技能, etc.)
4. Use ### for job titles/company names with dates
5. Use bullet points (•) for highlights and achievements
6. Keep all text in its ORIGINAL language - do NOT translate
7. Make it visually clean and professional
8. Include ALL information - do not skip anything

INPUT (Structured JSON):
${JSON.stringify(data, null, 2)}

Output beautifully formatted Markdown:`;

    try {
      const response = await llmService.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Format this resume into professional Markdown.' },
        ],
        { temperature: 0.1, requestId, model: extractModel() }
      );

      const formatted = response.trim();
      if (formatted.length > 0) {
        return formatted;
      }
    } catch (formatError) {
      logger.warn('RESUME_PARSER', 'Resume format LLM call failed, using fallback formatter', { error: String(formatError) }, requestId);
    }

    // Fallback to deterministic formatter
    return convertStructuredToMarkdown(data);
  }

  /**
   * One-shot resume parsing: raw text → professional markdown.
   * First tries direct formatting (more reliable, less data loss).
   * Falls back to two-step (structured JSON → markdown) if direct fails.
   */
  async parseAndFormatResume(rawText: string, requestId?: string): Promise<string> {
    const systemPrompt = `You are a professional resume formatter. Convert the following raw resume text into beautifully formatted Markdown.

CRITICAL RULES:
1. Extract and include ALL information from the resume - do NOT skip, summarize, or omit anything
2. Keep all text in its ORIGINAL language - do NOT translate (Chinese stays Chinese, English stays English)
3. Preserve all technical terms, company names, university names, and terminology exactly as written

FORMATTING RULES:
1. Start with the candidate's name as a large heading (# Name)
2. Contact info (email, phone, etc.) should be on one line, separated by • symbols
3. Use ## for section headings (教育背景, 工作经历, 项目经历, 技能, etc.)
4. For education: use ### for each entry in format "学校名 | 学位,专业:专业名称" with location and period below
5. For work experience: use ### for each entry in format "公司名 | 职位" with location and period below
6. Use bullet points (•) for highlights, achievements, and details
7. Include ALL bullet points and details - every single one
8. Make it visually clean and professional

RESUME TEXT:`;

    try {
      logger.info('RESUME_PARSER', 'Direct text-to-markdown formatting...', {}, requestId);
      const response = await llmService.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: rawText },
        ],
        { temperature: 0.1, requestId, model: extractModel() }
      );

      const formatted = response.trim();
      // Remove markdown code fences if LLM wrapped the output
      const cleaned = formatted.startsWith('```')
        ? formatted.replace(/^```(?:markdown)?\s*\n?/, '').replace(/\n?```\s*$/, '')
        : formatted;

      if (cleaned.length > 100) {
        logger.info('RESUME_PARSER', `Direct formatting succeeded (${cleaned.length} chars)`, {}, requestId);
        return cleaned;
      }
    } catch (err) {
      logger.warn('RESUME_PARSER', 'Direct formatting failed, falling back to two-step', { error: String(err) }, requestId);
    }

    // Fallback: two-step parse → format
    logger.info('RESUME_PARSER', 'Falling back to two-step structured parse + format', {}, requestId);
    const parsedData = await this.parseResumeStructured(rawText, requestId);
    return this.formatResumeMarkdown(parsedData, requestId);
  }
}

/**
 * Convert new ParsedResume format to the legacy format expected by routes/resumes.ts.
 * Maps candidateName→name, contact.email→email, experience[].title→role, etc.
 */
export function toLegacyFormat(data: ParsedResume): Record<string, any> {
  return {
    name: data.candidateName || 'Unknown',
    email: data.contact?.email || null,
    phone: data.contact?.phone || null,
    address: data.contact?.location || null,
    linkedin: data.contact?.linkedin || null,
    github: data.contact?.github || null,
    portfolio: data.contact?.website || null,
    summary: data.summary || data.objective || null,
    skills: data.skills?.length
      ? data.skills.reduce((acc: Record<string, string[]>, cat) => {
          acc[cat.category] = cat.skills;
          return acc;
        }, {})
      : [],
    experience: (data.experience || []).map(exp => ({
      company: exp.company,
      role: exp.title,
      department: exp.department || null,
      location: exp.location || null,
      startDate: exp.period || '',
      endDate: '',
      duration: exp.period || '',
      employmentType: null,
      achievements: exp.highlights || [],
      technologies: [],
    })),
    education: (data.education || []).map(edu => ({
      institution: edu.institution,
      degree: edu.degree,
      field: '',
      location: edu.location || null,
      startDate: edu.period || '',
      endDate: '',
      gpa: edu.gpa || null,
      coursework: edu.details || [],
    })),
    projects: (data.projects || []).map(proj => ({
      name: proj.name,
      organization: proj.organization || null,
      period: proj.period || null,
      description: proj.description || null,
      highlights: proj.highlights || [],
      technologies: proj.technologies || [],
      links: proj.links || [],
    })),
    languages: data.languages || [],
    awards: data.awards || [],
    certifications: data.certifications || [],
    publications: data.publications || [],
    interests: data.interests || [],
    otherSections: data.other ? { other: data.other.join('\n') } : {},
  };
}

// ── Singleton Export ───────────────────────────────────────────────────────────

export const resumeParserService = new ResumeParserService();
