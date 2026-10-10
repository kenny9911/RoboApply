'use client';

// CopilotRail — the Assistant's right-hand drawer on desktop and full-screen
// sheet on a phone, mounted once by the app shell (FND-6a layout slot;
// F-ORION-01, F-ORION-08).
//
// Contract (FND-6a):
//   • open state and requests come from `useAssistantRail()`; producers call
//     `useOpenAssistant()` (Ask in the top bar, "Ask about this job", …);
//   • it opens ONLY when the user asks. Nothing here opens it on a route
//     change, and it is not reopened on a page load either: the rail is a
//     modal drawer with a scrim, so reopening it by itself put a dialog over a
//     page the user had just started using (hooks/copilot/useRailMemory.ts);
//   • Drawer primitive (focus moves in, stays in, returns on close; Escape);
//   • renders nothing when the `copilot` capability is off;
//   • no AI entry (floating button, Cmd/Ctrl+J) unless the user may ask
//     (useCopilotAvailability: capability AND aiAllowed — the GoApply AI
//     consent — AND no `ai_unavailable` this session). A request that opens
//     the rail while the user may not ask is closed again once that is known;
//   • on /assistant the page is the Assistant: no floating button and
//     Cmd/Ctrl+J is left alone (no second conversation).
//
// The job on screen is the job in context. Ask in the top bar, the floating
// button and Cmd/Ctrl+J carry no job, so on a job page (`/jobs/<id>`) an
// empty chat takes that page's job: "Why do I fit this job?" then has a job
// to be about. A conversation that is already under way is never replaced:
// the thread then offers "New chat about this job" (CopilotThread, `pageJobId`).
// The pathname is read for that only, never to open the rail.
//
// Also here: Cmd/Ctrl+J toggles it; the floating "Ask" button (hideable,
// remembered in RAUserUiState); and at most one proactive nudge per session
// (hooks/copilot/nudges.ts) through the popup gate. The rail asks the server
// which nudge holds (GET /copilot/nudge, on mount and on a route change, only
// while the floating button is on screen); the server derives the kind from
// the user's real signals, and only that kind is used.

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { clearAssistantNudge, markNudgeShown, useCopilotAvailability, useCopilotChat, usePendingNudge, useRailMemory, useServerNudge } from '../../../hooks/copilot';
import { openAssistantRail, useAssistantRail } from '../../../hooks/shared/useOpenAssistant';
import { usePopupGate } from '../../../lib/ui/popupGate';
import { Btn, Drawer, IconChat } from '../../v3/primitives';
import { SURFACES_READY, showAllNav } from '../../v3/shell/destinations';
import { AssistantAvatar } from './AssistantAvatar';
import { CopilotThread, FullPageLink } from './CopilotThread';
import styles from './copilot.module.css';

export type CopilotRailProps = Record<string, never>;

const NARROW_QUERY = '(max-width: 760px)';

function isNarrow(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/** The job a job page is about: `/jobs/<id>` (not the list, Explore, Added by you or the report). Pure. */
export function jobIdOnPage(pathname: string): string | null {
  const m = /^\/jobs\/([^/?#]+)\/?$/.exec(pathname);
  if (!m || ['explore', 'added', 'report'].includes(m[1]!)) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'image', 'hidden']);

/** True for an element the user types or picks in (a text field, a select, an editable region). Pure. */
export function isEditingField(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase());
}

/** Cmd+J (macOS) / Ctrl+J elsewhere. Pure. */
export function isRailShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j';
}

