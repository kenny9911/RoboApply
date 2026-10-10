// Manifest per brand: minimal permissions, no job-board hosts (ARCHITECTURE.md §6.2; H10).

import { describe, expect, it } from 'vitest';

import { adapterHostPatterns, plannedSitesFor, plannedSiteForUrl } from '../src/adapters/registry';
import { buildManifest, manifestViolations } from '../src/manifest';

const BRANDS = ['roboapply', 'goapply'] as const;
const TARGETS = ['chrome', 'edge'] as const;

describe('buildManifest', () => {
  for (const brand of BRANDS) {
    for (const target of TARGETS) {
      it(`${brand}/${target}: MV3, three permissions, policy clean`, () => {
        const m = buildManifest({ brand, target, dev: false, version: '1.2.3' });
        expect(m.manifest_version).toBe(3);
        expect(m.version).toBe('1.2.3');
        expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage']);
        expect(m).not.toHaveProperty('optional_permissions');
        expect(manifestViolations(m)).toEqual([]);
        const all = JSON.stringify(m);
        expect(all).not.toMatch(/linkedin|indeed|glassdoor|<all_urls>|"cookies"|"tabs"|webRequest/i);
      });
    }
  }

  it('RoboApply: API origin + the shipped form hosts only; content scripts only on form hosts', () => {
    const m = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' }) as {
      host_permissions: string[];
      content_scripts: Array<{ matches: string[]; js: string[] }>;
      externally_connectable: { matches: string[] };
      background: { service_worker: string };
    };
    expect(m.host_permissions[0]).toBe('https://www.roboapply.io/*');
    expect(m.host_permissions).toEqual(expect.arrayContaining(['https://boards.greenhouse.io/*', 'https://jobs.lever.co/*', 'https://jobs.ashbyhq.com/*']));
    expect(m.host_permissions.every((h) => h.startsWith('https://'))).toBe(true);
    expect(m.content_scripts).toHaveLength(1);
    expect(m.content_scripts[0].matches).toEqual(adapterHostPatterns('intl'));
    expect(m.externally_connectable.matches).toEqual(['https://roboapply.io/*', 'https://www.roboapply.io/*']);
    expect(m.background.service_worker).toBe('sw.js');
  });

  it('GoApply: its own origin; no international form hosts until WP-71 ships portal adapters', () => {
    const m = buildManifest({ brand: 'goapply', target: 'edge', dev: false, version: '1.0.0' }) as { host_permissions: string[]; content_scripts: unknown[]; externally_connectable: { matches: string[] } };
    expect(m.host_permissions).toEqual(['https://www.goapply.top/*', ...adapterHostPatterns('cn')]);
    expect(m.host_permissions.join(' ')).not.toMatch(/greenhouse|lever|ashby/);
    expect(m.externally_connectable.matches).toEqual(['https://goapply.top/*', 'https://www.goapply.top/*']);
  });

  it('dev builds add local origins for pairing and fixture pages', () => {
    const m = buildManifest({ brand: 'roboapply', target: 'chrome', dev: true, version: '1.0.0', apiOrigin: 'http://127.0.0.1:4799' }) as {
      host_permissions: string[];
      externally_connectable: { matches: string[] };
      content_scripts: Array<{ matches: string[] }>;
    };
    expect(m.host_permissions).toEqual(expect.arrayContaining(['http://127.0.0.1/*', 'http://localhost/*']));
    expect(m.externally_connectable.matches).toEqual(expect.arrayContaining(['http://localhost/*', 'http://127.0.0.1/*']));
    expect(m.content_scripts[0].matches).toEqual(expect.arrayContaining(['http://localhost/*']));
    expect(manifestViolations(m)).toEqual([]);
  });

  it('manifestViolations catches extra permissions and job-board hosts', () => {
    const m = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' });
    const bad = {
      ...m,
      permissions: [...(m.permissions as string[]), 'tabs', 'cookies'],
      host_permissions: [...(m.host_permissions as string[]), 'https://www.linkedin.com/*', 'https://*.indeed.com/*'],
      optional_host_permissions: ['<all_urls>'],
    };
    const v = manifestViolations(bad).join('\n');
    expect(v).toMatch(/"tabs"/);
    expect(v).toMatch(/"cookies"/);
    expect(v).toMatch(/linkedin/);
    expect(v).toMatch(/indeed/);
    expect(v).toMatch(/<all_urls>/);
  });

  it('manifestViolations refuses every job board a reader supports, not just the fixed list (WP-70 R8)', () => {
    const m = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' });
    const boards = ['https://www.ziprecruiter.com/*', 'https://wellfound.com/*', 'https://www.104.com.tw/*', 'https://www.cake.me/*'];
    const v = manifestViolations({ ...m, host_permissions: [...(m.host_permissions as string[]), ...boards] });
    for (const b of boards) expect(v.join('\n')).toContain(b);
    expect(manifestViolations(m)).toEqual([]);
  });
});

describe('registry', () => {
  it('lists planned sites for "Request this site" without the shipped ones', () => {
    // Wave 5 gate (WP-70 R1, WP-71): every planned intl site and Moka shipped.
    expect(plannedSitesFor('intl').map((p) => p.id)).toEqual([]);
    expect(plannedSiteForUrl(new URL('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1'), 'intl')).toBeNull();
    expect(plannedSiteForUrl(new URL('https://boards.greenhouse.io/x'), 'intl')).toBeNull();
    expect(plannedSiteForUrl(new URL('https://app.mokahr.com/apply/x'), 'cn')).toBeNull();
  });
});
