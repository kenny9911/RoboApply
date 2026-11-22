'use client';

// The conversation tile: messages, the resume start under the greeting, the
// quick replies of Alice's open question, the live work line while a turn
// runs, and the composer. Every action goes through one `send` (a turn); the
// steps shown are the server's own progress events, never a timer.

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

import type { AliceThreadView } from '../../../lib/api/contracts/alice';
import type { AliceError, AliceTurnBody, StepState } from '../../../hooks/alice/useAlice';
import { IconArrow, IconInfo, IconUpload } from '../../v3/primitives/Iconset';
import { AliceMark } from './AliceMark';
import { MessageItem } from './MessageItem';
import { ResumeStart } from './ResumeStart';
import { hasUserTurn, type AliceRegion } from './model';
import s from './alice.module.css';

export interface ConversationProps {
  /** Below 1100px only one region shows at a time. */
  hidden?: boolean;
  thread: AliceThreadView;
  running: AliceTurnBody['kind'] | null;
  steps: StepState[];
  error: AliceError | null;
  onSend: (body: AliceTurnBody) => void;
  onOpen: (region: AliceRegion) => void;
  onRemind: (entryId: string, date: string | null) => void;
  reminderBusy: boolean;
  onRetry: (() => void) | null;
}

/** The plain words for a failed turn (the `alice.errors` messages). */
export function errorKey(error: AliceError): string {
  if (error.reason === 'alice_not_ready') return 'not_ready';
  if (error.reason === 'alice_ai_off') return 'ai_off';
  if (error.reason === 'alice_busy') return 'busy';
  if (error.reason === 'alice_agent_failed') return 'agent_failed';
  if (error.reason === 'alice_wrong_stage') return 'wrong_stage';
  if (error.reason === 'alice_profile_limit') return 'profile_limit';
  if (error.reason === 'alice_search_full') return 'search_full';
  if (error.code === 'rate_limited') return 'rate_limited';
  if (error.code === 'stream_interrupted') return 'interrupted';
  return 'generic';
}

