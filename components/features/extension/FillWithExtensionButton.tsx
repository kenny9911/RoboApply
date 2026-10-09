'use client';

// FillWithExtensionButton — "Fill this form" from a job: opens the employer's
// application page where the extension fills the fields; the user reviews and
// submits it themselves (D1) (PRODUCT_PLAN.md §5.17; TASK_PLAN.md WP-55a;
// ruling C27).
//
// STUB (FND-6b). Owner: WP-55a. Renders nothing. WP-34's "Get ready for this
// job" checklist renders it behind the `extension` flag. When filled it shows
// Install when the extension is absent and never watches or reports a submit.

export interface FillWithExtensionButtonProps {
  jobId: string;
  /** The employer's application URL; null when the job has none (the button stays hidden). */
  applyUrl: string | null;
}

export function FillWithExtensionButton(_props: FillWithExtensionButtonProps): null {
  return null;
}

export default FillWithExtensionButton;
