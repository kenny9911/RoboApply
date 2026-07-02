// Pages Router _app. The Pages Router subtree is only used for 404/500
// shadow pages — Next.js requires _app + _error to exist when /pages/ has
// any TSX. We render the child page with no extra wrapper.

import type { AppProps } from 'next/app';

export default function PagesApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
