export const meta = {
  name: 'jobright-i18n-translate',
  description: 'Translate the missing strings into the other locales in validated chunks (one translator per chunk)',
  phases: [
    { title: 'Translate', detail: 'one translator per chunk; self-validated against the EN structure' },
  ],
}
const ROOT = '/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone'
const REGISTER = {
  'zh': 'Simplified Chinese for mainland readers (also GoApply\'s primary language). Direct modern 你; concise, concrete, no marketing fluff. Use 简历, 职位, 申请, 面试, 匹配度/契合度 consistently with the existing zh.json. NEVER the Taiwan terms 履歷, 職缺, 面議. Where the English says Alipay write 支付宝.',
  'zh-TW': 'Traditional Chinese for TAIWAN (not converted Simplified). 你. Taiwan vocabulary is mandatory: 履歷, 職缺, 薪資, 面議, 應徵, 線上應徵, 校園徵才, 求職信, 自傳, 筆試, 測驗, 內部推薦, 錄取通知, 應徵進度, 符合度, 一鍵填表, 個人檔案, 帳號, 登入, 設定, 上傳, 檔案, 預設, 使用者, 資料/資訊, 影片, 軟體, 專案, 遠端. NEVER mainland terms: 简历/簡歷, 岗位/崗位, 网申, 校招, 视频/視頻, 软件/軟件, 信息, 默认/默認, 用户/用戶, 登录/登錄, 质量/質量, 网络/網絡, 账号/賬號, 数据/數據. Read CN_TW_LAUNCH_PLAN.md §9 and scripts/check-zh-variants.mjs.',
  'ja': 'Japanese, です/ます polite and dignified (casual English reads childish). 履歴書・職務経歴書, 求人, 応募, 面接, 適合度. Never write 自動応募 or 代わりに応募 (the product never applies for the user).',
  'ko': 'Korean, 해요체 polite. 이력서, 자기소개서, 채용 공고, 지원, 면접, 적합도. Never write 자동 지원 or 대신 지원 (the product never applies for the user).',
  'es': 'Spanish, tú, LatAm-neutral (no voseo, no vosotros). currículum/CV, vacante/oferta, postulación/postular, entrevista, ajuste. Never imply the product applies for the user.',
  'fr': 'French, modern-informal tu, never sloppy. CV, offre, candidature/postuler, entretien, adéquation. Never imply the product applies for the user.',
  'pt': 'Brazilian Portuguese, você, warm-direct. currículo, vaga, candidatura/candidatar-se, entrevista, aderência/compatibilidade. Never imply the product applies for the user.',
  'de': 'German, du (young product), no Beamtendeutsch. Lebenslauf, Stelle/Stellenanzeige, Bewerbung/bewerben, Vorstellungsgespräch, Passung. Use "KI" for AI in running text. Exact strings: credits.cancelPage.footerLink must be exactly "Verträge hier kündigen" and credits.cancelPage.confirm exactly "Jetzt kündigen". Never imply the product applies for the user.',
}
const BUNDLE = { web: (l) => `i18n/messages/${l}.json`, email: (l) => `server/src/i18n/email/${l}.json`, extension: (l) => `extension/src/i18n/${l}.json` }

