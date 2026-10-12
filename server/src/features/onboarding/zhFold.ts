// server/src/features/onboarding/zhFold.ts — Traditional Chinese input for the
// job-title typeahead (onboarding O2).
//
// The role taxonomy (features/jobs/taxonomy) carries English and Simplified
// Chinese phrases only. A Taiwan or Hong Kong user types Traditional
// characters ("後端", "軟體工程師"), which matched nothing. Until the taxonomy
// has Traditional phrases of its own, the typeahead also searches a
// Simplified reading of the query:
//   1. Taiwan wording → the mainland word the taxonomy uses (軟體 → 软件);
//   2. each Traditional character → its Simplified form.
//
// This only widens what a QUERY can find. Nothing here is shown to the user
// and no label is converted with it: a character map cannot produce correct
// Traditional wording, so zh-TW labels stay as the taxonomy returns them.
//
// The character table covers the characters the taxonomy's Chinese phrases
// use (the only ones a fold can help to match). A character outside it is
// left as typed.

/** Taiwan / Hong Kong wording → the mainland wording used by the taxonomy phrases (longest first). */
const WORDS: ReadonlyArray<readonly [string, string]> = [
  ['人工智慧', '人工智能'],
  ['使用者', '用户'],
  ['伺服器', '服务器'],
  ['演算法', '算法'],
  ['軟體', '软件'],
  ['硬體', '硬件'],
  ['韌體', '固件'],
  ['資料', '数据'],
  ['程式', '程序'],
  ['行銷', '营销'],
  ['專案', '项目'],
  ['網路', '网络'],
  ['資訊', '信息'],
  ['品質', '质量'],
  ['介面', '界面'],
  ['數位', '数字'],
  ['全端', '全栈'],
  ['維運', '运维'],
  ['影片', '视频'],
];

/** Traditional → Simplified, as pairs (Traditional first). */
const PAIRS =
  '與与專专業业東东個个臨临為为爲为習习書书雲云亞亚產产産产倉仓儀仪價价眾众衆众優优夥伙會会傳传體体儲储兒儿關关內内冊册寫写決决劃划創创製制劑剂劇剧辦办務务動动勞劳區区醫医協协單单廠厂廳厅壓压廚厨發发臺台號号後后員员諮咨響响園园國国圖图場场塊块聲声處处備备復复複复頭头學学寶宝實实審审對对尋寻導导佈布師师帶带並并併并廣广庫库應应開开強强錄录態态總总戲戏戰战戶户執执護护報报擬拟據据攝摄數数術术機机權权構构櫃柜標标棧栈檔档橋桥檢检氣气氬氩匯汇彙汇漢汉測测濟济滲渗遊游點点熱热獵猎貓猫環环現现電电畫画療疗監监盤盘碼码礎础稅税穩稳筆笔築筑籌筹類类係系繫系紅红約约級级紀纪納纳線线綫线練练組组經经結结給给絡络統统績绩續续維维綜综編编網网職职聯联藝艺蘋苹薦荐藥药營营蝕蚀裝装觀观規规視视覺觉計计訓训記记講讲訟讼設设證证評评識识詐诈訴诉診诊詞词譯译試试話话詢询語语課课調调負负財财責责賬账帳账貨货質质購购貸贷貿贸費费賃赁資资車车軟软輔辅輯辑輸输達达運运選选遜逊遞递採采錢钱銑铣銀银鋪铺鏈链銷销鏡镜長长門门問问間间聞闻隊队際际險险隱隐頁页項项顧顾預预頻频風风飛飞飲饮馬马駛驶駕驾驗验鴻鸿';

const CHARS: ReadonlyMap<string, string> = (() => {
  const chars = [...PAIRS];
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < chars.length; i += 2) map.set(chars[i]!, chars[i + 1]!);
  return map;
})();

/** True when the text holds a Han character. */
export function hasHan(text: string): boolean {
  return /[㐀-䶿一-鿿]/.test(text);
}

/**
 * The Simplified reading of a query: the same string when nothing changes
 * (Latin text, or a query already in Simplified characters).
 */
export function foldToSimplified(query: string): string {
  if (!hasHan(query)) return query;
  let out = query;
  for (const [tw, cn] of WORDS) if (out.includes(tw)) out = out.split(tw).join(cn);
  let folded = '';
  for (const ch of out) folded += CHARS.get(ch) ?? ch;
  return folded;
}
