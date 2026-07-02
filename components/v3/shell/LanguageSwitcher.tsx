'use client';

// LanguageSwitcher — the in-app UI-language picker.
//
// Setting the language does three things:
//   1. Writes the `robo_locale` cookie (so the server layout re-reads it and
//      hands NextIntlClientProvider the matching message bundle).
//   2. Best-effort persists the choice to the user's profile via
//      `PUT /preferences/locale` so requestless background jobs (weekly
//      insights, score refresh, digest emails) generate content in the same
//      language. The UI never blocks on this.
//   3. `router.refresh()` so the server tree re-renders with the new bundle
//      AND every API call thereafter carries the new `X-Robo-Locale` header
//      (set from the cookie in lib/api/client.ts) — so LLM responses come
//      back in the chosen language too.
//
// Two variants:
//   - 'icon' (default) — compact globe button for the Topbar.
//   - 'full'           — a labelled row of pills for the Preferences page.

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { READY_LOCALES, type RoboLocale } from '../../../lib/localeConfig';
import { setLocaleCookie } from '../../../lib/locale';
import { roboApi } from '../../../lib/api/client';

function GlobeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
    </svg>
  );
}

export function LanguageSwitcher({
  variant = 'icon',
}: {
  variant?: 'icon' | 'full';
}) {
  const locale = useLocale();
  const t = useTranslations('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  const current =
    READY_LOCALES.find((l) => l.code === locale) ?? READY_LOCALES[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function choose(code: RoboLocale) {
    setOpen(false);
    if (code === locale) return;
    setLocaleCookie(code);
    // Best-effort persist for requestless jobs — never block the UI on it.
    roboApi
      .put('/api/v1/roboapply/v2/preferences/locale', { locale: code })
      .catch(() => {});
    startTransition(() => router.refresh());
  }

  // ── Full variant — labelled pill row (Preferences page) ──────────────────
  if (variant === 'full') {
    return (
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
        role="radiogroup"
        aria-label={t('language')}
      >
        {READY_LOCALES.map((l) => {
          const active = l.code === locale;
          return (
            <button
              key={l.code}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(l.code)}
              style={{
                padding: '7px 14px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                border: `1px solid ${active ? 'var(--accent-text)' : 'var(--rule)'}`,
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                color: active ? 'var(--accent-text)' : 'var(--text)',
              }}
            >
              {l.label}
            </button>
          );
        })}
      </div>
    );
  }

  // ── Icon variant — compact globe dropdown (Topbar) ───────────────────────
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('language')}
        title={`${t('language')} · ${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon size={15} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t('language')}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 60,
            minWidth: 168,
            padding: 6,
            borderRadius: 12,
            border: '1px solid var(--rule)',
            background: 'var(--surface)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
          }}
        >
          {READY_LOCALES.map((l) => {
            const active = l.code === locale;
            return (
              <button
                key={l.code}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(l.code)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  textAlign: 'left',
                  background: active ? 'var(--accent-soft)' : 'transparent',
                  color: active ? 'var(--accent-text)' : 'var(--text)',
                }}
                onMouseEnter={(e) => {
                  if (!active)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'var(--surface-2)';
                }}
                onMouseLeave={(e) => {
                  if (!active)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'transparent';
                }}
              >
                <span>{l.label}</span>
                {active ? <span aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
