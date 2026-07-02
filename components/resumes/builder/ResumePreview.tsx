'use client';

// ResumePreview — the right-pane live render of the structured resume.
//
// Reads every field of `ResumeTheme` and applies it to the rendered DOM:
//   • accent  → name + section-heading color
//   • font    → font-family of the entire preview shell
//   • lineHeight / listLineHeight → CSS line-height on paragraphs / lists
//   • headerAlignment → text alignment of the name + contact strip
//   • dateAlignment / locationAlignment → row layout of experience headers
//   • skillsLayout → comma / comma-list / 3-column variants
//   • dateFormat → reformats raw user-typed dates
//   • paperSize + marginsLR / marginsTB → page surface dimensions
//
// Markdown safety: bullets render through react-markdown + rehype-sanitize.

import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import type { StructuredResume } from '../../../lib/resumeStructure';
import {
  fontFamilyFor,
  formatDateString,
  DEFAULT_THEME,
  type ResumeTheme,
} from '../../../lib/resumeTheme';

function dateRange(start: string, end: string, fmt: ResumeTheme['dateFormat']): string {
  const a = formatDateString(start, fmt);
  const b = formatDateString(end, fmt);
  if (a && b) return `${a} - ${b}`;
  if (a) return a;
  if (b) return b;
  return '';
}

