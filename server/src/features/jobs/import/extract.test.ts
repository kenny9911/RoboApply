// @vitest-environment node
//
// WP-35 — draft extraction: structured job data first, then the page title /
// site name / text; every value names its source; nothing invented.

import { describe, expect, it } from 'vitest';
import { cleanPageText, extractDraft, findJobPosting, missingRequired, titleFromPage } from './extract.js';
import type { ScrapedPage } from './firecrawl.js';

const LINK = 'https://careers.acme.example/jobs/42';

function page(over: Partial<ScrapedPage> & { meta?: Partial<ScrapedPage['metadata']> } = {}): ScrapedPage {
  return {
    finalUrl: over.finalUrl ?? LINK,
    markdown: over.markdown ?? '',
    rawHtml: over.rawHtml ?? '',
    metadata: { title: null, ogTitle: null, ogSiteName: null, description: null, statusCode: 200, ...over.meta },
  };
}

const LONG = 'You will build and run the data platform that powers our analytics, working with product and engineering teams every day.';

function ld(obj: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body>x</body></html>`;
}

describe('findJobPosting', () => {
  it('finds a JobPosting at the top level, in an array and in @graph', () => {
    expect(findJobPosting(ld({ '@type': 'JobPosting', title: 'A' }))?.title).toBe('A');
    expect(findJobPosting(ld([{ '@type': 'Organization' }, { '@type': 'JobPosting', title: 'B' }]))?.title).toBe('B');
    expect(findJobPosting(ld({ '@graph': [{ '@type': ['Thing', 'JobPosting'], title: 'C' }] }))?.title).toBe('C');
  });

  it('skips malformed blocks and pages without job data', () => {
    const html = `<script type="application/ld+json">{not json</script>${ld({ '@type': 'JobPosting', title: 'D' })}`;
    expect(findJobPosting(html)?.title).toBe('D');
    expect(findJobPosting('<html><body>No data</body></html>')).toBeNull();
    expect(findJobPosting('')).toBeNull();
  });
});

describe('extractDraft', () => {
  it('reads title, company, description and location from structured job data', () => {
    const html = ld({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Senior Data Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Acme &amp; Co' },
      description: `<p>${LONG}</p><ul><li>Python</li><li>SQL</li></ul>`,
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Taipei', addressCountry: 'TW' } },
    });
    const r = extractDraft(page({ rawHtml: html, markdown: 'menu menu menu' }), LINK);
    expect(r.draft).toMatchObject({ title: 'Senior Data Engineer', company: 'Acme & Co', location: 'Taipei, TW', applyUrl: LINK });
    expect(r.draft.description).toContain('You will build');
    expect(r.draft.description).toContain('• Python');
    expect(r.draft.sources).toEqual({ title: 'job_data', company: 'job_data', description: 'job_data', location: 'job_data', applyUrl: 'link' });
    expect(r.missingFields).toEqual([]);
    expect(r.foundAnything).toBe(true);
  });

  it('marks remote postings from jobLocationType', () => {
    const html = ld({ '@type': 'JobPosting', title: 'Analyst', jobLocationType: 'TELECOMMUTE', hiringOrganization: 'Acme', description: LONG });
    expect(extractDraft(page({ rawHtml: html }), LINK).draft.location).toBe('Remote');
  });

  it('falls back to the page title, site name and text, each labelled for checking', () => {
    const r = extractDraft(
      page({ markdown: `# Product Designer\n\n![logo](https://x/y.png)\n\n${LONG} [Apply](https://x/apply)`, meta: { ogTitle: 'Product Designer | Globex Careers', ogSiteName: 'Globex Careers' } }),
      LINK,
    );
    expect(r.draft.title).toBe('Product Designer');
    expect(r.draft.company).toBe('Globex Careers');
    expect(r.draft.sources).toMatchObject({ title: 'page_title', company: 'page_site_name', description: 'page_text' });
    expect(r.draft.description).not.toContain('logo');
    expect(r.draft.description).toContain('Apply');
    expect(r.draft.description).not.toContain('https://x/apply');
  });

  it('never invents a company: none named → missing', () => {
    const r = extractDraft(page({ markdown: LONG, meta: { title: 'Backend Engineer' } }), LINK);
    expect(r.draft.company).toBeNull();
    expect(r.missingFields).toEqual(['company']);
  });

  it('reports nothing found for an empty page', () => {
    const r = extractDraft(page({ markdown: 'Sign in' }), LINK);
    expect(r.foundAnything).toBe(false);
    expect(r.missingFields).toEqual(['title', 'company', 'description']);
  });
});

describe('helpers', () => {
  it('titleFromPage drops the trailing site part', () => {
    expect(titleFromPage('Staff Engineer - Initech', 'Initech')).toBe('Staff Engineer');
    expect(titleFromPage('Staff Engineer | Jobs at Initech', null)).toBe('Staff Engineer');
    expect(titleFromPage(null, 'X')).toBeNull();
  });

  it('missingRequired treats a too-short description as missing', () => {
    expect(missingRequired({ title: 'A', company: 'B', description: 'short' })).toEqual(['description']);
    expect(missingRequired({ title: ' ', company: null, description: LONG })).toEqual(['title', 'company']);
  });

  it('cleanPageText returns null for an empty page', () => {
    expect(cleanPageText('   ')).toBeNull();
  });
});
