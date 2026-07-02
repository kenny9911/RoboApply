'use client';

// components/v3/account/sections.tsx
//
// Account-page structural primitives + the Profile section.
//   - SectionNav     sticky pill row (Profile · Billing · Usage · Security)
//   - SecLabel       a mono uppercase section heading
//   - Panel          the surface card the account sections sit on
//   - ProfileCard    avatar + display name (inline edit) + email/verified +
//                    member-since + sign-in-method chip
//
// All visuals are inline-styled against the V3 token set (the mockup classes
// .panel/.profile/etc. are not in v3.css; we reproduce them here so the page
// is self-contained). Reuses .btn / .avatar / .tag from v3.css.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Btn } from '../primitives/Btn';
import { Tag } from '../primitives/Tag';
import { IconCheck, IconEdit, IconX } from '../primitives/Iconset';

// ─────────────────────────────────────────────────────────────────────
// Section ids — shared by the page + nav so anchors stay in sync.
// ─────────────────────────────────────────────────────────────────────

export type AccountSectionId = 'profile' | 'billing' | 'usage' | 'security';

export const ACCOUNT_SECTIONS: AccountSectionId[] = [
  'profile',
  'billing',
  'usage',
  'security',
];

// ─────────────────────────────────────────────────────────────────────
// SectionNav — sticky pill row. Highlights the section currently in view
// (scroll-spy via IntersectionObserver) and scrolls to it on click.
// ─────────────────────────────────────────────────────────────────────

export function SectionNav({ labels }: { labels: Record<AccountSectionId, string> }) {
  const [active, setActive] = useState<AccountSectionId>('profile');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) {
          setActive(visible.target.id as AccountSectionId);
        }
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    ACCOUNT_SECTIONS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const onJump = (id: AccountSectionId) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };

  return (
    <nav
      aria-label="Account sections"
      style={{
        display: 'flex',
        gap: 6,
        marginBottom: 30,
        flexWrap: 'wrap',
        position: 'sticky',
        top: 8,
        zIndex: 4,
        background: 'var(--bg)',
        paddingTop: 4,
        paddingBottom: 4,
      }}
    >
      {ACCOUNT_SECTIONS.map((id) => {
        const on = active === id;
        return (
          <button
            key={id}
            type="button"
            aria-current={on ? 'true' : undefined}
            onClick={() => onJump(id)}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '11.5px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: on ? 'var(--accent-ink)' : 'var(--muted)',
              padding: '7px 13px',
              borderRadius: '99px',
              border: `1px solid ${on ? 'var(--accent-text)' : 'var(--rule)'}`,
              background: on ? 'var(--accent)' : 'var(--surface)',
              cursor: 'pointer',
            }}
          >
            {labels[id]}
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SecLabel + Panel + section anchor wrapper
// ─────────────────────────────────────────────────────────────────────

export function SecLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div
      id={id}
      style={{
        fontFamily: 'var(--mono)',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: 'var(--muted)',
        fontWeight: 600,
        margin: '36px 0 14px',
        scrollMarginTop: 80,
      }}
    >
      {children}
    </div>
  );
}

export function Panel({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 'var(--r-lg)',
        padding: 22,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A mono uppercase caption used inside panels (e.g. "Change password"). */
export function CapLabel({
  children,
  style,
}: {
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: 'var(--muted)',
        fontWeight: 600,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SignInMethodChip — small provider chip (Google / Email).
// ─────────────────────────────────────────────────────────────────────

function providerGlyph(provider: string): ReactNode {
  const p = provider.toLowerCase();
  if (p.includes('google')) {
    return (
      <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#EA4335"
          d="M12 11v3.8h5.3c-.2 1.4-1.6 4-5.3 4-3.2 0-5.8-2.6-5.8-5.8S8.8 7.2 12 7.2c1.8 0 3 .8 3.7 1.5l2.5-2.4C16.6 4.7 14.5 4 12 4 6.9 4 2.8 8.1 2.8 13S6.9 22 12 22c5.3 0 8.8-3.7 8.8-9 0-.6 0-1-.1-1.5H12z"
        />
      </svg>
    );
  }
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

function SignInMethodChip({ provider, label }: { provider: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--mono)',
        fontSize: '11px',
        color: 'var(--text-2)',
        background: 'var(--surface-2)',
        border: '1px solid var(--rule)',
        padding: '3px 9px',
        borderRadius: '99px',
      }}
    >
      {providerGlyph(provider)}
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ProfileCard
// ─────────────────────────────────────────────────────────────────────

function initialFrom(name: string | null, email: string): string {
  const src = (name && name.trim()) || email;
  return (src.trim()[0] || '?').toUpperCase();
}

/** Map a provider id → a display label. "email" / "local" → "Email". */
function providerLabel(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('google')) return 'Google';
  if (p.includes('linkedin')) return 'LinkedIn';
  if (p.includes('github')) return 'GitHub';
  return 'Email';
}

interface ProfileCardProps {
  name: string | null;
  email: string;
  provider: string;
  memberSinceLabel: string; // pre-formatted "Member since Feb 2026"
  verified: boolean;
  saving: boolean;
  onSaveName: (name: string) => void;
}

export function ProfileCard({
  name,
  email,
  provider,
  memberSinceLabel,
  verified,
  saving,
  onSaveName,
}: ProfileCardProps) {
  const t = useTranslations('account');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name ?? '');
      // Focus after the input mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editing, name]);

  const displayName = (name && name.trim()) || email.split('@')[0];

  const commit = () => {
    const next = draft.trim();
    if (next && next !== (name ?? '').trim()) {
      onSaveName(next);
    }
    setEditing(false);
  };

  return (
    <Panel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          aria-hidden="true"
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            background: 'var(--grad-brand)',
            color: 'var(--accent-ink)',
            fontWeight: 700,
            fontSize: 24,
            display: 'grid',
            placeItems: 'center',
            fontFamily: 'var(--mono)',
            flexShrink: 0,
            boxShadow: '0 0 0 1px var(--rule), 0 8px 24px -10px var(--accent-glow)',
          }}
        >
          {initialFrom(name, email)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(false);
                }}
                aria-label={t('profile.displayName')}
                maxLength={80}
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--rule)',
                  borderRadius: 9,
                  padding: '8px 12px',
                  color: 'var(--text)',
                  fontFamily: 'var(--sans)',
                  fontSize: '18px',
                  fontWeight: 600,
                  minWidth: 200,
                }}
              />
              <Btn variant="primary" onClick={commit} disabled={saving} icon={<IconCheck size={14} />}>
                {t('profile.save')}
              </Btn>
              <Btn variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                {t('profile.cancel')}
              </Btn>
            </div>
          ) : (
            <div
              style={{
                fontSize: '22px',
                fontWeight: 600,
                letterSpacing: '-0.02em',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              {displayName}
              <Btn variant="ghost" onClick={() => setEditing(true)} icon={<IconEdit size={14} />}>
                {t('profile.edit')}
              </Btn>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              marginTop: 8,
              fontFamily: 'var(--mono)',
              fontSize: '12px',
              color: 'var(--text-2)',
            }}
          >
            <span>{email}</span>
            {verified ? <Tag tone="strong">{t('profile.verified')}</Tag> : null}
            <SignInMethodChip provider={provider} label={providerLabel(provider)} />
            <span style={{ color: 'var(--muted)' }}>· {memberSinceLabel}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

export { IconX };