function InlineMd({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        p: ({ children }) => <>{children}</>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

// Group flat skills into 3 fake categories so the layout-picker previews look
// realistic when the user hasn't entered categorized skills yet.
function groupSkills(skills: string[]): { category: string; items: string[] }[] {
  if (skills.length === 0) return [];
  const buckets: { category: string; items: string[] }[] = [
    { category: 'Tools', items: [] },
    { category: 'Languages', items: [] },
    { category: 'Skills', items: [] },
  ];
  skills.forEach((s, i) => {
    buckets[i % 3].items.push(s);
  });
  return buckets.filter((b) => b.items.length > 0);
}

interface Props {
  resume: StructuredResume;
  theme?: ResumeTheme;
}

export function ResumePreview({ resume, theme = DEFAULT_THEME }: Props) {
  const { contact, targetTitle, summary, experiences, education, skills } =
    resume;

  const accent = theme.accent;
  const fontFamily = fontFamilyFor(theme.font);
  // Page size in CSS pixels (1in = 96px). Cap the preview width so it fits
  // in the right pane without horizontal scroll.
  const pageWidthIn = theme.paperSize === 'a4' ? 8.27 : 8.5;
  const padX = `${theme.marginsLR}in`;
  const padY = `${theme.marginsTB}in`;
  const lineHeight = theme.lineHeight / 100;
  const listLineHeight = theme.listLineHeight / 100;

  const headerAlignClass =
    theme.headerAlignment === 'center'
      ? 'text-center'
      : theme.headerAlignment === 'right'
        ? 'text-right'
        : 'text-left';

  return (
    <div
      id="resume-preview-root"
      className="mx-auto w-full bg-white text-[13px] text-zinc-900 shadow-card"
      style={{
        fontFamily,
        maxWidth: `${pageWidthIn}in`,
        paddingLeft: padX,
        paddingRight: padX,
        paddingTop: padY,
        paddingBottom: padY,
        lineHeight,
        ['--resume-list-line-height' as string]: String(listLineHeight),
      }}
      aria-label="Resume preview"
    >
      <header className={headerAlignClass}>
        <h1
          className="font-display text-[28px] font-bold tracking-tight"
          style={{ color: accent, letterSpacing: '-0.02em' }}
        >
          {contact.fullName.trim() || 'Your Name'}
        </h1>
        {contact.email || contact.phone || contact.location || contact.links.length ? (
          <p className="mt-1 text-[12px] text-zinc-600">
            {[
              contact.email,
              contact.phone,
              contact.location,
              ...contact.links,
            ]
              .filter((v) => v && v.trim().length > 0)
              .join('  |  ')}
          </p>
        ) : null}
        {targetTitle.trim() ? (
          <p className="mt-2 font-semibold text-zinc-900">{targetTitle.trim()}</p>
        ) : null}
      </header>

      {summary.trim() ? (
        <>
          <hr className="my-4 border-zinc-200" />
          <p className="text-zinc-800">
            <InlineMd>{summary.trim()}</InlineMd>
          </p>
        </>
      ) : null}

      {experiences.length > 0 ? (
        <section className="mt-5">
          <SectionHeading accent={accent}>Work Experience</SectionHeading>
          <div className="mt-2 flex flex-col gap-4">
            {experiences.map((exp) => {
              const range = dateRange(exp.startDate, exp.endDate, theme.dateFormat);
              return (
                <div key={exp.id}>
                  <ExperienceHeader
                    company={exp.company}
                    title={exp.title}
                    location={exp.location}
                    range={range}
                    dateAlign={theme.dateAlignment}
                    locationAlign={theme.locationAlignment}
                  />
                  {exp.bullets.filter((b) => b.trim()).length > 0 ? (
                    <ul
                      className="mt-1.5 list-disc space-y-0.5 pl-5 text-zinc-800 marker:text-zinc-400"
                      style={{ lineHeight: listLineHeight }}
                    >
                      {exp.bullets.map((b, i) =>
                        b.trim() ? (
                          <li key={i}>
                            <InlineMd>{b}</InlineMd>
                          </li>
                        ) : null,
                      )}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {education.length > 0 ? (
        <section className="mt-5">
          <SectionHeading accent={accent}>Education</SectionHeading>
          <div className="mt-2 flex flex-col gap-3">
            {education.map((ed) => {
              const range = dateRange(ed.startDate, ed.endDate, theme.dateFormat);
              return (
                <div key={ed.id}>
                  <ExperienceHeader
                    company={ed.school}
                    title={ed.degree}
                    location={ed.location}
                    range={range}
                    dateAlign={theme.dateAlignment}
                    locationAlign={theme.locationAlignment}
                  />
                  {ed.bullets.filter((b) => b.trim()).length > 0 ? (
                    <ul
                      className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-800 marker:text-zinc-400"
                      style={{ lineHeight: listLineHeight }}
                    >
                      {ed.bullets.map((b, i) =>
                        b.trim() ? (
                          <li key={i}>
                            <InlineMd>{b}</InlineMd>
                          </li>
                        ) : null,
                      )}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {skills.length > 0 ? (
        <section className="mt-5">
          <SectionHeading accent={accent}>Skills</SectionHeading>
          <SkillsBlock skills={skills} layout={theme.skillsLayout} />
        </section>
      ) : null}
    </div>
  );
}

function SectionHeading({
  accent,
  children,
}: {
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <h2
      className="text-[12px] font-semibold uppercase tracking-[0.12em]"
      style={{ color: accent }}
    >
      {children}
    </h2>
  );
}

function ExperienceHeader({
  company,
  title,
  location,
  range,
  dateAlign,
  locationAlign,
}: {
  company: string;
  title: string;
  location: string;
  range: string;
  dateAlign: 'left' | 'right';
  locationAlign: 'left' | 'right';
}) {
  const company_s = company.trim() || '—';
  const title_s = title.trim() || '—';
  const location_s = location.trim();

  // Left-aligned date: render in line 1 next to company. Right-aligned: render
  // on the right edge of line 1. Same logic for location on line 2 (or
  // bundled with company when both are right-aligned).
  if (dateAlign === 'right') {
    return (
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-semibold text-zinc-900">{company_s}</p>
          <p className="text-[12px] font-medium text-zinc-600">{range}</p>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-zinc-700">{title_s}</p>
          {location_s && locationAlign === 'right' ? (
            <p className="text-[12px] text-zinc-600">{location_s}</p>
          ) : null}
        </div>
        {location_s && locationAlign === 'left' ? (
          <p className="text-[12px] text-zinc-600">{location_s}</p>
        ) : null}
      </div>
    );
  }
  // dateAlign === 'left' — inline with company.
  return (
    <div>
      <p className="font-semibold text-zinc-900">
        {[company_s, title_s, range].filter(Boolean).join(' · ')}
      </p>
      {location_s ? <p className="text-[12px] text-zinc-600">{location_s}</p> : null}
    </div>
  );
}

function SkillsBlock({
  skills,
  layout,
}: {
  skills: string[];
  layout: ResumeTheme['skillsLayout'];
}) {
  const clean = skills.filter((s) => s.trim());
  if (clean.length === 0) return null;
  const grouped = groupSkills(clean);

  if (layout === 'comma') {
    // Flat — "skill · skill · skill"
    return (
      <p className="mt-1.5 text-zinc-800">{clean.join('  ·  ')}</p>
    );
  }
  if (layout === 'comma-list') {
    return (
      <ul
        className="mt-1.5 list-disc space-y-0.5 pl-5 text-zinc-800 marker:text-zinc-400"
      >
        {grouped.map((g) => (
          <li key={g.category}>
            <span className="font-semibold">{g.category}:</span> {g.items.join(', ')}
          </li>
        ))}
      </ul>
    );
  }
  // columns
  return (
    <div
      className="mt-1.5 grid gap-3"
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, grouped.length)}, minmax(0, 1fr))`,
      }}
    >
      {grouped.map((g) => (
        <div key={g.category} className="text-zinc-800">
          <p className="font-semibold">{g.category}</p>
          {g.items.map((it) => (
            <p key={it}>{it}</p>
          ))}
        </div>
      ))}
    </div>
  );
}