export function Conversation({ hidden = false, thread, running, steps, error, onSend, onOpen, onRemind, reminderBusy, onRetry }: ConversationProps) {
  const t = useTranslations('alice');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [resumeOpen, setResumeOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = running !== null;
  const pending = thread.pending;
  const intakeNoResume = thread.stage === 'intake' && !thread.resume;
  const showStart = intakeNoResume && ((!thread.resumeSkipped && !hasUserTurn(thread.messages)) || resumeOpen);

  // A new open question clears the replies picked for the last one.
  const pendingKey = useMemo(() => `${pending?.topic ?? ''}|${pending?.quickReplies.join('|') ?? ''}`, [pending]);
  useEffect(() => setPicked([]), [pendingKey]);

  // Open on the latest message, then follow the conversation as it grows.
  const lastId = thread.messages.at(-1)?.id;
  const followed = useRef(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el || hidden) return;
    const behavior: ScrollBehavior = followed.current ? 'smooth' : 'auto';
    const last = el.lastElementChild as HTMLElement | null;
    if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') {
      // The tile scrolls (desktop, tablet): keep its end in view.
      if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
    } else if (followed.current && last && typeof last.scrollIntoView === 'function') {
      // The page scrolls (phone): bring a new message into view, never on first load (the title and switch stay on screen).
      last.scrollIntoView({ block: 'end', behavior });
    }
    followed.current = true;
  }, [lastId, steps.length, hidden]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    onSend({ kind: 'message', text: value });
    setText('');
    if (inputRef.current) inputRef.current.style.height = '';
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function reply(option: string) {
    if (busy || !pending) return;
    if (pending.multiSelect) {
      setPicked((prev) => (prev.includes(option) ? prev.filter((p) => p !== option) : [...prev, option]));
      return;
    }
    onSend({ kind: 'replies', replies: [option] });
  }

  const quickReplies = !busy && pending && pending.quickReplies.length > 0 && thread.stage === 'intake';
  const canDraft = thread.stage === 'intake' && thread.ready && !busy;

  return (
    <section className={`${s.conversation} ${s.region}`} data-hidden={hidden ? 'true' : undefined} aria-label={t('tabs.chat')}>
      <div ref={listRef} className={s.messages} aria-live="polite" aria-busy={busy}>
        {thread.messages.map((m, i) => (
          <MessageItem
            key={m.id}
            message={m}
            continued={i > 0 && thread.messages[i - 1].role === 'alice' && m.role === 'alice'}
            onOpen={onOpen}
            onRemind={onRemind}
            reminderBusy={reminderBusy}
          />
        ))}
        {showStart ? (
          <div className={s.alice}>
            <span />
            <ResumeStart
              busy={busy}
              onResume={(id) => {
                setResumeOpen(false);
                onSend({ kind: 'resume', resumeVariantId: id });
              }}
              onSkip={() => {
                setResumeOpen(false);
                if (!thread.resumeSkipped) onSend({ kind: 'skip_resume' });
              }}
            />
          </div>
        ) : null}
        {quickReplies ? (
          <div className={s.alice}>
            <span />
            <div className={s.section}>
              <div className={s.chips} role="group" aria-label={t('composer.replies')}>
                {pending!.quickReplies.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={s.chip}
                    aria-pressed={pending!.multiSelect ? picked.includes(option) : undefined}
                    onClick={() => reply(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
              {pending!.multiSelect && picked.length > 0 ? (
                <div className={s.actions}>
                  <button type="button" className={`${s.btn} ${s.primary} ${s.btnSmall}`} onClick={() => onSend({ kind: 'replies', replies: picked })}>
                    {t('composer.sendPicked', { count: picked.length })}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {busy ? (
          <div className={s.alice}>
            <AliceMark small live />
            <ul className={s.working} aria-label={t('status.working')}>
              {steps.length === 0 ? (
                <li className={s.step} data-state="running">
                  <span className={s.dot} />
                  {t('steps.thinking')}
                </li>
              ) : (
                steps.map((step) => (
                  <li key={step.step} className={s.step} data-state={step.state}>
                    {step.state === 'running' ? <span className={s.dot} /> : <span aria-hidden="true">✓</span>}
                    {t(`steps.${step.step}` as never)}
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}
      </div>

      <form className={s.composer} onSubmit={submit}>
        {error ? (
          <p className={s.errorBar} role="alert">
            <IconInfo size={14} />
            <span>{t(`errors.${errorKey(error)}` as never)}</span>
            {onRetry && errorKey(error) !== 'not_ready' && errorKey(error) !== 'ai_off' ? (
              <button type="button" className={s.textBtn} onClick={onRetry}>
                {t('errors.retry')}
              </button>
            ) : null}
          </p>
        ) : null}
        {canDraft ? (
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.btnSmall}`} onClick={() => onSend({ kind: 'draft_now' })}>
              {t('composer.showProfiles')}
            </button>
          </div>
        ) : null}
        <div className={s.composerRow}>
          {intakeNoResume ? (
            <button
              type="button"
              className={s.iconBtn}
              aria-label={t('composer.attach')}
              aria-expanded={showStart}
              title={t('composer.attach')}
              disabled={busy}
              onClick={() => setResumeOpen((open) => !open)}
            >
              <IconUpload size={18} />
            </button>
          ) : null}
          <label htmlFor="alice-composer" className={s.srOnly}>
            {t('composer.label')}
          </label>
          <textarea
            id="alice-composer"
            ref={inputRef}
            className={s.textarea}
            rows={1}
            maxLength={2000}
            placeholder={t(`composer.placeholder_${thread.stage}` as never)}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Grow with the text up to the field's max height (CSS), then scroll.
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={onKey}
          />
          <button type="submit" className={s.sendBtn} aria-label={t('composer.send')} disabled={busy || !text.trim()}>
            <IconArrow size={18} />
          </button>
        </div>
      </form>
    </section>
  );
}
