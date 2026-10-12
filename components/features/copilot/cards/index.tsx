'use client';

// components/features/copilot/cards — one component per card type
// (ARCHITECTURE.md §5.4; F-ORION-12). `CopilotCardView` picks the component
// by `card.type`; an unknown type (the server shipping ahead of the client)
// or data that does not parse renders NOTHING. A render error inside one card
// (a server shape the parsers did not foresee) is contained by CardBoundary:
// that card renders nothing and the rest of the conversation stays.
//
// A suggestion (a card with a `proposalId`) of an answer that could not be
// stored (`ctx.turn === 'unsaved'`) is replaced by one plain line: the answer
// is not in the chat, so nothing it suggested can be used.

import { Component as ReactComponent, type ComponentType, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import type { CardType, CopilotCard } from '../../../../lib/api/contracts/copilot';
import { ActionCard } from './ActionCard';
import { ApplicationsCard } from './ApplicationsCard';
import { CampusDeadlinesCard } from './CampusDeadlinesCard';
import { CompanyCard } from './CompanyCard';
import { CompetitivenessCard } from './CompetitivenessCard';
import { ContactsCard } from './ContactsCard';
import { CoverLetterCard } from './CoverLetterCard';
import { CreditActionCard } from './CreditActionCard';
import { FilterDiffCard } from './FilterDiffCard';
import { FiltersCard } from './FiltersCard';
import { FitAnalysisCard } from './FitAnalysisCard';
import { InterviewPlanCard } from './InterviewPlanCard';
import { JobImportedCard } from './JobImportedCard';
import { JobListCard } from './JobListCard';
import { MemoryAddCard } from './MemoryAddCard';
import { NoticeCard } from './NoticeCard';
import { ProfileGapsCard } from './ProfileGapsCard';
import { ResumeTipsCard } from './ResumeTipsCard';
import { RewriteReadyCard } from './RewriteReadyCard';
import { SalaryCard } from './SalaryCard';
import { TailorReadyCard } from './TailorReadyCard';
import { CardFrame } from './CardFrame';
import type { CardContext, CardProps } from './types';
import styles from '../copilot.module.css';

export const CARD_COMPONENTS: Record<CardType, ComponentType<CardProps>> = {
  job_list: JobListCard,
  filters: FiltersCard,
  filter_diff: FilterDiffCard,
  fit_analysis: FitAnalysisCard,
  company: CompanyCard,
  contacts: ContactsCard,
  credit_action: CreditActionCard,
  tailor_ready: TailorReadyCard,
  cover_letter: CoverLetterCard,
  interview_plan: InterviewPlanCard,
  salary: SalaryCard,
  applications: ApplicationsCard,
  job_imported: JobImportedCard,
  memory_add: MemoryAddCard,
  profile_gaps: ProfileGapsCard,
  action: ActionCard,
  notice: NoticeCard,
  campus_deadlines: CampusDeadlinesCard,
  competitiveness: CompetitivenessCard,
  resume_tips: ResumeTipsCard,
  rewrite_ready: RewriteReadyCard,
};

/** Renders nothing in place of a card that threw while rendering. */
class CardBoundary extends ReactComponent<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** True for a card that offers a change or a paid action (it names a proposal). Pure. */
export function isProposalCard(card: CopilotCard): boolean {
  const data = card.data as { proposalId?: unknown } | null;
  return !!data && typeof data === 'object' && typeof data.proposalId === 'string' && data.proposalId.length > 0;
}

function UnsavedProposal({ card }: { card: CopilotCard }) {
  const t = useTranslations('assistant.cards');
  return (
    <CardFrame card={card} showSources={false}>
      <p className={styles.cardText} role="status" data-testid="proposal-not-saved">
        {t('notSaved')}
      </p>
    </CardFrame>
  );
}

export function CopilotCardView({ card, ctx = {} }: { card: CopilotCard; ctx?: CardContext }) {
  if (!card || typeof card !== 'object' || typeof card.type !== 'string') return null;
  const Component = (CARD_COMPONENTS as Partial<Record<string, ComponentType<CardProps>>>)[card.type];
  if (!Component) return null;
  if (ctx.turn === 'unsaved' && isProposalCard(card)) return <UnsavedProposal card={card} />;
  return (
    <CardBoundary>
      <Component card={card} ctx={ctx} />
    </CardBoundary>
  );
}

export type { CardContext, CardProps } from './types';
export * from './model';
export { ACTION_CARD_CAPS, sortHref } from './ActionCard';
export { countText } from './FilterDiffCard';
export { creditResult } from './CreditActionCard';
export { formatRange } from './SalaryCard';
