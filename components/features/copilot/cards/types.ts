// components/features/copilot/cards/types.ts — props every card receives.

import type { CopilotCard } from '../../../../lib/api/contracts/copilot';

export interface CardContext {
  /** Put a question in the composer (never sends it). */
  prefill?: (text: string) => void;
  /** Called before a card navigates away (the rail closes on a phone). */
  onNavigate?: () => void;
}

export interface CardProps {
  card: CopilotCard;
  ctx: CardContext;
}
