# GoApply pricing for mainland China (CNY, Alipay)

**Researched:** 2026-10-11. **Scope:** the GoApply (goapply.top) price ladder, its evidence, and the rules that shape it. **Status:** recommendation for the owner; no code was changed.

Confidence labels: **confirmed** (read on the primary page or in our code today), **likely** (secondary source, or a primary page that does not fully identify the item), **inferred** (my reasoning from the evidence).

---

## 1. Verdict

**The owner's starting ladder holds. Keep 周卡 ¥12, 月卡 ¥39, 季卡 ¥99 and the practice packs ¥29 / ¥79.** Two additions and one guardrail:

1. **Add student passes** (D5 parity; the international catalog has them, GoApply's does not): 学生月卡 ¥29, 学生季卡 ¥69.
2. **Give the GoApply catalog real default amounts** (D6: "a plan is never price not set"). Today every GoApply price comes only from `CN_PRICE_<PLANKEY>_FEN`, which is empty in `.env.example`.
3. **Guardrail on packs:** ¥29 for five 20-minute voice sessions is ¥5.80 a session. That is far below every paid comparable, and it may be at or under our own cost when GoApply falls back to the shared voice stack (D5). Measure the real cost per session before `CN_PAYMENTS_ENABLED=true`; if it is above about ¥3.5, move the packs to ¥39 / ¥99.

Two premises in the brief need correcting:

- **The "5 days before renewal" reminder is no longer in the regulation.** SAMR Order 101 (2025-03-18) deleted "五日" from Article 18 of 《网络交易监督管理办法》. The duty is now to remind "before" each renewal date, and since 2026-04-10 a second rule requires a reminder before **every** deduction (§4).
- **支付宝周期扣款 is not part of our Alipay path, and third-party sources say it has been superseded by 商家扣款.** Either needs a signed deduction agreement per user. Our existing path creates one-time orders only (§5).

Both points support the existing design: GoApply sells **non-renewing passes**.

---

## 2. What comparable products charge (2025–2026)

Method: mainland App Store listings (`apps.apple.com/cn`) fetched on 2026-10-11 are the most verifiable public price source, so they carry most of the weight. Three caveats apply to every App Store row: the page shows at most ten in-app purchases; item names do not always say what they unlock; and iOS prices can be higher than web or Android prices because of Apple's commission. Vendor sites were used where they print prices. Review articles are marked, because most of them are written by a competitor.

### 2.1 Resume builders (the closest anchor for a student's monthly card)

| Product | Prices found | Source | Confidence |
|---|---|---|---|
| 超级简历 WonderCV | 月度会员 ¥18; 1 个月会员加秘籍 ¥28; "升级会员" tiers ¥19.90 / ¥29.90 / ¥39.90 / ¥69.90 / ¥99.90; 终身会员 ¥98; single download ¥9.90 | [App Store CN](https://apps.apple.com/cn/app/id1327732591) (v4.4.5, 1 Oct) | confirmed (prices); likely (what each "升级" tier is) |
| 超级简历, complaints | A ¥28 monthly charge by password-free payment, a ¥39 monthly membership and a ¥99.9 "permanent" membership appear in 2024 complaints about refunds | [黑猫 ¥28](https://tousu.sina.com.cn/complaint/view/17372238177), [黑猫 ¥39](https://tousu.sina.com.cn/complaint/view/17372759820/), [黑猫 ¥99.9](https://tousu.sina.com.cn/complaint/view/17376184335) | likely (user-reported, 2024) |
| 知页简历 | 7 天会员 ¥12; 1 个月 ¥18 / ¥19.90; 永久会员 ¥28 / ¥29.90 / ¥39.90; 永久 + 1 次点评 ¥119 | [App Store CN](https://apps.apple.com/cn/app/id1191748979) (v3.6.33, 2024-12-24; the app has not shipped an update since, so treat as stale) | confirmed, stale |
| 职徒简历 | 1 个月 ¥18; 3 个月 ¥38; 1 年 ¥88; 终身 ¥96. AI rewriting is sold separately in points (50 points ¥12, per a review) | [App Store CN](https://apps.apple.com/cn/app/id1524420173) (v3.1.0, 3 Jun); [CSDN comparison](https://blog.csdn.net/weixin_54878902/article/details/163248076) | confirmed (IAP); likely (points) |
| 五百丁 | 年会员 ¥29.9, 永久 ¥39.9 (about 2021); single template ¥9.9 | [牛客 review](https://www.nowcoder.com/discuss/353150761473351680) | likely, stale. The vendor's VIP page printed no prices to a fetch. |
| 简历本 | Not found | — | no data |
| AI 简历姬 | ¥29 / month, ¥198 / year; 3 free AI generations | [CSDN comparison](https://blog.csdn.net/weixin_54878902/article/details/163248076) (the article promotes this product) | likely |
| 夸克 AI 简历, 豆包 | Free | same article | likely |

**Reading:** a resume-only membership sells at **¥18–¥28 a month**, a quarter at about **¥38–¥60**, and "lifetime" at **¥28–¥99**. A 7-day card at **¥12** has an exact precedent (知页). Lifetime deals at under ¥100 are common, which is why a monthly price much above ¥39 would look expensive to a student.

### 2.2 Job platforms' seeker-side paid products (the anchor for experienced hires)

| Product | Prices found | Source | Confidence |
|---|---|---|---|
| BOSS直聘 | 找工作 VIP 会员 30 天 ¥68 (includes 竞争力分析 and message filtering); 直豆 ¥1 each, 30 for ¥30 | [App Store CN](https://apps.apple.com/cn/app/id887314963) (v14.180) | confirmed |
| BOSS直聘, context | Seeker VIP ¥68–¥98 depending on length and features (2024 report); a 2026 report calls the VIP a placebo that most seekers skip | [腾讯新闻 2024-10](https://news.qq.com/rain/a/20241010A062MS00), [OFweek 2026-06](https://tele.ofweek.com/2026-06/ART-8320506-8420-30690059.html) | likely |
| 智联招聘 | 月卡 ¥98; 求职服务 ¥18 / ¥68 / ¥98; 热门职位次卡 30 天 ¥78 / ¥88; 聊天加油包 30 天 ¥198 (first order ¥1); resume templates ¥12 / ¥18 | [App Store CN](https://apps.apple.com/cn/app/id488033535) (v8.15.13, 29 Sep) | confirmed (prices); likely (which are seeker-side) |
| 智联 职悟空 | Free; web + mini program, launched 2026-07-18 | [ITHome](https://www.ithome.com/1/004/863.htm), [知乎 (official PC launch)](https://zhuanlan.zhihu.com/p/2080340206880809258) | likely |
| 猎聘 | VIP 会员 ¥298; 季卡 ¥898; 优先沟通 10 次 ¥68, 20 次 ¥98; 猎币 packs ¥60–¥168 | [App Store CN](https://apps.apple.com/cn/app/id540996859) (v6.31.0) | confirmed |
| 猎聘 金卡 | 月卡 ¥548, 季卡 ¥898, 年卡 ¥1,598 (May 2025 dataset) | [小牛行研](https://www.hangyan.co/charts/3626931283117999129) | likely |
| 脉脉 | 求职版 ¥68; 职业发展会员 ¥58 (1 month) / ¥98; 连续包月 ¥98; 商务版连续包月 ¥68; VIP ¥198; 招聘版 ¥288 | [App Store CN](https://apps.apple.com/cn/app/id718659370) (v6.7.60) | confirmed |
| 牛客 | 大会员 30 天 ¥25, 90 天 ¥60, 连续包月 ¥25 (the description text says ¥20 a month); 牛客会员 30 天 ¥19.90; 简历工具包永久 ¥28 | [App Store CN](https://apps.apple.com/cn/app/id962209511) (v3.2.40, 11 Aug) | confirmed; the ¥20 / ¥25 mismatch is on the page |
| 实习僧 | Two unnamed items ¥39 and ¥49; 简历优化基础版 ¥98 | [App Store CN](https://apps.apple.com/cn/app/id1064868841) (v4.75.0, 14 Sep) | confirmed (prices); unknown (what ¥39 / ¥49 unlock) |

**Reading:** student-facing platforms sit at **¥20–¥25 a month and ¥60 a quarter** (牛客). Experienced-hire "exposure" memberships sit at **¥58–¥98 a month** (BOSS, 脉脉, 智联). Senior products start near **¥298** (猎聘). What these sell is visibility on their own marketplace, which GoApply does not have and does not claim.

### 2.3 AI mock interviews

| Product | Prices found | Per 20 minutes | Source | Confidence |
|---|---|---|---|---|
| 鹅来面 (formerly 多面鹅 / OfferGoose) | 30 分钟 ¥68 (also listed at ¥108); 120 分钟 ¥188; 300 分钟 ¥378; 首购专享 ¥19.90 | ¥25–¥45 | [App Store CN](https://apps.apple.com/cn/app/id6504543050) (v1.3.3, 30 Sep) | confirmed |
| 白瓜面试 | Points: mock interview 200 points a session; live speech recognition 3 points a minute; signup gift "¥30 (300 points)", so about ¥0.10 a point and **about ¥20 a mock session**. Time-based packages exist but the page prints no prices | about ¥20 a session | [pricing doc](https://m.baigua.com/docs/JYcHMTr4), [home](https://m.baigua.com/) | confirmed (points); inferred (yuan per point) |
| 面灵 AI | 尝鲜包 ¥29 (60 min live assist + 2 mock interviews); 标准包 ¥89 (240 min + 5); 通关包 ¥199 (600 min + 10); 周卡 ¥69; 月卡 ¥159; 季卡 ¥279; free 30 min + 1 mock; "refund any time if not satisfied" | n/a (bundled) | [vendor site](https://www.mianlingai.com/) | confirmed |
| 面试鸭 | Lifetime membership from ¥129, said to rise to ¥399+. It is a question bank, not a voice interviewer | n/a | [review, 2026-08-29](https://www.mianlingai.com/blog/mianshiya-review-2026/) (written by a competitor) | likely |
| 面试猫 | About ¥20 a session per a review; the vendor site says a free trial plus a paid tier with no public price | about ¥20 | [vendor site](https://offermore.cc/) | likely |
| Offer蛙, 牛面 | Sites printed no prices to a fetch; a search snippet showed Offer蛙 at ¥268 for a week against a struck-through ¥490 | — | [Offer蛙](https://mianshizhushou.com/), [牛面](https://niumianoffer.com/) | likely / no data |
| BOSS直聘 AI 模拟面试 | Free tryout for newcomers, with a report | free | [新浪 2025-03](https://client.sina.com.cn/2025-03-27/doc-inerauen0652718.shtml) | likely |
| 猎聘 AI 模拟面试 | A paid in-app pack, US$8.99 on a non-CN store page | — | already in `research/china-market.md` §4 | likely, stale |
| 讯飞, 北森 | Employer-side AI interviewers; no consumer price | — | `research/china-market.md` §4 | likely |

**Reading:** paid mock interviews cost **¥20 a session at the low end and ¥1.3–¥2.3 a minute at the high end**. Several of the expensive products (面灵, 白瓜, Offer蛙) mainly sell live answer prompting during real interviews and exams. That is a different, higher-stakes purchase, and one we do not build (`research/china-market.md` §4), so their weekly and monthly cards are not our anchor. The honest ceiling for practice is set by the free offers from 智联 (职悟空) and BOSS.

### 2.4 "一键投递" tools

No paid tool with a public weekly or monthly price was found. What exists is free and open source: a Greasy Fork script and a Chrome extension with about 10,000 users that batch-send greetings on BOSS ([Greasy Fork](https://greasyfork.org/en/scripts/491340-boss%E7%9B%B4%E8%81%98%E5%8A%A9%E6%89%8B), [Chrome Web Store](https://chromewebstore.google.com/detail/boss-helper-%E7%9B%B4%E8%81%98ai%E6%B1%82%E8%81%8C%E5%8A%A9%E6%89%8B/ogkmgjbagackkdlcibcailacnncgonbn)). D1 rules this category out for us anyway, so it gives no price anchor. *(likely)*

### 2.5 Packaging habits

- **Short cards and day-count names.** 7 天 / 30 天 / 90 天 and 周卡 / 月卡 / 季卡 are the standard units (知页, 牛客, 智联, 猎聘, 面灵). *(confirmed from the listings above)*
- **连续包月 is common but is the main source of complaints.** 脉脉 was reported for a ¥0.1 trial that renewed at ¥68 a month ([中华网 2021](https://m.tech.china.com/digi/digi/20211216/20211216955178.html)); tests after the 2026 price rules found nine large apps still preselecting auto-renewal ([东方财富 2026-04](https://caifuhao.eastmoney.com/news/20260411233936287921540)). *(likely)*
- **First-purchase prices** exist (鹅来面 首购 ¥19.90; 智联 首单 ¥1). *(confirmed)*
- **Prices end in whole yuan or in .9 / .90.** Our Alipay path can only charge whole yuan (§5), so ¥9.9-style points are not available to us. *(confirmed in code)*
- **Student prices:** no job-search product above publishes a verified student price. The category is already priced for students, so a student rate is a differentiator, not a norm. *(inferred from the listings)*

---

## 3. What buyers accept

| Segment | Evidence | Acceptable price |
|---|---|---|
| Students and new graduates | 牛客 ¥19.9–¥25 a month and ¥60 for 90 days; resume tools ¥12 a week and ¥18–¥28 a month; 实习僧 ¥39 / ¥49 items; a 中国青年报 survey of 1,011 students at ten Beijing universities found 63.8% consider mock interviews the key to success ([温州网 2025-01](https://edu.66wz.com/system/2025/01/09/105668312.shtml)) | Impulse buy under **¥30**; a monthly card up to about **¥39**; a whole season under **¥100** *(inferred)* |
| Experienced hires | BOSS VIP ¥68; 脉脉 ¥58–¥98; 智联 月卡 ¥98 | **¥58–¥98** a month is normal for them, so ¥39 reads as cheap *(inferred)* |
| Senior hires | 猎聘 ¥298–¥898 | Not our segment at launch |

An older survey found most students say they would pay for job-search help but only 14.3% had done so ([界面](https://www.jiemian.com/article/7240087.html)); treat stated willingness with caution. *(likely, stale)*

We keep **one public price for everyone** plus a published student rule. Charging experienced hires more based on their profile would be pricing the same service differently by ability to pay without telling the buyer, which Article 15 of 《互联网平台价格行为规则》 forbids (§4).

---

## 4. Rules that shape the offer

| Rule | What it requires | Source | Confidence |
|---|---|---|---|
| 《消费者权益保护法实施条例》 Art. 10, in force 2024-07-01 | For auto-renewal, remind the consumer prominently before the service starts and before each renewal date. No day count. | [新华网](http://www.news.cn/legal/20240704/1de0d45c25e3466aa812b5c0d391e92f/c.html) | confirmed (secondary) |
| 《网络交易监督管理办法》 Art. 18, as amended by SAMR Order 101 (2025-03-18; reported in force 2025-05-01) | Same two reminders, **with the former "五日" removed**; a prominent, simple option to cancel or change at any time; no unreasonable fees. Art. 41 routes violations to the Implementing Regulation's Art. 50. | [SAMR text](https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2025/art_4b47c79b8d994a42bba4835997688faa.html); the 2021 text with "前五日" is at [MOJ](https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202104/t20210423_357848.html) | confirmed (text); likely (effective date, from a law database) |
| 《互联网平台价格行为规则》 (发改价格规〔2025〕1607号), in force **2026-04-10** for five years | Art. 20: show auto-renewal and password-free payment as visible choices with an easy cancel route; **before every automatic deduction, tell the consumer the time, the amount and how to cancel**; notify fee changes. Art. 7: display prices and fee standards clearly. Art. 8: publish the rules for any price that differs by transaction condition. Art. 10: promotions state price, scope and period truthfully. Art. 15: no undisclosed algorithmic price differences by willingness or ability to pay. | [text](http://jsnews.jschina.com.cn/zt2024/fzsxxxpt/hdxf/wxfg/202512/t20251222_3575559.shtml) | confirmed (full text on a provincial news site; article numbers as read there) |
| 《网络购买商品七日无理由退货暂行办法》 | Digital goods downloaded online are outside the 7-day no-reason return. | [gov.cn](https://www.gov.cn/zhengce/2020-11/03/content_5723721.htm) | likely (via a search summary) |
| Network-recruitment rules | No deposits from job seekers; publish the fee schedule. | `research/china-market.md` §5.3, `CN_TW_LAUNCH_PLAN.md` C-13 | likely |
| Operating ICP (EDI) licence and collecting entity | No charging before the licence; the payment subject and receipt name the entity that actually collects (no 二清). | `CN_TW_LAUNCH_PLAN.md` C-12, C-13 | repo, binding |

**Refund expectations.** The law does not give a no-reason refund on activated digital memberships, but buyers expect one when the product was unused or bought by mistake, and they escalate to 黑猫 or 12315 quickly (the 超级简历 complaints in §2.1 are all refund disputes over ¥28–¥99.9). One competitor advertises "refund any time if not satisfied" (面灵). Our coded policy is already more generous than the legal floor: a first pass purchase is refundable within 7 days (48 hours for the 周卡) if fewer than 5 paid-only credits were used, and a pack is refundable while unused (`server/src/platform/billing/refunds.ts`). Keep it, print it on `/pricing`, and get counsel to clear the `refund-v1-2026-10-pending-counsel` version. *(inferred recommendation)*

---

## 5. What the existing Alipay path can and cannot do

Read from `server/src/platform/billing/rails/alipayWorker.ts`, `fulfilPass.ts`, `planCatalog.ts`. Nothing below proposes changing the request, callback or verification path.

| Fact | Consequence for pricing |
|---|---|
| The rail creates a **one-time order** through the GoHire worker and fulfils it on a callback authenticated by `ALIPAY_CALLBACK_SECRET`. | Every GoApply product must be a one-time purchase. Passes and packs fit; auto-renewal does not. |
| `plan.amountMinor % 100 !== 0` is refused (`price_not_whole_yuan`). | Prices must be **whole yuan**. ¥9.9 / ¥19.9 / ¥39.9 cannot be charged. All recommended prices comply. |
| The paid amount must equal the order amount, or fulfilment returns `amount_mismatch`. | A price change applies to new orders only; never edit the amount of a pending order. |
| Buying a pass while one is live **extends** from the current end date. | "续费" is a repeat purchase. A 周卡 buyer can stack; no proration logic is needed. |
| A new plan key needs only a `PlanDefinition` row and a `CN_PRICE_<KEY>_FEN` value; `package_id` is the plan key. | Student passes can be added **additively**. |
| The rail is unconfigured for GoApply until `CN_PAYMENT_COLLECTING_ENTITY` is set, and nothing is sellable until `CN_PAYMENTS_ENABLED=true`. | Prices can ship now without any charge being possible. |
| No refund call exists on this rail. | Refunds are issued by hand from the merchant side. Needs an owner-side procedure. |
| The 季卡's "3 per month" is granted lazily per calendar month (`server/src/lib/mockCreditService.ts`, `allowance.per === 'month'`). | A 90-day pass yields 9 practice credits in most cases, and can touch a fourth calendar month. |

**Why not 连续包月 on GoApply.** *(inferred, from the evidence above)*
1. It needs Alipay's agreement-signing product (周期扣款, reported as superseded by 商家扣款; third-party write-ups cite a 7-day minimum cycle and low per-deduction limits: [腾讯云开发者](https://cloud.tencent.cn/developer/article/2372077), [CSDN](https://blog.csdn.net/qq_30240219/article/details/144055239)). The official product page could not be retrieved, so access conditions are **unverified**. It would be a second integration beside the path the owner said not to touch.
2. Every deduction would need a prior notice with time, amount and cancel route (§4).
3. Auto-renewal is the category's main complaint. "到期不自动续费" is a selling point we can print truthfully.
4. Job search is seasonal (秋招 and 春招 each run about three months), which a 季卡 covers.

This is a payment-rail difference, which D5 and D6 allow. What a pass unlocks is the same Pro column the international subscriptions unlock.

---

## 6. Recommended GoApply ladder

All amounts are whole yuan, tax-inclusive, one-time, non-renewing. Same price on Alipay and, later, WeChat Pay.

| Plan key | Name | Price | `CN_PRICE_…_FEN` | Access | Practice credits (1 credit = 20 min) | Change vs approved |
|---|---|---|---|---|---|---|
| `free` | 免费版 | ¥0 | — | — | 1 after phone verification + 1 for the getting-started checklist | none |
| `pro_week_pass` | 会员周卡 | **¥12** | `1200` | 7 days | 1 | confirmed |
| `pro_monthly` | 会员月卡 (default selection) | **¥39** | `3900` | 30 days | 3 | confirmed |
| `pro_quarterly` | 会员季卡 | **¥99** | `9900` | 90 days | 3 per month | confirmed |
| `practice_pack_5` | 面试练习包 5 次 | **¥29** | `2900` | credits valid 12 months | 5 | confirmed, with the cost guardrail |
| `practice_pack_15` | 面试练习包 15 次 | **¥79** | `7900` | credits valid 12 months | 15 | confirmed, with the cost guardrail |
| `student_monthly` | 学生月卡 | **¥29** | `2900` | 30 days | 3 | **new** |
| `student_quarterly` | 学生季卡 | **¥69** | `6900` | 90 days | 3 per month | **new** |

Numbers the UI will compute from these (rounded down, as `savingsPercent` and `studentDiscountPercent` do):
- 季卡 against three 月卡: (117 − 99) / 117 = 15.4%, shown as **省 15%**.
- 学生月卡 against 月卡: (39 − 29) / 39 = 25.6%, shown as **25%**.
- 学生季卡 against 季卡: (99 − 69) / 99 = 30.3%, shown as **30%**.
- Four 周卡 cost ¥48 for 28 days; a 月卡 costs ¥39 for 30. No "save" badge is needed, the prices speak.
- 15-pack against three 5-packs: (87 − 79) / 87 = 9.2%, so at most **省 9%**.

### 6.1 Why each price

- **周卡 ¥12.** Exact precedent in 知页's 7 天会员 ¥12; under the ¥18–¥28 monthly prices of resume tools, so it reads as a trial; whole yuan. ¥9.9, the usual hook price, is not chargeable on our rail, and ¥9 or ¥10 would put four weeks (¥36–¥40) on top of the monthly card. *(confirmed anchor, inferred conclusion)*
- **月卡 ¥39.** Above resume-only memberships (¥18–¥28) and 牛客 (¥25) because it adds matching, tailoring, cover letters, the Assistant and three voice interviews; equal to WonderCV's ¥39 / ¥39.90 tier; well under the seeker VIPs experienced hires already pay (¥58–¥98). Three practice sessions alone would cost ¥60 or more at the cheapest paid comparable (about ¥20 a session). *(inferred)*
- **季卡 ¥99.** Under the ¥100 line; one hiring season; between 牛客's 90 days at ¥60 and the AI-interview quarter cards at ¥279. *(inferred)*
- **Packs ¥29 / ¥79.** ¥29 is the impulse line and matches the entry price point of the category (面灵 尝鲜包 ¥29, which includes 2 mock interviews against our 5). Per session we are at ¥5.80 and ¥5.27, against about ¥20 (白瓜, 面试猫) and ¥25–¥45 per 20 minutes (鹅来面). We could charge more, but 职悟空 and BOSS give practice away, and the pack should stay clearly worse value than the 月卡 so the membership remains the main product. *(inferred)*
- **Student passes ¥29 / ¥69.** The international plan targets 30% off for students; ¥69 gives exactly that on the quarter, and ¥29 gives 25% on the month while landing on the same impulse price as 牛客's and AI 简历姬's monthly tiers. A student 周卡 is not needed: ¥12 is already the low-commitment entry. *(inferred)*

### 6.2 Pack cost guardrail

One practice credit is a 20-minute live voice session, our most expensive unit.
- On a mainland voice stack, `research/china-market.md` §"voice" records Aliyun real-time audio at ¥0.098 a minute bundled and Paraformer ASR at about ¥0.0144 a minute. That is roughly ¥2.3 for 20 minutes before LLM and TTS, so plausibly **¥3–¥4 a session**. *(inferred from list prices in the repo note)*
- On the shared international stack, which D5 makes GoApply's fallback, the cost is unknown to this research and is likely higher. *(inferred; not measured)*

At ¥5.27–¥5.80 of revenue per session the margin is thin on the first and possibly negative on the second. **Action:** read the real per-session cost from `UsageDeductionLog` for the practice SKU before charging opens. Rule of thumb: keep ¥29 / ¥79 if the cost is at or under about ¥3.5 a session; otherwise use **¥39 / ¥99** (¥7.80 and ¥6.60 a session, still a third of the cheapest paid comparable). The same check applies to the three credits inside a 月卡.

---

## 7. Entitlements (D5: identical capability, priced for the market)

The Pro column is the same for both brands and is already one code path (`server/src/platform/credits/catalog.ts`, `entitlementProfile: 'pro'`). Every GoApply pass, student passes included, unlocks it for its duration.

| Credit / limit | 免费版 | 会员 (周卡, 月卡, 季卡, 学生卡) | Same as RoboApply? |
|---|---|---|---|
| Feed, fit scores, filters, search, tracker, campus calendar, alert digest | Free, no cap | Free, no cap | Yes |
| `fit_analysis` | 10 a day | up to 200 a day | Yes |
| `tailor` | **3 a day** | up to 50 a day | Free tier is 1 higher on GoApply (2 on RoboApply); Pro identical |
| `cover_letter` | 2 a day | up to 50 a day | Yes |
| `resume_check` | 1 a day | up to 20 a day | Yes |
| `rewrite` | 20 a day | up to 300 a day | Yes |
| `outreach` (内推 request drafts) | 3 a day | up to 50 a day | Yes |
| `assistant` | 30 a day | up to 300 a day | Yes |
| `autofill` (一键填表) | 5 a day | up to 100 a day | Yes |
| `ai_answer` | 10 a day | up to 200 a day | Yes |
| `job_import` | 10 a day | up to 50 a day | Yes |
| `ready_kits` | 3 a week | up to 30 a week | Yes |
| `competitiveness` | 1 a week | 3 a day, full report | Yes |
| Saved searches | 1 | 10 | Yes |
| Instant alerts | 1 a day | as they arrive (stored cap 100 a day) | Yes |
| Practice interview credits | 1 after phone verification + 1 for the checklist | 周卡 1; 月卡 3; 季卡 3 per month; packs add 5 or 15 | Counts match the international weekly, monthly and quarterly plans |

**免费版 stays as designed.** The incumbent assistant (职悟空) is entirely free and 夸克 and 豆包 give resume help away, so cutting the free tier would lose the comparison at the door. The free tier already carries the differentiated parts (matching, tracker, calendar) with no cap, and the three-a-day tailor is the right place to be more generous than the international brand. No free-tier number needs to change. *(inferred)*

**How the international ladder maps.** RoboApply sells an auto-renewing weekly, monthly and quarterly Pro plus a 7-day pass; GoApply sells the pass form of each. The capability, caps and practice allowances are equal; only the billing mechanics and the currency differ. At roughly ¥7 to the dollar (an illustration, not a quoted rate), ¥39 is a little over a fifth of US$24.99, which is in line with how far apart local comparables are (WonderCV ¥39 against Jobright US$39.99).

---

## 8. Implementation notes for the build (no code changed here)

1. **Catalog defaults (D6).** Add default fen amounts for `goapply` in `planCatalog.ts`, with `CN_PRICE_<PLANKEY>_FEN` as an override. `CN_PAYMENTS_ENABLED` and `CN_PAYMENT_COLLECTING_ENTITY` keep gating sellability, so `/pricing` shows real prices before charging opens.
2. **Student passes.** Add `student_monthly` and `student_quarterly` to `GOAPPLY_PLANS` as `kind: 'pass'` (30 and 90 days, `requiresFlag: 'student'`, never preselected), and add their two env names to `.env.example`. `savingsPercent` already treats `passDays === 90` as three months; `studentDiscountPercent` works unchanged.
3. **Student verification.** The existing check is a verified school email, and `.edu.cn` matches the `.edu.<cc>` rule. GoApply accounts are phone-first with a placeholder email, so the flow must let a user add and verify a school email. Many students have no usable `.edu.cn` mailbox; a 学信网 在线验证报告 upload with manual review is the mainland norm and should follow. Publish the rule on `/pricing` (Article 8).
4. **Copy.** State on every plan: one-time payment, 到期不自动续费, the exact day count, the refund rule and the collecting entity. No struck-through prices, no countdowns (already PRODUCT_PLAN §6.1). The 3-days-before-expiry notice is a courtesy, not a renewal reminder.
5. **Do not add** ¥x.9 prices, a first-month discount that later reverts, or auto-renewal. Each one either cannot be charged on the current rail or brings the reminder and complaint burden in §4.
6. **Later surfaces.** A WeChat mini program on iOS would have to sell through Apple's in-app purchase at a 15% commission (`research/china-market.md` §5.3). Decide then whether to hold the same prices; do not raise web prices now to pre-fund it.

---

## 9. Staleness and gaps

- App Store prices are a snapshot of 2026-10-11 and show at most ten items; iOS prices may exceed web prices. 知页's listing dates from 2024-12.
- 五百丁 figures are from about 2021; 简历本, Offer蛙 and 牛面 printed no prices to a fetch.
- BOSS and 猎聘 mock-interview prices for seekers were not found on a primary page.
- Most 2025–2026 "comparison" articles in this category are written by one of the products compared. Their own prices are usable; their rankings are not.
- Alipay's official 商家扣款 page and its fee table could not be retrieved; everything about it here is second-hand. The fee on the GoHire merchant's contract is unknown to this research.
- Voice cost per session is an estimate from list prices, not a measurement.
