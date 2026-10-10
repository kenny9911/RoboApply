'use client';

// First visit after onboarding (PRODUCT O8, WP-30) — everything that shows on
// /jobs once the tour is over, ONE thing at a time:
//
//   1. "Finish setting up — {n} steps left" when the user left onboarding
//      early. A persistent banner (not a popup); after two dismissals it
//      moves to Settings (`FinishSetupSettingsLine`).
//   2. Otherwise, inline tips in order, each through lib/ui/popupGate.ts (one
//      per page view, 24 h budget; the checklist too) and each shown once:
//        score tip → resume-check banner (only with a finished check) →
//        skills check (only when the feed has skills to ask about) →
//        getting-started checklist (WP-23's card).
//      The feed-rating card after 10 cards is the feed's (WP-33).
//
// Nothing here invents numbers: "k things to fix" is the finished check's
// issue count; "asked in X of Y" comes from the feed's skills check.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useOnboardingState } from '../../../hooks/onboarding/useOnboarding';
import { getSkillsCheck } from '../../../lib/api/feed';
import { getProfile, putSkills } from '../../../lib/api/profile';
import { getLatestGrade } from '../../../lib/api/resumes';
import { listSearchProfiles, updateSearchProfile } from '../../../lib/api/search';
import { dismiss as dismissUi, getUiState, markToursSeen } from '../../../lib/api/uiState';
import type { UiStateResponse } from '../../../lib/api/contracts/uistate';
import { UI_STATE_QUERY_KEY, usePopupGate } from '../../../lib/ui/popupGate';
import { Btn } from '../../v3/primitives/Btn';
import { IconX } from '../../v3/primitives/Iconset';
import { GettingStartedChecklist } from '../growth';
import { FINISH_BANNER_MAX_DISMISSALS, UI_KEYS } from './options';
import styles from './onboarding.module.css';

