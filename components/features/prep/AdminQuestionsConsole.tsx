'use client';

// AdminQuestionsConsole — /admin/questions (WP-59). Admin only; the API
// enforces it too. Scoped to the current site's market.
//
//   Shared, to check   questions users shared, oldest first, with the wording
//                      screen (possible test content under an NDA, copied
//                      material, contact details). Publish needs a group and
//                      lets staff tidy the wording; flagged text needs an
//                      explicit "I checked it" — also when staff's own edit
//                      trips the screen (the server re-screens the edited text
//                      and its flags show here). Turn down records a reason.
//   Published / Turned down   past decisions.
//   Reported / Hidden  questions people reported (3 reports hide one until
//                      staff look); hide, keep showing or show again. Keeping or
//                      showing again clears the reports counted so far.
//   Staff-written      general questions; "Write a question" never names a company.

import { useId, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { Tabs, tabPanelProps } from '../../v3/primitives/Tabs';
import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import type { AdminQuestionView, ContributionView, QuestionCategory, QuestionDifficulty, QuestionLocale, RejectReason, ScreenFlag } from '../../../lib/api/contracts/prep';
import {
  useAdminContributions,
  useAdminQuestions,
  useApproveContribution,
  useCreateCuratedQuestion,
  useRejectContribution,
  useSetQuestionHidden,
  type AdminQuestionFilter,
  type ContributionStatusFilter,
} from '../../../hooks/prep/usePrep';
import { SourceLine, usePeriodLabel } from './QuestionCard';
import styles from './prep.module.css';

const CATEGORIES: readonly QuestionCategory[] = ['behavioral', 'role_specific', 'coding', 'system_design', 'domain_design', 'hr'];
const DIFFICULTIES: readonly QuestionDifficulty[] = ['easy', 'medium', 'hard'];
const REJECT_REASONS: readonly RejectReason[] = ['nda_or_test_content', 'copyright', 'personal_info', 'not_a_question', 'duplicate', 'offensive', 'other'];
const LOCALES: readonly QuestionLocale[] = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];

type TabId = ContributionStatusFilter | AdminQuestionFilter | 'write';
const TABS: readonly TabId[] = ['pending', 'approved', 'rejected', 'reported', 'hidden', 'curated', 'write'];

export function AdminQuestionsConsole() {
  const t = useTranslations('practiceQuestions.admin');
  const tAdmin = useTranslations('admin');
  const { user, status } = useAuth();
  const [tab, setTab] = useState<TabId>('pending');

  if (status === 'loading') {
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  }
  if (user?.role !== 'admin') {
    return <EmptyState title={`${tAdmin('notAuthorized.title')} ${tAdmin('notAuthorized.titleAccent')}`} sub={tAdmin('notAuthorized.sub')} />;
  }

  return (
    <div className={styles.page} data-testid="admin-questions">
      <PageHeader title={t('title')} sub={t('sub')} />
      <section className={styles.section}>
        <Tabs tabs={TABS.map((id) => ({ id, label: t(`tabs.${id}`) }))} value={tab} onChange={setTab} ariaLabel={t('tabsLabel')} idBase="prep-admin" />
        <div {...tabPanelProps('prep-admin', tab)} className={styles.form}>
          {tab === 'pending' || tab === 'approved' || tab === 'rejected' ? (
            <ContributionList status={tab} />
          ) : tab === 'write' ? (
            <WriteQuestion onDone={() => setTab('curated')} />
          ) : (
            <QuestionList filter={tab} />
          )}
        </div>
      </section>
    </div>
  );
}

function useDate() {
  const format = useFormatter();
  return (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? format.dateTime(d, { dateStyle: 'medium' }) : '—';
  };
}

// ── Contributions ────────────────────────────────────────────────────────

