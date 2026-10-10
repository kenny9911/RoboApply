// components/features/coverletter/links.ts — the cover-letter routes (WP-37).
// Other areas link here instead of building the paths themselves:
//   job page / Assistant / Ready to apply  → newCoverLetterHref(jobId, trackerEntryId?)
//   tracker drawer                          → coverLetterHref(letterId, trackerEntryId)
//   resume hub "Cover letters" tab          → COVER_LETTERS_HREF

export const COVER_LETTERS_HREF = '/resume/letters';

/** The "Write a cover letter" form for a job (optionally attaching the letter to an application). */
export function newCoverLetterHref(jobId: string, trackerEntryId?: string | null): string {
  const q = new URLSearchParams({ jobId });
  if (trackerEntryId) q.set('entry', trackerEntryId);
  return `${COVER_LETTERS_HREF}?${q.toString()}`;
}

/** The editor of one letter; `trackerEntryId` offers "Attach to this application". */
export function coverLetterHref(letterId: string, trackerEntryId?: string | null): string {
  const base = `${COVER_LETTERS_HREF}/${encodeURIComponent(letterId)}`;
  return trackerEntryId ? `${base}?entry=${encodeURIComponent(trackerEntryId)}` : base;
}
