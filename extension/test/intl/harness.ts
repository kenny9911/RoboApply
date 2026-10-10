// extension/test/intl/harness.ts — fixture contract for the WP-70 adapters
// (same contract as test/adapters/harness.ts, for fixtures under
// test/intl/fixtures): detection, listFields coverage (labels, kinds,
// classified keys), value round-trip through the adapter's own fill(), file
// attach, and that nothing submit-like is ever pressed.
//
// Fixtures may use declarative shadow DOM (<template shadowrootmode="open">);
// jsdom does not parse it from innerHTML, so loadIntlFixture attaches those
// roots the way a browser does when it parses the page.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import type { AtsAdapter, FieldHandle, FieldKind } from '../../src/adapters/types';
import { classifyField } from '../../src/mapping/classify';

export const INTL_FIXTURES = join(__dirname, 'fixtures');

function attachDeclarativeShadowRoots(root: ParentNode): void {
  for (const tpl of Array.from(root.querySelectorAll<HTMLTemplateElement>('template[shadowrootmode]'))) {
    const host = tpl.parentElement;
    if (!host || host.shadowRoot) continue;
    const mode = tpl.getAttribute('shadowrootmode') === 'closed' ? 'closed' : 'open';
    const shadow = host.attachShadow({ mode });
    shadow.appendChild(tpl.content.cloneNode(true));
    tpl.remove();
    attachDeclarativeShadowRoots(shadow);
  }
}

/** Load a saved page into the jsdom document (scripts are never run). */
export function loadIntlFixture(dir: string, name: string): Document {
  const html = readFileSync(join(INTL_FIXTURES, dir, `${name}.html`), 'utf8');
  const inner = html.replace(/<!doctype[^>]*>/i, '').replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '');
  document.documentElement.innerHTML = inner;
  attachDeclarativeShadowRoots(document);
  return document;
}

