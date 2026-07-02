import { BaseAgent } from './BaseAgent.js';
import { withLLMRetry } from '../services/llm/withRetry.js';
import type { Message, ParsedResume, WorkExperience } from '../types/index.js';
import { logger } from '../services/LoggerService.js';
import { isParsedResumeLikelyIncomplete } from '../services/ResumeParseValidation.js';

interface ResumeParseInput {
  resumeText: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,3}[-\s]?)?(1[3-9]\d{9}|\d{3,4}[-\s]?\d{7,8})/;
const DATE_RANGE_RE = /((?:19|20)\d{2}[./-]\d{1,2})\s*(?:-|–|—|~|至)\s*(至今|present|current|now|(?:19|20)\d{2}[./-]\d{1,2})/i;
const CONTACT_BLOCK_NAME_RE = /^[\u3400-\u9fff·•]{2,6}$/;
const DEMOGRAPHIC_RE = /^(?:男|女)\s*[|｜]/;
const HEADING_RE = /^(?:个人优势|工作经历|工作经验|实习经历|教育背景|教育经历|项目经历|项目经验|专业技能|技能|证书|技能证书|荣誉奖项|自我评价|求职意向)$/;
const TRAILING_ROLE_RE = /(经理|顾问|专家|工程师|架构师|总监|主任|主管|专员|助理|分析师|咨询师|实施|实习生|实习员|开发|设计师|运营|产品|研究员|测试|consultant|manager|engineer|architect|director|analyst|developer|lead|specialist|intern)$/i;
const CJK_TECH_TERMS = [
  '用友', '金蝶', '数据治理', '财务共享', '低代码', '业财一体化', '业务再造',
];

/**
 * Agent for parsing resumes and extracting structured data
 * Extracts contact info, skills, experience, education, etc.
 */
export class ResumeParseAgent extends BaseAgent<ResumeParseInput, ParsedResume> {
  constructor() {
    super('ResumeParseAgent');
  }

  /**
   * Parsing is structured extraction, not creative generation. Low
   * temperature keeps the output stable across reparses and avoids the
   * "same resume, different fields on retry" behaviour that confused users
   * who clicked Reparse expecting a fix.
   */
  protected override getTemperature(): number {
    return 0.1;
  }

