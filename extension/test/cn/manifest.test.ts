// GoApply build (WP-71): manifest host permissions follow the portal adapters,
// no job boards, no broad hosts; detection; distribution values.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CN_PORTAL_ADAPTERS } from '../../src/adapters/cn/index';
import { adapterHostPatterns, plannedSitesFor } from '../../src/adapters/registry';
import { GOAPPLY_DISTRIBUTION, GOAPPLY_EXT, goapplyPortalIds } from '../../src/brands/goapply/index';
import { detectAdapter } from '../../src/content/detect';
import { buildManifest, manifestViolations } from '../../src/manifest';
import { loadCnFixture } from './helpers';

describe('GoApply manifest', () => {
  for (const target of ['edge', 'chrome'] as const) {
    it(`${target}: brand origin + the four portal hosts; content scripts only there; policy clean`, () => {
      const m = buildManifest({ brand: 'goapply', target, dev: false, version: '1.0.0' }) as {
        permissions: string[];
        host_permissions: string[];
        content_scripts: Array<{ matches: string[] }>;
      };
      expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage']);
      expect(m.host_permissions).toEqual([
        'https://www.goapply.top/*',
        'https://*.mokahr.com/*',
        'https://*.zhiye.com/*',
        'https://*.beisen.com/*',
        'https://*.jobs.feishu.cn/*',
        'https://*.dayee.com/*',
        'https://*.hotjob.cn/*',
      ]);
      expect(m.content_scripts[0].matches).toEqual(adapterHostPatterns('cn'));
      expect(manifestViolations(m)).toEqual([]);
      expect(JSON.stringify(m)).not.toMatch(/zhipin|liepin|51job|lagou|zhaopin|linkedin|indeed|<all_urls>|"\*:\/\/\*\/\*"/);
    });
  }

  it('RoboApply never gets the mainland portal hosts', () => {
    const m = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' }) as { host_permissions: string[] };
    expect(m.host_permissions.join(' ')).not.toMatch(/mokahr|zhiye|beisen|feishu|dayee|hotjob/);
  });

  it('every planned mainland site now has an adapter', () => {
    expect(plannedSitesFor('cn')).toEqual([]);
  });
});

describe('detection on mainland portals', () => {
  it('picks the portal adapter by host + markup, and the generic one elsewhere', () => {
    const moka = loadCnFixture('moka', 'campus');
    expect(detectAdapter(new URL('https://app.mokahr.com/campus-recruitment/x/1#/apply'), moka, { set: 'cn', dev: false })?.id).toBe('moka');
    expect(detectAdapter(new URL('https://app.mokahr.com/campus-recruitment/x/1#/apply'), moka, { set: 'intl', dev: false })).toBeNull();
    const dayee = loadCnFixture('dayee', 'campus');
    expect(detectAdapter(new URL('https://wecruit.hotjob.cn/SU1/pb/apply.html'), dayee, { set: 'cn', dev: false })?.id).toBe('dayee');
    const generic = loadCnFixture('generic', 'self-built');
    expect(detectAdapter(new URL('https://careers.example-games.cn/apply/1'), generic, { set: 'cn', dev: false })?.id).toBe('generic');
    expect(detectAdapter(new URL('https://www.zhipin.com/job_detail/1.html'), generic, { set: 'cn', dev: false })).toBeNull();
  });

  it('dev builds detect the saved fixtures on localhost', () => {
    const feishu = loadCnFixture('feishu', 'campus');
    expect(detectAdapter(new URL('http://localhost:5173/feishu/campus.html'), feishu, { set: 'cn', dev: true })?.id).toBe('feishu');
  });
});

describe('GoApply distribution values (inert until INT wires scripts/build.mjs to them)', () => {
  for (const store of GOAPPLY_DISTRIBUTION.stores) {
    it(`${store}: the build target it names produces a policy-clean GoApply manifest with every portal adapter's hosts`, () => {
      const m = buildManifest({ brand: 'goapply', target: GOAPPLY_DISTRIBUTION.buildTarget[store], dev: false, version: '1.0.0' }) as {
        host_permissions: string[];
        name: string;
        description: string;
        action: { default_title: string };
      };
      expect(manifestViolations(m)).toEqual([]);
      const portalHosts = CN_PORTAL_ADAPTERS.filter((a) => goapplyPortalIds().includes(a.id)).flatMap((a) => a.hostPatterns);
      expect(m.host_permissions.slice(1)).toEqual(portalHosts);
      // The store strings are message placeholders the build fills from `_locales`.
      expect([m.name, m.description, m.action.default_title].every((v) => v.startsWith('__MSG_'))).toBe(true);
    });
  }

  it('the manifest strings it points at exist in en and zh and fit the store limits', () => {
    const [ns, group] = GOAPPLY_DISTRIBUTION.manifestStringsKey.split('.');
    for (const lang of ['en', 'zh'] as const) {
      const raw = JSON.parse(readFileSync(resolve(__dirname, `../../../i18n/staging/${ns}.${lang}.json`), 'utf8'))[ns][group] as Record<string, string>;
      const sub = (v: string) => v.replace(/%BRAND%/g, 'GoApply');
      expect(Object.keys(raw).sort()).toEqual(['actionTitle', 'description', 'nameChrome', 'nameEdge', 'shortName']);
      // Edge Add-ons: name ≤ 45; Chrome: name ≤ 75, short_name ≤ 12, description ≤ 132.
      expect(sub(raw.nameEdge).length).toBeLessThanOrEqual(45);
      expect(sub(raw.nameChrome).length).toBeLessThanOrEqual(75);
      expect(sub(raw.shortName).length).toBeLessThanOrEqual(12);
      expect(sub(raw.description).length).toBeLessThanOrEqual(132);
    }
  });

  it('the portal ids are the shipped adapters (Edge Add-ons first), and the generic fallback is not listed', () => {
    expect(GOAPPLY_EXT.adapterSet).toBe('cn');
    expect(GOAPPLY_DISTRIBUTION.stores[0]).toBe('edge');
    expect(goapplyPortalIds()).toEqual(CN_PORTAL_ADAPTERS.map((a) => a.id));
    expect(goapplyPortalIds()).not.toContain('generic');
  });
});
