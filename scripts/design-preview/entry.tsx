import './network';
import { Component, Suspense, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from '../../app/providers';
import AuthLayout from '../../app/(auth)/layout';
import JobsPage from '../../app/(auth)/jobs/page';
import ResumePage from '../../app/(auth)/resume/page';
import ResumeEditorPage from '../../app/(auth)/resume/[id]/page';
import ApplicationsPage from '../../app/(auth)/applications/page';
import PracticePage from '../../app/(auth)/practice/page';
import PracticeReportPage from '../../app/(auth)/practice/[id]/report/page';
import PracticeLivePage from '../../app/(auth)/practice/[id]/page';
import SettingsPage from '../../app/(auth)/settings/page';
import { loadMessages } from '../../lib/i18n';
import { isLocale, LOCALE_COOKIE } from '../../lib/localeConfig';
import { usePathname, usePreviewLocation, navigate } from './navigation';
import '../../app/globals.css';
import './preview.css';

class PreviewBoundary extends Component<{ children: ReactNode; route: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(previous: { route: string }) {
    if (previous.route !== this.props.route && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) return <pre className="preview-error">Preview rendering error: {this.state.error.message}</pre>;
    return this.props.children;
  }
}

function Preview() {
  const path = usePathname();
  const location = usePreviewLocation();
  const locale = useMemo(() => {
    const cookie = document.cookie.split('; ').find((item) => item.startsWith(`${LOCALE_COOKIE}=`))?.split('=')[1];
    const query = new URLSearchParams(window.location.search).get('locale');
    const candidate = query ?? (cookie ? decodeURIComponent(cookie) : 'en');
    return isLocale(candidate) ? candidate : 'en';
  }, [location]);
  document.documentElement.lang = locale;
  const editorId = path.startsWith('/resume/') ? path.split('/')[2] : null;
  const params = useMemo(() => Promise.resolve({ id: editorId ?? 'cm_rv_base' }), [editorId]);
  const reportParams = useMemo(() => Promise.resolve({ id: 'ie_preview' }), []);
  let page: ReactNode;
  if (path === '/jobs' || path === '/') page = <JobsPage />;
  else if (path === '/resume') page = <ResumePage />;
  else if (editorId) page = <ResumeEditorPage params={params} />;
  else if (path === '/applications') page = <ApplicationsPage />;
  else if (path === '/practice/report') page = <PracticeReportPage params={reportParams} />;
  else if (path === '/practice/live') page = <PracticeLivePage params={reportParams} />;
  else if (path === '/practice') page = <PracticePage />;
  else if (path === '/settings') page = <SettingsPage />;
  else page = <div className="preview-error">This page is not part of the local preview. <button onClick={() => navigate('/jobs')}>Return to jobs</button></div>;
  return <Providers locale={locale} messages={loadMessages(locale)}><PreviewBoundary route={path}><AuthLayout><Suspense fallback={<p>Loading example data…</p>}>{page}</Suspense></AuthLayout></PreviewBoundary></Providers>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
