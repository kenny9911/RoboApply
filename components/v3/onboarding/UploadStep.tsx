'use client';

// UploadStep — the resume drop zone, embedded by ResumeSelectPanel's
// "Upload new" mode. Presentational: the parent owns the file state and the
// real upload mutation. The accept list mirrors the backend truth set
// (`DocumentParsingService.isAcceptedUpload`: PDF / DOC / DOCX / TXT / MD) —
// no fake format claims, no fake parse confirmation. The real "what I picked
// up" rows now live in IngestRecap (built server-side at bootstrap); the
// legacy `extracted` props remain for the optional inline reveal but the
// onboarding flow passes an empty list.

import { useTranslations } from 'next-intl';
import { IconUpload, IconCheck } from '../primitives/Iconset';

export interface IngestRow {
  /** already-translated field label, e.g. "Identity" */
  label: string;
  /** derived value, e.g. the parsed candidate headline */
  value: string;
}

interface Props {
  /** Picked file (name + human size) or null. */
  file: { name: string; size: string } | null;
  /** Revealed ingest rows (grows over time). */
  extracted: IngestRow[];
  /** Total rows expected — drives the pending spinner. */
  totalRows: number;
  /** Open the native file picker / accept a dropped file. */
  onPick: (file: File | null) => void;
  /** Inline error (parse failed). */
  error?: string | null;
}

export function UploadStep({ file, extracted, totalRows, onPick, error }: Props) {
  const t = useTranslations('onboarding.upload');

  return (
    <>
      <h1>
        {t('title')} <em>{t('title_accent')}</em>.
      </h1>
      <p className="lead">{t('lead')}</p>

      <label className={`upload-zone ${file ? 'has-file' : ''}`}>
        <input
          type="file"
          accept=".pdf,.doc,.docx,.txt,.md"
          className="sr-only"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
        {!file ? (
          <>
            <div className="ic">
              <IconUpload size={22} strokeWidthValue={2.2} />
            </div>
            <h3>{t('drop_title')}</h3>
            <p>{t('drop_sub')}</p>
            <div className="formats">
              <span>PDF</span> · <span>DOC/DOCX</span> · <span>TXT</span> ·{' '}
              <span>MD</span>
            </div>
          </>
        ) : (
          <div className="check-row">
            <div className="check">
              <IconCheck size={20} strokeWidthValue={3} />
            </div>
            <div>
              <div className="file">{file.name}</div>
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-2)',
                  marginTop: 4,
                  fontFamily: 'var(--mono)',
                }}
              >
                {t('received', { size: file.size })}
              </div>
            </div>
          </div>
        )}
      </label>

      {error ? (
        <p
          role="alert"
          style={{
            marginTop: 14,
            color: 'var(--warn)',
            fontSize: 13.5,
            textAlign: 'left',
          }}
        >
          {error}
        </p>
      ) : null}

      {file && extracted.length > 0 ? (
        <div className="ingest">
          <div className="ingest-title">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2 9 9l-7 3 7 3 3 7 3-7 7-3-7-3-3-7Z" />
            </svg>
            {t('ingest_title')}
          </div>
          {extracted.map((row, i) => (
            <div key={i} className="ingest-row" style={{ animation: 'expand 0.25s ease' }}>
              <div className="ic">
                <IconCheck size={12} strokeWidthValue={3.5} />
              </div>
              <div>{row.label}</div>
              <div className="extracted">{row.value}</div>
            </div>
          ))}
          {extracted.length < totalRows ? (
            <div className="ingest-row pending">
              <div className="ic">
                <div className="spinner" />
              </div>
              <div>{t('reading')}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
