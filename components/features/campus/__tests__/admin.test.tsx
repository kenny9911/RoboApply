// WP-58 — /admin/campus curation console (lib/api mocked; admin role from the
// auth mock): official page → AI proposal with quotes and the AI label →
// staff save a draft → check → publish. Publish stays disabled until checked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../../lib/api/client';

vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));
const api = vi.hoisted(() => ({
  adminListCampusEvents: vi.fn(),
  adminExtractCampusEvent: vi.fn(),
  adminCreateCampusEvent: vi.fn(),
  adminUpdateCampusEvent: vi.fn(),
  adminVerifyCampusEvent: vi.fn(),
  adminPublishCampusEvent: vi.fn(),
  adminDeleteCampusEvent: vi.fn(),
}));
vi.mock('../../../../lib/api/campus', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));

import AdminCampusPage from '../../../../app/(auth)/admin/campus/page';
import { bodyFromForm, errorKey, formFromDraft } from '../CampusAdmin';

const DRAFT_ROW = {
  id: 'ev_d',
  companyName: '示例科技',
  companySlug: '示例科技',
  title: '2027届校园招聘',
  graduationClass: '2027届',
  kind: 'application',
  applyOpensAt: null,
  applyClosesAt: '2026-10-31T15:59:00.000Z',
  stages: [],
  cities: [],
  roles: [],
  officialUrl: 'https://campus.example.cn/2027',
  sourceUrl: null,
  sourceName: '示例科技校园招聘官网',
  needsReverify: true,
  status: 'draft',
  companyId: null,
  sourceNote: null,
  verifiedAt: null,
  verifiedByUserId: null,
  verifiedByName: null,
  createdBy: 'admin_1',
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

const apiError = (status: number, code: string, reason?: string) =>
  new RoboApiError('x', { status, code, payload: { success: false, code, ...(reason ? { details: { reason } } : {}) } });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
  api.adminListCampusEvents.mockImplementation(async (q: { status: string }) => ({ items: q.status === 'draft' ? [DRAFT_ROW] : [], cursor: null }));
  api.adminCreateCampusEvent.mockResolvedValue(DRAFT_ROW);
  api.adminVerifyCampusEvent.mockResolvedValue({ ...DRAFT_ROW, verifiedAt: '2026-10-10T00:00:00.000Z', verifiedByUserId: 'admin_1' });
});

