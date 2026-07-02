import type { BrandConfig } from '../brands/types.js';

/**
 * Brand-aware, 8-locale signup email-confirmation renderer.
 *
 * Mirrors the table-less inline-style approach of lib/evaluationCompletionEmail.ts
 * and the existing forgot-password email, but is multipart (text + HTML) for
 * better inbox placement and fully brand-aware (RoboHire vs GoHire — name,
 * colors, support email, link host). See
 * docs/design-spec-signup-email-verification.md.
 */

export interface VerificationEmailStrings {
  subject: string;
  heading: string;
  body: string;       // may contain {{brandName}}
  button: string;
  fallback: string;   // "Or paste this link into your browser:"
  expiry: string;     // may contain {{hours}}
  ignore: string;
  support: string;    // may contain {{supportEmail}}
}

// Keep keys in sync with the 8 supported UI locales (en, zh, zh-TW, ja, es, fr, pt, de).
const STRINGS: Record<string, VerificationEmailStrings> = {
  en: {
    subject: 'Confirm your email to activate your {{brandName}} account',
    heading: 'Confirm your email',
    body: "Welcome to {{brandName}}! Confirm this email address to activate your account and start hiring with AI. Click the button below — it only takes a second.",
    button: 'Verify email address',
    fallback: 'Or paste this link into your browser:',
    expiry: 'This link is single-use and expires in {{hours}} hours.',
    ignore: "If you didn't create an account, someone may have typed your address by mistake — you can safely ignore this email.",
    support: 'Need help? Contact us at {{supportEmail}}.',
  },
  zh: {
    subject: '确认邮箱以激活您的 {{brandName}} 账户',
    heading: '确认您的邮箱',
    body: '欢迎使用 {{brandName}}！请确认此邮箱地址以激活您的账户，开启 AI 智能招聘。点击下方按钮即可完成，只需一秒。',
    button: '验证邮箱地址',
    fallback: '或将以下链接粘贴到浏览器中打开：',
    expiry: '此链接仅可使用一次，将在 {{hours}} 小时后失效。',
    ignore: '如果您没有注册账户，可能是有人误输入了您的邮箱地址，您可以放心忽略这封邮件。',
    support: '需要帮助？请联系 {{supportEmail}}。',
  },
  'zh-TW': {
    subject: '確認電子郵件以啟用您的 {{brandName}} 帳戶',
    heading: '確認您的電子郵件',
    body: '歡迎使用 {{brandName}}！請確認此電子郵件地址以啟用您的帳戶，開啟 AI 智慧招募。點擊下方按鈕即可完成，只需一秒。',
    button: '驗證電子郵件地址',
    fallback: '或將以下連結貼到瀏覽器中開啟：',
    expiry: '此連結僅可使用一次，將在 {{hours}} 小時後失效。',
    ignore: '如果您沒有註冊帳戶，可能是有人誤輸入了您的電子郵件地址，您可以放心忽略這封郵件。',
    support: '需要協助？請聯絡 {{supportEmail}}。',
  },
  ja: {
    subject: 'メールアドレスを確認して {{brandName}} アカウントを有効化してください',
    heading: 'メールアドレスの確認',
    body: '{{brandName}} へようこそ！このメールアドレスを確認してアカウントを有効化し、AI採用を始めましょう。下のボタンをクリックするだけで完了します。',
    button: 'メールアドレスを確認',
    fallback: 'または、以下のリンクをブラウザに貼り付けてください：',
    expiry: 'このリンクは一度のみ有効で、{{hours}} 時間後に失効します。',
    ignore: 'アカウントを作成した覚えがない場合は、誰かが誤ってあなたのアドレスを入力した可能性があります。このメールは無視して構いません。',
    support: 'お困りですか？{{supportEmail}} までご連絡ください。',
  },
  es: {
    subject: 'Confirma tu correo para activar tu cuenta de {{brandName}}',
    heading: 'Confirma tu correo electrónico',
    body: '¡Bienvenido a {{brandName}}! Confirma esta dirección de correo para activar tu cuenta y empezar a contratar con IA. Haz clic en el botón de abajo: solo toma un segundo.',
    button: 'Verificar correo electrónico',
    fallback: 'O pega este enlace en tu navegador:',
    expiry: 'Este enlace es de un solo uso y caduca en {{hours}} horas.',
    ignore: 'Si no creaste una cuenta, es posible que alguien haya escrito tu dirección por error. Puedes ignorar este correo con seguridad.',
    support: '¿Necesitas ayuda? Escríbenos a {{supportEmail}}.',
  },
  fr: {
    subject: 'Confirmez votre e-mail pour activer votre compte {{brandName}}',
    heading: 'Confirmez votre e-mail',
    body: "Bienvenue sur {{brandName}} ! Confirmez cette adresse e-mail pour activer votre compte et commencer à recruter avec l'IA. Cliquez sur le bouton ci-dessous — cela ne prend qu'une seconde.",
    button: "Vérifier l'adresse e-mail",
    fallback: 'Ou collez ce lien dans votre navigateur :',
    expiry: 'Ce lien est à usage unique et expire dans {{hours}} heures.',
    ignore: "Si vous n'avez pas créé de compte, quelqu'un a peut-être saisi votre adresse par erreur — vous pouvez ignorer cet e-mail en toute sécurité.",
    support: "Besoin d'aide ? Contactez-nous à {{supportEmail}}.",
  },
  pt: {
    subject: 'Confirme seu e-mail para ativar sua conta {{brandName}}',
    heading: 'Confirme seu e-mail',
    body: 'Bem-vindo ao {{brandName}}! Confirme este endereço de e-mail para ativar sua conta e começar a contratar com IA. Clique no botão abaixo — leva apenas um segundo.',
    button: 'Verificar endereço de e-mail',
    fallback: 'Ou cole este link no seu navegador:',
    expiry: 'Este link é de uso único e expira em {{hours}} horas.',
    ignore: 'Se você não criou uma conta, alguém pode ter digitado seu endereço por engano — você pode ignorar este e-mail com segurança.',
    support: 'Precisa de ajuda? Fale conosco em {{supportEmail}}.',
  },
  de: {
    subject: 'Bestätigen Sie Ihre E-Mail, um Ihr {{brandName}}-Konto zu aktivieren',
    heading: 'Bestätigen Sie Ihre E-Mail',
    body: 'Willkommen bei {{brandName}}! Bestätigen Sie diese E-Mail-Adresse, um Ihr Konto zu aktivieren und mit KI zu rekrutieren. Klicken Sie auf die Schaltfläche unten — es dauert nur eine Sekunde.',
    button: 'E-Mail-Adresse bestätigen',
    fallback: 'Oder fügen Sie diesen Link in Ihren Browser ein:',
    expiry: 'Dieser Link ist einmalig verwendbar und läuft in {{hours}} Stunden ab.',
    ignore: 'Wenn Sie kein Konto erstellt haben, hat möglicherweise jemand Ihre Adresse versehentlich eingegeben — Sie können diese E-Mail bedenkenlos ignorieren.',
    support: 'Brauchen Sie Hilfe? Kontaktieren Sie uns unter {{supportEmail}}.',
  },
};

