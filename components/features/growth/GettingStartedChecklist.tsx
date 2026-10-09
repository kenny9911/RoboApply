'use client';

// GettingStartedChecklist — "Tailor a resume · Do a practice interview ·
// Save a job"; finishing all three grants one practice credit, once
// (PRODUCT_PLAN.md F-GROW; TASK_PLAN.md WP-23).
//
// STUB (FND-6b). Owner: WP-23. Renders nothing. Progress is server state:
// steps complete only through `growth.markChecklistStep()` on the server
// (called by WP-34 save, WP-36a tailor finalize, WP-43 completed practice);
// the component reads it and never marks a step itself. Hidden once done or
// dismissed.

export interface GettingStartedChecklistProps {
  /** 'card' on the jobs page; 'compact' in narrow places (the More sheet). */
  variant?: 'card' | 'compact';
}

export function GettingStartedChecklist(_props: GettingStartedChecklistProps = {}): null {
  return null;
}

export default GettingStartedChecklist;
