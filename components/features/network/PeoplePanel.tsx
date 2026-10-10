'use client';

// PeoplePanel — the People tab's people and messages on a job (PRODUCT_PLAN.md
// §5.11 F-NET; TASK_PLAN.md WP-54). WP-34's PeopleTab renders it under the
// three LinkedIn search deep links it owns.
//
// RoboApply (`hiringContacts` mode):
//   - `on`: "People you know at {company}" from the user's own imported
//     LinkedIn connections (with an import prompt when there are none), and
//     the job's hiring contact — shown only when a recruiter opted in through
//     a RoboHire opt-in record (the section is absent until one exists);
//   - every mode but `off`: "Write a message" (LinkedIn note, email, referral
//     ask, follow-up) — drafts the user copies and sends themselves.
// GoApply (`cn.referralCodes`): moderated 内推码 for this company and the
// 内推请求 message draft for WeChat.
//
// Every person shown is a real record with its own source named on its row
// (imported LinkedIn connection, added by you, or opted-in recruiter; D3); nothing is
// shown when there is no one; we never contact anyone.

import { useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useBrand } from '../../../lib/brand';
import { useFlag } from '../../../lib/flags';
import { useConnectionsForJob } from '../../../hooks/network';
import type { ContactView } from '../../../lib/api/contracts/network';
import { OutreachComposer } from './OutreachComposer';
import { ReferralCodesForCompany } from './ReferralCodesForCompany';
import { CONNECTIONS_SETTINGS_HREF } from './links';
import styles from './network.module.css';

export interface PeoplePanelProps {
  jobId: string;
  /** RACompany id when the job is linked to one. */
  companyId: string | null;
  /** The company name as the job shows it (for matching and empty states). */
  companyName: string;
}

function PersonRow({ person, onWrite, canWrite }: { person: ContactView; onWrite: (id: string) => void; canWrite: boolean }) {
  const t = useTranslations('people.panel');
  const format = useFormatter();
  const first = person.fullName.split(/\s+/)[0] ?? person.fullName;
  return (
    <li className={styles.person} data-contact={person.id} data-source={person.source}>
      <div className={styles.personText}>
        <p className={styles.name}>{person.fullName}</p>
        {person.title ? <p className={styles.muted}>{person.title}</p> : null}
        {person.source === 'bank_recruiter' && person.sourceName ? (
          <p className={styles.muted} data-testid="recruiter-source">
            {t('recruiterSource', { sourceName: person.sourceName })}
            {person.optedInAt ? ` · ${t('recruiterSince', { date: format.dateTime(new Date(person.optedInAt), { year: 'numeric', month: 'long' }) })}` : ''}
          </p>
        ) : person.source === 'user_connections_import' || person.source === 'user_added' ? (
          <p className={styles.muted} data-testid="contact-source">
            {t(person.source === 'user_added' ? 'sourceAdded' : 'sourceImported')}
          </p>
        ) : null}
        {person.connectedOn ? (
          <p className={styles.muted}>{t('connectedOn', { date: format.dateTime(new Date(person.connectedOn), { year: 'numeric', month: 'short' }) })}</p>
        ) : null}
      </div>
      {canWrite ? (
        <Btn variant="ghost" onClick={() => onWrite(person.id)}>
          {t('writeTo', { name: first })}
        </Btn>
      ) : null}
    </li>
  );
}

export function PeoplePanel({ jobId, companyName }: PeoplePanelProps) {
  const t = useTranslations('people.panel');
  const brand = useBrand();
  const cn = brand.market === 'cn';
  const referralCodes = useFlag('cn.referralCodes');
  const q = useConnectionsForJob(jobId);
  const [writeTo, setWriteTo] = useState<string | null>(null);

  if (q.isLoading) {
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className={styles.row}>
        <p className={styles.muted}>{t('error')}</p>
        <Btn variant="ghost" onClick={() => void q.refetch()}>
          {t('retry')}
        </Btn>
      </div>
    );
  }

  const data = q.data;
  if (!cn && data.mode === 'off') return null;

  const known = [...data.fromYourSchools, ...data.fromYourCompanies];
  const contacts = [...data.recruiters, ...known];
  const onWrite = (id: string) => {
    setWriteTo(id);
    const el = typeof document !== 'undefined' ? document.getElementById(`compose-${jobId}`) : null;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={styles.panel} data-testid="people-panel">
      {cn && referralCodes ? <ReferralCodesForCompany companyName={companyName} /> : null}

      {!cn && data.mode === 'on' && data.recruiters.length ? (
        <section className={styles.section} data-testid="hiring-contacts">
          <h3 className={styles.title}>{t('recruitersTitle')}</h3>
          <ul className={styles.list}>
            {data.recruiters.map((p) => (
              <PersonRow key={p.id} person={p} onWrite={onWrite} canWrite={data.aiAvailable} />
            ))}
          </ul>
        </section>
      ) : null}

      {!cn && data.mode === 'on' ? (
        <section className={styles.section} data-testid="people-you-know">
          <h3 className={styles.title}>{t('knownTitle', { company: companyName })}</h3>
          {known.length ? (
            <>
              <p className={styles.muted}>{t('knownIntro')}</p>
              {data.fromYourSchools.length ? <p className={styles.muted}>{t('schoolsTitle', { company: companyName })}</p> : null}
              <ul className={styles.list}>
                {known.map((p) => (
                  <PersonRow key={p.id} person={p} onWrite={onWrite} canWrite={data.aiAvailable} />
                ))}
              </ul>
            </>
          ) : data.importedCount > 0 ? (
            <p className={styles.muted}>{t('noneKnown', { company: companyName })}</p>
          ) : (
            <>
              <p className={styles.muted}>{t('importHint')}</p>
              <Link className={styles.link} href={CONNECTIONS_SETTINGS_HREF} data-testid="import-cta">
                {t('importCta')}
              </Link>
            </>
          )}
        </section>
      ) : null}

      <div id={`compose-${jobId}`}>
        <OutreachComposer
          jobId={jobId}
          companyName={companyName}
          contacts={contacts}
          contactId={writeTo}
          drafts={data.drafts}
          aiAvailable={data.aiAvailable}
        />
      </div>
    </div>
  );
}

export default PeoplePanel;
