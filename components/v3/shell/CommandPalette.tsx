'use client';

// CommandPalette — the ⌘K overlay. Job search through the feed
// (`queryFeed({ q })`, lib/api/feed.ts) + quick-nav to the visible
// destinations. Opens on ⌘K / Ctrl-K from anywhere, or via either Topbar
// search button (both go through CommandPaletteProvider's `open()`).
//
// Behaviour:
//   • Typing filters the quick-nav list at once and sends NOTHING. With two or
//     more characters a "Search jobs for “…”" row appears; Enter or a click
//     on that row runs ONE `queryFeed({ q })` and the first PALETTE_JOB_LIMIT
//     items show under a "Jobs" group.
//   • Why not search as you type: a first-page feed query is a list refresh on
//     the server. It scores a window, writes a feed session and counts against
//     the user's refresh budget (20 per 10 minutes, shared with /jobs —
//     FeedQueryService `consumeRefresh`). One request per keystroke pause
//     would use that up in two or three searches and lock the job list itself
//     with a 429. One request per search the user asked for does not, and the
//     same search inside that window is answered from the cache.
//   • It is the same query the job list runs, so the filters of the user's
//     active saved search apply and a hit is always a job the list can show.
//     The empty state says so, instead of "nothing found".
//   • Job search exists only where the feed does (`jobs.feed`; off on GoApply
//     until its recruitment-info mode allows a feed, R-14). Without it the
//     palette is a page jumper and says so: no request, no search row, no
//     "Jobs" group, and the placeholder does not promise a job search.
//   • ↑/↓ move the highlight across the flat result list; Enter selects;
//     Esc closes. Selecting a nav item routes to it. Selecting a job routes to
//     `jobHref(id)` (destinations.ts): `/jobs/[id]`.
//   • The nav targets are the visible nav entries for the brand and user
//     (destinations.ts), so the palette never offers a page the rail hides.
//   • A failed search says so; it is never shown as "nothing found". A search
//     the server refused because the refresh budget is used up (429
//     `feed_refresh_limited`) has its own message and no retry row.
//   • The panel is --surface with a --rule border, so it flips with the theme
//     instead of being a dark island in a light app; the backdrop stays a
//     near-black scrim in both themes, which is what a scrim is for.
//
// History: this used to call the frozen V2 client (`raV2Api.search.run`,
// /v2/search). INT-12 moved it to the feed wrapper so that route and its
// index service can be deleted (TASK_PLAN.md WP-93; join J6). Still open with
// the feed owner (INT-05): a lookup mode on feed.query that skips the refresh
// budget, the feed session and the saved-search filters.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { queryFeed } from '../../../lib/api/feed';
import { apiErrorReason } from '../../../lib/api/contracts/wire';
import type { FeedQueryResponse } from '../../../lib/api/contracts/feed';
import { useFlag } from '../../../lib/flags';
import { IconSearch, IconArrow } from '../primitives/Iconset';
import { jobHref, useVisibleNav } from './destinations';

/** How many job hits the palette lists (the feed page is longer; the rest is one click away on /jobs). */
export const PALETTE_JOB_LIMIT = 6;

/** The shortest text the palette offers to search jobs for. */
export const PALETTE_MIN_QUERY = 2;

/**
 * How long a palette search is answered from the cache: the server's refresh
 * window (server/src/platform/ratelimit/defaults.ts `feedRefresh`), so asking
 * for the same thing again inside it never spends a second refresh.
 */
export const PALETTE_SEARCH_STALE_MS = 10 * 60 * 1000;

/** React Query key of a palette search. */
export const paletteSearchKey = (q: string) => ['shell', 'palette', 'feed', q] as const;

