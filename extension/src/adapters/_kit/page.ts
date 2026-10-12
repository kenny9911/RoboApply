// extension/src/adapters/_kit/page.ts — small read-only helpers for adapters.

import { attachFileField, fillField, listFieldsIn, type ListFieldsOptions } from './fields';
import type { AtsAdapter, AtsType, JobOnPage } from '../types';

export function firstText(root: ParentNode, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const t = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return undefined;
}

export function metaContent(doc: Document, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const v = doc.querySelector(sel)?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Plain text of a description block, capped (the API accepts 60k). */
export function descriptionText(root: ParentNode, selectors: string[], max = 60_000): string | undefined {
  for (const sel of selectors) {
    const el = root.querySelector(sel) as HTMLElement | null;
    const t = (el?.innerText ?? el?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (t) return t.slice(0, max);
  }
  return undefined;
}

/** `host` is exactly `domain` or a subdomain of it. */
export function hostIs(url: URL, domains: string[]): boolean {
  const host = url.hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export interface AdapterSpec {
  id: AtsType;
  siteName: string;
  hostPatterns: string[];
  domains: string[];
  probe(doc: Document): boolean;
  readJob(doc: Document): JobOnPage | null;
  fields: ListFieldsOptions;
}

/** Build an adapter from a declarative spec; filling always goes through the _kit. */
export function defineAdapter(spec: AdapterSpec): AtsAdapter {
  return {
    id: spec.id,
    siteName: spec.siteName,
    hostPatterns: spec.hostPatterns,
    matches: (url, doc) => hostIs(url, spec.domains) && spec.probe(doc),
    probe: spec.probe,
    readJob: spec.readJob,
    listFields: (root) => listFieldsIn(root, spec.fields),
    fill: (field, value) => fillField(field, value),
    attachFile: (field, file) => attachFileField(field, file),
  };
}