  protected getAgentPrompt(): string {
    return `You are an expert multilingual resume parser. Your task is to extract ALL information from resume text into a structured JSON format, preserving every detail completely.

## CRITICAL RULES — ZERO INFORMATION LOSS:
1. Extract EVERY piece of information. Do NOT summarize, truncate, paraphrase, or omit anything.
2. Copy the EXACT original text — every bullet point, every sentence, every detail, word for word.
3. For non-English resumes (Chinese, Japanese, Korean, etc.), preserve the ORIGINAL language text verbatim. Do NOT translate or romanize.
4. Every entry (work experience, education, project, award, certification) MUST be included — do NOT skip any.
5. If a section has sub-sections or nested content (e.g., awards listed under education), extract each item into its proper category AND keep it in the parent section's achievements too.
6. **Section order is NOT guaranteed.** Many PDFs list the CONTENT first and the section HEADERS (个人优势, 专业技能, 工作经历, etc.) later. Treat every date-range line (e.g. "2021.07-至今", "2020.06-2021.07") as a work-experience entry regardless of where the 工作经历/Work Experience heading appears — or even if that heading is missing entirely. Same for numbered skill bullets (lines starting with "1.", "2.", "3." that describe a technical capability): extract them into skills even if they appear before any 专业技能/Skills heading.
7. **Ignore watermarks and content-protection artifacts.** If the same short opaque string (hex, base64, or hash-looking token like "a229c545eb287fec1HV_2t6_EltYx4y9U_...") repeats three or more times, it is a PDF watermark — do not treat it as a section header, skill, or content. Skip over it silently. The same applies to repeated CJK watermark phrases such as "招聘专用" (recruitment use only), "内部资料" / "内部使用" (internal materials), "机密文件" / "保密文件" (confidential document), "请勿外传" / "禁止外传" (do not share), "仅供XX使用" (for XX use only), "版权所有" (copyright). **Any company name attached to one of these phrases — e.g. "XX有限公司 招聘专用", "XX企业管理咨询有限公司 招聘专用" — is the watermarking entity (the recruitment platform or document owner), NOT the candidate's employer. Never list it as work experience.** Skip these watermark lines entirely.
8. **Never stop after extracting only the summary.** If you find a summary/个人简介 paragraph, keep scanning the rest of the text for skills, experience, education, projects — all resumes have more than one section.

## SECTION MAPPING — Handle all common resume section names:

**Personal Info** (基本信息, 个人信息, 联系方式, Contact):
→ name, email, phone, address, linkedin, github, portfolio
→ Also extract: age, gender, location/city (现居地), nationality, marital status, etc. into "otherSections"

**Summary / Self-evaluation** (自我评价, 个人简介, 个人总结, 求职意向, Career Objective, Profile, About Me):
→ "summary" — copy the COMPLETE text

**Skills** (专业技能, 技能, 技术栈, Skills, Technical Skills):
→ Categorize into: technical, soft, languages (programming), tools, frameworks, other
→ Preserve the FULL description of each skill category (e.g., "熟练掌握 Rust, Python" → technical: ["Rust", "Python"])
→ Also put the complete original skill description text into "otherSections.skillsRaw"

**Work Experience / Internships** (工作经历, 实习经历, 工作经验, Employment History, Experience):
→ "experience" array — one entry per position
→ 要识别公司名称，岗位，任职期间，任职地点
→ employmentType: "internship" if title/section contains 实习/Intern/インターン/Stagiaire/Praktikant; "contract" for contractor; "freelance" for freelance; "part-time" if specified; default "full-time"
→ "description": include ALL bullet points concatenated with newlines, exactly as written
→ "achievements": each bullet point as a separate array element, complete text

**Projects** (项目经历, 项目经验, 科研项目, 本科科研项目, 研究生科研项目, Research Projects, Academic Projects, Personal Projects):
→ "projects" array — one entry per project
→ Include ALL bullet points in "description", every technical detail, every result/metric
→ If a project has 关键词/Keywords, include them in "technologies"

**Education** (教育背景, 教育经历, 学历, Education):
→ "education" array — one entry per degree/institution
→ 要识别学校名称，学位，专业，在学和毕业时间，地点
→ Include: institution, degree (学士/硕士/博士/Bachelor/Master/PhD), field/major, dates, GPA/成绩/排名
→ "coursework": list ALL courses mentioned (主修课程)
→ "achievements": include ALL honors, scholarships (奖学金), rankings (排名), dean's list, etc.

**Awards / Honors** (荣誉奖项, 获奖情况, 竞赛, Awards, Honors, Competitions):
→ "awards" array — one entry per award
→ Include: name, issuer/organization, date, full description
→ Awards for math competitions (数学建模), hackathons, scholarships (国家奖学金, 一等奖学金) — include ALL

**Certifications / Certificates** (技能证书, 资格证书, Certifications, Licenses):
→ "certifications" array

**Languages** (语言能力, Language Skills):
→ "languages" array with proficiency (CET-4/6, IELTS, TOEFL scores, etc.)

**Publications / Patents** (发表论文, 学术成果, Publications, Patents):
→ "publications" and "patents" arrays — include complete citations

**Volunteer Work** (志愿者经历, 社会实践, Volunteer, Community Service):
→ "volunteerWork" array

**Any other section** not listed above:
→ Put its COMPLETE content into "otherSections" using the original section title as the key

## OUTPUT FORMAT — Return ONLY this JSON, no other text:

\`\`\`json
{
  "name": "<full name>",
  "email": "<email or empty string>",
  "phone": "<phone number or empty string>",
  "address": "<address/location if present>",
  "linkedin": "<LinkedIn URL if present>",
  "github": "<GitHub URL if present>",
  "portfolio": "<website/portfolio URL if present>",
  "summary": "<COMPLETE self-evaluation / summary / objective — full original text>",
  "skills": {
    "technical": ["skill1", "skill2"],
    "soft": ["skill1", "skill2"],
    "languages": ["programming language1", "language2"],
    "tools": ["tool1", "tool2"],
    "frameworks": ["framework1", "framework2"],
    "other": ["other1"]
  },
  "experience": [
    {
      "company": "<company name>",
      "role": "<job title>",
      "location": "<location>",
      "startDate": "<start date>",
      "endDate": "<end date or Present/至今>",
      "duration": "<calculated duration>",
      "employmentType": "<full-time|part-time|internship|contract|freelance>",
      "description": "<ALL bullet points joined with newlines — complete text, no omissions>",
      "achievements": ["<bullet 1 complete text>", "<bullet 2 complete text>"],
      "technologies": ["tech1", "tech2"]
    }
  ],
  "projects": [
    {
      "name": "<project name>",
      "role": "<role if mentioned>",
      "date": "<date range>",
      "description": "<ALL bullet points joined with newlines — every detail preserved>",
      "technologies": ["tech1", "tech2"],
      "link": "<URL if present>"
    }
  ],
  "education": [
    {
      "institution": "<school name>",
      "degree": "<degree type, e.g. 硕士/Bachelor/PhD>",
      "field": "<major/field of study>",
      "startDate": "<start date>",
      "endDate": "<end date>",
      "gpa": "<GPA or score, e.g. 88/100 (前5%), 3.86/4.00>",
      "achievements": ["<scholarship>", "<honor>", "<ranking>"],
      "coursework": ["<course1>", "<course2>"]
    }
  ],
  "certifications": [
    {
      "name": "<cert name>",
      "issuer": "<issuer>",
      "date": "<date>",
      "expiryDate": "<expiry if applicable>",
      "credentialId": "<ID if present>"
    }
  ],
  "awards": [
    {
      "name": "<award name — full text>",
      "issuer": "<organization>",
      "date": "<date>",
      "description": "<full description including context>"
    }
  ],
  "languages": [
    {
      "language": "<language>",
      "proficiency": "<level, e.g. CET-6, IELTS 6.5, Native>"
    }
  ],
  "volunteerWork": [
    {
      "organization": "<org>",
      "role": "<role>",
      "duration": "<period>",
      "description": "<COMPLETE description>"
    }
  ],
  "publications": ["<complete citation 1>"],
  "patents": ["<complete patent info>"],
  "otherSections": {
    "<original section title>": "<COMPLETE content of that section>"
  }
}
\`\`\`

## FINAL CHECK — Before outputting, verify:
- Every section heading in the resume has its content captured somewhere in the JSON
- Every bullet point under every section is present in full
- No project, job, degree, award, or certification was skipped
- GPA, rankings, scores, and dates are all preserved
- The "description" fields contain ALL bullet points, not just the first few`;
  }

