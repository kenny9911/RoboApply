'use client';

// AiText — one block of AI output in the offers area (WP-64): the label
// ("AI-written …"; GoApply also renders AiGeneratedBadge), the text, optional
// talking points and a Copy button. The user sends anything themselves (D1).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import styles from './offers.module.css';

export interface AiTextProps {
  label: string;
  text: string;
  points?: readonly string[];
  pointsTitle?: string;
  copyable?: boolean;
}

export function AiText({ label, text, points, pointsTitle, copyable = false }: AiTextProps) {
  const t = useTranslations('offers.ai');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.aiPanel} data-ai-output="true">
      <div className={styles.aiLine}>
        <AiGeneratedBadge />
        <p className={styles.muted}>{label}</p>
      </div>
      <p className={styles.aiText}>{text}</p>
      {points && points.length ? (
        <>
          {pointsTitle ? <p className={styles.label}>{pointsTitle}</p> : null}
          <ul className={styles.points}>
            {points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      ) : null}
      {copyable ? (
        <div className={styles.actions}>
          <Btn variant="default" onClick={copy}>
            {copied ? t('copied') : t('copy')}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
