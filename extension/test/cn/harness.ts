// extension/test/cn/harness.ts — the fixture contract for mainland portal adapters:
// detection (host + markup), the job on the page, listFields coverage with the
// cn field map (label, kind, cn key, section row), value round-trip through the
// adapter's own fill(), resume attach, and nothing submit-like pressed.

import { expect, it, vi } from 'vitest';

import { planCnFields } from '../../src/adapters/cn/fields';
import type { CnAdapter } from '../../src/adapters/cn/kit';
import type { FieldHandle, FieldKind } from '../../src/adapters/types';
import { classifyField } from '../../src/mapping/classify';
import { loadCnFixture } from './helpers';

export interface CnExpectedField {
  label: string;
  kind: FieldKind;
  /** cn key ("-" = left to the shared mapping, null = owned by a row section without a key). */
  cn?: string | null;
  row?: number;
  required?: boolean;
}

export interface CnFixtureCase {
  name: string;
  url: string;
  job: { title?: string; company?: string; location?: string };
  fields: CnExpectedField[];
  roundTrip: Array<{ id: string; value: string }>;
  /** id of the resume file input. */
  resume: string;
}

export function byId(fields: FieldHandle[], id: string): FieldHandle {
  const f = fields.find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id} in [${fields.map((x) => x.id).join(', ')}]`);
  return f;
}

export function readBack(f: FieldHandle): string {
  if (f.kind === 'radio') {
    const i = (f.group ?? []).findIndex((r) => r.checked);
    return i === -1 ? '' : (f.options ?? [])[i];
  }
  if (f.kind === 'select') return ((f.element as HTMLSelectElement).selectedOptions[0]?.textContent ?? '').trim();
  return (f.element as HTMLInputElement).value;
}

/** Fixture comboboxes behave like the real widget: choosing an option writes it into the input. */
export function wireComboboxes(doc: Document): void {
  doc.querySelectorAll<HTMLElement>('[role="option"]').forEach((opt) =>
    opt.addEventListener('click', () => {
      const box = opt.closest('[role="listbox"]');
      const input = box && doc.querySelector<HTMLInputElement>(`[aria-controls="${box.id}"]`);
      if (input) input.value = (opt.textContent ?? '').trim();
    }),
  );
}

export function runCnFixtureCases(adapter: CnAdapter, portal: string, cases: CnFixtureCase[], opts: { otherHost?: string | null } = {}): void {
  it('has at least three fixtures', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  for (const c of cases) {
    it(`${c.name}: detects the form and reads the job`, () => {
      const doc = loadCnFixture(portal, c.name);
      expect(adapter.matches(new URL(c.url), doc)).toBe(true);
      expect(adapter.probe(doc)).toBe(true);
      const other = opts.otherHost === undefined ? 'https://www.example.test/careers/apply' : opts.otherHost;
      if (other) expect(adapter.matches(new URL(other), doc)).toBe(false);
      expect(adapter.readJob(doc)).toMatchObject(c.job);
    });

    it(`${c.name}: lists every field in order with its cn key and row, and no buttons`, () => {
      const doc = loadCnFixture(portal, c.name);
      const fields = adapter.listFields(doc);
      const plan = planCnFields(adapter, fields);
      const got = fields.map((f) => {
        const p = plan.get(f.id);
        return { label: f.label, kind: f.kind, cn: p ? p.key : '-', row: p?.row ?? 0, required: f.required };
      });
      expect(got.map((g) => g.label)).toEqual(c.fields.map((f) => f.label));
      c.fields.forEach((want, i) => {
        expect(got[i].kind, want.label).toBe(want.kind);
        if (want.cn !== undefined) expect(got[i].cn, want.label).toBe(want.cn);
        if (want.row !== undefined) expect(got[i].row, want.label).toBe(want.row);
        if (want.required !== undefined) expect(got[i].required, want.label).toBe(want.required);
      });
      for (const f of fields) expect(['button', 'a'].includes(f.element.tagName.toLowerCase())).toBe(false);
    });

    it(`${c.name}: values round-trip through fill()`, async () => {
      const doc = loadCnFixture(portal, c.name);
      wireComboboxes(doc);
      const fields = adapter.listFields(doc);
      for (const rt of c.roundTrip) {
        const f = byId(fields, rt.id);
        const value = f.kind === 'select' || f.kind === 'radio' || f.kind === 'combobox' ? { kind: 'option' as const, option: rt.value } : { kind: 'text' as const, text: rt.value };
        const res = await adapter.fill(f, value);
        expect(res.ok, `fill ${rt.id}`).toBe(true);
        expect(readBack(f), rt.id).toBe(rt.value);
      }
    });

    it(`${c.name}: attaches the resume file`, async () => {
      const doc = loadCnFixture(portal, c.name);
      const f = byId(adapter.listFields(doc), c.resume);
      expect(f.kind).toBe('file');
      expect(classifyField(f)).toBe('resume');
      const change = vi.fn();
      f.element.addEventListener('change', change);
      const res = await adapter.attachFile(f, new File(['%PDF-1.4'], '王小明_简历.pdf', { type: 'application/pdf' }));
      expect(res.ok).toBe(true);
      expect((f.element as HTMLInputElement).files?.[0]?.name).toBe('王小明_简历.pdf');
      expect(change).toHaveBeenCalled();
    });

    it(`${c.name}: filling never presses or submits anything`, async () => {
      const doc = loadCnFixture(portal, c.name);
      wireComboboxes(doc);
      const submits = vi.fn();
      doc.addEventListener('submit', submits, true);
      const pressed = vi.fn();
      doc.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a').forEach((b) => b.addEventListener('click', pressed));
      for (const f of adapter.listFields(doc)) {
        if (f.kind === 'file') continue;
        const v = f.kind === 'checkbox' ? { kind: 'checked' as const, checked: true } : f.options?.length ? { kind: 'option' as const, option: f.options[0] } : { kind: 'text' as const, text: '测试' };
        await adapter.fill(f, v);
      }
      expect(submits).not.toHaveBeenCalled();
      expect(pressed).not.toHaveBeenCalled();
    });
  }
}
