// extension/src/manifest.ts — the MV3 manifest for one brand build (ARCHITECTURE.md §6.2).
//
// Minimal permissions: `activeTab`, `scripting`, `storage`. Never `cookies`,
// `tabs`, `webRequest` or `<all_urls>`. Host permissions: the brand's API
// origin plus the form hosts of the adapters this build ships (they follow
// adapters/intl and adapters/cn). Job boards get NO host permission and no
// content script: board reading runs only after a toolbar click (activeTab).
// `externally_connectable` lets only the brand's own web pages talk to us
// (pairing); dev builds add the local dev origins.

import { adapterHostPatterns } from './adapters/registry';
import { getExtBrand, type BrandId } from './brands/index';
import { boardDomains } from './content/boards/index';

export { getExtBrand };
// The build script reads the GoApply distribution through this module (scripts/build.mjs).
export { GOAPPLY_DISTRIBUTION } from './brands/goapply/index';

/** The `_locales` folder of a brand's default locale (Chrome's `default_locale`). */
const LOCALE_FOLDER: Record<string, string> = { zh: 'zh_CN', 'zh-TW': 'zh_TW' };
export function defaultLocaleFolder(brand: BrandId): string {
  const locale = getExtBrand(brand).defaultLocale;
  return LOCALE_FOLDER[locale] ?? 'en';
}

export type BuildTarget = 'chrome' | 'edge';

export interface ManifestOptions {
  brand: BrandId;
  target: BuildTarget;
  dev: boolean;
  version: string;
  /** Overrides the API origin (dev / e2e builds). */
  apiOrigin?: string;
}

export const PERMISSIONS = ['activeTab', 'scripting', 'storage'] as const;

/** Hosts we must never hold a permission for (job boards are read only via activeTab). */
export const FORBIDDEN_HOST_RE = /linkedin\.|indeed\.|glassdoor\.|<all_urls>|^\*:\/\/\*\/\*$|^https?:\/\/\*\/\*$/i;

/** FORBIDDEN_HOST_RE, plus every job board a reader supports (boardDomains(); WP-70 R8). */
export function isForbiddenHostPattern(pattern: string): boolean {
  if (FORBIDDEN_HOST_RE.test(pattern)) return true;
  const host = pattern.match(/^[^:]+:\/\/(?:\*\.)?([^/:]+)/)?.[1]?.toLowerCase();
  return Boolean(host) && boardDomains().some((d) => host === d || host!.endsWith(`.${d}`));
}

function originPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

export function buildManifest(opts: ManifestOptions): Record<string, unknown> {
  const brand = getExtBrand(opts.brand);
  const apiOrigin = opts.apiOrigin ?? (opts.dev ? brand.devApiOrigin : brand.apiOrigin);
  const formHosts = adapterHostPatterns(brand.adapterSet);
  const webHostPatterns = brand.webHosts.filter((h) => !h.startsWith('api.')).map((h) => `https://${h}/*`);
  const devPatterns = opts.dev ? [...new Set([...brand.devWebOrigins.map(originPattern), ...brand.devHosts.map((h) => `http://${h}/*`), originPattern(apiOrigin)])] : [];
  const hostPermissions = [...new Set([originPattern(apiOrigin), ...formHosts, ...(opts.dev ? ['http://localhost/*', 'http://127.0.0.1/*'] : [])])];

  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: '__MSG_extShortName__',
    description: '__MSG_extDescription__',
    // GoApply: zh_CN, so a browser in a language we have no strings for reads Chinese, not English.
    default_locale: defaultLocaleFolder(opts.brand),
    version: opts.version,
    minimum_chrome_version: '116',
    icons: { '16': 'icons/16.png', '32': 'icons/32.png', '48': 'icons/48.png', '128': 'icons/128.png' },
    action: { default_title: '__MSG_actionTitle__', default_popup: 'popup.html', default_icon: { '16': 'icons/16.png', '32': 'icons/32.png' } },
    background: { service_worker: 'sw.js', type: 'module' },
    permissions: [...PERMISSIONS],
    host_permissions: hostPermissions,
    content_scripts: [
      {
        matches: [...formHosts, ...(opts.dev ? ['http://localhost/*', 'http://127.0.0.1/*'] : [])],
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: true,
      },
    ].filter((cs) => cs.matches.length > 0),
    externally_connectable: { matches: [...webHostPatterns, ...devPatterns] },
  };
  return manifest;
}

/** Violations of the permission policy (tests and the build both run it). */
export function manifestViolations(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  const perms = (manifest.permissions as string[]) ?? [];
  for (const p of perms) if (!(PERMISSIONS as readonly string[]).includes(p)) out.push(`permission "${p}" is not allowed`);
  if ('optional_permissions' in manifest) out.push('optional_permissions are not used');
  const hosts = [...((manifest.host_permissions as string[]) ?? []), ...((manifest.optional_host_permissions as string[]) ?? [])];
  for (const h of hosts) if (isForbiddenHostPattern(h)) out.push(`host permission "${h}" is not allowed`);
  for (const cs of (manifest.content_scripts as Array<{ matches: string[] }>) ?? []) {
    for (const m of cs.matches) if (isForbiddenHostPattern(m)) out.push(`content script on "${m}" is not allowed`);
  }
  return out;
}
