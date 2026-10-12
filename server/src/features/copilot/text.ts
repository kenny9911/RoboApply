// server/src/features/copilot/text.ts — the few fixed lines the server writes
// into an Assistant reply (WP-50). They replace text the guard removed, so they
// must read in the reply's language. No first-person system copy (R-10, H21).

export type GuardLineKey = 'noSource' | 'notSubmitted' | 'restBlocked';

const LINES: Record<string, Record<GuardLineKey, string>> = {
  en: {
    noSource: 'No source found for that number.',
    notSubmitted: "Nothing was submitted for you. You apply yourself on the employer's site.",
    restBlocked: 'The rest of this reply was blocked.',
  },
  zh: {
    noSource: '未找到该数字的来源。',
    notSubmitted: '没有替你提交任何申请，申请需要你本人在招聘方网站完成。',
    restBlocked: '此回复的其余内容已被拦截。',
  },
  'zh-TW': {
    noSource: '找不到這個數字的來源。',
    notSubmitted: '沒有替你送出任何申請，申請需由你本人在招募方網站完成。',
    restBlocked: '此回覆的其餘內容已被攔截。',
  },
  ja: {
    noSource: 'この数字の出典が見つかりません。',
    notSubmitted: '応募は送信されていません。応募は企業のサイトでご自身で行います。',
    restBlocked: 'この返信の残りはブロックされました。',
  },
  ko: {
    noSource: '이 숫자의 출처를 찾을 수 없습니다.',
    notSubmitted: '대신 제출된 지원서는 없습니다. 지원은 기업 사이트에서 직접 하세요.',
    restBlocked: '이 답변의 나머지 부분은 차단되었습니다.',
  },
  es: {
    noSource: 'No se encontró una fuente para ese número.',
    notSubmitted: 'No se envió nada en tu nombre. La solicitud la envías tú en el sitio del empleador.',
    restBlocked: 'El resto de esta respuesta se bloqueó.',
  },
  fr: {
    noSource: 'Aucune source trouvée pour ce nombre.',
    notSubmitted: "Rien n'a été envoyé à votre place. Vous postulez vous-même sur le site de l'employeur.",
    restBlocked: 'La suite de cette réponse a été bloquée.',
  },
  pt: {
    noSource: 'Nenhuma fonte encontrada para esse número.',
    notSubmitted: 'Nada foi enviado em seu nome. Você se candidata no site do empregador.',
    restBlocked: 'O restante desta resposta foi bloqueado.',
  },
  de: {
    noSource: 'Für diese Zahl wurde keine Quelle gefunden.',
    notSubmitted: 'Es wurde nichts für Sie eingereicht. Sie bewerben sich selbst auf der Website des Arbeitgebers.',
    restBlocked: 'Der Rest dieser Antwort wurde blockiert.',
  },
};

/** `zh-CN` → `zh`, `zh-Hant`/`zh-TW` → `zh-TW`, `pt-BR` → `pt`; unknown → `en`. */
export function lineLocale(locale: string | null | undefined): string {
  const raw = (locale ?? '').trim();
  if (!raw) return 'en';
  const lower = raw.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'zh-hk' || lower.startsWith('zh-hant')) return 'zh-TW';
  if (lower.startsWith('zh')) return 'zh';
  const base = lower.split(/[-_]/)[0]!;
  return base in LINES ? base : 'en';
}

export function guardLine(key: GuardLineKey, locale: string | null | undefined): string {
  return LINES[lineLocale(locale)]![key];
}

/** Every replacement line (tests, and the guard's own "already replaced" check). */
export function allGuardLines(): string[] {
  return Object.values(LINES).flatMap((l) => Object.values(l));
}
