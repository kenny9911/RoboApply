'use client';

// The Profile view of the canvas, one panel per stage:
//   intake    What Alice knows so far (every value from the person's answers)
//   choosing  the two profiles compared row by row (rows that differ carry her dot)
//   refining  the version being worked on: the comment that caused it, what she
//             changed (blue rule, old value struck), the versions, the save card
//   saved     the saved profile and the search it drives

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { AliceJobProfile, AliceProfileField, AliceThreadView, AliceTopicId } from '../../../lib/api/contracts/alice';
import type { AliceTurnBody } from '../../../hooks/alice/useAlice';
import { useAliceProfiles, usePatchAliceProfile } from '../../../hooks/alice/useAlice';
import { ProfileRows } from './ProfileFields';
import { currentRevision, differingFields, formatAmount, isUnnamed, newlyLearned, previousRevision, topicProgress, topicValue, type AliceRegion } from './model';
import s from './alice.module.css';

interface PanelProps {
  thread: AliceThreadView;
  busy: boolean;
  onSend: (body: AliceTurnBody) => void;
  onOpen: (region: AliceRegion) => void;
}

// ── Intake: what Alice knows so far ─────────────────────────────────────────

function TopicValue({ thread, topic }: { thread: AliceThreadView; topic: AliceTopicId }) {
  const t = useTranslations('alice');
  const locale = useLocale();
  const values = topicValue(thread.brief, topic);
  if (thread.topics.declined.includes(topic) && values.length === 0) return <span className={s.muted}>{t('brief.skipped')}</span>;
  if (values.length === 0) return <span className={s.muted}>—</span>;
  const words = values.map((v) => {
    if (typeof v === 'object' && v !== null && 'avoid' in v) return t('brief.not', { value: String((v as { avoid: string }).avoid) });
    if (typeof v === 'object' && v !== null && 'amount' in v) {
      const pay = v as { amount: number; currency: string; period: 'year' | 'month' | 'hour' };
      return t(`values.payPer.${pay.period}`, { amount: formatAmount(pay, locale) });
    }
    if (topic === 'level') return t(`values.levels.${String(v)}` as never);
    if (topic === 'workSetting') return t(`values.workModels.${String(v)}` as never);
    if (topic === 'companyKind') return t(`values.companyKinds.${String(v)}` as never);
    if (topic === 'companySize') return t('values.companySize', { size: String(v) });
    if (topic === 'timing') return t(`values.timing.${String(v)}` as never);
    if (topic === 'sponsorship') return t(v ? 'values.sponsorship.yes' : 'values.sponsorship.no');
    return String(v);
  });
  return <>{words.join(' · ')}</>;
}

