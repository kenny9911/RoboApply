// ImportModal — the upload flow says only true things (QA; D3):
//   - it lists the file types the server reads (it advertised Apple Pages and RTF; RTF answers 415);
//   - nothing is ticked while the file is being read (rows used to tick on a timer);
//   - when done it shows what the saved resume really holds, not a fixed list.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImportModal, RESUME_UPLOAD_FORMATS } from './ImportModal';
import type { RAResumeVariant } from '../../../lib/api/v2/types';

const LABELS = new Proxy({} as Record<string, string>, { get: (_t, key) => `L:${String(key)}` }) as never;
const variant = { id: 'rv_1', name: 'Resume', resumeMarkdown: '# Maya' } as unknown as RAResumeVariant;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderModal(over: Partial<Parameters<typeof ImportModal>[0]> = {}) {
  const props = {
    source: 'file' as const,
    labels: LABELS,
    ingestRows: vi.fn(() => [{ k: 'Template', v: 'One column' }]),
    readingLabel: (file: string) => `Reading ${file}…`,
    doneFacts: vi.fn(() => [
      { k: 'You', v: 'Maya Lindqvist', found: true },
      { k: 'Experience', v: '2 roles', found: true },
      { k: 'Education', v: 'Not found. Add it in the editor.', found: false },
    ]),
    onCreate: vi.fn(() => Promise.resolve(variant)),
    onClose: vi.fn(),
    onDone: vi.fn(),
    ...over,
  };
  const view = render(<ImportModal {...props} />);
  return { ...view, props };
}

function pickFile(container: HTMLElement, name = 'resume.pdf') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'application/pdf' })] } });
}

describe('ImportModal (file upload)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lists exactly the file types the server reads', () => {
    const { container } = renderModal();
    const formats = container.querySelector('.formats')!.textContent!;
    expect(formats.replace(/\s+/g, ' ').trim()).toBe('PDF · DOC · DOCX · TXT · MD');
    expect(formats).not.toMatch(/Pages|RTF/);
    const accept = (container.querySelector('input[type="file"]') as HTMLInputElement).accept;
    for (const f of RESUME_UPLOAD_FORMATS) expect(accept).toContain(`.${f.toLowerCase()}`);
    expect(accept).not.toMatch(/rtf|pages/);
  });

  it('ticks nothing while the file is being read, however long it takes', async () => {
    const pending = deferred<RAResumeVariant>();
    const { container, props } = renderModal({ onCreate: vi.fn(() => pending.promise) });
    pickFile(container);
    fireEvent.click(screen.getByRole('button', { name: /L:parseWithAi/ }));
    expect(props.onCreate).toHaveBeenCalledTimes(1);
    // A scanned PDF can take a minute: still one pending line, no ticked row.
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('status')).toHaveTextContent('Reading resume.pdf…');
    expect(container.querySelectorAll('.ingest-row:not(.pending)')).toHaveLength(0);
    expect(props.ingestRows).not.toHaveBeenCalled();
    expect(screen.queryByText('L:doneTitleImport')).toBeNull();

    await act(async () => pending.resolve(variant));
    expect(screen.getByText('L:doneTitleImport')).toBeInTheDocument();
    // What was really read, from the saved resume.
    expect(props.doneFacts).toHaveBeenCalledWith(variant);
    const facts = screen.getByTestId('import-facts');
    expect(facts).toHaveTextContent('Maya Lindqvist');
    expect(facts).toHaveTextContent('2 roles');
    expect(facts.querySelectorAll('[data-found="false"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /L:openEditor/ }));
    expect(props.onDone).toHaveBeenCalledWith(variant);
  });

  it('a failed read shows the error and never a success', async () => {
    const { container } = renderModal({ onCreate: vi.fn(() => Promise.reject(Object.assign(new Error('x'), { payload: { code: 'unsupported_format' } }))), errorMessages: { unsupported_format: 'That file type cannot be read.' } });
    pickFile(container, 'resume.rtf');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /L:parseWithAi/ }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('That file type cannot be read.');
    expect(screen.queryByText('L:doneTitleImport')).toBeNull();
  });

  it('a new draft from a template still shows what the template is, and finishes only once created', async () => {
    const pending = deferred<RAResumeVariant>();
    const { props } = renderModal({ source: 'scratch', onCreate: vi.fn(() => pending.promise) });
    fireEvent.click(screen.getByRole('button', { name: /L:createDraft/ }));
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(props.ingestRows).toHaveBeenCalled();
    expect(screen.getByText('One column')).toBeInTheDocument();
    expect(screen.queryByText('L:doneTitleScratch')).toBeNull();
    await act(async () => pending.resolve(variant));
    expect(screen.getByText('L:doneTitleScratch')).toBeInTheDocument();
    expect(screen.queryByTestId('import-facts')).toBeNull();
  });
});
