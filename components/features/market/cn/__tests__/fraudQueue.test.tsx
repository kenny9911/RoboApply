// WP-41 — /admin/fraud console (lib/api mocked; admin role from the auth mock).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../../../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../../../lib/api/client';

const api = vi.hoisted(() => ({
  adminListFraudQueue: vi.fn(),
  adminResolveFraud: vi.fn(),
  adminListBlacklist: vi.fn(),
  adminAddBlacklist: vi.fn(),
  adminRemoveBlacklist: vi.fn(),
}));
vi.mock('../../../../../lib/api/cnJobs', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import AdminFraudPage from '../../../../../app/(auth)/admin/fraud/page';

const ITEM = {
  jobId: 'job_a',
  title: '储备干部',
  companyName: '示例培训有限公司',
  sourceName: 'GoHire',
  visibility: 'public',
  flags: [
    { rule: 'upfront_fee', evidence: '入职需缴纳押金500元', at: '2026-10-02T00:00:00.000Z', method: 'keywords' },
    { rule: 'training_loan', evidence: '学费可分期', at: '2026-10-03T00:00:00.000Z', method: 'llm' },
  ],
  reportCount: 2,
  flaggedAt: '2026-10-02T00:00:00.000Z',
  review: null,
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
  api.adminListFraudQueue.mockImplementation(async (q: { status: string }) => (q.status === 'flagged' ? { items: [ITEM], cursor: null } : { items: [], cursor: null }));
  api.adminResolveFraud.mockResolvedValue({ jobId: 'job_a', status: 'cleared', blacklistEntryId: null });
  api.adminListBlacklist.mockResolvedValue({ items: [{ id: 'bl1', employerName: '黑心培训学校', reason: '培训贷', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'a1' }] });
  api.adminAddBlacklist.mockResolvedValue({ id: 'bl2', employerName: 'X', reason: 'y', createdAt: '2026-10-10T00:00:00.000Z', createdBy: 'a1', matchedOpenJobs: 3 });
  api.adminRemoveBlacklist.mockResolvedValue(undefined);
});

describe('/admin/fraud', () => {
  it('non-admins see "not authorized" and nothing is fetched', () => {
    mockAuthState.value = buildAuthValue();
    renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    expect(screen.getByText(/authorized/)).toBeInTheDocument();
    expect(api.adminListFraudQueue).not.toHaveBeenCalled();
  });

  it('titles the page and lists flagged posts with evidence, method and report count', async () => {
    const { container } = renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    expect(screen.getByRole('heading', { name: 'Suspicious jobs to review' })).toBeInTheDocument();
    const item = await screen.findByRole('article', { name: '储备干部' });
    expect(within(item).getByText('Asks you to pay first')).toBeInTheDocument();
    expect(within(item).getByText('“入职需缴纳押金500元”')).toBeInTheDocument();
    expect(within(item).getByText('AI check')).toBeInTheDocument();
    expect(within(item).getByText(/2 user reports/)).toBeInTheDocument();
    // The AI-raised flag carries the AI label (GoApply).
    expect(container.querySelectorAll('[data-ai-label]')).toHaveLength(1);
  });

  it('"Not a scam" clears with the note', async () => {
    renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    const item = await screen.findByRole('article', { name: '储备干部' });
    fireEvent.change(within(item).getByLabelText('Note (optional)'), { target: { value: '押金为工牌押金，已核实退还' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Not a scam' }));
    await waitFor(() => expect(api.adminResolveFraud).toHaveBeenCalledWith('job_a', { decision: 'clear', note: '押金为工牌押金，已核实退还' }));
  });

  it('confirm can add the employer to the block list (clear is then disabled)', async () => {
    renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    const item = await screen.findByRole('article', { name: '储备干部' });
    fireEvent.click(within(item).getByLabelText('Also add 示例培训有限公司 to the block list'));
    expect(within(item).getByRole('button', { name: 'Not a scam' })).toBeDisabled();
    fireEvent.click(within(item).getByRole('button', { name: 'Confirm scam and take down' }));
    await waitFor(() => expect(api.adminResolveFraud).toHaveBeenCalledWith('job_a', { decision: 'confirm', blacklistEmployer: true }));
  });

  it('status tabs load the other lists', async () => {
    renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    await screen.findByRole('article', { name: '储备干部' });
    fireEvent.click(screen.getByRole('tab', { name: 'Cleared' }));
    expect(await screen.findByText('No cleared posts yet.')).toBeInTheDocument();
    expect(api.adminListFraudQueue).toHaveBeenCalledWith({ status: 'cleared' }, expect.anything());
  });

  it('block list: add, duplicate message, remove', async () => {
    renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    expect(await screen.findByText('黑心培训学校')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Employer name'), { target: { value: '某某教育' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '培训贷投诉' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to block list' }));
    await waitFor(() => expect(api.adminAddBlacklist).toHaveBeenCalledWith({ employerName: '某某教育', reason: '培训贷投诉' }));
    expect(await screen.findByText('3 open posts matched this name and are now flagged.')).toBeInTheDocument();

    api.adminAddBlacklist.mockRejectedValueOnce(new RoboApiError('dup', { status: 409, code: 'conflict', payload: { success: false, code: 'conflict', error: 'dup' } }));
    fireEvent.change(screen.getByLabelText('Employer name'), { target: { value: '黑心培训学校' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to block list' }));
    expect(await screen.findByText('That employer is already on the block list.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove 黑心培训学校' }));
    await waitFor(() => expect(api.adminRemoveBlacklist).toHaveBeenCalledWith('bl1'));
  });

  it('adding a name that matches no open post says so', async () => {
    api.adminAddBlacklist.mockResolvedValueOnce({ id: 'bl3', employerName: '华', reason: 'r', createdAt: '2026-10-10T00:00:00.000Z', createdBy: 'a1', matchedOpenJobs: 0 });
    renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    await screen.findByText('黑心培训学校');
    fireEvent.change(screen.getByLabelText('Employer name'), { target: { value: '华' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to block list' }));
    expect(await screen.findByRole('status')).toHaveTextContent('No open posts matched this name.');
  });

  it("reviewed items show the admin's name, never the raw id", async () => {
    const reviewed = (byName: string | null) => ({ ...ITEM, review: { decision: 'clear', note: null, at: '2026-10-05T00:00:00.000Z', by: 'usr_123', byName } });
    api.adminListFraudQueue.mockImplementation(async (q: { status: string }) =>
      q.status === 'cleared' ? { items: [reviewed('Lin Wei'), { ...reviewed(null), jobId: 'job_b', title: '客服' }], cursor: null } : { items: [], cursor: null },
    );
    renderWithBrand(<AdminFraudPage />, { brand: 'goapply' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Cleared' }));
    const named = await screen.findByRole('article', { name: '储备干部' });
    expect(within(named).getByText(/^Cleared by Lin Wei on /)).toBeInTheDocument();
    const unnamed = screen.getByRole('article', { name: '客服' });
    expect(within(unnamed).getByText(/^Cleared on /)).toBeInTheDocument();
    expect(screen.queryByText(/usr_123/)).toBeNull();
  });
});
