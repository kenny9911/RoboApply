// lib/auth/inAppBrowser.ts — F-ONB-11 in-app browser guard.
//
// Google (and LINE) refuse OAuth inside many social apps' embedded webviews
// ("disallowed_useragent"). Inside LinkedIn, Instagram, TikTok, Facebook or
// WeChat we replace the provider buttons with "Open in your browser" and a
// copy-link button; email sign-up keeps working everywhere.

export type InAppBrowser = 'linkedin' | 'instagram' | 'tiktok' | 'facebook' | 'wechat';

const PATTERNS: Array<[RegExp, InAppBrowser]> = [
  [/LinkedInApp/i, 'linkedin'],
  [/Instagram/i, 'instagram'],
  [/musical_ly|BytedanceWebview|TikTok|Bytedance/i, 'tiktok'],
  [/FBAN|FBAV|FB_IAB|FBIOS|\[FB/i, 'facebook'],
  [/MicroMessenger/i, 'wechat'],
];

/** The in-app browser this user agent belongs to, or null for a normal browser. */
export function detectInAppBrowser(userAgent: string | null | undefined): InAppBrowser | null {
  const ua = userAgent ?? '';
  for (const [re, id] of PATTERNS) if (re.test(ua)) return id;
  return null;
}
