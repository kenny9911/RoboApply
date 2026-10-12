// components/features/coverletter — cover letters UI (WP-37; F-CL-01, F-CL-02).
// Cross-area imports go through this file (TASK_PLAN.md §2.1 rule 4).
//
// Job detail ("Write a cover letter"), the Assistant card and Ready to apply
// link with `newCoverLetterHref(jobId, trackerEntryId?)`; the resume hub's
// "Cover letters" tab links to COVER_LETTERS_HREF.

export { CoverLetterHub, type CoverLetterHubProps } from './CoverLetterHub';
export { CoverLetterEditor, type CoverLetterEditorProps } from './CoverLetterEditor';
export { NewLetterForm, type NewLetterFormProps } from './NewLetterForm';
export { RewritePanel, SourcesPanel, VersionsPanel } from './LetterPanels';
export { LetterError } from './LetterError';
export { COVER_LETTERS_HREF, coverLetterHref, newCoverLetterHref } from './links';
