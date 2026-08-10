import { logger } from './LoggerService.js';
import type {
  ParsedResume,
  WorkExperience,
  Education,
  Project,
  Certification,
  Award,
  LanguageSkill,
  VolunteerWork,
  SkillsDetailed,
} from '../types/index.js';

/**
 * GoHire `POST /api/v1/parse-resume` — the resume extract+parse path.
 *
 * WHY THIS EXISTS. Local extraction ran pdftotext → (on failure) rasterize →
 * vision-LLM OCR → ResumeParseAgent. For image-only scans that path FABRICATES
 * the document: three passes over one 2.8MB scanned Chinese résumé produced
 * three different candidates (陈丽萍 / 庄丽萍 / 邱丽萍 — the real name is 占丽萍),
 * three different phone numbers and three different universities, every one of
 * them persisted with parseStatus='parsed'. A wrong phone number on a
 * job-seeker's résumé is worse than a visible failure. GoHire's endpoint is
 * purpose-built for this (its docs state text, scanned and image-only PDFs are
 * all supported) and returns the correct 占丽萍 / 15907036381 / 九江学院.
 *
 * It replaces BOTH pipeline steps at once: the response carries `rawText` (the
 * full transcription) AND the structured fields, so a hit skips local
 * extraction and ResumeParseAgent entirely.
 *
 * NOT a hard dependency. Every failure path returns null and the caller falls
 * back to the local pipeline — an unconfigured key, a non-PDF, an oversized
 * file, a timeout, a non-200, or a response too thin to be a real parse.
 */

const DEFAULT_API_BASE = 'https://api.gohire.top';
/** Documented ceiling for the endpoint. Larger files skip straight to local. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Measured 45.4s on a 1-page 2.8MB image-only scan, so the ceiling has to be
 * generous — but it must stay BELOW the caller's own budget so a hung upstream
 * degrades to the local pipeline instead of hanging the user's upload.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface GoHireParseResult {
  /** Full document transcription, in human reading order. */
  rawText: string;
  parsed: ParsedResume;
}

