// backend/src/roboapply/lib/billingEmails.ts
//
// Locale-aware HTML email templates for RoboApply billing lifecycle emails:
//   • Renewal reminder (T-5d before the monthly plan lapses).
//   • Friday "prep for next week's interviews" engagement nudge.
//
// Four languages (en / zh / zh-TW / ja). Plain, inline-styled HTML (email
// clients strip <style>); no external assets. Returns { subject, html }.

export type RoboEmailLocale = 'en' | 'zh' | 'zh-TW' | 'ja';

const ACCENT = '#5b5bd6';

function shell(bodyHtml: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <div style="font-size:20px;font-weight:700;color:${ACCENT};margin-bottom:24px;">RoboApply</div>
      ${bodyHtml}
    </div>
    <div style="text-align:center;color:#9aa0aa;font-size:12px;margin-top:20px;line-height:1.6;">${footer}</div>
  </div></body></html>`;
}

function button(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:10px;font-size:15px;">${label}</a>`;
}

function fmtDate(iso: string, locale: RoboEmailLocale): string {
  try {
    const map: Record<RoboEmailLocale, string> = { en: 'en-US', zh: 'zh-CN', 'zh-TW': 'zh-TW', ja: 'ja-JP' };
    return new Date(iso).toLocaleDateString(map[locale], { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  } catch {
    return iso.slice(0, 10);
  }
}

// ─── Renewal reminder ─────────────────────────────────────────────────────────

export function renderRenewalEmail(input: {
  locale: RoboEmailLocale;
  planLabel: string; // 'Starter' | 'Growth'
  periodEndIso: string;
  manualRenewal: boolean; // Alipay/CN monthly pass → must re-purchase
  credits: number;
  ctaUrl: string;
}): { subject: string; html: string } {
  const { locale, planLabel, periodEndIso, manualRenewal, credits, ctaUrl } = input;
  const date = fmtDate(periodEndIso, locale);

  const T: Record<RoboEmailLocale, { subject: string; h: string; auto: string; manual: string; credits: string; cta: string; footer: string }> = {
    en: {
      subject: manualRenewal
        ? `Your RoboApply ${planLabel} plan expires in 5 days`
        : `Your RoboApply ${planLabel} plan renews in 5 days`,
      h: manualRenewal ? `Your plan expires soon` : `Your plan renews soon`,
      auto: `Your <b>${planLabel}</b> plan renews automatically on <b>${date}</b>. No action needed — your mock-interview credits will refresh.`,
      manual: `Your <b>${planLabel}</b> monthly pass expires on <b>${date}</b>. Renew now to keep your mock-interview credits without interruption.`,
      credits: `You currently have <b>${credits}</b> mock-interview credit${credits === 1 ? '' : 's'} remaining.`,
      cta: manualRenewal ? 'Renew now' : 'Manage subscription',
      footer: 'You receive billing reminders because you have an active RoboApply plan.',
    },
    zh: {
      subject: manualRenewal ? `您的 RoboApply ${planLabel} 套餐将在 5 天后到期` : `您的 RoboApply ${planLabel} 套餐将在 5 天后续订`,
      h: manualRenewal ? `您的套餐即将到期` : `您的套餐即将续订`,
      auto: `您的 <b>${planLabel}</b> 套餐将于 <b>${date}</b> 自动续订，无需操作，模拟面试额度将自动刷新。`,
      manual: `您的 <b>${planLabel}</b> 月度套餐将于 <b>${date}</b> 到期。立即续订以继续使用模拟面试额度。`,
      credits: `您当前还剩 <b>${credits}</b> 个模拟面试额度。`,
      cta: manualRenewal ? '立即续订' : '管理订阅',
      footer: '您收到此账单提醒，是因为您拥有有效的 RoboApply 套餐。',
    },
    'zh-TW': {
      subject: manualRenewal ? `您的 RoboApply ${planLabel} 方案將在 5 天後到期` : `您的 RoboApply ${planLabel} 方案將在 5 天後續訂`,
      h: manualRenewal ? `您的方案即將到期` : `您的方案即將續訂`,
      auto: `您的 <b>${planLabel}</b> 方案將於 <b>${date}</b> 自動續訂，無需操作，模擬面試點數將自動刷新。`,
      manual: `您的 <b>${planLabel}</b> 月度方案將於 <b>${date}</b> 到期。立即續訂以繼續使用模擬面試點數。`,
      credits: `您目前還剩 <b>${credits}</b> 個模擬面試點數。`,
      cta: manualRenewal ? '立即續訂' : '管理訂閱',
      footer: '您收到此帳單提醒，是因為您擁有有效的 RoboApply 方案。',
    },
    ja: {
      subject: manualRenewal ? `RoboApply ${planLabel} プランは5日後に期限切れになります` : `RoboApply ${planLabel} プランは5日後に更新されます`,
      h: manualRenewal ? `プランの有効期限が近づいています` : `プランがまもなく更新されます`,
      auto: `<b>${planLabel}</b> プランは <b>${date}</b> に自動更新されます。操作は不要で、模擬面接クレジットが補充されます。`,
      manual: `<b>${planLabel}</b> の月間パスは <b>${date}</b> に期限切れになります。今すぐ更新して模擬面接クレジットを継続してご利用ください。`,
      credits: `現在、模擬面接クレジットが <b>${credits}</b> 件残っています。`,
      cta: manualRenewal ? '今すぐ更新' : 'サブスクリプションを管理',
      footer: 'アクティブな RoboApply プランをお持ちのため、請求のリマインダーをお送りしています。',
    },
  };
  const t = T[locale] ?? T.en;
  const body = `
    <h1 style="font-size:22px;color:#111;margin:0 0 16px;">${t.h}</h1>
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 12px;">${manualRenewal ? t.manual : t.auto}</p>
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 24px;">${t.credits}</p>
    <div style="margin:8px 0 4px;">${button(t.cta, ctaUrl)}</div>`;
  return { subject: t.subject, html: shell(body, t.footer) };
}

// ─── Friday "prep for next week" nudge ────────────────────────────────────────

export function renderFridayNudgeEmail(input: {
  locale: RoboEmailLocale;
  name: string | null;
  credits: number;
  startUrl: string;
  accountUrl: string;
}): { subject: string; html: string } {
  const { locale, name, credits, startUrl, accountUrl } = input;
  const greetName = name ? name.split(' ')[0] : '';

  const T: Record<RoboEmailLocale, { subject: string; hi: string; body: string; creditsLine: string; cta: string; footer: string }> = {
    en: {
      subject: 'Ready for next week? Practice an interview 🎯',
      hi: greetName ? `Hi ${greetName},` : 'Hi there,',
      body: 'The weekend is a great time to sharpen up. Run a quick mock interview and walk into next week ready to impress.',
      creditsLine: `You have <b>${credits}</b> mock-interview credit${credits === 1 ? '' : 's'} ready to use.`,
      cta: 'Start a mock interview',
      footer: 'You receive weekly prep nudges because you have RoboApply credits. Manage email preferences in your account.',
    },
    zh: {
      subject: '为下周做好准备了吗？练习一场面试 🎯',
      hi: greetName ? `${greetName}，您好：` : '您好：',
      body: '周末是提升自己的好时机。来一场快速模拟面试，让您在下周自信出击、脱颖而出。',
      creditsLine: `您还有 <b>${credits}</b> 个模拟面试额度可以使用。`,
      cta: '开始模拟面试',
      footer: '您拥有 RoboApply 额度，因此每周会收到练习提醒。可在账户中管理邮件偏好。',
    },
    'zh-TW': {
      subject: '為下週做好準備了嗎？練習一場面試 🎯',
      hi: greetName ? `${greetName}，您好：` : '您好：',
      body: '週末是提升自己的好時機。來一場快速模擬面試，讓您在下週自信出擊、脫穎而出。',
      creditsLine: `您還有 <b>${credits}</b> 個模擬面試點數可以使用。`,
      cta: '開始模擬面試',
      footer: '您擁有 RoboApply 點數，因此每週會收到練習提醒。可在帳戶中管理郵件偏好。',
    },
    ja: {
      subject: '来週の準備はできていますか？面接を練習しましょう 🎯',
      hi: greetName ? `${greetName} さん、` : 'こんにちは、',
      body: '週末は実力を磨く絶好の機会です。模擬面接をさっと行って、来週に自信を持って臨みましょう。',
      creditsLine: `模擬面接クレジットが <b>${credits}</b> 件ご利用いただけます。`,
      cta: '模擬面接を始める',
      footer: 'RoboApply クレジットをお持ちのため、毎週の練習リマインダーをお送りしています。メール設定はアカウントで管理できます。',
    },
  };
  const t = T[locale] ?? T.en;
  const body = `
    <p style="font-size:15px;color:#111;margin:0 0 12px;">${t.hi}</p>
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 12px;">${t.body}</p>
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 24px;">${t.creditsLine}</p>
    <div style="margin:8px 0 4px;">${button(t.cta, startUrl)}</div>`;
  const footer = `${t.footer} &middot; <a href="${accountUrl}" style="color:#9aa0aa;">${
    locale === 'en' ? 'Preferences' : locale === 'ja' ? '設定' : '偏好設定'
  }</a>`;
  return { subject: t.subject, html: shell(body, footer) };
}
