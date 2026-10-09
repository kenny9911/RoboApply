// /bind-phone — GoApply: add a verified phone number after WeChat sign-in
// (TASK_PLAN.md WP-11; CN-L-08). AI features answer 403
// phone_binding_required until a number is bound. Renders inside the (public)
// sign-in layout; signed-out visitors are sent to /login first.

import type { Metadata } from 'next';

import { BindPhoneCard } from '../../../components/features/auth-cn';

export const metadata: Metadata = { robots: { index: false, follow: false } };

function first(v: string | string[] | undefined): string | null {
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

export default async function BindPhonePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <BindPhoneCard next={first(sp.next)} />;
}