/** Raw upstream payload. Every field is optional — never trust the wire. */
interface GoHireResumeData {
  [key: string]: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strArray(value: unknown): string[] {
  return arr(value).map(str).filter(Boolean);
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Chinese résumés print personal facts (籍贯, 民族, 政治面貌, 婚姻状态, QQ/WeChat…)
 * that GoHire returns as dedicated top-level fields. `ParsedResume` has no home
 * for them, and dropping them would lose data the candidate deliberately
 * included — so they are folded into `otherSections` under their printed
 * Chinese labels, which is exactly what that map is for.
 */
const PERSONAL_FIELD_LABELS: Array<[string, string]> = [
  ['birthDate', '出生'],
  ['age', '年龄'],
  ['gender', '性别'],
  ['nationality', '国籍'],
  ['ethnicity', '民族'],
  ['nativePlace', '籍贯'],
  ['maritalStatus', '婚姻状态'],
  ['politicalAffiliation', '政治面貌'],
  ['QQ/WeChat', 'QQ/微信'],
];

function mapExperience(value: unknown): WorkExperience[] {
  return arr(value)
    .map((raw) => {
      const e = obj(raw);
      const startDate = str(e.startDate);
      const endDate = str(e.endDate);
      const employmentType = str(e.employmentType);
      return {
        company: str(e.company),
        role: str(e.role),
        location: str(e.location) || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        // `duration` is required on WorkExperience; synthesize when absent so
        // downstream renderers never print "undefined".
        duration: str(e.duration) || [startDate, endDate].filter(Boolean).join(' - '),
        description: str(e.description) || undefined,
        achievements: strArray(e.achievements),
        technologies: strArray(e.technologies),
        employmentType: (['full-time', 'part-time', 'internship', 'contract', 'freelance'] as const)
          .find((t) => t === employmentType),
      };
    })
    .filter((e) => e.company || e.role);
}

function mapEducation(value: unknown): Education[] {
  return arr(value)
    .map((raw) => {
      const e = obj(raw);
      const startDate = str(e.startDate);
      const endDate = str(e.endDate);
      return {
        institution: str(e.institution) || str(e.school),
        degree: str(e.degree),
        field: str(e.field) || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        // `year` is required. GoHire returns "" and carries the real dates in
        // startDate/endDate, so fall back to the range rather than emit "".
        year: str(e.year) || [startDate, endDate].filter(Boolean).join(' - '),
        gpa: str(e.gpa) || undefined,
        achievements: strArray(e.achievements),
        coursework: strArray(e.coursework),
      };
    })
    .filter((e) => e.institution || e.degree);
}

function mapSkills(value: unknown): string[] | SkillsDetailed {
  if (Array.isArray(value)) return strArray(value);
  const s = obj(value);
  const detailed: SkillsDetailed = {
    technical: strArray(s.technical),
    soft: strArray(s.soft),
    // Upstream key is `language`; the local type uses `languages`. Accept both.
    languages: strArray(s.languages ?? s.language),
    tools: strArray(s.tools ?? s.tool),
    frameworks: strArray(s.frameworks ?? s.framework),
    other: strArray(s.other),
  };
  return detailed;
}

function mapProjects(value: unknown): Project[] {
  return arr(value)
    .map((raw) => {
      const p = obj(raw);
      return {
        name: str(p.name),
        role: str(p.role) || undefined,
        date: str(p.date) || undefined,
        description: str(p.description) || undefined,
        technologies: strArray(p.technologies),
        link: str(p.link) || undefined,
      };
    })
    .filter((p) => p.name || p.description);
}

function mapCertifications(value: unknown): Certification[] {
  return arr(value)
    .map((raw) => {
      const c = obj(raw);
      return {
        name: str(c.name),
        issuer: str(c.issuer) || undefined,
        date: str(c.date) || undefined,
        expiryDate: str(c.expiryDate) || undefined,
        credentialId: str(c.credentialId) || undefined,
      };
    })
    .filter((c) => c.name);
}

function mapAwards(value: unknown): Award[] {
  return arr(value)
    .map((raw) => {
      const a = obj(raw);
      return {
        name: str(a.name),
        issuer: str(a.issuer) || undefined,
        date: str(a.date) || undefined,
        description: str(a.description) || undefined,
      };
    })
    .filter((a) => a.name);
}

function mapLanguages(value: unknown): LanguageSkill[] {
  return arr(value)
    .map((raw) => {
      if (typeof raw === 'string') return { language: raw.trim() };
      const l = obj(raw);
      return {
        language: str(l.language) || str(l.name),
        proficiency: str(l.proficiency) || str(l.level) || undefined,
      };
    })
    .filter((l) => l.language);
}

function mapVolunteerWork(value: unknown): VolunteerWork[] {
  return arr(value)
    .map((raw): VolunteerWork => {
      const v = obj(raw);
      return {
        organization: str(v.organization) || str(v.company),
        role: str(v.role) || undefined,
        duration:
          str(v.duration) || [str(v.startDate), str(v.endDate)].filter(Boolean).join(' - ') || undefined,
        description: str(v.description) || undefined,
      };
    })
    .filter((v) => Boolean(v.organization || v.role));
}

/**
 * Fold GoHire's Chinese personal fields + `otherPersonalInformation` +
 * `otherSections` into one `Record<string, string>`. Printed section headings
 * win over synthesized personal labels on a key collision.
 */
function mapOtherSections(data: GoHireResumeData): Record<string, string> | undefined {
  const out: Record<string, string> = {};

  for (const [key, label] of PERSONAL_FIELD_LABELS) {
    const value = str(data[key]);
    if (value) out[label] = value;
  }
  for (const [key, value] of Object.entries(obj(data.otherPersonalInformation))) {
    const v = str(value);
    if (v) out[key] = v;
  }
  for (const [key, value] of Object.entries(obj(data.otherSections))) {
    const v = str(value);
    if (v) out[key] = v;
  }

  return Object.keys(out).length ? out : undefined;
}

function mapToParsedResume(data: GoHireResumeData, rawText: string): ParsedResume {
  return {
    name: str(data.name),
    email: str(data.email),
    phone: str(data.phone),
    address: str(data.address) || undefined,
    linkedin: str(data.linkedin) || undefined,
    github: str(data.github) || undefined,
    portfolio: str(data.portfolio) || undefined,
    summary: str(data.summary) || undefined,
    skills: mapSkills(data.skills),
    experience: mapExperience(data.experience),
    education: mapEducation(data.education),
    projects: mapProjects(data.projects),
    certifications: mapCertifications(data.certifications),
    awards: mapAwards(data.awards),
    languages: mapLanguages(data.languages),
    volunteerWork: mapVolunteerWork(data.volunteerWork),
    publications: strArray(data.publications),
    patents: strArray(data.patents),
    otherSections: mapOtherSections(data),
    rawText,
  };
}

/**
 * A 200 with an empty shell is a failed parse wearing a success costume.
 * Require a transcription plus at least one identifying or structural signal,
 * otherwise fall through to the local pipeline.
 */
function isUsableParse(rawText: string, parsed: ParsedResume): boolean {
  if (rawText.trim().length < 50) return false;
  return Boolean(
    parsed.name ||
      parsed.email ||
      parsed.phone ||
      parsed.experience.length ||
      parsed.education.length,
  );
}

export class GoHireResumeParseService {
  private resolveApiKey(): string {
    return (process.env.GOHIRE_API_KEY || '').trim();
  }

  private resolveApiBase(): string {
    return (process.env.GOHIRE_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  }

  private resolveTimeoutMs(): number {
    const raw = Number(process.env.GOHIRE_PARSE_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    // Opt-out so a bad upstream can be switched off without a redeploy.
    if ((process.env.GOHIRE_PARSE_ENABLED || '').trim().toLowerCase() === 'false') return false;
    return Boolean(this.resolveApiKey());
  }

  /**
   * Returns null on ANY failure — the caller must fall back to local
   * extraction. Never throws.
   */
  async parseResumeFile(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<GoHireParseResult | null> {
    const { buffer, fileName, mimeType, requestId, signal } = params;

    if (!this.isConfigured()) return null;

    // The endpoint takes PDFs only. Everything else (docx, images, txt) stays
    // on the local pipeline, which already handles those formats natively.
    const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(fileName);
    if (!isPdf) return null;

    if (buffer.byteLength > MAX_FILE_BYTES) {
      logger.info(
        'GOHIRE_PARSE',
        `Skipping GoHire parse: file exceeds the ${MAX_FILE_BYTES} byte limit`,
        { bytes: buffer.byteLength },
        requestId,
      );
      return null;
    }

    const url = `${this.resolveApiBase()}/api/v1/parse-resume`;
    const startedAt = Date.now();

    // Cap our own wait, but still honour a caller abort (client disconnect).
    const timeout = AbortSignal.timeout(this.resolveTimeoutMs());
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const form = new FormData();
      form.append(
        'file',
        // Copy into a fresh ArrayBuffer: a Buffer from a pooled allocation is a
        // view onto shared memory, and Blob would otherwise capture the whole pool.
        new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
        fileName || 'resume.pdf',
      );

      logger.info('GOHIRE_PARSE', 'Parsing résumé via GoHire', {
        bytes: buffer.byteLength,
        fileName,
      }, requestId);

      const response = await fetch(url, {
        method: 'POST',
        // Do NOT set Content-Type — fetch must write the multipart boundary.
        headers: { 'X-API-Key': this.resolveApiKey() },
        body: form,
        signal: abortSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(
          'GOHIRE_PARSE',
          `GoHire parse failed (HTTP ${response.status}); falling back to local extraction`,
          { status: response.status, body: body.slice(0, 300), elapsedMs: Date.now() - startedAt },
          requestId,
        );
        return null;
      }

      const payload = obj(await response.json());
      if (payload.success === false) {
        logger.warn(
          'GOHIRE_PARSE',
          'GoHire returned success=false; falling back to local extraction',
          { error: str(payload.error) || str(payload.message), elapsedMs: Date.now() - startedAt },
          requestId,
        );
        return null;
      }

      const data = obj(payload.data);
      const rawText = str(data.rawText);
      const parsed = mapToParsedResume(data, rawText);

      if (!isUsableParse(rawText, parsed)) {
        logger.warn(
          'GOHIRE_PARSE',
          'GoHire returned an empty parse; falling back to local extraction',
          { rawChars: rawText.length, elapsedMs: Date.now() - startedAt },
          requestId,
        );
        return null;
      }

      logger.info('GOHIRE_PARSE', 'GoHire parse succeeded', {
        rawChars: rawText.length,
        hasName: Boolean(parsed.name),
        hasPhone: Boolean(parsed.phone),
        experienceCount: parsed.experience.length,
        educationCount: parsed.education.length,
        elapsedMs: Date.now() - startedAt,
      }, requestId);

      return { rawText, parsed };
    } catch (err) {
      // Includes upstream timeout AND caller abort. Both degrade to local.
      logger.warn(
        'GOHIRE_PARSE',
        'GoHire parse errored; falling back to local extraction',
        {
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - startedAt,
        },
        requestId,
      );
      return null;
    }
  }
}

export const goHireResumeParseService = new GoHireResumeParseService();
