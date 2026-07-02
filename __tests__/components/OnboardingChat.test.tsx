// OnboardingChat — composer/send guards during the bootstrap window (no
// sessionId yet) and the non-retryable terminal-session error notices.
// The chat prop is a hand-built UseOnboardingChatReturn fake so each case
// pins the exact state under test (no stream plumbing).

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { OnboardingChat } from '../../components/v3/onboarding/OnboardingChat';
import {
  createInitialChatState,
  type OnboardingChatState,
  type UseOnboardingChatReturn,
} from '../../hooks/useOnboardingChat';

function buildChat(
  overrides: Partial<OnboardingChatState> = {},
): UseOnboardingChatReturn & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    state: { ...createInitialChatState(), ...overrides },
    sendMessage: vi.fn(async () => {}),
    seedFromBootstrap: vi.fn(),
    hydrateFromSession: vi.fn(),
  };
}

function renderChat(chat: UseOnboardingChatReturn) {
  return renderWithProviders(
    <OnboardingChat
      chat={chat}
      ingestRows={null}
      openingPrompt={null}
      onComplete={vi.fn()}
      completing={false}
    />,
  );
}

describe('OnboardingChat — no-session guard (bootstrap in flight)', () => {
  it('Send is disabled and Enter neither clears the composer nor dispatches', () => {
    const chat = buildChat(); // sessionId: null
    renderChat(chat);

    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'I want remote PM roles' } });

    const send = screen.getByRole('button', { name: /Send/i });
    expect(send).toBeDisabled();

    fireEvent.click(send);
    fireEvent.keyDown(composer, { key: 'Enter' });

    // The typed text survives — never silently destroyed pre-session.
    expect(composer.value).toBe('I want remote PM roles');
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('suggestion chips are disabled while there is no session', () => {
    const chat = buildChat({ chips: ['Show me jobs now'] });
    renderChat(chat);

    const chip = screen.getByRole('button', { name: 'Show me jobs now' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('with a session, Send dispatches and clears the composer', () => {
    const chat = buildChat({ sessionId: 'sess_1' });
    renderChat(chat);

    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'I want remote PM roles' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    expect(chat.sendMessage).toHaveBeenCalledWith('I want remote PM roles');
    expect(composer.value).toBe('');
  });
});

describe('OnboardingChat — terminal-session error notices', () => {
  it.each(['session_superseded', 'session_not_active'])(
    '%s shows the superseded notice without a Retry button',
    (code) => {
      const chat = buildChat({
        sessionId: 'sess_1',
        items: [{ kind: 'user', content: 'hello' }],
        error: { code, message: 'terminal' },
      });
      renderChat(chat);

      expect(screen.getByRole('alert')).toHaveTextContent(/another window/i);
      expect(
        screen.queryByRole('button', { name: /Retry/i }),
      ).not.toBeInTheDocument();
    },
  );

  it('turn_failed keeps the retryable path', () => {
    const chat = buildChat({
      sessionId: 'sess_1',
      items: [{ kind: 'user', content: 'hello' }],
      error: { code: 'turn_failed', message: 'boom' },
    });
    renderChat(chat);

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(chat.sendMessage).toHaveBeenCalledWith('hello');
  });
});
