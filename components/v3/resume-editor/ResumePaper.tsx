'use client';

// ResumePaper — the live "paper" preview in the right pane (.rb-paper). Renders
// the current StructuredResume (parsed from resumeMarkdown). Source:
// RoboApply_V3/resume-editor.jsx ResumePaper.
//
// Renders the 5 structured sections plus every preserved extra section
// (Projects, Certifications… — see StructuredResume.extraSections), so the
// preview matches what serializes to the server. Bullets / summary / extras
// render via the V3 Markdown primitive so any inline markup reads.
//
// WP-36b: with `layout`, the sheet follows the saved template (Standard,
// Compact, Centered, Structured, Two-column), page shape (Letter / A4),
// font, accent, spacing and date format, mirroring the server export
// (server/src/roboapply/v2/lib/resumeExport.ts). Document styling only — this
// file is résumé typography (ruling C25), not app chrome.

import type { CSSProperties, ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Markdown } from '../primitives';
import type { StructuredResume } from '../../../lib/resumeStructure';
import {
  SPACING_PRESETS,
  formatDatesIn,
  isSidebarSection,
  pageAspect,
  type DateFormat,
  type ResolvedLayout,
} from '../../features/resume/layout';

function dateRange(start: string, end: string, format: DateFormat): string {
  const a = formatDatesIn(start.trim(), format);
  const b = formatDatesIn(end.trim(), format);
  if (a && b) return `${a} — ${b}`;
  return a || b || '';
}

/** Preview px per export point (the sheet is ~540 px wide for a 612 pt page). */
const PT = 0.88;

const DOC_FONTS = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
} as const;

