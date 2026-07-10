'use client';

// /mock-interview — SETUP (V3 design) wired to the real-time Interview Engine.
//
// Keeps the polished V3 setup UI (RolePicker · InterviewerPicker · TypePicker ·
// FormatPicker · LangDurationPicker · LaunchBar + RecentSessionsStrip, all on the
// .iv-* class family) and the RA mock catalog for the pickers. On launch it
// creates a real InterviewSession via the Interview Engine (LiveKit voice) and
// routes to the live room. The engine's persona ids are aligned to this
// catalog's interviewer ids, so the selection maps 1:1.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { RoboApiError } from '../../../lib/api/client';
import { raV2Api } from '../../../lib/api/v2';
import { useCredits } from '../../../hooks/useAccount';

import { useMockCatalog } from '../../../hooks/useMockV3';
import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { Btn } from '../../../components/v3/primitives/Btn';
import {
  RecentSessionsStrip,
  RolePicker,
  MarketRequirementsPanel,
  InterviewerPicker,
  TypePicker,
  FormatPicker,
  LangDurationPicker,
  LaunchBar,
} from '../../../components/v3/mock';
import { JD_MIN_CHARS, type RoleSourceMode } from '../../../components/v3/mock/RolePicker';
import { useInterviewPreview } from '../../../hooks/useInterviewPreview';
import { recommendationsForRole } from '../../../lib/interviewRecommendations';
import { useMockRoleLabels } from '../../../lib/mockRoleLabels';
import { READY_LOCALES } from '../../../lib/localeConfig';
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

