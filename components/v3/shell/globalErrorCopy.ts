// globalErrorCopy — the three strings app/global-error.tsx shows, per locale.
//
// global-error replaces the root layout, so there is no message provider to
// read from, and importing the nine bundles would put all of them in the one
// chunk that has to load when everything else did not. These are therefore
// COPIES of `errors.error_title`, `errors.error_body` and `errors.try_again`
// from i18n/messages/<locale>.json. app/errorPages.test.tsx fails when a
// bundle and this table disagree: change the bundle, then this.

import type { RoboLocale } from '../../../lib/localeConfig';

export interface GlobalErrorCopy {
  title: string;
  body: string;
  tryAgain: string;
}

export const GLOBAL_ERROR_COPY: Record<RoboLocale, GlobalErrorCopy> = {
  en: {
    title: 'Something on this page failed to load',
    body: 'Nothing you saved was lost. Try again, and if it keeps failing, reload the page.',
    tryAgain: 'Try again',
  },
  zh: {
    title: '这个页面上有内容没有加载出来',
    body: '你保存过的东西一样都没丢。请重试；如果一直失败，请刷新页面。',
    tryAgain: '重试',
  },
  'zh-TW': {
    title: '這個頁面上有內容沒有載入出來',
    body: '你儲存過的東西一樣都沒少。請重試；如果一直失敗，請重新整理頁面。',
    tryAgain: '重試',
  },
  ja: {
    title: 'このページの一部を読み込めませんでした',
    body: '保存した内容は消えていません。もう一度試して、それでも失敗する場合はページを再読み込みしてください。',
    tryAgain: 'もう一度試す',
  },
  ko: {
    title: '이 페이지의 일부를 불러오지 못했어요',
    body: '저장한 내용은 잃어버리지 않았어요. 다시 시도해 보고, 계속 안 되면 페이지를 새로고침해 주세요.',
    tryAgain: '다시 시도',
  },
  es: {
    title: 'Algo de esta página no se cargó',
    body: 'No se perdió nada de lo que guardaste. Inténtalo otra vez y, si sigue fallando, recarga la página.',
    tryAgain: 'Reintentar',
  },
  fr: {
    title: 'Un élément de cette page n’a pas pu se charger',
    body: 'Rien de ce que tu as enregistré n’est perdu. Réessaie, et si ça continue, recharge la page.',
    tryAgain: 'Réessayer',
  },
  pt: {
    title: 'Algo desta página não carregou',
    body: 'Nada do que você salvou foi perdido. Tente de novo e, se continuar falhando, recarregue a página.',
    tryAgain: 'Tentar de novo',
  },
  de: {
    title: 'Etwas auf dieser Seite konnte nicht geladen werden',
    body: 'Nichts von dem, was du gespeichert hast, ist verloren. Versuch es erneut, und wenn es weiter scheitert, lade die Seite neu.',
    tryAgain: 'Erneut versuchen',
  },
};