/** The same page as its own Document (leaves the test document, and Testing Library's screen, alone). */
export function parseIntlFixture(dir: string, name: string): Document {
  const html = readFileSync(join(INTL_FIXTURES, dir, `${name}.html`), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  attachDeclarativeShadowRoots(doc);
  return doc;
}

export const PAGE_ID = 'ra-test-page';

/**
 * Put a saved page into one element of the test document, leaving everything
 * else in the body (a mounted panel) alone: the way a single-page site swaps
 * the step of a page-by-page form without changing the URL.
 */
export function showIntlPage(dir: string, name: string): Document {
  const parsed = parseIntlFixture(dir, name);
  let page = document.getElementById(PAGE_ID);
  if (!page) {
    document.documentElement.innerHTML = '<head></head><body></body>';
    page = document.createElement('div');
    page.id = PAGE_ID;
    document.body.appendChild(page);
  }
  page.innerHTML = parsed.body.innerHTML;
  attachDeclarativeShadowRoots(page);
  return document;
}

/** Forget the element showIntlPage() fills (call between tests that use it). */
export function resetIntlPage(): void {
  document.getElementById(PAGE_ID)?.remove();
}

export interface ExpectedField {
  label: string | RegExp;
  kind: FieldKind;
  key?: string | null;
  required?: boolean;
}

export interface FixtureCase {
  name: string;
  url: string;
  job: { title?: string; company?: string; location?: string } | null;
  fields: ExpectedField[];
  /** Values to write and read back, by field label. */
  roundTrip: Array<{ label: string | RegExp; value: string }>;
  /** Label of the resume file input; null for a page of a multi-page form without one. */
  resume: string | RegExp | null;
  /** Multi-page forms: the step marker this page shows. */
  step?: string | null;
}

/** querySelectorAll across the document and every open shadow root. */
export function deepQueryAll(root: Document | ShadowRoot, selector: string): Element[] {
  const out = Array.from(root.querySelectorAll(selector));
  for (const el of Array.from(root.querySelectorAll('*'))) if (el.shadowRoot) out.push(...deepQueryAll(el.shadowRoot, selector));
  return out;
}

export function findField(fields: FieldHandle[], label: string | RegExp): FieldHandle {
  const f = fields.find((x) => (typeof label === 'string' ? x.label === label : label.test(x.label)));
  if (!f) throw new Error(`no field labelled ${label} in [${fields.map((x) => x.label).join(' | ')}]`);
  return f;
}

export function readBack(f: FieldHandle): string {
  if (f.kind === 'radio') {
    const i = (f.group ?? []).findIndex((r) => r.checked);
    return i === -1 ? '' : (f.options ?? [])[i];
  }
  if (f.kind === 'select') {
    const s = f.element as HTMLSelectElement;
    return (s.selectedOptions[0]?.textContent ?? '').trim();
  }
  if (f.kind === 'checkbox') return String((f.element as HTMLInputElement).checked);
  return (f.element as HTMLInputElement).value;
}

export function runIntlFixtureCases(
  adapter: AtsAdapter,
  dir: string,
  cases: FixtureCase[],
  opts: { stepKey?: (doc: Document) => string | null; /** The generic adapter runs one fixture per host. */ minFixtures?: number } = {},
): void {
  it(`has at least ${opts.minFixtures ?? 3} fixture(s)`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(opts.minFixtures ?? 3);
  });

  it('at least one fixture attaches a resume', () => {
    expect(cases.some((c) => c.resume !== null)).toBe(true);
  });

  for (const c of cases) {
    it(`${c.name}: detects the form and reads the job`, () => {
      const doc = loadIntlFixture(dir, c.name);
      expect(adapter.matches(new URL(c.url), doc)).toBe(true);
      expect(adapter.probe(doc)).toBe(true);
      expect(adapter.matches(new URL('https://www.example.test/careers'), doc)).toBe(false);
      const job = adapter.readJob(doc);
      if (c.job === null) expect(job).toBeNull();
      else expect(job).toMatchObject(c.job);
      if (opts.stepKey && c.step !== undefined) expect(opts.stepKey(doc)).toBe(c.step);
    });

    it(`${c.name}: lists every fillable field, in order, and no buttons`, () => {
      const doc = loadIntlFixture(dir, c.name);
      const fields = adapter.listFields(doc);
      const got = fields.map((f) => ({ label: f.label, kind: f.kind, key: classifyField(f), required: f.required }));
      expect(got.map((g) => g.label), 'labels').toHaveLength(c.fields.length);
      c.fields.forEach((want, i) => {
        if (typeof want.label === 'string') expect(got[i].label, `field ${i}`).toBe(want.label);
        else expect(got[i].label, `field ${i}`).toMatch(want.label);
        expect(got[i].kind, `kind of ${got[i].label}`).toBe(want.kind);
        if (want.key !== undefined) expect(got[i].key, `key of ${got[i].label}`).toBe(want.key);
        if (want.required !== undefined) expect(got[i].required, `required of ${got[i].label}`).toBe(want.required);
      });
      for (const f of fields) {
        expect(f.element.tagName.toLowerCase()).not.toBe('button');
        expect((f.element.getAttribute('type') ?? '').toLowerCase()).not.toMatch(/^(submit|button|image|reset|password|hidden)$/);
      }
      expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
    });

    it(`${c.name}: values round-trip through fill()`, async () => {
      const doc = loadIntlFixture(dir, c.name);
      const fields = adapter.listFields(doc);
      for (const rt of c.roundTrip) {
        const f = findField(fields, rt.label);
        const value = f.kind === 'select' || f.kind === 'radio' || f.kind === 'combobox' ? { kind: 'option' as const, option: rt.value } : { kind: 'text' as const, text: rt.value };
        const res = await adapter.fill(f, value);
        expect(res.ok, `fill ${String(rt.label)}`).toBe(true);
        expect(readBack(f)).toBe(rt.value);
      }
    });

    if (c.resume !== null) {
      it(`${c.name}: attaches the resume file`, async () => {
        const doc = loadIntlFixture(dir, c.name);
        const f = findField(adapter.listFields(doc), c.resume as string | RegExp);
        expect(f.kind).toBe('file');
        expect(classifyField(f)).toBe('resume');
        const change = vi.fn();
        f.element.addEventListener('change', change);
        const res = await adapter.attachFile(f, new File(['%PDF-1.4'], 'Avery_Lin_Resume.pdf', { type: 'application/pdf' }));
        expect(res.ok).toBe(true);
        const input = f.element as HTMLInputElement;
        expect(input.files?.length).toBe(1);
        expect(input.files?.[0]?.name).toBe('Avery_Lin_Resume.pdf');
        expect(change).toHaveBeenCalled();
      });
    }

    it(`${c.name}: filling every field never presses or submits anything`, async () => {
      const doc = loadIntlFixture(dir, c.name);
      const submits = vi.fn();
      doc.addEventListener('submit', submits, true);
      const pressed = vi.fn();
      const pressables = deepQueryAll(doc, 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]');
      expect(pressables.length, 'fixture keeps the site’s own buttons').toBeGreaterThan(0);
      pressables.forEach((b) => b.addEventListener('click', pressed));
      for (const f of adapter.listFields(doc)) {
        if (f.kind === 'file') {
          await adapter.attachFile(f, new File(['x'], 'x.pdf', { type: 'application/pdf' }));
          continue;
        }
        const v = f.kind === 'checkbox' ? { kind: 'checked' as const, checked: true } : f.options?.length ? { kind: 'option' as const, option: f.options[f.options.length - 1] } : { kind: 'text' as const, text: 'x' };
        await adapter.fill(f, v);
      }
      expect(submits).not.toHaveBeenCalled();
      expect(pressed).not.toHaveBeenCalled();
    });
  }
}
