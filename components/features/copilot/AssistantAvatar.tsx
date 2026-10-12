'use client';

// AssistantAvatar — the brand symbol in a soft disc (WP-51 honesty rule: no
// name, face or emoji persona; R-10). Decorative: the message eyebrow names
// the speaker.

import { BrandSymbol } from '../../chrome/BrandSymbol';
import styles from './copilot.module.css';

export function AssistantAvatar({ size = 16 }: { size?: number }) {
  return (
    <span className={styles.avatar} aria-hidden="true" data-testid="assistant-avatar">
      <BrandSymbol size={size} />
    </span>
  );
}
