'use client';

// LaunchBar — the sticky setup footer (proto `.iv-launch`). Shows the current
// 4-pick selection (role / interviewer / format-type / mode) and the primary
// "Start interview" button. Disabled until all four picks are made (the brief's
// gate: enabled only when role + interviewer + type + format are chosen).

import { useTranslations } from 'next-intl';
import { IconBolt } from '../primitives/Iconset';
import { READY_LOCALES } from '../../../lib/localeConfig';
import { useMockRoleLabels } from '../../../lib/mockRoleLabels';
import type {
  RAMockFormat,
  RAMockInterviewer,
  RAMockType,
} from '../../../lib/api/v2/types';

interface Props {
  role: string | null;
  interviewer: RAMockInterviewer | null;
  type: RAMockType | null;
  format: RAMockFormat;
  language: string;
  durationMinutes: number;
  canLaunch: boolean;
  starting: boolean;
  onStart: () => void;
}

export function LaunchBar({
  role,
  interviewer,
  type,
  format,
  language,
  durationMinutes,
  canLaunch,
  starting,
  onStart,
}: Props) {
  const t = useTranslations('mock');
  const { localizeRole } = useMockRoleLabels();
  const languageLabel =
    READY_LOCALES.find((l) => l.code === language)?.label ?? language;

  return (
    <div className="iv-launch">
      <div className="iv-launch-summary">
        <div className="iv-launch-row">
          <span className="iv-launch-k">{t('setup.launch.role')}</span>
          <span className="iv-launch-v">{role ? localizeRole(role) : t('setup.launch.pickRole')}</span>
        </div>
        <div className="iv-launch-row">
          <span className="iv-launch-k">{t('setup.launch.interviewer')}</span>
          <span className="iv-launch-v">
            {interviewer ? (
              <>
                {interviewer.name} · <em>{interviewer.role}</em>
              </>
            ) : (
              t('setup.launch.pickInterviewer')
            )}
          </span>
        </div>
        <div className="iv-launch-row">
          <span className="iv-launch-k">{t('setup.launch.format')}</span>
          <span className="iv-launch-v">
            {type
              ? `${type.label} · ${t('setup.type.minutes', { minutes: durationMinutes })}`
              : t('setup.launch.pickType')}
          </span>
        </div>
        <div className="iv-launch-row">
          <span className="iv-launch-k">{t('setup.launch.mode')}</span>
          <span className="iv-launch-v">
            {format === 'video'
              ? t('setup.launch.modeVideo')
              : t('setup.launch.modeVoice')}
          </span>
        </div>
        <div className="iv-launch-row">
          <span className="iv-launch-k">{t('setup.launch.language')}</span>
          <span className="iv-launch-v">{languageLabel}</span>
        </div>
      </div>
      <button
        type="button"
        className="btn primary iv-launch-btn"
        onClick={onStart}
        disabled={!canLaunch || starting}
        style={!canLaunch || starting ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
      >
        <IconBolt size={15} />
        {starting ? t('setup.launch.starting') : t('setup.launch.start')}
      </button>
    </div>
  );
}
