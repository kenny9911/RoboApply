'use client';

// CardFrame — the shared frame of every Assistant card: a titled section, its
// body, and one SourceNote per sourced value the server attached (D3).
// `sources` goes through the same tolerant parser as card data: a malformed
// entry is dropped instead of crashing the conversation.

import type { ReactNode } from 'react';

import { SourceNote } from '../../common';
import type { CopilotCard } from '../../../../lib/api/contracts/copilot';
import { parseSources } from './model';
import styles from '../copilot.module.css';

export interface CardFrameProps {
  card: CopilotCard;
  title?: ReactNode;
  children?: ReactNode;
  /** Render the card's `sources` under the body (default true). */
  showSources?: boolean;
}

export function CardFrame({ card, title, children, showSources = true }: CardFrameProps) {
  const sources = showSources ? parseSources(card.sources) : [];
  return (
    <section className={styles.card} data-card={card.type} data-card-id={card.id} aria-label={typeof title === 'string' ? title : undefined}>
      {title ? <h3 className={styles.cardTitle}>{title}</h3> : null}
      {children}
      {sources.map((s, i) => (
        <SourceNote key={i} sourced={s} />
      ))}
    </section>
  );
}
