'use client';

// /practice — SETUP, wired to the real-time Interview Engine and its prep agents.
//
// This file owns the state and the engine calls; PracticeTargetPicker and
// PracticeSetupFlow own the screen.
//
// The flow:
//   1. Which job — typed in the candidate's own words and searched in their job
//      market (prep/search: roles that match + real openings), browsed by
//      industry (prep/industries, prep/roles), pasted as a post, or prefilled
//      from `?job=` (WP-43). A target company is optional.
//   2. The plan — as soon as the job is known, prep/plan writes it: the job's
//      requirements, the interviewers a real loop for it would include, the
//      angles it is tested on, the company's interview style and a strategy.
//      The recommended interviewer and focus are preselected.
//   3. Start — the session is created with the plan and the interviewer and
//      focus chosen from it (`prep`); the server keeps it with the session, so
//      the questions, the live interviewer and the report all follow it.
//
// Kept from before:
//   - `/practice?job=<id>[&resume=<id>]` (hooks/shared/useLaunchPractice;
//     `jobId` is read too) prefills the job; the server picks the resume and
//     market-checks the job (404 → a one-line notice).
//   - Recording is off unless turned on in the RecordingConsentSheet (H8).
//   - A 402 opens the shared out-of-credits sheet; when the free first
//     practice still waits on verification, a notice says how to get it.
//   - GoApply without voice offers the written practice with a one-line reason.
//   - Practice lengths are 15, 20 or 30 minutes (default 20); GoApply's
//     AI-interview format runs 20 or 30. The first length offered is one the
//     balance covers.
//   - "Get credits" appears only where something is on sale.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RoboApiError } from '../../../lib/api/client';
import { accountKeys, useCredits } from '../../../hooks/useAccount';
import { useCredits as useCreditSummary } from '../../../hooks/shared/useCredits';
import { reportCreditsExhausted } from '../../../hooks/shared/useCreditGate';
import { useFlag } from '../../../lib/flags';
import { usePlans, visiblePlans } from '../../../hooks/credits/usePlans';
import {
  PracticeJobBanner,
  PracticeNotices,
  RecordingConsentSheet,
  RecordingRow,
  TextPracticeRoom,
  setupNotices,
} from '../../../components/features/practice';

import { plannedMinutesForType, useLocalizeType } from '../../../components/features/practice-cn';
import { SubscribeOnTap } from '../../../components/features/notify-cn';
import { useMockCatalog } from '../../../hooks/useMockV3';
import {
  PracticeSetupFlow,
  PracticeTargetPicker,
  DEFAULT_PRACTICE_MINUTES,
  JD_MIN_CHARS,
  practiceDurationOptions,
  type LoadState,
  type PracticeTarget,
  type RoleSourceMode,
} from '../../../components/v3/mock';
import {
  useIndustryRoles,
  usePrepIndustries,
  usePrepPlan,
  usePrepSearch,
} from '../../../hooks/practice/usePracticePrep';
import { useMockRoleLabels } from '../../../lib/mockRoleLabels';
import { formatRelativeTime } from '../../../lib/relativeTime';
import { INTERVIEW_LOCALES } from '../../../lib/localeConfig';
import {
  canAffordMinutes,
  defaultPracticeMinutes,
  longestAffordableMinutes,
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
  type PracticePrepSelection,
  type PracticeRecordingRequest,
  type PracticeSetupJob,
  type PrepPlanBody,
} from '../../../lib/api/interviewEngine';

/** A typed company or pasted post takes part in the plan once the candidate pauses this long. */
const COMMIT_DELAY_MS = 900;

/** Read once on mount: `?job=` (or `?jobId=`, older links), `?resume=` (WP-43 route contract). */
function readJobParams(): { job: string | null; resume: string | null } {
  if (typeof window === 'undefined') return { job: null, resume: null };
  const params = new URLSearchParams(window.location.search);
  const clip = (v: string | null) => (v && v.trim() ? v.trim().slice(0, 64) : null);
  return { job: clip(params.get('job') ?? params.get('jobId')), resume: clip(params.get('resume')) };
}