export function getVerificationEmailStrings(lang?: string): VerificationEmailStrings {
  if (lang && STRINGS[lang]) return STRINGS[lang];
  const base = lang?.split('-')[0];
  if (base && STRINGS[base]) return STRINGS[base];
  return STRINGS.en;
}

function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface RenderedVerificationEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render the signup confirmation email. `verifyUrl` is the fully-built,
 * brand-correct link (caller resolves the host) — e.g.
 * https://gohire.top/verify-email?token=<raw>.
 */
export function renderVerificationEmail(opts: {
  brand: BrandConfig;
  verifyUrl: string;
  lang?: string;
  ttlHours: number;
}): RenderedVerificationEmail {
  const { brand, verifyUrl, lang, ttlHours } = opts;
  const s = getVerificationEmailStrings(lang);
  const vars = {
    brandName: brand.name,
    hours: String(ttlHours),
    supportEmail: brand.supportEmail,
  };

  const subject = fill(s.subject, vars);
  const heading = fill(s.heading, vars);
  const body = fill(s.body, vars);
  const expiry = fill(s.expiry, vars);
  const ignore = fill(s.ignore, vars);
  const support = fill(s.support, vars);
  const safeUrl = escapeHtml(verifyUrl);
  const grad = `linear-gradient(135deg, ${brand.primaryColor}, ${brand.accentColor})`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; color: #46556A;">
      <div style="font-size: 20px; font-weight: 700; color: ${brand.primaryColor}; margin-bottom: 24px;">${escapeHtml(brand.name)}</div>
      <h1 style="color: #33465B; font-size: 22px; margin: 0 0 16px;">${escapeHtml(heading)}</h1>
      <p style="line-height: 1.6; font-size: 15px; margin: 0 0 24px;">${escapeHtml(body)}</p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${safeUrl}" style="display: inline-block; background: ${grad}; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 9999px; font-weight: 600; font-size: 15px;">${escapeHtml(s.button)}</a>
      </div>
      <p style="font-size: 13px; color: #6B7280; line-height: 1.6; margin: 0 0 4px;">${escapeHtml(s.fallback)}</p>
      <p style="font-size: 13px; line-height: 1.6; margin: 0 0 24px; word-break: break-all;"><a href="${safeUrl}" style="color: ${brand.primaryColor};">${safeUrl}</a></p>
      <p style="font-size: 13px; color: #6B7280; line-height: 1.6; margin: 0 0 4px;">${escapeHtml(expiry)}</p>
      <p style="font-size: 13px; color: #6B7280; line-height: 1.6; margin: 0 0 24px;">${escapeHtml(ignore)}</p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
      <p style="color: #9CA3AF; font-size: 12px; line-height: 1.6;">${escapeHtml(support)}</p>
      <p style="color: #9CA3AF; font-size: 12px;">${escapeHtml(brand.name)}${brand.tagline ? ` — ${escapeHtml(brand.tagline)}` : ''}</p>
    </div>
  `.trim();

  const text = [
    heading,
    '',
    body,
    '',
    `${s.button}: ${verifyUrl}`,
    '',
    expiry,
    ignore,
    '',
    support,
    `${brand.name}${brand.tagline ? ` — ${brand.tagline}` : ''}`,
  ].join('\n');

  return { subject, html, text };
}
