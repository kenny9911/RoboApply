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
//
// WP-65: sections follow the resume's own order and titles (实习经历, 自我评价…;
// `StructuredResume.order` / `headings`), and the header shows the personal
// details line and the device photo the export will place.

import type { CSSProperties, ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Markdown } from '../primitives';
import { knownOrder, skillLines, type KnownSectionKind, type StructuredResume } from '../../../lib/resumeStructure';
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

export function ResumePaper({
  resume,
  layout,
  personalLine,
  photo,
  photoAlt,
}: {
  resume: StructuredResume;
  layout?: ResolvedLayout | null;
  /** The personal details line the export prints (GoApply 籍贯 / 政治面貌), or null. */
  personalLine?: string | null;
  /** The device photo the download will place (data URL), or null. */
  photo?: string | null;
  photoAlt?: string;
}) {
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
  // WP-65: the saved bullet mark, justify, skills layout and education order,
  // drawn the way the export draws them.
  const bulletStyle: CSSProperties | undefined =
    layout?.bullet === 'hollow' ? { listStyleType: 'circle' } : layout?.bullet === 'dash' ? { listStyleType: '"– "' } : undefined;

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

  const blocks: Record<KnownSectionKind, () => void> = {} as Record<KnownSectionKind, () => void>;
  blocks.summary = () => {
  if (summary) {
    sections.push({
      key: 'summary',
      title: resume.headings?.summary ?? t('section.summary'),
      node: (
        <div className="rb-paper-text">
          <Markdown>{summary}</Markdown>
        </div>
      ),
    });
  }
  };
  blocks.experiences = () => {
  if (experiences.length) {
    sections.push({
      key: 'experience',
      title: resume.headings?.experiences ?? t('section.experience'),
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
            <ul className="rb-paper-bullets" style={bulletStyle}>
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
  };
  blocks.education = () => {
  if (education.length) {
    sections.push({
      key: 'education',
      title: resume.headings?.education ?? t('section.education'),
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
            <ul className="rb-paper-bullets" style={bulletStyle}>
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
  };
  blocks.skills = () => {
  if (skills.length) {
    sections.push({
      key: 'skills',
      title: resume.headings?.skills ?? t('section.skills'),
      node:
        layout?.skillsLayout === 'columns' ? (
          <ul className="rb-paper-text" data-skills="columns" style={{ columns: 3, columnGap: 16, listStyle: 'none', margin: 0, padding: 0 }}>
            {skills.map((sk, i) => (
              <li key={i}>{sk}</li>
            ))}
          </ul>
        ) : resume.skillGroups?.some((g) => g.label) ? (
          // Labelled lines ("Tools: Zendesk · Jira"), as the export prints them.
          skillLines(resume).map((line, i) => (
            <div key={i} className="rb-paper-text" data-skills="grouped">
              <Markdown>{line}</Markdown>
            </div>
          ))
        ) : (
          <div className="rb-paper-text">{skills.join(' · ')}</div>
        ),
    });
  }
  };

  pushExtras(null);
  for (const kind of withEduOrder(knownOrder(resume), layout?.eduOrder)) {
    blocks[kind]();
    pushExtras(kind);
  }

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
  const secStyle: CSSProperties | undefined = layout
    ? { marginBottom: Math.round(spacing!.section * 1.4), ...(layout.justify ? { textAlign: 'justify' as const } : null) }
    : undefined;

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
      <div className="rb-paper-head" style={photo ? { ...headStyle, position: 'relative', paddingRight: 84, minHeight: 104 } : headStyle}>
        {photo ? (
          // A data: URL from this device (never uploaded); next/image adds nothing.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={photoAlt ?? ''} style={{ position: 'absolute', top: 0, right: 0, width: 64, height: 90, objectFit: 'cover' }} />
        ) : null}
        <h1 className="rb-paper-name" style={nameStyle}>{contact.fullName || t('paper.your_name')}</h1>
        {targetTitle ? <div className="rb-paper-title">{targetTitle}</div> : null}
        {contactBits.length ? (
          <div className="rb-paper-contact">{contactBits.join(' · ')}</div>
        ) : null}
        {contact.links.length ? (
          <div className="rb-paper-links">{contact.links.join(' · ')}</div>
        ) : null}
        {personalLine ? <div className="rb-paper-contact" data-testid="paper-personal">{personalLine}</div> : null}
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

/** Education before / after experience when the layout says so (the export's rule). */
export function withEduOrder(kinds: KnownSectionKind[], eduOrder: ResolvedLayout['eduOrder'] | undefined): KnownSectionKind[] {
  if (!eduOrder || eduOrder === 'as_written') return kinds;
  const edu = kinds.indexOf('education');
  const exp = kinds.indexOf('experiences');
  if (edu < 0 || exp < 0) return kinds;
  const wantBefore = eduOrder === 'before_experience';
  if ((wantBefore && edu < exp) || (!wantBefore && edu > exp)) return kinds;
  const rest: KnownSectionKind[] = kinds.filter((k) => k !== 'education');
  const at = rest.indexOf('experiences');
  rest.splice(wantBefore ? at : at + 1, 0, 'education');
  return rest;
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