/** True when the palette can search jobs here (the job feed exists for this brand and user). */
export function usePaletteJobSearch(): boolean {
  return useFlag('jobs.feed');
}

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
  const t = useTranslations('nav');
  const tp = useTranslations('nav');
  const canSearchJobs = usePaletteJobSearch();
  const [q, setQ] = useState('');
  // The text the user asked to search jobs for (Enter or a click on the
  // search row). Null until then: typing alone never sends a request.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set by a search; moves the highlight to the first hit when it arrives.
  const [highlightHits, setHighlightHits] = useState(false);
  // Quick-nav targets: every visible nav entry (Settings included) — the
  // same registry the Sidebar and the bottom bar render.
  const nav = useVisibleNav();
  const navTargets = useMemo(() => nav.all.map((e) => ({ href: e.href, labelKey: e.labelKey })), [nav.all]);

  // Reset + focus when opened.
  useEffect(() => {
    if (isOpen) {
      setQ('');
      setSubmitted(null);
      setActive(0);
      setHighlightHits(false);
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  const term = q.trim();
  const canOfferSearch = canSearchJobs && term.length >= PALETTE_MIN_QUERY;
  // A search was asked for exactly this text. Editing the text ends it.
  const searched = isOpen && canOfferSearch && submitted === term;
  const { data, isFetching, isError, error, refetch } = useQuery<FeedQueryResponse>({
    queryKey: paletteSearchKey(searched ? term : ''),
    queryFn: ({ signal }) => queryFeed({ q: term }, { signal }),
    enabled: searched,
    staleTime: PALETTE_SEARCH_STALE_MS,
    gcTime: PALETTE_SEARCH_STALE_MS,
    // Each request is a list refresh on the server: never send one the user
    // did not ask for.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const searching = searched && isFetching;
  // A retry keeps the old error until it settles; while it runs only
  // "Searching…" shows.
  const errored = searched && isError && !isFetching;
  const refreshLimited = errored && apiErrorReason(error) === 'feed_refresh_limited';
  const failed = errored && !refreshLimited;
  const answered = searched && !isFetching && !isError && data !== undefined;

  const jobs = useMemo(
    () =>
      answered
        ? (data?.items ?? []).slice(0, PALETTE_JOB_LIMIT).map((item) => ({ id: item.jobId, title: item.title, companyName: item.company.name }))
        : [],
    [answered, data],
  );

  // Filter quick-nav by what is typed: local, so it follows every keystroke.
  const navMatches = useMemo(() => {
    const ql = term.toLowerCase();
    return navTargets.filter((n) => !ql || t(n.labelKey).toLowerCase().includes(ql));
  }, [term, t, navTargets]);

  // The row that runs the search: offered until the search is asked for, and
  // again after a failure the user can retry.
  const showSearchRow = canOfferSearch && (!searched || failed);

  // Flat selectable list: nav items, then the search row, then job hits.
  const flat = useMemo(
    () => [
      ...navMatches.map((n) => ({ type: 'nav' as const, href: n.href, label: t(n.labelKey) })),
      ...(showSearchRow ? [{ type: 'search' as const, href: '', label: tp('palette.search_jobs', { query: term }) }] : []),
      ...jobs.map((j) => ({
        type: 'job' as const,
        href: jobHref(j.id),
        label: `${j.title} · ${j.companyName}`,
      })),
    ],
    [navMatches, showSearchRow, jobs, t, tp, term],
  );

  // The highlight, kept inside the list as it grows and shrinks.
  const activeIndex = Math.min(active, Math.max(0, flat.length - 1));

  // When the hits of a search arrive, the highlight goes to the first one, so
  // Enter, Enter opens the best hit. Done while rendering (not in an effect),
  // so the row that looks highlighted is always the one Enter opens.
  if (highlightHits && answered) {
    setHighlightHits(false);
    if (jobs.length > 0) setActive(navMatches.length);
  }

  const runSearch = useCallback(() => {
    if (!canOfferSearch) return;
    setHighlightHits(true);
    // The same text again after a failure: the query is still mounted, so ask
    // it again. Otherwise submitting enables the query for this text.
    if (submitted === term) void refetch();
    else setSubmitted(term);
  }, [canOfferSearch, submitted, term, refetch]);

  const select = useCallback(
    (i: number) => {
      const item = flat[i];
      if (!item) return;
      if (item.type === 'search') {
        runSearch();
        return;
      }
      onClose();
      router.push(item.href);
    },
    [flat, onClose, router, runSearch],
  );

  // Keyboard nav within the palette. The listener reads the current list
  // through a ref that is updated with every commit, so a key pressed right
  // after the list changed acts on what is on screen.
  const keyState = useRef({ activeIndex, count: flat.length, select });
  useLayoutEffect(() => {
    keyState.current = { activeIndex, count: flat.length, select };
  });
  useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(e: KeyboardEvent) {
      // An Enter that confirms an input-method candidate (Chinese, Japanese,
      // Korean) is not a command: it must not run a search or leave the page.
      if (e.isComposing || e.keyCode === 229) return;
      const cur = keyState.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(Math.min(cur.activeIndex + 1, Math.max(0, cur.count - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(Math.max(cur.activeIndex - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        cur.select(cur.activeIndex);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  let runningIndex = -1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tp('palette.aria')}
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(2px)' }}
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
          <IconSearch size={16} stroke="var(--text-muted)" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              // Editing the text ends the search that was asked for; coming
              // back to the same text needs Enter again (then it is answered
              // from the cache).
              setSubmitted(null);
              setHighlightHits(false);
              setActive(0);
            }}
            placeholder={canSearchJobs ? tp('palette.placeholder') : tp('palette.placeholder_pages')}
            aria-label={canSearchJobs ? tp('palette.placeholder') : tp('palette.placeholder_pages')}
            className="flex-1 bg-transparent outline-hidden"
            style={{ color: 'var(--text)', fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-body)' }}
          />
          <kbd
            style={{
              fontSize: 'var(--fs-label)',
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
            <Group label={tp('palette.group_nav')}>
              {navMatches.map((n) => {
                runningIndex += 1;
                const i = runningIndex;
                return (
                  <Row
                    key={n.href}
                    active={i === activeIndex}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => select(i)}
                    icon={<IconArrow size={14} stroke="var(--text-muted)" />}
                    label={t(n.labelKey)}
                  />
                );
              })}
            </Group>
          ) : null}

          {showSearchRow
            ? (() => {
                runningIndex += 1;
                const i = runningIndex;
                return (
                  <Row
                    key="search"
                    active={i === activeIndex}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => select(i)}
                    icon={<IconSearch size={14} stroke="var(--action)" />}
                    label={tp('palette.search_jobs', { query: term })}
                  />
                );
              })()
            : null}

          {jobs.length > 0 ? (
            <Group label={tp('palette.group_jobs')}>
              {jobs.map((j) => {
                runningIndex += 1;
                const i = runningIndex;
                return (
                  <Row
                    key={j.id}
                    active={i === activeIndex}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => select(i)}
                    icon={<IconSearch size={14} stroke="var(--action)" />}
                    label={j.title}
                    sub={j.companyName}
                  />
                );
              })}
            </Group>
          ) : null}

          {failed || refreshLimited ? (
            <p role="alert" className="px-4 py-3" style={{ color: 'var(--danger)', fontSize: 'var(--fs-meta)' }}>
              {refreshLimited ? tp('palette.refresh_limited') : tp('palette.error')}
            </p>
          ) : null}

          {searching ? (
            <p className="px-4 py-3" style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-meta)' }} role="status">
              {tp('palette.searching')}
            </p>
          ) : null}

          {/* A search that worked and found nothing: the saved-search filters
              apply, and the message says so. */}
          {answered && jobs.length === 0 ? (
            <p className="px-4 py-3" style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-meta)' }} role="status">
              {tp('palette.empty_jobs')}
            </p>
          ) : null}

          {flat.length === 0 && !searched ? (
            <p
              className="px-4 py-8 text-center"
              style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-meta)' }}
              role="status"
            >
              {canSearchJobs ? tp('palette.empty') : tp('palette.empty_pages')}
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
          fontSize: 'var(--fs-label)',
          color: 'var(--text-muted)',
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
        background: active ? 'var(--action-subtle)' : 'transparent',
        boxShadow: active ? 'inset 2px 0 0 var(--action)' : 'none',
      }}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text)', fontSize: 'var(--fs-body)' }}>
        {label}
        {sub ? (
          <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 'var(--fs-meta)' }}>· {sub}</span>
        ) : null}
      </span>
    </button>
  );
}
