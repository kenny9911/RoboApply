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

export { Icon };
