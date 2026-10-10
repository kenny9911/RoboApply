'use client';

// components/features/feed/SkillsCheck.tsx — "Do you have these skills?"
// (PRODUCT §4.3 O8 item 4, F-FEED-09; ARCHITECTURE.md §4.9).
//
// Chips come from `GET /feed/skills-check`: skills often asked for in the
// user's search that the profile does not list, each with "Asked in X of Y
// posts" (real counts, D3). Yes → the skill is added to the PROFILE skills as
// confirmed (`PUT /profile/skills`), never to the resume. No → the change to
// the saved search (the skill added to excludedSkills) is shown first
// (FilterDiff) and saved only on confirm.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { Btn, toast } from '../../v3/primitives';
import { FilterDiff } from '../filters';
import { getProfile, putSkills } from '../../../lib/api/profile';
import type { SkillsCheckResponse } from '../../../lib/api/contracts/feed';
import { applyPatchPreview } from '../../../hooks/feed/filterOps';
import { feedKeys } from '../../../hooks/feed/keys';
import { useProposalApply } from './useProposalApply';
import styles from './feed.module.css';

/** Profile skills with `name` confirmed (added when missing). Pure. */
export function withConfirmedSkill<T extends { name: string; confirmed: boolean }>(skills: readonly T[], name: string): Array<T | { name: string; confirmed: true }> {
  const key = name.trim().toLocaleLowerCase();
  let found = false;
  const out: Array<T | { name: string; confirmed: true }> = skills.map((s) => {
    if (s.name.trim().toLocaleLowerCase() !== key) return s;
    found = true;
    return { ...s, confirmed: true };
  });
  if (!found) out.push({ name: name.trim(), confirmed: true });
  return out;
}

export interface SkillsCheckProps {
  data: SkillsCheckResponse;
  onClose: () => void;
}

export function SkillsCheck({ data, onClose }: SkillsCheckProps) {
  const t = useTranslations('jobs.skills');
  const qc = useQueryClient();
  const proposal = useProposalApply();
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmNo, setConfirmNo] = useState<string | null>(null);

  const skills = data.skills.filter((s) => s.outOf > 0 && !answered.has(s.skill));

  const done = (skill: string) => {
    const next = new Set(answered);
    next.add(skill);
    setAnswered(next);
    if (data.skills.every((s) => next.has(s.skill) || s.outOf <= 0)) onClose();
  };

  const yes = async (skill: string) => {
    setBusy(skill);
    try {
      const profile = await getProfile();
      await putSkills({ skills: withConfirmedSkill(profile.skills ?? [], skill) as Parameters<typeof putSkills>[0]['skills'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
      void qc.invalidateQueries({ queryKey: feedKeys.skillsCheck() });
      toast({ message: t('yesDone', { skill }), tone: 'ok' });
      done(skill);
    } catch {
      toast({ message: t('failed'), tone: 'warn' });
    } finally {
      setBusy(null);
    }
  };

  const noPatch = (skill: string) => {
    const current = proposal.profile?.filters.excludedSkills ?? [];
    return { excludedSkills: current.includes(skill) ? current : [...current, skill] };
  };

  const no = async (skill: string) => {
    setBusy(skill);
    const result = await proposal.save(noPatch(skill));
    setBusy(null);
    if (result === 'saved') {
      toast({ message: t('noDone', { skill }), tone: 'ok' });
      setConfirmNo(null);
      done(skill);
    } else {
      toast({ message: t('failed'), tone: 'warn' });
    }
  };

  if (confirmNo && proposal.profile) {
    const before = proposal.profile.filters;
    const after = applyPatchPreview(before, noPatch(confirmNo));
    return (
      <section className={styles.prompt} aria-label={t('noTitle', { skill: confirmNo })}>
        <h2 className={styles.promptTitle}>{t('noTitle', { skill: confirmNo })}</h2>
        <FilterDiff before={before} after={after} filters={after} />
        <div className={styles.row}>
          <Btn variant="primary" className={styles.actionBtn} disabled={busy !== null} onClick={() => void no(confirmNo)}>
            {t('noConfirm')}
          </Btn>
          <Btn className={styles.actionBtn} onClick={() => setConfirmNo(null)}>
            {t('noCancel')}
          </Btn>
        </div>
      </section>
    );
  }

  if (skills.length === 0) return null;

  return (
    <section className={styles.prompt} aria-label={t('title')} data-testid="skills-check">
      <h2 className={styles.promptTitle}>{t('title')}</h2>
      <p className={styles.help}>{t('intro')}</p>
      <div>
        {skills.map((s) => (
          <div key={s.skill} className={styles.skillRow}>
            <span className={styles.skillName}>
              {s.skill}
              <span className={styles.skillCount}>{t('askedIn', { count: s.askedIn, total: s.outOf })}</span>
            </span>
            <span className={styles.row}>
              <Btn className={styles.actionBtn} disabled={busy !== null} onClick={() => void yes(s.skill)}>
                {t('yes', { skill: s.skill })}
              </Btn>
              <Btn variant="ghost" className={styles.actionBtn} disabled={busy !== null || !proposal.profile} onClick={() => setConfirmNo(s.skill)}>
                {t('no', { skill: s.skill })}
              </Btn>
            </span>
          </div>
        ))}
      </div>
      <div className={styles.row}>
        <Btn variant="ghost" className={styles.actionBtn} onClick={onClose}>
          {t('close')}
        </Btn>
      </div>
    </section>
  );
}
