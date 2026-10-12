'use client';

// Iconset — ported from RoboApply_V3/icons.jsx. Minimal, sharp stroke icons
// (1.5px). Each icon takes `size` (px) + standard SVG passthrough props and
// inherits `currentColor` so it tints with whatever text color the parent
// sets (the V3 nav/topbar/buttons all rely on this).
//
// Usage: <IconHome size={15} /> · <IconSparkle className="..." />

import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Square px size. Default 16 (matches the prototype). */
  size?: number;
  /** Stroke width. Default 1.5. */
  strokeWidthValue?: number;
  /** Optional path `d` shortcut for single-path icons. */
  d?: string;
  children?: React.ReactNode;
}

function Icon({
  d,
  size = 16,
  strokeWidthValue = 1.5,
  fill = 'none',
  stroke = 'currentColor',
  children,
  ...rest
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidthValue}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export const IconSparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </Icon>
);
export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Icon>
);
export const IconArrow = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14M13 5l7 7-7 7" />
  </Icon>
);
export const IconCheck = (p: IconProps) => <Icon d="M4 12l5 5L20 6" {...p} />;
export const IconX = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M6 18L18 6" />
  </Icon>
);
export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6" />
  </Icon>
);
export const IconPause = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5v14M16 5v14" />
  </Icon>
);
export const IconPlay = (p: IconProps) => <Icon d="M6 4l14 8-14 8V4Z" {...p} />;
export const IconUpload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 16V4M6 10l6-6 6 6" />
    <path d="M4 20h16" />
  </Icon>
);
export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
    <path d="M14 3v6h6" />
  </Icon>
);
export const IconEdit = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20h4l10-10-4-4L4 16Z" />
    <path d="m14 6 4 4" />
  </Icon>
);
export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
    <path d="M3 21v-5h5" />
  </Icon>
);
export const IconBolt = (p: IconProps) => (
  <Icon d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" {...p} />
);
export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1Z" />
  </Icon>
);
export const IconStack = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 2 8l10 5 10-5-10-5Z" />
    <path d="M2 16l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </Icon>
);
export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Icon>
);
export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Icon>
);

// ── Practice / interview set ───────────────────────────────────────────────
// Drawn on the same 24 grid at 1.5px so they sit beside the originals without
// a visible weight break.

export const IconMic = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </Icon>
);
export const IconMicOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 9V6a3 3 0 0 1 5.9-.7" />
    <path d="M15 11.5V12a3 3 0 0 1-4.6 2.5" />
    <path d="M5 11a7 7 0 0 0 10.6 6" />
    <path d="M19 11v1" />
    <path d="M12 18v3" />
    <path d="m4 4 16 16" />
  </Icon>
);
export const IconCamera = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 2 15V9a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="m15 11 5.2-2.9a.6.6 0 0 1 .8.5v6.8a.6.6 0 0 1-.8.5L15 13Z" />
  </Icon>
);
export const IconCameraOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.5 7.5h5a1.5 1.5 0 0 1 1.5 1.5v3" />
    <path d="M15 13v2a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 2 15V9a1.5 1.5 0 0 1 1.5-1.5h.6" />
    <path d="m15 11 5.2-2.9a.6.6 0 0 1 .8.5v6.8a.6.6 0 0 1-.8.5l-2-1.1" />
    <path d="m4 4 16 16" />
  </Icon>
);
export const IconWaveform = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10.5v3M8 7v10M12 4.5v15M16 8v8M20 10.5v3" />
  </Icon>
);
export const IconChevron = (p: IconProps) => <Icon d="m6 9 6 6 6-6" {...p} />;
export const IconPerson = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Icon>
);
export const IconTarget = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconGlobe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
  </Icon>
);
export const IconTranscript = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H8.5L4.5 20v-3H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
    <path d="M7 10h7M7 13h5" />
  </Icon>
);
export const IconEndCall = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.6 14.2a1.4 1.4 0 0 1-.4-1.4C4 9.6 7.6 7.5 12 7.5s8 2.1 8.8 5.3a1.4 1.4 0 0 1-.4 1.4l-1.6 1.4a1.4 1.4 0 0 1-1.8 0l-1.5-1.2a1.4 1.4 0 0 1-.5-1.3l.2-1.2a10 10 0 0 0-6.4 0l.2 1.2a1.4 1.4 0 0 1-.5 1.3L7 16.6a1.4 1.4 0 0 1-1.8 0Z" />
  </Icon>
);
export const IconPanel = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M14.5 4.5v15" />
  </Icon>
);
export const IconSliders = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </Icon>
);
export const IconHistory = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4.5h4.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);


// ── Shell additions (FND-6a): nav entries for Ready to apply, Coaching,
// Invite friends, the extension, the campus calendar, More and Ask. ──────
export const IconCalendar = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Icon>
);
export const IconGift = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="8" width="17" height="4" rx="1" />
    <path d="M5 12v8h14v-8M12 8v12M12 8c-1.5-3-5-3.5-5-1.25S10 8 12 8Zm0 0c1.5-3 5-3.5 5-1.25S14 8 12 8Z" />
  </Icon>
);
export const IconPuzzle = (p: IconProps) => (
  <Icon
    d="M9 4.5a2 2 0 1 1 4 0V6h3.5a1 1 0 0 1 1 1v3.5H19a2 2 0 1 1 0 4h-1.5V18a1 1 0 0 1-1 1H13v-1.5a2 2 0 1 0-4 0V19H5.5a1 1 0 0 1-1-1v-3.5H6a2 2 0 1 0 0-4H4.5V7a1 1 0 0 1 1-1H9Z"
    {...p}
  />
);
export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconChat = (p: IconProps) => (
  <Icon d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5Z" {...p} />
);
export const IconUsers = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.8a3 3 0 0 1 0 5.4M17 14.2a5.5 5.5 0 0 1 3.5 4.8" />
  </Icon>
);
export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
);

export { Icon };