interface TextRun {
  jobId: string | null;
  role: string;
  interviewerId: string;
  typeId: string;
  language: string;
  durationMinutes: number;
  prep: PracticePrepSelection | null;
}

/** What a restored plan prefers once the new plan arrives (a past session, a "Run it again" link). */
interface PreferredPick {
  interviewerName?: string | null;
  baseId?: string | null;
  focusLabel?: string | null;
  format?: string | null;
}

/** Cheap client-side working title from a pasted post — the first meaningful
 *  line, clipped. The plan names the role properly; this is only shown until then. */
function deriveRoleLabelFromJd(jd: string): string {
  const firstLine =
    jd
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find(Boolean) ?? '';
  return (firstLine || jd.trim()).slice(0, 60).trim();
}

/** A value that follows `value` after the candidate pauses (or at once, through `commitNow`). */
function useCommitted(value: string, delayMs: number): [string, (next: string) => void] {
  const [committed, setCommitted] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setCommitted(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return [committed, setCommitted];
}

function loadState(query: { isFetching: boolean; isError: boolean; data: unknown }, enabled: boolean): LoadState {
  if (!enabled) return 'idle';
  if (query.isError && !query.data) return 'error';
  if (query.isFetching && !query.data) return 'loading';
  return query.data ? 'ready' : 'idle';
}

export default function MockSetupPage() {
  const t = useTranslations('practice');
  const tTaxonomy = useTranslations('taxonomy');
  const { localizeRole } = useMockRoleLabels();
  const localizeType = useLocalizeType();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const uiLocale = useLocale();

  // The catalog only names the interviewers of sessions planned before the prep agents.
  const catalogQuery = useMockCatalog({ refetchOnWindowFocus: false });
  const catalog = catalogQuery.data?.catalog;

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
  const studentPlans = useFlag('student');
  const creditSummary = useCreditSummary();
  // The server says whether a sellable plan raises the allowance.
  const upgradable = creditSummary.data?.summary.upgradable === true;

  // Recent sessions come from the engine (completed voice interviews).
  const [recent, setRecent] = useState<IESessionSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    interviewEngineApi.recent()
      .then((r) => { if (!cancelled) setRecent(r.sessions); })
      .catch(() => { /* the lane just stays empty */ });
    return () => { cancelled = true; };
  }, []);

  // ── The job ──
  const [sourceMode, setSourceMode] = useState<RoleSourceMode>('role');
  const [query, setQuery] = useState('');
  const [company, setCompany] = useState('');
  const [committedCompany, setCommittedCompany] = useCommitted(company.trim(), COMMIT_DELAY_MS);
  const [industry, setIndustry] = useState<string | null>(null);
  const [target, setTarget] = useState<PracticeTarget | null>(null);
  const [jdText, setJdText] = useState('');
  const [committedJd] = useCommitted(jdText.trim(), COMMIT_DELAY_MS * 1.4);

  // ── The plan ──
  const [interviewerKey, setInterviewerKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const preferredRef = useRef<PreferredPick | null>(null);
  // Default to Video — the recommended, most realistic format. The candidate can switch to voice-only.
  const [format, setFormat] = useState<RAMockFormat>('video');

  // WP-43: prefill once from the job — the posting becomes the brief and the
  // job title the role. The candidate can drop the job.
  useEffect(() => {
    const next = setup?.job ?? null;
    if (!next || prefilledJobRef.current === next.id) return;
    prefilledJobRef.current = next.id;
    setJob(next);
    setTarget(null);
    setCompany(next.companyName ?? '');
    setCommittedCompany((next.companyName ?? '').trim());
  }, [setup, setCommittedCompany]);

  function clearJob() {
    setJob(null);
    setSourceMode('role');
  }

  // The interview language defaults to the UI language (region variants
  // tolerated). Matched against INTERVIEW_LOCALES: the voice engine speaks all
  // nine locales.
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

  const jobActive = !!job;
  const jdTrimmed = jdText.trim();

  // ── Queries ──
  // The prep calls reach a model: none while the brand's AI gate is closed
  // (GoApply without a bound phone or the AI consent; the notice says why).
  // A failed setup read leaves them on: the server enforces the gate anyway.
  const prepAllowed = setup ? setup.ai.allowed : setupQuery.isError;
  const browsing = sourceMode === 'role' && !target && !jobActive;
  const industriesQ = usePrepIndustries(browsing);
  const rolesQ = useIndustryRoles(browsing && prepAllowed && !query.trim() ? industry : null);
  const searchQ = usePrepSearch({ query, company: committedCompany, industry, enabled: browsing && prepAllowed });

  const planBody: PrepPlanBody | null = useMemo(() => {
    if (!prepAllowed) return null;
    const withCompany = committedCompany ? { company: committedCompany } : {};
    if (jobActive) return { jobId: job!.id, ...withCompany };
    if (sourceMode === 'jd') return committedJd.length >= JD_MIN_CHARS ? { jdText: committedJd, ...withCompany } : null;
    if (!target) return null;
    const industryText = industry ? (industriesQ.data?.find((item) => item.id === industry)?.label ?? industry) : null;
    if (target.kind === 'role') {
      return { role: target.title, ...withCompany, ...(industryText ? { industry: industryText } : {}) };
    }
    const posting = target.posting;
    if (posting.jobId) return { jobId: posting.jobId, ...withCompany };
    return {
      role: posting.title,
      posting: { title: posting.title, company: posting.company, location: posting.location, url: posting.url },
      ...(posting.description ? { jdText: posting.description } : {}),
      ...withCompany,
    };
  }, [prepAllowed, jobActive, job, sourceMode, committedJd, target, committedCompany, industry, industriesQ.data]);

  const planQ = usePrepPlan(planBody);
  const plan = planBody ? planQ.data ?? null : null;
  const planState = loadState(planQ, planBody !== null);

  // A new plan selects its recommendation, or what a restored plan preferred.
  useEffect(() => {
    if (!plan) return;
    const prefer = preferredRef.current;
    preferredRef.current = null;
    const interviewer =
      (prefer?.interviewerName ? plan.interviewers.find((item) => item.name === prefer.interviewerName) : undefined) ??
      (prefer?.baseId ? plan.interviewers.find((item) => item.baseId === prefer.baseId) : undefined) ??
      plan.interviewers.find((item) => item.key === plan.recommended.interviewerKey) ??
      plan.interviewers[0];
    const focus =
      (prefer?.focusLabel ? plan.focuses.find((item) => item.label === prefer.focusLabel) : undefined) ??
      (prefer?.format ? plan.focuses.find((item) => item.format === prefer.format) : undefined) ??
      plan.focuses.find((item) => item.key === plan.recommended.focusKey) ??
      plan.focuses[0];
    setInterviewerKey(interviewer?.key ?? null);
    setFocusKey(focus?.key ?? null);
  }, [plan]);

  const interviewer = plan?.interviewers.find((item) => item.key === interviewerKey) ?? null;
  const focus = plan?.focuses.find((item) => item.key === focusKey) ?? null;

  // ── Restoring a plan (a past session, a report's "Run it again" link) ──
  const restorePlan = useCallback((saved: {
    role: string;
    company?: string | null;
    interviewer?: string | null;
    interviewerName?: string | null;
    type?: string | null;
    focusLabel?: string | null;
    mode?: string | null;
    language?: string | null;
    duration?: number | null;
  }): boolean => {
    const role = saved.role.trim();
    if (!role) return false;
    setJob(null);
    setSourceMode('role');
    setQuery('');
    setIndustry(null);
    setTarget({ kind: 'role', title: role, titleEn: null });
    const savedCompany = (saved.company ?? '').trim();
    setCompany(savedCompany);
    setCommittedCompany(savedCompany);
    if (saved.mode === 'video' || saved.mode === 'voice') setFormat(saved.mode);
    if (INTERVIEW_LOCALES.some((locale) => locale.code === saved.language)) setLanguage(saved.language as string);
    const duration = typeof saved.duration === 'number' && Number.isInteger(saved.duration) ? saved.duration : null;
    setDurationOverride(duration !== null && duration >= 5 && duration <= 120 ? duration : null);
    preferredRef.current = {
      interviewerName: saved.interviewerName ?? null,
      baseId: saved.interviewer ?? null,
      focusLabel: saved.focusLabel ?? null,
      format: saved.type ?? null,
    };
    setInsufficientCredits(null);
    setStartError(null);
    return true;
  }, [setCommittedCompany]);

  // A report's "Run it again" action carries the last interview plan in the URL.
  const replayHydratedRef = useRef(false);
  useEffect(() => {
    if (replayHydratedRef.current || typeof window === 'undefined') return;
    replayHydratedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('job') || params.get('jobId')) return;
    const parsedDuration = Number(params.get('duration'));
    restorePlan({
      role: params.get('role')?.trim() ?? '',
      company: params.get('company'),
      interviewer: params.get('interviewer'),
      type: params.get('type'),
      mode: params.get('mode'),
      language: params.get('language'),
      duration: Number.isFinite(parsedDuration) ? parsedDuration : null,
    });
  }, [restorePlan]);

  // ── Selection handlers ──
  function selectTarget(next: PracticeTarget) {
    setTarget(next);
    setInsufficientCredits(null);
    setStartError(null);
    // A posting names its company: the plan uses it at once (no typing pause to wait for).
    if (next.kind === 'posting' && next.posting.company && !company.trim()) {
      setCompany(next.posting.company);
      setCommittedCompany(next.posting.company);
    }
  }

  function clearTarget() {
    setTarget(null);
    setInterviewerKey(null);
    setFocusKey(null);
  }

  function changeSourceMode(next: RoleSourceMode) {
    setSourceMode(next);
    setStartError(null);
  }

  // ── Lengths and credits ──
  // Mirror the server's runtime credit policy. The optional-field fallback is
  // only for a rolling deployment where the frontend reaches an older API.
  const creditMinutes = normalizeMockCreditMinutes(creditsQ.data?.creditMinutes);
  const creditBalance = creditsQ.data?.balance;
  const focusFormat = focus?.format ?? null;
  const durationOptions = useMemo(() => practiceDurationOptions(focusFormat ? { id: focusFormat } : null), [focusFormat]);
  // GoApply's AI-interview format runs 20–30 minutes: the length shown, priced
  // and sent is the one the server will run. Until the candidate picks a
  // length, the plan starts on 20 minutes when the balance covers it.
  const durationMinutes = plannedMinutesForType(
    focusFormat,
    durationOverride !== null && durationOptions.includes(durationOverride)
      ? durationOverride
      : defaultPracticeMinutes({
          preferred: plannedMinutesForType(focusFormat, DEFAULT_PRACTICE_MINUTES),
          options: durationOptions,
          balance: creditBalance,
          creditMinutes,
        }),
  );

  // The role the dock names, from the job, the posting, the role, or the plan of a pasted post.
  const effectiveRole = jobActive
    ? job!.title
    : sourceMode === 'jd'
      ? plan?.role || (jdTrimmed ? deriveRoleLabelFromJd(jdTrimmed) : null)
      : target?.kind === 'posting'
        ? target.posting.title
        : target?.kind === 'role'
          ? target.title
          : null;
  const hasRoleSource = jobActive || (sourceMode === 'jd' ? jdTrimmed.length >= JD_MIN_CHARS : !!target);
  // GoApply gates (server-decided): no AI practice without a phone / consent;
  // without voice, the practice runs in writing.
  const aiBlocked = setup ? !setup.ai.allowed : false;
  const textMode = !!setup && setup.ai.allowed && !setup.voice.available && setup.voice.reason === 'voice_unavailable';
  const canLaunch = hasRoleSource && planState === 'ready' && !!plan && !!interviewer && !!focus && !aiBlocked;

  const recentSummaries: RAMockSessionSummary[] = useMemo(() => {
    return recent
      .filter((s) => s.status === 'completed')
      .map((s) => ({
        id: s.id,
        role: s.company ? `${localizeRole(s.role)} · ${s.company}` : localizeRole(s.role),
        // A planned session names its own interviewer and focus; older ones
        // are named from the catalog (persona names are proper nouns).
        interviewerName:
          s.interviewer?.name ??
          catalog?.interviewers.find((i) => i.id === s.personaId)?.name ??
          t('setup.recent.unknownInterviewer'),
        typeLabel:
          s.focusLabel ??
          localizeType(s.interviewType, 'label', catalog?.types.find((tp) => tp.id === s.interviewType)?.label ?? s.interviewType),
        score: s.overall ?? 0,
        when: formatRelativeTime(s.endedAt ?? s.createdAt, uiLocale),
        note: '',
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, catalog, uiLocale]);

  function replay(sessionId: string) {
    router.push(`/practice/${sessionId}/report`);
  }

  // "Practice this again" — restore that session's plan onto the brief. It
  // stops short of launching: a new interview spends credits.
  function repeat(sessionId: string) {
    const past = recent.find((item) => item.id === sessionId);
    if (!past) return;
    restorePlan({
      role: past.role,
      company: past.company ?? null,
      interviewer: past.personaId,
      interviewerName: past.interviewer?.name ?? null,
      type: past.interviewType,
      focusLabel: past.focusLabel ?? null,
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
        upgradable,
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
    if (!canLaunch || !canAfford || !plan || !interviewer || !focus) return;
    setStartError(null);
    setInsufficientCredits(null);
    setFirstPracticeFrom402(null);
    const prep: PracticePrepSelection = { plan, interviewerKey: interviewer.key, focusKey: focus.key };
    const postingJobId = target?.kind === 'posting' ? target.posting.jobId : null;
    const jobId = jobActive ? job!.id : postingJobId;
    if (textMode) {
      // GoApply without voice: the written practice runs on this page, for
      // the job when there is one (the server loads it and meters the run).
      setTextRun({
        jobId,
        role: effectiveRole ?? '',
        interviewerId: interviewer.baseId,
        typeId: focus.format,
        language,
        durationMinutes,
        prep,
      });
      return;
    }
    setStarting(true);
    try {
      const postingText = target?.kind === 'posting' && !target.posting.jobId ? target.posting.description ?? undefined : undefined;
      const body: PracticeCreateBody = {
        role: effectiveRole ?? '',
        jdText: sourceMode === 'jd' && !jobActive ? jdTrimmed : postingText,
        interviewType: focus.format,
        personaId: interviewer.baseId,
        mode: format,
        language,
        durationMinutes,
        candidateName: user?.name ?? undefined,
        // The server loads the job, picks and redacts the resume, and checks
        // the recording consent itself.
        jobId,
        resumeId: jobParams?.resume ?? null,
        recording: { audio: recording.audio, video: recording.audio && recording.video && format === 'video' },
        prep,
      };
      // The server answers as soon as the session row exists (status
      // 'preparing'); the interview is written while the live page shows its
      // own progress, so navigate straight away.
      const { session } = await practiceApi.create(body);
      router.push(`/practice/${session.id}`);
    } catch (err) {
      const info = ieErrorInfo(err);
      if (handleRefusal(err)) {
        // Shown on the page (sheet, notice or start error).
      } else if (info.network) {
        setStartError('network');
      } else if (info.code === 'llm_unavailable' || info.code === 'worker_unavailable' || info.status === 503) {
        setStartError('busy');
      } else {
        setStartError('generic');
      }
      setStarting(false);
    }
  }

  const creditCost = mockCreditsForMinutes(durationMinutes, creditMinutes);
  const canAfford = creditBalance === undefined || canAffordMinutes(durationMinutes, creditBalance, creditMinutes);
  // The balance covers none of the offered lengths: only then is the user
  // "short of credits" in the sense the first-practice notice means.
  const noLengthAffordable =
    creditBalance !== undefined && longestAffordableMinutes(durationOptions, creditBalance, creditMinutes) === null;

  // Is there anything to buy? A plan that raises the allowance (the server
  // says so), or a practice pack on sale right now.
  const plansQ = usePlans({ enabled: (!canAfford || insufficientCredits !== null) && !upgradable });
  const canGetCredits =
    upgradable ||
    visiblePlans(plansQ.data?.plans, { studentEnabled: studentPlans }).some((p) => p.kind === 'pack' && p.sellable);

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
        prep={textRun.prep ?? undefined}
        onExit={() => setTextRun(null)}
      />
    );
  }

  const notices = setupNotices({
    setup,
    jobNotFound,
    creditsShort: !canAfford && noLengthAffordable,
    firstPracticeFrom402,
  });
  const recordingChoice: PracticeRecordingRequest = {
    audio: recording.audio,
    video: recording.audio && recording.video && format === 'video',
  };

  const searchState: LoadState = loadState(searchQ, searchQ.ready);
  const rolesState: LoadState = loadState(rolesQ, !!industry);

  return (
    <>
    <PracticeSetupFlow
      topSlot={<PracticeNotices kinds={notices} />}
      introAside={
        showQuestionsLink ? <Link href="/practice/questions">{t('questionsLink')}</Link> : null
      }
      targetSection={
        <PracticeTargetPicker
          sourceMode={sourceMode}
          onSourceModeChange={changeSourceMode}
          query={query}
          onQueryChange={setQuery}
          company={company}
          onCompanyChange={setCompany}
          industries={industriesQ.data ?? (industriesQ.isError ? [] : null)}
          industry={industry}
          onIndustryChange={setIndustry}
          industryRoles={{ state: rolesState, roles: rolesQ.data ?? [] }}
          onRetryIndustryRoles={() => void rolesQ.refetch()}
          search={{ state: searchState, pending: searchQ.pending, result: searchQ.ready ? searchQ.data ?? null : null }}
          onRetrySearch={() => void searchQ.refetch()}
          target={target}
          onSelectTarget={selectTarget}
          onClearTarget={clearTarget}
          jdText={jdText}
          onJdTextChange={setJdText}
          jobBanner={jobActive && job ? <PracticeJobBanner job={job} resume={setup?.resume ?? null} onClear={clearJob} /> : undefined}
          localizeTaxonomy={(id, fallback) => (tTaxonomy.has(`roles.${id}`) ? tTaxonomy(`roles.${id}`) : fallback)}
        />
      }
      hasRoleSource={hasRoleSource}
      effectiveRole={effectiveRole}
      company={committedCompany || null}
      planState={planState}
      planBlocked={!prepAllowed}
      plan={plan}
      onRetryPlan={() => void planQ.refetch()}
      selectedInterviewerKey={interviewerKey}
      onSelectInterviewer={setInterviewerKey}
      selectedFocusKey={focusKey}
      onSelectFocus={(value) => {
        setFocusKey(value);
        setInsufficientCredits(null);
      }}
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
      // GoApply inside WeChat: Start also asks, once, to be told when the report is ready.
      wrapStart={(button) => <SubscribeOnTap template="report_ready">{button}</SubscribeOnTap>}
      format={format}
      onFormatChange={setFormat}
      // Video or voice is a choice only where the voice practice can run.
      formatChoice={setup ? setup.voice.available : true}
      language={language}
      onLanguageChange={setLanguage}
      durationMinutes={durationMinutes}
      durationOptions={durationOptions}
      onDurationChange={(value) => {
        setDurationOverride(value);
        setInsufficientCredits(null);
      }}
      recentSessions={recentSummaries}
      onReplay={(session) => replay(session.id)}
      onRepeat={(session) => repeat(session.id)}
      onDelete={(session) => void removeSession(session.id)}
      creditCost={creditCost}
      creditMinutes={creditMinutes}
      creditsRemaining={creditsQ.data?.balance}
      // The written practice is metered like a live one (C42: the first is free).
      canAfford={canAfford}
      startError={startError}
      insufficientCredits={insufficientCredits}
      canGetCredits={canGetCredits}
      canLaunch={canLaunch}
      starting={starting}
      onStart={() => void launch()}
    />
    {setup?.recording.available ? (
      <RecordingConsentSheet
        open={recordingSheetOpen}
        onClose={() => setRecordingSheetOpen(false)}
        mode={format}
        videoAllowed={setup.media?.recordVideo !== false}
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
