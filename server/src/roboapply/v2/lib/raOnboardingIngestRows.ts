// backend/src/roboapply/v2/lib/raOnboardingIngestRows.ts
//
// Deterministic ingest-row builder for the onboarding "what I picked up"
// recap. Derives the rows from the RAResumeVariant's REAL parse artifacts
// (parsedData / summary / highlight / resumeMarkdown) — this replaces the
// hardcoded Maya-Chen persona rows the old wizard faked. No LLM, no DB:
// callers (RAOnboardingService) do the prisma read themselves because the
// route view deliberately omits `parsedData`, then hand the fields in.
//
// Degradation ladder:
//   1. structured parsedData (ParsedResume Json) → up to 6 rows
//      (identity / experience / skills / education / links / summary);
//   2. sparse/absent parsedData → markdown-heading heuristic over
//      resumeMarkdown (first `#` heading = identity; `##` section headings
//      matched by keyword → skills / experience / education);
//   3. nothing usable → a single localized "Imported {name}" row.
// All labels + templated values come from the raOnboardingMessages catalog.

import type { IngestRow, IngestRowKind } from '../types/onboarding.js';
import type { RaLocale } from './raLocale.js';
import { format, getMessages } from './raOnboardingMessages.js';

export interface IngestRowSource {
  /** Variant display name — the terminal-fallback row's `{name}`. */
  variantName: string;
  /** RAResumeVariant.parsedData (ParsedResume Json; may be null / partial). */
  parsedData?: unknown;
  summary?: string | null;
  highlight?: string | null;
  resumeMarkdown?: string | null;
}

const MAX_VALUE_LEN = 160;
const MAX_SKILLS = 6;

function clipValue(value: string): string {
  return value.trim().slice(0, MAX_VALUE_LEN);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s || null;
}

/** Flatten ParsedResume.skills — plain array passthrough; SkillsDetailed in
 *  fixed priority order: technical → frameworks → tools → languages → other
 *  → soft (specifics first, transferables last). */
function flattenSkills(skills: unknown): string[] {
  if (Array.isArray(skills)) {
    return skills.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  }
  const detailed = asRecord(skills);
  if (!detailed) return [];
  const order = ['technical', 'frameworks', 'tools', 'languages', 'other', 'soft'];
  const out: string[] = [];
  for (const key of order) {
    const group = detailed[key];
    if (!Array.isArray(group)) continue;
    for (const s of group) {
      if (typeof s === 'string' && s.trim() && !out.includes(s.trim())) {
        out.push(s.trim());
      }
    }
  }
  return out;
}

/** Best-effort total-years estimate from experience duration strings:
 *  sums explicit "N years / N 年" tokens, else YYYY–YYYY/present ranges.
 *  Returns null when nothing parses (the row omits the years segment). */
function estimateYears(experience: Array<Record<string, unknown>>): number | null {
  let total = 0;
  const nowYear = new Date().getFullYear();
  for (const entry of experience) {
    const duration = nonEmpty(entry.duration);
    if (!duration) continue;
    const explicit = duration.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?|年)/i);
    if (explicit) {
      total += parseFloat(explicit[1]);
      continue;
    }
    const range = duration.match(
      /(\d{4})\s*(?:[-–—~]|to|until)\s*(\d{4}|present|now|current|現在|至今)/i,
    );
    if (range) {
      const start = parseInt(range[1], 10);
      const end = /^\d{4}$/.test(range[2]) ? parseInt(range[2], 10) : nowYear;
      if (end >= start) total += end - start;
    }
  }
  if (total <= 0) return null;
  return Math.min(Math.round(total), 50);
}

function row(kind: IngestRowKind, label: string, value: string): IngestRow {
  return { id: kind, kind, label, value: clipValue(value) };
}

