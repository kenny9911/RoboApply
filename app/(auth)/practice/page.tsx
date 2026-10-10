'use client';

// /practice — SETUP, wired to the real-time Interview Engine.
//
// This file owns the state and the engine calls; PracticeSetupFlow owns the
// screen. On launch it creates a real InterviewSession via the Interview
// Engine (LiveKit voice) and routes to the live room. The engine's persona ids
// are aligned to this catalog's interviewer ids, so the selection maps 1:1.
//
// WP-43 (practice from any job):
//   - `/practice?job=<id>[&resume=<id>]` (hooks/shared/useLaunchPractice)
//     prefills the role, company and posting from the server, which also
//     picks the resume (the job's tailored one, else the primary) and
//     market-checks the job (404 → a one-line notice).
//   - Sessions are created through `practiceApi.create`: the server loads the
//     job, the PII-redacted resume and the recording consent itself.
//   - Recording is off unless turned on in the RecordingConsentSheet (H8).
//   - A 402 opens the shared out-of-credits sheet; when the free first
//     practice still waits on verification, a notice says how to get it.
//   - GoApply without voice offers the written practice with a one-line reason.
//     It runs through the first-party practice routes: the server checks the
//     GoApply gate, loads the job, meters credits and ticks the checklist.
//   - The market-requirements preview (web search + LLM) is offered only
//     where AI is allowed, and not on GoApply until a domestic search path
//     exists (WP-63a).
//   - The setup may grant the free first practice; the balance is refetched
//     when it does, so Start is not left disabled.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RoboApiError } from '../../../lib/api/client';
import { accountKeys, useCredits } from '../../../hooks/useAccount';
import { useBrand } from '../../../lib/brand';
import { useCredits as useCreditSummary } from '../../../hooks/shared/useCredits';
import { reportCreditsExhausted } from '../../../hooks/shared/useCreditGate';
import { useFlag } from '../../../lib/flags';
import {
  PracticeJobBanner,
  PracticeNotices,
  RecordingConsentSheet,
  RecordingRow,
  TextPracticeRoom,
  setupNotices,
} from '../../../components/features/practice';

import { useMockCatalog } from '../../../hooks/useMockV3';
import {
  PracticeSetupFlow,
  PracticeSetupError,
  PracticeSetupSkeleton,
  JD_MIN_CHARS,
  type RoleSourceMode,
} from '../../../components/v3/mock';
import { useInterviewPreview } from '../../../hooks/useInterviewPreview';
import { recommendationsForRole } from '../../../lib/interviewRecommendations';
import { useMockRoleLabels } from '../../../lib/mockRoleLabels';
import { formatRelativeTime } from '../../../lib/relativeTime';
import { INTERVIEW_LOCALES } from '../../../lib/localeConfig';
import {
  mockCreditsForMinutes,
  normalizeMockCreditMinutes,
} from '../../../lib/mockInterviewCredits';
import { useAuth } from '../../../lib/auth/AuthProvider';
import type { RAMockFormat, RAMockSessionSummary } from '../../../lib/api/v2/types';
import {
  ieErrorInfo,
  interviewEngineApi,
  practiceApi,
  practiceErrorInfo,
  type IESessionSummary,
  type PracticeCreateBody,
  type PracticeFirstState,
  type PracticeRecordingRequest,
  type PracticeSetupJob,
} from '../../../lib/api/interviewEngine';

const DEFAULT_DURATION_MINUTES = 30;

/** Read once on mount: `?job=`, `?resume=` (WP-43 route contract). */
function readJobParams(): { job: string | null; resume: string | null } {
  if (typeof window === 'undefined') return { job: null, resume: null };
  const params = new URLSearchParams(window.location.search);
  const clip = (v: string | null) => (v && v.trim() ? v.trim().slice(0, 64) : null);
  return { job: clip(params.get('job')), resume: clip(params.get('resume')) };
}

