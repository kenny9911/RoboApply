// extension/test/adapters/harness.ts — the shared adapter fixture contract:
// detection, listFields coverage (labels, kinds, classified keys), value
// round-trip through the adapter's own fill(), file attach, and no press of
// anything submit-like.

import { expect, it, vi } from 'vitest';

import type { AtsAdapter, FieldHandle, FieldKind } from '../../src/adapters/types';
import { classifyField } from '../../src/mapping/classify';
import { loadFixture } from '../helpers';

export interface ExpectedField {
  label: string | RegExp;
  kind: FieldKind;
  key?: string | null;
  required?: boolean;
}

export interface FixtureCase {
  name: string;
  url: string;
  job: { title?: string; company?: string; location?: string };
  fields: ExpectedField[];
  /** Values to write and read back, by field label. */
  roundTrip: Array<{ label: string | RegExp; value: string; read?: (f: FieldHandle) => string }>;
  /** Label of the resume file input. */
  resume: string | RegExp;
}

function find(fields: FieldHandle[], label: string | RegExp): FieldHandle {
  const f = fields.find((x) => (typeof label === 'string' ? x.label === label : label.test(x.label)));
  if (!f) throw new Error(`no field labelled ${label} in [${fields.map((x) => x.label).join(' | ')}]`);
  return f;
}

function readBack(f: FieldHandle): string {
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

export function runFixtureCases(adapter: AtsAdapter, ats: string, cases: FixtureCase[]): void {
  it(`has at least three fixtures`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  for (const c of cases) {
    it(`${c.name}: detects the form and reads the job`, () => {
      const doc = loadFixture(ats, c.name);
      expect(adapter.matches(new URL(c.url), doc)).toBe(true);
      expect(adapter.matches(new URL('https://www.example.test/careers'), doc)).toBe(false);
      const job = adapter.readJob(doc);
      expect(job).toMatchObject(c.job);
    });

    it(`${c.name}: lists every fillable field, in order, and no buttons`, () => {
      const doc = loadFixture(ats, c.name);
      const fields = adapter.listFields(doc);
      const got = fields.map((f) => ({ label: f.label, kind: f.kind, key: classifyField(f), required: f.required }));
      expect(got.length).toBe(c.fields.length);
      c.fields.forEach((want, i) => {
        if (typeof want.label === 'string') expect(got[i].label).toBe(want.label);
        else expect(got[i].label).toMatch(want.label);
        expect(got[i].kind).toBe(want.kind);
        if (want.key !== undefined) expect(got[i].key).toBe(want.key);
        if (want.required !== undefined) expect(got[i].required).toBe(want.required);
      });
      for (const f of fields) expect(f.element.tagName.toLowerCase()).not.toBe('button');
    });

    it(`${c.name}: values round-trip through fill()`, async () => {
      const doc = loadFixture(ats, c.name);
      const fields = adapter.listFields(doc);
      // Comboboxes in fixtures behave like the real widget: choosing an option sets the input.
      doc.querySelectorAll<HTMLElement>('[role="option"]').forEach((opt) =>
        opt.addEventListener('click', () => {
          const box = opt.closest('[role="listbox"]');
          const input = box && doc.querySelector<HTMLInputElement>(`[aria-controls="${box.id}"]`);
          if (input) input.value = opt.textContent ?? '';
        }),
      );
      for (const rt of c.roundTrip) {
        const f = find(fields, rt.label);
        const value = f.kind === 'select' || f.kind === 'radio' || f.kind === 'combobox' ? { kind: 'option' as const, option: rt.value } : { kind: 'text' as const, text: rt.value };
        const res = await adapter.fill(f, value);
        expect(res.ok, `fill ${String(rt.label)}`).toBe(true);
        expect((rt.read ?? readBack)(f)).toBe(rt.value);
      }
    });

    it(`${c.name}: attaches the resume file`, async () => {
      const doc = loadFixture(ats, c.name);
      const f = find(adapter.listFields(doc), c.resume);
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

    it(`${c.name}: filling never presses or submits anything`, async () => {
      const doc = loadFixture(ats, c.name);
      const submits = vi.fn();
      doc.addEventListener('submit', submits, true);
      const pressed = vi.fn();
      doc.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach((b) => b.addEventListener('click', pressed));
      const fields = adapter.listFields(doc);
      for (const f of fields) {
        if (f.kind === 'file') continue;
        const v = f.kind === 'checkbox' ? { kind: 'checked' as const, checked: true } : f.options?.length ? { kind: 'option' as const, option: f.options[0] } : { kind: 'text' as const, text: 'x' };
        await adapter.fill(f, v);
      }
      expect(submits).not.toHaveBeenCalled();
      expect(pressed).not.toHaveBeenCalled();
    });
  }
}