function rowsFromParsedData(
  parsed: Record<string, unknown>,
  locale: RaLocale,
): IngestRow[] {
  const m = getMessages(locale);
  const rows: IngestRow[] = [];

  const experience = Array.isArray(parsed.experience)
    ? (parsed.experience.filter((e) => asRecord(e) !== null) as Array<Record<string, unknown>>)
    : [];
  const latest = experience[0] ?? null;
  const latestRole = latest ? nonEmpty(latest.role) : null;
  const latestCompany = latest ? nonEmpty(latest.company) : null;

  // identity — "Name — Role @ Company", with whatever parts exist.
  const name = nonEmpty(parsed.name);
  if (name) {
    const parts = [name];
    if (latestRole) parts.push(`— ${latestRole}`);
    if (latestCompany) parts.push(`@ ${latestCompany}`);
    rows.push(row('identity', m.ingestLabel.identity, parts.join(' ')));
  }

  // experience — count · ~years · most recent role.
  if (experience.length > 0 && latestRole) {
    let value: string;
    if (experience.length === 1) {
      value = format(m.ingestExperienceValueSingle, { role: latestRole });
    } else {
      const years = estimateYears(experience);
      value =
        years != null
          ? format(m.ingestExperienceValue, {
              count: experience.length,
              years,
              role: latestRole,
            })
          : format(m.ingestExperienceValueNoYears, {
              count: experience.length,
              role: latestRole,
            });
    }
    rows.push(row('experience', m.ingestLabel.experience, value));
  }

  const skills = flattenSkills(parsed.skills);
  if (skills.length > 0) {
    rows.push(row('skills', m.ingestLabel.skills, skills.slice(0, MAX_SKILLS).join(' · ')));
  }

  const educationEntry = Array.isArray(parsed.education)
    ? asRecord(parsed.education[0])
    : null;
  if (educationEntry) {
    const degree = nonEmpty(educationEntry.degree);
    const institution = nonEmpty(educationEntry.institution);
    const value = [degree, institution].filter(Boolean).join(' — ');
    if (value) rows.push(row('education', m.ingestLabel.education, value));
  }

  // links — presence list; proper nouns, no localization needed.
  const links: string[] = [];
  if (nonEmpty(parsed.linkedin)) links.push('LinkedIn');
  if (nonEmpty(parsed.github)) links.push('GitHub');
  if (nonEmpty(parsed.portfolio)) links.push('Portfolio');
  if (links.length > 0) {
    rows.push(row('links', m.ingestLabel.links, links.join(' · ')));
  }

  return rows;
}

/** summary — the AI highlight first, else the pitch summary's first line.
 *  Independent of parsedData: the highlight is real data even when the
 *  structured parse is missing. */
function summaryRow(source: IngestRowSource, locale: RaLocale): IngestRow | null {
  const m = getMessages(locale);
  const summaryValue =
    nonEmpty(source.highlight) ?? nonEmpty(source.summary)?.split('\n')[0] ?? null;
  return summaryValue ? row('summary', m.ingestLabel.summary, summaryValue) : null;
}

/** Section-heading keywords for the markdown heuristic (en + zh + zh-TW + ja). */
const HEADING_KEYWORDS: Array<{ kind: IngestRowKind; pattern: RegExp }> = [
  { kind: 'skills', pattern: /skills?|技能|スキル/i },
  { kind: 'experience', pattern: /experience|work history|工作经历|工作經歷|經歷|经历|職歴/i },
  { kind: 'education', pattern: /education|学历|學歷|教育|学歴/i },
];

function rowsFromMarkdown(markdown: string, locale: RaLocale): IngestRow[] {
  const m = getMessages(locale);
  const rows: IngestRow[] = [];
  const lines = markdown.split('\n');

  // First `# heading` → identity (matches the resume-name convention the
  // GoHire import name-fallback also relies on).
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  if (h1) {
    rows.push(row('identity', m.ingestLabel.identity, h1.replace(/^#\s+/, '')));
  }

  // `##`/`###` section headings matched by keyword → first content line.
  for (const { kind, pattern } of HEADING_KEYWORDS) {
    const idx = lines.findIndex((l) => /^#{2,3}\s+\S/.test(l) && pattern.test(l));
    if (idx === -1) continue;
    const content = lines
      .slice(idx + 1)
      .find((l) => l.trim() !== '' && !/^#{1,6}\s/.test(l));
    if (content) {
      rows.push(row(kind, m.ingestLabel[kind], content.replace(/^[-*+]\s+/, '')));
    }
  }

  return rows;
}

/**
 * Build the localized ingest rows for a resume variant. Deterministic and
 * total: always returns ≥1 row (the "Imported {name}" terminal fallback when
 * nothing else is derivable). Never throws.
 */
export function buildIngestRows(source: IngestRowSource, locale: RaLocale): IngestRow[] {
  const m = getMessages(locale);
  const summary = summaryRow(source, locale);

  const parsed = asRecord(source.parsedData);
  const rows = parsed ? rowsFromParsedData(parsed, locale) : [];

  if (rows.length === 0) {
    const markdown = nonEmpty(source.resumeMarkdown);
    if (markdown) rows.push(...rowsFromMarkdown(markdown, locale));
  }

  if (summary) rows.push(summary);
  if (rows.length > 0) return rows;

  return [
    row('summary', m.ingestLabel.summary, format(m.importedRow, { name: source.variantName })),
  ];
}
