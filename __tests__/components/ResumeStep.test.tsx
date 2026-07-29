// ResumeStep — step 1 of setup. Four doors, and the two that were broken.
//
// Replaces the coverage that lived around `UploadStep` / `ResumeSelectPanel`.
// Two of these cases are regression guards for shipped bugs:
//
//   • the drop zone was a <label> wrapping an <input>. Its copy said "Drop your
//     resume here" and dropping did nothing at all.
//   • paste called POST /v2/resumes, which stores markdown and no parsedData —
//     so the deterministic seed had nothing to read and step 2 rendered empty
//     for everyone who pasted. Paste now goes through the UPLOAD path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { ResumeStep } from '../../components/v3/setup/ResumeStep';

const uploadMutate = vi.fn();
const createMutate = vi.fn();
const linkedInMutate = vi.fn();
let variants: Array<Record<string, unknown>> = [];
let linkedInEnabled = false;

vi.mock('../../hooks/useResumes', () => ({
  useResumeList: () => ({ data: { resumes: variants }, isSuccess: true }),
  useLinkedInImportConfig: () => ({
    data: { urlImportEnabled: linkedInEnabled },
  }),
  useUploadResumeMutation: () => ({
    mutateAsync: uploadMutate,
    isPending: false,
  }),
  useCreateResumeMutation: () => ({
    mutateAsync: createMutate,
    isPending: false,
  }),
  useImportLinkedInMutation: () => ({
    mutateAsync: linkedInMutate,
    isPending: false,
  }),
}));

function renderStep(overrides: Partial<Parameters<typeof ResumeStep>[0]> = {}) {
  const onReady = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <ResumeStep onReady={onReady} onClose={onClose} {...overrides} />,
  );
  return { onReady, onClose };
}

function pdf(name = 'cv.pdf', size = 1024): File {
  const file = new File(['%PDF-1.4'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  variants = [];
  linkedInEnabled = false;
  uploadMutate.mockResolvedValue({ id: 'rv_new' });
});

describe('ResumeStep', () => {
  it('accepts a DROPPED file, not just a browsed one', async () => {
    const { onReady } = renderStep();
    const zone = screen.getByRole('button', { name: /drop your resume here/i });
    const file = pdf();
    fireEvent.dragEnter(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(uploadMutate).toHaveBeenCalledTimes(1));
    expect(uploadMutate.mock.calls[0][0].file).toBe(file);
    await waitFor(() => expect(onReady).toHaveBeenCalledWith('rv_new'));
  });

  it('routes PASTED text through the upload path, as a text file', async () => {
    const { onReady } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /paste the text instead/i }));
    fireEvent.change(screen.getByLabelText(/paste the text instead/i), {
      target: { value: '# Ada Lovelace\nAnalytical Engine, 1843' },
    });
    fireEvent.click(screen.getByRole('button', { name: /use this text/i }));

    await waitFor(() => expect(uploadMutate).toHaveBeenCalledTimes(1));
    // POST /v2/resumes would have produced a variant with no parsedData.
    expect(createMutate).not.toHaveBeenCalled();
    const arg = uploadMutate.mock.calls[0][0];
    expect(arg.file).toBeInstanceOf(File);
    expect(arg.file.type).toBe('text/plain');
    // The markdown H1 is almost always the person's name — a better variant
    // name than "Pasted resume", and free.
    expect(arg.name).toBe('Ada Lovelace');
    await waitFor(() => expect(onReady).toHaveBeenCalledWith('rv_new'));
  });

  it('rejects an oversize file before any bytes move', async () => {
    renderStep();
    const zone = screen.getByRole('button', { name: /drop your resume here/i });
    fireEvent.drop(zone, { dataTransfer: { files: [pdf('huge.pdf', 20 * 1024 * 1024)] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/over 15 MB/i);
    expect(uploadMutate).not.toHaveBeenCalled();
  });

  it('names the real format list when the file is not one of them', async () => {
    renderStep();
    const zone = screen.getByRole('button', { name: /drop your resume here/i });
    fireEvent.drop(zone, { dataTransfer: { files: [pdf('resume.rtf')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/PDF, DOC, DOCX, TXT, and MD/i);
    expect(uploadMutate).not.toHaveBeenCalled();
  });

  it('opens the paste field inline when the file had no text in it', async () => {
    // A scanned PDF. "Try another file" is not the fix — the same scan fails
    // the same way — so the actual recovery opens underneath the message.
    uploadMutate.mockRejectedValueOnce(
      Object.assign(new Error('empty'), { payload: { code: 'empty_text' } }),
    );
    renderStep();
    const zone = screen.getByRole('button', { name: /drop your resume here/i });
    fireEvent.drop(zone, { dataTransfer: { files: [pdf('scan.pdf')] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/may be a scan/i);
    await waitFor(() =>
      expect(screen.getByLabelText(/paste the text instead/i)).toBeInTheDocument(),
    );
  });

  it('never offers "use a resume you already have" on a genuine first run', () => {
    renderStep();
    expect(screen.queryByText(/use a resume you already have/i)).not.toBeInTheDocument();
  });

  it('offers the existing variants once the account has one', async () => {
    variants = [
      {
        id: 'rv_old',
        name: 'Master Resume',
        isPrimary: true,
        lastEditedAt: '2026-07-01T00:00:00.000Z',
      },
    ];
    const { onReady } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Master Resume/ }));
    await waitFor(() => expect(onReady).toHaveBeenCalledWith('rv_old'));
  });

  it('hides the LinkedIn door when the deployment has not enabled it', () => {
    renderStep();
    expect(
      screen.queryByRole('button', { name: /import from linkedin/i }),
    ).not.toBeInTheDocument();
  });

  it('can always be closed — nobody is trapped on step 1', () => {
    const { onClose } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('says what happens to the document', () => {
    renderStep();
    expect(screen.getByText(/never shown to an employer/i)).toBeInTheDocument();
  });
});

describe('ResumeStep — keyboard and screen reader', () => {
  it('keeps the hidden file input out of the tab order', () => {
    renderStep();
    const input = document.querySelector('input[type="file"]');
    // `.sr-only` is a clip, not display:none — the input stayed focusable, so a
    // keyboard user hit an invisible tab stop right after the drop zone and
    // could not see where focus had gone. display:none is not the fix either:
    // iOS Safari will not open the picker for one.
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('aria-hidden', 'true');
  });

  it('puts the caret in the paste field it opens for a scanned PDF', async () => {
    uploadMutate.mockRejectedValueOnce(
      Object.assign(new Error('empty'), { payload: { code: 'empty_text' } }),
    );
    renderStep();
    fireEvent.drop(screen.getByRole('button', { name: /drop your resume here/i }), {
      dataTransfer: { files: [pdf('scan.pdf')] },
    });

    const textarea = await screen.findByLabelText(/paste the text instead/i);
    // Focusing in the same tick as the state change focused a textarea React
    // had not mounted yet, so the recovery only ever worked with a mouse.
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it('focuses the paste field when the door is opened by tap too', async () => {
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /paste the text instead/i }));
    const textarea = await screen.findByLabelText(/paste the text instead/i);
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it('announces that the file was accepted', async () => {
    renderStep();
    fireEvent.drop(screen.getByRole('button', { name: /drop your resume here/i }), {
      dataTransfer: { files: [pdf('cv.pdf')] },
    });
    // The visible confirmation sits inside role="button", whose children are
    // presentational — so nothing was announced at all.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/cv\.pdf/),
    );
  });
});
