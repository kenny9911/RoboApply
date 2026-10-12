// WP-59 — /admin/questions (lib/api/prep mocked; admin role from the auth mock).
// The moderation list, the NDA/copyright screen, publish/turn down, reported
// questions and staff-written questions.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../../../../__tests__/utils/mockAuth';
import type { AdminQuestionView, ContributionView } from '../../../../lib/api/contracts/prep';
import { RoboApiError } from '../../../../lib/api/client';

const api = vi.hoisted(() => ({
  adminListContributions: vi.fn(),
  adminApproveContribution: vi.fn(),
  adminRejectContribution: vi.fn(),
  adminListQuestions: vi.fn(),
  adminCreateQuestion: vi.fn(),
  adminSetQuestionHidden: vi.fn(),
}));
vi.mock('../../../../lib/api/prep', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import AdminQuestionsPage from '../../../../app/(auth)/admin/questions/page';

const CLEAN: ContributionView = {
  id: 'c1',
  companyName: 'Acme',
  role: 'Analyst',
  period: '2026-09',
  body: 'Why do you want to work on payments?',
  status: 'pending',
  createdAt: '2026-10-01T00:00:00.000Z',
  moderatedAt: null,
  suggestedCategory: null,
  rejectReason: null,
  flags: [],
  locale: 'en',
};
const FLAGGED: ContributionView = { ...CLEAN, id: 'c2', role: '', body: 'Codility online assessment, under NDA: sort a list?', flags: ['nda_or_test_content'] };

const REPORTED: AdminQuestionView = {
  id: 'q9',
  companySlug: 'acme',
  companyName: 'Acme',
  title: 'Old question',
  body: 'Describe your biggest weakness?',
  category: 'behavioral',
  difficulty: null,
  seniority: null,
  locale: 'en',
  sourceKind: 'user_report',
  sourceLabelKey: 'source.userReport',
  reportedPeriod: '2025-01',
  aiGenerated: false,
  status: 'published',
  reportsCount: 2,
  reports: [{ reason: 'duplicate', note: 'Same as another', createdAt: '2026-10-02T00:00:00.000Z' }],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
  api.adminListContributions.mockImplementation(async (q: { status: string }) => (q.status === 'pending' ? { items: [CLEAN, FLAGGED], cursor: null } : { items: [], cursor: null }));
  api.adminListQuestions.mockImplementation(async (q: { filter: string }) => (q.filter === 'reported' ? { items: [REPORTED], cursor: null } : { items: [], cursor: null }));
  api.adminApproveContribution.mockResolvedValue({});
  api.adminRejectContribution.mockResolvedValue({ ...FLAGGED, status: 'rejected' });
  api.adminSetQuestionHidden.mockResolvedValue({});
  api.adminCreateQuestion.mockResolvedValue({});
});

