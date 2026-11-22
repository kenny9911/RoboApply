'use client';

// Btn — the V3 button (.btn family). Variants: default (white pill with a
// hairline), primary (the action-colour pill), violet (the --brand-mark
// highlight with --brand-plane ink: the stronger of two adjacent calls to
// action, never a selected state), ghost (transparent). Renders
// as a <button> by default; pass `as="a"` + `href` for a link-styled button
// (used in the topbar / launch bars). Forwards an optional leading icon.
//
// Mirrors the prototype's .btn rules in styles/v3.css — class-driven so the
// accent swap (data-accent) reaches it for free.

import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type BtnVariant = 'default' | 'primary' | 'violet' | 'ghost';

const VARIANT_CLASS: Record<BtnVariant, string> = {
  default: '',
  primary: 'primary',
  violet: 'violet',
  ghost: 'ghost',
};

type CommonProps = {
  variant?: BtnVariant;
  /** Leading icon node (an Iconset glyph). */
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
};

type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
    as?: 'button';
  };

type LinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & {
    as: 'a';
    href: string;
  };

export function Btn(props: ButtonProps | LinkProps) {
  const { variant = 'default', icon, children, className } = props;
  const classes = cn('btn', VARIANT_CLASS[variant], className);

  if (props.as === 'a') {
    const { as: _as, variant: _v, icon: _i, children: _c, className: _cn, ...rest } = props;
    return (
      <a className={classes} {...rest}>
        {icon}
        {children}
      </a>
    );
  }

  const { as: _as, variant: _v, icon: _i, children: _c, className: _cn, type, ...rest } =
    props as ButtonProps;
  return (
    <button type={type ?? 'button'} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
}
