'use client';

// AvatarMenu — the monogram button in the Topbar and the menu behind it:
// Settings, Billing, Sign out.
//
// This is the whole reason the rail lost its Settings group. Four destinations
// fit on a phone; account plumbing does not, and until now it simply was not
// there: styles/v3.css hides the sidebar below 760px and the old bottom bar
// shipped four tabs, so a phone user could not open billing, change a setting,
// or cancel a subscription at all. The Topbar renders at every width, so
// mounting the menu here is what gives mobile parity.
//
// Keyboard contract (WAI-ARIA menu button):
//   • Enter / Space / ArrowDown open and focus the first item; ArrowUp opens
//     and focuses the last.
//   • ArrowUp / ArrowDown move between items and wrap; Home / End jump.
//   • Escape closes and returns focus to the trigger — losing focus to <body>
//     after a menu closes strands a keyboard user at the top of the document.
//   • Tab closes and lets focus continue past the menu.
//   • A click anywhere else closes it.
//
// Styling is inline rather than a `.avatar-menu` class because this component
// ships without a stylesheet change; `.avatar` (the trigger) already exists.

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useAuth } from '../../../lib/auth/useAuth';
import { logout } from '../../../lib/api/auth';
import { IconPerson } from '../primitives/Iconset';
import { cleanUpDeviceOnSignOut, leaveSignedOut } from './signOutCleanup';

/**
 * A placeholder address, not a mailbox: `.invalid` is reserved (RFC 6761) and
 * is what a GoApply phone account carries in place of an email
 * (`u-<random>@users.goapply.invalid`, server/src/features/auth-cn/accounts.ts).
 */
function isPlaceholderAddress(source: string): boolean {
  return source.toLowerCase().endsWith('.invalid');
}

/**
 * Initials for the trigger: two letters from a name, else from the address.
 * Empty when there is nothing real to abbreviate — no session yet, or a phone
 * account with no name. The trigger then shows a person icon. It never falls
 * back to made-up letters: the old 'RA' was RoboApply's initials on GoApply
 * too, and a placeholder address abbreviated to "UU".
 */
export function initialsFor(source: string | null | undefined): string {
  const src = source?.trim() ?? '';
  if (!src || isPlaceholderAddress(src)) return '';
  const bits = src.split(/[\s@.]+/).filter(Boolean);
  if (bits.length >= 2) return (bits[0][0] + bits[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/**
 * @deprecated Use `initialsFor`. Nothing renders this: it is `initialsFor`
 * with the old 'RA' fallback, kept only because
 * __tests__/components/AvatarMenu.test.tsx still pins that fallback. Delete it
 * together with those two assertions.
 */
export function monogramFor(source: string | null | undefined): string {
  return initialsFor(source) || 'RA';
}

const MENU_STYLE: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 8px)',
  right: 0,
  minWidth: 200,
  padding: 'var(--sp-1)',
  background: 'var(--surface)',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--r-md)',
  zIndex: 40,
};

const ITEM_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 'var(--sp-2) var(--sp-3)',
  borderRadius: 'var(--r-sm)',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-2)',
  fontSize: 'var(--fs-meta)',
  fontFamily: 'inherit',
  fontWeight: 500,
  textAlign: 'left',
  textDecoration: 'none',
  cursor: 'pointer',
};

export function AvatarMenu() {
  const t = useTranslations('nav');
  const { user, clear } = useAuth();
  const [open, setOpen] = useState(false);
  // Which item to focus once the menu has rendered, as an index into the
  // items (-1 = the last one). `null` = nothing pending.
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  const menuId = useId();
  const triggerId = useId();
  // True from the Sign out click until the page leaves (see signOut below).
  const [signingOut, setSigningOut] = useState(false);
  const signOutInFlight = useRef(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  // A name that is only spaces is no name; fall through to the address.
  const initials = initialsFor(user?.name?.trim() || user?.email);

  const focusItem = useCallback((index: number) => {
    const items = itemRefs.current.filter(Boolean) as HTMLElement[];
    if (items.length === 0) return;
    const wrapped = ((index % items.length) + items.length) % items.length;
    items[wrapped]?.focus();
  }, []);

  const closeAndRestore = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Keyboard opening asks for an item by index; the items do not exist until
  // the menu has rendered, so the focus lands here, one commit later.
  useEffect(() => {
    if (!open) {
      itemRefs.current = [];
      return;
    }
    if (pendingFocus !== null) {
      focusItem(pendingFocus);
      setPendingFocus(null);
    }
  }, [open, pendingFocus, focusItem]);

  // A click outside dismisses without stealing focus back (the user is already
  // pointing at whatever they meant to hit).
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
      setPendingFocus(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setPendingFocus(-1);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const items = itemRefs.current.filter(Boolean) as HTMLElement[];
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRestore();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(current + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(current - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(-1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  /**
   * Sign out, in this order:
   *   1. forget this device (signOutCleanup.ts): the push subscription is
   *      removed while the session can still authorise it, then unsent
   *      resume-builder drafts are cleared from this browser. It never throws
   *      and gives up by itself after a few seconds, so it cannot block 2–4;
   *   2. end the server session (the route is deliberately sessionless: it
   *      clears the cookie even for a token it cannot validate, so this works
   *      from a stranded session too);
   *   3. clear the client;
   *   4. a HARD navigation — not laziness: it drops the TanStack cache, which
   *      still holds the previous account's jobs and applications.
   */
  async function signOut() {
    // One sign-out at a time. Step 1 can take a few seconds on a slow push
    // service, so the menu stays open and its item reads "Signing out…" until
    // the page leaves; a second click or Enter does nothing.
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    try {
      await cleanUpDeviceOnSignOut();
    } catch {
      // Belt and braces: the cleanup swallows its own errors.
    }
    try {
      window.localStorage.removeItem('auth_token');
    } catch {
      // Storage unavailable (private mode) — the cookie clear below still runs.
    }
    try {
      await logout();
    } catch {
      // Already signed out server-side, or offline. Clear the client anyway;
      // leaving the user on an authenticated-looking screen is worse.
    }
    clear();
    leaveSignedOut();
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="avatar"
        style={{ border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
        aria-label={t('account_menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          // Opening always lands focus on the first item, pointer or not —
          // otherwise Tab from the trigger walks straight past an open menu.
          if (!open) setPendingFocus(0);
          setOpen(!open);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {initials || <IconPerson size={18} aria-hidden="true" />}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className="shadow-e2"
          style={MENU_STYLE}
          onKeyDown={onMenuKeyDown}
        >
          <Link
            ref={(el) => {
              itemRefs.current[0] = el;
            }}
            href="/settings"
            role="menuitem"
            tabIndex={-1}
            style={ITEM_STYLE}
            onClick={() => setOpen(false)}
          >
            {t('settings')}
          </Link>
          <Link
            ref={(el) => {
              itemRefs.current[1] = el;
            }}
            href="/settings#billing"
            role="menuitem"
            tabIndex={-1}
            style={ITEM_STYLE}
            onClick={() => setOpen(false)}
          >
            {t('billing')}
          </Link>
          <button
            ref={(el) => {
              itemRefs.current[2] = el;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            style={signingOut ? { ...ITEM_STYLE, cursor: 'default', color: 'var(--text-muted)' } : ITEM_STYLE}
            aria-disabled={signingOut || undefined}
            aria-busy={signingOut || undefined}
            onClick={() => void signOut()}
          >
            {signingOut ? t('signing_out') : t('sign_out')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
