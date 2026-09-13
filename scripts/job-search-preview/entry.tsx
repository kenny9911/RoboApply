import '../design-preview/network';
import { useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from '../../app/providers';
import AuthLayout from '../../app/(auth)/layout';
import JobSearchPage from '../../app/(auth)/job-search/page';
import ApiKeysPage from '../../app/(auth)/job-search/developers/page';
import DevelopersPage from '../../app/developers/job-search/page';
import { loadMessages } from '../../lib/i18n';
import { isLocale } from '../../lib/localeConfig';
import { usePathname, usePreviewLocation } from '../design-preview/navigation';
import '../../app/globals.css';
import '../design-preview/preview.css';

const initialTheme = new URLSearchParams(window.location.search).get('theme');
if (initialTheme === 'dark' || initialTheme === 'light') window.localStorage.setItem('roboapply:theme:v4', JSON.stringify({ theme: initialTheme }));

function Preview() {
  const path = usePathname();
  const location = usePreviewLocation();
  const locale = useMemo(() => {
    const candidate = new URLSearchParams(window.location.search).get('locale');
    return candidate && isLocale(candidate) ? candidate : 'en';
  }, [location]);
  document.documentElement.lang = locale;
  let page: ReactNode;
  if (path === '/developers/job-search') page = <DevelopersPage />;
  else if (path === '/job-search/developers') page = <AuthLayout><ApiKeysPage /></AuthLayout>;
  else page = <AuthLayout><JobSearchPage /></AuthLayout>;
  return <Providers locale={locale} messages={loadMessages(locale)}>{page}</Providers>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
