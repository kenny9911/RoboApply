'use client';

// ResumePaper — the live "paper" preview in the right pane (.rb-paper). Renders
// the current StructuredResume (parsed from resumeMarkdown). Source:
// RoboApply_V3/resume-editor.jsx ResumePaper.
//
// The proto carried a Projects section; StructuredResume (lib/resumeStructure)
// round-trips Identity / Summary / Experience / Education / Skills only — so
// the editor + preview are scoped to those 5 sections to avoid losing data on
// save (see the page's contract note). Bullets / summary render via the V3
// Markdown primitive so any inline markup reads.

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
  const { contact, targetTitle, summary, experiences, education, skills } =
    resume;

  const contactBits = [contact.email, contact.phone, contact.location].filter(
    Boolean,
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

      {summary ? (
        <PaperSection title={t('section.summary')}>
          <div className="rb-paper-text">
            <Markdown>{summary}</Markdown>
          </div>
        </PaperSection>
      ) : null}

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

      {skills.length ? (
        <PaperSection title={t('section.skills')}>
          <div className="rb-paper-text">{skills.join(' · ')}</div>
        </PaperSection>
      ) : null}
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
