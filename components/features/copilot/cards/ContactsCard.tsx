'use client';

// contacts — real people from a named source (find_connections:
// the job's opted-in recruiter, the user's imported or added contacts at the
// company), plus search links that open a new tab (F-NET; honesty: no person
// without a source, no email finder, no generated people). Nothing here sends
// a message.

import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseContacts } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function ContactsCard({ card }: CardProps) {
  const t = useTranslations('assistant.cards.contacts');
  const data = parseContacts(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={data.company ? t('title', { company: data.company }) : t('titleGeneric')}>
      {data.people.length ? (
        <ul className={styles.cardList}>
          {data.people.map((p) => (
            <li key={p.id} className={styles.jobRow}>
              <span className={styles.cardTitle}>{p.name}</span>
              <span className={styles.jobMeta}>
                {p.recruiter ? <span>{t('recruiter')}</span> : null}
                {p.title ? <span>{p.title}</span> : null}
                <span className={styles.label}>
                  {t('from', { source: p.source === 'bank_recruiter' ? (p.sourceName ?? '') : t(`sources.${p.source}`) })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.searchLinks.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className={styles.link}>
          {t('search')}
        </a>
      ))}
    </CardFrame>
  );
}
