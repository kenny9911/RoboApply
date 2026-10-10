// extension/src/content/boards/read.ts — read-only helpers the board readers
// share: the page's schema.org JobPosting (JSON-LD), plain text from HTML, and
// "first selector with text". Nothing here touches the page or sends anything;
// readers run only after the user clicks "Check fit" or "Save".

import type { JobOnPage } from '../../adapters/types';

export const MAX_DESCRIPTION = 60_000;

export function collapse(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** The first selector whose element has text. */
export function pick(root: ParentNode, selectors: readonly string[]): string | undefined {
  for (const sel of selectors) {
    let el: Element | null = null;
    try {
      el = root.querySelector(sel);
    } catch {
      el = null;
    }
    const t = collapse(el?.textContent);
    if (t) return t;
  }
  return undefined;
}

/** Block-level text of an element: paragraphs and list items keep their line breaks. */
export function blockText(el: Element | null | undefined, max = MAX_DESCRIPTION): string | undefined {
  if (!el) return undefined;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script, style, noscript, template, button, svg').forEach((n) => n.remove());
  clone.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  clone.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6, tr, section, ul, ol').forEach((n) => n.append('\n'));
  clone.querySelectorAll('li').forEach((n) => n.prepend('• '));
  const t = (clone.textContent ?? '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t ? t.slice(0, max) : undefined;
}

export function pickBlock(root: ParentNode, selectors: readonly string[]): string | undefined {
  for (const sel of selectors) {
    let el: Element | null = null;
    try {
      el = root.querySelector(sel);
    } catch {
      el = null;
    }
    const t = blockText(el);
    if (t) return t;
  }
  return undefined;
}

/** Plain text from an HTML string (JSON-LD descriptions). Parsed inert: nothing loads or runs. */
export function htmlToText(html: string): string | undefined {
  if (!html) return undefined;
  let source = html;
  // Some boards entity-encode the HTML inside the JSON ("&lt;p&gt;").
  if (/&lt;\/?[a-z]/i.test(source) && !/<\/?[a-z]/i.test(source)) {
    const tmp = new DOMParser().parseFromString(`<!doctype html><body>${source}`, 'text/html');
    source = tmp.body.textContent ?? '';
  }
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${source}`, 'text/html');
  return blockText(parsed.body);
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typesOf(node: Json): string[] {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
}

function walkJson(node: unknown, out: Json[]): void {
  if (Array.isArray(node)) {
    for (const n of node) walkJson(n, out);
    return;
  }
  if (!isObj(node)) return;
  if (typesOf(node).includes('JobPosting')) out.push(node);
  if (Array.isArray(node['@graph'])) walkJson(node['@graph'], out);
}

/** Every schema.org JobPosting in the page's JSON-LD blocks. */
export function jobPostings(doc: Document): Json[] {
  const out: Json[] = [];
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      walkJson(JSON.parse(script.textContent ?? ''), out);
    } catch {
      // A broken block is ignored; the DOM selectors still apply.
    }
  }
  return out;
}

function nameOf(v: unknown): string | undefined {
  if (typeof v === 'string') return collapse(v) || undefined;
  if (isObj(v) && typeof v.name === 'string') return collapse(v.name) || undefined;
  return undefined;
}

function placeText(place: unknown): string | undefined {
  if (!isObj(place)) return undefined;
  const addr = place.address;
  if (typeof addr === 'string') return collapse(addr) || undefined;
  if (!isObj(addr)) return nameOf(place);
  const parts = [addr.addressLocality, addr.addressRegion, nameOf(addr.addressCountry)]
    .map((p) => (typeof p === 'string' ? collapse(p) : ''))
    .filter(Boolean);
  return [...new Set(parts)].join(', ') || undefined;
}

/** The single JobPosting on the page as a job, or null (none, or several: a list page). */
export function jobFromJsonLd(doc: Document): JobOnPage | null {
  const postings = jobPostings(doc);
  if (postings.length !== 1) return null;
  const p = postings[0];
  const title = typeof p.title === 'string' ? collapse(p.title) || undefined : undefined;
  const company = nameOf(p.hiringOrganization);
  const places = Array.isArray(p.jobLocation) ? p.jobLocation : p.jobLocation ? [p.jobLocation] : [];
  const located = places.map(placeText).filter((x): x is string => Boolean(x));
  const remote = p.jobLocationType === 'TELECOMMUTE';
  const location = located.length ? located.join(' · ') : remote ? 'Remote' : undefined;
  const descriptionText = typeof p.description === 'string' ? htmlToText(p.description) : undefined;
  if (!title && !company) return null;
  return { title, company, location, descriptionText };
}

/** Fill the gaps of `a` from `b` (the DOM fills what the JSON-LD left out, or the reverse). */
export function mergeJob(a: JobOnPage | null, b: JobOnPage | null): JobOnPage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    title: a.title || b.title,
    company: a.company || b.company,
    location: a.location || b.location,
    descriptionText: a.descriptionText || b.descriptionText,
  };
}