function prompt(l, t, c) {
  const inP = `${ROOT}/.i18n-work/in/${t}/${l}/${c}.json`
  const outP = `${ROOT}/.i18n-work/out/${t}/${l}/${c}.json`
  return `You are a professional product localizer translating UI strings for RoboApply / GoApply (an AI job-search copilot: job feed with fit explanations, resume tailoring and checks, cover letters, application tracker, interview practice, an Assistant, a form-filling browser extension). Target locale: ${l}. Bundle kind: ${t}.

INPUT (English source, nested JSON): ${inP}
OUTPUT (write this file with the Write tool; create nothing else): ${outP}
Do NOT edit any other file. Do not commit. Do not run servers.

REGISTER for ${l}: ${REGISTER[l]}

CONSISTENCY: before translating, read the existing translated bundle ${ROOT}/${BUNDLE[t](l)} (if it exists) and reuse its established terms for the product's nouns and the fit tiers (Great fit / Good fit / Possible / Unlikely), navigation labels and buttons. English source of truth for meaning: ${ROOT}/${BUNDLE[t]('en')}.

HARD RULES:
1. Output JSON has EXACTLY the same key structure as the input — every leaf translated, no key added, removed or renamed.
2. ICU MessageFormat must stay valid with the SAME argument names: keep {name}, {count, plural, one {…} other {…}}, {x, select, …} structures; translate only the human text inside branches; add plural categories only if the language needs them and keep "other". ${t === 'extension' ? 'This bundle supports ONLY simple {name} substitution — no plural/select.' : ''}${t === 'email' ? ' Email bundle supports only {name}, plural and select.' : ''} Rich-text tags like <b>…</b> or <link>…</link> keep their tag names.
3. %BRAND% and %OTHER_BRAND% are placeholders for the product name: keep each exactly as written and the same number of times as in English. Never write the literal words RoboApply or GoApply (unless the English string itself contains them).
4. Copy verbatim: values with no words ({min}–{max}, —, +86, 985, 211, 03/2024, © {year} %BRAND%), brand/product names (Google, LINE, WeChat, LinkedIn, GitHub, Pro, RoboHire, GoHire as source names), URLs and placeholders like XXXXX-XXXXX. Keep ASCII: AI (except German KI in prose), PDF, CSV, STAR, HR, UTC, QR, URL, GPA, IELTS/TOEFL/CET, USD/CNY/NT$, and keyboard shortcuts (Ctrl+J, ⌘J, Shift+Enter).
5. HONESTY (binding): the product NEVER submits an application. Lines such as "You submit every application yourself", "Open application", "Apply on company site", "Fill this form" must keep that literal meaning — never translate into anything like auto-apply, apply for you, one-click apply, or "we send it". Never add the idea "unlimited", "guaranteed" or any number that is not in the English.
6. Banned vocabulary: read the BANNED list in ${ROOT}/scripts/check-copy.mjs and avoid every term listed for locale "${l}" (and the all-locale ones). Plain language: no idioms, no slang, no wordplay, no humour on errors, money or rejection.
7. Natural, native UI copy — concise like the English, appropriate for buttons/labels/errors; not a word-for-word gloss. Keep sentence-final punctuation style native to the locale; keep leading/trailing spaces and line breaks.

SELF-CHECK (required before you finish): run
  cd ${ROOT} && node docs/jobright-clone/orch/apply-translations.mjs "${ROOT}" .i18n-work/out --dry-run --only ${t}/${l}/${c}.json
It must print "accepted <n>, rejected 0" with n = the number of leaves in your input. Fix every rejected leaf (ICU args, %BRAND% count, literal brand) and re-run until rejected is 0. Also confirm with a short script that the set of leaf paths in your output equals the input's.
Return one line: "<locale> <bundle> <chunk>: accepted N, rejected 0" plus any string you were unsure about (path + why).`
}

const items = []
if (Array.isArray(args.items)) items.push(...args.items)
else for (const t of ['web', 'email', 'extension']) for (const [l, n] of Object.entries(args[t])) for (let i = 1; i <= n; i++) items.push({ l, t, c: String(i).padStart(2, '0') })
log(`translating ${items.length} chunks`)
// args.model (optional): a cheaper model for this mechanical stage. A translator that dies (network) is tried again once.
const OPTS = (it, n) => ({ label: `tr:${it.l}:${it.t}:${it.c}${n > 1 ? '#' + n : ''}`, phase: 'Translate', ...(args.model ? { model: args.model } : {}) })
const results = await pipeline(items, async (it) => {
  let r = await agent(prompt(it.l, it.t, it.c), OPTS(it, 1))
  if (!r) r = await agent(prompt(it.l, it.t, it.c), OPTS(it, 2))
  return r ? { ...it, r } : null
})
const done = results.filter(Boolean)
return { total: items.length, done: done.length, missing: items.filter(i => !done.find(d => d.l === i.l && d.t === i.t && d.c === i.c)), notes: done.map(d => `${d.l}/${d.t}/${d.c}: ${String(d.r || '').slice(0, 300)}`) }
