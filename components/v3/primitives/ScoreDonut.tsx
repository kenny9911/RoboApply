'use client';

// ScoreDonut — the V3 match-score ring (.score-donut). An SVG track + accent
// fill arc (glowing), the score number centered, and an optional mono label
// underneath. `value` is 0..100. Size scales the whole thing; the stroke +
// radius derive from it so the donut stays crisp at any size (the prototype
// uses 56px in match rows, 120px in the results hero).

interface Props {
  /** 0..100 */
  value: number;
  /** Square px size. Default 56 (match-row size). */
  size?: number;
  /** Mono caption under the number, e.g. "MATCH". Omit to hide. */
  label?: string;
  /** Hide the numeric center (rare). */
  hideNumber?: boolean;
  className?: string;
}

export function ScoreDonut({
  value,
  size = 56,
  label = 'match',
  hideNumber = false,
  className,
}: Props) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  // Stroke scales with size; radius leaves room for the round cap.
  const stroke = Math.max(4, Math.round(size * 0.09));
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const dash = (clamped / 100) * circumference;

  return (
    <div
      className={`score-donut ${className ?? ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${clamped}% ${label}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="track" cx={cx} cy={cy(size)} r={r} />
        <circle
          className="fill"
          cx={cx}
          cy={cy(size)}
          r={r}
          strokeDasharray={`${dash} ${circumference}`}
        />
      </svg>
      {hideNumber ? null : <span className="num robo-tnum">{clamped}</span>}
      {label && !hideNumber ? <span className="lbl">{label}</span> : null}
    </div>
  );
}

// cy === cx for a square; helper keeps the JSX readable.
function cy(size: number) {
  return size / 2;
}
