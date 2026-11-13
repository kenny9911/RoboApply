'use client';

// SidebarProfile — the person at the top of the rail, as resume.io's app
// shows it (docs/resume-io/TEARDOWN.md): the avatar inside a ring that fills
// to the profile's completeness, the percentage on a chip, the name, and the
// target role underneath — or "Set your target role" while there is none.
// The whole block opens /profile.
//
// Facts come from the profile read (hooks/profile/useProfile, shared with the
// Profile nav badge); until it arrives the ring and the chip are not drawn,
// and nothing is guessed. The headline is the profile's target role line.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useAuth } from '../../../lib/auth/useAuth';
import { useProfile } from '../../../hooks/profile/useProfile';
import { initialsFor } from './AvatarMenu';

const SIZE = 52;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Clamp a server percentage into 0–100 (an older server may send nothing). */
export function completenessOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function SidebarProfile() {
  const t = useTranslations('nav.profile_card');
  const { user } = useAuth();
  const profile = useProfile({ enabled: Boolean(user) });
  const data = profile.data;

  const fullName =
    user?.name?.trim() ||
    [data?.firstName, data?.lastName].filter((part) => part && part.trim()).join(' ').trim() ||
    '';
  const initials = initialsFor(fullName || user?.email) || '·';
  const percent = completenessOf(data?.completeness);
  const role = data?.headline?.trim() || null;
  const complete = percent === 100;

  return (
    <Link href="/profile" className="side-profile">
      <span className="side-profile-avatar" data-complete={complete ? 'true' : 'false'} aria-hidden="true">
        {percent !== null ? (
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} focusable="false">
            <circle className="track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} />
            <circle
              className="fill"
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
            />
          </svg>
        ) : null}
        <span className="side-profile-initials">{initials}</span>
        {percent !== null ? <span className="side-profile-pct">{t('percent', { percent })}</span> : null}
      </span>
      <span className="side-profile-copy">
        <strong>{fullName || t('you')}</strong>
        <span>{role ?? t('set_role')}</span>
        {percent !== null ? <span className="sr-only">{t('complete', { percent })}</span> : null}
      </span>
    </Link>
  );
}
