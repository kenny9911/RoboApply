'use client';

// components/features/practice-cn/format.ts — the GoApply AI-interview
// practice format on the client (WP-66; INT-09): its id, its length rule and
// its labels.
//
// CLIENT MIRROR of server/src/features/cn/interview/contract.ts
// (CN_AI_INTERVIEW_FORMAT_ID, CN_FORMAT_MIN/MAX/DEFAULT_MINUTES) and
// format.ts (`clampCnMinutes`); __tests__/rubricParity.test.ts keeps them
// equal. The server decides what a session runs; these only keep the setup
// screen honest about it (the lengths offered, the price shown).

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { useMockRoleLabels } from '../../../lib/mockRoleLabels';
import { CN_AI_INTERVIEW_FORMAT_ID, type CnPracticeReport } from './rubric';

export const CN_FORMAT_MIN_MINUTES = 20;
export const CN_FORMAT_MAX_MINUTES = 30;
export const CN_FORMAT_DEFAULT_MINUTES = 25;

/** The lengths the setup offers for the format. */
export const CN_FORMAT_DURATIONS: readonly number[] = [CN_FORMAT_MIN_MINUTES, CN_FORMAT_DEFAULT_MINUTES, CN_FORMAT_MAX_MINUTES];

export function isCnFormatType(typeId: string | null | undefined): boolean {
  return typeId === CN_AI_INTERVIEW_FORMAT_ID;
}

/** Clamp a planned length into the format's 20–30 minutes (the server does the same). */
export function clampCnFormatMinutes(minutes: number | null | undefined): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return CN_FORMAT_DEFAULT_MINUTES;
  return Math.max(CN_FORMAT_MIN_MINUTES, Math.min(CN_FORMAT_MAX_MINUTES, Math.round(minutes)));
}

/** The planned length the server will run for this type: the format's range for the format, the choice otherwise. */
export function plannedMinutesForType(typeId: string | null | undefined, minutes: number): number {
  return isCnFormatType(typeId) ? clampCnFormatMinutes(minutes) : minutes;
}

export type LocalizeType = (id: string, field: 'label' | 'sub', fallback?: string) => string;

/**
 * `localizeType` (lib/mockRoleLabels) with the GoApply format's own label and
 * description: `practiceCn.format.label` / `.sub`. Every other type keeps its
 * `practice.setup.types.<id>.*` label, so RoboApply renders exactly as before.
 */
export function useLocalizeType(): LocalizeType {
  const { localizeType } = useMockRoleLabels();
  const t = useTranslations('practiceCn.format');
  return useCallback<LocalizeType>(
    (id, field, fallback) => (isCnFormatType(id) ? t(field) : localizeType(id, field, fallback)),
    // localizeType is rebuilt each render from the same translator; `t` is the stable input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );
}

/** One question's timing in the format, as the written practice's start returns it. */
export interface CnQuestionTimingPlan {
  prepSeconds: number;
  answerSeconds: number;
  story?: boolean;
}

/**
 * The timing of question `index`, or null. Null unless the plan has exactly
 * one entry per question, so a timing is never shown under the wrong question.
 */
export function cnTimingFor(
  plan: { questions?: readonly CnQuestionTimingPlan[] | null } | null | undefined,
  index: number,
  questionCount: number,
): CnQuestionTimingPlan | null {
  const list = plan?.questions;
  if (!Array.isArray(list) || list.length !== questionCount) return null;
  const item = list[index];
  return item && Number.isFinite(item.prepSeconds) && Number.isFinite(item.answerSeconds) ? item : null;
}

/** A report block the server sent (`report.cn` / a written practice's `cn`), or null when it is not one. */
export function asCnPracticeReport(value: unknown): CnPracticeReport | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<CnPracticeReport>;
  return v.version === 1 && Array.isArray(v.areas) && Array.isArray(v.answers) && !!v.star && !!v.fillers ? (value as CnPracticeReport) : null;
}
