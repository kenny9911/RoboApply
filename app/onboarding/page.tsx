'use client';

// /onboarding — Onboarding Chat v4 (replaces the V3 3-step wizard).
//
// Two-phase shell:
//   S0  resume_select — ResumeSelectPanel (pick existing / upload / paste)
//   S1–S4 chat        — OnboardingChat, driven entirely by server NDJSON
//                       stream events (greeting → elicitation → recommend →
//                       wrap). Client `state` is a pure echo of the server —
//                       the only client-side transition is resume_select ↔
//                       chat.
//
// Mount: GET /onboarding/session → 200 restores the active session (≤7 days)
// into the chat; 404 shows S0. Picking a variant POSTs /onboarding/bootstrap
// (real ingest rows + LLM opening prompt + resume-grounded chips), and the
// page flips to chat immediately — IngestRecap shows a skeleton while the
// bootstrap is in flight. Completion (wrap CTA or an aggressiveness
// quick-reply short-circuit) POSTs /onboarding/complete server-side — the
// old client-side targetTitle split hack and DEFAULT_DAILY_CAP are gone.
// Skip POSTs /onboarding/skip then always routes /home.
//
// This route stays OUTSIDE the (auth) route group (fullscreen overlay, no
// Sidebar/Topbar); auth is enforced by proxy.ts (cookie presence only) plus
// the AuthGate in ./layout.tsx (real session validity via /auth/me).

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  OnboardTop,
  ResumeSelectPanel,
  OnboardingChat,
  type OnboardingStage,
} from '../../components/v3/onboarding';
import { useOnboardingChat } from '../../hooks/useOnboardingChat';
import { useJobApplyingEnabled } from '../../lib/jobApplying';
import { raV2Api } from '../../lib/api/v2';
import { RoboApiError } from '../../lib/api/client';
import type {
  IngestRow,
  OnboardingSessionResponse,
  RAAggressiveness,
} from '../../lib/api/v2/types';

type Phase = 'loading' | 'resume_select' | 'chat';

