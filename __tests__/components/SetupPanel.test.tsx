// SetupPanel — the two-step container.
//
// The cases here are the ones that decide whether setup is a wall or a panel:
//
//   • the auto-open counter is spent on an AUTOMATIC open and never on a tap,
//     and it is reported for BOTH steps — including the no-resume state, which
//     is the one the cap exists to protect. Counting on bootstrap instead
//     could not work: bootstrap needs a resumeVariantId a no-resume user does
//     not have, so that panel would reopen forever.
//   • step 1 → reading → step 2 happens in place, with the ingest rows as the
//     bridge rather than a spinner.
//   • opening straight at step 2 restores an interrupted session before it
//     spends a new one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';
import { SetupPanel } from '../../components/v3/setup/SetupPanel';
import type { OnboardingSetupState } from '../../lib/api/v2/types';

// The real provider fires GET /auth/me on mount. `useSetup` calls
// `refresh()` after confirm / skip / seen so `onboardingState` reflects the
// write; the fixture just records that it happened.
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));

const bootstrap = vi.fn();
const getSession = vi.fn();
const confirm = vi.fn();
const skip = vi.fn();
const seen = vi.fn();

vi.mock('../../lib/api/v2', () => ({
  raV2Api: {
    onboarding: {
      bootstrap: (...args: unknown[]) => bootstrap(...args),
      getSession: (...args: unknown[]) => getSession(...args),
      confirm: (...args: unknown[]) => confirm(...args),
      skip: (...args: unknown[]) => skip(...args),
      seen: (...args: unknown[]) => seen(...args),
    },
    preferences: { get: vi.fn() },
    resumes: { list: vi.fn() },
  },
}));

const uploadMutate = vi.fn();
vi.mock('../../hooks/useResumes', () => ({
  resumeKeys: { all: ['v2', 'resumes'] },
  useResumeList: () => ({ data: { resumes: [] }, isSuccess: true }),
  useLinkedInImportConfig: () => ({ data: { urlImportEnabled: false } }),
  useUploadResumeMutation: () => ({ mutateAsync: uploadMutate, isPending: false }),
  useCreateResumeMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useImportLinkedInMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const SESSION: OnboardingSetupState = {
  sessionId: 'obs_1',
  returning: false,
  resumeVariant: { id: 'rv_1', name: 'Master Resume' },
  ingestRows: [
    { id: 'r1', kind: 'identity', label: 'Name', value: 'Ada Lovelace' },
  ],
  draft: { targetRoles: ['Senior Product Manager'] },
  fieldMeta: { targetRoles: { source: 'resume', confidence: 0.8 } },
  proposedFields: [],
  evidence: { roles: ['Senior Product Manager'], years: 8 },
  thin: false,
  enrichmentPending: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  bootstrap.mockResolvedValue(SESSION);
  getSession.mockRejectedValue(
    Object.assign(new Error('none'), { code: 'not_found', payload: { code: 'no_active_session' } }),
  );
  confirm.mockResolvedValue({ goal: {}, preferences: {}, capturedFromNotes: [] });
  skip.mockResolvedValue({ skipped: true });
  seen.mockResolvedValue({ autoOpens: 1 });
  uploadMutate.mockResolvedValue({ id: 'rv_1' });
});

describe('SetupPanel', () => {
  it('reports an automatic open for the no-resume step too', async () => {
    renderWithProviders(
      <SetupPanel initialStep="resume" auto onClose={() => {}} />,
    );
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ step: 'resume' }));
  });

  it('never spends a free showing on a tap-opened panel', async () => {
    renderWithProviders(
      <SetupPanel initialStep="resume" auto={false} onClose={() => {}} />,
    );
    await screen.findByRole('button', { name: /drop your resume here/i });
    expect(seen).not.toHaveBeenCalled();
  });

  it('swaps step 1 → reading → step 2 in place after a resume lands', async () => {
    renderWithProviders(
      <SetupPanel initialStep="resume" onClose={() => {}} />,
    );
    const zone = await screen.findByRole('button', { name: /drop your resume here/i });
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() => expect(bootstrap).toHaveBeenCalledWith({ resumeVariantId: 'rv_1' }));
    // The evidence, not a spinner: the ingest rows are what justify the prefill.
    expect(await screen.findByText('What your resume says')).toBeInTheDocument();
    expect(await screen.findByText('Senior Product Manager')).toBeInTheDocument();
  });

  it('restores an interrupted session before starting a new one', async () => {
    getSession.mockResolvedValueOnce({ ...SESSION, returning: true });
    renderWithProviders(
      <SetupPanel initialStep="confirm" resumeVariantId="rv_1" onClose={() => {}} />,
    );
    expect(await screen.findByText(/picked up where you left off/i)).toBeInTheDocument();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('bootstraps against the primary variant when there is nothing to restore', async () => {
    renderWithProviders(
      <SetupPanel initialStep="confirm" resumeVariantId="rv_1" onClose={() => {}} />,
    );
    await waitFor(() => expect(bootstrap).toHaveBeenCalledWith({ resumeVariantId: 'rv_1' }));
    expect(await screen.findByText(/here is what your resume says/i)).toBeInTheDocument();
  });

  it('submits the COMPLETE post-edit draft, including a removal', async () => {
    const onDone = vi.fn();
    renderWithProviders(
      <SetupPanel
        initialStep="confirm"
        resumeVariantId="rv_1"
        onClose={() => {}}
        onDone={onDone}
      />,
    );
    await screen.findByText('Senior Product Manager');
    fireEvent.click(screen.getByRole('button', { name: /remove Senior Product Manager/i }));
    fireEvent.click(screen.getByRole('button', { name: /show me the jobs/i }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const body = confirm.mock.calls[0][0];
    expect(body.sessionId).toBe('obs_1');
    // `[]`, not an absent key: an absent key would leave the seed in place and
    // the removed title would come back.
    expect(body.draft.targetRoles).toEqual([]);
    // Blank notes cost zero tokens, so the key is omitted entirely.
    expect(body.freeText).toBeUndefined();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('sends the notes line only when the user wrote one', async () => {
    renderWithProviders(
      <SetupPanel initialStep="confirm" resumeVariantId="rv_1" onClose={() => {}} />,
    );
    await screen.findByText('Senior Product Manager');
    fireEvent.change(screen.getByLabelText(/anything else that matters/i), {
      target: { value: 'no agencies' },
    });
    fireEvent.click(screen.getByRole('button', { name: /show me the jobs/i }));
    await waitFor(() => expect(confirm.mock.calls[0][0].freeText).toBe('no agencies'));
  });

  it('closes on skip even if the skip call fails', async () => {
    skip.mockRejectedValueOnce(new Error('offline'));
    const onClose = vi.fn();
    renderWithProviders(
      <SetupPanel
        initialStep="confirm"
        resumeVariantId="rv_1"
        onClose={onClose}
        onDone={() => {}}
      />,
    );
    await screen.findByText('Senior Product Manager');
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('does not claim the rest of the page is inert', async () => {
    renderWithProviders(<SetupPanel initialStep="resume" onClose={() => {}} />);
    const panel = await screen.findByRole('region', {
      name: /tell us what you're looking for/i,
    });
    // The shell behind it — sign out, settings, every other destination — is
    // live. `aria-modal` here would be a lie to a screen reader.
    expect(panel).not.toHaveAttribute('aria-modal');
  });
});