function relativeWhen(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
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
  const t = useTranslations('mock');
  const { localizeRole } = useMockRoleLabels();
  const router = useRouter();
  const { user } = useAuth();

  const catalogQuery = useMockCatalog();
  const catalog = catalogQuery.data?.catalog;

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
  const uiLocale = useLocale();
  const [language, setLanguage] = useState<string>(() => {
    const base = uiLocale.split('-')[0];
    const match =
      READY_LOCALES.find((l) => l.code === uiLocale) ??
      READY_LOCALES.find((l) => l.code === base) ??
      READY_LOCALES.find((l) => l.code.split('-')[0] === base);
    return match?.code ?? 'en';
  });
  const [durationOverride, setDurationOverride] = useState<number | null>(null);

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);
  const [insufficientCredits, setInsufficientCredits] = useState<{ balance: number; required: number } | null>(null);
  const creditsQ = useCredits();

  const effectiveCategory = activeCategory || catalog?.roleCategories[0]?.name || '';

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

  // When a role is picked and no format is chosen yet, default to the top
  // recommended format for that role. The user can still pick any other (and
  // once they've chosen, changing role never overrides their pick).
  useEffect(() => {
    if (sourceMode === 'role' && recs && !typeId) {
      setTypeId(recs.typeIds[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, sourceMode]);

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
        interviewerName: catalog.interviewers.find((i) => i.id === s.personaId)?.name ?? 'Interviewer',
        typeLabel: catalog.types.find((tp) => tp.id === s.interviewType)?.label ?? s.interviewType,
        score: s.overall ?? 0,
        when: relativeWhen(s.endedAt ?? s.createdAt),
        note: '',
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, catalog]);

  function replay(sessionId: string) {
    router.push(`/mock-interview/${sessionId}/report`);
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
    if (!canLaunch || !interviewer || !type) return;
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
      router.push(`/mock-interview/${session.id}`);
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

  // Credit cost of the currently-selected duration (1 credit = 20 min).
  const creditCost = Math.ceil((durationMinutes / 20) * 100) / 100;

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
      title={t('setup.title')}
      accentWord={t('setup.titleAccent')}
      titleAfter={t('setup.titleAfter')}
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
          style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-xl)', padding: '52px 32px' }}
        >
          <p style={{ fontFamily: 'var(--sans)', fontSize: 18, fontWeight: 600, color: 'var(--text)', margin: 0 }}>
            {t('setup.error.title')}
          </p>
          <p style={{ color: 'var(--text-2)', fontSize: 14, maxWidth: 420, margin: 0 }}>{t('setup.error.body')}</p>
          <Btn variant="primary" onClick={() => void catalogQuery.refetch()}>{t('setup.error.retry')}</Btn>
        </div>
      </>
    );
  }

  if (catalogQuery.isLoading || !catalog) {
    return (
      <>
        {header}
        <div aria-busy="true" aria-label={t('setup.loading')} style={{ color: 'var(--text-2)', fontSize: 14, padding: '40px 0' }}>
          {t('setup.loading')}
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <RecentSessionsStrip
        sessions={recentSummaries}
        onReplay={(s) => replay(s.id)}
        onDelete={(s) => void removeSession(s.id)}
      />

      <RolePicker
        categories={catalog.roleCategories}
        totalRoles={catalog.totalRoles}
        query={query}
        onQueryChange={setQuery}
        activeCategory={effectiveCategory}
        onCategoryChange={setActiveCategory}
        selectedRole={role}
        onSelectRole={setRole}
        sourceMode={sourceMode}
        onSourceModeChange={setSourceMode}
        jdText={jdText}
        onJdTextChange={setJdText}
      />

      <MarketRequirementsPanel
        state={previewMut.isPending ? 'loading' : previewMut.isError ? 'error' : previewMut.data ? 'ready' : 'idle'}
        requirements={previewMut.data?.requirements ?? null}
        webSources={previewMut.data?.webSources ?? []}
        sampleQuestions={previewMut.data?.sampleQuestions ?? []}
        groundedOn={previewMut.data?.groundedOn}
        canPreview={canPreview}
        onPreview={() => runPreview()}
        onRetry={() => runPreview()}
      />

      <InterviewerPicker
        interviewers={catalog.interviewers}
        selectedId={interviewerId}
        onSelect={setInterviewerId}
        recommendedPersonaIds={recs?.personaIds}
      />

      <TypePicker
        types={catalog.types}
        selectedId={typeId}
        onSelect={setTypeId}
        recommendedTypeIds={recs?.typeIds}
        roleLabel={role}
      />

      <FormatPicker value={format} onChange={setFormat} />

      <LangDurationPicker
        language={language}
        onLanguageChange={setLanguage}
        durationMinutes={durationMinutes}
        onDurationChange={setDurationOverride}
        typeMinutes={type?.minutes ?? null}
      />

      {/* Credit cost + balance hint for this interview. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text-2)' }}>
          {t('setup.creditCost', { n: creditCost })}
        </span>
        {creditsQ.data ? (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--muted)' }}>
            {t('setup.creditsRemaining', { n: creditsQ.data.balance })}
          </span>
        ) : null}
      </div>

      {startError ? (
        <p role="alert" style={{ color: 'var(--warn)', fontSize: 13, marginTop: 12 }}>{t('setup.startError')}</p>
      ) : null}

      {insufficientCredits ? (
        <div
          role="alert"
          style={{ border: '1px solid var(--warn)', background: 'var(--warn-soft)', borderRadius: 'var(--r-lg)', padding: '14px 16px', marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}
        >
          <span style={{ fontSize: 13.5, color: 'var(--text)' }}>
            {t('setup.insufficientCredits', { required: insufficientCredits.required, balance: insufficientCredits.balance })}
          </span>
          <Link href="/account#billing" style={{ textDecoration: 'none' }}>
            <Btn variant="primary">{t('setup.getCredits')}</Btn>
          </Link>
        </div>
      ) : null}

      <LaunchBar
        role={effectiveRole}
        interviewer={interviewer}
        type={type}
        format={format}
        language={language}
        durationMinutes={durationMinutes}
        canLaunch={canLaunch}
        starting={starting}
        onStart={() => void launch()}
      />
    </>
  );
}