describe('/admin/questions', () => {
  it('non-admins see "not authorized" and nothing is fetched', () => {
    mockAuthState.value = buildAuthValue();
    renderWithBrand(<AdminQuestionsPage />);
    expect(screen.getByText(/authorized/)).toBeInTheDocument();
    expect(api.adminListContributions).not.toHaveBeenCalled();
  });

  it('publishing needs a group; the question publishes with the tidied wording', async () => {
    renderWithBrand(<AdminQuestionsPage />);
    const item = await screen.findByRole('article', { name: 'Acme · Analyst · asked in September 2026' });
    const publish = within(item).getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    fireEvent.change(within(item).getByLabelText('Group'), { target: { value: 'behavioral' } });
    fireEvent.change(within(item).getByLabelText('Short title'), { target: { value: 'Why payments' } });
    fireEvent.click(publish);
    await waitFor(() =>
      expect(api.adminApproveContribution).toHaveBeenCalledWith('c1', { category: 'behavioral', title: 'Why payments', body: 'Why do you want to work on payments?', locale: 'en' }),
    );
  });

  it("the group field starts at the contributor's suggestion, which staff can change (SR-59-2)", async () => {
    api.adminListContributions.mockImplementation(async (q: { status: string }) =>
      q.status === 'pending' ? { items: [{ ...CLEAN, suggestedCategory: 'system_design' }], cursor: null } : { items: [], cursor: null },
    );
    renderWithBrand(<AdminQuestionsPage />);
    const item = await screen.findByRole('article', { name: 'Acme · Analyst · asked in September 2026' });
    expect(within(item).getByText('Group the user picked: System design')).toBeInTheDocument();
    const group = within(item).getByLabelText('Group');
    expect(group).toHaveValue('system_design');
    expect(within(item).getByRole('button', { name: 'Publish' })).not.toBeDisabled();
    fireEvent.change(group, { target: { value: 'coding' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.adminApproveContribution).toHaveBeenCalledWith('c1', expect.objectContaining({ category: 'coding' })));
  });

  it('a turned-down question shows the stored reason (SR-59-2)', async () => {
    api.adminListContributions.mockImplementation(async (q: { status: string }) =>
      q.status === 'rejected'
        ? { items: [{ ...CLEAN, status: 'rejected', moderatedAt: '2026-10-05T00:00:00.000Z', rejectReason: 'duplicate' }], cursor: null }
        : { items: [], cursor: null },
    );
    renderWithBrand(<AdminQuestionsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Turned down' }));
    const item = await screen.findByRole('article', { name: 'Acme · Analyst · asked in September 2026' });
    expect(within(item).getByText('Turned down: Already published')).toBeInTheDocument();
    expect(within(item).queryByText(/Group the user picked/)).toBeNull();
  });

  it("the language field starts at the server's guess and staff can change it", async () => {
    api.adminListContributions.mockImplementation(async (q: { status: string }) =>
      q.status === 'pending' ? { items: [{ ...CLEAN, body: '日本語のテスト質問です、なぜ弊社ですか？', locale: 'ja' }], cursor: null } : { items: [], cursor: null },
    );
    renderWithBrand(<AdminQuestionsPage />);
    const item = await screen.findByRole('article', { name: 'Acme · Analyst · asked in September 2026' });
    const language = within(item).getByLabelText('Language');
    expect(language).toHaveValue('ja');
    fireEvent.change(language, { target: { value: 'zh-TW' } });
    fireEvent.change(within(item).getByLabelText('Group'), { target: { value: 'behavioral' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.adminApproveContribution).toHaveBeenCalledWith('c1', expect.objectContaining({ locale: 'zh-TW' })));
  });

  it('flagged text shows why and needs "I checked it" before publishing; turning down records the reason', async () => {
    renderWithBrand(<AdminQuestionsPage />);
    const item = await screen.findByRole('article', { name: 'Acme · asked in September 2026' });
    expect(within(item).getByText('It may be test or assessment content under a non-disclosure agreement')).toBeInTheDocument();
    fireEvent.change(within(item).getByLabelText('Group'), { target: { value: 'coding' } });
    const publish = within(item).getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    // The reason defaults to the flag.
    expect(within(item).getByLabelText('Reason')).toHaveValue('nda_or_test_content');
    fireEvent.click(within(item).getByRole('button', { name: 'Turn down' }));
    await waitFor(() => expect(api.adminRejectContribution).toHaveBeenCalledWith('c2', { reason: 'nda_or_test_content' }));
    fireEvent.click(within(item).getByRole('checkbox'));
    expect(publish).not.toBeDisabled();
  });

  it('an edit that trips the screen shows its flags and the check box, then publishes with confirmScreened', async () => {
    api.adminApproveContribution.mockRejectedValueOnce(
      new RoboApiError('Check the flagged text first.', {
        code: 'conflict',
        status: 409,
        payload: { success: false, code: 'conflict', details: { reason: 'screen_not_confirmed', flags: ['nda_or_test_content'] } },
      }),
    );
    renderWithBrand(<AdminQuestionsPage />);
    const item = await screen.findByRole('article', { name: 'Acme · Analyst · asked in September 2026' });
    expect(within(item).queryByRole('checkbox')).toBeNull();
    fireEvent.change(within(item).getByLabelText('Question as it will show'), { target: { value: 'The take-home test: why payments?' } });
    fireEvent.change(within(item).getByLabelText('Group'), { target: { value: 'behavioral' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Publish' }));
    expect(await within(item).findByText(/Your edit was flagged/)).toBeInTheDocument();
    expect(within(item).getByText('It may be test or assessment content under a non-disclosure agreement')).toBeInTheDocument();
    const publish = within(item).getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    fireEvent.click(within(item).getByRole('checkbox'));
    fireEvent.click(publish);
    await waitFor(() => expect(api.adminApproveContribution).toHaveBeenLastCalledWith('c1', expect.objectContaining({ confirmScreened: true })));
  });

  it('a reported question can be kept showing, which clears its reports', async () => {
    renderWithBrand(<AdminQuestionsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Reported' }));
    const item = await screen.findByRole('article', { name: 'Old question' });
    expect(within(item).getByText(/clears its reports/)).toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Keep showing' }));
    await waitFor(() => expect(api.adminSetQuestionHidden).toHaveBeenCalledWith('q9', false));
  });

  it('reported questions show reasons and can be hidden', async () => {
    renderWithBrand(<AdminQuestionsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Reported' }));
    const item = await screen.findByRole('article', { name: 'Old question' });
    expect(within(item).getByText(/2 reports/)).toBeInTheDocument();
    expect(within(item).getByText(/It repeats another question/)).toBeInTheDocument();
    expect(within(item).getByText('Shared by a RoboApply user, January 2025')).toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(api.adminSetQuestionHidden).toHaveBeenCalledWith('q9', true));
  });

  it("GoApply: a staff question's language starts at zh (the site's language)", async () => {
    renderWithBrand(<AdminQuestionsPage />, { brand: 'goapply' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Write a question' }));
    const form = await screen.findByRole('form', { name: 'Write a general practice question' });
    expect(within(form).getByLabelText('Language')).toHaveValue('zh');
  });

  it('staff write a general question (no company field)', async () => {
    renderWithBrand(<AdminQuestionsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Write a question' }));
    const form = await screen.findByRole('form', { name: 'Write a general practice question' });
    expect(within(form).queryByLabelText('Company')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Short title'), { target: { value: 'Career plans' } });
    fireEvent.change(within(form).getByLabelText('Question'), { target: { value: '你未来三年的职业规划是什么？' } });
    fireEvent.change(within(form).getByLabelText('Group'), { target: { value: 'hr' } });
    fireEvent.change(within(form).getByLabelText('Language'), { target: { value: 'zh' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Publish question' }));
    await waitFor(() =>
      expect(api.adminCreateQuestion).toHaveBeenCalledWith({ title: 'Career plans', body: '你未来三年的职业规划是什么？', category: 'hr', locale: 'zh' }),
    );
  });
});