export function CopilotRail(_props: CopilotRailProps = {}) {
  const availability = useCopilotAvailability();
  const enabled = availability.capability;
  const rail = useAssistantRail();
  const pathname = usePathname() ?? '';
  const chat = useCopilotChat();
  const onAssistantPage = pathname === '/assistant' || pathname.startsWith('/assistant/');
  // Ask is shown only once the Assistant surface has shipped (INT flips
  // SURFACES_READY.assistant; the dev override shows it early) and only to a
  // user who may ask.
  const entryVisible = enabled && availability.canAsk && (SURFACES_READY.assistant || showAllNav());
  const memory = useRailMemory({ enabled });
  const pageJobId = jobIdOnPage(pathname);
  const nudge = usePendingNudge();
  const t = useTranslations('assistant');
  const [prefill, setPrefill] = useState<{ text: string; seq: number } | null>(null);
  const handledSeq = useRef(0);

  // The floating button sits over the bottom-right corner of the page. While the
  // user is typing in a field of the page it steps aside, so it never covers the
  // field or the buttons beside it; it is back as soon as the field is left.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!entryVisible) return undefined;
    const sync = () => setEditing(isEditingField(document.activeElement));
    // After focusout the next element is focused a tick later.
    const later = () => window.setTimeout(sync, 0);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', later);
    sync();
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', later);
    };
  }, [entryVisible]);

  /** The floating button belongs on this page (whether or not it is stepping aside right now). */
  const fabOffered = entryVisible && memory.fabHidden === false && !rail.open && !onAssistantPage;
  const fabVisible = fabOffered && !editing;

  // Each open request (a new seq) may carry a thread, a job or a prompt.
  useEffect(() => {
    if (!enabled || rail.seq === handledSeq.current) return;
    handledSeq.current = rail.seq;
    const req = rail.request;
    if (!req) return;
    // A resume-scoped request (F-RES-11) starts a chat about that resume; every turn then carries it.
    const resumeId = req.scope === 'resume' && req.resumeId ? req.resumeId : null;
    if (req.threadId) chat.openThread(req.threadId, { jobId: req.jobId ?? null, resumeId });
    else if (resumeId) {
      if (resumeId !== chat.contextResumeId) chat.newChat({ resumeId });
    } else if (req.jobId) {
      if (req.jobId !== chat.contextJobId) chat.newChat({ jobId: req.jobId });
    } else if (!chat.contextResumeId && !chat.threadId && chat.messages.length === 0 && !chat.streaming) {
      // A request with no job of its own (Ask in the top bar, the floating button, Cmd/Ctrl+J)
      // and nothing said yet: the chat is about the job on screen, or about no job when the
      // page is not a job (a job left over from an earlier page would be the wrong one).
      if ((pageJobId ?? null) !== chat.contextJobId) chat.newChat({ jobId: pageJobId });
    }
    if (req.prompt) setPrefill({ text: req.prompt, seq: rail.seq });
    // chat callbacks are stable; the contexts and the page are read at request time on purpose.
  }, [enabled, rail.seq, rail.request]);

  // "New chat" on a job page: the new, empty chat is about that job too. A chat
  // that has a job, a resume, a thread or a message already is left alone.
  useEffect(() => {
    if (!enabled || !rail.open || !pageJobId) return;
    if (chat.contextJobId || chat.contextResumeId || chat.threadId || chat.messages.length > 0 || chat.streaming || chat.loading) return;
    chat.newChat({ jobId: pageJobId });
    // chat.newChat is stable; the fields above are the whole condition.
  }, [enabled, rail.open, pageJobId, chat.contextJobId, chat.contextResumeId, chat.threadId, chat.messages.length, chat.streaming, chat.loading]);

  // A request that reached the rail while the user may not ask (another
  // area's Ask button, gated on the capability only) is closed once known.
  // After an `ai_unavailable` turn the open rail stays, without AI actions.
  const refuse = enabled && !availability.loading && !availability.canAsk && !availability.blocked;
  useEffect(() => {
    if (refuse && rail.open) rail.close();
  }, [refuse, rail]);

  // Cmd/Ctrl+J toggles the rail (only where Ask is offered, and not on the
  // full page, which is already the Assistant).
  useEffect(() => {
    if (!entryVisible || onAssistantPage) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!isRailShortcut(e)) return;
      e.preventDefault();
      if (rail.open) rail.close();
      else openAssistantRail({ source: 'other' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entryVisible, onAssistantPage, rail]);

  // Which nudge holds is the server's call (real signals only); asked while one could be shown.
  useServerNudge({ enabled: fabOffered, route: pathname });

  // One proactive nudge per session, through the popup gate.
  const { granted } = usePopupGate('assistant:nudge', 'survey', { enabled: !!nudge && fabOffered });
  const showNudge = !!nudge && fabVisible && granted;
  useEffect(() => {
    if (showNudge) markNudgeShown();
  }, [showNudge]);

  if (!enabled) return null;

  const onNavigate = () => {
    if (isNarrow()) rail.close();
  };

  return (
    <>
      {fabVisible ? (
        <button type="button" className={styles.fab} aria-label={t('fab.aria')} onClick={() => openAssistantRail({ source: 'other' })} data-testid="assistant-fab">
          <IconChat size={18} />
          <span className={styles.fabText}>{t('fab.label')}</span>
        </button>
      ) : null}

      {showNudge && nudge ? (
        <div className={styles.nudge} role="dialog" aria-label={t('short')} data-testid="assistant-nudge">
          <p className={styles.nudgeText}>{t(`nudge.${nudge.kind}`)}</p>
          <div className={styles.row}>
            <Btn
              variant="primary"
              onClick={() => {
                clearAssistantNudge();
                openAssistantRail({ source: 'other', jobId: nudge.jobId ?? null, prompt: t(`nudge.prompts.${nudge.kind}`) });
              }}
            >
              {t('nudge.ask')}
            </Btn>
            <Btn variant="ghost" onClick={clearAssistantNudge}>
              {t('nudge.notNow')}
            </Btn>
          </div>
        </div>
      ) : null}

      <Drawer
        open={rail.open && !refuse}
        onClose={rail.close}
        ariaLabel={t('name')}
        title={
          <span className={styles.railTitle}>
            <AssistantAvatar />
            {t('name')}
          </span>
        }
      >
        <CopilotThread
          chat={chat}
          variant="rail"
          prefill={prefill}
          onNavigate={onNavigate}
          canAsk={availability.canAsk}
          checking={availability.loading}
          pageJobId={pageJobId}
          toolbarExtra={
            <>
              {!onAssistantPage ? <FullPageLink threadId={chat.threadId} onNavigate={rail.close} /> : null}
              {entryVisible && memory.fabHidden === false ? (
                <button type="button" className={styles.toolBtn} onClick={memory.hideFab}>
                  {t('toolbar.hideFab')}
                </button>
              ) : null}
            </>
          }
        />
      </Drawer>
    </>
  );
}

export default CopilotRail;
