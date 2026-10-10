'use client';

// OutreachComposer — "Write a message" (F-NET-04, F-NET-06; GoApply 内推请求).
//
// The user picks the kind of message (and, when there is one, the person),
// %BRAND% writes a draft from the job post and their resume (credit
// `outreach`), the user edits it, then copies it or opens it in their own
// email app / LinkedIn and sends it themselves. There is no send button: the
// only follow-up is "I sent it", which records what the user tells us.
// AI output is labelled ("Written from the job post and your resume."; on
// GoApply the AiGeneratedBadge too).

import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, CreditNotice, toast } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import { PhoneBindingNotice } from '../auth-cn';
import { useBrand } from '../../../lib/brand';
import { useCreateOutreachDraft, useDraftActions, type OutreachErrorKind } from '../../../hooks/network';
import type { ContactView, OutreachChannel, OutreachDraftView } from '../../../lib/api/contracts/network';
import { linkedinHrefFor, mailtoHref } from './links';
import styles from './network.module.css';

/** Mirrors server OUTREACH_CHANNELS_BY_MARKET (features/network/contract.ts). */
export const CHANNELS_BY_MARKET: Record<'intl' | 'cn', readonly OutreachChannel[]> = {
  intl: ['linkedin_note', 'email', 'referral_ask', 'follow_up'],
  cn: ['wechat', 'referral_ask', 'email', 'follow_up'],
};
/** Mirrors server maxCharsFor (features/network/draftText.ts). */
export function maxCharsFor(channel: OutreachChannel): number {
  return channel === 'linkedin_note' ? 300 : channel === 'wechat' ? 600 : 5000;
}
const MAIL_CHANNELS: ReadonlySet<OutreachChannel> = new Set(['email', 'referral_ask', 'follow_up']);

export interface OutreachComposerProps {
  jobId: string;
  companyName: string;
  /** People the user may address (own contacts, opted-in recruiters). */
  contacts?: ContactView[];
  /** Pre-select a person (e.g. "Write to Ada"). */
  contactId?: string | null;
  /** Save the draft on this application. */
  trackerEntryId?: string | null;
  /** Limit the kinds of message offered (default: the brand's market list). */
  channels?: readonly OutreachChannel[];
  initialChannel?: OutreachChannel;
  /** Drafts already written for this job / application, newest first. */
  drafts?: OutreachDraftView[];
  aiAvailable: boolean;
  /** Hide the section title (when the host already has one, e.g. a sheet). */
  bare?: boolean;
}

const charCount = (s: string) => Array.from(s).length;

