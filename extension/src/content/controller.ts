// extension/src/content/controller.ts — the content script's state, without chrome.*.
//
// Detection runs at document_idle and again on each user action from the
// toolbar (content.ping when the popup opens, panel.open on its button) when
// nothing was found yet or the page's path changed. Single-page sites such as
// Ashby (Overview → Application tab) and forms rendered after load are found
// that way, still only after a user click. The panel is (re)mounted for the
// page it fills; a path change means a different form.

import type { AdapterSet } from '../adapters/registry';
import type { AtsAdapter } from '../adapters/types';
import type { PageJobBody } from '../shared/contract';
import type { ContentMessage, ContentPingResponse, PageReadResponse } from '../shared/messages';
import { findBoardReader } from './boards/index';
import { detectAdapter } from './detect';
import { apiPageUrl } from './pageUrl';
import type { MountedPanel } from './panel/mount';

export interface ContentControllerDeps {
  doc: Document;
  /** The page's current URL (location.href). */
  href: () => string;
  set: AdapterSet;
  dev: boolean;
  /** Mount the panel for this adapter and page URL. */
  mount: (adapter: AtsAdapter, url: string, open: boolean) => MountedPanel;
}

export type ContentResponse = ContentPingResponse | PageReadResponse | { ok: boolean };

function pageKey(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return href;
  }
}

export interface ContentController {
  /** document_idle: show the collapsed launcher when a supported form is already there. */
  init(): void;
  handle(message: ContentMessage): ContentResponse | undefined;
}

export function createContentController(deps: ContentControllerDeps): ContentController {
  let adapter: AtsAdapter | null = null;
  let detectedFor: string | null = null;
  let mounted: MountedPanel | null = null;
  let mountedFor: string | null = null;

  const detect = (): AtsAdapter | null => {
    const href = deps.href();
    const key = pageKey(href);
    if (adapter && detectedFor === key) return adapter;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    adapter = detectAdapter(url, deps.doc, { set: deps.set, dev: deps.dev });
    detectedFor = key;
    return adapter;
  };

  const ensureMounted = (open: boolean): boolean => {
    const a = detect();
    if (!a) {
      // The user left the form (same tab, new path): drop its stale panel.
      if (mounted && mountedFor !== detectedFor) {
        mounted.unmount();
        mounted = null;
        mountedFor = null;
      }
      return false;
    }
    if (mounted && mountedFor === detectedFor) {
      if (open) mounted.open();
      return true;
    }
    mounted?.unmount();
    mounted = deps.mount(a, deps.href(), open);
    mountedFor = detectedFor;
    return true;
  };

  return {
    init() {
      ensureMounted(false);
    },
    handle(message) {
      switch (message?.type) {
        case 'content.ping': {
          const found = ensureMounted(false);
          const url = new URL(deps.href());
          return { siteName: found ? adapter!.siteName : (findBoardReader(url)?.siteName ?? null) };
        }
        case 'panel.open':
          return { ok: ensureMounted(true) };
        case 'page.read': {
          const url = new URL(deps.href());
          const a = detect();
          const job = a?.readJob(deps.doc) ?? findBoardReader(url)?.readJob(deps.doc) ?? null;
          const body: PageJobBody | null =
            job?.title && job.company
              ? { url: apiPageUrl(deps.href()), title: job.title.slice(0, 200), company: job.company.slice(0, 200), location: job.location?.slice(0, 200), descriptionText: (job.descriptionText ?? '').slice(0, 60_000) }
              : null;
          return { job: body };
        }
        default:
          return undefined;
      }
    },
  };
}