export function BriefPanel({ thread, busy, onSend }: PanelProps) {
  const t = useTranslations('alice');
  const { done, total } = topicProgress(thread);
  const fresh = newlyLearned(thread.messages);
  return (
    <>
      <div className={s.section}>
        <h2 className={s.h2}>{t('brief.title')}</h2>
        <p className={s.lead}>{t('brief.intro')}</p>
        <div className={s.progress}>
          <div className={s.track} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t('brief.progress', { done, total })}>
            <span className={s.fill} style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
          </div>
          <span className={s.meta}>{t('brief.progress', { done, total })}</span>
        </div>
      </div>
      <dl className={s.facts}>
        {thread.topics.all.map((topic) => (
          <div key={topic} className={s.fact} data-new={fresh.has(topic) ? 'true' : undefined}>
            <dt>{t(`brief.topics.${topic}` as never)}</dt>
            <dd>
              <TopicValue thread={thread} topic={topic} />
            </dd>
          </div>
        ))}
      </dl>
      {thread.resume ? <p className={s.meta}>{t('brief.fromResume', { name: thread.resume.name })}</p> : null}
      <div className={s.section}>
        <p className={s.lead}>{thread.ready ? t('brief.ready') : t('brief.notReady')}</p>
        {thread.ready ? (
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.primary}`} disabled={busy} onClick={() => onSend({ kind: 'draft_now' })}>
              {t('composer.showProfiles')}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

// ── Choosing: two profiles compared ────────────────────────────────────────

function ProfileCard({ profile, letter, differs, busy, onChoose }: { profile: AliceJobProfile; letter: string; differs: ReadonlySet<AliceProfileField>; busy: boolean; onChoose: () => void }) {
  const t = useTranslations('alice');
  return (
    <article className={s.card} aria-labelledby={`alice-draft-${profile.id}`}>
      <div className={s.cardHead}>
        <span className={s.letter} aria-hidden="true">
          {letter}
        </span>
        <h3 id={`alice-draft-${profile.id}`} className={s.label}>
          {profile.label}
        </h3>
        <p className={s.headline}>{profile.headline}</p>
        {profile.summary ? <p className={s.meta}>{profile.summary}</p> : null}
      </div>
      <ProfileRows profile={profile} differs={differs} />
      <div className={s.actions}>
        <button type="button" className={`${s.btn} ${s.primary}`} disabled={busy} onClick={onChoose}>
          {t('compare.choose')}
          <span className={s.srOnly}>: {profile.label}</span>
        </button>
      </div>
    </article>
  );
}

export function ComparePanel({ thread, busy, onSend }: PanelProps) {
  const t = useTranslations('alice');
  const [comment, setComment] = useState('');
  const [a, b] = thread.drafts;
  if (!a || !b) return null;
  const differs = differingFields(a, b);
  const note = comment.trim();
  return (
    <>
      <div className={s.section}>
        <h2 className={s.h2}>{thread.analysis?.question || t('compare.title')}</h2>
        <p className={s.lead}>{thread.analysis?.summary || t('compare.intro')}</p>
        <p className={s.meta}>{t('compare.differsHint')}</p>
      </div>
      <div className={s.compare}>
        <ProfileCard profile={a} letter="A" differs={differs} busy={busy} onChoose={() => onSend({ kind: 'choose', draftId: 'a', ...(note ? { comment: note } : {}) })} />
        <ProfileCard profile={b} letter="B" differs={differs} busy={busy} onChoose={() => onSend({ kind: 'choose', draftId: 'b', ...(note ? { comment: note } : {}) })} />
      </div>
      <div className={s.commentBox}>
        <label className={s.fieldLabel} htmlFor="alice-compare-comment">
          {t('compare.commentLabel')}
        </label>
        <textarea
          id="alice-compare-comment"
          className={s.textarea}
          rows={2}
          maxLength={1000}
          placeholder={t('compare.commentPlaceholder')}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <p className={s.meta}>{t('compare.commentHint')}</p>
        <div className={s.actions}>
          <button type="button" className={s.btn} disabled={busy} onClick={() => onSend({ kind: 'regenerate', ...(note ? { comment: note } : {}) })}>
            {t('compare.neither')}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Refining: the version being worked on ───────────────────────────────────

function SaveCard({ thread, busy, onSend }: PanelProps) {
  const t = useTranslations('alice');
  const rev = currentRevision(thread);
  const [name, setName] = useState(rev?.profile.label ?? '');
  const target = thread.saveTarget;
  const named = name.trim() || undefined;
  return (
    <section className={s.saveCard} aria-labelledby="alice-save-title">
      <h3 id="alice-save-title" className={s.h3}>
        {t('save.title')}
      </h3>
      <div className={s.inputRow}>
        <label className={s.srOnly} htmlFor="alice-save-name">
          {t('save.name')}
        </label>
        <input id="alice-save-name" className={s.input} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {target?.mode === 'choose' ? (
        <>
          <p className={s.meta}>{t('save.replaceHint')}</p>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.primary}`} disabled={busy} onClick={() => onSend({ kind: 'save', search: 'replace', ...(named ? { name: named } : {}) })}>
              {isUnnamed(target.search?.name) ? t('save.replaceMain') : t('save.replace', { search: target.search?.name ?? '' })}
            </button>
            <button type="button" className={s.btn} disabled={busy} onClick={() => onSend({ kind: 'save', search: 'none', ...(named ? { name: named } : {}) })}>
              {t('save.none')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={s.meta}>{target?.mode === 'update' ? t('save.updateHint') : t('save.createHint')}</p>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.primary}`} disabled={busy} onClick={() => onSend({ kind: 'save', search: 'auto', ...(named ? { name: named } : {}) })}>
              {target?.mode === 'update'
                ? isUnnamed(target.search?.name)
                  ? t('save.updateMain')
                  : t('save.update', { search: target.search?.name ?? '' })
                : t('save.create')}
            </button>
            <button type="button" className={s.btn} disabled={busy} onClick={() => onSend({ kind: 'save', search: 'none', ...(named ? { name: named } : {}) })}>
              {t('save.none')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function VersionPanel({ thread, busy, onSend }: PanelProps) {
  const t = useTranslations('alice');
  const [comment, setComment] = useState('');
  const rev = currentRevision(thread);
  if (!rev) return null;
  const prev = previousRevision(thread, rev);
  const note = comment.trim();
  return (
    <>
      <div className={s.section}>
        <div className={s.versionHead}>
          <h2 className={s.h2}>{rev.profile.label}</h2>
          <span className={s.meta}>{t('profile.version', { version: rev.version })}</span>
        </div>
        <p className={s.headline}>{rev.profile.headline}</p>
        {rev.profile.summary ? <p className={s.lead}>{rev.profile.summary}</p> : null}
      </div>
      {rev.origin === 'edit' && rev.comment ? (
        <div className={s.section}>
          <p className={s.said}>{t('profile.yourComment', { comment: rev.comment })}</p>
          {rev.notes.length ? (
            <>
              <h3 className={s.h3}>{t('profile.aliceNotes')}</h3>
              <ul className={s.notes}>
                {rev.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      <ProfileRows profile={rev.profile} changed={new Set(rev.changed)} previous={prev?.profile ?? null} />
      <form
        className={s.commentBox}
        onSubmit={(e) => {
          e.preventDefault();
          if (!note || busy) return;
          onSend({ kind: 'refine', comment: note });
          setComment('');
        }}
      >
        <label className={s.fieldLabel} htmlFor="alice-refine-comment">
          {t('profile.commentLabel')}
        </label>
        <textarea
          id="alice-refine-comment"
          className={s.textarea}
          rows={2}
          maxLength={1000}
          placeholder={t('profile.commentPlaceholder')}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className={s.actions}>
          <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy || !note}>
            {t('profile.send')}
          </button>
          <button type="button" className={s.textBtn} disabled={busy} onClick={() => onSend({ kind: 'regenerate' })}>
            {t('profile.newPair')}
          </button>
        </div>
      </form>
      <SaveCard thread={thread} busy={busy} onSend={onSend} onOpen={() => undefined} />
      {thread.revisions.length > 1 ? (
        <section className={s.section} aria-labelledby="alice-trail-title">
          <h3 id="alice-trail-title" className={s.h3}>
            {t('profile.history')}
          </h3>
          <ol className={s.trail}>
            {[...thread.revisions].reverse().map((r) => {
              const current = r.version === rev.version;
              const what =
                r.origin === 'edit' && r.comment
                  ? t('profile.historyEdit', { comment: r.comment })
                  : r.origin === 'restore'
                    ? t('profile.historyRestore', { version: r.restoredFrom ?? 0 })
                    : r.origin === 'saved_profile'
                      ? t('profile.historySaved')
                      : t('profile.historyPick', { label: r.profile.label });
              return (
                <li key={r.version} className={s.trailItem} aria-current={current ? 'true' : undefined}>
                  <span className={s.trailV}>{r.version}</span>
                  <span className={s.trailText} title={what}>
                    {what}
                  </span>
                  {current ? (
                    <span className={s.meta}>{t('profile.current')}</span>
                  ) : (
                    <button type="button" className={s.textBtn} disabled={busy} onClick={() => onSend({ kind: 'restore', version: r.version })}>
                      {t('profile.restore')}
                      <span className={s.srOnly}> {t('profile.version', { version: r.version })}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </>
  );
}

// ── Saved ──────────────────────────────────────────────────────────────────

export function SavedPanel({ thread, busy, onSend, onOpen }: PanelProps) {
  const t = useTranslations('alice');
  const saved = thread.savedProfile;
  const profiles = useAliceProfiles();
  const patch = usePatchAliceProfile();
  const [undone, setUndone] = useState(false);
  if (!saved) return null;
  const others = (profiles.data?.items ?? []).filter((p) => p.id !== saved.id && p.status === 'active');
  return (
    <>
      <div className={s.section}>
        <div className={s.versionHead}>
          <h2 className={s.h2}>{saved.name}</h2>
          <span className={s.meta}>{t('profile.version', { version: saved.version })}</span>
        </div>
        <p className={s.headline}>{saved.profile.headline}</p>
        <p className={s.meta}>
          {saved.search ? (isUnnamed(saved.search.name) ? t('saved.drivesMain') : t('saved.drives', { search: saved.search.name })) : t('saved.drivesNone')}
        </p>
        <div className={s.actions}>
          <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => onOpen('jobs')}>
            {t('saved.findJobs')}
          </button>
          <button type="button" className={s.btn} disabled={busy} onClick={() => onSend({ kind: 'edit_profile', profileId: saved.id })}>
            {t('saved.edit')}
          </button>
          {saved.canUndoReplace ? (
            <button
              type="button"
              className={s.textBtn}
              disabled={patch.isPending}
              onClick={() => patch.mutate({ id: saved.id, body: { undoReplace: true } }, { onSuccess: () => setUndone(true) })}
            >
              {t('saved.undo')}
            </button>
          ) : null}
        </div>
        {undone ? <p className={s.meta}>{t('saved.undone')}</p> : null}
      </div>
      <ProfileRows profile={saved.profile} />
      {others.length ? (
        <section className={s.section} aria-labelledby="alice-others-title">
          <h3 id="alice-others-title" className={s.h3}>
            {t('saved.others')}
          </h3>
          <ul className={s.trail}>
            {others.map((p) => (
              <li key={p.id} className={`${s.trailItem} ${s.trailItemWide}`}>
                <span className={s.trailText}>
                  {p.name} · {p.profile.headline}
                </span>
                <button type="button" className={s.textBtn} disabled={busy} onClick={() => onSend({ kind: 'edit_profile', profileId: p.id })}>
                  {t('saved.edit')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function ProfileView(props: PanelProps) {
  const { thread } = props;
  if (thread.stage === 'choosing') return <ComparePanel {...props} />;
  if (thread.stage === 'refining') return <VersionPanel {...props} />;
  if (thread.stage === 'saved') return <SavedPanel {...props} />;
  return <BriefPanel {...props} />;
}
