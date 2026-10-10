// components/features/agent/fileName.ts — preview of the file name a kit's
// resume will download as (PRODUCT F-AGENT-03 "file naming", F-RES-15).
//
// The server names the real file (server/src/roboapply/v2/lib/resumeExport.ts
// `buildExportFileName`); this mirrors its rules so Settings and the review
// screen can show the name before anything is downloaded. Once a file was
// recorded on the kit, the review shows the recorded name instead.

import type { AgentSettings } from '../../../lib/api/contracts/agent';

export type FileNameStyle = AgentSettings['fileNameStyle'];

function clean(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export interface FileNameParts {
  name?: string | null;
  company?: string | null;
  role?: string | null;
  date?: Date;
}

/** File name without the extension; '' when no part is known. Pure. */
export function previewFileName(style: FileNameStyle, parts: FileNameParts): string {
  const name = clean(parts.name);
  const company = clean(parts.company);
  const role = clean(parts.role);
  const date = (parts.date ?? new Date()).toISOString().slice(0, 10);
  let pieces: string[];
  switch (style) {
    case 'name_role':
      pieces = [name, role];
      break;
    case 'company_role_name':
      pieces = [company, role, name];
      break;
    case 'name_date':
      pieces = [name, date];
      break;
    case 'name_company_role':
    default:
      pieces = [name, company, role];
  }
  return pieces.filter(Boolean).join(' - ');
}