interface TextRun {
  jobId: string | null;
  role: string;
  interviewerId: string;
  typeId: string;
  language: string;
  durationMinutes: number;
}

/** Cheap client-side working title from a pasted JD — the first meaningful
 *  line, clipped. The backend blueprint agent infers the canonical title; this
 *  is only what we surface to the user before launch. */
function deriveRoleLabelFromJd(jd: string): string {
  const firstLine =
    jd
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find(Boolean) ?? '';
  return (firstLine || jd.trim()).slice(0, 60).trim();
}

export default function MockSetupPage() {
  const t = useTranslations('practice');
  const { localizeRole, localizeType } = useMockRoleLabels();
  const router = useRouter();
  const { user } = useAuth();
  const brand = useBrand();
  const queryClient = useQueryClient();

  const catalogQuery = useMockCatalog();
  const catalog = catalogQuery.data?.catalog;
  const defaultedTargetRef = useRef<string | null>(null);
  const replayHydratedRef = useRef(false);
  const replayTargetRef = useRef<string | null>(null);

  // WP-43: the job (and the resume the interviewer reads) come from the
  // server. The params are read after mount so the first frame stays stable.
  const [jobParams, setJobParams] = useState<{ job: string | null; resume: string | null } | null>(null);
  useEffect(() => {
    setJobParams(readJobParams());
  }, []);
  const setupQuery = useQuery({
    queryKey: ['practice', 'setup', jobParams?.job ?? null, jobParams?.resume ?? null],
    queryFn: () => practiceApi.setup({ job: jobParams?.job, resume: jobParams?.resume }),
    enabled: jobParams !== null,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const setup = setupQuery.data ?? null;
  // The setup tops up the free first practice; when it just did, the balance
  // fetched on mount is stale (Start would stay disabled). Refetch it once.
  const grantRefreshedRef = useRef(false);
  useEffect(() => {
    if (grantRefreshedRef.current || setup?.firstPractice.grant !== 'granted') return;
    grantRefreshedRef.current = true;
    void queryClient.invalidateQueries({ queryKey: accountKeys.credits() });
  }, [setup, queryClient]);
  const jobNotFound = setupQuery.isError && practiceErrorInfo(setupQuery.error).code === 'job_not_found';
  const [job, setJob] = useState<PracticeSetupJob | null>(null);
  const prefilledJobRef = useRef<string | null>(null);

  const [recording, setRecording] = useState<PracticeRecordingRequest>({ audio: false, video: false });
  const [recordingSheetOpen, setRecordingSheetOpen] = useState(false);
  const [firstPracticeFrom402, setFirstPracticeFrom402] = useState<PracticeFirstState | null>(null);
  const [textRun, setTextRun] = useState<TextRun | null>(null);
  const showQuestionsLink = useFlag('interviewBank');
  const creditSummary = useCreditSummary();

  // Recent sessions come from the engine (completed voice interviews), mapped to
  // the strip's shape using the catalog for display names.
  const [recent, setRecent] = useState<IESessionSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    interviewEngineApi.recent()
      .then((r) => { if (!cancelled) setRecent(r.sessions); })
      .catch(() => { /* strip just stays empty */ });
    return () => { cancelled = true; };
  }, []);

  // ── Selection state ──
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [role, setRole] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<RoleSourceMode>('role');
  const [jdText, setJdText] = useState('');
  const [interviewerId, setInterviewerId] = useState<string | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  // Default to Video — the recommended, most realistic format (eye contact +
  // body language practice). The candidate can switch to voice-only.
  const [format, setFormat] = useState<RAMockFormat>('video');

  // WP-43: prefill once from the job — the posting becomes the brief and the
  // job title the role. The user can still edit the post or drop the job.
  useEffect(() => {
    const next = setup?.job ?? null;
    if (!next || prefilledJobRef.current === next.id) return;
    prefilledJobRef.current = next.id;
    setJob(next);
    setSourceMode('jd');
    setJdText(next.jdText);
    setRole(null);
  }, [setup]);

  function clearJob() {
    setJob(null);
    setJdText('');
    setSourceMode('role');
  }

  // Pre-launch market-requirements preview (mutation = user-triggered only).
  const previewMut = useInterviewPreview();

  // Default the interview language to the language the user is using the app in
  // (their selected UI locale), tolerant of region variants: zh-CN → zh,
  // en-US → en, etc. Falls back to English only if nothing matches.
  //
  // Matched against INTERVIEW_LOCALES, not READY_LOCALES: the voice engine
  // speaks all nine locales, and clamping to the translated-chrome subset
  // silently seeded a ko / es / fr / pt / de user to an English interviewer.
  const uiLocale = useLocale();
  const [language, setLanguage] = useState<string>(() => {
    const base = uiLocale.split('-')[0];
    const match =
      INTERVIEW_LOCALES.find((l) => l.code === uiLocale) ??
      INTERVIEW_LOCALES.find((l) => l.code === base) ??
      INTERVIEW_LOCALES.find((l) => l.code.split('-')[0] === base);
    return match?.code ?? 'en';
  });
  const [durationOverride, setDurationOverride] = useState<number | null>(null);

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<'network' | 'busy' | 'generic' | null>(null);
  const [insufficientCredits, setInsufficientCredits] = useState<{ balance: number; required: number } | null>(null);
  const creditsQ = useCredits();

  // Restore a whole saved plan (a past session, or a report's "Run it again"
  // link) onto the brief. Every id is validated against the CURRENT catalog, so
  // a retired persona or type simply falls back to today's recommendation
  // instead of launching an interview the engine can't build.
  //
  // Shared by the ?role=… URL hydration below and the recent-practice lane, so
  // both paths restore exactly the same fields.
  const applyPlan = useCallback((plan: {
    role: string;
    interviewer?: string | null;
    type?: string | null;
    mode?: string | null;
    language?: string | null;
    duration?: number | null;
  }): boolean => {
    if (!catalog) return false;
    const planRole = plan.role.trim();
    const category = catalog.roleCategories.find((item) => item.roles.includes(planRole));
    if (!planRole || !category) return false;

    const planInterviewer = catalog.interviewers.find((item) => item.id === plan.interviewer)?.id ?? null;
    const planType = catalog.types.find((item) => item.id === plan.type)?.id ?? null;
    const planDuration =
      typeof plan.duration === 'number' && Number.isInteger(plan.duration) && plan.duration >= 5 && plan.duration <= 120
        ? plan.duration
        : null;

    setSourceMode('role');
    setQuery('');
    setActiveCategory(category.name);
    setRole(planRole);
    setInterviewerId(planInterviewer);
    setTypeId(planType);
    if (plan.mode === 'video' || plan.mode === 'voice') setFormat(plan.mode);
    if (INTERVIEW_LOCALES.some((locale) => locale.code === plan.language)) {
      setLanguage(plan.language as string);
    }
    setDurationOverride(planDuration);
    setInsufficientCredits(null);
    setStartError(null);

    // A complete saved plan should survive the role-aware defaulting effect.
    // Partial or stale plans intentionally fall back to current recommendations.
    const target = planInterviewer && planType ? `role:${planRole}` : null;
    replayTargetRef.current = target;
    defaultedTargetRef.current = target;
    return true;
  }, [catalog]);

  // A report's "Run it again" action carries the last interview plan in the
  // URL. Hydrate it after the catalog is ready, while keeping the
  // server-rendered first frame stable.
  useEffect(() => {
    if (!catalog || replayHydratedRef.current || typeof window === 'undefined') return;
    replayHydratedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const parsedDuration = Number(params.get('duration'));
    applyPlan({
      role: params.get('role')?.trim() ?? '',
      interviewer: params.get('interviewer'),
      type: params.get('type'),
      mode: params.get('mode'),
      language: params.get('language'),
      duration: Number.isFinite(parsedDuration) ? parsedDuration : null,
    });
  }, [catalog, applyPlan]);

  const effectiveCategory = activeCategory || catalog?.roleCategories[0]?.name || '';

  function changeCategory(nextCategory: string) {
    setActiveCategory(nextCategory);
    setQuery('');

    const category = catalog?.roleCategories.find((item) => item.name === nextCategory);
    if (role && category && !category.roles.includes(role)) {
      setRole(null);
      defaultedTargetRef.current = null;
    }
  }

  function selectRole(nextRole: string) {
    setRole(nextRole);
    const category = catalog?.roleCategories.find((item) => item.roles.includes(nextRole));
    if (category) setActiveCategory(category.name);

    if (catalog) {
      const nextRecommendations = recommendationsForRole(nextRole, catalog.roleCategories);
      setInterviewerId(
        nextRecommendations?.personaIds[0] ??
        catalog.interviewers.find((item) => item.id === 'maya')?.id ??
        catalog.interviewers[0]?.id ??
        null,
      );
      setTypeId(
        nextRecommendations?.typeIds[0] ??
        catalog.types.find((item) => item.id === 'behavioral')?.id ??
        catalog.types[0]?.id ??
        null,
      );
      setDurationOverride(null);
      defaultedTargetRef.current = `role:${nextRole}`;
    }
  }

  const interviewer = useMemo(
    () => catalog?.interviewers.find((i) => i.id === interviewerId) ?? null,
    [catalog, interviewerId],
  );
  const type = useMemo(
    () => catalog?.types.find((tp) => tp.id === typeId) ?? null,
    [catalog, typeId],
  );

  // Role-aware recommendations: which formats + interviewers suit the chosen
  // role (browse mode only — a pasted JD has no catalog category). Pure UI sugar.
  const recs = useMemo(
    () => (sourceMode === 'role' ? recommendationsForRole(role, catalog?.roleCategories ?? []) : null),
    [role, sourceMode, catalog],
  );

  const durationMinutes = durationOverride ?? type?.minutes ?? DEFAULT_DURATION_MINUTES;

  // The effective role comes from EITHER the picked chip (browse) or the pasted
  // JD's working title — a single source of truth for launch + the LaunchBar.
  const jdTrimmed = jdText.trim();
  // A job practice keeps the job's title and works even when the stored post
  // is short: the server loads the job itself.
  const jobActive = !!job && sourceMode === 'jd';
  const effectiveRole = jobActive
    ? job!.title
    : sourceMode === 'jd' ? (jdTrimmed ? deriveRoleLabelFromJd(jdTrimmed) : null) : role;
  const hasRoleSource = jobActive || (sourceMode === 'role' ? !!role : jdTrimmed.length >= JD_MIN_CHARS);
  // GoApply gates (server-decided): no AI practice without a phone / consent;
  // without voice, the practice runs in writing.
  const aiBlocked = setup ? !setup.ai.allowed : false;
  const textMode = !!setup && setup.ai.allowed && !setup.voice.available && setup.voice.reason === 'voice_unavailable';
  const canLaunch = !!(interviewer && type && hasRoleSource) && !aiBlocked;
  // The preview runs a web search and an LLM on the post: only where AI is
  // allowed, and not on GoApply (the search provider is international) until
  // WP-63a gives it a domestic path. It never gates launch.
  const showPreview = brand.market !== 'cn';
  const canPreview = showPreview && !!(interviewer && type && hasRoleSource) && !aiBlocked;
  const targetKey = hasRoleSource
    ? jobActive
      ? `job:${job!.id}`
      : sourceMode === 'role'
        ? `role:${role}`
        : `jd:${deriveRoleLabelFromJd(jdTrimmed)}`
    : null;

  // Once the target is known, build a sensible plan immediately. Role-aware
  // recommendations win; pasted descriptions use the catalog's familiar Maya
  // + behavioral defaults. A new target gets a newly matched plan exactly once,
  // while manual changes remain untouched for as long as that target stays put.
  useEffect(() => {
    if (!catalog || !targetKey) {
      // The URL prefill effect runs earlier in this same commit, before the
      // selected role has rendered. Preserve its complete plan for that one
      // transition instead of immediately clearing it as a missing target.
      if (replayTargetRef.current) return;
      defaultedTargetRef.current = null;
      return;
    }
    if (replayTargetRef.current === targetKey) {
      replayTargetRef.current = null;
      defaultedTargetRef.current = targetKey;
      return;
    }
    if (defaultedTargetRef.current === targetKey) return;
    defaultedTargetRef.current = targetKey;

    const nextPersonaId =
      recs?.personaIds[0] ??
      catalog.interviewers.find((item) => item.id === 'maya')?.id ??
      catalog.interviewers[0]?.id ??
      null;
    const nextTypeId =
      recs?.typeIds[0] ??
      catalog.types.find((item) => item.id === 'behavioral')?.id ??
      catalog.types[0]?.id ??
      null;

    setInterviewerId(nextPersonaId);
    setTypeId(nextTypeId);
    setDurationOverride(null);
  }, [catalog, recs, targetKey]);

  // A preview is only valid for the exact inputs it was generated from. If any
  // of them changes, drop the stale result so the panel can't misrepresent what
  // launch will actually run.
  useEffect(() => {
    previewMut.reset();
    // previewMut.reset is stable (react-query); only the inputs should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, jdText, interviewerId, typeId, language, sourceMode]);

  const recentSummaries: RAMockSessionSummary[] = useMemo(() => {
    if (!catalog) return [];
    return recent
      .filter((s) => s.status === 'completed')
      .map((s) => ({
        id: s.id,
        role: localizeRole(s.role),
        // Persona names are proper nouns (Maya, Dr. Voss) — only the "no such
        // persona" fallback needs translating. Type labels ride the same
        // setup.types.<id> keys the TypePicker renders.
        interviewerName:
          catalog.interviewers.find((i) => i.id === s.personaId)?.name ??
          t('setup.recent.unknownInterviewer'),
        typeLabel: localizeType(
          s.interviewType,
          'label',
          catalog.types.find((tp) => tp.id === s.interviewType)?.label ?? s.interviewType,
        ),
        score: s.overall ?? 0,
        when: formatRelativeTime(s.endedAt ?? s.createdAt, uiLocale),
        note: '',
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, catalog, uiLocale]);

  function replay(sessionId: string) {
    router.push(`/practice/${sessionId}/report`);
  }

  // "Practice this again" — restore that session's whole plan onto the brief.
  // It stops short of launching: a new interview spends credits, so the
  // candidate still presses Start.
  function repeat(sessionId: string) {
    const past = recent.find((item) => item.id === sessionId);
    if (!past) return;
    applyPlan({
      role: past.role,
      interviewer: past.personaId,
      type: past.interviewType,
      mode: past.mode,
      language: past.language,
      duration: past.durationMinutes,
    });
  }

  // Delete a past session + its recording. Optimistic: drop it from the list
  // right away; if the server delete fails, re-sync from the server's truth.
  async function removeSession(sessionId: string) {
    setRecent((rows) => rows.filter((r) => r.id !== sessionId));
    try {
      await interviewEngineApi.remove(sessionId);
    } catch {
      interviewEngineApi
        .recent()
        .then((r) => setRecent(r.sessions))
        .catch(() => { /* keep the optimistic state */ });
    }
  }

  /**
   * A start the server refused for a reason this page shows: out of credits
   * (the shared sheet + inline shortfall + how to get the free first one), an
   * unknown job, or the GoApply gate. True = handled.
   */
  function handleRefusal(err: unknown): boolean {
    const info = ieErrorInfo(err);
    const practice = practiceErrorInfo(err);
    if (info.code === 'insufficient_credits') {
      const p = (err instanceof RoboApiError ? err.payload : {}) as { balance?: number; required?: number };
      setInsufficientCredits({ balance: p.balance ?? 0, required: p.required ?? 0 });
      setFirstPracticeFrom402(practice.firstPractice);
      reportCreditsExhausted({
        bucket: 'practice',
        resetsAt: null,
        upgradable: creditSummary.data?.summary.upgradable === true,
      });
      void queryClient.invalidateQueries({ queryKey: accountKeys.credits() });
      return true;
    }
    if (practice.code === 'job_not_found') {
      clearJob();
      setStartError('generic');
      return true;
    }
    if (practice.code === 'phone_binding_required' || (practice.code === 'ai_unavailable' && practice.reason !== 'voice_unavailable')) {
      void setupQuery.refetch();
      setStartError('generic');
      return true;
    }
    return false;
  }

  async function launch() {
    if (!canLaunch || !canAfford || !interviewer || !type) return;
    setStartError(null);
    setInsufficientCredits(null);
    setFirstPracticeFrom402(null);
    if (textMode) {
      // GoApply without voice: the written practice runs on this page, for
      // the job when there is one (the server loads it and meters the run).
      setTextRun({
        jobId: jobActive ? job!.id : null,
        role: effectiveRole ?? '',
        interviewerId: interviewer.id,
        typeId: type.id,
        language,
        durationMinutes,
      });
      return;
    }
    setStarting(true);
    try {
      const body: PracticeCreateBody = {
        role: effectiveRole ?? '',
        jdText: sourceMode === 'jd' ? jdTrimmed : undefined,
        interviewType: type.id,
        personaId: interviewer.id,
        mode: format,
        language,
        durationMinutes,
        candidateName: user?.name ?? undefined,
        // The server loads the job, picks and redacts the resume, and checks
        // the recording consent itself.
        jobId: jobActive ? job!.id : null,
        resumeId: jobParams?.resume ?? null,
        recording: { audio: recording.audio, video: recording.audio && recording.video && format === 'video' },
      };
      // The server answers as soon as the session row exists (status
      // 'preparing'); the interview plan is written while the live page shows
      // its own progress, so navigate straight away.
      const { session } = await practiceApi.create(body);
      router.push(`/practice/${session.id}`);
    } catch (err) {
      const info = ieErrorInfo(err);
      if (handleRefusal(err)) {
        // Shown on the page (sheet, notice or start error).
      } else if (info.network) {
        setStartError('network');
      } else if (info.code === 'llm_unavailable' || info.code === 'worker_unavailable' || info.status === 503) {
        // An older API still writes the plan inside create and answers 503
        // when the language service is down.
        setStartError('busy');
      } else {
        setStartError('generic');
      }
      setStarting(false);
    }
  }

  // Mirror the server's runtime credit policy. The optional-field fallback is
  // only for a rolling deployment where the frontend reaches an older API.
  const creditMinutes = normalizeMockCreditMinutes(creditsQ.data?.creditMinutes);
  const creditCost = mockCreditsForMinutes(durationMinutes, creditMinutes);
  const canAfford = creditsQ.data === undefined || creditsQ.data.balance + 1e-9 >= creditCost;

  // Fetch the market-grounded requirements preview for the current selection.
  // User-triggered (the panel's Preview button); never auto-fires.
  function runPreview() {
    if (!canPreview || !interviewer || !type) return;
    previewMut.mutate({
      role: sourceMode === 'role' ? role ?? undefined : undefined,
      jdText: sourceMode === 'jd' ? jdTrimmed : undefined,
      interviewType: type.id,
      personaId: interviewer.id,
      language,
    });
  }

  if (textRun) {
    return (
      <TextPracticeRoom
        jobId={textRun.jobId}
        onStartRefused={(err) => {
          if (!handleRefusal(err)) return false;
          setTextRun(null);
          return true;
        }}
        role={textRun.role}
        interviewerId={textRun.interviewerId}
        typeId={textRun.typeId}
        language={textRun.language}
        durationMinutes={textRun.durationMinutes}
        onExit={() => setTextRun(null)}
      />
    );
  }

  if (catalogQuery.isError) {
    return <PracticeSetupError onRetry={() => void catalogQuery.refetch()} />;
  }

  if (catalogQuery.isLoading || !catalog) {
    return <PracticeSetupSkeleton />;
  }

  const notices = setupNotices({
    setup,
    jobNotFound,
    creditsShort: !canAfford,
    firstPracticeFrom402,
  });
  const recordingChoice: PracticeRecordingRequest = {
    audio: recording.audio,
    video: recording.audio && recording.video && format === 'video',
  };

  return (
    <>
    <PracticeSetupFlow
      topSlot={
        <>
          {jobActive && job ? (
            <PracticeJobBanner job={job} resume={setup?.resume ?? null} onClear={clearJob} />
          ) : null}
          <PracticeNotices kinds={notices} />
        </>
      }
      introAside={
        showQuestionsLink ? <Link href="/practice/questions">{t('questionsLink')}</Link> : null
      }
      dockSlot={
        setup && hasRoleSource && !textMode ? (
          <RecordingRow
            available={setup.recording.available}
            choice={recordingChoice}
            onChange={() => setRecordingSheetOpen(true)}
          />
        ) : null
      }
      startLabel={textMode ? t('gate.startText') : undefined}
      categories={catalog.roleCategories}
      totalRoles={catalog.totalRoles}
      query={query}
      onQueryChange={setQuery}
      activeCategory={effectiveCategory}
      onCategoryChange={changeCategory}
      selectedRole={role}
      effectiveRole={effectiveRole}
      onSelectRole={selectRole}
      sourceMode={sourceMode}
      onSourceModeChange={setSourceMode}
      jdText={jdText}
      onJdTextChange={setJdText}
      hasRoleSource={hasRoleSource}
      interviewers={catalog.interviewers}
      selectedInterviewerId={interviewerId}
      onSelectInterviewer={setInterviewerId}
      recommendedPersonaIds={recs?.personaIds}
      types={catalog.types}
      selectedTypeId={typeId}
      onSelectType={(value) => {
        setTypeId(value);
        setInsufficientCredits(null);
      }}
      recommendedTypeIds={recs?.typeIds}
      format={format}
      onFormatChange={setFormat}
      language={language}
      onLanguageChange={setLanguage}
      durationMinutes={durationMinutes}
      onDurationChange={(value) => {
        setDurationOverride(value);
        setInsufficientCredits(null);
      }}
      recentSessions={recentSummaries}
      onReplay={(session) => replay(session.id)}
      onRepeat={(session) => repeat(session.id)}
      onDelete={(session) => void removeSession(session.id)}
      previewState={previewMut.isPending ? 'loading' : previewMut.isError ? 'error' : previewMut.data ? 'ready' : 'idle'}
      requirements={previewMut.data?.requirements ?? null}
      webSources={previewMut.data?.webSources ?? []}
      sampleQuestions={previewMut.data?.sampleQuestions ?? []}
      groundedOn={previewMut.data?.groundedOn}
      showPreview={showPreview}
      canPreview={canPreview}
      onPreview={runPreview}
      onRetryPreview={runPreview}
      creditCost={creditCost}
      creditMinutes={creditMinutes}
      creditsRemaining={creditsQ.data?.balance}
      // The written practice is metered like a live one (C42: the first is free).
      canAfford={canAfford}
      startError={startError}
      insufficientCredits={insufficientCredits}
      canLaunch={canLaunch}
      starting={starting}
      onStart={() => void launch()}
    />
    {setup?.recording.available ? (
      <RecordingConsentSheet
        open={recordingSheetOpen}
        onClose={() => setRecordingSheetOpen(false)}
        mode={format}
        initial={recordingChoice}
        onConfirm={(choice) => {
          setRecording(choice);
          setRecordingSheetOpen(false);
        }}
      />
    ) : null}
    </>
  );
}