  protected formatInput(input: ResumeParseInput): string {
    return `## Resume Text:
${input.resumeText}

Please parse this resume and extract structured information.`;
  }

  private hasSkillContent(skills: ParsedResume['skills'] | undefined): boolean {
    if (!skills) return false;
    if (Array.isArray(skills)) return skills.some((item) => typeof item === 'string' && item.trim().length > 0);
    return Object.values(skills).some((items) => Array.isArray(items) && items.some((item) => typeof item === 'string' && item.trim().length > 0));
  }

  private hasMeaningfulExperience(experience: ParsedResume['experience'] | undefined): boolean {
    if (!Array.isArray(experience) || experience.length === 0) return false;

    return experience.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const hasAchievements = Array.isArray(entry.achievements) && entry.achievements.some((item) => typeof item === 'string' && item.trim().length > 0);
      const hasTechnologies = Array.isArray(entry.technologies) && entry.technologies.some((item) => typeof item === 'string' && item.trim().length > 0);

      return [
        entry.company,
        entry.role,
        entry.location,
        entry.description,
        entry.startDate,
        entry.endDate,
        entry.duration,
      ].some((value) => typeof value === 'string' && value.trim().length > 0) || hasAchievements || hasTechnologies;
    });
  }

  private normalizeLines(resumeText: string): string[] {
    return resumeText
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  private looksLikeContactSignal(line: string): boolean {
    return DEMOGRAPHIC_RE.test(line) ||
      EMAIL_RE.test(line) ||
      PHONE_RE.test(line) ||
      /出生年月|出生日期|性别|政治面貌|现居地|所在地|联系电话|电话|邮箱|email|mail|求职意向|期望薪资|期望城市/i.test(line);
  }

  private isLikelySummaryNoise(line: string): boolean {
    const normalized = line.replace(/\s+/g, '').trim();
    if (!normalized) return true;
    if (normalized.length === 1) return true;
    if (/^(男|女)$/.test(normalized)) return true;
    if (this.looksLikeContactSignal(line)) return true;
    if (/^[•·▪▫◦]$/.test(normalized)) return true;
    return false;
  }

  private mergeSplitChineseName(lines: string[], index: number, baseName: string): string {
    const lookahead = lines.slice(index + 1, index + 7);
    const hasContactSignal = lookahead.some((line) => this.looksLikeContactSignal(line));
    if (!hasContactSignal) {
      return baseName;
    }

    const trailingChars = lookahead.filter((line) => /^[\u3400-\u9fff·•]$/.test(line) && !/^(男|女)$/.test(line));
    if (trailingChars.length !== 1) {
      return baseName;
    }

    return `${baseName}${trailingChars[0]}`;
  }

  private resolveCandidateName(parsedName: string | undefined, fallbackName: string): string {
    // For CJK names, remove all spaces (e.g. "崔 晋 闻" → "崔晋闻").
    // For Latin names, collapse multiple spaces but preserve word separation.
    const normalizeName = (n: string) => {
      const trimmed = n.trim();
      const hasCjk = /[\u3400-\u9fff]/.test(trimmed);
      return hasCjk ? trimmed.replace(/\s+/g, '') : trimmed.replace(/\s+/g, ' ');
    };
    const existing = typeof parsedName === 'string' ? normalizeName(parsedName) : '';
    const fallback = normalizeName(fallbackName);

    if (!existing) return fallback;
    if (!fallback) return existing;
    if (existing === fallback) return existing;

    // Prefer the longer name when one contains the other
    // e.g. LLM returns "崔晋" but heuristic found "崔晋闻"
    if (fallback.startsWith(existing) && fallback.length > existing.length) {
      return fallback;
    }
    if (existing.startsWith(fallback) && existing.length > fallback.length) {
      return existing;
    }

    return existing;
  }

  private findName(lines: string[]): string {
    // Strategy 1: standalone CJK name line followed by contact info
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!CONTACT_BLOCK_NAME_RE.test(line)) continue;
      const nextLines = lines.slice(i + 1, i + 4);
      if (nextLines.some((item) => this.looksLikeContactSignal(item) || /工作经验/.test(item))) {
        return this.mergeSplitChineseName(lines, i, line);
      }
    }

    // Strategy 2: name at start of line followed by "个人简历" / "简历" / other common suffixes
    // e.g. "崔晋闻 个人简历" or "张三 简历"
    for (let i = 0; i < Math.min(lines.length, 5); i += 1) {
      const match = lines[i].match(/^([\u3400-\u9fff]{2,4})\s+(?:个人简历|简历|resume|CV|履历)/i);
      if (match) return match[1];
    }

    // Strategy 3: first CJK-only token (2-4 chars) in the first 3 lines, when contact info follows
    for (let i = 0; i < Math.min(lines.length, 3); i += 1) {
      const nameMatch = lines[i].match(/^([\u3400-\u9fff]{2,4})(?:\s|$)/);
      if (!nameMatch) continue;
      const nextLines = lines.slice(i, i + 5);
      if (nextLines.some((item) => this.looksLikeContactSignal(item))) {
        return nameMatch[1];
      }
    }

    // Strategy 4: English name — 2-3 capitalized words on a standalone line near the top,
    // followed by contact info (email/phone) within the next few lines.
    // e.g. "Ding Yi", "John Smith", "Sarah Jane Parker"
    for (let i = 0; i < Math.min(lines.length, 5); i += 1) {
      const engName = lines[i].match(/^([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)$/);
      if (!engName) continue;
      const nextLines = lines.slice(i + 1, i + 5);
      if (nextLines.some((item) => this.looksLikeContactSignal(item))) {
        return engName[1];
      }
    }

    return '';
  }

  private findAddress(lines: string[]): string {
    for (const line of lines) {
      const match = line.match(/(?:现居地|所在地|居住地|期望城市|城市)[:：]\s*([^|｜\s]+)/);
      if (match?.[1]) return match[1].trim();
    }
    return '';
  }

  private findSummary(lines: string[]): string {
    const firstExperienceIndex = lines.findIndex((line) => DATE_RANGE_RE.test(line));
    const introLines = (firstExperienceIndex > 0 ? lines.slice(0, firstExperienceIndex) : lines.slice(0, 4))
      .filter((line) => !EMAIL_RE.test(line))
      .filter((line) => !PHONE_RE.test(line))
      .filter((line) => !CONTACT_BLOCK_NAME_RE.test(line))
      .filter((line) => !DEMOGRAPHIC_RE.test(line))
      .filter((line) => !this.isLikelySummaryNoise(line))
      .filter((line) => !/工作经验|求职意向|期望薪资|期望城市/.test(line));
    return introLines.join('\n').trim();
  }

  private extractSkillsFromText(resumeText: string): string[] {
    const found = new Set<string>();

    for (const match of resumeText.matchAll(/\b[A-Z][A-Z0-9.+/-]{2,}\b/g)) {
      const token = match[0].trim();
      if (token.length >= 3) found.add(token);
    }

    for (const term of CJK_TECH_TERMS) {
      if (resumeText.includes(term)) found.add(term);
    }

    return [...found].slice(0, 12);
  }

  private splitCompanyRole(line: string): { company: string; role: string } {
    const normalized = line.replace(/\s+/g, ' ').trim();
    if (!normalized) return { company: '', role: '' };

    const lastSpace = normalized.lastIndexOf(' ');
    if (lastSpace > 0) {
      const company = normalized.slice(0, lastSpace).trim();
      const role = normalized.slice(lastSpace + 1).trim();
      if (TRAILING_ROLE_RE.test(role) || role.length <= 18) {
        return { company, role };
      }
    }

    return { company: normalized, role: '' };
  }

  private extractExperience(lines: string[]): WorkExperience[] {
    const entries: WorkExperience[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const dateMatch = lines[i].match(DATE_RANGE_RE);
      if (!dateMatch) continue;

      const startDate = dateMatch[1];
      const endDate = dateMatch[2];

      // Check if company/role is on the same line after the date range
      // e.g. "2025-07 ~ 2025-09 ＮＩＯ蔚来汽车（上海）" or "2025-07 ~ 2025-09 NIO蔚来汽车（上海） 全栈开发实习生"
      const dateEndPos = lines[i].indexOf(dateMatch[2]) + dateMatch[2].length;
      const sameLineRemainder = lines[i].slice(dateEndPos).trim();

      let company = '';
      let role = '';
      let nextIndex = i + 1;

      if (sameLineRemainder.length > 1) {
        // Company (and possibly role) is on the same line as the date
        const split = this.splitCompanyRole(sameLineRemainder);
        company = split.company;
        role = split.role;

        // If we only got company from the date line, check next line for role
        // The next short non-bullet, non-date line is likely the job title
        if (!role) {
          while (nextIndex < lines.length && HEADING_RE.test(lines[nextIndex])) {
            nextIndex += 1;
          }
          const nextLine = (lines[nextIndex] || '').trim();
          const isLikelyRole = nextLine
            && !DATE_RANGE_RE.test(nextLine)
            && !nextLine.startsWith('·')
            && !nextLine.startsWith('•')
            && nextLine.length <= 20
            && (TRAILING_ROLE_RE.test(nextLine) || /[\u4e00-\u9fff]/.test(nextLine));
          if (isLikelyRole) {
            role = nextLine;
            nextIndex += 1;
          }
        }
      } else {
        // Company/role is on the next line (original behavior)
        while (nextIndex < lines.length && HEADING_RE.test(lines[nextIndex])) {
          nextIndex += 1;
        }
        const headerLine = lines[nextIndex] || '';
        const split = this.splitCompanyRole(headerLine);
        company = split.company;
        role = split.role;
        if (headerLine) nextIndex += 1;
      }
      const descriptionLines: string[] = [];
      let scanIndex = nextIndex;

      while (scanIndex < lines.length) {
        const current = lines[scanIndex];
        if (DATE_RANGE_RE.test(current)) break;
        if (HEADING_RE.test(current) && descriptionLines.length > 0) break;
        if (CONTACT_BLOCK_NAME_RE.test(current) || DEMOGRAPHIC_RE.test(current) || EMAIL_RE.test(current) || PHONE_RE.test(current)) break;
        descriptionLines.push(current);
        scanIndex += 1;
      }

      const description = descriptionLines.join('\n').trim();
      if (company || role || description) {
        entries.push({
          company,
          role,
          startDate,
          endDate,
          duration: `${startDate}-${endDate}`,
          description,
          achievements: descriptionLines,
          technologies: this.extractSkillsFromText([company, role, description].filter(Boolean).join('\n')),
          employmentType: /实习|intern/i.test([company, role, description].join('\n')) ? 'internship' : 'full-time',
        });
      }

      if (scanIndex > i) {
        i = scanIndex - 1;
      }
    }

    return entries;
  }

  private buildHeuristicFallback(resumeText: string, parsed: ParsedResume): ParsedResume {
    const lines = this.normalizeLines(resumeText);
    const fallbackName = this.findName(lines);
    const fallbackSummary = this.findSummary(lines);
    const fallbackSkills = this.extractSkillsFromText(resumeText);
    const fallbackExperience = this.extractExperience(lines);
    const intentLine = lines.find((line) => /求职意向|期望薪资|期望城市/.test(line)) || '';

    const existingSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const summary = !existingSummary || existingSummary === 'Unable to parse resume' || existingSummary.length < Math.max(40, Math.floor(fallbackSummary.length * 0.4))
      ? fallbackSummary || existingSummary
      : existingSummary;

    const otherSections = {
      ...(parsed.otherSections || {}),
      ...(intentLine ? { 求职概况: intentLine } : {}),
    };

    return {
      ...parsed,
      name: this.resolveCandidateName(parsed.name, fallbackName),
      email: parsed.email || (resumeText.match(EMAIL_RE)?.[0] ?? ''),
      phone: parsed.phone || (resumeText.match(PHONE_RE)?.[0] ?? ''),
      address: parsed.address || this.findAddress(lines),
      summary,
      skills: this.hasSkillContent(parsed.skills)
        ? parsed.skills
        : (fallbackSkills.length > 0 ? { technical: fallbackSkills } : parsed.skills),
      experience: this.hasMeaningfulExperience(parsed.experience) ? parsed.experience : fallbackExperience,
      otherSections: Object.keys(otherSections).length > 0 ? otherSections : undefined,
    };
  }

  protected parseOutput(response: string): ParsedResume {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
                      response.match(/```\s*([\s\S]*?)\s*```/) ||
                      response.match(/(\{[\s\S]*\})/);

    let raw: Record<string, unknown> | null = null;
    if (jsonMatch && jsonMatch[1]) {
      try {
        raw = JSON.parse(jsonMatch[1].trim());
      } catch {
        // Continue to try parsing the entire response
      }
    }

    if (!raw) {
      try {
        raw = JSON.parse(response);
      } catch {
        return {
          name: '',
          email: '',
          phone: '',
          skills: [],
          experience: [],
          education: [],
          summary: 'Unable to parse resume',
          rawText: response,
        };
      }
    }

    // Normalize field names — LLMs sometimes use alternative keys
    return ResumeParseAgent.normalizeFields(raw as Record<string, unknown>);
  }

  /**
   * Pick the first non-empty string value from an object by trying multiple key names.
   */
  private static pick(obj: Record<string, unknown>, ...keys: string[]): string {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  /**
   * Normalize LLM output field names to canonical ParsedResume shape.
   * Handles common variations like school→institution, title→role, etc.
   */
  private static normalizeFields(raw: Record<string, unknown>): ParsedResume {
    const pick = ResumeParseAgent.pick;

    const result: ParsedResume = {
      name: pick(raw, 'name', 'candidateName', 'fullName', '姓名'),
      email: pick(raw, 'email', 'e-mail', '邮箱'),
      phone: pick(raw, 'phone', 'telephone', 'mobile', '电话', '手机'),
      address: pick(raw, 'address', 'location', '地址', '现居地'),
      linkedin: pick(raw, 'linkedin', 'linkedIn'),
      github: pick(raw, 'github', 'GitHub'),
      portfolio: pick(raw, 'portfolio', 'website', 'personalSite', '个人网站'),
      summary: pick(raw, 'summary', 'objective', 'profile', 'aboutMe', '自我评价', '个人简介', '求职意向'),
      skills: (raw.skills ?? []) as ParsedResume['skills'],
      experience: [],
      education: [],
      projects: [],
    };

    // Normalize education entries
    const eduArray = Array.isArray(raw.education) ? raw.education : [];
    result.education = eduArray.map((e: Record<string, unknown>) => ({
      institution: pick(e, 'institution', 'school', 'university', 'schoolName', 'school_name', 'college', '学校', '院校'),
      degree: pick(e, 'degree', 'degreeName', 'degreeType', '学位', '学历'),
      field: pick(e, 'field', 'major', 'fieldOfStudy', 'specialization', '专业'),
      startDate: pick(e, 'startDate', 'start_date', 'from', 'startYear'),
      endDate: pick(e, 'endDate', 'end_date', 'to', 'endYear'),
      year: pick(e, 'year', 'graduationYear'),
      gpa: pick(e, 'gpa', 'grade', 'score', '成绩', '绩点', 'GPA'),
      achievements: Array.isArray(e.achievements) ? e.achievements as string[] : [],
      coursework: Array.isArray(e.coursework) ? e.coursework as string[]
        : Array.isArray(e.courses) ? e.courses as string[] : [],
    }));

    // Normalize experience entries
    const expArray = Array.isArray(raw.experience) ? raw.experience : [];
    result.experience = expArray.map((e: Record<string, unknown>) => ({
      company: pick(e, 'company', 'companyName', 'company_name', 'employer', 'organization', '公司'),
      role: pick(e, 'role', 'title', 'jobTitle', 'job_title', 'position', '职位', '岗位'),
      location: pick(e, 'location', 'city', '地点'),
      startDate: pick(e, 'startDate', 'start_date', 'from'),
      endDate: pick(e, 'endDate', 'end_date', 'to'),
      duration: pick(e, 'duration', 'period', '时长'),
      description: pick(e, 'description', '描述'),
      achievements: Array.isArray(e.achievements) ? e.achievements as string[] : [],
      technologies: Array.isArray(e.technologies) ? e.technologies as string[] : [],
      employmentType: (pick(e, 'employmentType', 'employment_type', 'type') || undefined) as WorkExperience['employmentType'],
    }));

    // Normalize project entries
    const projArray = Array.isArray(raw.projects) ? raw.projects : [];
    result.projects = projArray.map((p: Record<string, unknown>) => ({
      name: pick(p, 'name', 'projectName', 'title', '项目名称'),
      role: pick(p, 'role', 'position', '角色'),
      date: pick(p, 'date', 'period', 'duration', 'dates'),
      description: pick(p, 'description', '描述'),
      technologies: Array.isArray(p.technologies) ? p.technologies as string[] : [],
      link: pick(p, 'link', 'url', 'links'),
    }));

    // Pass through other arrays as-is
    if (Array.isArray(raw.certifications)) result.certifications = raw.certifications as ParsedResume['certifications'];
    if (Array.isArray(raw.awards)) result.awards = raw.awards as ParsedResume['awards'];
    if (Array.isArray(raw.languages)) result.languages = raw.languages as ParsedResume['languages'];
    if (Array.isArray(raw.volunteerWork)) result.volunteerWork = raw.volunteerWork as ParsedResume['volunteerWork'];
    if (Array.isArray(raw.publications)) result.publications = raw.publications as string[];
    if (Array.isArray(raw.patents)) result.patents = raw.patents as string[];
    if (raw.otherSections && typeof raw.otherSections === 'object') {
      result.otherSections = raw.otherSections as Record<string, string>;
    }

    return result;
  }

  /**
   * Parse a resume from text.
   *
   * `signal` is the request-lifecycle AbortSignal (see lib/requestAbort.ts):
   * when the client/proxy disconnects it cancels the in-flight LLM call and
   * stops the retry budget so the worker isn't pinned for minutes after the
   * caller is gone.
   */
  async parse(resumeText: string, requestId?: string, signal?: AbortSignal): Promise<ParsedResume> {
    const result = await this.parseOnce(resumeText, requestId, false, signal);
    const parsed = {
      ...result,
      rawText: resumeText,
    };

    if (!isParsedResumeLikelyIncomplete(parsed, resumeText)) {
      return parsed;
    }

    const heuristic = {
      ...this.buildHeuristicFallback(resumeText, parsed),
      rawText: resumeText,
    };
    if (!isParsedResumeLikelyIncomplete(heuristic, resumeText)) {
      logger.warn('RESUME_PARSE', 'Sparse resume parse recovered with heuristic text fallback', {
        resumeLength: resumeText.length,
        experienceCount: heuristic.experience.length,
        hasEmail: Boolean(heuristic.email),
        hasPhone: Boolean(heuristic.phone),
      }, requestId);
      return heuristic;
    }

    // If the request budget is already spent (deadline reached or client/edge
    // disconnected), don't start a second LLM pass — it would just be aborted and
    // waste quota on a request nobody is waiting for. Return the best-effort
    // heuristic from the first parse so the caller still gets usable (if sparse)
    // data. This bounds parse() to a single LLM pass once the signal has fired,
    // keeping the worst case structurally under the route's ~85s deadline.
    if (signal?.aborted) {
      logger.warn('RESUME_PARSE', 'Skipping sparse-retry pass — request budget already aborted', {
        resumeLength: resumeText.length,
      }, requestId);
      return heuristic;
    }

    logger.warn('RESUME_PARSE', 'Sparse resume parse detected, retrying with stricter extraction prompt', {
      resumeLength: resumeText.length,
    }, requestId);

    const retried = await this.parseOnce(resumeText, requestId, true, signal);
    const retriedParsed = {
      ...retried,
      rawText: resumeText,
    };

    if (!isParsedResumeLikelyIncomplete(retriedParsed, resumeText)) {
      return retriedParsed;
    }

    const repaired = {
      ...this.buildHeuristicFallback(resumeText, retriedParsed),
      rawText: resumeText,
    };
    if (!isParsedResumeLikelyIncomplete(repaired, resumeText)) {
      logger.warn('RESUME_PARSE', 'Retry remained sparse, recovered with heuristic text fallback', {
        resumeLength: resumeText.length,
        experienceCount: repaired.experience.length,
        hasEmail: Boolean(repaired.email),
        hasPhone: Boolean(repaired.phone),
      }, requestId);
      return repaired;
    }

    logger.error('RESUME_PARSE', 'Retry and heuristic fallback still produced sparse resume parse', {
      resumeLength: resumeText.length,
    }, requestId);
    return repaired;
  }

  private async parseOnce(resumeText: string, requestId?: string, retry = false, signal?: AbortSignal): Promise<ParsedResume> {
    const systemPrompt = [
      this.buildSystemPrompt(resumeText, requestId),
      retry
        ? 'Your previous extraction missed resume sections. Re-read the entire resume text and make sure every non-education section is captured, especially skills, projects, publications, internships, contact details, and languages.'
        : '',
    ].filter(Boolean).join('\n\n');

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.formatInput({ resumeText }) },
    ];

    // Wrap in withLLMRetry so a transient provider hiccup (notably OpenRouter
    // "Premature close" — a mid-stream socket drop, more likely here because of
    // the 24k-token budget keeping the connection open longer) is retried rather
    // than surfaced as a 500. parseOnce calls chatLogged directly (not via
    // BaseAgent.execute), so without this it had no retry net. See withRetry.ts.
    const response = await withLLMRetry(
      () => this.chatLogged(messages, {
        temperature: retry ? 0 : 0.1,
        maxTokens: 24000,
        requestId,
        ...(signal ? { signal } : {}),
      }),
      { label: `${this.name}.parseOnce`, requestId, signal },
    );

    return this.parseOutput(response);
  }
}

export const resumeParseAgent = new ResumeParseAgent();
