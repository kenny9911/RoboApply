// extension/src/adapters/intl/shared.ts — helpers the WP-70 adapters share.
//
// Read-only: attribute hints, a field lister that also looks inside open
// shadow roots (SmartRecruiters renders its inputs in web components), the
// company name from page metadata, and the step marker of multi-page forms.
// Filling always goes through the _kit (fields.ts → setters / interact.ts).

import { listFieldsIn, type ListFieldsOptions } from '../_kit/fields';
import { metaContent } from '../_kit/page';
import type { FieldHandle, FieldKey } from '../types';

export type HintRule = [RegExp, FieldKey];

/** The first rule matching any of the element's naming attributes. */
export function hintFromAttributes(el: HTMLElement, rules: readonly HintRule[], attrs: readonly string[] = ['id', 'name']): FieldKey | undefined {
  for (const attr of attrs) {
    const v = attr === 'id' ? el.id : (el.getAttribute(attr) ?? '');
    if (!v) continue;
    for (const [re, key] of rules) if (re.test(v)) return key;
  }
  return undefined;
}

/** A <label for=id> in the element's own tree (document or shadow root). */
export function labelInOwnTree(el: HTMLElement): string | null {
  const id = el.id;
  if (!id) return null;
  const root = el.getRootNode() as Document | ShadowRoot;
  if (!('querySelectorAll' in root)) return null;
  for (const label of Array.from(root.querySelectorAll('label[for]'))) {
    if (label.getAttribute('for') === id) return label.textContent;
  }
  return null;
}

/** The element's nearest shadow host, or null in the light DOM. */
function hostOf(node: Node): Element | null {
  const root = node.getRootNode();
  return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.host : null;
}

/**
 * The chain of shadow hosts from the tree of `top` down to `el`: [host in
 * top's tree, host in that host's shadow root, …, el]. Two chains compare
 * level by level, and at the first level where they differ both nodes sit in
 * the same tree, so their document order is well defined.
 */
function hostChain(el: Element, top: Node): Element[] {
  const chain: Element[] = [];
  let cur: Element = el;
  for (let guard = 0; guard < 32; guard++) {
    chain.unshift(cur);
    const host = hostOf(cur);
    if (!host || cur.getRootNode() === top) break;
    cur = host;
  }
  return chain;
}

function compareChains(a: Element[], b: Element[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const pos = a[i].compareDocumentPosition(b[i]);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }
  return a.length - b.length;
}

function ownShadowRoot(node: unknown): ShadowRoot | null {
  return ((node as { shadowRoot?: ShadowRoot | null } | null)?.shadowRoot ?? null) || null;
}

/**
 * Every open shadow root under `scope`, including the scope element's own
 * (a form that is itself a component, e.g. <oc-oneclick-form>), in tree order.
 */
function openShadowRoots(scope: ParentNode): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const own = ownShadowRoot(scope);
  if (own) out.push(own, ...openShadowRoots(own));
  for (const el of Array.from(scope.querySelectorAll('*'))) {
    const sr = ownShadowRoot(el);
    if (sr) out.push(sr, ...openShadowRoots(sr));
  }
  return out;
}

/**
 * listFieldsIn over the scope AND every open shadow root inside it, in
 * document order (a field inside a component sits where its host sits).
 * Closed shadow roots are not reachable and their questions stay with the user.
 */
export function listFieldsDeep(root: Document | ShadowRoot, opts: ListFieldsOptions = {}): FieldHandle[] {
  const scope = opts.scope ? opts.scope(root) : root;
  if (!scope) return [];
  const rest: ListFieldsOptions = { ...opts, scope: undefined };
  const parts: FieldHandle[][] = [listFieldsIn(scope as Document, rest)];
  for (const sr of openShadowRoots(scope as ParentNode)) parts.push(listFieldsIn(sr, rest));
  const all = parts.flat();
  if (parts.length === 1) return all;

  const top = (scope as Node).getRootNode();
  const indexed = all.map((f, i) => ({ f, i, chain: hostChain(f.element, top) }));
  indexed.sort((a, b) => compareChains(a.chain, b.chain) || a.i - b.i);

  // Ids are unique per listFieldsIn call; keep them unique across roots too.
  const seen = new Set<string>();
  return indexed.map(({ f }) => {
    let id = f.id;
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`;
    seen.add(id);
    return id === f.id ? f : { ...f, id };
  });
}

/** Company from page metadata only (never guessed from a host name or URL). */
export function companyFromMeta(doc: Document): string | undefined {
  return cleanCompany(metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']));
}

/** "Acme Careers" → "Acme"; "Careers at Acme" → "Acme". */
export function cleanCompany(raw: string | null | undefined): string | undefined {
  const t = (raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^(careers|jobs|join us|work)\s+(at|with)\s+/i, '')
    .replace(/\s+(careers?|jobs|career site|job board|recruiting|recruitment)(\s+(site|page|portal))?$/i, '')
    .trim();
  return t || undefined;
}

/** Elements that belong to a sign-in box (never listed: credentials are the user's). */
export function inSignIn(el: HTMLElement): boolean {
  return el.closest('[data-signin], #loginForm, form[name="loginForm"], form[id*="login" i], form[action*="login" i], [class*="login" i][class*="form" i]') !== null;
}
