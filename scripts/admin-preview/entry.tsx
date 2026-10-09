import '../design-preview/network';
import { Component, Suspense, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from '../../app/providers';
import AuthLayout from '../../app/(auth)/layout';
import AdminPage from '../../app/(auth)/admin/page';
import AdminUserDetailPage from '../../app/(auth)/admin/users/[userId]/page';
import AdminSessionDetailPage from '../../app/(auth)/admin/sessions/[sessionId]/page';
import { loadMessages } from '../../lib/i18n';
import { isLocale } from '../../lib/localeConfig';
import { usePathname, usePreviewLocation } from '../design-preview/navigation';
import '../../app/globals.css';
import '../design-preview/preview.css';

const initialTheme = new URLSearchParams(window.location.search).get('theme');
if (initialTheme === 'dark' || initialTheme === 'light') window.localStorage.setItem('roboapply:theme:v4', JSON.stringify({ theme: initialTheme }));

class PreviewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <pre className="preview-error">Preview rendering error: {this.state.error.message}</pre> : this.props.children; }
}

function Preview() {
  const path = usePathname();
  const location = usePreviewLocation();
  const locale = useMemo(() => {
    const candidate = new URLSearchParams(window.location.search).get('locale');
    return candidate && isLocale(candidate) ? candidate : 'en';
  }, [location]);
  document.documentElement.lang = locale;
  const userId = path.startsWith('/admin/users/') ? decodeURIComponent(path.split('/')[3]) : null;
  const sessionId = path.startsWith('/admin/sessions/') ? decodeURIComponent(path.split('/')[3]) : null;
  const userParams = useMemo(() => Promise.resolve({ userId: userId ?? 'preview-user-01' }), [userId]);
  const sessionParams = useMemo(() => Promise.resolve({ sessionId: sessionId ?? 'preview-session-01' }), [sessionId]);
  const page = userId ? <AdminUserDetailPage params={userParams} /> : sessionId ? <AdminSessionDetailPage params={sessionParams} /> : <AdminPage />;
  return <Providers locale={locale} messages={loadMessages(locale)}><PreviewBoundary key={path}><AuthLayout><Suspense fallback={<p>Loading example data…</p>}>{page}</Suspense></AuthLayout></PreviewBoundary></Providers>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
