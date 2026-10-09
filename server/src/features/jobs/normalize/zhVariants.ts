// server/src/features/jobs/normalize/zhVariants.ts
//
// Taiwan-usage → mainland-usage folding for MATCHING ONLY (TW-03 / TW-09
// inventory): taxonomy v1 carries Simplified Chinese synonyms, so a Taiwan
// title such as 資深後端工程師 or 資料分析師 is folded to 资深后端工程师 /
// 数据分析师 before the dictionary match. The folded text is never stored or
// shown (zh-TW must never display Simplified text).
//
// Terms first (vocabulary differs: 軟體 → 软件, 資料 → 数据), then single
// characters. The lists cover job-title vocabulary, not general text.

const TERMS: [string, string][] = [
  ['軟體', '软件'], ['硬體', '硬件'], ['韌體', '固件'], ['資料庫', '数据库'], ['資料', '数据'], ['資訊', '信息'],
  ['網路', '网络'], ['程式', '程序'], ['專案', '项目'], ['行銷', '营销'], ['人資', '人力资源'], ['雲端', '云'],
  ['演算法', '算法'], ['介面', '界面'], ['伺服器', '服务器'], ['數位', '数字'], ['晶片', '芯片'], ['製程', '工艺'],
  ['品保', '质量保证'], ['影音', '音视频'], ['視覺', '视觉'], ['使用者', '用户'], ['機器學習', '机器学习'],
];

const CHARS: Record<string, string> = {
  資: '资', 後: '后', 發: '发', 開: '开', 師: '师', 經: '经', 產: '产', 設: '设', 計: '计', 數: '数', 據: '据',
  業: '业', 務: '务', 銷: '销', 運: '运', 營: '营', 專: '专', 員: '员', 測: '测', 試: '试', 網: '网', 絡: '络',
  構: '构', 統: '统', 體: '体', 導: '导', 製: '制', 機: '机', 學: '学', 習: '习', 備: '备', 維: '维', 護: '护',
  總: '总', 監: '监', 會: '会', 領: '领', 長: '长', 單: '单', 創: '创', 實: '实', 驗: '验', 職: '职', 區: '区',
  際: '际', 協: '协', 調: '调', 標: '标', 類: '类', 價: '价', 電: '电', 腦: '脑', 視: '视', 覺: '觉', 畫: '画',
  動: '动', 戶: '户', 關: '关', 係: '系', 財: '财', 審: '审', 稅: '税', 規: '规', 劃: '划', 處: '处', 醫: '医',
  藥: '药', 環: '环', 檢: '检', 質: '质', 證: '证', 銀: '银', 險: '险', 優: '优', 雜: '杂', 傳: '传', 編: '编',
  輯: '辑', 譯: '译', 語: '语', 戲: '戏', 遊: '游', 應: '应', 屆: '届', 儲: '储', 幹: '干', 級: '级', 階: '阶',
  線: '线', 車: '车', 輛: '辆', 鏈: '链', 採: '采', 購: '购', 庫: '库', 倉: '仓',
};

/** Fold Taiwan vocabulary and Traditional characters to mainland forms (for dictionary matching only). */
export function foldTwToCn(input: string): string {
  if (!/[㐀-鿿]/.test(input)) return input;
  let s = input;
  for (const [tw, cn] of TERMS) s = s.split(tw).join(cn);
  let out = '';
  for (const ch of s) out += CHARS[ch] ?? ch;
  return out;
}
