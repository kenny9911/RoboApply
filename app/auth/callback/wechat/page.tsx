// /auth/callback/wechat — where the API sends the browser after a WeChat
// round trip (TASK_PLAN.md WP-11; WECHAT_RETURN_PATH in the auth-cn
// contract). A transitional page without the app shell: it finishes the
// sign-in (or shows why it failed) and moves on to /bind-phone or `next`.

import type { Metadata } from 'next';

import { WechatReturn } from '../../../../components/features/auth-cn';

export const metadata: Metadata = { robots: { index: false, follow: false } };

function first(v: string | string[] | undefined): string | null {
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

export default async function AuthCallbackWechatPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return (
    <main>
      <WechatReturn
        params={{ result: first(sp.result), code: first(sp.code), next: first(sp.next), bind: first(sp.bind), reverify: first(sp.reverify) }}
      />
    </main>
  );
}
