// WP-57 routes: /tools and /tools/[tool] render inside HybridShell with the
// site footer; only the two working tools exist (no /tools/cover-letter);
// no result id is read from the URL; GoApply on the offshore stack (CN-0)
// has no tool pages and a hub without tools; metadata comes from
// `tools.meta.*` per brand and the pages are indexable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const brand = vi.hoisted(() => ({ id: 'roboapply' as 'roboapply' | 'goapply' }));

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
vi.mock('../../../../lib/serverLocale', () => ({ resolveLocale: async () => 'en' }));

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
});

describe('/tools pages', () => {
  it('/tools renders the hub in HybridShell with the footer', async () => {
    const { getByTestId, container } = render(await ToolsPage());
    expect(getByTestId('hub').getAttribute('data-open')).toBe('true');
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

  it('GoApply on the offshore stack (CN-0): tool pages 404 (noindex) and the hub gets no tools; on the mainland stack they work', async () => {
    brand.id = 'goapply';
    await expect(ToolsToolPage(props('resume-check'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await toolMeta(props('resume-check'))).toEqual({ robots: { index: false, follow: false } });
    expect(render(await ToolsPage()).getByTestId('hub').getAttribute('data-open')).toBe('false');
    cleanup();
    vi.stubEnv('DEPLOY_REGION', 'cn-mainland');
    expect(render(await ToolsToolPage(props('resume-check'))).getByTestId('runner')).toBeTruthy();
    expect(freeToolsOpen('goapply', { DEPLOY_REGION: 'cn-mainland' })).toBe(true);
    expect(freeToolsOpen('goapply', {})).toBe(false);
    expect(freeToolsOpen('roboapply', {})).toBe(true);
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
    vi.stubEnv('DEPLOY_REGION', 'cn-mainland');
    expect((await toolMeta(props('resume-check'))).title).toMatch(/\| GoApply$/);
  });
});
