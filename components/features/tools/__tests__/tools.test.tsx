// WP-57 UI: the tools hub per brand (GoApply leads with the resume check
// and links the campus calendar only when it is on; no tools where they are
// off), the resume check (client file checks, short automated report, signup
// link carrying from=resume-check and never the result id — only a click on
// it remembers the id, per tab, for 30 minutes), the GoApply processing
// notice, the daily allowance per tool, the resume–job check (no score, no
// links fetched), keeping the resume when signed in, reopening the result
// this tab asked to keep, and the claim host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getToolsConfig: vi.fn(),
  runResumeCheck: vi.fn(),
  runResumeJobMatch: vi.fn(),
  getToolResult: vi.fn(),
  claimToolResult: vi.fn(),
}));
const auth = vi.hoisted(() => ({ status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' }));

vi.mock('../../../../lib/api/tools', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/auth/useAuth', () => ({ useAuth: () => ({ status: auth.status, user: auth.status === 'authenticated' ? { id: 'u1' } : null }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/tools',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { RoboApiError } from '../../../../lib/api/client';
import type { ResumeCheckReport, ResumeJobMatchReport, ToolsConfigView } from '../../../../lib/api/contracts/tools';
import { TOOLS_CONSENT_VERSION } from '../../../../server/src/features/tools/contract';
import { ARM_TTL_MS, PENDING_RESULT_KEY, armPendingResult, readPendingResult } from '../pendingResult';
import { CLIENT_CONSENT_VERSION, JOB_ALERTS_ENTRY } from '../catalog';
import { ToolResultClaimHost, ToolRunner, ToolsHub, isBareLink, signupHref, toolBySlug } from '..';
import { intlErrors, renderTool } from './render';

const RID = 'r'.repeat(43);

function config(over: Partial<ToolsConfigView> = {}): ToolsConfigView {
  return {
    available: true,
    perIpPerDay: 3,
    remainingByTool: { resume_check: 2, resume_job_match: 3 },
    resetsAt: '2026-10-11T00:00:00.000Z',
    maxFileBytes: 15 * 1024 * 1024,
    acceptedTypes: ['application/pdf'],
    acceptedExtensions: ['.pdf', '.doc', '.docx', '.txt'],
    cacheHours: 24,
    shortReportIssues: 3,
    consentRequired: false,
    consentVersion: null,
    processedOutsideMainland: false,
    parserName: null,
    ...over,
  };
}

const issue = (id: string, type: string, severity: 'urgent' | 'critical' | 'optional') => ({
  id,
  type,
  severity,
  section: 'experience',
  anchor: null,
  why: `why ${type}`,
  how: `how ${type}`,
  params: { opener: 'Responsible for' },
  evidence: 'Responsible for stock',
  source: 'rules' as const,
});

function checkReport(over: Partial<ResumeCheckReport> = {}): ResumeCheckReport {
  return {
    kind: 'resume_check',
    resultId: RID,
    expiresAt: '2026-10-11T12:00:00.000Z',
    cached: false,
    full: false,
    label: 'fair',
    counts: { urgent: 1, critical: 3, optional: 2 },
    issues: [issue('i1', 'weak_verb', 'urgent'), issue('i2', 'no_numbers', 'critical'), issue('i3', 'summary_missing', 'critical')],
    hiddenIssueCount: 3,
    rulesChecked: 17,
    profile: 'intl',
    method: 'rules',
    ...over,
  };
}

function matchReport(): ResumeJobMatchReport {
  return {
    kind: 'resume_job_match',
    resultId: RID,
    expiresAt: '2026-10-11T12:00:00.000Z',
    cached: false,
    full: false,
    postingTitle: 'Backend Engineer',
    rows: [
      { key: 'title', status: 'fail', params: { title: 'Backend Engineer' }, label: 'Job title', detail: '' },
      { key: 'years', status: 'warn', params: { required: 3, found: 2 }, label: 'Years', detail: '' },
      { key: 'education', status: 'unknown', params: {}, label: 'Education', detail: '' },
      { key: 'skills', status: 'fail', params: { met: 1, total: 4 }, label: 'Hard skills', detail: '' },
      { key: 'keywords', status: 'warn', params: { met: 2, total: 5 }, label: 'Keywords', detail: '' },
    ],
    keywords: { matched: ['payments'], missing: ['event-driven'] },
    hardSkills: { matched: ['SQL'], missing: ['Kubernetes'] },
    method: 'rules',
  };
}

const pdf = () => new File(['%PDF-1.7 test'], 'Sam_Rivera.pdf', { type: 'application/pdf' });

function chooseFile(file: File) {
  fireEvent.change(screen.getByTestId('tool-file'), { target: { files: [file] } });
}

beforeEach(() => {
  auth.status = 'unauthenticated';
  api.getToolsConfig.mockResolvedValue(config());
  try {
    window.sessionStorage.removeItem(PENDING_RESULT_KEY);
    window.localStorage.removeItem(PENDING_RESULT_KEY);
  } catch {
    /* no storage */
  }
  intlErrors.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  const errors = intlErrors.splice(0);
  expect(errors).toEqual([]);
});

describe('catalog helpers', () => {
  it('maps slugs and builds the signup hand-off without the result id', () => {
    expect(toolBySlug('resume-check')?.kind).toBe('resume_check');
    expect(toolBySlug('cover-letter')).toBeNull();
    const href = signupHref(toolBySlug('resume-check')!);
    const u = new URL(href, 'https://x');
    expect(u.pathname).toBe('/signup');
    expect(u.searchParams.get('from')).toBe('resume-check');
    expect(u.searchParams.get('next')).toBe('/tools/resume-check');
    expect(u.searchParams.has('toolResult')).toBe(false);
    expect(new URL(signupHref(toolBySlug('resume-job-match')!, 'login'), 'https://x').pathname).toBe('/login');
    expect(isBareLink(' https://jobs.example.com/123 ')).toBe(true);
    expect(isBareLink('We are hiring. Apply at https://x.test')).toBe(false);
  });

  it('a kept-result request lives in this tab only, for 30 minutes after the click, and never past the result', () => {
    const clicked = new Date('2026-10-11T00:00:00.000Z');
    armPendingResult({ id: RID, kind: 'resume_check', expiresAt: '2026-10-11T12:00:00.000Z' }, clicked);
    expect(window.localStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_RESULT_KEY)).not.toBeNull();
    expect(readPendingResult(new Date(clicked.getTime() + ARM_TTL_MS - 1000))?.id).toBe(RID);
    expect(readPendingResult(new Date(clicked.getTime() + ARM_TTL_MS + 1000))).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_RESULT_KEY)).toBeNull();

    armPendingResult({ id: RID, kind: 'resume_check', expiresAt: '2026-10-11T00:10:00.000Z' }, clicked);
    expect(readPendingResult(new Date('2026-10-11T00:11:00.000Z'))).toBeNull();
  });

  it('the client consent version matches the server contract', () => {
    expect(CLIENT_CONSENT_VERSION).toBe(TOOLS_CONSENT_VERSION);
  });
});

describe('ToolsHub', () => {
  it('RoboApply lists the two working tools and no campus calendar', async () => {
    const { container } = renderTool(<ToolsHub />);
    const cards = [...container.querySelectorAll('[data-tool-card]')].map((c) => c.getAttribute('data-tool-card'));
    expect(cards).toEqual(['resume-check', 'resume-job-match']);
    expect(screen.getByRole('link', { name: /Resume check/ }).getAttribute('href')).toBe('/tools/resume-check');
    expect(screen.queryByText(/campus/i)).toBeNull();
    expect(container.querySelector('[data-honesty="automated"]')).not.toBeNull();
    await waitFor(() => expect(screen.getByText(/Up to 3 checks a day with each tool/)).toBeTruthy());
  });

  it('GoApply lists both tools by default, like RoboApply (D5)', async () => {
    const { container } = renderTool(<ToolsHub />, { brand: 'goapply' });
    const cards = [...container.querySelectorAll('[data-tool-card]')].map((c) => c.getAttribute('data-tool-card'));
    expect(cards).toEqual(['resume-check', 'resume-job-match']);
    expect(container.querySelector('[data-notice="unavailable"]')).toBeNull();
    expect(container.querySelector('[data-honesty="automated"]')).not.toBeNull();
    await waitFor(() => expect(screen.getByText(/Up to 3 checks a day with each tool/)).toBeTruthy());
  });

  it('where a page says the tools are off it lists no tool, says so, and keeps the campus link', async () => {
    const { container } = renderTool(<ToolsHub toolsOpen={false} />, { brand: 'goapply', flags: { 'jobs.campusCalendar': true } });
    const cards = [...container.querySelectorAll('[data-tool-card]')].map((c) => c.getAttribute('data-tool-card'));
    expect(cards).toEqual(['campus']);
    expect(container.querySelector('[data-notice="unavailable"]')).not.toBeNull();
    expect(screen.queryByText(/checks a day/)).toBeNull();
  });

  it('hides the tools when the server says they are off, even if the page did not', async () => {
    api.getToolsConfig.mockResolvedValue(config({ available: false }));
    const { container } = renderTool(<ToolsHub />, { brand: 'goapply', flags: { 'jobs.campusCalendar': false } });
    await waitFor(() => expect(container.querySelector('[data-notice="unavailable"]')).not.toBeNull());
    expect(container.querySelector('[data-tool-card]')).toBeNull();
  });

  it('shows the allowance the server reports, and no number while it is unknown', async () => {
    api.getToolsConfig.mockResolvedValue(config({ perIpPerDay: 5 }));
    renderTool(<ToolsHub />);
    expect(screen.queryByText(/checks a day/)).toBeNull();
    expect(screen.getByText('No account needed.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Up to 5 checks a day/)).toBeTruthy());
  });

  it('GoApply in Chinese: 简历体检 first and a link to 校招日历', () => {
    const { container } = renderTool(<ToolsHub />, { brand: 'goapply', flags: { 'jobs.campusCalendar': true }, locale: 'zh' });
    const first = container.querySelector('[data-tool-card]') as HTMLElement;
    expect(first.getAttribute('data-tool-card')).toBe('resume-check');
    expect(within(first).getByRole('heading').textContent).toBe('简历体检');
    const campus = screen.getByRole('link', { name: /校招日历/ });
    expect(campus.getAttribute('href')).toBe('/campus');
  });

  it('GoApply leads with the resume check and links the campus calendar when it is on', () => {
    const { container } = renderTool(<ToolsHub />, { brand: 'goapply', flags: { 'jobs.campusCalendar': true } });
    const cards = [...container.querySelectorAll('[data-tool-card]')].map((c) => c.getAttribute('data-tool-card'));
    expect(cards).toEqual(['resume-check', 'campus', 'resume-job-match']);
    expect(container.querySelector('[data-tool-card="campus"]')?.getAttribute('href')).toBe('/campus');
  });

  // INT-06 (wave5 WP-93 #30): the job-alerts card.
  it('lists "Job alerts by email" last, linking /tools/job-alerts, when job alerts and email are both on', () => {
    const { container } = renderTool(<ToolsHub />, { flags: { 'jobs.alerts': true, 'notify.email': true } });
    const cards = [...container.querySelectorAll('[data-tool-card]')].map((c) => c.getAttribute('data-tool-card'));
    expect(cards).toEqual(['resume-check', 'resume-job-match', 'job-alerts']);
    const card = screen.getByRole('link', { name: /Job alerts by email/ });
    expect(card.getAttribute('href')).toBe('/tools/job-alerts');
    expect(card.textContent).toContain('daily or weekly');
    expect(JOB_ALERTS_ENTRY.flags).toEqual(['jobs.alerts', 'notify.email']);
  });

  it.each([
    ['job alerts off', { 'jobs.alerts': false, 'notify.email': true }],
    ['email off', { 'jobs.alerts': true, 'notify.email': false }],
    ['both off', {}],
  ] as const)('hides the job-alerts card with %s', (_name, flags) => {
    const { container } = renderTool(<ToolsHub />, { flags });
    expect(container.querySelector('[data-tool-card="job-alerts"]')).toBeNull();
    expect(screen.queryByText(/Job alerts by email/)).toBeNull();
    expect(container.querySelector('[data-tool-card="resume-check"]')).not.toBeNull();
  });

  it('GoApply: the job-alerts card under the same two capabilities, last, in Chinese; hidden when alerts are switched off', () => {
    const off = renderTool(<ToolsHub />, { brand: 'goapply', flags: { 'jobs.alerts': false, 'notify.email': true, 'jobs.campusCalendar': true } });
    expect(off.container.querySelector('[data-tool-card="job-alerts"]')).toBeNull();
    off.unmount();
    const on = renderTool(<ToolsHub />, { brand: 'goapply', flags: { 'jobs.alerts': true, 'notify.email': true, 'jobs.campusCalendar': true }, locale: 'zh' });
    const cards = [...on.container.querySelectorAll('[data-tool-card]')].map((c) => c.getAttribute('data-tool-card'));
    expect(cards).toEqual(['resume-check', 'campus', 'resume-job-match', 'job-alerts']);
    const card = on.container.querySelector('[data-tool-card="job-alerts"]') as HTMLElement;
    expect(within(card).getByRole('heading').textContent).toBe('职位邮件提醒');
    expect(card.getAttribute('href')).toBe('/tools/job-alerts');
    expect(intlErrors).toEqual([]);
    on.unmount();
    // The card does not depend on the upload tools being listed.
    const closed = renderTool(<ToolsHub toolsOpen={false} />, { brand: 'goapply', flags: { 'jobs.alerts': true, 'notify.email': true } });
    expect(closed.container.querySelector('[data-tool-card="job-alerts"]')).not.toBeNull();
  });

  it('GoApply without the campus capability has no campus entry', () => {
    const { container } = renderTool(<ToolsHub />, { brand: 'goapply', flags: { 'jobs.campusCalendar': false } });
    expect(container.querySelector('[data-tool-card="campus"]')).toBeNull();
    expect(container.querySelector('[data-tool-card="resume-check"]')).not.toBeNull();
  });
});

describe('resume check', () => {
  it('refuses a wrong file type on the client without calling the API', async () => {
    renderTool(<ToolRunner kind="resume_check" />);
    chooseFile(new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(screen.getByRole('alert').textContent).toMatch(/PDF, Word or plain-text/);
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    expect(api.runResumeCheck).not.toHaveBeenCalled();
  });

  it('asks for a file first', () => {
    renderTool(<ToolRunner kind="resume_check" />);
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    expect(screen.getByRole('alert').textContent).toBe('Choose a resume file.');
  });

  it('runs, shows the short automated report and the signup hand-off; only the click remembers the result, outside the URL', async () => {
    api.runResumeCheck.mockResolvedValue(checkReport());
    const { container } = renderTool(<ToolRunner kind="resume_check" />);
    await waitFor(() => expect(screen.getByText('2 free checks left today')).toBeTruthy());
    expect(container.querySelector('[data-privacy="tools"]')?.textContent).toMatch(/We don't keep your file/);
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));

    await waitFor(() => expect(container.querySelector('[data-report="resume_check"]')).not.toBeNull());
    const form = api.runResumeCheck.mock.calls[0]![0] as FormData;
    expect((form.get('resume') as File).name).toBe('Sam_Rivera.pdf');
    expect(form.get('consent')).toBeNull();

    const report = container.querySelector('[data-report="resume_check"]') as HTMLElement;
    expect(within(report).getByRole('heading', { level: 2 }).textContent).toBe('Fair');
    expect(within(report).getByText('Automated checklist')).toBeTruthy();
    expect(within(report).getByText(/Checked by software against 17 rules/)).toBeTruthy();
    expect(report.querySelectorAll('[data-issue]')).toHaveLength(3);
    expect(within(report).getByText('Weak opener: "Responsible for"')).toBeTruthy();
    expect(within(report).getByText('3 more issues are in the full report.')).toBeTruthy();
    expect(report.textContent).not.toMatch(/\bATS\b|score/i);

    const signup = screen.getByRole('link', { name: 'Create a free account' }).getAttribute('href')!;
    const u = new URL(signup, 'https://x');
    expect(u.searchParams.get('from')).toBe('resume-check');
    expect(u.searchParams.get('next')).toBe('/tools/resume-check');
    expect(signup).not.toContain(RID);
    expect(screen.getByRole('link', { name: 'I have an account' }).getAttribute('href')).not.toContain(RID);
    expect(screen.getByRole('link', { name: 'I have an account' }).getAttribute('href')).toMatch(/^\/login\?/);
    // A run alone remembers nothing; the click on the signup link is the request to keep it.
    expect(window.sessionStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
    expect(window.localStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
    const signupLink = screen.getByRole('link', { name: 'Create a free account' });
    signupLink.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(signupLink);
    expect(readPendingResult()).toMatchObject({ id: RID, kind: 'resume_check', expiresAt: '2026-10-11T12:00:00.000Z' });
  });

  it('says plainly when today’s free checks are used up', async () => {
    api.runResumeCheck.mockRejectedValue(new RoboApiError('limit', { status: 429, code: 'rate_limited', payload: { code: 'rate_limited', details: { retryAfterSec: 60 } } }));
    renderTool(<ToolRunner kind="resume_check" />);
    await screen.findByText('2 free checks left today');
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/used today's 3 free checks with this tool/));
  });

  it('shows what is left of this tool’s allowance', async () => {
    renderTool(<ToolRunner kind="resume_job_match" />);
    await screen.findByText('3 free checks left today');
  });

  it('explains the attempts guard and a check that is already running', async () => {
    api.runResumeCheck.mockRejectedValueOnce(
      new RoboApiError('many', { status: 429, code: 'rate_limited', payload: { code: 'rate_limited', details: { reason: 'too_many_attempts' } } }),
    );
    renderTool(<ToolRunner kind="resume_check" />);
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Too many tries today. Try again tomorrow.'));
    api.runResumeCheck.mockRejectedValueOnce(
      new RoboApiError('busy', { status: 429, code: 'rate_limited', payload: { code: 'rate_limited', details: { reason: 'run_in_progress' } } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already running/));
  });

  it('where the server says the tools are off, there is no form', async () => {
    api.getToolsConfig.mockResolvedValue(config({ available: false }));
    const { container } = renderTool(<ToolRunner kind="resume_check" />, { brand: 'goapply' });
    await waitFor(() => expect(container.querySelector('[data-notice="unavailable"]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Check my resume' })).toBeNull();
  });

  it('names the allowance the server enforced (RATE_LIMITS_JSON override)', async () => {
    api.runResumeCheck.mockRejectedValue(
      new RoboApiError('limit', { status: 429, code: 'rate_limited', payload: { code: 'rate_limited', details: { retryAfterSec: 60, limit: 5 } } }),
    );
    renderTool(<ToolRunner kind="resume_check" />);
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/used today's 5 free checks/));
  });

  it('maps a server reason (unreadable file) to plain text', async () => {
    api.runResumeCheck.mockRejectedValue(new RoboApiError('bad', { status: 422, code: 'invalid_request', payload: { code: 'invalid_request', details: { reason: 'file_unreadable' } } }));
    renderTool(<ToolRunner kind="resume_check" />);
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not read text from this file/));
  });

  it('GoApply: the notice must be ticked (unticked by default) and is sent with its version', async () => {
    api.getToolsConfig.mockResolvedValue(
      config({ consentRequired: true, consentVersion: 'tools-processing.vX', processedOutsideMainland: true, parserName: 'GoHire' }),
    );
    api.runResumeCheck.mockResolvedValue(checkReport({ profile: 'cn' }));
    const { container } = renderTool(<ToolRunner kind="resume_check" />, { brand: 'goapply' });
    const box = await waitFor(() => {
      const el = container.querySelector('[data-consent="tools"] input');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    expect(box.checked).toBe(false);
    await waitFor(() => expect(container.querySelector('[data-consent="tools"]')?.textContent).toMatch(/GoHire/));
    const notice = container.querySelector('[data-consent="tools"]')?.textContent ?? '';
    // The notice names the AI read (the structured parse runs only after this tick).
    expect(notice).toMatch(/GoApply reads this resume with automated software, including an AI model/);
    expect(notice).toMatch(/sent to GoHire, the resume-reading service GoApply uses, on servers in mainland China/);
    expect(notice).toMatch(/processed outside mainland China by the service providers named in the privacy notice/);
    expect(notice).not.toMatch(/beta|United States/);
    expect(screen.getByRole('link', { name: 'Privacy notice' })).toBeTruthy();
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Tick the box/);
    expect(api.runResumeCheck).not.toHaveBeenCalled();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(api.runResumeCheck).toHaveBeenCalled());
    expect((api.runResumeCheck.mock.calls[0]![0] as FormData).get('consent')).toBe('tools-processing.vX');
  });

  it('GoApply in Chinese: a stored translation of the old notice is never shown under the new consent version', async () => {
    api.getToolsConfig.mockResolvedValue(config({ consentRequired: true, consentVersion: 'tools-processing.vX', processedOutsideMainland: true, parserName: null }));
    const { container } = renderTool(<ToolRunner kind="resume_check" />, { brand: 'goapply', locale: 'zh' });
    await waitFor(() => expect(container.querySelector('[data-consent="tools"]')?.textContent).toMatch(/outside mainland China|中国大陆以外/));
    const notice = container.querySelector('[data-consent="tools"]')?.textContent ?? '';
    // The sentence the tick agrees to names the AI read, in the new English text or its Chinese translation.
    expect(notice).toMatch(/including an AI model|包括 AI 模型/);
    // The old Chinese sentences (no AI read; "during the beta … in the United States") never render.
    expect(notice).not.toMatch(/用自动化软件读取这份简历/);
    expect(notice).not.toMatch(/测试期间|美国/);
  });

  it('GoApply: when /config fails the notice still shows, and the contract version is sent', async () => {
    api.getToolsConfig.mockRejectedValue(new RoboApiError('down', { status: 503, code: 'unavailable', payload: { code: 'unavailable' } }));
    api.runResumeCheck.mockResolvedValue(checkReport({ profile: 'cn' }));
    const { container } = renderTool(<ToolRunner kind="resume_check" />, { brand: 'goapply' });
    const box = container.querySelector('[data-consent="tools"] input') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(container.querySelector('[data-consent="tools"]')?.textContent).toMatch(/set out in the privacy notice/);
    chooseFile(pdf());
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(api.runResumeCheck).toHaveBeenCalled());
    expect((api.runResumeCheck.mock.calls[0]![0] as FormData).get('consent')).toBe(TOOLS_CONSENT_VERSION);
  });

  it('signed in: Keep it saves the resume and shows the full report with a link to the full check', async () => {
    auth.status = 'authenticated';
    api.runResumeCheck.mockResolvedValue(checkReport());
    const full = checkReport({
      full: true,
      hiddenIssueCount: 0,
      issues: [...checkReport().issues, issue('i4', 'buzzwords', 'optional')],
    });
    api.claimToolResult.mockResolvedValue({ resumeId: 'rv_1', report: full, alreadyClaimed: false });
    const { container } = renderTool(<ToolRunner kind="resume_check" />);
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy());
    expect(screen.queryByRole('link', { name: 'Create a free account' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.getByText('Saved. It is in your resumes now.')).toBeTruthy());
    expect(api.claimToolResult).toHaveBeenCalledWith(RID);
    expect(container.querySelector('[data-report="resume_check"]')?.getAttribute('data-full')).toBe('yes');
    expect(container.querySelectorAll('[data-issue]')).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Open the full check' }).getAttribute('href')).toBe('/resume/rv_1/check');
    expect(window.sessionStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
  });

  it('signed in: a check the user does not keep is never remembered for a later claim', async () => {
    auth.status = 'authenticated';
    api.runResumeCheck.mockResolvedValue(checkReport());
    renderTool(<ToolRunner kind="resume_check" />);
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    await screen.findByRole('button', { name: 'Keep it' });
    expect(window.sessionStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
    expect(window.localStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
    cleanup();
    renderTool(<ToolResultClaimHost />);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.claimToolResult).not.toHaveBeenCalled();
  });

  it('signed in: a full resume list is explained', async () => {
    auth.status = 'authenticated';
    api.runResumeCheck.mockResolvedValue(checkReport());
    api.claimToolResult.mockRejectedValue(new RoboApiError('full', { status: 409, code: 'conflict', payload: { code: 'conflict', details: { reason: 'resume_limit' } } }));
    renderTool(<ToolRunner kind="resume_check" />);
    chooseFile(pdf());
    fireEvent.click(screen.getByRole('button', { name: 'Check my resume' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/most resumes it can/));
  });

  const keepInThisTab = (kind: 'resume_check' | 'resume_job_match' = 'resume_check') =>
    armPendingResult({ id: RID, kind, expiresAt: '2999-01-01T00:00:00.000Z' });

  it('back from signup, reopens the result this tab asked to keep (never from the URL)', async () => {
    keepInThisTab();
    api.getToolResult.mockResolvedValueOnce(checkReport({ cached: true }));
    const { container } = renderTool(<ToolRunner kind="resume_check" />);
    await waitFor(() => expect(container.querySelector('[data-report="resume_check"]')).not.toBeNull());
    expect(api.getToolResult).toHaveBeenCalledWith(RID, expect.anything());
    expect(screen.getByText(/did not use a free check/)).toBeTruthy();
  });

  it('does not reopen another tool’s result, or anything without a request to keep', async () => {
    keepInThisTab('resume_job_match');
    renderTool(<ToolRunner kind="resume_check" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getToolResult).not.toHaveBeenCalled();
  });

  it('says when the result was deleted, or cannot be opened in this browser, and forgets it', async () => {
    keepInThisTab();
    api.getToolResult.mockRejectedValueOnce(
      new RoboApiError('gone', { status: 404, code: 'not_found', payload: { code: 'not_found', details: { reason: 'result_expired' } } }),
    );
    const first = renderTool(<ToolRunner kind="resume_check" />);
    await waitFor(() => expect(first.container.querySelector('[data-notice="expired"]')?.textContent).toMatch(/deleted after 24 hours/));
    expect(screen.getByRole('button', { name: 'Check my resume' })).toBeTruthy();
    expect(readPendingResult()).toBeNull();
    first.unmount();

    keepInThisTab();
    api.getToolResult.mockRejectedValueOnce(new RoboApiError('nope', { status: 404, code: 'not_found', payload: { code: 'not_found' } }));
    const { container } = renderTool(<ToolRunner kind="resume_check" />);
    await waitFor(() => expect(container.querySelector('[data-notice="missing"]')).not.toBeNull());
    expect(screen.getByText(/only in the browser that ran the check/)).toBeTruthy();
  });

  it('a kept result says it is saved, not deleted', async () => {
    keepInThisTab();
    api.getToolResult.mockRejectedValueOnce(
      new RoboApiError('kept', { status: 404, code: 'not_found', payload: { code: 'not_found', details: { reason: 'result_claimed' } } }),
    );
    const { container } = renderTool(<ToolRunner kind="resume_check" />);
    await waitFor(() => expect(container.querySelector('[data-notice="claimed"]')).not.toBeNull());
    expect(container.querySelector('[data-notice="expired"]')).toBeNull();
    expect(screen.queryByText(/This result was deleted/)).toBeNull();
    expect(screen.getByText(/already saved in an account/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to my resumes' }).getAttribute('href')).toBe('/resume');
  });

  it('Check another file on a reopened result shows the form and keeps it', async () => {
    keepInThisTab();
    api.getToolResult.mockResolvedValue(checkReport({ cached: true }));
    const { container } = renderTool(<ToolRunner kind="resume_check" />);
    await waitFor(() => expect(container.querySelector('[data-report="resume_check"]')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Check another file' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-report="resume_check"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check my resume' })).toBeTruthy();
  });
});

describe('resume and job check', () => {
  it('does not take a bare link: it explains and does not call the API', async () => {
    const { container } = renderTool(<ToolRunner kind="resume_job_match" />);
    chooseFile(pdf());
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Backend Engineer' } });
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: 'https://jobs.example.com/123' } });
    expect(container.querySelector('[data-notice="link"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(api.runResumeJobMatch).not.toHaveBeenCalled();
  });

  it('sends the posting and shows requirement rows, word lists and the no-score line', async () => {
    api.runResumeJobMatch.mockResolvedValue(matchReport());
    const { container } = renderTool(<ToolRunner kind="resume_job_match" />);
    chooseFile(pdf());
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Backend Engineer' } });
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: 'x'.repeat(80) } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(container.querySelector('[data-report="resume_job_match"]')).not.toBeNull());
    const form = api.runResumeJobMatch.mock.calls[0]![0] as FormData;
    expect(form.get('postingTitle')).toBe('Backend Engineer');
    expect(form.get('postingText')).toBe('x'.repeat(80));
    expect(container.querySelectorAll('[data-row]')).toHaveLength(5);
    expect(container.querySelector('[data-row="years"]')?.textContent).toMatch(/Asks for 3\+ years.*about 2/);
    expect(container.querySelector('[data-row="skills"]')?.textContent).toMatch(/1 of 4/);
    expect(container.querySelector('[data-honesty="no-score"]')?.textContent).toMatch(/not a fit score/);
    expect(screen.getByText('Kubernetes')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tailor this resume to the job' })).toBeTruthy();
  });

  it('asks for the posting text before calling the API', () => {
    renderTool(<ToolRunner kind="resume_job_match" />);
    chooseFile(pdf());
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Backend Engineer' } });
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByRole('alert').textContent).toMatch(/at least 50 characters/);
    expect(api.runResumeJobMatch).not.toHaveBeenCalled();
  });
});

describe('ToolResultClaimHost', () => {
  it('keeps a result the visitor asked to keep (clicked signup in this tab), once', async () => {
    armPendingResult({ id: RID, kind: 'resume_check', expiresAt: '2999-01-01T00:00:00.000Z' });
    auth.status = 'authenticated';
    api.claimToolResult.mockResolvedValue({ resumeId: 'rv_1', report: checkReport({ full: true }), alreadyClaimed: false });
    renderTool(<ToolResultClaimHost />);
    await waitFor(() => expect(api.claimToolResult).toHaveBeenCalledWith(RID));
    expect(window.sessionStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
    cleanup();
    renderTool(<ToolResultClaimHost />);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.claimToolResult).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a session or without a request to keep', async () => {
    armPendingResult({ id: RID, kind: 'resume_check', expiresAt: '2999-01-01T00:00:00.000Z' });
    renderTool(<ToolResultClaimHost />);
    cleanup();
    window.sessionStorage.removeItem(PENDING_RESULT_KEY);
    auth.status = 'authenticated';
    renderTool(<ToolResultClaimHost />);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.claimToolResult).not.toHaveBeenCalled();
  });

  it('shared browser: a request older than 30 minutes is dropped, not claimed into whoever signs in', async () => {
    armPendingResult({ id: RID, kind: 'resume_check', expiresAt: '2999-01-01T00:00:00.000Z' }, new Date(Date.now() - ARM_TTL_MS - 60_000));
    auth.status = 'authenticated';
    renderTool(<ToolResultClaimHost />);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.claimToolResult).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(PENDING_RESULT_KEY)).toBeNull();
  });

  it('ignores an entry left by an older build in localStorage', async () => {
    window.localStorage.setItem(PENDING_RESULT_KEY, JSON.stringify({ id: RID, kind: 'resume_check', expiresAt: '2999-01-01T00:00:00.000Z' }));
    auth.status = 'authenticated';
    renderTool(<ToolResultClaimHost />);
    await new Promise((r) => setTimeout(r, 10));
    expect(api.claimToolResult).not.toHaveBeenCalled();
  });
});
