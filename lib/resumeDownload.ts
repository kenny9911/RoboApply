// roboapply/lib/resumeDownload.ts
//
// Authed binary download of a server-rendered resume export (PDF/DOCX). The
// JSON `roboApi` client can't carry a binary body, so this does a raw fetch
// mirroring the client's auth (session_token cookie via credentials:'include'
// + the localStorage Bearer fallback for ITP'd browsers), then saves the blob.
// Backend: GET /api/v1/roboapply/v2/resumes/:id/export?format=pdf|docx.

import { API_BASE } from './config';

export type ResumeExportFormat = 'pdf' | 'docx';

function bearer(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

/** Pull the filename from Content-Disposition (RFC 5987 filename* first, so
 *  CJK names survive), falling back to a caller-supplied name. */
function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : fallback;
}

/**
 * Fetch the server-rendered export for a resume variant and trigger a browser
 * download. Throws on a non-2xx so the caller can surface an error state.
 */
export async function downloadResumeExport(
  id: string,
  format: ResumeExportFormat,
  fallbackName: string,
): Promise<void> {
  const url = `${API_BASE}/api/v1/roboapply/v2/resumes/${encodeURIComponent(
    id,
  )}/export?format=${format}`;
  const headers: Record<string, string> = {};
  const tok = bearer();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;

  const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
  if (!res.ok) throw new Error(`export_failed_${res.status}`);

  const blob = await res.blob();
  const name = filenameFromDisposition(
    res.headers.get('Content-Disposition'),
    `${fallbackName || 'resume'}.${format}`,
  );
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