export function OutreachComposer({
  jobId,
  companyName,
  contacts = [],
  contactId = null,
  trackerEntryId = null,
  channels,
  initialChannel,
  drafts = [],
  aiAvailable,
  bare = false,
}: OutreachComposerProps) {
  const t = useTranslations('people.composer');
  const format = useFormatter();
  const brand = useBrand();
  const market = brand.market === 'cn' ? 'cn' : 'intl';
  const offered = channels?.length ? channels.filter((c) => CHANNELS_BY_MARKET[market].includes(c)) : CHANNELS_BY_MARKET[market];
  const [channel, setChannel] = useState<OutreachChannel>(initialChannel && offered.includes(initialChannel) ? initialChannel : offered[0]!);
  const [to, setTo] = useState<string>(contactId ?? '');
  const [draft, setDraft] = useState<OutreachDraftView | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<{ kind: OutreachErrorKind; cause?: unknown } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle');
  const create = useCreateOutreachDraft();
  const actions = useDraftActions();

  useEffect(() => {
    if (contactId) setTo(contactId);
  }, [contactId]);

  const person = useMemo(() => contacts.find((c) => c.id === to) ?? null, [contacts, to]);
  const max = maxCharsFor(draft?.channel ?? channel);
  const dirty = draft != null && (body !== draft.body || (subject || null) !== (draft.subject || null));
  const over = charCount(body) > max;

  const load = (d: OutreachDraftView) => {
    setDraft(d);
    setBody(d.body);
    setSubject(d.subject ?? '');
    setSaveState('idle');
  };

  const write = async () => {
    setError(null);
    const r = await create.run({ jobId, channel, contactId: to || undefined, trackerEntryId: trackerEntryId ?? undefined });
    if (r.ok) load(r.draft);
    else if (r.error !== 'credits_exhausted') setError({ kind: r.error, cause: r.cause });
  };

  const save = async (): Promise<OutreachDraftView | null> => {
    if (!draft || !dirty || over) return draft;
    const next = await actions.save(draft.id, { body, subject: MAIL_CHANNELS.has(draft.channel) ? subject : undefined });
    if (next) {
      load(next);
      setSaveState('saved');
    } else setSaveState('error');
    return next;
  };

  const copy = async () => {
    if (!draft) return;
    const text = MAIL_CHANNELS.has(draft.channel) && subject.trim() ? `${subject.trim()}\n\n${body}` : body;
    try {
      await navigator.clipboard.writeText(text);
      toast({ message: t('copied'), tone: 'ok' });
    } catch {
      /* clipboard blocked: the text stays selectable in the box */
    }
    await save();
    const d = await actions.copied(draft.id);
    if (d) setDraft((prev) => (prev ? { ...prev, copiedAt: d.copiedAt } : prev));
  };

  const opened = async () => {
    if (!draft) return;
    await save();
    const d = await actions.copied(draft.id);
    if (d) setDraft((prev) => (prev ? { ...prev, copiedAt: d.copiedAt } : prev));
  };

  const markSent = async () => {
    if (!draft) return;
    await save();
    const d = await actions.sent(draft.id);
    if (d) setDraft((prev) => (prev ? { ...prev, markedSentAt: d.markedSentAt } : prev));
  };

  const others = drafts.filter((d) => d.id !== draft?.id);

  return (
    <section className={bare ? styles.panel : styles.section} aria-label={t('title')} data-testid="outreach-composer">
      {bare ? null : <h3 className={styles.title}>{t('title')}</h3>}
      <p className={styles.muted}>{t('intro')}</p>

      {!aiAvailable ? (
        <p className={styles.muted} data-testid="outreach-ai-off">
          {t('aiOff')}
        </p>
      ) : (
        <div className={styles.form}>
          <div className={styles.row}>
            <label className={styles.fieldGrow}>
              {t('channelLabel')}
              <select className={styles.select} value={channel} onChange={(e) => setChannel(e.target.value as OutreachChannel)}>
                {offered.map((c) => (
                  <option key={c} value={c}>
                    {t(`channel.${c}`)}
                  </option>
                ))}
              </select>
            </label>
            {contacts.length ? (
              <label className={styles.fieldGrow}>
                {t('toLabel')}
                <select className={styles.select} value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">{t('toNobody')}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title ? `${c.fullName} · ${c.title}` : c.fullName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <CreditNotice bucket={create.summary} />
          <div className={styles.row}>
            <Btn variant="primary" onClick={write} disabled={create.pending} aria-busy={create.pending || undefined}>
              {create.pending ? t('writing') : draft ? t('again') : t('write')}
            </Btn>
          </div>
        </div>
      )}

      {error ? (
        error.kind === 'phone_binding_required' ? (
          <PhoneBindingNotice error={error.cause} />
        ) : (
          <p className={styles.error} role="alert" data-error={error.kind}>
            {t(`error.${error.kind}`)}
          </p>
        )
      ) : null}

      {draft ? (
        <div className={styles.form} data-testid="outreach-draft" data-channel={draft.channel}>
          <p className={styles.label}>
            <span>{t('grounding')}</span>
            <AiGeneratedBadge kind="text" />
          </p>
          {brand.market !== 'cn' ? <p className={styles.muted}>{t('aiLabel')}</p> : null}
          {MAIL_CHANNELS.has(draft.channel) ? (
            <label className={styles.field}>
              {t('subject')}
              <input className={styles.input} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            </label>
          ) : null}
          <label className={styles.field}>
            {t('body')}
            <textarea className={styles.textarea} value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={over || undefined} />
          </label>
          <p className={over ? styles.counterOver : styles.counter} aria-live="polite">
            {t('counter', { count: charCount(body), max })}
          </p>
          {draft.trackerEntryId ? <p className={styles.muted}>{t('savedOnApplication')}</p> : null}
          <div className={styles.row}>
            <Btn onClick={copy} disabled={over}>
              {t('copy')}
            </Btn>
            {MAIL_CHANNELS.has(draft.channel) ? (
              <Btn as="a" href={mailtoHref(subject, body)} onClick={opened} title={t('openMailHint')}>
                {t('openMail')}
              </Btn>
            ) : null}
            {draft.channel === 'linkedin_note' ? (
              <Btn as="a" href={linkedinHrefFor(person, companyName)} target="_blank" rel="noopener noreferrer" onClick={opened}>
                {t('openLinkedIn')}
              </Btn>
            ) : null}
            {dirty ? (
              <Btn variant="ghost" onClick={() => void save()} disabled={over}>
                {t('save')}
              </Btn>
            ) : null}
            {draft.markedSentAt ? null : (
              <Btn variant="ghost" onClick={markSent}>
                {t('markSent')}
              </Btn>
            )}
          </div>
          {MAIL_CHANNELS.has(draft.channel) ? <p className={styles.muted}>{t('openMailHint')}</p> : null}
          {saveState === 'saved' ? <p className={styles.muted}>{t('saved')}</p> : null}
          {saveState === 'error' ? (
            <p className={styles.error} role="alert">
              {t('saveError')}
            </p>
          ) : null}
          {draft.markedSentAt ? (
            <p className={styles.notice}>{t('sentOn', { date: format.dateTime(new Date(draft.markedSentAt), { dateStyle: 'medium' }) })}</p>
          ) : null}
          <p className={styles.muted}>{t('youSend')}</p>
        </div>
      ) : null}

      {others.length ? (
        <div className={styles.form}>
          <p className={styles.muted}>{t('history')}</p>
          <ul className={styles.list}>
            {others.slice(0, 5).map((d) => (
              <li key={d.id}>
                <button type="button" className={styles.linkButton} onClick={() => load(d)}>
                  {t('draftOf', { channel: t(`channel.${d.channel}`), date: format.dateTime(new Date(d.createdAt), { dateStyle: 'medium' }) })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export default OutreachComposer;
