// server/src/features/jobs/import/extract.ts — turn a scraped page into a
// draft the user confirms (WP-35). Deterministic, no model: nothing is
// guessed beyond what the page says, and every value names where it came from.
//
//   1. The page's structured job data (schema.org `JobPosting` in a
//      `<script type="application/ld+json">` block, as most career sites and
//      ATS boards publish for search engines): title, hiring organization,
//      description, location → source `job_data`.
//   2. Otherwise the page title (`page_title`), the site name
//      (`page_site_name`) and the page's main text (`page_text`) — values the
//      form asks the user to check. A page title that names both ("Job
//      Application for Staff Engineer at Acme", the title Greenhouse boards
//      use) gives the title and the company. The page text is the posting
//      only: the site's navigation above the job's own heading and the
//      application form below it ("Apply for this job", "First Name *", …)
//      are left out.
// The link the user gave is the apply link (`link`).

import { htmlToPlain } from '../normalize/index.js';
import { MAX_DESCRIPTION_CHARS, MIN_DESCRIPTION_CHARS, REQUIRED_IMPORT_FIELDS, type ImportDraft, type ImportField } from './contract.js';
import type { ScrapedPage } from './firecrawl.js';

const LD_JSON_RE = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
/** Cap on the structured-data blocks we parse (a page with hundreds is not a job post). */
const MAX_LD_BLOCKS = 20;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function typeIncludes(node: Json, type: string): boolean {
  const t = node['@type'];
  return Array.isArray(t) ? t.some((x) => x === type) : t === type;
}

/** Every JobPosting node in a parsed ld+json value (arrays, @graph, nesting one level deep). */
function jobPostingsIn(value: unknown, out: Json[] = [], depth = 0): Json[] {
  if (depth > 3) return out;
  if (Array.isArray(value)) {
    for (const v of value) jobPostingsIn(v, out, depth + 1);
    return out;
  }
  if (!isObj(value)) return out;
  if (typeIncludes(value, 'JobPosting')) out.push(value);
  if (Array.isArray(value['@graph'])) jobPostingsIn(value['@graph'], out, depth + 1);
  if (isObj(value.mainEntity)) jobPostingsIn(value.mainEntity, out, depth + 1);
  return out;
}

/** The first JobPosting in the page's structured data, or null. */
export function findJobPosting(rawHtml: string): Json | null {
  if (!rawHtml) return null;
  let seen = 0;
  LD_JSON_RE.lastIndex = 0;
  for (let m = LD_JSON_RE.exec(rawHtml); m && seen < MAX_LD_BLOCKS; m = LD_JSON_RE.exec(rawHtml)) {
    seen += 1;
    const body = (m[1] ?? '').trim().replace(/^<!--|-->$/g, '').trim();
    if (!body) continue;
    try {
      const found = jobPostingsIn(JSON.parse(body));
      if (found.length) return found[0]!;
    } catch {
      // A malformed block: skip it.
    }
  }
  return null;
}

const text = (v: unknown): string | null => {
  if (typeof v === 'string') {
    const s = htmlToPlain(v).replace(/\s+/g, ' ').trim();
    return s || null;
  }
  if (typeof v === 'number') return String(v);
  return null;
};

function orgName(v: unknown): string | null {
  if (Array.isArray(v)) return orgName(v[0]);
  if (isObj(v)) return text(v.name) ?? text(v.legalName);
  return text(v);
}

function placeText(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map(placeText).filter((s): s is string => !!s);
    return parts.length ? [...new Set(parts)].slice(0, 3).join(' · ') : null;
  }
  if (!isObj(v)) return text(v);
  const addr = isObj(v.address) ? v.address : null;
  if (!addr) return text(v.name) ?? text(v.address);
  const country = isObj(addr.addressCountry) ? text(addr.addressCountry.name) : text(addr.addressCountry);
  const parts = [text(addr.addressLocality), text(addr.addressRegion), country].filter((s): s is string => !!s);
  return parts.length ? [...new Set(parts)].join(', ') : text(v.name);
}

function postingLocation(posting: Json): string | null {
  const place = placeText(posting.jobLocation);
  const remote = String(posting.jobLocationType ?? '').toUpperCase().includes('TELECOMMUTE');
  if (remote) return place ? `Remote · ${place}` : 'Remote';
  return place;
}

const clip = (s: string | null, max: number): string | null => (s ? (s.length <= max ? s : s.slice(0, max).trimEnd()) : null);

/** A line that starts the page's application form or its footer: nothing after it is the posting. */
const FORM_START_RE =
  /^(?:apply (?:for|to) this (?:job|position|role)|apply now|submit (?:your )?application|application form|first name\s*\*?|legal first name\s*\*?|resume\/cv\s*\*?|attach resume|autofill with [a-z ]+|create a job alert|share this job|similar jobs|powered by \w+|立即申请|申请该职位|投递简历)\s*:?$/i;
/** How far down the page the job's own heading is looked for. */
const TITLE_SEARCH_LINES = 40;

const lineKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The posting's part of a page's text: from the job's own heading (when the
 * title is known and appears near the top) to the application form or footer.
 * Only whole chrome blocks are removed; when neither marker is found the text
 * is returned as it is.
 */
export function withoutPageChrome(plain: string, title: string | null): string {
  let lines = plain.split('\n');
  const want = title ? lineKey(title) : '';
  if (want) {
    const at = lines.slice(0, TITLE_SEARCH_LINES).findIndex((l) => lineKey(l) === want);
    if (at > 0) lines = lines.slice(at);
  }
  const end = lines.findIndex((l, i) => i > 0 && FORM_START_RE.test(l.trim()));
  if (end > 0) lines = lines.slice(0, end);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Page text, minus markdown images and link targets (and, with a title, the page chrome around the posting), kept to the description cap. */
export function cleanPageText(markdown: string, title: string | null = null): string | null {
  const plain = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const posting = withoutPageChrome(plain, title);
  // Never trade a usable text for a fragment: the trimmed text is used only when it is still a description.
  const body = posting.length >= MIN_DESCRIPTION_CHARS ? posting : plain;
  return clip(body || null, MAX_DESCRIPTION_CHARS);
}

/**
 * "Job Application for Staff Engineer at Acme" (the page title of Greenhouse
 * boards) → the title and the company it names. Null for any other shape: a
 * title is not split on a guess.
 */
export function titleAndCompanyFromPage(title: string | null): { title: string; company: string } | null {
  if (!title) return null;
  const m = /^\s*job application for\s+(.+?)\s+at\s+(.+?)\s*$/i.exec(title.replace(/\s+/g, ' '));
  if (!m) return null;
  const [, role, company] = m as unknown as [string, string, string];
  return role.trim() && company.trim() ? { title: role.trim(), company: company.trim() } : null;
}

/** Title from the page `<title>` / og:title, without a trailing " | Site" / " - Careers" part. */
export function titleFromPage(title: string | null, siteName: string | null): string | null {
  if (!title) return null;
  let t = title.trim();
  if (siteName) {
    const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[|\\-–—:·]\\s*${esc}.*$`, 'i'), '').trim();
  }
  const parts = t.split(/\s+[|–—]\s+/);
  t = (parts[0] ?? t).trim();
  return clip(t || null, 200);
}

export interface ExtractResult {
  draft: ImportDraft;
  missingFields: ImportField[];
  /** True when the page gave us anything useful (a title or a long-enough text). */
  foundAnything: boolean;
}

/** Required fields that are empty (description: shorter than the save minimum). */
export function missingRequired(draft: Pick<ImportDraft, 'title' | 'company' | 'description'>): ImportField[] {
  return REQUIRED_IMPORT_FIELDS.filter((f) => {
    const v = draft[f];
    if (!v || !v.trim()) return true;
    return f === 'description' && v.trim().length < MIN_DESCRIPTION_CHARS;
  });
}

/** Build the draft for `link` from the scraped page. */
export function extractDraft(page: ScrapedPage, link: string): ExtractResult {
  const sources: ImportDraft['sources'] = { applyUrl: 'link' };
  const draft: ImportDraft = { title: null, company: null, description: null, location: null, applyUrl: link, sources };

  const posting = findJobPosting(page.rawHtml);
  if (posting) {
    const title = clip(text(posting.title) ?? text(posting.name), 200);
    if (title) {
      draft.title = title;
      sources.title = 'job_data';
    }
    const company = clip(orgName(posting.hiringOrganization), 200);
    if (company) {
      draft.company = company;
      sources.company = 'job_data';
    }
    const description = typeof posting.description === 'string' ? clip(htmlToPlain(posting.description) || null, MAX_DESCRIPTION_CHARS) : null;
    if (description) {
      draft.description = description;
      sources.description = 'job_data';
    }
    const location = clip(postingLocation(posting), 200);
    if (location) {
      draft.location = location;
      sources.location = 'job_data';
    }
  }

  const site = page.metadata.ogSiteName;
  // A page title that names the role and the employer ("Job Application for X at Y").
  const named = titleAndCompanyFromPage(page.metadata.title) ?? titleAndCompanyFromPage(page.metadata.ogTitle);
  if (!draft.title) {
    const t = named ? clip(named.title, 200) : titleFromPage(page.metadata.ogTitle ?? page.metadata.title, site);
    if (t) {
      draft.title = t;
      sources.title = 'page_title';
    }
  }
  if (!draft.company && named) {
    draft.company = clip(named.company, 200);
    sources.company = 'page_title';
  }
  if (!draft.company && site) {
    draft.company = clip(site, 200);
    sources.company = 'page_site_name';
  }
  if (!draft.description) {
    const body = cleanPageText(page.markdown, draft.title);
    if (body) {
      draft.description = body;
      sources.description = 'page_text';
    }
  }

  const foundAnything = !!draft.title || (!!draft.description && draft.description.length >= MIN_DESCRIPTION_CHARS);
  return { draft, missingFields: missingRequired(draft), foundAnything };
}
