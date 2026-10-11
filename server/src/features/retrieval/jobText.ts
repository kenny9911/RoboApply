// server/src/features/retrieval/jobText.ts
//
// The parts of a posting that describe what the job IS, shared by the lexical
// document (searchDoc.ts) and the embedded card text (cardText.ts):
// title; role labels; level; skills, required first; the enrichment summary;
// the head of the requirement text. Company boilerplate, benefits and legal
// text are not part of either (MATCH 4.9). For a mainland posting the free
// text goes through the contact strip first (`JobTextDeps.stripContact`): what
// is indexed or embedded for it carries no recruiter phone number or WeChat id.
//
// Skills: when the posting has canonical skill ids (`RAJob.skillIds`, filled
// from phase M4) and a vocabulary is given, the canonical labels are used,
// soft skills left out. Otherwise the stored display strings, with the
// enrichment's own `kind: 'soft'` entries left out. Which of them are required
// comes from `skillsDetail`.

import { getTaxonomyNode } from '../jobs/taxonomy/index.js';

/** The RAJob columns indexing reads. */
export interface IndexJobRow {
  id: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  title: string;
  primaryTaxonomyId: string | null;
  seniority: string | null;
  skills: string[];
  skillsDetail: unknown;
  skillIds: string[];
  summary: string | null;
  qualifications: string | null;
  descriptionPlain: string | null;
  archivedAt: Date | null;
}

/** Characters of the requirement text that go into the document and the card. */
export const REQUIREMENTS_HEAD_CHARS = 1200;

/**
 * The part of the canonical skill vocabulary (features/skills, MKT-2G) this
 * area reads. `label` answers the English label when a locale has none.
 */
export interface SkillLabels {
  kindOf(id: string): string | null;
  label(id: string, locale: string): string;
}

export interface JobTextDeps {
  /** The skill vocabulary, when one is loaded. Absent or null: the stored display strings are used. */
  skillLabels?: SkillLabels | null;
  /**
   * Removes a recruiter's phone number and WeChat id from a text
   * (features/cn/jobs `stripContactInfo`). Applied to the free text of every
   * MAINLAND posting (title, summary, requirement text) before it is cut: an
   * indexed mainland row was cleaned before it was stored, but a user's own
   * import keeps its text as pasted, and this is where that text would
   * otherwise leave for the search document and the embeddings provider
   * (MARKET_STRATEGY §1.5 / JC-7). Other markets are never touched.
   */
  stripContact?: ((text: string) => string) | null;
}

export interface JobTextParts {
  title: string;
  /** Labels of the primary role: English, Simplified Chinese, and the Taiwan label when the role has one. */
  roleLabels: string[];
  level: string | null;
  requiredSkills: string[];
  preferredSkills: string[];
  /**
   * The posting's own skill strings when the lists above hold canonical labels:
   * the spellings this posting used. For the lexical document only.
   */
  skillAliases: string[];
  summary: string | null;
  requirementsHead: string;
}

const clean = (v: string | null | undefined): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const keyOf = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

interface DetailEntry {
  skill: string;
  required: boolean;
  soft: boolean;
}

function readDetail(value: unknown): DetailEntry[] {
  if (!Array.isArray(value)) return [];
  const out: DetailEntry[] = [];
  for (const e of value) {
    if (!e || typeof e !== 'object') continue;
    const r = e as { skill?: unknown; required?: unknown; kind?: unknown };
    const skill = clean(typeof r.skill === 'string' ? r.skill : '');
    if (skill) out.push({ skill, required: r.required === true, soft: r.kind === 'soft' });
  }
  return out;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = keyOf(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** The stored display strings: required first, soft skills left out. */
function displaySkills(row: Pick<IndexJobRow, 'skills' | 'skillsDetail'>): { required: string[]; preferred: string[] } {
  const detail = readDetail(row.skillsDetail);
  const soft = new Set(detail.filter((d) => d.soft).map((d) => keyOf(d.skill)));
  const required = unique(detail.filter((d) => d.required && !d.soft).map((d) => d.skill));
  const requiredKeys = new Set(required.map(keyOf));
  const rest = [...detail.filter((d) => !d.required && !d.soft).map((d) => d.skill), ...(row.skills ?? []).map((s) => clean(s))];
  const preferred = unique(rest).filter((s) => !requiredKeys.has(keyOf(s)) && !soft.has(keyOf(s)));
  return { required, preferred };
}

/** Canonical labels of the posting's skill ids (English and Chinese), soft skills left out; null when they cannot be used. */
function canonicalSkills(row: Pick<IndexJobRow, 'skillIds'>, labels: SkillLabels | null | undefined): string[] | null {
  if (!labels || !row.skillIds?.length) return null;
  const out: string[] = [];
  for (const id of row.skillIds) {
    if (labels.kindOf(id) === 'soft') continue;
    for (const locale of ['en', 'zh', 'zh-TW']) {
      const label = clean(labels.label(id, locale));
      if (label) out.push(label);
    }
  }
  const list = unique(out);
  return list.length ? list : null;
}

export function jobTextParts(row: IndexJobRow, deps: JobTextDeps = {}): JobTextParts {
  const node = row.primaryTaxonomyId ? getTaxonomyNode(row.primaryTaxonomyId) : null;
  const roleLabels = node ? unique([node.en, node.zh, node.zhHant ?? ''].map((l) => clean(l)).filter(Boolean)) : [];
  const display = displaySkills(row);
  // `skillIds` are stored required first (ra-jobs.prisma); they carry no required flag of their own.
  const canonical = canonicalSkills(row, deps.skillLabels);
  const stripContact = row.market === 'cn' ? (deps.stripContact ?? null) : null;
  const text = (v: string | null | undefined): string => clean(stripContact && typeof v === 'string' ? stripContact(v) : v);
  const requirementText = text(row.qualifications) || text(row.descriptionPlain?.slice(0, REQUIREMENTS_HEAD_CHARS * 4));
  return {
    title: text(row.title),
    roleLabels,
    level: clean(row.seniority) || null,
    requiredSkills: canonical ?? display.required,
    preferredSkills: canonical ? [] : display.preferred,
    skillAliases: canonical ? unique([...canonical, ...display.required, ...display.preferred]).slice(canonical.length) : [],
    summary: text(row.summary) || null,
    requirementsHead: requirementText.slice(0, REQUIREMENTS_HEAD_CHARS),
  };
}
