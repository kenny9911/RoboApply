'use client';

// CommandPalette — the ⌘K overlay. A real palette (not the prototype's static
// span): job/company search via raV2Api.search.run + quick-nav to the V3
// routes. Opens on ⌘K / Ctrl-K from anywhere, or via the Topbar search button
// (both go through CommandPaletteProvider's `open()`).
//
// Behaviour:
//   • Type → debounced search.run({ q, sortBy:'match_desc' }); results show
//     under a "Jobs" group. With an empty query we show quick-nav only.
//   • ↑/↓ move the highlight across the flat result list; Enter selects;
//     Esc closes. Selecting a job routes to /home (the Today match feed is the
//     job surface in V3 — there's no standalone /jobs/[id] anymore); selecting
//     a nav item routes to it.
//   • Solid dark panel (literal #181923) per CLAUDE.md; dim backdrop.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { raV2Api } from '../../../lib/api/v2';
import type { SearchRunResponse } from '../../../lib/api/v2';
import { IconSearch, IconArrow } from '../primitives/Iconset';
import {
  isJobApplyRoute,
  QUEUE_REVIEW_ENABLED,
  useJobApplyingEnabled,
} from '../../../lib/jobApplying';

// ── context ──────────────────────────────────────────────────────────
interface PaletteCtx {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}
const Ctx = createContext<PaletteCtx | null>(null);

export function useCommandPalette(): PaletteCtx {
  const c = useContext(Ctx);
  if (!c) return { open: () => undefined, close: () => undefined, isOpen: false };
  return c;
}

const PANEL_BG = 'var(--surface)';

// Quick-nav targets (mirrors the sidebar IA, including the launch-hidden /queue).
const NAV_TARGETS: { href: string; labelKey: string }[] = [
  { href: '/home', labelKey: 'today' },
  { href: '/queue', labelKey: 'queue' },
  { href: '/resumes', labelKey: 'resumes' },
  { href: '/mock-interview', labelKey: 'interview' },
  { href: '/tracker', labelKey: 'tracker' },
  { href: '/tracker/activity', labelKey: 'activity' },
  { href: '/preferences', labelKey: 'preferences' },
].filter((n) => QUEUE_REVIEW_ENABLED || n.href !== '/queue');

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Global ⌘K / Ctrl-K.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo<PaletteCtx>(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CommandPalette isOpen={isOpen} onClose={close} />
    </Ctx.Provider>
  );
}

// ── palette ──────────────────────────────────────────────────────────
function CommandPalette({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const router = useRouter();
  const t = useTranslations('nav_v3');
  const tp = useTranslations('palette');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // When job-applying is off, drop the auto-apply nav targets and the job
  // search (job picks route to /home, which is hidden).
  const showJobApply = useJobApplyingEnabled() === true;

  // Reset + focus when opened.
  useEffect(() => {
    if (isOpen) {
      setQ('');
      setDebounced('');
      setActive(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  // Debounce the query.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 180);
    return () => window.clearTimeout(id);
  }, [q]);

  const { data, isFetching } = useQuery<SearchRunResponse>({
    queryKey: ['v3', 'palette', 'search', debounced],
    queryFn: () => raV2Api.search.run({ q: debounced, limit: 6, sortBy: 'match_desc' }),
    enabled: isOpen && debounced.length >= 2 && showJobApply,
    staleTime: 30_000,
  });

  const jobs = debounced.length >= 2 && showJobApply ? data?.jobs ?? [] : [];

  // Filter quick-nav by query (and drop the auto-apply targets when off).
  const navMatches = useMemo(() => {
    const ql = debounced.toLowerCase();
    return NAV_TARGETS.filter(
      (n) =>
        (showJobApply || !isJobApplyRoute(n.href)) &&
        (!ql || t(n.labelKey).toLowerCase().includes(ql)),
    );
  }, [debounced, t, showJobApply]);

  // Flat selectable list: nav items first, then jobs.
  const flat = useMemo(
    () => [
      ...navMatches.map((n) => ({ type: 'nav' as const, href: n.href, label: t(n.labelKey) })),
      ...jobs.map((j) => ({
        type: 'job' as const,
        href: '/home',
        label: `${j.title} · ${j.companyName}`,
      })),
    ],
    [navMatches, jobs, t],
  );

  const select = useCallback(
    (i: number) => {
      const item = flat[i];
      if (!item) return;
      onClose();
      router.push(item.href);
    },
    [flat, onClose, router],
  );

  // Keyboard nav within the palette.
  useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, Math.max(0, flat.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        select(active);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, flat.length, active, select, onClose]);

  // Clamp the highlight if the list shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  if (!isOpen) return null;

  let runningIndex = -1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tp('aria')}
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: 'rgba(7, 8, 13, 0.62)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        style={{ background: PANEL_BG, border: '1px solid var(--rule)' }}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-3 px-4 py-3.5"
          style={{ borderBottom: '1px solid var(--rule)' }}
        >
          <IconSearch size={16} stroke="var(--muted)" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tp('placeholder')}
            className="flex-1 bg-transparent outline-none"
            style={{ color: 'var(--text)', fontFamily: 'var(--sans)', fontSize: 15 }}
          />
          <kbd
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              background: 'var(--bg)',
              padding: '2px 6px',
              borderRadius: 4,
              color: 'var(--text-2)',
              border: '1px solid var(--rule)',
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[52vh] overflow-y-auto py-2">
          {navMatches.length > 0 ? (
            <Group label={tp('group_nav')}>
              {navMatches.map((n) => {
                runningIndex += 1;
                const i = runningIndex;
                return (
                  <Row
                    key={n.href}
                    active={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => select(i)}
                    icon={<IconArrow size={14} stroke="var(--muted)" />}
                    label={t(n.labelKey)}
                  />
                );
              })}
            </Group>
          ) : null}

          {jobs.length > 0 ? (
            <Group label={tp('group_jobs')}>
              {jobs.map((j) => {
                runningIndex += 1;
                const i = runningIndex;
                return (
                  <Row
                    key={j.id}
                    active={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => select(i)}
                    icon={<IconSearch size={14} stroke="var(--accent-text)" />}
                    label={j.title}
                    sub={j.companyName}
                  />
                );
              })}
            </Group>
          ) : null}

          {flat.length === 0 ? (
            <p
              className="px-4 py-8 text-center"
              style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}
            >
              {isFetching ? tp('searching') : tp('empty')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1">
      <div
        className="px-4 pb-1.5 pt-2"
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          color: 'var(--muted)',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({
  active,
  onClick,
  onMouseEnter,
  icon,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  icon: ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      style={{
        background: active ? 'var(--accent-soft)' : 'transparent',
        boxShadow: active ? 'inset 2px 0 0 var(--accent-text)' : 'none',
      }}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)', fontSize: 14 }}>
        {label}
        {sub ? (
          <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12.5 }}>· {sub}</span>
        ) : null}
      </span>
    </button>
  );
}
