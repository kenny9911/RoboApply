'use client';

// ConnectionsList — "People you imported" under /settings#connections (WP-93
// #3, SR-54-2). The user's own contacts outside any job page: each person's
// name, position and the company name as their file (or the user) wrote it
// (`RAContact.companyName`; rows from before that column show the normalized
// name the server falls back to). Private to the user; nothing here contacts
// anyone. 50 a page, "Show more" loads the next one.
//
// The list needs the hiring-contacts mode `on` (the contacts API is gated);
// the caller renders it only then. An empty list renders nothing: the count
// above already says "No connections imported".

import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useOwnContacts } from '../../../hooks/network';
import styles from './network.module.css';

export function ConnectionsList() {
  const t = useTranslations('people.settings.list');
  const tPanel = useTranslations('people.panel');
  const format = useFormatter();
  const { contacts, isLoading, isError, hasMore, loadingMore, loadMore } = useOwnContacts();

  if (isLoading) return null;
  if (isError) {
    return (
      <p className={styles.muted} role="status" data-testid="connections-list-error">
        {t('error')}
      </p>
    );
  }
  if (contacts.length === 0) return null;

  return (
    <div className={styles.form} data-testid="connections-list">
      <h4 className={styles.title}>{t('title')}</h4>
      <p className={styles.muted}>{t('private')}</p>
      <ul className={styles.list}>
        {contacts.map((person) => (
          <li key={person.id} className={styles.person} data-contact={person.id} data-source={person.source}>
            <div className={styles.personText}>
              <p className={styles.name}>{person.fullName}</p>
              <p className={styles.muted} data-testid="contact-company">
                {person.title ? t('role', { title: person.title, company: person.companyName }) : person.companyName}
              </p>
              <p className={styles.muted} data-testid="contact-source">
                {tPanel(person.source === 'user_added' ? 'sourceAdded' : 'sourceImported')}
                {person.connectedOn ? ` · ${tPanel('connectedOn', { date: format.dateTime(new Date(person.connectedOn), { year: 'numeric', month: 'short' }) })}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <div className={styles.row}>
          <Btn variant="ghost" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore || undefined}>
            {loadingMore ? t('loadingMore') : t('more')}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

export default ConnectionsList;