function ContributionList({ status }: { status: ContributionStatusFilter }) {
  const t = useTranslations('practiceQuestions.admin');
  const q = useAdminContributions(status);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isLoading)
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  if (q.isError)
    return (
      <p className={styles.error} role="alert">
        {t('loadError')}
      </p>
    );
  if (!items.length) return <p className={styles.muted}>{t(`empty.${status}`)}</p>;
  return (
    <>
      <ul className={styles.list}>
        {items.map((c) => (
          <li key={c.id}>{status === 'pending' ? <PendingItem item={c} /> : <DecidedItem item={c} />}</li>
        ))}
      </ul>
      {q.hasNextPage ? (
        <div className={styles.actions}>
          <Btn onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {t('more')}
          </Btn>
        </div>
      ) : null}
    </>
  );
}

function ContributionHead({ item, headingId }: { item: ContributionView; headingId: string }) {
  const t = useTranslations('practiceQuestions.admin.contribution');
  const tCat = useTranslations('practiceQuestions.categories');
  const period = usePeriodLabel()(item.period) ?? item.period;
  const date = useDate();
  return (
    <header className={styles.form}>
      <h3 className={styles.h3} id={headingId}>
        {item.role ? t('meta', { company: item.companyName, role: item.role, period }) : t('metaNoRole', { company: item.companyName, period })}
      </h3>
      <p className={styles.muted}>{t('received', { date: date(item.createdAt) })}</p>
      {/* SR-59-2: the group the contributor picked (staff may publish it under another). */}
      {item.suggestedCategory ? <p className={styles.muted}>{t('suggestedGroup', { group: tCat(item.suggestedCategory) })}</p> : null}
      <p className={styles.text}>{item.body}</p>
    </header>
  );
}

function DecidedItem({ item }: { item: ContributionView }) {
  const t = useTranslations('practiceQuestions.admin.contribution');
  const date = useDate();
  const headingId = `prep-c-${item.id}`;
  return (
    <article className={styles.card} aria-labelledby={headingId}>
      <ContributionHead item={item} headingId={headingId} />
      <p className={styles.muted}>{t('decided', { date: date(item.moderatedAt) })}</p>
      {/* SR-59-2: why it was turned down (stored on the contribution). */}
      {item.status === 'rejected' && item.rejectReason ? <p className={styles.muted}>{t('rejectedFor', { reason: t(`reasons.${item.rejectReason}`) })}</p> : null}
    </article>
  );
}

