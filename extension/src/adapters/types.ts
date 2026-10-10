// extension/src/adapters/types.ts — the ATS adapter contract (ARCHITECTURE.md §6.5).
//
// An adapter reads one employer application form and fills fields with the
// _kit setters. It has NO submit() and NO next(): moving between pages and
// submitting are the user's clicks on the site's own buttons (D1).

/** Canonical field keys the value resolver knows (mapping/resolve.ts). */
export const FIELD_KEYS = [
  'firstName',
  'lastName',
  'fullName',
  'preferredName',
  'email',
  'phone',
  'addressLine1',
  'city',
  'region',
  'postalCode',
  'country',
  'location',
  'linkedin',
  'github',
  'portfolio',
  'website',
  'x',
  'currentCompany',
  'currentTitle',
  'school',
  'degree',
  'discipline',
  'resume',
  'coverLetter',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export type FieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'combobox'
  | 'file';

export interface FieldHandle {
  /** Stable within the page (element id, else name, else position). */
  id: string;
  /** The visible question or label text. */
  label: string;
  kind: FieldKind;
  required: boolean;
  /** The input/select/textarea; for a radio group, the first radio; for a combobox, its input. */
  element: HTMLElement;
  /** Radio group members (kind 'radio'). */
  group?: HTMLInputElement[];
  /** Option labels for select / radio / known combobox options. */
  options?: string[];
  maxLength?: number;
  /** A key the adapter knows from the form's own field names (beats label heuristics). */
  hint?: FieldKey;
}

export type FieldValue =
  | { kind: 'text'; text: string }
  /** Choose the option whose label best matches. */
  | { kind: 'option'; option: string }
  | { kind: 'checked'; checked: boolean };

export type FillFailure = 'not_found' | 'no_option' | 'disabled' | 'unsupported' | 'refused';

/** What a field held before we changed it (for "Undo autofill"). */
export type PreviousValue =
  | { kind: 'text'; text: string }
  | { kind: 'select'; value: string }
  | { kind: 'radio'; checked: HTMLInputElement | null }
  | { kind: 'checkbox'; checked: boolean }
  | { kind: 'files'; count: number }
  | { kind: 'combobox'; text: string };

export interface FillResult {
  ok: boolean;
  reason?: FillFailure;
  previous?: PreviousValue;
}

export interface JobOnPage {
  title?: string;
  company?: string;
  location?: string;
  descriptionText?: string;
}

/** Adapter ids. The core three ship in WP-55b; WP-70 / WP-71 add the rest. */
export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'smartrecruiters'
  | 'icims'
  | 'workable'
  | 'taleo'
  | 'successfactors'
  | 'moka'
  | 'beisen'
  | 'feishu'
  | 'dayee'
  | 'generic';

export interface AtsAdapter {
  id: AtsType;
  /** Display name of the form host (a real product name, shown as "Form on {site}"). */
  siteName: string;
  /**
   * Chrome match patterns for the hosts this adapter serves. They become the
   * manifest's `host_permissions` and content-script `matches` (never a job
   * board such as LinkedIn or Indeed).
   */
  hostPatterns: string[];
  matches(url: URL, doc: Document): boolean;
  /** The form markup alone (host ignored): used by dev builds on local fixture pages. */
  probe(doc: Document): boolean;
  readJob(doc: Document): JobOnPage | null;
  /** Stable order, each with label text and input kind. */
  listFields(root: Document | ShadowRoot): FieldHandle[];
  fill(field: FieldHandle, value: FieldValue): Promise<FillResult>;
  attachFile(field: FieldHandle, file: File): Promise<FillResult>;
  // NO submit(), NO next(): deliberately absent from the interface.
}
