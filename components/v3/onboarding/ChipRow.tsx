'use client';

// ChipRow — the suggestion strip under the latest assistant message.
// Two kinds of taps:
//   • suggestion chips: plain strings, send-on-tap as the message text;
//   • quick-replies (OptionPill): closed-set options carrying a MACHINE id —
//     the tap sends `{ message: label, quickReplyId: id }` so the server
//     handles the choice deterministically (no LLM laundering of an enum;
//     design-review fix E10). The localized label is what lands in the
//     transcript.

import { OptionPill } from '../../ui/OptionPill';
import type { RAOnboardingQuickReply } from '../../../lib/api/v2/types';

interface Props {
  chips: string[];
  quickReplies: RAOnboardingQuickReply[];
  disabled?: boolean;
  /** Suggestion chip tap — send the text as the user message. */
  onChip: (text: string) => void;
  /** Quick-reply tap — the full option (machine id + localized label). */
  onQuickReply: (option: RAOnboardingQuickReply) => void;
}

export function ChipRow({
  chips,
  quickReplies,
  disabled = false,
  onChip,
  onQuickReply,
}: Props) {
  if (chips.length === 0 && quickReplies.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {quickReplies.length > 0 ? (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
          role="group"
          data-testid="onboarding-quick-replies"
        >
          {quickReplies.map((option) => (
            <OptionPill
              key={option.id}
              label={option.label}
              radio={false}
              className="!w-auto"
              onClick={() => {
                if (!disabled) onQuickReply(option);
              }}
            />
          ))}
        </div>
      ) : null}

      {chips.length > 0 ? (
        <div className="chips" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
          {chips.map((text) => (
            <button
              key={text}
              type="button"
              className="chip"
              disabled={disabled}
              onClick={() => onChip(text)}
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
