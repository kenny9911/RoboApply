// extension/src/content/detect.ts — which adapter (if any) fills this page.
//
// URL pattern + DOM probe. Dev builds also accept local fixture pages
// (localhost / 127.0.0.1) by DOM probe alone, so the e2e test and local
// development can use saved forms.

import { adaptersFor, type AdapterSet } from '../adapters/registry';
import type { AtsAdapter } from '../adapters/types';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalHost(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}

export function detectAdapter(url: URL, doc: Document, opts: { set: AdapterSet; dev: boolean }): AtsAdapter | null {
  const adapters = adaptersFor(opts.set);
  for (const a of adapters) if (a.matches(url, doc)) return a;
  if (opts.dev && isLocalHost(url)) {
    for (const a of adapters) if (a.probe(doc)) return a;
  }
  return null;
}
