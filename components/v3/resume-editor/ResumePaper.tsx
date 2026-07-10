'use client';

// ResumePaper — the live "paper" preview in the right pane (.rb-paper). Renders
// the current StructuredResume (parsed from resumeMarkdown). Source:
// RoboApply_V3/resume-editor.jsx ResumePaper.
//
// Renders the 5 structured sections plus every preserved extra section
// (Projects, Certifications… — see StructuredResume.extraSections), so the
// preview matches what serializes to the server. Bullets / summary / extras
// render via the V3 Markdown primitive so any inline markup reads.

import { useTranslations } from 'next-intl';

import { Markdown } from '../primitives';
import type { StructuredResume } from '../../../lib/resumeStructure';

function dateRange(start: string, end: string): string {
  const a = start.trim();
  const b = end.trim();
  if (a && b) return `${a} — ${b}`;
  return a || b || '';
}

export function ResumePaper({ resume }: { resume: StructuredResume }) {
  const t = useTranslations('resumeEditor');
  const {
    contact,
    targetTitle,
    summary,
    experiences,
    education,
    skills,
    extraSections,
  } = resume;

  const contactBits = [contact.email, contact.phone, contact.location].filter(
    Boolean,
  );

  // Extras render at the same spots the serializer emits them (right after
  // the known block they followed in the source), so preview ≈ export.
  const extrasFor = (anchor: 'summary' | 'experiences' | 'education' | 'skills' | null) =>
    extraSections.map((x) =>
      x.anchor === anchor && (x.markdown.trim() || x.heading.trim()) ? (
        <PaperSection key={x.id} title={x.heading}>
          <div className="rb-paper-text">
            <Markdown>{x.markdown}</Markdown>
          </div>
        </PaperSection>
      ) : null,
    );

  return (
    <div className="rb-paper">
      <div className="rb-paper-head">
        <h1 className="rb-paper-name">{contact.fullName || t('paper.your_name')}</h1>
        {targetTitle ? <div className="rb-paper-title">{targetTitle}</div> : null}
        {contactBits.length ? (
          <div className="rb-paper-contact">{contactBits.join(' · ')}</div>
        ) : null}
        {contact.links.length ? (
          <div className="rb-paper-links">{contact.links.join(' · ')}</div>
        ) : null}
      </div>

      {extrasFor(null)}

      {summary ? (
        <PaperSection title={t('section.summary')}>
          <div className="rb-paper-text">
            <Markdown>{summary}</Markdown>
          </div>
        </PaperSection>
      ) : null}
      {extrasFor('summary')}

      {experiences.length ? (
        <PaperSection title={t('section.experience')}>
          {experiences.map((e) => (
            <div key={e.id} className="rb-paper-exp">
              <div className="rb-paper-exp-head">
                <div>
                  <span className="rb-paper-exp-co">{e.company}</span>
                  {e.company && e.title ? (
                    <span className="rb-paper-exp-sep"> · </span>
                  ) : null}
                  <span className="rb-paper-exp-title">{e.title}</span>
                </div>
                <div className="rb-paper-exp-when">
                  {dateRange(e.startDate, e.endDate)}
                </div>
              </div>
              {e.location ? (
                <div className="rb-paper-exp-loc">{e.location}</div>
              ) : null}
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
          ))}
        </PaperSection>
      ) : null}
      {extrasFor('experiences')}

      {education.length ? (
        <PaperSection title={t('section.education')}>
          {education.map((ed) => (
            <div key={ed.id} className="rb-paper-edu">
              <div className="rb-paper-exp-head">
                <div>
                  <span className="rb-paper-exp-co">{ed.school}</span>
                  {ed.school && ed.degree ? (
                    <span className="rb-paper-exp-sep"> · </span>
                  ) : null}
                  <span className="rb-paper-exp-title">{ed.degree}</span>
                </div>
                <div className="rb-paper-exp-when">
                  {dateRange(ed.startDate, ed.endDate)}
                </div>
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
          ))}
        </PaperSection>
      ) : null}
      {extrasFor('education')}

      {skills.length ? (
        <PaperSection title={t('section.skills')}>
          <div className="rb-paper-text">{skills.join(' · ')}</div>
        </PaperSection>
      ) : null}
      {extrasFor('skills')}
    </div>
  );
}

function PaperSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rb-paper-sec">
      <h2 className="rb-paper-sec-title">{title}</h2>
      {children}
    </section>
  );
}