function useUiState(enabled: boolean) {
  return useQuery<UiStateResponse>({
    queryKey: UI_STATE_QUERY_KEY,
    queryFn: ({ signal }) => getUiState({ signal }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function useUiWrite() {
  const qc = useQueryClient();
  return useMutation<UiStateResponse, unknown, { seen?: string; dismissed?: string }>({
    mutationFn: ({ seen, dismissed }) => (seen ? markToursSeen([seen]) : dismissUi([dismissed!])),
    onSuccess: (res) => qc.setQueryData(UI_STATE_QUERY_KEY, res),
  });
}

/** The finish banner (also usable on its own). */
export function FinishSetupBanner({ stepsLeft, onDismiss }: { stepsLeft: number; onDismiss: () => void }) {
  const t = useTranslations('onboarding.finish');
  return (
    <section className={styles.dock} role="region" aria-label={t('banner', { count: stepsLeft })} data-testid="finish-banner">
      <p className={styles.dockTitle}>{t('banner', { count: stepsLeft })}</p>
      <div className={styles.dockActions}>
        <Btn as="a" href="/onboarding" variant="primary" className={styles.touch}>
          {t('resume')}
        </Btn>
        <Btn type="button" variant="ghost" onClick={onDismiss} className={styles.touch}>
          {t('dismiss')}
        </Btn>
      </div>
    </section>
  );
}

/** Settings line once the banner has been dismissed twice (INT mounts it in Settings → #account). */
export function FinishSetupSettingsLine() {
  const t = useTranslations('onboarding.finish');
  const state = useOnboardingState();
  const left = state.data?.progress.leftEarly ? state.data.progress.stepsLeft : 0;
  if (!left) return null;
  return (
    <div className={styles.settingsLine} data-testid="finish-settings-line">
      <span>{t('settingsLine', { count: left })}</span>
      <Btn as="a" href="/onboarding" className={styles.touch}>
        {t('settingsAction')}
      </Btn>
    </div>
  );
}

function TipCard({ title, children, onClose, testId }: { title?: string; children: ReactNode; onClose: () => void; testId: string }) {
  const t = useTranslations('onboarding.tips');
  return (
    <section className={styles.dock} role="region" aria-label={title ?? t('scoreTitle')} data-testid={testId}>
      <div className={styles.dialogHead}>
        {title ? <p className={styles.dockTitle}>{title}</p> : <span />}
        <button type="button" className={styles.iconBtn} aria-label={t('close')} onClick={onClose}>
          <IconX size={16} />
        </button>
      </div>
      {children}
    </section>
  );
}

type TipKind = 'score' | 'resume' | 'skills' | 'checklist';

/** The dock on /jobs: the finish banner, else the next unseen tip. */
export function OnboardingPromptDock() {
  const t = useTranslations('onboarding.tips');
  const onboarding = useOnboardingState();
  const ui = useUiState(true);
  const write = useUiWrite();
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const state = onboarding.data;
  const tours = ui.data?.state.tours ?? {};
  const dismissals = ui.data?.state.dismissals ?? {};
  const variantId = (state?.answers as { resume?: { resumeVariantId?: string } } | undefined)?.resume?.resumeVariantId ?? null;

  const grade = useQuery({
    queryKey: ['onboarding', 'resumeCheck', variantId],
    queryFn: ({ signal }) => getLatestGrade(variantId!, { signal }),
    enabled: !!variantId && !!state?.completed && !tours[UI_KEYS.resumeCheckBanner],
    staleTime: 60_000,
    retry: false,
  });
  const skills = useQuery({
    queryKey: ['onboarding', 'skillsCheck'],
    queryFn: ({ signal }) => getSkillsCheck({ signal }),
    enabled: !!state?.completed && !tours[UI_KEYS.skillsCheck],
    staleTime: 10 * 60_000,
    retry: false,
  });

  const leftEarly = state?.progress.leftEarly ?? null;
  const bannerCount = dismissals[UI_KEYS.finishBanner]?.count ?? 0;
  const showBanner = !!leftEarly && state!.progress.stepsLeft > 0 && bannerCount < FINISH_BANNER_MAX_DISMISSALS && !closed.has('banner');

  const doneGrade = grade.data?.grade && grade.data.grade.status === 'done' ? grade.data.grade : null;
  const skillRows = skills.data?.skills ?? [];
  let tip: TipKind | null = null;
  if (state?.completed && ui.data) {
    if (!tours[UI_KEYS.scoreTip]) tip = 'score';
    else if (doneGrade && !tours[UI_KEYS.resumeCheckBanner]) tip = 'resume';
    else if (skillRows.length && !tours[UI_KEYS.skillsCheck]) tip = 'skills';
    else tip = 'checklist';
  }
  if (tip && closed.has(tip)) tip = null;

  // Every inline prompt, the checklist included, goes through the shared popup budget (PRODUCT O8).
  const gate = usePopupGate(`onboarding:${tip ?? 'none'}`, 'survey', { enabled: !showBanner && !!tip });

  if (showBanner) {
    return (
      <FinishSetupBanner
        stepsLeft={state!.progress.stepsLeft}
        onDismiss={() => {
          setClosed(new Set([...closed, 'banner']));
          write.mutate({ dismissed: UI_KEYS.finishBanner });
        }}
      />
    );
  }
  if (!tip) return null;
  if (!gate.granted) return null;
  if (tip === 'checklist') return <ChecklistDock />;

  const close = (key: string) => {
    setClosed(new Set([...closed, tip!]));
    write.mutate({ seen: key });
  };

  if (tip === 'score') {
    return (
      <TipCard title={t('scoreTitle')} onClose={() => close(UI_KEYS.scoreTip)} testId="tip-score">
        <p className={styles.dockText}>{t('scoreBody')}</p>
        <p className={styles.dockText}>
          <strong>{t('scoreLine')}</strong>
        </p>
        <div className={styles.dockActions}>
          <Btn type="button" onClick={() => close(UI_KEYS.scoreTip)} className={styles.touch}>
            {t('dismiss')}
          </Btn>
        </div>
      </TipCard>
    );
  }
  if (tip === 'resume' && doneGrade) {
    return (
      <TipCard onClose={() => close(UI_KEYS.resumeCheckBanner)} testId="tip-resume">
        <p className={styles.dockTitle}>{t('resumeCheck', { count: doneGrade.issues.length })}</p>
        <div className={styles.dockActions}>
          <Link className={styles.link} href={`/resume/${encodeURIComponent(doneGrade.resumeVariantId)}/check`} onClick={() => close(UI_KEYS.resumeCheckBanner)}>
            {t('resumeCheckAction')}
          </Link>
        </div>
      </TipCard>
    );
  }
  if (tip === 'skills') {
    return <SkillsCheckTip rows={skillRows} onClose={() => close(UI_KEYS.skillsCheck)} />;
  }
  return null;
}

function ChecklistDock() {
  return (
    <div className={styles.dock} data-testid="tip-checklist">
      <GettingStartedChecklist variant="compact" />
    </div>
  );
}

/** "Do you have these skills?" — yes adds to profile skills (not the resume); no hides jobs that require it (a filter change, said first). */
function SkillsCheckTip({ rows, onClose }: { rows: Array<{ skill: string; askedIn: number; outOf: number }>; onClose: () => void }) {
  const t = useTranslations('onboarding.skillsCheck');
  const qc = useQueryClient();
  const [answered, setAnswered] = useState<Record<string, 'yes' | 'no'>>({});
  const [pendingNo, setPendingNo] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const closedOnce = useRef(false);
  useEffect(() => {
    const shown = rows.slice(0, 5);
    if (!closedOnce.current && shown.length && shown.every((r) => answered[r.skill])) {
      closedOnce.current = true;
      onClose();
    }
  }, [answered, rows, onClose]);

  async function yes(skill: string) {
    try {
      const profile = await getProfile();
      if (!profile.skills.some((s) => s.name.toLowerCase() === skill.toLowerCase())) {
        await putSkills({ skills: [...profile.skills, { name: skill, confirmed: true }] });
      }
      setAnswered((a) => ({ ...a, [skill]: 'yes' }));
    } catch {
      setFailed(true);
    }
  }

  async function no(skill: string) {
    try {
      const list = await listSearchProfiles();
      const active = list.profiles.find((p) => p.isActive) ?? list.profiles.find((p) => p.isDefault);
      if (active) {
        const excluded = [...new Set([...(active.filters.excludedSkills ?? []), skill])];
        await updateSearchProfile(active.id, { baseVersion: active.version, filtersPatch: { excludedSkills: excluded } });
        await qc.invalidateQueries({ queryKey: ['search'] });
      }
      setAnswered((a) => ({ ...a, [skill]: 'no' }));
      setPendingNo(null);
    } catch {
      setFailed(true);
    }
  }

  return (
    <TipCard title={t('title')} onClose={onClose} testId="tip-skills">
      <ul className={styles.phases}>
        {rows.slice(0, 5).map((r) => (
          <li key={r.skill} className={styles.dockText}>
            <strong>{r.skill}</strong> · <span>{t('askedIn', { count: r.askedIn, total: r.outOf })}</span>
            {answered[r.skill] ? (
              <span> · {t(answered[r.skill] === 'yes' ? 'added' : 'hidden')}</span>
            ) : pendingNo === r.skill ? (
              <div className={styles.dockActions}>
                <span>{t('confirmNo', { skill: r.skill })}</span>
                <Btn type="button" onClick={() => void no(r.skill)} className={styles.touch}>
                  {t('confirmNoAction')}
                </Btn>
                <Btn type="button" variant="ghost" onClick={() => setPendingNo(null)} className={styles.touch}>
                  {t('cancel')}
                </Btn>
              </div>
            ) : (
              <div className={styles.dockActions}>
                <Btn type="button" onClick={() => void yes(r.skill)} className={styles.touch}>
                  {t('yes')}
                </Btn>
                <Btn type="button" variant="ghost" onClick={() => setPendingNo(r.skill)} className={styles.touch}>
                  {t('no')}
                </Btn>
              </div>
            )}
          </li>
        ))}
      </ul>
      {failed ? (
        <p className={styles.fieldError} role="alert">
          {t('failed')}
        </p>
      ) : null}
    </TipCard>
  );
}
