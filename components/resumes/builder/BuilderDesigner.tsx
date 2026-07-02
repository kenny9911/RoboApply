'use client';

// BuilderDesigner — the Designer tab. 4 sub-tabs (Presentation / Sections /
// Settings / Advanced). Presentation contains:
//
//   • My Templates    — Browse Library card + active template thumb
//   • Styling         — Font / Line height / List line height / Accent / Date format
//   • Alignments      — Header align (3 tiles) / Date align (2) / Location align (2) /
//                       Skills layout (3 tiles)
//   • Page Setup      — Paper size / L+R margins / T+B margins
//
// All controls write through to the parent's `ResumeTheme`, which the preview
// reads to render in real-time. The non-Presentation sub-tabs are stubbed
// with helpful copy until Wave 2.1.

import { useState, type ReactNode } from 'react';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import {
  ACCENT_SWATCHES,
  DEFAULT_THEME,
  FONT_OPTIONS,
  type Alignment,
  type DateFormat,
  type FontKey,
  type PaperSize,
  type ResumeTheme,
  type SkillsLayout,
  type TemplateKey,
} from '../../../lib/resumeTheme';
import { cn } from '../../../lib/utils';

// Re-export so callers that imported `ResumeTheme` from this module keep
// compiling.
export type { ResumeTheme };

type SubTab = 'presentation' | 'sections' | 'settings' | 'advanced';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'presentation', label: 'Presentation' },
  { id: 'sections', label: 'Sections' },
  { id: 'settings', label: 'Settings' },
  { id: 'advanced', label: 'Advanced' },
];

const TEMPLATES: {
  key: TemplateKey;
  title: string;
  description: string;
}[] = [
  { key: 'ats-clean', title: 'ATS Clean', description: 'Single column, parseable.' },
  { key: 'modern', title: 'Modern', description: 'Colored name accent.' },
  { key: 'compact', title: 'Compact', description: 'Tighter line height.' },
  { key: 'two-column', title: 'Two Column', description: 'Sidebar + main.' },
];

interface Props {
  theme: ResumeTheme;
  onChange: (next: ResumeTheme) => void;
}

