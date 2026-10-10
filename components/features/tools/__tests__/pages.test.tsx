// WP-57 routes: /tools and /tools/[tool] render inside HybridShell with the
// site footer; only the two working tools exist (no /tools/cover-letter);
// no result id is read from the URL; GoApply has the same tool pages and hub
// on every stack (D5); metadata comes from `tools.meta.*` per brand and the
// pages are indexable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const brand = vi.hoisted(() => ({ id: 'roboapply' as 'roboapply' | 'goapply', locale: 'en' as 'en' | 'zh' }));

vi.mock('../../../v3/shell/HybridShell', () => ({
  HybridShell: ({ children, footer, from }: { children: ReactNode; footer: ReactNode; from: string }) => (
    <div data-hybrid={from}>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock('../../marketing', () => ({ MarketingFooter: () => <footer data-testid="footer" /> }));
vi.mock('..', () => ({
  ToolsHub: ({ toolsOpen }: { toolsOpen?: boolean }) => <div data-testid="hub" data-open={String(toolsOpen)} />,
  ToolRunner: (props: { kind: string }) => <div data-testid="runner" data-kind={props.kind} data-props={Object.keys(props).join(',')} />,
  toolBySlug: (slug: string) =>
    ({ 'resume-check': { kind: 'resume_check', slug, key: 'resumeCheck' }, 'resume-job-match': { kind: 'resume_job_match', slug, key: 'resumeJobMatch' } })[slug] ?? null,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('../../../../lib/server/brand', () => ({ getServerBrandId: async () => brand.id }));
vi.mock('../../../../lib/serverLocale', () => ({ resolveLocale: async () => brand.locale }));

import ToolsPage, { generateMetadata as hubMeta } from '../../../../app/tools/page';
import ToolsToolPage, { generateMetadata as toolMeta } from '../../../../app/tools/[tool]/page';
import { freeToolsOpen } from '../../../../app/tools/meta';

const props = (tool: string) => ({ params: Promise.resolve({ tool }) });

beforeEach(() => {
  vi.stubEnv('DEPLOY_REGION', '');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  brand.id = 'roboapply';
  brand.locale = 'en';
});

describe('/tools pages', () => {
  it('/tools renders the hub in HybridShell with the footer', async () => {
    const { getByTestId, container } = render(await ToolsPage());
    // The page passes no switch: the hub's default is open.
    expect(getByTestId('hub').getAttribute('data-open')).toBe('undefined');
    expect(getByTestId('footer')).toBeTruthy();
    expect(container.querySelector('[data-hybrid="tools"]')).not.toBeNull();
  });

  it('/tools/resume-check and /tools/resume-job-match render their tool, and take nothing from the URL', async () => {
    const a = render(await ToolsToolPage(props('resume-check')));
    expect(a.getByTestId('runner').getAttribute('data-kind')).toBe('resume_check');
    expect(a.getByTestId('runner').getAttribute('data-props')).toBe('kind');
    cleanup();
    const b = render(await ToolsToolPage(props('resume-job-match')));
    expect(b.getByTestId('runner').getAttribute('data-kind')).toBe('resume_job_match');
  });

  it.each(['', 'cn-mainland', 'us'])('GoApply with DEPLOY_REGION=%j: both tool pages render and are indexable, and the hub is open', async (region) => {
    brand.id = 'goapply';
    // GoApply's own language (an English view of a zh-only brand is noindex on every page).
    brand.locale = 'zh';
    vi.stubEnv('DEPLOY_REGION', region);
    for (const [slug, kind] of [['resume-check', 'resume_check'], ['resume-job-match', 'resume_job_match']] as const) {
      const page = render(await ToolsToolPage(props(slug)));
      expect(page.getByTestId('runner').getAttribute('data-kind')).toBe(kind);
      cleanup();
      const meta = await toolMeta(props(slug));
      expect(meta.robots).toMatchObject({ index: true });
      expect(String(meta.alternates?.canonical)).toBe(`https://www.goapply.top/tools/${slug}`);
    }
    expect(render(await ToolsPage()).getByTestId('hub').getAttribute('data-open')).not.toBe('false');
    expect(freeToolsOpen('goapply')).toBe(true);
    expect(freeToolsOpen('roboapply')).toBe(true);
    // An unknown tool is still 404 on GoApply.
    await expect(ToolsToolPage(props('cover-letter'))).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('any other tool is 404 (no cover-letter lander)', async () => {
    await expect(ToolsToolPage(props('cover-letter'))).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(ToolsToolPage(props('ats-score-checker'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await toolMeta(props('cover-letter'))).toEqual({ robots: { index: false, follow: false } });
  });

  it('metadata per brand from tools.meta, indexable, canonical on the tool path', async () => {
    const hub = await hubMeta();
    expect(hub.title).toBe('Free job search tools | RoboApply');
    expect(hub.robots).toMatchObject({ index: true });
    const check = await toolMeta(props('resume-check'));
    expect(check.title).toBe('Free resume check | RoboApply');
    expect(String(check.alternates?.canonical)).toMatch(/\/tools\/resume-check$/);
    expect(String(check.description)).not.toMatch(/\bATS\b/);
    brand.id = 'goapply';
    expect((await toolMeta(props('resume-check'))).title).toMatch(/\| GoApply$/);
  });
});
