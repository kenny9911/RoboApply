// components/features/copilot/cards/types.ts — props every card receives.

import type { CopilotCard } from '../../../../lib/api/contracts/copilot';

export interface CardContext {
  /** Put a question in the composer (never sends it). */
  prefill?: (text: string) => void;
  /** Called before a card navigates away (the rail closes on a phone). */
  onNavigate?: () => void;
  /**
   * Where the answer this card belongs to stands, when that limits the card:
   * `streaming` — still being written (a suggestion can be used once it is
   * finished and stored); `unsaved` — the answer could not be stored
   * (`save_failed`), so its suggestions cannot be used at all (the server
   * refuses them too). Absent for a stored answer.
   */
  turn?: 'streaming' | 'unsaved';
  /**
   * Read the thread's stored cards again. A card calls it when the server says
   * its suggestion was already applied by an earlier click: what that click
   * left in the thread (the result card with its link) then shows up.
   */
  refresh?: () => void;
}

export interface CardProps {
  card: CopilotCard;
  ctx: CardContext;
}
