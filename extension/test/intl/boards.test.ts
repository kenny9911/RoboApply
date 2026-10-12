// Job-board readers ("Check fit" / "Save"): which pages they recognise, what
// they read (only the job), the URL they send, and that no board ever gets a
// host permission or a content script (ARCHITECTURE.md §6.7; H10).

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { BOARD_READERS, boardDomains, boardPageJob, findBoardReader } from '../../src/content/boards/index';
import { employerName } from '../../src/content/boards/glassdoor';
import { htmlToText, jobFromJsonLd } from '../../src/content/boards/read';
import { createContentController } from '../../src/content/controller';
import { adapterHostPatterns } from '../../src/adapters/registry';
import { buildManifest } from '../../src/manifest';
import { loadIntlFixture } from './harness';

interface BoardCase {
  fixture: string;
  url: string;
  reader: string;
  canonical: string;
  job: { title: string; company: string; location?: string };
  description: RegExp;
}

const CASES: BoardCase[] = [
  {
    fixture: 'linkedin-view',
    url: 'https://www.linkedin.com/jobs/view/3901234567/?refId=abc&trackingId=xyz',
    reader: 'linkedin',
    canonical: 'https://www.linkedin.com/jobs/view/3901234567/',
    job: { title: 'Backend Engineer', company: 'Example Co', location: 'Austin, TX' },
    description: /payment APIs[\s\S]*• Design and run Go services[\s\S]*PostgreSQL/,
  },
  {
    fixture: 'linkedin-search',
    url: 'https://www.linkedin.com/jobs/search/?currentJobId=3912345678&keywords=data%20analyst&geoId=1',
    reader: 'linkedin',
    canonical: 'https://www.linkedin.com/jobs/view/3912345678/',
    job: { title: 'Data Analyst', company: 'Sample Labs', location: 'Remote' },
    description: /weekly reports[\s\S]*SQL and Python/,
  },
  {
    fixture: 'linkedin-guest',
    url: 'https://de.linkedin.com/jobs/view/junior-designer-at-demo-studio-3923456789?position=1&pageNum=0',
    reader: 'linkedin',
    canonical: 'https://www.linkedin.com/jobs/view/3923456789/',
    job: { title: 'Junior Designer', company: 'Demo Studio', location: 'Berlin, DE' },
    description: /booking app[\s\S]*• Figma[\s\S]*• User research/,
  },
  {
    fixture: 'indeed-viewjob',
    url: 'https://www.indeed.com/viewjob?jk=9f8e7d6c5b4a3f2e&from=serp&vjs=3',
    reader: 'indeed',
    canonical: 'https://www.indeed.com/viewjob?jk=9f8e7d6c5b4a3f2e',
    job: { title: 'Warehouse Associate', company: 'Example Co', location: 'Austin, TX 78701' },
    description: /Pick, pack and ship[\s\S]*• Lift up to 50 lbs/,
  },
  {
    fixture: 'indeed-search',
    url: 'https://tw.indeed.com/jobs?q=nurse&l=Taipei&vjk=0a1b2c3d4e5f6a7b',
    reader: 'indeed',
    canonical: 'https://tw.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b',
    job: { title: 'Registered Nurse', company: 'Sample Clinic', location: '台北市 信義區' },
    description: /outpatient care/,
  },
  {
    fixture: 'glassdoor-listing',
    url: 'https://www.glassdoor.com/job-listing/product-manager-example-co-JV_IC1150505_KO0,15_KE16,26.htm?jl=1009123456789&src=GD_JOB_AD',
    reader: 'glassdoor',
    canonical: 'https://www.glassdoor.com/job-listing/product-manager-example-co-JV_IC1150505_KO0,15_KE16,26.htm?jl=1009123456789',
    job: { title: 'Product Manager', company: 'Example Co', location: 'Seattle, WA' },
    description: /Lead the checkout product/,
  },
  {
    fixture: 'ziprecruiter-job',
    url: 'https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?jid=abc123&utm_source=x',
    reader: 'ziprecruiter',
    canonical: 'https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?jid=abc123',
    job: { title: 'Dental Assistant', company: 'Sample Smiles', location: 'Phoenix, AZ, US' },
    description: /cleanings and X-rays\.\nCertification preferred\./,
  },
  {
    fixture: 'ziprecruiter-search',
    url: 'https://www.ziprecruiter.com/jobs-search?search=dental&location=AZ&lk=Zx9-abcDEF',
    reader: 'ziprecruiter',
    canonical: 'https://www.ziprecruiter.com/jobs-search?lk=Zx9-abcDEF',
    job: { title: 'Hygienist', company: 'Other Dental', location: 'Mesa, AZ' },
    description: /Part-time role/,
  },
  {
    fixture: 'wellfound-job',
    url: 'https://wellfound.com/jobs/3012345-founding-engineer?utm_campaign=x',
    reader: 'wellfound',
    canonical: 'https://wellfound.com/jobs/3012345-founding-engineer',
    job: { title: 'Founding Engineer', company: 'Demo Studio', location: 'Remote' },
    description: /first version of our editor/,
  },
  {
    fixture: '104-job',
    url: 'https://www.104.com.tw/job/8a9bc?jobsource=index_s',
    reader: '104',
    canonical: 'https://www.104.com.tw/job/8a9bc',
    job: { title: '後端工程師', company: '範例科技股份有限公司', location: '台北市內湖區瑞光路' },
    description: /API 開發與維運[\s\S]*Go 或 Java/,
  },
  {
    fixture: 'cake-job',
    url: 'https://www.cake.me/companies/sample-labs-taiwan/jobs/ui-designer-1a2b?ref=search',
    reader: 'cake',
    canonical: 'https://www.cake.me/companies/sample-labs-taiwan/jobs/ui-designer-1a2b',
    job: { title: 'UI Designer', company: 'Sample Labs Taiwan', location: '台北市, TW' },
    description: /設計產品介面/,
  },
];