export default function OnboardingPage() {
  const router = useRouter();
  const locale = useLocale();
  const qc = useQueryClient();
  const chat = useOnboardingChat();

  // Job-applying off → the auto-apply onboarding is skipped entirely; send the
  // user straight to the Resume Builder. Only act on a known `false` so an
  // enabled deploy never bounces (and we don't redirect mid-load).
  const jobApplyingEnabled = useJobApplyingEnabled();
  useEffect(() => {
    if (jobApplyingEnabled === false) router.replace('/resumes');
  }, [jobApplyingEnabled, router]);

  const [phase, setPhase] = useState<Phase>('loading');
  const [ingestRows, setIngestRows] = useState<IngestRow[] | null>(null);
  const [openingPrompt, setOpeningPrompt] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [restoredPassedIds, setRestoredPassedIds] = useState<string[]>([]);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  // ── Session restore (once on mount). 404 → S0; payload is backend-
  //    localized, so the locale is part of the key (useQueue convention). ──
  const sessionQuery = useQuery<OnboardingSessionResponse | null>({
    queryKey: ['v3', 'onboarding', 'session', locale],
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    // Don't bootstrap an onboarding session when job-applying is off.
    enabled: jobApplyingEnabled !== false,
    queryFn: async () => {
      try {
        return await raV2Api.onboarding.getSession();
      } catch (err) {
        if (err instanceof RoboApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

  useEffect(() => {
    if (hydratedRef.current) return;
    if (sessionQuery.isPending) return;
    hydratedRef.current = true;
    const session = sessionQuery.data;
    if (session) {
      chat.hydrateFromSession(session);
      setIngestRows(session.ingestRows);
      setOpeningPrompt(session.openingPrompt ?? null);
      setRestoredPassedIds(session.passedJobIds);
      setRestored(true);
      setPhase('chat');
    } else {
      // 404 (no active session) and transport errors both land on S0 — the
      // user can always start fresh.
      setPhase('resume_select');
    }
  }, [sessionQuery.isPending, sessionQuery.data, chat]);

  // ── Bootstrap: variant chosen → create the session, flip to chat. ──
  const bootstrapMutation = useMutation({
    mutationFn: (resumeVariantId: string) =>
      raV2Api.onboarding.bootstrap({ resumeVariantId }),
    onSuccess: (data) => {
      // The cached restore payload (staleTime: Infinity) now describes a
      // superseded session — evict every locale's copy so a remount
      // refetches the real active one.
      qc.removeQueries({ queryKey: ['v3', 'onboarding', 'session'] });
      chat.seedFromBootstrap(data);
      setIngestRows(data.ingestRows);
      setOpeningPrompt(data.openingPrompt);
      setRestored(false);
      setRestoredPassedIds([]);
      setPhase('chat');
    },
    onError: (err) => {
      setPhase('resume_select');
      const raw =
        err instanceof RoboApiError
          ? (err.payload as { code?: string } | undefined)?.code
          : undefined;
      setBootstrapError(
        raw === 'session_daily_limit' ||
          (err instanceof RoboApiError && err.status === 429)
          ? 'daily_limit'
          : 'bootstrap_failed',
      );
    },
  });

  function handleResumeReady(resumeVariantId: string) {
    setBootstrapError(null);
    setIngestRows(null); // skeleton while the bootstrap is in flight
    setPhase('chat');
    bootstrapMutation.mutate(resumeVariantId);
  }

  // ── Complete: server-side persistence, then hand off to /home. ──
  const completeMutation = useMutation({
    mutationFn: (aggressiveness: RAAggressiveness) => {
      const sessionId = chat.state.sessionId;
      if (!sessionId) throw new Error('no session');
      return raV2Api.onboarding.complete({ sessionId, aggressiveness });
    },
    onSuccess: () => {
      // The session is now completed — evict the Infinity-stale restore
      // cache (all locales) so back-navigation can't rehydrate a zombie.
      qc.removeQueries({ queryKey: ['v3', 'onboarding', 'session'] });
      // The home feed benefits immediately from the warmed score rows.
      void qc.invalidateQueries({ queryKey: ['v2', 'goal'] });
      void qc.invalidateQueries({ queryKey: ['v3', 'preferences'] });
      void qc.invalidateQueries({ queryKey: ['v2', 'home', 'jobs'] });
      router.push('/home');
    },
  });

  // ── Skip: flush what's confirmed server-side; ALWAYS route home. ──
  const skipMutation = useMutation({
    mutationFn: () =>
      raV2Api.onboarding.skip(
        chat.state.sessionId ? { sessionId: chat.state.sessionId } : undefined,
      ),
    onSettled: () => {
      // Skip marks the session skipped server-side — evict the
      // Infinity-stale restore cache (all locales) before routing home.
      qc.removeQueries({ queryKey: ['v3', 'onboarding', 'session'] });
      router.push('/home');
    },
  });

  // ── 4-dot progress stage (Resume → Chat → Matches → Done). ──
  const hasCards = chat.state.items.some((item) => item.kind === 'cards');
  const stage: OnboardingStage =
    phase !== 'chat'
      ? 'resume'
      : chat.state.state === 'wrap'
        ? 'done'
        : hasCards
          ? 'matches'
          : 'chat';

  // Job-applying off → render nothing while the effect above redirects to
  // /resumes (avoids flashing the auto-apply onboarding).
  if (jobApplyingEnabled === false) return null;

  return (
    <div className="onboard">
      <OnboardTop
        stage={stage}
        onSkip={() => skipMutation.mutate()}
        skipping={skipMutation.isPending}
      />

      <div className="onboard-main">
        <div
          className="onboard-card"
          style={
            phase === 'chat'
              ? {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  height: '100%',
                  maxHeight: 'calc(100vh - 140px)',
                }
              : undefined
          }
        >
          {phase === 'loading' ? (
            <div className="ingest-row pending" style={{ justifyContent: 'center' }}>
              <div className="ic">
                <div className="spinner" />
              </div>
            </div>
          ) : null}

          {phase === 'resume_select' ? (
            <ResumeSelectPanel
              onReady={handleResumeReady}
              busy={bootstrapMutation.isPending}
              errorCode={bootstrapError}
            />
          ) : null}

          {phase === 'chat' ? (
            <OnboardingChat
              chat={chat}
              ingestRows={ingestRows}
              openingPrompt={openingPrompt}
              initialPassedJobIds={restoredPassedIds}
              restored={restored}
              onComplete={(aggressiveness) =>
                completeMutation.mutate(aggressiveness)
              }
              completing={completeMutation.isPending}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
