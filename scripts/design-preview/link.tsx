import { forwardRef, type AnchorHTMLAttributes } from 'react';
import { navigate } from './navigation';

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string | { pathname?: string; query?: Record<string, string>; hash?: string };
  prefetch?: boolean | null;
  replace?: boolean;
  scroll?: boolean;
  locale?: string;
};
export default forwardRef<HTMLAnchorElement, Props>(function PreviewLink({ href, replace, prefetch: _prefetch, scroll: _scroll, locale: _locale, onClick, ...props }, ref) {
  const target = typeof href === 'string' ? href : `${href.pathname ?? ''}${href.query ? `?${new URLSearchParams(href.query)}` : ''}${href.hash ?? ''}`;
  return <a {...props} href={target} ref={ref} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    navigate(target, replace);
  }} />;
});
