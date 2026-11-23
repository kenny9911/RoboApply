'use client';

// /alice — Alice, the application agent (docs/alice/ALICE.md §3).
//
// Desktop (1100px and up): the title row, then two tiles side by side: the
// conversation and the canvas (Profile · Jobs · Applications). Below 1100px
// one region at a time, switched by a segmented control under the title:
// Chat · Profile · Jobs · Applications.
//
// Three colours only (alice.module.css): ink, paper, and Alice's blue on her
// own work. The status line under the title states the one thing that matters
// now; it narrates work only while a turn really runs (C38).

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { aliceErrorOf, useAliceApplications, useAliceReminder, useAliceThread, useAliceTurn, type AliceTurnBody } from '../../../hooks/alice/useAlice';
import { AliceMark } from './AliceMark';
import { Conversation } from './Conversation';
import { ProfileView } from './ProfilePanels';
import { ApplicationsPanel, JobsPanel } from './WorkPanels';
import { canvasFor, currentRevision, needsCount, topicProgress, type AliceRegion } from './model';
import s from './alice.module.css';

type CanvasView = Exclude<AliceRegion, 'chat'>;
const CANVAS: readonly CanvasView[] = ['profile', 'jobs', 'applications'];

export function AlicePage() {
  const t = useTranslations('alice');
  const thread = useAliceThread();
  const turn = useAliceTurn();
  const board = useAliceApplications(thread.isSuccess);
  const remind = useAliceReminder();
  const [region, setRegion] = useState<AliceRegion>('chat');
  const [canvas, setCanvas] = useState<CanvasView>('profile');
  const [confirming, setConfirming] = useState(false);
  const last = useRef<AliceTurnBody | null>(null);
  const stage = thread.data?.stage;

  // The canvas follows the work: the profiles while they are being shaped, the jobs once one is saved.
  useEffect(() => {
    if (stage) setCanvas(canvasFor(stage));
  }, [stage]);

  function open(r: AliceRegion) {
    setRegion(r);
    if (r !== 'chat') setCanvas(r);
  }

  function send(body: AliceTurnBody) {
    last.current = body;
    void turn.send(body);
  }

  if (thread.isLoading) {
    return (
      <div className={s.root}>
        <div className={s.titleRow}>
          <div className={s.titleBlock}>
            <AliceMark />
            <h1 className={s.h1}>Alice</h1>
          </div>
        </div>
        <div className={s.full} aria-busy="true">
          <span className={s.skeleton} style={{ width: '40%' }} />
          <span className={s.skeleton} style={{ width: '65%' }} />
        </div>
      </div>
    );
  }

  if (thread.isError || !thread.data) {
    const err = aliceErrorOf(thread.error);
    const key = err.reason === 'alice_not_ready' ? 'notReady' : err.reason === 'alice_ai_off' || err.code === 'ai_unavailable' ? 'aiOff' : 'loadFailed';
    return (
      <div className={s.root}>
        <div className={s.titleRow}>
          <div className={s.titleBlock}>
            <AliceMark />
            <div className={s.titleLine}>
              <h1 className={s.h1}>Alice</h1>
              <span className={s.tag}>{t('tag')}</span>
            </div>
          </div>
        </div>
        <div className={s.full} role="alert">
          <h2 className={s.h2}>{t(`unavailable.${key}.title` as never)}</h2>
          <p className={s.lead}>{t(`unavailable.${key}.body` as never)}</p>
          {key === 'loadFailed' ? (
            <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => void thread.refetch()}>
              {t('errors.retry')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const data = thread.data;
  const busy = turn.running !== null;
  const needs = needsCount(board.data);
  const { done, total } = topicProgress(data);
  const status = busy
    ? t('status.working')
    : data.stage === 'intake'
      ? t('status.intake', { done, total })
      : data.stage === 'choosing'
        ? t('status.choosing')
        : data.stage === 'refining'
          ? t('status.refining', { version: currentRevision(data)?.version ?? 1 })
          : needs
            ? t('status.savedNeeds', { count: needs })
            : t('status.saved');

  const canvasBody =
    canvas === 'profile' ? (
      <ProfileView thread={data} busy={busy} onSend={send} onOpen={open} />
    ) : canvas === 'jobs' ? (
      <JobsPanel thread={data} onAsk={() => open('chat')} />
    ) : (
      <ApplicationsPanel />
    );

  const tabLabel = (view: AliceRegion) => (
    <>
      {t(`tabs.${view}` as never)}
      {view === 'applications' && needs ? <span className={`${s.count} ${s.countAlice}`}>{needs}</span> : null}
    </>
  );

  return (
    <div className={s.root}>
      <header className={s.titleRow}>
        <div className={s.titleBlock}>
          <AliceMark live={busy} />
          <div className={s.titleText}>
            <div className={s.titleLine}>
              <h1 className={s.h1}>Alice</h1>
              <span className={s.tag}>{t('tag')}</span>
            </div>
            <p className={busy ? `${s.status} ${s.statusLive}` : s.status} aria-live="polite">
              {status}
            </p>
          </div>
        </div>
        {confirming ? (
          <div className={s.actions}>
            <span className={s.meta}>{t('restartConfirm')}</span>
            <button
              type="button"
              className={`${s.btn} ${s.btnSmall} ${s.primary}`}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setRegion('chat');
                send({ kind: 'restart' });
              }}
            >
              {t('restart')}
            </button>
            <button type="button" className={`${s.btn} ${s.btnSmall}`} onClick={() => setConfirming(false)}>
              {t('cancel')}
            </button>
          </div>
        ) : (
          <button type="button" className={s.textBtn} disabled={busy} onClick={() => setConfirming(true)}>
            {t('restart')}
          </button>
        )}
      </header>

      <div className={s.switch} role="tablist" aria-label={t('tabs.aria')}>
        {(['chat', ...CANVAS] as AliceRegion[]).map((view) => (
          <button key={view} type="button" role="tab" className={s.tab} aria-selected={region === view} onClick={() => open(view)}>
            {tabLabel(view)}
          </button>
        ))}
      </div>

      <div className={s.workspace}>
        <Conversation
          hidden={region !== 'chat'}
          thread={data}
          running={turn.running}
          steps={turn.steps}
          error={turn.error}
          onSend={send}
          onOpen={open}
          onRemind={(entryId, date) => remind.mutate({ entryId, date }, { onSuccess: () => void thread.refetch() })}
          reminderBusy={remind.isPending}
          onRetry={last.current ? () => send(last.current!) : null}
        />
        <section className={`${s.canvas} ${s.region}`} data-hidden={region === 'chat' ? 'true' : undefined} aria-label={t(`tabs.${canvas}` as never)}>
          <div className={s.canvasHead}>
            <div className={s.canvasTabs} role="tablist" aria-label={t('tabs.aria')}>
              {CANVAS.map((view) => (
                <button key={view} type="button" role="tab" className={s.tab} aria-selected={canvas === view} onClick={() => setCanvas(view)}>
                  {tabLabel(view)}
                </button>
              ))}
            </div>
          </div>
          <div className={s.canvasBody}>{canvasBody}</div>
        </section>
      </div>
    </div>
  );
}
