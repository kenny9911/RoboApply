'use client';

// /mock-interview/[id]/report — RESULTS (V3 design) from the Interview Engine.
//
// Re-skins onto the V3 ResultsTop (overall + breakdown) + ResultsGrid
// (strengths / sharpen) components, then adds the engine extras: the localized
// LLM enrichment (concrete recommendations + a per-question deep dive with
// analysis / correction / suggestion), the recording playback (audio for voice
// mode, video for video mode), and the transcript.
//
// Two-phase report: finalize() persists a deterministic score instantly, then a
// background LLM pass enriches it (localized prose, recommendations, per-question
// analysis). We poll until `reportPending` clears (or give up after a cap so a
// legacy session doesn't poll forever).

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { PageHeader } from '../../../../../components/v3/primitives/PageHeader';
import { Btn } from '../../../../../components/v3/primitives/Btn';
import {
  ResultsTop,
  ResultsGrid,
  RecommendationsCard,
  QuestionBreakdownSection,
} from '../../../../../components/v3/mock';
import { canonicalDimKey } from '../../../../../lib/mock/dimensionLabels';
import { interviewEngineApi, type IEReport } from '../../../../../lib/api/interviewEngine';

const MAX_POLLS = 15;

export default function MockReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('ie');

  const [report, setReport] = useState<IEReport | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const pollsRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await interviewEngineApi.report(id);
      setReport(r);
      return r;
    } catch {
      setError(true);
      return null;
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // The recording (egress webhook) and the LLM enrichment both land a few
  // seconds after the interview ends — auto-retry until both are ready, capped
  // so a legacy / failed-enrichment session settles instead of polling forever.
  useEffect(() => {
    if (!report || gaveUp) return;
    const s = report.session;
    const needMore =
      s.status !== 'completed' ||
      !!s.reportPending ||
      (!report.recordingUrl && s.recordingAvailable);
    if (!needMore) return;
    if (pollsRef.current >= MAX_POLLS) { setGaveUp(true); return; }
    const delay = s.status !== 'completed' ? 3000 : 4000;
    const h = window.setTimeout(() => { pollsRef.current += 1; void load(); }, delay);
    return () => window.clearTimeout(h);
  }, [report, load, gaveUp]);

  const refresh = async () => {
    setGaveUp(false);
    pollsRef.current = 0;
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (error) {
    return (
      <>
        <PageHeader title={t('report.title')} />
        <p style={{ color: 'var(--text-2)', fontSize: 14 }}>{t('report.error')}</p>
        <Btn variant="primary" as="a" href="/mock-interview">{t('report.newInterview')}</Btn>
      </>
    );
  }
  if (!report) {
    return (
      <>
        <PageHeader eyebrowLive title={t('report.title')} />
        <p aria-busy="true" style={{ color: 'var(--text-2)', fontSize: 14, padding: '40px 0' }}>{t('report.loading')}</p>
      </>
    );
  }

  const s = report.session;
  const enrichPending = !!s.reportPending && !gaveUp;
  const breakdown = (s.breakdown ?? []).map((b) => {
    const ck = canonicalDimKey(b.key);
    return { key: ck ? t(`report.dim.${ck}`) : b.key, value: b.value, note: b.note };
  });

  return (
    <>
      <PageHeader
        eyebrow={`${s.role} · ${t(`setup.modeShort.${s.mode}`)}`}
        title={t('report.title')}
        sub={s.summary ?? undefined}
      />

      {s.status !== 'completed' && (
        <div style={{ border: '1px solid var(--rule)', borderRadius: 'var(--r-lg, 12px)', padding: '12px 16px', marginBottom: 16, color: 'var(--text-2)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('report.processing')}</span>
          <Btn variant="default" onClick={() => void refresh()}>{refreshing ? t('report.refreshing') : t('report.refresh')}</Btn>
        </div>
      )}

      {s.status === 'completed' && enrichPending && (
        <div style={{ border: '1px solid var(--accent-text)', background: 'var(--accent-soft)', borderRadius: 'var(--r-lg, 12px)', padding: '12px 16px', marginBottom: 16, color: 'var(--text)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span aria-busy="true">{t('report.analysisPending')}</span>
        </div>
      )}

      <ResultsTop overall={s.overall ?? 0} delta={null} breakdown={breakdown} />

      <ResultsGrid strengths={s.strengths ?? []} gaps={s.gaps ?? []} />

      <RecommendationsCard recommendations={s.recommendations} enrichmentPending={enrichPending} />

      <QuestionBreakdownSection items={s.questionAnalysis} enrichmentPending={enrichPending} />

      {/* Recording */}
      {report.recordingUrl && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>{t('report.recording')}</div>
          {s.mode === 'video' ? (
            <video controls src={report.recordingUrl} style={{ width: '100%', maxWidth: 720, borderRadius: 'var(--r-lg, 12px)', background: '#000' }} />
          ) : (
            <audio controls src={report.recordingUrl} style={{ width: '100%', maxWidth: 520 }} />
          )}
        </div>
      )}

      {/* Transcript */}
      {report.transcript.length > 0 && (
        <div style={{ marginTop: 24, border: '1px solid var(--rule)', borderRadius: 'var(--r-xl, 16px)', padding: 20, background: 'var(--surface)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{t('report.transcript')}</div>
            {report.transcriptUrl && <a href={report.transcriptUrl} style={{ fontSize: 13, color: 'var(--accent, #3B84E2)' }}>{t('report.download')}</a>}
          </div>
          {report.transcript.filter((tr) => !tr.interim).map((turn, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: turn.role === 'candidate' ? 'var(--accent, #3B84E2)' : 'var(--text-2)' }}>
                {turn.role === 'candidate' ? t('live.you') : t('live.interviewer')}
              </span>
              <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)' }}>{turn.text}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 28, paddingBottom: 40 }}>
        <Btn variant="primary" as="a" href="/mock-interview">{t('report.newInterview')}</Btn>
      </div>
    </>
  );
}
