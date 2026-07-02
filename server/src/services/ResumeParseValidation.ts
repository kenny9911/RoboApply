import type { ParsedResume, SkillsDetailed } from '../types/index.js';

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasContent(value: unknown): boolean {
  if (hasText(value)) return true;
  if (Array.isArray(value)) return value.some((item) => hasContent(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasContent(item));
  }
  return false;
}

function countArrayEntries(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => hasContent(item)).length;
}

function countObjectEntries(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  return Object.values(value as Record<string, unknown>).filter((item) => hasContent(item)).length;
}

function countSkills(skills: ParsedResume['skills'] | undefined): number {
  if (!skills) return 0;
  if (Array.isArray(skills)) {
    return skills.filter((item) => hasText(item)).length;
  }

  return Object.values(skills as SkillsDetailed).reduce((total, items) => total + countArrayEntries(items), 0);
}

function getResumeSignalScore(text: string): number {
  if (!text) return 0;

  const normalized = text.toLowerCase();
  const compact = text.replace(/\s+/g, ' ').trim();

  const urls = (normalized.match(/https?:\/\/|www\./g) || []).length;
  const dateRanges = (compact.match(/(?:19|20)\d{2}(?:[./-]\d{1,2})?\s*(?:~|-|–|to|至)\s*(?:present|current|now|至今|(?:19|20)\d{2}(?:[./-]\d{1,2})?)/gi) || []).length;
  const technicalTerms = (normalized.match(/\b(python|java|javascript|typescript|c\+\+|c#|go|rust|react|node|docker|linux|k8s|kubernetes|git|sql|tensorflow|pytorch|fortran|mpi|vasp|quantum espresso|aiida)\b/gi) || []).length;
  const sectionSignals = (normalized.match(/(github|project|projects|publication|publications|journal|conference|letters|bulletin|award|awards|language|languages|skills|certification|research|intern|experience|实习|项目|论文|期刊|技能|语言|证书|获奖|经历)/gi) || []).length;

  let score = 0;
  if (urls >= 1) score += 2;
  if (dateRanges >= 2) score += 2;
  if (technicalTerms >= 3) score += 1;
  if (sectionSignals >= 2) score += 1;
  if (/@/.test(text) && /\d{8,}/.test(text)) score += 1;

  return score;
}

export function summarizeParsedResumeCoverage(parsed: unknown) {
  const resume = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<ParsedResume>;

  const coverage = {
    contactFields: [
      resume.name,
      resume.email,
      resume.phone,
      resume.address,
      resume.linkedin,
      resume.github,
      resume.portfolio,
    ].filter((item) => hasText(item)).length,
    summary: hasText(resume.summary) ? 1 : 0,
    skills: countSkills(resume.skills),
    experience: countArrayEntries(resume.experience),
    projects: countArrayEntries(resume.projects),
    education: countArrayEntries(resume.education),
    certifications: countArrayEntries(resume.certifications),
    awards: countArrayEntries(resume.awards),
    languages: countArrayEntries(resume.languages),
    volunteerWork: countArrayEntries(resume.volunteerWork),
    publications: countArrayEntries(resume.publications),
    patents: countArrayEntries(resume.patents),
    otherSections: countObjectEntries(resume.otherSections),
  };

  const populatedSections = [
    coverage.summary,
    coverage.skills,
    coverage.experience,
    coverage.projects,
    coverage.education,
    coverage.certifications,
    coverage.awards,
    coverage.languages,
    coverage.volunteerWork,
    coverage.publications,
    coverage.patents,
    coverage.otherSections,
  ].filter((count) => count > 0).length;

  return {
    ...coverage,
    populatedSections,
    totalStructuredEntries: Object.values(coverage).reduce((total, count) => total + count, 0),
  };
}

export function isParsedResumeLikelyIncomplete(parsed: unknown, resumeText?: string): boolean {
  if (!parsed || typeof parsed !== 'object') {
    return true;
  }

  const coverage = summarizeParsedResumeCoverage(parsed);
  if (coverage.totalStructuredEntries === 0) {
    return true;
  }

  const sourceText = typeof resumeText === 'string' ? resumeText : '';
  const sourceLength = sourceText.replace(/\s/g, '').length;
  const richSource = sourceLength >= 250 && getResumeSignalScore(sourceText) >= 3;

  const onlyEducationAndContact = coverage.education > 0 &&
    coverage.summary === 0 &&
    coverage.skills === 0 &&
    coverage.experience === 0 &&
    coverage.projects === 0 &&
    coverage.certifications === 0 &&
    coverage.awards === 0 &&
    coverage.languages === 0 &&
    coverage.volunteerWork === 0 &&
    coverage.publications === 0 &&
    coverage.patents === 0 &&
    coverage.otherSections === 0;

  if (richSource && onlyEducationAndContact) {
    return true;
  }

  const missingExpectedNonEducationSections = richSource &&
    coverage.skills === 0 &&
    coverage.experience === 0 &&
    coverage.projects === 0 &&
    coverage.languages === 0 &&
    coverage.publications === 0 &&
    coverage.awards === 0 &&
    coverage.certifications === 0;

  if (missingExpectedNonEducationSections) {
    return true;
  }

  if (sourceLength >= 600 && coverage.populatedSections <= 2 && coverage.totalStructuredEntries <= coverage.education + coverage.contactFields + 1) {
    return true;
  }

  // Check for hollow entries: sections exist but key fields are empty
  // This catches cases where the LLM created entries with wrong field names
  if (hasHollowEntries(parsed as Partial<ParsedResume>)) {
    return true;
  }

  // "Summary-only" guard: LLM returned a real summary but no skills or
  // work experience, even though the source text clearly contains multiple
  // date ranges (YYYY.MM-YYYY.MM / YYYY.MM-至今) or 10+ numbered list
  // items (skill bullets). This catches the 潘梦全 scenario where content
  // appears BEFORE the section headers in the PDF and the LLM gives up
  // after grabbing the first paragraph.
  if (typeof sourceText === 'string' && sourceText.length > 0) {
    const dateRangeCount = (sourceText.match(/(?:19|20)\d{2}[./-]\d{1,2}\s*[-–—~至]\s*(?:(?:19|20)\d{2}[./-]\d{1,2}|至今|present|current|now)/gi) || []).length;
    const numberedBulletCount = (sourceText.match(/^\s*\d+\s*[.、]\s*\S/gm) || []).length;
    const hasSubstantiveContent = dateRangeCount >= 2 || numberedBulletCount >= 10;
    if (hasSubstantiveContent && coverage.experience === 0 && coverage.skills === 0 && coverage.projects === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Detect entries that exist but have empty key fields (institution, company, role).
 * This catches cases where the LLM used non-standard field names that didn't map correctly.
 */
function hasHollowEntries(parsed: Partial<ParsedResume>): boolean {
  // Check education entries for missing institution
  if (Array.isArray(parsed.education) && parsed.education.length > 0) {
    const allMissingInstitution = parsed.education.every((edu) => {
      const inst = typeof edu === 'object' && edu !== null
        ? (edu as unknown as Record<string, unknown>).institution ?? (edu as unknown as Record<string, unknown>).school ?? (edu as unknown as Record<string, unknown>).university
        : undefined;
      return !inst || (typeof inst === 'string' && !inst.trim());
    });
    if (allMissingInstitution) return true;
  }

  // Check experience entries for missing company AND role
  if (Array.isArray(parsed.experience) && parsed.experience.length > 0) {
    const allMissingKeyFields = parsed.experience.every((exp) => {
      if (typeof exp !== 'object' || exp === null) return true;
      const e = exp as unknown as Record<string, unknown>;
      const company = e.company ?? e.companyName ?? e.employer ?? e.organization;
      const role = e.role ?? e.title ?? e.jobTitle ?? e.position;
      const hasCompany = typeof company === 'string' && company.trim().length > 0;
      const hasRole = typeof role === 'string' && role.trim().length > 0;
      return !hasCompany && !hasRole;
    });
    if (allMissingKeyFields) return true;
  }

  return false;
}
