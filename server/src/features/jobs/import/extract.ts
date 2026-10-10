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
//      form asks the user to check.
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

/** Page text, minus markdown images and link targets, kept to the description cap. */
export function cleanPageText(markdown: string): string | null {
  const plain = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(plain || null, MAX_DESCRIPTION_CHARS);
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
  if (!draft.title) {
    const t = titleFromPage(page.metadata.ogTitle ?? page.metadata.title, site);
    if (t) {
      draft.title = t;
      sources.title = 'page_title';
    }
  }
  if (!draft.company && site) {
    draft.company = clip(site, 200);
    sources.company = 'page_site_name';
  }
  if (!draft.description) {
    const body = cleanPageText(page.markdown);
    if (body) {
      draft.description = body;
      sources.description = 'page_text';
    }
  }

  const foundAnything = !!draft.title || (!!draft.description && draft.description.length >= MIN_DESCRIPTION_CHARS);
  return { draft, missingFields: missingRequired(draft), foundAnything };
}