export function ResumePaper({ resume, layout }: { resume: StructuredResume; layout?: ResolvedLayout | null }) {
  const t = useTranslations('resume');
  const {
    contact,
    targetTitle,
    summary,
    experiences,
    education,
    skills,
    extraSections,
  } = resume;
  const dateFormat: DateFormat = layout?.dateFormat ?? 'as_written';

  const contactBits = [contact.email, contact.phone, contact.location].filter(
    Boolean,
  );

  // Every section in document order, tagged with its title (for the sidebar split).
  const sections: Array<{ key: string; title: string; node: ReactNode }> = [];
  const pushExtras = (anchor: 'summary' | 'experiences' | 'education' | 'skills' | null) => {
    for (const x of extraSections) {
      if (x.anchor !== anchor || !(x.markdown.trim() || x.heading.trim())) continue;
      sections.push({
        key: x.id,
        title: x.heading,
        node: (
          <div className="rb-paper-text">
            <Markdown>{x.markdown}</Markdown>
          </div>
        ),
      });
    }
  };

  pushExtras(null);
  if (summary) {
    sections.push({
      key: 'summary',
      title: t('section.summary'),
      node: (
        <div className="rb-paper-text">
          <Markdown>{summary}</Markdown>
        </div>
      ),
    });
  }
  pushExtras('summary');
  if (experiences.length) {
    sections.push({
      key: 'experience',
      title: t('section.experience'),
      node: experiences.map((e) => (
        <div key={e.id} className="rb-paper-exp">
          <div className="rb-paper-exp-head">
            <div>
              <span className="rb-paper-exp-co">{e.company}</span>
              {e.company && e.title ? <span className="rb-paper-exp-sep"> · </span> : null}
              <span className="rb-paper-exp-title">{e.title}</span>
            </div>
            <div className="rb-paper-exp-when">{dateRange(e.startDate, e.endDate, dateFormat)}</div>
          </div>
          {e.location ? <div className="rb-paper-exp-loc">{e.location}</div> : null}
          {e.bullets.length ? (
            <ul className="rb-paper-bullets">
              {e.bullets.map((b, i) => (
                <li key={i}>
                  <Markdown>{b}</Markdown>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )),
    });
  }
  pushExtras('experiences');
  if (education.length) {
    sections.push({
      key: 'education',
      title: t('section.education'),
      node: education.map((ed) => (
        <div key={ed.id} className="rb-paper-edu">
          <div className="rb-paper-exp-head">
            <div>
              <span className="rb-paper-exp-co">{ed.school}</span>
              {ed.school && ed.degree ? <span className="rb-paper-exp-sep"> · </span> : null}
              <span className="rb-paper-exp-title">{ed.degree}</span>
            </div>
            <div className="rb-paper-exp-when">{dateRange(ed.startDate, ed.endDate, dateFormat)}</div>
          </div>
          {ed.bullets.length ? (
            <ul className="rb-paper-bullets">
              {ed.bullets.map((b, i) => (
                <li key={i}>
                  <Markdown>{b}</Markdown>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )),
    });
  }
  pushExtras('education');
  if (skills.length) {
    sections.push({
      key: 'skills',
      title: t('section.skills'),
      node: <div className="rb-paper-text">{skills.join(' · ')}</div>,
    });
  }
  pushExtras('skills');

  // ── Layout → inline document styles ──
  const template = layout?.template ?? null;
  const spacing = layout ? SPACING_PRESETS[layout.spacing] : null;
  const paperStyle: CSSProperties | undefined = layout
    ? ({
        ['--resume-serif' as string]: DOC_FONTS[layout.font],
        ['--resume-mono' as string]: DOC_FONTS[layout.font],
        fontFamily: DOC_FONTS[layout.font],
        aspectRatio: `1 / ${pageAspect(layout.page)}`,
        minHeight: 0,
        padding: `${Math.round(spacing!.marginY * PT * 0.7)}px ${Math.round(spacing!.marginX * PT * 0.7)}px`,
        fontSize: template === 'compact' ? 10.5 : undefined,
      } as CSSProperties)
    : undefined;
  const headStyle: CSSProperties | undefined = layout
    ? {
        textAlign: layout.headerAlign,
        marginBottom: Math.round(spacing!.section * 1.6),
        ...(template === 'structured' ? { borderBottom: `1.5px solid ${layout.accent}`, paddingBottom: 10 } : null),
      }
    : undefined;
  const nameStyle: CSSProperties | undefined = layout ? { fontSize: template === 'compact' ? 24 : 28, fontWeight: 700 } : undefined;
  const titleStyle: CSSProperties | undefined = layout
    ? {
        color: layout.accent,
        borderBottomColor: template === 'structured' ? 'transparent' : layout.accent === '#1a1a1a' ? '#cccccc' : layout.accent,
        textAlign: template === 'centered' ? 'center' : 'left',
        letterSpacing: template === 'structured' ? '0.12em' : '0.02em',
        textTransform: template === 'structured' ? 'uppercase' : 'none',
        fontSize: template === 'structured' ? 10.5 : 12.5,
      }
    : undefined;
  const secStyle: CSSProperties | undefined = layout ? { marginBottom: Math.round(spacing!.section * 1.4) } : undefined;

  const renderSection = (s: { key: string; title: string; node: ReactNode }) => (
    <PaperSection key={s.key} title={s.title} style={secStyle} titleStyle={titleStyle}>
      {s.node}
    </PaperSection>
  );

  const twoColumn = template === 'two_column';
  const side = twoColumn ? sections.filter((s) => isSidebarSection(s.title)) : [];
  const main = twoColumn ? sections.filter((s) => !isSidebarSection(s.title)) : sections;

  return (
    <div className="rb-paper" style={paperStyle} data-template={template ?? undefined} data-page={layout?.page}>
      <div className="rb-paper-head" style={headStyle}>
        <h1 className="rb-paper-name" style={nameStyle}>{contact.fullName || t('paper.your_name')}</h1>
        {targetTitle ? <div className="rb-paper-title">{targetTitle}</div> : null}
        {contactBits.length ? (
          <div className="rb-paper-contact">{contactBits.join(' · ')}</div>
        ) : null}
        {contact.links.length ? (
          <div className="rb-paper-links">{contact.links.join(' · ')}</div>
        ) : null}
      </div>

      {twoColumn ? (
        <div style={{ display: 'grid', gridTemplateColumns: '32% 1fr', gap: 18, alignItems: 'start' }}>
          <div data-column="side">{side.map(renderSection)}</div>
          <div data-column="main">{main.map(renderSection)}</div>
        </div>
      ) : (
        main.map(renderSection)
      )}
    </div>
  );
}

function PaperSection({
  title,
  children,
  style,
  titleStyle,
}: {
  title: string;
  children: ReactNode;
  style?: CSSProperties;
  titleStyle?: CSSProperties;
}) {
  return (
    <section className="rb-paper-sec" style={style}>
      <h2 className="rb-paper-sec-title" style={titleStyle}>{title}</h2>
      {children}
    </section>
  );
}
