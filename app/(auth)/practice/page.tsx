'use client';

// /mock-interview — SETUP (V3 design) wired to the real-time Interview Engine.
//
// Keeps the polished V3 setup UI (RolePicker · InterviewerPicker · TypePicker ·
// FormatPicker · LangDurationPicker · LaunchBar + RecentSessionsStrip, all on the
// .iv-* class family) and the RA mock catalog for the pickers. On launch it
// creates a real InterviewSession via the Interview Engine (LiveKit voice) and
// routes to the live room. The engine's persona ids are aligned to this
// catalog's interviewer ids, so the selection maps 1:1.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { RoboApiError } from '../../../lib/api/client';
import { raV2Api } from '../../../lib/api/v2';
import { useCredits } from '../../../hooks/useAccount';

import { useMockCatalog } from '../../../hooks/useMockV3';
import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { Btn } from '../../../components/v3/primitives/Btn';
import { PracticeSetupFlow } from '../../../components/v3/mock';
import { JD_MIN_CHARS, type RoleSourceMode } from '../../../components/v3/mock/RolePicker';
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
  interviewEngineApi,
  type IECreateBody,
  type IESessionSummary,
} from '../../../lib/api/interviewEngine';

const DEFAULT_DURATION_MINUTES = 30;

// The blueprint agent clips résumé context to 2000 chars server-side — sending
// more just bloats the create body.
const RESUME_CONTEXT_MAX_CHARS = 2000;

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

  const catalogQuery = useMockCatalog();
  const catalog = catalogQuery.data?.catalog;
  const defaultedTargetRef = useRef<string | null>(null);
  const replayHydratedRef = useRef(false);
  const replayTargetRef = useRef<string | null>(null);

  // Résumé context for the blueprint prompt (the interviewer tailors question
  // targeting to it). Fetched in the background at page load — never inside
  // launch(), which must stay instant — and strictly best-effort: no résumé
  // (or a failed fetch) simply omits it from the create body.
  const [resumeContext, setResumeContext] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { resumes } = await raV2Api.resumes.list();
        // Primary résumé preferred; the list is lastEditedAt-desc, so the
        // fallback is the most recently edited one.
        const pick = resumes.find((r) => r.isPrimary) ?? resumes[0];
        if (!pick) return;
        const { resume } = await raV2Api.resumes.get(pick.id);
        const md = resume.resumeMarkdown?.trim();
        if (!cancelled && md) setResumeContext(md.slice(0, RESUME_CONTEXT_MAX_CHARS));
      } catch { /* best-effort — interview setup works without a résumé */ }
    })();
    return () => { cancelled = true; };
  }, []);

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
  const [startError, setStartError] = useState(false);
  const [insufficientCredits, setInsufficientCredits] = useState<{ balance: number; required: number } | null>(null);
  const creditsQ = useCredits();

  // A report's "Run it again" action carries the last interview plan in the
  // URL. Hydrate it after the catalog is ready so every id is validated against
  // the current choices, while keeping the server-rendered first frame stable.
  useEffect(() => {
    if (!catalog || replayHydratedRef.current || typeof window === 'undefined') return;
    replayHydratedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const replayRole = params.get('role')?.trim() ?? '';
    const replayCategory = catalog.roleCategories.find((item) => item.roles.includes(replayRole));
    if (!replayRole || !replayCategory) return;

    const replayInterviewer = catalog.interviewers.find(
      (item) => item.id === params.get('interviewer'),
    )?.id ?? null;
    const replayType = catalog.types.find((item) => item.id === params.get('type'))?.id ?? null;
    const replayMode = params.get('mode');
    const replayLanguage = params.get('language');
    const parsedDuration = Number(params.get('duration'));
    const replayDuration =
      Number.isInteger(parsedDuration) && parsedDuration >= 5 && parsedDuration <= 120
        ? parsedDuration
        : null;

    setSourceMode('role');
    setQuery('');
    setActiveCategory(replayCategory.name);
    setRole(replayRole);
    setInterviewerId(replayInterviewer);
    setTypeId(replayType);
    if (replayMode === 'video' || replayMode === 'voice') setFormat(replayMode);
    if (INTERVIEW_LOCALES.some((locale) => locale.code === replayLanguage)) {
      setLanguage(replayLanguage as string);
    }
    setDurationOverride(replayDuration);

    // A complete saved plan should survive the role-aware defaulting effect.
    // Partial or stale links intentionally fall back to current recommendations.
    const replayTarget = replayInterviewer && replayType ? `role:${replayRole}` : null;
    replayTargetRef.current = replayTarget;
    defaultedTargetRef.current = replayTarget;
  }, [catalog]);

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
  const effectiveRole =
    sourceMode === 'jd' ? (jdTrimmed ? deriveRoleLabelFromJd(jdTrimmed) : null) : role;
  const hasRoleSource = sourceMode === 'role' ? !!role : jdTrimmed.length >= JD_MIN_CHARS;
  const canLaunch = !!(interviewer && type && hasRoleSource);
  // Preview just needs a target + persona + type; it never gates launch.
  const canPreview = !!(interviewer && type && hasRoleSource);
  const targetKey = hasRoleSource
    ? sourceMode === 'role'
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

  async function launch() {
    if (!canLaunch || !canAfford || !interviewer || !type) return;
    setStarting(true);
    setStartError(false);
    setInsufficientCredits(null);
    try {
      const body: IECreateBody = {
        role: effectiveRole ?? '',
        jdText: sourceMode === 'jd' ? jdTrimmed : undefined,
        interviewType: type.id,
        personaId: interviewer.id,
        mode: format,
        language,
        durationMinutes,
        candidateName: user?.name ?? undefined,
        // Whatever the background fetch has by now — a still-pending fetch is
        // simply omitted rather than delaying the launch.
        resumeContext: resumeContext ?? undefined,
      };
      const { session } = await interviewEngineApi.create(body);
      router.push(`/practice/${session.id}`);
    } catch (err) {
      // 402 → out of mock-interview credits. Show an upsell, not a generic error.
      if (err instanceof RoboApiError && err.status === 402 && (err.payload as any)?.error === 'insufficient_credits') {
        const p = err.payload as { balance?: number; required?: number };
        setInsufficientCredits({ balance: p.balance ?? 0, required: p.required ?? 0 });
      } else {
        setStartError(true);
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
    if (!interviewer || !type || !hasRoleSource) return;
    previewMut.mutate({
      role: sourceMode === 'role' ? role ?? undefined : undefined,
      jdText: sourceMode === 'jd' ? jdTrimmed : undefined,
      interviewType: type.id,
      personaId: interviewer.id,
      language,
    });
  }

  const header = (
    <PageHeader
      eyebrow={t('setup.eyebrow', { count: catalog?.totalRoles ?? 57 })}
      eyebrowLive
      title={`${t('setup.title')} ${t('setup.titleAccent')}${t('setup.titleAfter')}`}
      sub={t('setup.sub')}
    />
  );

  if (catalogQuery.isError) {
    return (
      <>
        {header}
        <div
          role="alert"
          className="flex flex-col items-center gap-4 text-center"
          style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-lg)', padding: '52px 32px' }}
        >
          <p style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-subtitle)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
            {t('setup.error.title')}
          </p>
          <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', maxWidth: 420, margin: 0 }}>{t('setup.error.body')}</p>
          <Btn variant="primary" onClick={() => void catalogQuery.refetch()}>{t('setup.error.retry')}</Btn>
        </div>
      </>
    );
  }

  if (catalogQuery.isLoading || !catalog) {
    return (
      <>
        {header}
        <div aria-busy="true" aria-label={t('setup.loading')} style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', padding: '40px 0' }}>
          {t('setup.loading')}
        </div>
      </>
    );
  }

  return (
    <PracticeSetupFlow
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
      onDelete={(session) => void removeSession(session.id)}
      previewState={previewMut.isPending ? 'loading' : previewMut.isError ? 'error' : previewMut.data ? 'ready' : 'idle'}
      requirements={previewMut.data?.requirements ?? null}
      webSources={previewMut.data?.webSources ?? []}
      sampleQuestions={previewMut.data?.sampleQuestions ?? []}
      groundedOn={previewMut.data?.groundedOn}
      canPreview={canPreview}
      onPreview={runPreview}
      onRetryPreview={runPreview}
      creditCost={creditCost}
      creditMinutes={creditMinutes}
      creditsRemaining={creditsQ.data?.balance}
      canAfford={canAfford}
      startError={startError}
      insufficientCredits={insufficientCredits}
      canLaunch={canLaunch}
      starting={starting}
      onStart={() => void launch()}
    />
  );
}