describe('job-board readers', () => {
  for (const c of CASES) {
    it(`${c.fixture}: recognised from the URL alone, reads the job, sends the canonical URL`, () => {
      const url = new URL(c.url);
      const reader = findBoardReader(url, 'intl');
      expect(reader?.id).toBe(c.reader);
      const doc = loadIntlFixture('boards', c.fixture);
      const job = reader!.readJob(doc, url);
      expect(job).toMatchObject(c.job);
      expect(job?.descriptionText ?? '').toMatch(c.description);
      expect(reader!.canonicalUrl(url)).toBe(c.canonical);

      const body = boardPageJob(c.url, doc, 'intl');
      expect(body).not.toBeNull();
      // Only the fields Save / Check fit send — nothing else from the page.
      expect(Object.keys(body!).sort()).toEqual(['company', 'descriptionText', 'title', 'url', ...(c.job.location ? ['location'] : [])].sort());
      expect(body).toMatchObject({ url: c.canonical, title: c.job.title, company: c.job.company });
    });
  }

  it('every reader has at least one saved page, and LinkedIn and Indeed have several', () => {
    const files = readdirSync(join(__dirname, 'fixtures', 'boards'));
    for (const r of BOARD_READERS) expect(CASES.some((c) => c.reader === r.id), r.id).toBe(true);
    expect(files.filter((f) => f.startsWith('linkedin')).length).toBeGreaterThanOrEqual(3);
    expect(files.filter((f) => f.startsWith('indeed')).length).toBeGreaterThanOrEqual(2);
  });

  it('never reads the signed-in member or other listings on the page', () => {
    const doc = loadIntlFixture('boards', 'linkedin-view');
    const sent = JSON.stringify(boardPageJob('https://www.linkedin.com/jobs/view/3901234567/', doc, 'intl'));
    expect(sent).not.toMatch(/Avery|Prior Corp|compare to other applicants/);
    const search = loadIntlFixture('boards', 'linkedin-search');
    expect(JSON.stringify(boardPageJob('https://www.linkedin.com/jobs/search/?currentJobId=3912345678', search, 'intl'))).not.toMatch(/Avery|Senior Data Analyst|Other Corp/);
    const indeed = loadIntlFixture('boards', 'indeed-viewjob');
    expect(JSON.stringify(boardPageJob('https://www.indeed.com/viewjob?jk=9f8e7d6c5b4a3f2e', indeed, 'intl'))).not.toMatch(/avery@example\.test|\$18/);
    const gd = loadIntlFixture('boards', 'glassdoor-listing');
    expect(JSON.stringify(boardPageJob('https://www.glassdoor.com/job-listing/x.htm?jl=1009123456789', gd, 'intl'))).not.toMatch(/Great place|4\.1|★/);
  });

  it('the URL sent from a search page names the open job only: no search terms, place or tracking', () => {
    const searches: Array<[string, string, string]> = [
      ['linkedin-search', 'https://www.linkedin.com/jobs/search/?currentJobId=3912345678&keywords=data%20analyst&geoId=1&trk=public_jobs', 'https://www.linkedin.com/jobs/view/3912345678/'],
      ['indeed-search', 'https://tw.indeed.com/jobs?q=nurse&l=Taipei&vjk=0a1b2c3d4e5f6a7b&from=searchOnHP', 'https://tw.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b'],
      ['ziprecruiter-search', 'https://www.ziprecruiter.com/jobs-search?search=dental&location=AZ&lk=Zx9-abcDEF&utm_source=mail', 'https://www.ziprecruiter.com/jobs-search?lk=Zx9-abcDEF'],
    ];
    for (const [fixture, href, clean] of searches) {
      const body = boardPageJob(href, loadIntlFixture('boards', fixture), 'intl');
      expect(body?.url, fixture).toBe(clean);
      expect(body!.url, fixture).not.toMatch(/keywords|geoId|trk|[?&]q=|[?&]l=|search=|location=|utm_|from=/);
    }
  });

  it('ZipRecruiter: two postings for one role and city keep their own job id; tracking is dropped', () => {
    const reader = findBoardReader(new URL('https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?jid=abc123'), 'intl')!;
    const a = reader.canonicalUrl(new URL('https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?jid=abc123&utm_source=x&utm_medium=email'));
    const b = reader.canonicalUrl(new URL('https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?utm_campaign=y&jid=def456'));
    expect(a).toBe('https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?jid=abc123');
    expect(b).toBe('https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?jid=def456');
    expect(reader.canonicalUrl(new URL('https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ?utm_source=x'))).toBe('https://www.ziprecruiter.com/c/Sample-Smiles/Job/Dental-Assistant/-in-Phoenix,AZ');
    expect(reader.canonicalUrl(new URL('https://www.ziprecruiter.com/jobs/abc-123?utm_source=x&jid=zzz'))).toBe('https://www.ziprecruiter.com/jobs/abc-123');
  });

  it('Glassdoor: the star rating is dropped from the employer, a number in the name is kept', () => {
    const cases: Array<[string, string]> = [
      ['<div data-test="employer-name"><h4>Forever 21</h4></div>', 'Forever 21'],
      ['<div data-test="employer-name"><h4>Forever 21 4.1 ★</h4></div>', 'Forever 21'],
      ['<div data-test="employer-name"><h4>Forever 21 4.1</h4></div>', 'Forever 21'],
      ['<div data-test="employer-name"><h4>Area 51</h4></div>', 'Area 51'],
      ['<div data-test="employer-name"><h4>Studio 54 3.9★</h4></div>', 'Studio 54'],
      ['<div data-test="employer-name">Forever 21<span data-test="rating">4.1</span></div>', 'Forever 21'],
      ['<div class="EmployerProfile_employerName__x">Forever 21<span class="rating-headline">4.1 ★</span></div>', 'Forever 21'],
    ];
    for (const [html, want] of cases) {
      document.body.innerHTML = html;
      expect(employerName(document), html).toBe(want);
    }
  });

  it('Glassdoor: the employer named in the page’s schema.org data wins over the page text', () => {
    const doc = loadIntlFixture('boards', 'glassdoor-listing');
    doc.querySelector('[data-test="employer-name"] h4')!.textContent = 'Example Co 4 ★ Rated';
    expect(findBoardReader(new URL(CASES[5].url), 'intl')!.readJob(doc)?.company).toBe('Example Co');
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((n) => n.remove());
    doc.querySelector('[data-test="employer-name"] h4')!.textContent = 'Forever 21 4.1 ★';
    expect(findBoardReader(new URL(CASES[5].url), 'intl')!.readJob(doc)?.company).toBe('Forever 21');
  });

  it('is not a job page: board home pages, profiles, searches with nothing open', () => {
    for (const u of [
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/in/avery-example/',
      'https://www.linkedin.com/jobs/search/?keywords=engineer',
      'https://www.indeed.com/',
      'https://www.indeed.com/jobs?q=nurse',
      'https://www.indeed.com/viewjob?jk=<script>',
      'https://www.glassdoor.com/Reviews/index.htm',
      'https://www.ziprecruiter.com/jobs-search?search=dental',
      'https://wellfound.com/company/demo-studio',
      'https://www.104.com.tw/jobs/search/?keyword=go',
      'https://www.cake.me/jobs/designer',
      'https://www.linkedin.com.evil.test/jobs/view/3901234567/',
      'chrome://extensions',
    ]) {
      expect(findBoardReader(new URL(u), 'intl'), u).toBeNull();
    }
  });

  it('GoApply builds offer no international board readers', () => {
    expect(findBoardReader(new URL(CASES[0].url), 'cn')).toBeNull();
    expect(boardPageJob(CASES[0].url, loadIntlFixture('boards', 'linkedin-view'), 'cn')).toBeNull();
  });

  it('a page that does not name both role and employer sends nothing', () => {
    const doc = loadIntlFixture('boards', 'linkedin-view');
    doc.querySelector('.job-details-jobs-unified-top-card__company-name')?.remove();
    expect(boardPageJob('https://www.linkedin.com/jobs/view/3901234567/', doc, 'intl')).toBeNull();
  });

  it('JSON-LD: several postings (a list page) are not one job; HTML descriptions are read inert', () => {
    expect(jobFromJsonLd(loadIntlFixture('boards', 'ziprecruiter-search'))).toBeNull();
    const text = htmlToText('<p>One</p><img src="https://tracker.example.test/x.gif" onerror="window.__pwned=1"><script>window.__pwned=1</script><p>Two</p>');
    expect(text).toBe('One\nTwo');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('board readers run only after a user click', () => {
  it('the content script does not read a board page when injected; only "page.read" does', () => {
    const doc = loadIntlFixture('boards', 'linkedin-view');
    const reader = findBoardReader(new URL(CASES[0].url))!;
    const spy = vi.spyOn(reader, 'readJob');
    const mount = vi.fn();
    const controller = createContentController({ doc, href: () => CASES[0].url, set: 'intl', dev: false, mount });
    controller.init();
    expect(controller.handle({ type: 'content.ping' })).toEqual({ siteName: 'LinkedIn' });
    expect(spy).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    const res = controller.handle({ type: 'page.read' }) as { job: { title: string; company: string } | null };
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.job).toMatchObject({ title: 'Backend Engineer', company: 'Example Co' });
    spy.mockRestore();
  });

  // R3 (applied at the Wave 5 gate): the controller's page.read uses
  // boardPageJob(href, doc) on boards, so the search terms never leave.
  it('R3: page.read on a board search page sends the canonical job URL (controller wiring)', () => {
    const href = 'https://www.linkedin.com/jobs/search/?currentJobId=3912345678&keywords=data%20analyst&geoId=1&trk=public_jobs';
    const controller = createContentController({ doc: loadIntlFixture('boards', 'linkedin-search'), href: () => href, set: 'intl', dev: false, mount: vi.fn() });
    controller.init();
    const res = controller.handle({ type: 'page.read' }) as { job: { url: string } | null };
    expect(res.job?.url).toBe('https://www.linkedin.com/jobs/view/3912345678/');
    expect(JSON.stringify(res.job)).not.toMatch(/keywords|data%20analyst|trk=|geoId/);
  });

  it('reader and helper sources send nothing, listen to nothing and score nothing', () => {
    const dir = resolve(__dirname, '../../src/content/boards');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|chrome\.|addEventListener|MutationObserver|setInterval|\.click\s*\(|\bscore\b/i);
    }
  });
});

describe('no job board gets a host permission or a content script', () => {
  const domains = boardDomains();

  it('board hosts are not form hosts', () => {
    const formHosts = adapterHostPatterns('intl').join(' ');
    for (const d of domains) expect(formHosts, d).not.toContain(d);
  });

  for (const brand of ['roboapply', 'goapply'] as const) {
    for (const target of ['chrome', 'edge'] as const) {
      for (const dev of [false, true]) {
        it(`${brand}/${target}${dev ? ' (dev)' : ''}`, () => {
          const m = buildManifest({ brand, target, dev, version: '1.0.0' }) as { host_permissions: string[]; content_scripts: Array<{ matches: string[] }> };
          const all = [...m.host_permissions, ...m.content_scripts.flatMap((cs) => cs.matches)].join(' ');
          for (const d of domains) expect(all, d).not.toContain(d);
        });
      }
    }
  }
});
