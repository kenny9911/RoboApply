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

/** Read a Blob's text (jsdom's Blob has no sync reader). */
class FileReaderSync0 {
  text: Promise<string>;
  constructor(blob: Blob) {
    this.text = new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blob);
    });
  }
}

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
    // The message names the real reason: details of a tailored version that were not checked.
    expect(await screen.findByRole('alert')).toHaveTextContent('3 details in this tailored resume have not been checked yet. Check them in Verify details before you download.');
    expect(screen.getByRole('button', { name: /^PDF/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^DOCX/ })).toBeDisabled();
    // Plain text and Markdown are the same unchecked text: blocked too.
    expect(screen.getByRole('button', { name: /^Plain text/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Markdown/ })).toBeDisabled();
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
    expect(await screen.findByRole('alert')).toHaveTextContent('1 detail in this tailored resume has not been checked yet. Check it in Verify details before you download.');
  });

  it('any other refusal is a plain download error, and nothing is blocked', async () => {
    fetchMock.mockResolvedValue(json(500, { error: 'internal_error' }));
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).not.toHaveTextContent(/not been checked yet/);
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

describe('every format respects the Verify-details block (QA: TXT and MD downloaded the unchecked AI text)', () => {
  const MD = '# Maya Lindqvist\n*maya@example.com · Portland, OR*\n\n## Skills\n\n**Frameworks:** pandas · [docs](https://example.test)\n\n## Experience\n\n### Northwind · Data Analyst · 2022 – Present\n- Built a **weekly** dashboard.\n';
  let saved: Array<{ name: string; text: Promise<string>; type: string }> = [];
  let click: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = [];
    const blobs = new Map<string, Blob>();
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        const id = `blob:${blobs.size}`;
        blobs.set(id, b);
        return id;
      },
      revokeObjectURL: () => undefined,
    }));
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.getAttribute('href') ?? '')!;
      const reader = new FileReaderSync0(blob);
      saved.push({ name: this.download, text: reader.text, type: blob.type });
    });
  });
  afterEach(() => click.mockRestore());

  it('a version with unchecked details downloads nothing in any format, and links to Verify details', () => {
    const onClose = vi.fn();
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown={MD} unverifiedClaims={2} verifyHref="/resume?tailorSession=ts_9" onClose={onClose} />);
    for (const name of [/^PDF/, /^DOCX/, /^Plain text/, /^Markdown/]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(saved).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('2 details in this tailored resume have not been checked yet.');
    expect(screen.getByRole('link', { name: 'Verify details' })).toHaveAttribute('href', '/resume?tailorSession=ts_9');
  });

  it('"Plain text" has no markdown syntax; Markdown is the text as written', async () => {
    const { unmount } = renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown={MD} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Plain text/ }));
    unmount();
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown={MD} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Markdown/ }));
    const [txt, md] = await Promise.all(saved.map(async (f) => ({ ...f, text: await f.text })));
    expect(txt!.name).toBe('Main.txt');
    expect(txt!.text).toBe(
      ['Maya Lindqvist', 'maya@example.com · Portland, OR', '', 'SKILLS', '', 'Frameworks: pandas · docs (https://example.test)', '', 'EXPERIENCE', '', 'Northwind · Data Analyst · 2022 – Present', '- Built a weekly dashboard.', ''].join('\n'),
    );
    expect(txt!.text).not.toMatch(/[#*]|\]\(/);
    expect(md!.name).toBe('Main.md');
    expect(md!.text).toBe(MD);
    expect(txt!.text).not.toBe(md!.text);
  });
});

describe('unfilled placeholders (QA: "[X] products across [n=__] planning periods" was exported with no warning)', () => {
  it('lists the lines and downloads nothing until the user says to download with the blanks', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['%PDF-1.7']), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Main.pdf"' } }));
    renderWithProviders(
      <DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" placeholderLines={['Contributed to inventory forecasting for [X] products across [n=__] planning periods.']} onClose={vi.fn()} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('1 line still has a blank like [X] where your own number goes. Fill it in, or rewrite the line without the number.');
    expect(alert).toHaveTextContent('[X] products across [n=__] planning periods');
    for (const name of [/^PDF/, /^DOCX/, /^Plain text/, /^Markdown/]) expect(screen.getByRole('button', { name })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Download with these blanks left in' }));
    expect(screen.getByRole('button', { name: /^PDF/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^PDF/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('finds the blanks itself when the caller passes no list (the download opened from an application)', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['%PDF-1.7']), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Main.pdf"' } }));
    const md = [
      '# Maya Lindqvist',
      '## Experience',
      '### Northwind · Data Analyst · 2022 – Present',
      '- Contributed to inventory forecasting for [X] products across [n=__] planning periods.',
      '- Built a weekly dashboard, see [the write-up](https://example.com/post).',
      '## Summary',
      '**Analyst** who cut report time by [percent].',
    ].join('\n');
    // Exactly what components/features/tracker/ResumeForApplication.tsx passes.
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown={md} unverifiedClaims={0} aiAssisted={false} trackerEntryId="te_1" onClose={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('2 lines still have a blank like [X] where your own number goes. Fill them in, or rewrite those lines without the numbers.');
    // The lines as text: no bullet mark, no bold marks; a markdown link is not a blank.
    const items = Array.from(alert.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toEqual(['Contributed to inventory forecasting for [X] products across [n=__] planning periods.', 'Analyst who cut report time by [percent].']);
    for (const name of [/^PDF/, /^DOCX/, /^Plain text/, /^Markdown/]) expect(screen.getByRole('button', { name })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^DOCX/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Download with these blanks left in' }));
    fireEvent.click(screen.getByRole('button', { name: /^DOCX/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('a resume with no blanks shows no warning and holds nothing', () => {
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown={'# A\n- Built a dashboard, see [the write-up](https://example.com).'} onClose={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /^PDF/ })).toBeEnabled();
  });

  it('unchecked details are never overridden by the placeholder tick', () => {
    renderWithProviders(<DownloadModal resumeId="r1" resumeName="Main" resumeMarkdown="# A" unverifiedClaims={1} placeholderLines={['[X] users']} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Download with these blanks left in' }));
    for (const name of [/^PDF/, /^DOCX/, /^Plain text/, /^Markdown/]) expect(screen.getByRole('button', { name })).toBeDisabled();
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
