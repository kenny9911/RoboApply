// The resume editor saves only what the user changed.
//
// Opening an uploaded resume used to save it straight away: the stored text is
// in the upload format, the editor's serializer writes another, and "changed"
// was measured as text difference. (QA: lastEditedAt moved 8 s after opening
// the editor with no input; the header showed "Saving…".)

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_AUTOSAVE_MS, EDITOR_RETRY_MS, useEditorAutosave } from './useEditorAutosave';
import { serializeResumeMarkdown } from '../../lib/resumeStructure';

// The upload format (server parsedResumeToMarkdown): not what the serializer writes.
const UPLOAD = [
  '# Maya Lindqvist',
  '',
  'maya.lindqvist@example.com · (555) 010-0142 · Portland, OR',
  '',
  '## Skills',
  '',
  '**Technical:** SQL · Python',
  '**Tools:** Zendesk · Jira',
  '',
  '## Experience',
  '',
  '**Data Analyst — Northwind Freight** · June 2022 – Present · Portland, OR',
  '- Built a weekly on-time delivery dashboard in Tableau used by 12 dispatch managers.',
  '',
  '## Education',
  '',
  '**Oregon State University · 2020** — B.S., Statistics',
].join('\n');

describe('useEditorAutosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not save a resume that was only opened, however often the query refetches', async () => {
    const save = vi.fn(async (_markdown: string) => undefined);
    const { result, rerender } = renderHook(({ resume }) => useEditorAutosave(resume, save), {
      initialProps: { resume: { id: 'rv_1', resumeMarkdown: UPLOAD } },
    });
    expect(result.current.structured?.experiences[0]).toMatchObject({ title: 'Data Analyst', company: 'Northwind Freight' });
    // The stored text is not what the serializer writes — the old "is it different?" test.
    expect(serializeResumeMarkdown(result.current.structured!)).not.toBe(UPLOAD);

    await act(async () => void vi.advanceTimersByTime(8000));
    // A refetch hands back a new object with the same content (layout save, window focus).
    rerender({ resume: { id: 'rv_1', resumeMarkdown: UPLOAD } });
    rerender({ resume: { id: 'rv_1', resumeMarkdown: UPLOAD } });
    await act(async () => void vi.advanceTimersByTime(8000));

    expect(save).not.toHaveBeenCalled();
    expect(result.current.saveState).toBe('idle');
    expect(result.current.hydrations).toBe(1);
  });

  it('saves once, debounced, after a user edit, and ignores its own echo', async () => {
    const save = vi.fn(async (_markdown: string) => undefined);
    const { result, rerender } = renderHook(({ resume }) => useEditorAutosave(resume, save), {
      initialProps: { resume: { id: 'rv_1', resumeMarkdown: UPLOAD } },
    });
    act(() => result.current.setStructured((cur) => (cur ? { ...cur, summary: 'Analyst.' } : cur)));
    expect(result.current.saveState).toBe('saving');
    expect(save).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(EDITOR_AUTOSAVE_MS));

    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0]![0];
    expect(sent).toContain('## Summary\n\nAnalyst.');
    expect(sent).toContain('**Tools:** Zendesk · Jira');
    expect(sent).toContain('### Northwind Freight · Data Analyst · June 2022 – Present');
    expect(result.current.saveState).toBe('saved');

    // The PATCH response lands in the cache: same text, no re-hydration, no second save.
    const before = result.current.structured;
    rerender({ resume: { id: 'rv_1', resumeMarkdown: sent } });
    await act(async () => void vi.advanceTimersByTime(8000));
    expect(result.current.structured).toBe(before);
    expect(result.current.hydrations).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('an edit undone before the save fires saves nothing', async () => {
    const save = vi.fn(async (_markdown: string) => undefined);
    const { result } = renderHook(() => useEditorAutosave({ id: 'rv_1', resumeMarkdown: UPLOAD }, save));
    const original = result.current.structured!;
    act(() => result.current.setStructured({ ...original, summary: 'x' }));
    act(() => result.current.setStructured({ ...original }));
    await act(async () => void vi.advanceTimersByTime(8000));
    expect(save).not.toHaveBeenCalled();
    expect(result.current.saveState).toBe('idle');
  });

  it('a failed save is reported and the edit stays unsaved', async () => {
    const save = vi.fn(async (_markdown: string) => {
      throw new Error('offline');
    });
    const { result, rerender } = renderHook(({ resume }) => useEditorAutosave(resume, save), {
      initialProps: { resume: { id: 'rv_1', resumeMarkdown: UPLOAD } },
    });
    act(() => result.current.setStructured((cur) => (cur ? { ...cur, summary: 'Analyst.' } : cur)));
    await act(async () => void vi.advanceTimersByTime(EDITOR_AUTOSAVE_MS));
    expect(result.current.saveState).toBe('error');
    // A refetch must not throw the unsaved edit away.
    rerender({ resume: { id: 'rv_1', resumeMarkdown: `${UPLOAD}\n` } });
    expect(result.current.structured?.summary).toBe('Analyst.');
  });

  it('a failed save is tried again without another edit, and ends saved', async () => {
    const save = vi
      .fn(async (_markdown: string) => undefined)
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('502'));
    const { result } = renderHook(() => useEditorAutosave({ id: 'rv_1', resumeMarkdown: UPLOAD }, save));
    act(() => result.current.setStructured((cur) => (cur ? { ...cur, summary: 'Analyst.' } : cur)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_MS)));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.saveState).toBe('error');

    // Nobody types. First retry after the backoff, and not before.
    await act(async () => void (await vi.advanceTimersByTimeAsync(EDITOR_RETRY_MS - 1)));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(save).toHaveBeenCalledTimes(2);
    // Still failing: the header keeps "not saved yet", and the wait doubles.
    expect(result.current.saveState).toBe('error');
    await act(async () => void (await vi.advanceTimersByTimeAsync(EDITOR_RETRY_MS * 2 - 1)));
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2]![0]).toContain('## Summary\n\nAnalyst.');
    expect(result.current.saveState).toBe('saved');

    // Saved: nothing more is sent.
    await act(async () => void (await vi.advanceTimersByTimeAsync(120000)));
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('an edit during the retry wait replaces the retry with one fresh save', async () => {
    const save = vi.fn(async (_markdown: string) => undefined).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useEditorAutosave({ id: 'rv_1', resumeMarkdown: UPLOAD }, save));
    act(() => result.current.setStructured((cur) => (cur ? { ...cur, summary: 'Analyst.' } : cur)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_MS)));
    expect(result.current.saveState).toBe('error');
    act(() => result.current.setStructured((cur) => (cur ? { ...cur, summary: 'Data analyst.' } : cur)));
    expect(result.current.saveState).toBe('saving');
    await act(async () => void (await vi.advanceTimersByTimeAsync(60000)));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toContain('Data analyst.');
    expect(result.current.saveState).toBe('saved');
  });

  it('stops retrying when the editor is closed', async () => {
    const save = vi.fn(async (_markdown: string) => {
      throw new Error('offline');
    });
    const { result, unmount } = renderHook(() => useEditorAutosave({ id: 'rv_1', resumeMarkdown: UPLOAD }, save));
    act(() => result.current.setStructured((cur) => (cur ? { ...cur, summary: 'Analyst.' } : cur)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_MS)));
    expect(save).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(120000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('hydrates again for another resume or a real external change', () => {
    const save = vi.fn(async (_markdown: string) => undefined);
    const { result, rerender } = renderHook(({ resume }) => useEditorAutosave(resume, save), {
      initialProps: { resume: { id: 'rv_1', resumeMarkdown: UPLOAD } },
    });
    rerender({ resume: { id: 'rv_1', resumeMarkdown: UPLOAD.replace('Data Analyst', 'Senior Analyst') } });
    expect(result.current.structured?.experiences[0]?.title).toBe('Senior Analyst');
    rerender({ resume: { id: 'rv_2', resumeMarkdown: '# Other\n' } });
    expect(result.current.structured?.contact.fullName).toBe('Other');
    expect(result.current.hydrations).toBe(3);
  });
});
