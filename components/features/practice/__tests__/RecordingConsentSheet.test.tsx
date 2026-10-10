// RecordingConsentSheet (WP-43, H8): unticked by default, server prose,
// a second opt-in for video, grants recorded before the choice is returned.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { RecordingConsentSheet } from '../RecordingConsentSheet';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';

const m = vi.hoisted(() => ({ getConsents: vi.fn(), recordConsent: vi.fn() }));
vi.mock('../../../../lib/api/compliance', () => ({ getConsents: m.getConsents, recordConsent: m.recordConsent }));

function item(type: string, prose: string, granted: boolean | null = null) {
  return {
    type, required: false, stage: 'in_context', control: 'toggle', withdrawable: true, onWithdraw: 'none',
    defaultGranted: false, prose, proseVersion: 'v1', proseHash: 'h', proseLocale: 'en', granted, answeredAt: null,
  };
}
const AUDIO = 'Keep the audio and transcript of my practice interviews.';
const VIDEO = 'Also keep the video of my practice interviews.';

beforeEach(() => {
  vi.clearAllMocks();
  m.getConsents.mockResolvedValue({ items: [item('interview_recording', AUDIO), item('interview_video', VIDEO)] });
  m.recordConsent.mockResolvedValue({});
});

function open(mode: 'voice' | 'video' = 'video', initial?: { audio: boolean; video: boolean }) {
  const onConfirm = vi.fn();
  renderWithProviders(
    <RecordingConsentSheet open mode={mode} initial={initial} onClose={vi.fn()} onConfirm={onConfirm} />,
  );
  return onConfirm;
}

describe('RecordingConsentSheet', () => {
  it('shows the server prose with every box unticked; the video box waits for the first', async () => {
    open('video');
    const audio = (await screen.findByRole('checkbox', { name: AUDIO })) as HTMLInputElement;
    const video = screen.getByRole('checkbox', { name: new RegExp(VIDEO) }) as HTMLInputElement;
    expect(audio.checked).toBe(false);
    expect(video.checked).toBe(false);
    expect(video.disabled).toBe(true);
    fireEvent.click(audio);
    expect(video.disabled).toBe(false);
  });

  it('records the audio grant with the shown prose version, then confirms audio only', async () => {
    const onConfirm = open('video');
    fireEvent.click(await screen.findByRole('checkbox', { name: AUDIO }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ audio: true, video: false }));
    expect(m.recordConsent).toHaveBeenCalledTimes(1);
    expect(m.recordConsent).toHaveBeenCalledWith({ type: 'interview_recording', granted: true, proseVersion: 'v1', locale: 'en' });
  });

  it('records both grants for audio and video', async () => {
    const onConfirm = open('video');
    fireEvent.click(await screen.findByRole('checkbox', { name: AUDIO }));
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(VIDEO) }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ audio: true, video: true }));
    expect(m.recordConsent.mock.calls.map((c) => c[0].type)).toEqual(['interview_recording', 'interview_video']);
  });

  it('does not re-record a standing grant', async () => {
    m.getConsents.mockResolvedValue({ items: [item('interview_recording', AUDIO, true)] });
    const onConfirm = open('voice');
    fireEvent.click(await screen.findByRole('checkbox', { name: AUDIO }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ audio: true, video: false }));
    expect(m.recordConsent).not.toHaveBeenCalled();
    expect(screen.getByText('This is a voice practice, so there is no video to keep.')).toBeTruthy();
  });

  it('without a video consent in the catalog, video practice keeps audio only', async () => {
    m.getConsents.mockResolvedValue({ items: [item('interview_recording', AUDIO)] });
    open('video');
    await screen.findByRole('checkbox', { name: AUDIO });
    expect(screen.getByText('Only audio can be kept. Video is never recorded.')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('a failed save shows an error and confirms nothing', async () => {
    m.recordConsent.mockRejectedValue(new Error('409'));
    const onConfirm = open('voice');
    fireEvent.click(await screen.findByRole('checkbox', { name: AUDIO }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Your choice wasn't saved. Try again.");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('when the consent text cannot load, recording stays off', async () => {
    m.getConsents.mockRejectedValue(new Error('down'));
    const onConfirm = open('voice');
    expect(await screen.findByText("The consent text couldn't be loaded, so recording stays off.")).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save my choice' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep recording off' }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false, video: false });
  });
});
