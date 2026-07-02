'use client';

// RbField — a single labelled identity input (.rb-field). Controlled: the page
// owns the value and gets a string back on change. Source:
// RoboApply_V3/resume-editor.jsx RbField.

interface Props {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Show the small "✦ AI" hint after the label. */
  ai?: boolean;
  aiLabel?: string;
  placeholder?: string;
}

export function RbField({ label, value, onChange, ai, aiLabel, placeholder }: Props) {
  return (
    <label className="rb-field">
      <div className="rb-field-label">
        {label}
        {ai ? <span className="rb-field-ai">✦ {aiLabel}</span> : null}
      </div>
      <input
        className="rb-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
