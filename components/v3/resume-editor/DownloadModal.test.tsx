// DownloadModal against the real wire (INT-10; wave3 WP-93 #27). The export
// call is NOT mocked here: `downloadResumeExport` runs for real over a fake
// `fetch` that answers exactly what server/src/roboapply/v2/routes/resumes.ts
// sends, so the modal reads `unverified_claims` from where the server puts it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import { RoboApiError } from '../../../lib/api/client';

vi.mock('../../features/auth-cn', () => ({ WechatBrowserBanner: () => null }));
vi.mock('../../features/market', () => ({ AiGeneratedBadge: () => null }));

import { DownloadModal, unverifiedClaimsOf } from './DownloadModal';

const fetchMock = vi.fn();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderModal = (onClose = vi.fn()) => {
  renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" onClose={onClose} />);
  return onClose;
};

describe('DownloadModal over the real export call', () => {
  it('409 unverified_claims as the export route sends it → the C12 message with the count, PDF and Word blocked', async () => {
    // routes/resumes.ts sendExport: res.status(409).json({ error, code, details: { count } })
    fetchMock.mockResolvedValue(json(409, { error: 'unverified_claims', code: 'unverified_claims', details: { count: 3 } }));
    const onClose = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("3 lines have numbers or details we couldn't find on your resume.");
    expect(screen.getByRole('button', { name: /^PDF/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^DOCX/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Plain text/ })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    // One request, to the export endpoint, with the format and name preset in the query.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/v1/roboapply/v2/resumes/r1/export');
    expect(url).toContain('format=pdf');
    expect(url).toContain('nameStyle=name_company_role');
    // It is not shown as a generic failure.
    expect(screen.queryByText(/couldn.t download|Download failed/i)).toBeNull();
  });

  it('one unverified detail uses the singular line', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'unverified_claims', code: 'unverified_claims', details: { count: 1 } }));
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /^DOCX/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("One line has a number we couldn't find on your resume. Fix it or remove it before you download.");
  });

  it('any other refusal is a plain download error, and nothing is blocked', async () => {
    fetchMock.mockResolvedValue(json(500, { error: 'internal_error' }));
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).not.toHaveTextContent(/couldn't find on your resume/);
    expect(screen.getByRole('button', { name: /^PDF/ })).toBeEnabled();
  });

  it('a 404 for a tracker entry is not mistaken for unverified details', async () => {
    fetchMock.mockResolvedValue(json(404, { error: 'tracker_entry_not_found', code: 'tracker_entry_not_found' }));
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^DOCX/ })).toBeEnabled();
  });
});

describe('unverifiedClaimsOf: where the count can be', () => {
  const err = (payload: Record<string, unknown>) => new RoboApiError('x', { status: 409, payload });

  it('reads the export route shape (code + details.count)', () => {
    expect(unverifiedClaimsOf(err({ error: 'unverified_claims', code: 'unverified_claims', details: { count: 2 } }))).toBe(2);
  });

  it('reads the tailor-session shape (code + details.pending)', () => {
    expect(unverifiedClaimsOf(err({ success: false, code: 'unverified_claims', details: { pending: 4 } }))).toBe(4);
  });

  it('reads a platform envelope (code conflict + details.reason)', () => {
    expect(unverifiedClaimsOf(err({ success: false, code: 'conflict', details: { reason: 'unverified_claims', count: 5 } }))).toBe(5);
  });

  it('a missing or bad count is 1, never 0 and never invented', () => {
    expect(unverifiedClaimsOf(err({ code: 'unverified_claims' }))).toBe(1);
    expect(unverifiedClaimsOf(err({ code: 'unverified_claims', details: { count: 0 } }))).toBe(1);
    expect(unverifiedClaimsOf(err({ code: 'unverified_claims', details: { count: 'many' } }))).toBe(1);
  });

  it('other errors are not unverified claims', () => {
    expect(unverifiedClaimsOf(err({ code: 'conflict', details: { reason: 'target_changed' } }))).toBeNull();
    expect(unverifiedClaimsOf(err({ error: 'unverified_claims' }))).toBeNull(); // `error` alone is a message, not a code
    expect(unverifiedClaimsOf(new Error('network'))).toBeNull();
    expect(unverifiedClaimsOf(null)).toBeNull();
  });
});