describe('/admin/campus', () => {
  it('non-admins see "not authorized" and nothing is fetched', () => {
    mockAuthState.value = buildAuthValue();
    renderWithBrand(<AdminCampusPage />, { brand: 'goapply' });
    expect(screen.getByText('Only staff can edit the campus calendar.')).toBeInTheDocument();
    expect(api.adminListCampusEvents).not.toHaveBeenCalled();
  });

  it('reads an official page into a labelled AI proposal with quotes, then saves a draft (Beijing time)', async () => {
    api.adminExtractCampusEvent.mockResolvedValue({
      draft: { officialUrl: 'https://campus.example.cn/2027', companyName: '示例科技', title: '2027届校园招聘', graduationClass: '2027届', applyClosesAt: '2026-10-31T15:59:00.000Z', sourceName: '示例科技2027届校园招聘官网' },
      evidence: { applyClosesAt: '网申时间：2026年9月1日-2026年10月31日 23:59' },
      dropped: ['applyOpensAt'],
      pageTitle: '示例科技2027届校园招聘官网',
      fetchedAt: '2026-10-10T00:00:00.000Z',
      finalUrl: 'https://campus.example.cn/2027',
      aiGenerated: true,
      model: 'deepseek/deepseek-chat',
    });
    const { container } = renderWithBrand(<AdminCampusPage />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('Official page URL'), { target: { value: 'https://campus.example.cn/2027' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the page' }));
    await screen.findByRole('heading', { name: 'New entry' });
    expect(api.adminExtractCampusEvent).toHaveBeenCalledWith({ officialUrl: 'https://campus.example.cn/2027' });
    expect(screen.getByText(/Suggested by AI from the page/)).toBeInTheDocument();
    // GoApply AI output carries the AI label.
    expect(container.querySelector('[data-ai-label="text"]')).not.toBeNull();
    expect(screen.getByText('On the page: “网申时间：2026年9月1日-2026年10月31日 23:59”')).toBeInTheDocument();
    expect(screen.getByText(/Not filled because the page doesn't state it/)).toBeInTheDocument();
    expect(screen.getByLabelText('Applications close (Beijing time)')).toHaveValue('2026-10-31T23:59');
    // Nothing saved until staff press save.
    expect(api.adminCreateCampusEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() =>
      expect(api.adminCreateCampusEvent).toHaveBeenCalledWith(
        expect.objectContaining({ companyName: '示例科技', graduationClass: '2027届', applyClosesAt: '2026-10-31T15:59:00.000Z', officialUrl: 'https://campus.example.cn/2027' }),
      ),
    );
    expect(api.adminPublishCampusEvent).not.toHaveBeenCalled();
  });

  it('shows why an aggregator URL is refused', async () => {
    api.adminExtractCampusEvent.mockRejectedValue(apiError(422, 'invalid_request', 'aggregator_source'));
    renderWithBrand(<AdminCampusPage />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('Official page URL'), { target: { value: 'https://www.yingjiesheng.com/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the page' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That site lists other employers' programmes");
  });

  it('a draft cannot be published until someone checks it', async () => {
    renderWithBrand(<AdminCampusPage />, { brand: 'goapply' });
    const item = await screen.findByRole('article', { name: '示例科技 · 2027届校园招聘' });
    expect(within(item).getByText('Not checked yet')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Publish' })).toBeDisabled();
    fireEvent.click(within(item).getByRole('button', { name: 'I checked it against the official page' }));
    await waitFor(() => expect(api.adminVerifyCampusEvent).toHaveBeenCalledWith('ev_d'));
  });

  it('deleting a draft asks first; cancel keeps it', async () => {
    api.adminDeleteCampusEvent.mockResolvedValue({ id: 'ev_d', result: 'deleted' });
    renderWithBrand(<AdminCampusPage />, { brand: 'goapply' });
    const item = await screen.findByRole('article', { name: '示例科技 · 2027届校园招聘' });
    fireEvent.click(within(item).getByRole('button', { name: 'Delete draft' }));
    expect(api.adminDeleteCampusEvent).not.toHaveBeenCalled();
    expect(within(item).getByText("Delete this draft? This can't be undone.")).toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }));
    expect(within(item).queryByText("Delete this draft? This can't be undone.")).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: 'Delete draft' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(api.adminDeleteCampusEvent).toHaveBeenCalledWith('ev_d'));
  });

  it('archiving a checked programme says it cannot be published again, and asks first', async () => {
    const checked = { ...DRAFT_ROW, verifiedAt: '2026-10-09T00:00:00.000Z', verifiedByUserId: 'admin_1', verifiedByName: 'Ops' };
    api.adminListCampusEvents.mockImplementation(async (q: { status: string }) => ({ items: q.status === 'draft' ? [checked] : [], cursor: null }));
    api.adminDeleteCampusEvent.mockResolvedValue({ id: 'ev_d', result: 'archived' });
    renderWithBrand(<AdminCampusPage />, { brand: 'goapply' });
    const item = await screen.findByRole('article', { name: '示例科技 · 2027届校园招聘' });
    fireEvent.click(within(item).getByRole('button', { name: 'Archive' }));
    expect(api.adminDeleteCampusEvent).not.toHaveBeenCalled();
    expect(within(item).getByText(/can't be published again/)).toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Archive it' }));
    await waitFor(() => expect(api.adminDeleteCampusEvent).toHaveBeenCalledWith('ev_d'));
  });

  it('a failed AI read says to fill in by hand', async () => {
    api.adminExtractCampusEvent.mockRejectedValue(apiError(503, 'ai_unavailable', 'extract_failed'));
    renderWithBrand(<AdminCampusPage />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('Official page URL'), { target: { value: 'https://campus.example.cn/2027' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the page' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("The page couldn't be read automatically. Fill in the fields by hand");
  });
});

describe('form mapping', () => {
  it('round-trips a draft and reads errors', () => {
    const f = formFromDraft({ officialUrl: 'https://x.cn', cities: ['北京'], stages: [{ kind: 'bishi', startsAt: '2026-11-04T16:00:00.000Z' }] });
    const body = bodyFromForm({ ...f, companyName: ' A ', title: 'T' });
    expect(body).toMatchObject({ companyName: 'A', graduationClass: '2027届', cities: ['北京'], stages: [{ kind: 'bishi', startsAt: '2026-11-04T16:00:00.000Z' }] });
    expect(errorKey(apiError(503, 'ai_unavailable'))).toBe('ai_unavailable');
    // An unknown reason falls back to the code (no_model is an ai_unavailable answer).
    expect(errorKey(apiError(503, 'ai_unavailable', 'no_model'))).toBe('ai_unavailable');
    expect(errorKey(apiError(503, 'ai_unavailable', 'extract_failed'))).toBe('extract_failed');
    expect(errorKey(apiError(409, 'conflict', 'campus_event_not_verified'))).toBe('campus_event_not_verified');
    expect(errorKey(new Error('x'))).toBe('generic');
  });
});