export function BuilderDesigner({ theme, onChange }: Props) {
  const [sub, setSub] = useState<SubTab>('presentation');

  function patch<K extends keyof ResumeTheme>(key: K, value: ResumeTheme[K]) {
    onChange({ ...theme, [key]: value });
  }

  return (
    <div className="mx-auto w-full max-w-[760px]">
      <div className="flex items-end gap-6 border-b border-ink-line-soft" role="tablist">
        {SUB_TABS.map((t) => {
          const active = t.id === sub;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSub(t.id)}
              className={cn(
                'relative inline-flex h-10 items-center border-b-2 px-1 text-sm font-medium transition-colors',
                active
                  ? 'border-accent-text text-accent-text'
                  : 'border-transparent text-ink-500 hover:text-ink-900',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {sub === 'presentation' ? (
        <PresentationTab theme={theme} patch={patch} />
      ) : sub === 'sections' ? (
        <StubPanel
          title="Sections"
          body="Toggle which sections appear, rename them, and reorder them. Coming in V2.1 — for now reorder by deleting / re-adding entries on the Content Editor tab."
        />
      ) : sub === 'settings' ? (
        <StubPanel
          title="Settings"
          body="Spell-check language, hyphenation, paragraph spacing, and ATS-mode toggles ship with V2.1."
        />
      ) : (
        <StubPanel
          title="Advanced"
          body="Custom CSS overrides, per-section color tokens, and PDF metadata controls ship with V2.1."
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Presentation sub-tab
// ─────────────────────────────────────────────────────────────────────

function PresentationTab({
  theme,
  patch,
}: {
  theme: ResumeTheme;
  patch: <K extends keyof ResumeTheme>(key: K, value: ResumeTheme[K]) => void;
}) {
  return (
    <div className="flex flex-col gap-3 pt-5">
      {/* My Templates */}
      <CollapsibleGroup title="My Templates" defaultOpen>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <BrowseLibraryCard />
          {TEMPLATES.map((t) => (
            <TemplateThumb
              key={t.key}
              template={t}
              active={theme.templateKey === t.key}
              accent={theme.accent}
              onClick={() => patch('templateKey', t.key)}
            />
          ))}
        </div>
      </CollapsibleGroup>

      {/* Styling */}
      <CollapsibleGroup title="Styling" defaultOpen>
        <div className="flex flex-col gap-4">
          <LabeledRow label="Font">
            <FontSelect
              value={theme.font}
              onChange={(v) => patch('font', v)}
            />
          </LabeledRow>
          <LabeledRow label="Line Height">
            <PercentSlider
              value={theme.lineHeight}
              min={80}
              max={200}
              step={5}
              onChange={(n) => patch('lineHeight', n)}
            />
          </LabeledRow>
          <LabeledRow label="List Line Height">
            <PercentSlider
              value={theme.listLineHeight}
              min={80}
              max={200}
              step={5}
              onChange={(n) => patch('listLineHeight', n)}
            />
          </LabeledRow>
          <LabeledRow label="Accent Color">
            <AccentPicker
              value={theme.accent}
              onChange={(c) => patch('accent', c)}
            />
          </LabeledRow>
          <LabeledRow label="Date Format">
            <DateFormatSelect
              value={theme.dateFormat}
              onChange={(v) => patch('dateFormat', v)}
            />
          </LabeledRow>
        </div>
      </CollapsibleGroup>

      {/* Alignments & Layouts */}
      <CollapsibleGroup title="Alignments & Layouts" defaultOpen>
        <div className="flex flex-col gap-5">
          <TilePicker<Alignment>
            label="Header Alignment"
            value={theme.headerAlignment}
            onChange={(v) => patch('headerAlignment', v)}
            options={[
              { value: 'left', label: 'Left', preview: <HeaderMock align="left" accent={theme.accent} /> },
              { value: 'center', label: 'Center', preview: <HeaderMock align="center" accent={theme.accent} /> },
              { value: 'right', label: 'Right', preview: <HeaderMock align="right" accent={theme.accent} /> },
            ]}
          />
          <TilePicker<'left' | 'right'>
            label="Date Alignment"
            value={theme.dateAlignment}
            onChange={(v) => patch('dateAlignment', v)}
            options={[
              { value: 'left', label: 'Left', preview: <DateMock align="left" /> },
              { value: 'right', label: 'Right', preview: <DateMock align="right" /> },
            ]}
          />
          <TilePicker<'left' | 'right'>
            label="Location Alignment"
            value={theme.locationAlignment}
            onChange={(v) => patch('locationAlignment', v)}
            options={[
              { value: 'left', label: 'Left', preview: <LocationMock align="left" /> },
              { value: 'right', label: 'Right', preview: <LocationMock align="right" /> },
            ]}
          />
          <TilePicker<SkillsLayout>
            label="Skills Layout"
            value={theme.skillsLayout}
            onChange={(v) => patch('skillsLayout', v)}
            options={[
              { value: 'comma', label: 'Comma Separated', preview: <SkillsMock layout="comma" /> },
              { value: 'comma-list', label: 'Comma Separated List', preview: <SkillsMock layout="comma-list" /> },
              { value: 'columns', label: 'Columns', preview: <SkillsMock layout="columns" /> },
            ]}
          />
        </div>
      </CollapsibleGroup>

      {/* Page Setup */}
      <CollapsibleGroup title="Page Setup">
        <div className="flex flex-col gap-4">
          <LabeledRow label="Paper Size">
            <PaperSizeSelect
              value={theme.paperSize}
              onChange={(v) => patch('paperSize', v)}
            />
          </LabeledRow>
          <LabeledRow label="Left & Right Margins">
            <InchesSlider
              value={theme.marginsLR}
              min={0.2}
              max={1.5}
              step={0.05}
              onChange={(n) => patch('marginsLR', n)}
            />
          </LabeledRow>
          <LabeledRow label="Top & Bottom Margins">
            <InchesSlider
              value={theme.marginsTB}
              min={0.2}
              max={1.5}
              step={0.05}
              onChange={(n) => patch('marginsTB', n)}
            />
          </LabeledRow>
        </div>
      </CollapsibleGroup>

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={() => Object.entries(DEFAULT_THEME).forEach(([k, v]) => patch(k as keyof ResumeTheme, v as never))}
          className="text-xs font-semibold text-ink-500 transition-colors hover:text-ink-900 hover:underline"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function StubPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-6 rounded-md border border-ink-line-soft bg-bg-muted/40 p-6 text-center">
      <p className="text-sm font-semibold text-ink-900">{title}</p>
      <p className="mt-1 text-sm text-ink-500">{body}</p>
    </div>
  );
}

function CollapsibleGroup({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-ink-line-soft pb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-3 text-left text-sm font-semibold text-ink-900"
      >
        <ChevronDownIcon
          className={cn(
            'h-4 w-4 text-ink-500 transition-transform',
            open ? 'rotate-0' : '-rotate-90',
          )}
          aria-hidden="true"
        />
        <span>{title}</span>
      </button>
      {open ? <div className="pt-2">{children}</div> : null}
    </div>
  );
}

function LabeledRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
      <label className="text-xs font-semibold text-ink-700 sm:w-40 sm:shrink-0">
        {label}
      </label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function BrowseLibraryCard() {
  return (
    <button
      type="button"
      className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-accent-200 bg-accent-50/40 p-4 text-center transition-colors hover:border-accent-text hover:bg-accent-50"
      title="Browse the full template library"
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent-50 text-accent-text">
        <PlusIcon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="text-sm font-semibold text-accent-text">
        Browse Template Library
      </span>
    </button>
  );
}

function TemplateThumb({
  template,
  active,
  accent,
  onClick,
}: {
  template: { key: TemplateKey; title: string; description: string };
  active: boolean;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={template.description}
      className={cn(
        'group relative flex aspect-[3/4] flex-col items-stretch rounded-md border-2 bg-white p-3 text-left shadow-card transition-colors',
        active ? 'border-accent-text' : 'border-ink-line-soft hover:border-accent-200',
      )}
    >
      {active ? (
        <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent-700 text-accent-ink">
          <CheckCircleIcon className="h-5 w-5" aria-hidden="true" />
        </span>
      ) : null}
      <TemplateMiniature template={template.key} accent={accent} />
      <p className="mt-2 text-[11px] font-semibold text-ink-900">{template.title}</p>
    </button>
  );
}

function TemplateMiniature({
  template,
  accent,
}: {
  template: TemplateKey;
  accent: string;
}) {
  const isTwoCol = template === 'two-column';
  return (
    <div className="flex h-full w-full flex-col gap-1 rounded-sm bg-bg-muted/40 p-2">
      {/* Name + tagline */}
      <div className={cn('flex flex-col gap-0.5', template === 'modern' && 'items-center')}>
        <div className="h-1.5 w-14 rounded-full" style={{ background: accent }} />
        <div className="h-1 w-20 rounded-full bg-ink-line" />
      </div>
      {/* Body */}
      <div className={cn('mt-1 flex flex-1 gap-1', isTwoCol ? '' : 'flex-col')}>
        {isTwoCol ? (
          <>
            <div className="flex-1 space-y-0.5">
              <div className="h-1 w-full rounded-full bg-ink-line-soft" />
              <div className="h-1 w-2/3 rounded-full bg-ink-line-soft" />
              <div className="h-1 w-1/2 rounded-full bg-ink-line-soft" />
            </div>
            <div className="flex-[2] space-y-0.5">
              <div className="h-1 w-full rounded-full bg-ink-line-soft" />
              <div className="h-1 w-5/6 rounded-full bg-ink-line-soft" />
              <div className="h-1 w-3/4 rounded-full bg-ink-line-soft" />
              <div className="h-1 w-2/3 rounded-full bg-ink-line-soft" />
            </div>
          </>
        ) : (
          <>
            <div className="h-1 w-full rounded-full bg-ink-line-soft" />
            <div className="h-1 w-5/6 rounded-full bg-ink-line-soft" />
            <div className="h-1 w-2/3 rounded-full bg-ink-line-soft" />
            <div className="mt-1 h-1 w-1/3 rounded-full" style={{ background: accent }} />
            <div className="h-1 w-3/4 rounded-full bg-ink-line-soft" />
            <div className="h-1 w-2/3 rounded-full bg-ink-line-soft" />
          </>
        )}
      </div>
    </div>
  );
}

function FontSelect({
  value,
  onChange,
}: {
  value: FontKey;
  onChange: (next: FontKey) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as FontKey)}
      className="h-10 w-full rounded-md border border-ink-line bg-white px-3 text-sm text-ink-900 focus:border-accent-text focus:outline-none focus:shadow-focus"
    >
      {FONT_OPTIONS.map((o) => (
        <option key={o.key} value={o.key} style={{ fontFamily: o.cssVar }}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function DateFormatSelect({
  value,
  onChange,
}: {
  value: DateFormat;
  onChange: (next: DateFormat) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as DateFormat)}
      className="h-10 w-full rounded-md border border-ink-line bg-white px-3 text-sm text-ink-900 focus:border-accent-text focus:outline-none focus:shadow-focus"
    >
      <option value="MM/YYYY">Numbers (MM/YYYY)</option>
      <option value="Mon YYYY">Short (Mon YYYY)</option>
      <option value="YYYY">Year only (YYYY)</option>
    </select>
  );
}

function PaperSizeSelect({
  value,
  onChange,
}: {
  value: PaperSize;
  onChange: (next: PaperSize) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as PaperSize)}
      className="h-10 w-full rounded-md border border-ink-line bg-white px-3 text-sm text-ink-900 focus:border-accent-text focus:outline-none focus:shadow-focus"
    >
      <option value="letter">Letter (8.5 × 11 Inches)</option>
      <option value="a4">A4 (210 × 297 mm)</option>
    </select>
  );
}

function PercentSlider({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="inline-flex h-9 items-center rounded-md border border-ink-line bg-white px-2 text-sm">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="w-12 bg-transparent text-right text-sm font-medium text-ink-900 focus:outline-none"
        />
        <span className="text-sm text-ink-500">%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="robo-range flex-1 accent-accent-700"
      />
    </div>
  );
}

function InchesSlider({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="inline-flex h-9 items-center rounded-md border border-ink-line bg-white px-2 text-sm">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="w-12 bg-transparent text-right text-sm font-medium text-ink-900 focus:outline-none"
        />
        <span className="text-sm text-ink-500">in</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="robo-range flex-1 accent-accent-700"
      />
    </div>
  );
}

function AccentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACCENT_SWATCHES.map((s) => {
        const active = s.color.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={s.color}
            type="button"
            onClick={() => onChange(s.color)}
            title={s.label}
            aria-label={s.label}
            className={cn(
              'relative h-7 w-7 rounded-full transition-transform hover:scale-110',
              active && 'ring-2 ring-ink-900 ring-offset-2',
            )}
            style={{ background: s.color }}
          />
        );
      })}
      {/* Custom color picker — mirrors Teal's "ask" tile. */}
      <label
        className="relative inline-flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-ink-line bg-gradient-to-br from-amber-300 via-pink-400 to-violet-500 text-[10px] font-bold text-white"
        title="Custom color"
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <span aria-hidden="true">+</span>
      </label>
    </div>
  );
}

interface TilePickerOption<T> {
  value: T;
  label: string;
  preview: ReactNode;
}

function TilePicker<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: TilePickerOption<T>[];
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-ink-700">{label}</p>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex flex-col items-stretch gap-2 rounded-md border bg-white p-3 text-left transition-colors',
                active
                  ? 'border-ink-900 ring-1 ring-ink-900'
                  : 'border-ink-line-soft hover:border-accent-200',
              )}
            >
              <div className="rounded-sm border border-ink-line-soft bg-bg-muted/30 p-2">
                {opt.preview}
              </div>
              <p
                className={cn(
                  'text-xs',
                  active ? 'font-semibold text-ink-900' : 'text-ink-500',
                )}
              >
                {opt.label}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Mock previews used inside TilePickers ────────────────────────────

function HeaderMock({
  align,
  accent,
}: {
  align: Alignment;
  accent: string;
}) {
  const alignClass =
    align === 'left' ? 'items-start' : align === 'center' ? 'items-center' : 'items-end';
  return (
    <div className={cn('flex flex-col gap-1', alignClass)}>
      <div className="text-[10px] font-bold" style={{ color: accent }}>
        Full Name
      </div>
      <div className="text-[8px] text-ink-500">Information · Information</div>
    </div>
  );
}

function DateMock({ align }: { align: 'left' | 'right' }) {
  if (align === 'left') {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="text-[9px] font-semibold text-ink-900">
          Company 01 · 01/2022 - Present
        </div>
        <div className="text-[8px] text-ink-500">Position 01</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-semibold text-ink-900">Company 01</span>
        <span className="text-[8px] text-ink-500">01/2022 - Present</span>
      </div>
      <div className="text-[8px] text-ink-500">Position 01</div>
    </div>
  );
}

function LocationMock({ align }: { align: 'left' | 'right' }) {
  if (align === 'left') {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="text-[9px] font-semibold text-ink-900">
          Company 01 · Location
        </div>
        <div className="text-[8px] text-ink-500">Position 01</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-semibold text-ink-900">Company 01</span>
        <span className="text-[8px] text-ink-500">Location</span>
      </div>
      <div className="text-[8px] text-ink-500">Position 01</div>
    </div>
  );
}

function SkillsMock({ layout }: { layout: SkillsLayout }) {
  if (layout === 'comma') {
    return (
      <div className="flex flex-col gap-0.5 text-[8px] text-ink-700">
        <div>
          <span className="font-semibold">Category:</span> Skill, Skill, Skill
        </div>
        <div>
          <span className="font-semibold">Category:</span> Skill, Skill, Skill
        </div>
        <div>
          <span className="font-semibold">Category:</span> Skill, Skill, Skill
        </div>
      </div>
    );
  }
  if (layout === 'comma-list') {
    return (
      <ul className="list-disc space-y-0.5 pl-3 text-[8px] text-ink-700 marker:text-ink-300">
        <li>
          <span className="font-semibold">Category:</span> Skill, Skill, Skill
        </li>
        <li>
          <span className="font-semibold">Category:</span> Skill, Skill, Skill
        </li>
        <li>
          <span className="font-semibold">Category:</span> Skill, Skill, Skill
        </li>
      </ul>
    );
  }
  // columns
  return (
    <div className="grid grid-cols-3 gap-2 text-[8px] text-ink-700">
      {[1, 2, 3].map((i) => (
        <div key={i}>
          <div className="font-semibold">Category</div>
          <div>Skill</div>
          <div>Skill</div>
          <div>Skill</div>
        </div>
      ))}
    </div>
  );
}