function PendingItem({ item }: { item: ContributionView }) {
  const t = useTranslations('practiceQuestions.admin.contribution');
  const tCat = useTranslations('practiceQuestions.categories');
  const tLocale = useTranslations('practiceQuestions.admin.write.locales');
  const base = useId();
  const headingId = `prep-c-${item.id}`;
  const approve = useApproveContribution();
  const reject = useRejectContribution();
  const [title, setTitle] = useState(item.body.split('\n')[0]?.slice(0, 160) ?? '');
  const [body, setBody] = useState(item.body);
  const [companyName, setCompanyName] = useState(item.companyName);
  // Starts at the contributor's suggestion when they made one (SR-59-2).
  const [category, setCategory] = useState<QuestionCategory | ''>(item.suggestedCategory ?? '');
  // Prefilled with the server's guess from the script; the guide is written in it.
  const [locale, setLocale] = useState<QuestionLocale>(item.locale);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState<RejectReason>(item.flags.includes('nda_or_test_content') ? 'nda_or_test_content' : 'other');
  const [note, setNote] = useState('');
  const err = approve.error ?? reject.error;
  const errDetails = err ? apiErrorDetails<{ reason?: string; flags?: ScreenFlag[] }>(err) : null;
  const errReason = errDetails?.reason ?? null;
  // The server screens the wording staff publish, so an edit can raise flags the
  // shared text didn't have: show those and the check box too.
  const editFlags = errReason === 'screen_not_confirmed' ? (errDetails?.flags ?? []).filter((f) => !item.flags.includes(f)) : [];
  const flags = [...item.flags, ...editFlags];
  const flagged = item.flags.length > 0 || errReason === 'screen_not_confirmed';

  const publish = (e: FormEvent) => {
    e.preventDefault();
    if (!category) return;
    approve.mutate({
      id: item.id,
      body: { category, title: title.trim(), body: body.trim(), locale, ...(companyName.trim() !== item.companyName ? { companyName: companyName.trim() } : {}), ...(flagged ? { confirmScreened: confirmed } : {}) },
    });
  };

  const turnDown = (e: FormEvent) => {
    e.preventDefault();
    reject.mutate({ id: item.id, body: { reason, ...(note.trim() ? { note: note.trim() } : {}) } });
  };

  return (
    <article className={styles.card} aria-labelledby={headingId}>
      <ContributionHead item={item} headingId={headingId} />
      {flagged ? (
        <div className={styles.warning} role="note">
          <strong>{item.flags.length ? t('flagsTitle') : t('editFlagsTitle')}</strong>
          {flags.length ? (
            <ul>
              {flags.map((f) => (
                <li key={f}>{t(`flags.${f}`)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <form className={styles.form} onSubmit={publish} aria-label={t('publishForm')}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${base}-title`}>
            {t('titleLabel')}
          </label>
          <input id={`${base}-title`} className={styles.input} value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${base}-body`}>
            {t('bodyLabel')}
          </label>
          <textarea id={`${base}-body`} className={styles.textarea} value={body} maxLength={2000} required onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${base}-company`}>
            {t('companyLabel')}
          </label>
          <input id={`${base}-company`} className={styles.input} value={companyName} maxLength={120} required onChange={(e) => setCompanyName(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${base}-category`}>
            {t('categoryLabel')}
          </label>
          <select id={`${base}-category`} className={styles.select} value={category} required onChange={(e) => setCategory(e.target.value as QuestionCategory | '')}>
            <option value="">{t('categoryPick')}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {tCat(c)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${base}-locale`}>
            {t('localeLabel')}
          </label>
          <select
            id={`${base}-locale`}
            className={styles.select}
            value={locale}
            aria-describedby={`${base}-locale-hint`}
            onChange={(e) => setLocale(e.target.value as QuestionLocale)}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {tLocale(l.replace('-', '_'))}
              </option>
            ))}
          </select>
          <p className={styles.muted} id={`${base}-locale-hint`}>
            {t('localeHint')}
          </p>
        </div>
        {flagged ? (
          <label className={styles.check}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>{t('confirm')}</span>
          </label>
        ) : null}
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={!category || (flagged && !confirmed) || approve.isPending}>
            {t('publish')}
          </Btn>
        </div>
      </form>

      <form className={styles.form} onSubmit={turnDown} aria-label={t('rejectForm')}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${base}-reason`}>
            {t('rejectReason')}
          </label>
          <select id={`${base}-reason`} className={styles.select} value={reason} onChange={(e) => setReason(e.target.value as RejectReason)}>
            {REJECT_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reasons.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${base}-note`}>
            {t('rejectNote')}
          </label>
          <input id={`${base}-note`} className={styles.input} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className={styles.actions}>
          <Btn type="submit" disabled={reject.isPending}>
            {t('reject')}
          </Btn>
        </div>
      </form>
      {err ? (
        <p className={styles.error} role="alert">
          {errReason === 'already_moderated'
            ? t('alreadyDecided')
            : errReason === 'screen_not_confirmed'
              ? item.flags.length
                ? t('confirmNeeded')
                : t('editFlagged')
              : apiErrorCode(err) === 'invalid_request'
                ? t('invalid')
                : t('error')}
        </p>
      ) : null}
    </article>
  );
}

// ── Questions ────────────────────────────────────────────────────────────

function QuestionList({ filter }: { filter: AdminQuestionFilter }) {
  const t = useTranslations('practiceQuestions.admin');
  const q = useAdminQuestions(filter);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isLoading)
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  if (q.isError)
    return (
      <p className={styles.error} role="alert">
        {t('loadError')}
      </p>
    );
  if (!items.length) return <p className={styles.muted}>{t(`empty.${filter}`)}</p>;
  return (
    <>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id}>
            <AdminQuestion item={item} />
          </li>
        ))}
      </ul>
      {q.hasNextPage ? (
        <div className={styles.actions}>
          <Btn onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {t('more')}
          </Btn>
        </div>
      ) : null}
    </>
  );
}

function AdminQuestion({ item }: { item: AdminQuestionView }) {
  const t = useTranslations('practiceQuestions.admin.question');
  const tReasons = useTranslations('practiceQuestions.report.reasons');
  const date = useDate();
  const toggle = useSetQuestionHidden();
  const headingId = `prep-q-${item.id}`;
  const hidden = item.status === 'hidden';
  return (
    <article className={styles.card} aria-labelledby={headingId}>
      <h3 className={styles.h3} id={headingId}>
        {item.title}
      </h3>
      <p className={styles.text}>{item.body}</p>
      <SourceLine question={item} />
      <p className={styles.muted}>
        {t(`status.${item.status}`)}
        {item.companyName ? ` · ${item.companyName}` : ''} · {t('reports', { count: item.reportsCount })}
      </p>
      {item.reports.length ? (
        <ul className={styles.bullets}>
          {item.reports.map((r, i) => (
            <li key={i}>
              {tReasons(r.reason)} · {date(r.createdAt)}
              {r.note ? ` — ${r.note}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.actions}>
        <Btn onClick={() => toggle.mutate({ id: item.id, hidden: !hidden })} disabled={toggle.isPending}>
          {hidden ? t('restore') : t('hide')}
        </Btn>
        {!hidden && item.reportsCount > 0 ? (
          <Btn onClick={() => toggle.mutate({ id: item.id, hidden: false })} disabled={toggle.isPending}>
            {t('keep')}
          </Btn>
        ) : null}
      </div>
      {hidden || item.reportsCount > 0 ? <p className={styles.muted}>{t('reviewNote')}</p> : null}
      {toggle.isError ? (
        <p className={styles.error} role="alert">
          {t('error')}
        </p>
      ) : null}
    </article>
  );
}

function WriteQuestion({ onDone }: { onDone: () => void }) {
  const t = useTranslations('practiceQuestions.admin.write');
  const tCat = useTranslations('practiceQuestions.categories');
  const tDiff = useTranslations('practiceQuestions.difficulty');
  const create = useCreateCuratedQuestion();
  const base = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<QuestionCategory>('behavioral');
  const [difficulty, setDifficulty] = useState<QuestionDifficulty | ''>('');
  const brand = useBrand();
  // The site's main language: staff questions in any other language only show
  // to readers of that language (GoApply readers fall back to zh).
  const [locale, setLocale] = useState<QuestionLocale>(brand.market === 'cn' ? 'zh' : 'en');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { title: title.trim(), body: body.trim(), category, locale, ...(difficulty ? { difficulty } : {}) },
      {
        onSuccess: () => {
          setTitle('');
          setBody('');
          onDone();
        },
      },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label={t('formLabel')}>
      <p className={styles.note}>{t('intro')}</p>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${base}-title`}>
          {t('title')}
        </label>
        <input id={`${base}-title`} className={styles.input} value={title} minLength={3} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${base}-body`}>
          {t('body')}
        </label>
        <textarea id={`${base}-body`} className={styles.textarea} value={body} minLength={10} maxLength={2000} required onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${base}-category`}>
          {t('category')}
        </label>
        <select id={`${base}-category`} className={styles.select} value={category} onChange={(e) => setCategory(e.target.value as QuestionCategory)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {tCat(c)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${base}-difficulty`}>
          {t('difficulty')}
        </label>
        <select id={`${base}-difficulty`} className={styles.select} value={difficulty} onChange={(e) => setDifficulty(e.target.value as QuestionDifficulty | '')}>
          <option value="">{t('difficultyNone')}</option>
          {DIFFICULTIES.map((d) => (
            <option key={d} value={d}>
              {tDiff(d)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${base}-locale`}>
          {t('locale')}
        </label>
        <select id={`${base}-locale`} className={styles.select} value={locale} onChange={(e) => setLocale(e.target.value as QuestionLocale)}>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`locales.${l.replace('-', '_')}`)}
            </option>
          ))}
        </select>
      </div>
      {create.isError ? (
        <p className={styles.error} role="alert">
          {t('error')}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Btn type="submit" variant="primary" disabled={create.isPending || title.trim().length < 3 || body.trim().length < 10}>
          {t('submit')}
        </Btn>
      </div>
    </form>
  );
}
