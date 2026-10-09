# GoApply.Top: requirements for a mainland-China Jobright-style copilot (plus Taiwan notes)

**Research date:** 2026-10-09. **Angle:** what it takes to launch a Jobright-equivalent AI job-search copilot in **mainland China** under the **GoApply** brand (goapply.top). **Taiwan** is served by the international brand (RoboHire.io). This file covers job data sources, what Chinese job seekers expect, the competitor landscape, platform and compliance requirements, LLM and real-time voice infrastructure, and Taiwan specifics. It ends with a numbered requirement list and open questions.

**Confidence legend**
- **confirmed**: primary source (regulator, vendor docs, the product's own page, official registry).
- **likely**: more than one secondary source (news, law-firm analysis, trade press).
- **inferred**: my own reasoning from the evidence. Legal or ops should validate these.

> Not legal advice. Everything marked as a compliance requirement needs sign-off from PRC counsel before launch. Several rules took effect in 2025–2026, and enforcement still varies by province.

---

## 0. TL;DR: the ten things that decide whether GoApply can launch

1. **You need a mainland legal entity.** Every gate below needs one: ICP filing, the paid-service ICP licence, the WeChat Open Platform, WeChat Pay/Alipay merchant accounts, SMS signature registration and the HR-service licence. *(likely / inferred; see §2)*
2. **Aggregating and recommending jobs counts as "network recruitment service" (网络招聘服务).** It needs a **人力资源服务许可证** (HR service licence), and that licence needs a telecom licence for online recruitment. A Dec-2025 five-ministry notice tightened this further: reposted postings must cite their original source, and each post must show base pay, location, headcount and an expiry date. *(confirmed: CAC notice; MOHRSS rules)*
3. **Charging a subscription needs an operating ICP licence (经营性ICP / 增值电信业务经营许可证), not just a filing.** The 2024 foreign-ownership pilot is limited to Beijing, Shanghai Lingang, Hainan and Shenzhen and to specific telecom categories. *(likely)*
4. **No OpenAI or Anthropic models for mainland users.** OpenAI cut off CN/HK API traffic from 2024-07-09. Anthropic bars entities majority-owned by Chinese companies from 2025-09-05. The usable models are filed domestic ones: DeepSeek, Qwen, Kimi, GLM and Doubao. GoApply must also complete **local CAC "登记" (registration) as a generative-AI app** and show the model name plus its filing or launch number in the product. *(likely / confirmed)*
5. **Host in the mainland.** Vercel has no China PoPs and *.vercel.app may be blocked. Cloudflare's China Network needs Enterprise, an ICP and a JD Cloud content review. Plan a separate Aliyun or Tencent Cloud deployment with an in-China database, which means **no resumes in Neon us-east-1**. *(confirmed)*
6. **Assume every resume upload is a cross-border transfer unless the full stack is in China.** Job seekers probably do not fall under the cross-border HR-management exemption (lawyers note the ambiguity). Below 100k people per year the filing mechanisms are waived, but separate consent and a PIA are still required. **Default: keep all CN data in CN.** *(likely)*
7. **LiveKit Cloud has no mainland region** (none in its region list), and LiveKit Inference's vendors are not domestic. Mock interviews need either self-hosted LiveKit on mainland cloud with domestic STT/TTS/LLM, or a domestic conversational-AI RTC: Volcano Engine RTC, Agora (声网), Tencent TRTC or Aliyun AI 实时互动. *(confirmed / likely)*
8. **Build for WeChat first.** Chinese AI interviews and the newest copilot (Zhaopin's 职悟空, July 2026) run as **WeChat mini programs** with phone and WeChat login. Paid features on iOS mini programs now go through Apple IAP at 15% under the Nov-2025 Apple–Tencent arrangement. *(likely)*
9. **Never scrape BOSS直聘, 智联 or 51job, and never auto-greet.** The criminal precedent is a Beijing company that scraped about 210 million resumes from recruiting sites: RMB 40M fine, 7 years for the legal representative. None of the big boards has a public read API. Realistic sources are the **GoHire bank (first-party)**, employer partnerships and feeds, **official campus job-sharing (国家24365 platform)**, university career centres, and **user-assisted autofill on company career sites** (Beisen/Moka/Feishu-hosted). *(likely / inferred)*
10. **Campus recruiting (校招) is the wedge.** About 12.7M graduates in the class of 2026. 网申 (online application) forms are long and repeated across employers (about 15–20 minutes each by hand), and AI interviews are now a standard early filter. The Chinese equivalents of Jobright's autofill, "insider connections" and interview prep are **一键网申 autofill**, **内推 (referral codes)** and **AI面试 simulation**. *(likely)*

---

## 1. Regulatory and licensing gates (mainland)

### 1.1 Entity and licences: what each one unlocks

| Gate | What it unlocks | Key facts | Confidence / evidence |
|---|---|---|---|
| Mainland legal entity (domestic company, WFOE or JV) | Everything below | ICP filing needs the domain's real-name holder to match the filing entity exactly, down to full-width parentheses as on the business licence. Domain must be held by an MIIT-approved registrar, with more than 45 days to expiry. | confirmed: [Aliyun ICP domain prep](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/prepare-and-check-the-domain-name) |
| **ICP 备案 (filing)** for goapply.top | Serving any site from mainland servers | Mainland hosting needs a filing; servers outside the mainland do not. Real-name data takes about 2–3 days to sync to MIIT. Only the apex domain is filed; subdomains are covered. | confirmed: same Aliyun doc |
| **.top eligibility** | Filing for goapply.top | Aliyun's list of fileable suffixes includes .TOP. Wikipedia says .top was put on record with MIIT on 2015-04-24. **New:** IANA now lists the sponsoring organisation as *Hong Kong Zhongze International Limited* (record updated 2026-09-23), with Jiangsu Bangning staff as admin/tech contacts. Whether that changes filing eligibility is **unverified**; check domain.miit.gov.cn and run Aliyun's "检测域名是否可备案" check before you commit. A 2026 third-party list names suffixes Beijing will not file (.pro, .kim, .red, .icu …); .top is not on it. | confirmed: [Aliyun](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/prepare-and-check-the-domain-name), [IANA .top](https://www.iana.org/domains/root/db/top), [Wikipedia .top](https://en.wikipedia.org/wiki/.top); likely: [CSDN 2026 list](https://blog.csdn.net/qq_47607250/article/details/160745801) |
| **经营性 ICP 许可证 (operating ICP licence / value-added telecom licence)** | Charging users (memberships, paid reports) | A filing alone does not allow paid services; membership top-ups and paid subscriptions sit in licence scope. Commonly cited minimum registered capital is RMB 1M. Review takes up to 60 days. | likely: [Sohu explainer](https://m.sohu.com/a/525091007_120873253), [ICP vs licence](https://m.sohu.com/a/1061071493_122805213/) |
| Foreign ownership of value-added telecom | Whether a foreign-held entity can hold the licence | MIIT's 2024-04 pilot lifts foreign-equity caps for IDC, CDN, internet access, online data processing and transaction processing, and information-publishing platforms, **only** in the Beijing services-opening zone, Shanghai Lingang, Hainan FTP and Shenzhen. It started 2024-10-23. | likely: [China Law & Practice](https://chinalawandpractice.com/2024/04/25/ministry-of-industry-and-information-technology-notice-on-the-launching-of-a-pilot-project-to-expand-the-opening-up-of-value-added-telecommunications-services-to-foreign-investment), [China Daily 2024-10-23](https://cn.chinadaily.com.cn/a/202410/23/WS6718886da310b59111d9f685.html) |
| **人力资源服务许可证 (HR service licence)** | Publishing or aggregating job postings, matching seekers to employers | See §1.2. | confirmed |
| **App 备案 / mini-program 备案** | Listing in app stores and in WeChat | Since 2023-09 new apps and mini programs must be filed before launch. The filing number must appear prominently, linked to the filing system. Apple's China App Store requires a valid filing number. | likely: [The Paper](https://www.thepaper.cn/newsDetail_forward_24155262), [secrss Q&A](https://www.secrss.com/articles/57561), [ITHome Apple](https://www.ithome.com/0/734/605.htm) |
| Generative-AI **登记 (registration)** | Shipping LLM features that call filed models | Apps that call an already-filed model through an API register with the **local CAC**. Filing is for the model itself. Live apps must show, prominently or on the product detail page, **the model name plus the filing number or launch number**. Totals at 2025-12-31: 748 filed services and 435 registered apps. Mid-2026: 988 and 598. | likely: [The Paper](https://www.thepaper.cn/newsdetail_forward_32368980), [ITHome](https://www.ithome.com/0/911/987.htm), [CAC 2024-04](https://www.cac.gov.cn/2024-04/02/c_1713729983803145.htm) |
| Algorithm filing (算法备案) | Personalised job feed | Required within 10 working days for providers "with public-opinion attributes or social-mobilisation capacity". 猎聘's "信息推荐算法" was in the Aug-2022 batch as a personalised-push algorithm. **Whether GoApply qualifies is a legal call.** Comparable job boards have filed, so plan to file. | likely: [CAC algorithm list 2022-08](https://www.cac.gov.cn/2022-08/12/c_1661927474338504.htm), [Guantao](https://guantao.com/page3269) |
| Real-name | Account creation | Cybersecurity Law (amended Oct 2025, effective 2026-01-01; the real-name article is now Art. 26, formerly Art. 24): operators that provide info-publishing or IM services must collect real identity. In practice that means verified mobile numbers. | likely: [The Paper on 2025 amendment](https://m.thepaper.cn/newsDetail_forward_32950799), [CAC 2017 real-name explainer](https://www.cac.gov.cn/2017-05/31/c_1121064957.htm) |
| Public-security filing (公安备案) | Website footer | Standard after ICP filing. | inferred (common practice; no source fetched) |

### 1.2 HR-service licence: why a job copilot is in scope

- The *Network Recruitment Service Management Provisions* (MOHRSS, effective 2021-03-01) define network recruitment as HR-service agencies providing job-seeking or recruiting services online through platforms, self-built sites or other network means. A commercial agency doing this **must hold a 人力资源服务许可证** (Art. 9) and, where telecom business is involved, a telecom licence. Licences are annotated "开展网络招聘服务" (Art. 10). Scope includes introducing employers to workers, recommending workers to employers and online job fairs (Art. 11). Commercial agencies may not charge job seekers deposits and must publish their fee schedule (Art. 19). *(likely: [gov.cn text](https://www.gov.cn/zhengce/zhengceku/2020-12/25/content_5573141.htm), [ITHome summary](https://www.ithome.com/0/526/824.htm))*
- **Five-ministry notice 《关于规范网络平台招聘类信息发布的通知》** (MOHRSS, CAC, MIIT, MPS and NFRA; dated 2025-12-25, published 2026-01-15). *(confirmed: [CAC](https://www.cac.gov.cn/2026-01/15/c_1770207718756257.htm); likely: [Xinhua](https://www.news.cn/tech/20260114/29a97e23ff3c4c06b991d6507e79637c/c.html))*
  - Commercial agencies that publish recruitment information in any format, and platforms that publish it for employers, need the licence.
  - Accounts must be real-name. Recruiting accounts are classed as commercial, public or employer-direct, verified against a materials list and **re-verified at least every 6 months**. Unverified accounts cannot post. Employer-direct accounts post only for themselves or their branches.
  - Verified recruiting accounts carry a "招聘服务类" label and show their qualifications on the profile. Changes must be updated within 10 working days.
  - **Each posting must include** employer basics, headcount, requirements, job content, work location and **basic pay (基本劳动报酬)**, plus an **expiry date** or timely updates. **Reposted information must state the original source.** This applies directly to an aggregator.
  - Algorithms must not boost fake postings. Platforms may not steer users into 招转培 or 培训贷 (training-loan traps) or into unrelated financial products. Risk-identification models, evidence retention, graduated penalties and anti-re-registration blacklists are required.
  - Number-protection services should be supervised to reduce leaks of job seekers' phone numbers.
- **Licence conditions (Beijing example).** The legal person needs "职业中介活动" in its business scope, at least **50 m²** of fixed premises, full-time staff per the Employment Promotion Act, management rules and ledgers, and for online recruitment **a telecom and information-service licence**. Foreign or HK/Macau/Taiwan-invested agencies apply to the city-level bureau. *(likely: [Beijing RSJ procedure doc](https://rsj.beijing.gov.cn/xxgk/2024zcwj/202406/W020240617396922300833.docx), [Fadada](https://www.fadada.com/article/Basics-004099))*
- **Enforcement example.** Jiangsu fined a company that posted jobs on a WeChat official account without the licence and charged fees. *(likely: [Yangtze Evening Post 2026-05](https://www.yzwb.net/news/jiangsu/202605/t20260506_350070.html))*
- **Product implication** *(inferred)*: a "seeker-only toolkit" (resume, mock interview, tracker) with no job inventory is lower risk. Once GoApply shows a job feed, recommends jobs or forwards applications, it is doing recruitment services. Options:
  - (a) GoApply's entity obtains the licence.
  - (b) Run the job inventory through **GoHire's** entity, if GoHire holds or obtains the licence, and have GoApply deep-link out.
  - (c) Show only official or public-sector shared postings with source attribution and no ranking. Still risky; needs counsel.

### 1.3 Personal information (PIPL and related rules)

- **Legal bases.** PIPL Art. 13 lists consent, necessity for contract, and HR management under lawful labour rules. Law-firm analysis: for **candidates and job seekers** the HR-management basis is weak, and "necessary for contract" covers very little, so **consent is the working basis**. *(likely: [PIPL text](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm), [Bird & Bird employee data series](https://www.twobirds.com/en/insights/2021/china/employee-data-protection-series-iv))*
- **Sensitive PI (Art. 28–30).** Biometrics, specific identities, medical or health data, financial accounts, location tracks and data of children under 14 need **separate consent** and a necessity notice. Resume items that hit this: national ID number, health status, face images if processed for identification, bank cards. *(likely: PIPL text above)*
- **No forced bundling (Art. 16).** You cannot refuse service because a user declines non-essential processing. The 2021 CAC naming of 51 recruiting apps, including LinkedIn, 智联 and 猎聘, cited over-collection. *(likely: [ITHome 2021](https://www.ithome.com/0/552/764.htm))*
- **Automated decision-making (Art. 24).** Must be transparent and fair. Users can ask for an explanation and can refuse decisions with significant impact made solely by automation. This applies to match scores and "your odds" features. *(likely: PIPL text)*
- **Network Data Security Management Regulations** (effective 2025-01-01). The privacy policy must be centralised and easy to find, and must list purposes, methods, categories, the necessity of any sensitive PI, retention and how to exercise rights (access, copy, port, correct, delete, restrict, close account, withdraw consent). Large platforms (≥50M registered or ≥10M MAU) must offer an easy **off switch for personalised push** and tag deletion. Processors of ≥10M people's PI take on important-data-style duties. *(likely: [CAC/Xinhua](https://www.cac.gov.cn/2024-09/30/c_1729384452126506.htm), [JunHe](https://junhe.com/legal-updates/2531))*
- **Cross-border transfer.** Under the 2024-03 *Provisions on Promoting and Regulating Cross-Border Data Flow*:
  - Non-CIIO processors sending **under 100k individuals' non-sensitive PI per calendar year** need no mechanism.
  - 100k to 1M individuals, or under 10k sensitive, need a standard contract or certification.
  - Above that, a security assessment.
  - The **PI Export Certification Measures** take effect 2026-01-01 and give 3-year certificates.
  - **Notice, separate consent and a PIA are still required in every case.**
  - The HR-management exemption covers *employees* under labour rules. Lawyers flag that applicants and candidates may not count as "employees".

  *(likely: [JunHe](https://junhe.com/legal-updates/2401), [HSF Kramer](https://www.hsfkramer.com/notes/employment/2024-05/prc-new-data-regulations-eases-cross-border-transfer-of-employee-data), [CAC 2025-10 certification measures](https://www.cac.gov.cn/2025-10/17/c_1762449728518762.htm))*

  **Implication** *(inferred)*: sending a CN user's resume to OpenRouter/Anthropic/US Postgres is a cross-border transfer and is blocked by model policy anyway. Keep the GoApply data plane fully in China.
- **Facial recognition.** The *Security Measures for Facial Recognition Technology* took effect 2025-06-01. They require separate consent, local storage by default, an alternative to face-only verification, a PIA kept for 3 years, and **a provincial CAC filing once stored face data reaches 100k people** (within 30 working days). Expression or emotion analysis that never identifies anyone is probably outside the measures but is still PI. *(likely: [CAC](https://www.cac.gov.cn/2025-03/21/c_1744259796594932.htm), [JunHe](https://junhe.com/legal-updates/2651))*

  **Implication** *(inferred)*: video mock interviews should not run face ID or store face templates. Make video opt-in, keep it in China, and give short retention.
- **2026 enforcement climate.** A CAC, MIIT and MPS campaign launched 2026-04-02 covers automated decision-making, face recognition, third-party sharing and internal access control. By Aug-2026 it had checked more than 20k apps and SDKs, publicly named over 1,100 and taken down over 400. *(likely: [Xinhua 2026-08-19](https://www.news.cn/20260819/0fad3ae51947401b87be2e31f89906b5/c.html), [ChinaNews 2026-04-02](https://www.chinanews.com.cn/gn/2026/04-02/10597585.shtml))*
- **Resume resale is criminal.** Precedents: a Zhaopin insider sold over 155k resumes at RMB 2–2.5 each, and fake job ads have been used to harvest resumes. Courts remind HR staff to delete resumes promptly. *(likely: [BJNews](https://www.bjnews.com.cn/detail/156715864414056.html), [Yangtze Evening Post 2025-10](https://www.yzwb.net/news/sh/202510/t20251031_283877.html))*

### 1.4 AI-generated content labelling (effective 2025-09-01)

- The *Measures for Labelling AI-Generated Synthetic Content* (CAC, MIIT, MPS, NRTA) and a mandatory national standard took effect together on 2025-09-01. *(likely: [CAC](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm), [China Law Translate](https://www.chinalawtranslate.com/ai-content-labels/))*
- **Explicit labels.** Where deep-synthesis Art. 17(1) applies (text generation simulating a person, intelligent dialogue and so on), add text or symbol prompts at the start, end or middle, or a prominent marker in the interface. **Downloads, copies and exports must keep the explicit label.**
- **Implicit labels.** Metadata in the file covering the generation attribute, provider name or code, and a content ID. Watermarks are encouraged.
- If a user asks for unlabelled output, the provider may supply it only after the user agreement sets out the user's labelling duty, and must **keep logs for at least 6 months**. Users may not strip or forge labels.
- **Implication** *(inferred)*: AI-tailored resumes, cover letters and 自我评价 generated in GoApply should carry an in-app "AI 生成/AI 辅助" marker and XMP/DOCX metadata in exports. Settle the policy for unlabelled export in the ToS. Watch the tension: users do not want "AI-generated" stamped on a resume an employer will read. **Needs a product and legal decision.**

### 1.5 Model-vendor restrictions

- **OpenAI**: API traffic from CN, HK and Macau blocked from 2024-07-09. Azure OpenAI in the mainland is limited to enterprise customers. *(likely: [Caixin](https://www.caixinglobal.com/2024-06-26/openai-enforces-harsher-api-restrictions-on-unsupported-countries-102209858.html), [SCMP](https://scmp.com/tech/policy/article/3267971/tech-war-openai-further-block-access-mainland-china-hong-kong-based-developers))*
- **Anthropic**: from 2025-09-05 it bars entities more than 50% owned, directly or indirectly, by companies headquartered in restricted regions including China, wherever they operate. *(likely: [CRN Asia](https://www.crnasia.com/news/2025/artificial-intelligence/anthropic-tightens-ai-access-rules), [Bloomberg Tax](https://news.bloombergtax.com/international-trade/anthropic-clamps-down-on-ai-services-for-chinese-owned-firms))*
- **Implication** *(inferred)*: GoApply's CN stack must use domestic filed models. **If the GoApply operating entity, or RoboApply's cap table, becomes majority-owned by a PRC-HQ company, the international RoboHire.io brand could also lose Claude access.** Check before structuring the CN entity.

---

## 2. Job data sources for mainland jobs: what is reachable legally

### 2.1 Summary table

| Source | Public API? | Legal and technical reality | Recommendation | Confidence / evidence |
|---|---|---|---|---|
| **GoHire job bank (gohire.top)** (first-party, recruiter side) | Ours | Already wired into RoboApply's cross-bank search (`server/src/roboapply/v2/…`, `docs/CROSSBANK_JOBSEARCH_SPEC.md`). Jobs materialise into RAJob with applyUrl `www.gohire.top/jobs/{id}`. The GoHire DB is self-hosted at a public IP with `sslmode=disable` (flagged as a risk in internal notes). Data is thin and includes recruiter test postings. | **Primary inventory.** Fix TLS, move to a mainland VPC, and confirm GoHire's entity holds the HR-service licence and verifies employers per the 2026 notice. | confirmed (internal): `docs/CROSSBANK_JOBSEARCH_SPEC.md` and project memory `crossbank-jobsearch-agent-team.md` |
| **BOSS直聘** | No public open platform found | Dynamic rendering and strict risk control. Third-party CLIs use reverse-engineered APIs, and extensions that auto-greet carry ban risk. In 2025-Q3 the platform permanently banned about 20k fraud-suspect accounts, 80% caught automatically. Candidate data needs per-contact authorisation. | **Do not integrate or scrape. Deep-link only** ("在 BOSS 直聘查看"). Never automate 打招呼. | likely: [Jiemian](https://www.jiemian.com/article/13552109.html), [GitTrend boss-cli](https://gittrend.io/repo/jackwener/boss-cli), [App Store](https://apps.apple.com/us/app/-/id887314963) |
| **智联招聘** | None public | ATS vendors such as Moka connect through browser extensions (one-click import and posting on 智联, 51job, 猎聘 and 拉勾) or HR-mailbox authorisation, not server APIs. | Partnership only. 智联 now runs its own seeker copilot (职悟空), so it is a competitor. | likely: [Moka Chrome extension](https://chrome.google.com/webstore/detail/aahbjjldiddbnpabbhkaklkmnokndedo), [36Kr 2018](https://www.36kr.com/p/1641796239361) |
| **前程无忧 51job** | Contract-gated **posting** API (push from employer ATS) | SAP SuccessFactors Recruiting Posting and Manatal post to 51job using the customer's own 51job contract and API token. This is employer-side distribution, not a read feed. | Not a data source for us. Possible later as a **distribution** channel for GoHire employers. | likely: [SAP KBA 2651162](https://userapps.support.sap.com/sap/support/knowledge/en/2651162), [Manatal](https://www.manatal.com/integrations/my-contract-51job), [API Evangelist](https://providers.apievangelist.com/providers/51job/) |
| **猎聘 Liepin** | None found | Filed recommendation algorithm. Doris AI interviewing is B2B. Seeker app sells AI mock interviews and "AI 智投" auto-push. | Competitor; no integration. | likely: [App Store](https://apps.apple.com/py/app/%E7%8C%8E%E8%81%98-%E4%B8%93%E4%B8%9A%E6%8B%9B%E8%81%98app/id540996859?l=en-GB), [Xinhua 2024](https://www.news.cn/tech/20241031/a02bd81b437947e6a9b0ee612cafe10e/c.html) |
| **拉勾, 实习僧, 牛客** | None found | 牛客 has a verified-employee **内推** marketplace, a written-test (笔试) question bank and B2B AI interviews (Meituan uses 牛客). 实习僧's latest app (v4.73.0, 2026-07-28) shows no public AI copilot features. | **Partnership targets**: 内推 and 笔试 content for 牛客, internships for 实习僧. | likely: [牛客 App Store](https://apps.apple.com/cr/app/%E7%89%9B%E5%AE%A2-%E5%A4%A7%E5%AD%A6%E7%94%9F%E5%AE%9E%E4%B9%A0%E6%B1%82%E8%81%8C%E6%89%BE%E5%B7%A5%E4%BD%9C%E7%A5%9E%E5%99%A8/id962209511), [Jiemian AI interviews](https://m.jiemian.com/article/13678532.html), [应用宝 实习僧](https://sj.qq.com/appdetail/com.shixiseng.activity) |
| **国家大学生就业服务平台 (24365, ncss.cn)**, run by the Ministry of Education | No public API found, but an established **岗位共享 (job-sharing)** programme | 2022: technical job-sharing integrations with 22 provincial graduate-employment bodies and 526 universities, plus joint publishing with 12 social recruiting agencies. 2025: MoE pledged more sharing with social recruiters and over 19M shared postings for the class of 2025. | **Pursue as an official partner channel** once licensed. Most defensible campus inventory. | likely: [The Paper 2022](https://m.thepaper.cn/newsDetail_forward_17845334), [STDaily 2025-09](https://www.stdaily.com/web/gdxw/2025-09/28/content_409317.html), [People's Daily 2025-06](https://paper.people.com.cn/rmrb/pc/content/202506/07/content_30077770.html) |
| **Company career sites** (self-built, or hosted on **北森 Beisen**, **Moka**, **飞书招聘** (*.jobs.feishu.cn), 大易) | Public pages; vendor APIs are customer-only (Moka's needs a CSM-issued key) | Big employers (ByteDance, Tencent, Alibaba, Meituan, Baidu) post 校招 on their own portals. Beisen is #1 in China HCM SaaS (15.3% share, IDC H1-2023; "#1 in recruiting management five years running" per later IDC coverage). | **Two uses.** (1) Curated, source-attributed **校招日历** entries: company, 届别 window, 网申 open/close dates, link out. (2) The **网申 autofill extension** runs on these pages, user-initiated, filling the user's own data. Avoid bulk crawling of JD bodies without permission. | likely: [Digitaling Beisen](https://www.digitaling.com/articles/1012171.html), [Moka MCP (CSM key)](https://claudemarket.ai/mcp/mingyangsun-sketch/moka-mcpserver), [Feishu recruiting](https://www.feishu.cn/content/feishu-recruiting-new-talent-advantages); inferred: strategy |
| Campus aggregator sites and community lists (e.g. 牛企直聘 campus.niuqizp.com, GitHub "Campus2026" crowd list) | No | Show demand for deadline aggregation. Licensing and redistribution rights are unclear. | Content inspiration only; build our own calendar. | likely: [niuqizp](https://campus.niuqizp.com/deadline-internet-all-2/), [GitHub Campus2026](https://github.com/namewyf/Campus2026) |
| Paid scrapers (Apify 51job and 104 scrapers, etc.) | n/a | ToS and PIPL risk. Criminal precedent for scraping resumes (see below). | **Do not use.** | likely: [Apify 51job](https://apify.com/saswave/51jobs-scraper/api/python) |

### 2.2 The scraping precedent

A Beijing company founded in 2014, selling recruiting tools and big data, ran a crawler team from 2015 to 2019. It used proxy IPs and forged device IDs to pull resumes from major job sites without authorisation. Prosecutors identified more than 210M records with crawler signatures. The final judgment fined the company **RMB 40M** and gave the legal representative **7 years** plus a RMB 10M fine, described as the heaviest in such cases. Press link it to 巧达科技. The 2017 SPC/SPP interpretation sets low thresholds: 50 records of certain categories, 500 of others, or RMB 5k in profit. *(likely: [secrss/Xinhua](https://www.secrss.com/articles/10845), [secrss](https://www.secrss.com/articles/39162), [China Law & Practice 2017 interpretation](https://chinalawandpractice.com/2017/07/27/interpretation-on-several-issues-concerning-the-application-of-the-law-in-the-handling-of-criminal-cases-involving-the-infringement-of-the-personal-information-of-citizens))*

That case was about **resumes** (PI). Scraping **job postings** is mainly an unfair-competition and ToS risk, but the 2026 notice adds a duty to cite the original source. *(inferred)*

### 2.3 Recommended inventory strategy *(inferred)*

1. **P0**: GoHire bank, with GoHire's licence and employer verification, plus user-imported jobs ("粘贴 JD 链接或文本" into the tracker, as Jobright lets users add external jobs).
2. **P0**: a curated 校招日历 (company, 届别 eligibility window, 网申 open/close, 笔试/面试 waves, official link), built by an editorial and ops team plus an LLM extractor run **only on official announcements**.
3. **P1**: 24365 job-sharing partnership; university career-centre partnerships (these employment offices publish 宣讲会 and 双选会 schedules); 牛客/实习僧 partnerships for 内推 and internships.
4. **P2**: employer-side feeds (employers post to GoHire, and GoApply consumes them), and possibly 51job distribution for GoHire employers.

---

## 3. What Chinese job seekers expect

### 3.1 Market size and segments

- **Class of 2026: about 12.7M graduates**, up 480k year on year (MoE Nov-2025, repeated by MOHRSS in Mar-2026). Mid-2026 MoE ran a "百日冲刺" with over 4,000 campus events and over 5M postings. The 2026 autumn special (from 2026-09-20) targets the **class of 2027**. *(likely: [The Paper](https://www.thepaper.cn/newsDetail_forward_32005999), [HK01](https://global.hk01.com/%E5%A4%A7%E5%9B%BD%E5%B0%8F%E4%BA%8B/60296221/2026%E5%B1%8A%E5%86%85%E5%9C%B0%E5%A4%A7%E4%B8%93%E9%99%A2%E6%A0%A1%E6%AF%95%E4%B8%9A%E7%94%9F%E9%A2%84%E8%AE%A11270%E4%B8%87-%E5%86%8D%E5%88%9B%E5%8E%86%E5%8F%B2%E6%96%B0%E9%AB%98), [STDaily 2026-09-20](https://www.stdaily.com/web/gdxw/2026-09/20/content_584569.html))*
- **Civil-service exam (国考) 2026: 3.718M applicants passed review** for 38.1k posts (about 98:1), a record. It has risen every year (2023 about 2.6M, 2024 over 3M, 2025 3.416M). Written exam was 2025-11-30. 考公/考编 is a parallel track many graduates pursue. *(likely: [BJNews](https://m.bjnews.com.cn/detail/1761479397168803.html), [Xinhua](https://www.news.cn/politics/20251130/7da14327e1c24cafbf0af0a287a2f085/c.html))*
- **AI adoption.** A 智联 2026 survey reports 51.9% of respondents already use AI in job search (65.9% of new grads), 87.2% are interested in a dedicated AI job tool, the top wish (71.5%) is "auto-match jobs and tailor my resume", and the top pain point (57.6%) is unclear positioning. This is a platform self-survey. *(likely: [CSDN 2026-07-30](https://www.csdn.net/article/2026-07-30/163325820), [BJNews](https://www.bjnews.com.cn/detail/1784202970129697.html))*
- **AI-role hiring surge.** 脉脉 reports AI postings up 12× in Jan–Feb 2026 with an average monthly salary of RMB 60,738. AI roles were 38% of campus postings in Jan–May 2026, versus 26% a year earlier. ByteDance and Alibaba campus drives are 70–80%+ AI or tech. *(likely: [BJNews 脉脉](https://www.bjnews.com.cn/detail/1785917407129269.html), [Sina 2026-08-18](https://finance.sina.cn/tech/2026-08-18/detail-ininuefe8581733.d.html))*

### 3.2 The campus calendar (校招), class of 2027 as of Oct 2026

| Window | What happens | Examples |
|---|---|---|
| Spring (Mar–May) | **暑期实习** (summer internships, often with return offers) and 春招 补录 for the outgoing class | ByteDance Seed LLM campus and intern 网申 2026-04-02 → 06-01; Beisen 26 spring 2026-03-06 → 05-06 |
| Jun–Jul | **提前批** (early batch), talent programmes, internship-to-offer conversion | 2027 early batches opened late June (Hesai, DJI, vivo, iFlytek and others); ByteDance AI-PM early-bird 2026-07-14 → 08-02 |
| Aug–Sep | **正式批** (main batch): 网申 peak, 笔试 waves, interviews | ByteDance main campus from 2026-08-03 (grads Sep-2026 → Aug-2027); Meituan 2026-08-17 (grads Nov-2026 → Oct-2027); Tencent CSIG 2026-07-31 → 09-30; Tencent AI-new-tech 2026-08-27 → 10-26 |
| Late Aug–Oct | Banks (joint-stock first, the big six mid-to-late Sep), operators, SOEs/central SOEs | China Mobile and Unicom special batches Jul–Sep; State Grid early batch Sep–Oct (forecasts) |
| Oct–Dec | Offers (often Oct–Nov), 补录 (supplementary rounds), 国考 written exam (late Nov) | Example cycle: 网申 Aug → 笔试 Sep → interviews Sep–Oct → offers Oct–Nov |
| Feb–Apr | **春招** for unplaced grads ("金三银四") | n/a |

Evidence (likely): [Tencent News 2026-06-29](https://view.inews.qq.com/a/20260629A064VY00), [Sina 2026-08-18](https://finance.sina.cn/tech/2026-08-18/detail-ininuefe8581733.d.html), [gwy.com bank and SOE forecasts](https://m.gwy.com/gqzp/411503.html), [niuqizp schedules](https://campus.niuqizp.com/deadline-internet-all-2/).

**Product implications** *(inferred)*:
- Each employer's eligible **graduation window (届别 + 毕业时间区间)** differs. ByteDance takes Sep-2026 to Aug-2027 grads, Meituan Nov-2026 to Oct-2027. Eligibility must be a first-class filter.
- Track **deadlines** (网申截止), not just postings.
- Pipeline stages are 网申 → 测评 → 笔试 → AI面试 → 一面/二面/HR面 → Offer → 三方 (tripartite agreement), not the US Applied → Interview → Offer.

### 3.3 Application mechanics seekers want automated

- **网申 forms are long and repetitive.** One vendor-sourced claim puts a manual application at about 19.2 minutes versus about 48 seconds with autofill. That figure is from the vendor's own logs, so discount it. Forms cover education, internships, projects, awards, family members and other non-standard fields. Autofill tools target **北森, Moka, 大易** and self-built big-tech portals. Feishu support is unverified. *(likely: [CSDN test article](https://damodev.csdn.net/6a4244ab662f9a54cb85b0ea.html), [CSDN 塔塔网申](https://gitcode.csdn.net/6a26643f10ee7a33f2794be1.html))*
- Existing extensions: **塔塔网申** (fill all / fill blanks only / fill a selected region; claims over 85% success on mainstream platforms), **网申助手** (about 60 users), **Cvmax网申助手** (1k+), **一念职达** (rated medium risk for data retention), **求职喵**. Jobright Autofill shows 500k+ users but is English-site oriented. *(likely: [extscope 一念职达](https://extscope.org/extension/gcnbeoinjginiaeajpkknbmbbfbepjjg), [chromeboard 网申助手](https://chromeboard.com/extension/网申助手-kimplleefipjgniilmfkicnjmadpofec), [chromeboard Cvmax](https://www.chromeboard.com/extension/cvmax网申助手-autofill-gmmdijpemgmbjbgcpiehbnjkgacllbic))*
- **AI interviews as an early filter (2026 season).** Usually delivered through **WeChat mini programs**, **20–30 minutes**, assessing communication, logic and behavioural tendencies rather than technical knowledge. Alibaba and Ant use Beisen (AI interviewer 2.0, 300+ job models, 8 dimensions), Meituan uses 牛客, and foreign firms use them to test English. Some top internet firms ran about 50:1 admission ratios, and HR may cut 80% at the first stage. In a 2024 牛客 survey, more than half of students had received AI-interview invitations. *(likely: [Jiemian](https://m.jiemian.com/article/13678532.html), [Xinhua 2024](https://www.news.cn/tech/20241031/a02bd81b437947e6a9b0ee612cafe10e/c.html))*
- **笔试 and 测评.** Written tests (coding, aptitude/行测, personality). 牛客 hosts past papers. *(likely: [牛客 App Store](https://apps.apple.com/cr/app/%E7%89%9B%E5%AE%A2-%E5%A4%A7%E5%AD%A6%E7%94%9F%E5%AE%9E%E4%B9%A0%E6%B1%82%E8%81%8C%E6%89%BE%E5%B7%A5%E4%BD%9C%E7%A5%9E%E5%99%A8/id962209511))*
- **内推 (referrals).** Verified-employee referrals on 牛客. 脉脉 positions "好友引荐" as core and runs a 2026 internship programme with senior-student referrals. Employers hand out 内推码 (ByteDance and Feishu campus pages tell candidates to get a code from an employee). *(likely: [maimai.cn](https://www.maimai.cn/), [CSDN 脉脉 plan](https://damodev.csdn.net/6a61c4ad10ee7a33f291b18a.html), [niuqizp Feishu campus page](https://campus.niuqizp.com/job-vYr5LC5Na.html))*

### 3.4 Resume (简历) conventions on the mainland

| Element | Convention | Evidence |
|---|---|---|
| Photo | Widely expected for domestic employers (formal headshot); not universal | likely: [woshipm](https://www.woshipm.com/zhichang/166665.html), [CAS template](https://iap.cas.cn/gb/yjsjy/tzgg/202110/W020211026621714756209.docx) |
| 基本信息 (basic info) | Name, gender, birth year and month, **籍贯** (native place), email, phone, address; optional **政治面貌** (political status; little value outside SOEs and government); some templates ask for **生源所在地** (pre-university hukou) | likely: [woshipm](https://www.woshipm.com/discuss/25083.html), [CAS template](https://iap.cas.cn/gb/yjsjy/tzgg/202110/W020211026621714756209.docx) |
| 求职意向 (job objective) | Target role matching the posting; employer, role and "是否接受调剂" (open to reassignment) on campus forms | likely: same |
| Expected salary | Often left off the resume; collected as structured platform fields | likely: [woshipm](https://www.woshipm.com/zhichang/166665.html) |
| New-grad sections | Education first, with school tier and GPA or rank; **实习经历** separate from work; 项目经历 (role, method, result); 技能/证书 (**CET-4/6**, IELTS/TOEFL, software, licences); 获奖 (scholarships, competitions); 自我评价 (3–5 sentences) | likely: [ResumeGeni China](https://resumegeni.com/zh-hans/blog/how-to-write-resume-china) |
| Length | 1–2 pages; Chinese and English bilingual versions common (超级简历 auto-translates zh↔en) | likely: [WonderCV App Store](https://apps.apple.com/cn/app/%E7%AE%80%E5%8E%86-%E8%B6%85%E7%BA%A7%E7%AE%80%E5%8E%86wondercv-%E4%B8%93%E4%B8%9A%E6%B1%82%E8%81%8C%E7%AE%80%E5%8E%86%E5%88%B6%E4%BD%9C%E6%A8%A1%E6%9D%BF/id1327732591) |
| School tier | 985/211/双一流 tiers drive screening, and Shanghai's hukou scoring historically tiered by school. Overseas returnees list QS/THE rank. | likely: [Sina 2018](https://news.sina.cn/gn/2018-08-07/detail-ihhkuskt3272957.d.html?vt=4), [ResumeGeni](https://resumegeni.com/zh-hans/blog/how-to-write-resume-china) |

**PIPL tension** *(inferred)*: 籍贯, 政治面貌, birth date, photo and gender are expected on Chinese resumes but are over-collection risks on a platform. Make each **optional, never required, never a match-ranking input**. Keep them out of the LLM prompt unless the user is generating a resume and opts in.

### 3.5 Structured job-intent fields (求职期望), modelled on BOSS直聘 conventions

- **求职状态 (job-search status)**, four options: 离职-随时到岗 (left, available now), 在职-月内到岗 (employed, can start within a month), 在职-考虑机会 (employed, open to offers), 在职-暂不考虑 (not looking). *(likely: [ali213 feature write-up](https://m.ali213.net/android/137873.html))*
- **Salary format**: monthly band in thousands of RMB, with an optional months-per-year suffix, e.g. **"15-25K·13薪"**. Job cards show salary, city, experience, education, job type, posting time, skill tags and benefits. *(likely: [clawhub BOSS skill](https://clawhub.ai/codenova58/boss-zhipin), [Rest of World](https://restofworld.org/2023/china-job-finding-app/))*
- Other fields *(inferred from the above plus common practice)*: 期望职位 (multi-select), 期望行业, **期望城市** (multi-select; tier-1 and new-tier-1 cities), 期望薪资 (K/月 band), 工作性质 (全职/实习/兼职), **实习: 每周到岗天数 + 实习时长** (days per week and duration for internships), 到岗时间 (start date), **毕业届别 + 学历 + 院校层次**, 是否接受调剂.
- **户口 (hukou) as a job attribute.** Shanghai's non-local new-grad hukou score threshold stayed at **72** for 2026, scored on graduate and employer factors; employer eligibility matters. Beijing has no new-grad scoring; it relies on **进京指标** (employer quotas), and over half of central SOEs cut quotas in a 2025 tracker. *(likely: [Bendibao SH](https://m.sh.bendibao.com/zffw/305726.html), [Sina tracker](https://t.cj.sina.com.cn/articles/view/1673438413/63bea4cd01901e49o), [Caixin 2026-02](https://www.caixinglobal.com/2026-02-06/beijings-youth-workforce-shrinks-as-city-enforces-strict-residency-limits-102412027.html))*

  This is the **Chinese analogue of Jobright's H1B filter**: tag jobs "可解决户口/落户" (can provide hukou), "央国企" (central or state-owned), "事业编/编制" (public-institution staff post) and "外企" (foreign firm), but only when an official source supports the tag. *(inferred)*

---

## 4. Competitor landscape: how Chinese AI job copilots present themselves

| Product | Owner | Seeker-facing AI features | Surface / price | Confidence / evidence |
|---|---|---|---|---|
| **职悟空** | 智联招聘 | Launched 2026-07-18 at WAIC for new grads and 1–3-year professionals. Five modules: **个人画像** (positioning), **简历定制** (tailoring from real experience), **岗位匹配** (from 智联's job DB, claims "no fake jobs"), **模拟面试** (role-specific), **Offer 分析** (compare offers). Claims a "career long-term memory" across sessions. Proactive nudges at key moments. Reported to build profiles on Qwen3. Weak for senior users. | **Web + WeChat mini program, no app download, guest mode; free for now** | likely: [ITHome 2026-09-20](https://www.ithome.com/1/004/863.htm), [aibase](https://www.aibase.com/zh/news/20112) |
| **BOSS直聘 AI** | Kanzhun | Agent spans multi-turn intent clarification, resume optimisation, direction advice, job recommendations, fit judgement and **mock interviews**. Mock interviews: free tryout for newcomers, then a report with what each question tests and reference approaches. 2025 grey-tests used DeepSeek-R1. AI search returns job-search strategy and resume guides. | App; core free; Q2-2026 revenue RMB 2.399B | likely: [Eastmoney Q2-2026](https://caifuhao.eastmoney.com/news/20260827190816423311200), [The Paper 2025](https://www.thepaper.cn/newsDetail_forward_30528401), [Xinhua 2025-08](https://www.news.cn/tech/20250821/096f71c1eaed4dee8ade54c8fd6f5433/c.html) |
| **猎聘** | Tongdao Liepin | "AI 职位透镜" (resume vs job match report), "AI 智投" (proactive job push for 30 days), **AI 模拟面试** as a paid IAP (US$8.99 on the store page); Doris is the B2B AI interviewer | App; paid add-ons | likely: [App Store](https://apps.apple.com/py/app/%E7%8C%8E%E8%81%98-%E4%B8%93%E4%B8%9A%E6%8B%9B%E8%81%98app/id540996859?l=en-GB) |
| **超级简历 WonderCV** | WonderCV | Resume scoring and error checks, sample cases, keyword-driven rewriting, zh↔en translation, AI tutor, job recommendations | App, web, mini program; membership (one 2024 complaint cites a RMB 39 monthly membership) | likely: [WonderCV App Store CN](https://apps.apple.com/cn/app/%E7%AE%80%E5%8E%86-%E8%B6%85%E7%BA%A7%E7%AE%80%E5%8E%86wondercv-%E4%B8%93%E4%B8%9A%E6%B1%82%E8%81%8C%E7%AE%80%E5%8E%86%E5%88%B6%E4%BD%9C%E6%A8%A1%E6%9D%BF/id1327732591), [Heimao complaint](https://tousu.sina.com.cn/complaint/view/17372759820/), [ai-bot.cn](https://ai-bot.cn/app/57490.html) |
| **脉脉 Maimai** | Taou | 内推 (friend referrals), 职言 (verified-employee company talk, formerly an anonymous zone that regulators ordered rectified), 人脉发现 (post a networking need, get matches); DeepSeek-R1 integrated in 2025-02 | App | likely: [maimai.cn](https://www.maimai.cn/), [Jiemian](https://m.jiemian.com/article/7332814.html), [BJNews](https://www.bjnews.com.cn/detail/1785917407129269.html) |
| **牛客 Nowcoder** | Nowcoder | 内推, 笔试 question bank, AI-interview practice for tech roles; B2B AI-interview vendor (Meituan) | App, web | likely: see §3.3 |
| **北森 Beisen** | Beisen (09669.HK) | Employer-side AI interviewer 2.0 (300+ job models) used by Alibaba and Ant; also hosts many 网申 portals | B2B | likely: [Jiemian](https://m.jiemian.com/article/13678532.html) |
| Mock-interview apps | Various | **鹅来面/OfferGoose** (resume + JD questions; scores expression, logic and STAR completeness), **智面星** (facial expression, pace and volume), **面试猫** (behavioural questions, mini program), **Offerin AI** (English interviews for returnees and foreign firms) | Mostly freemium | likely: [CSDN 2026-06-09 comparison](https://gitcode.csdn.net/6a27702110ee7a33f2799081.html) (promotional) |
| Real-time interview cheating helpers | Various (e.g. "AI 辅助面试 提词器" apps) | Live answer prompting during real interviews | Apps | likely: [App Store 面试牛牛](https://apps.apple.com/cn/app/%E9%9D%A2%E8%AF%95%E7%89%9B%E7%89%9B-ai%E8%BE%85%E5%8A%A9%E9%9D%A2%E8%AF%95%E5%8A%A9%E6%89%8B%E6%8F%90%E8%AF%8D%E5%99%A8%E6%99%BA%E8%83%BD%E7%AD%94%E9%A2%98%E5%AE%9A%E5%88%B6%E7%AE%80%E5%8E%86%E7%A5%9E%E5%99%A8/id6743431889); **do not build** (inferred: reputational and ethics risk) |

**Positioning implications** *(inferred)*:
- The incumbent copilot (职悟空) is **free**, **mini-program-first** and leads with **memory** and **"no fake jobs"**. GoApply can't win on inventory, so it should win on being **cross-platform and employer-neutral**:
  - one profile → many 网申 portals (autofill);
  - a unified tracker across BOSS, 智联, official portals and 内推;
  - AI-interview simulation in the formats Beisen and 牛客 actually use;
  - 校招 deadline intelligence.
- Copy should be pragmatic and reassuring ("帮你少填表、不错过截止、面试不慌"), not hype. Chinese competitors foreground free trials, reports and concrete time saved.

---

## 5. Platform requirements: surfaces, login, payments

### 5.1 Surfaces

- **WeChat mini program first.** 职悟空 ships web plus mini program with no download, and employer AI interviews run in mini programs. Mini programs need filing (mandatory before listing since 2023-09-01) and a service category whose qualifications match. Recruitment categories will likely ask for the HR-service licence; confirm in the WeChat backend. *(likely: [secrss mini-program filing](https://www.secrss.com/articles/57561); inferred: category licence)*
- **H5/web at goapply.top**: filed domain, mainland hosting.
- **Native apps later.** App filing is required, and Apple CN needs the filing number. Android has fragmented stores (Huawei, Xiaomi, OPPO, vivo, Tencent 应用宝). *(likely: [ITHome Apple](https://www.ithome.com/0/734/605.htm))*
- **网申 autofill browser extension.** Jobright's autofill is a Chrome extension. Chrome Web Store reachability from the mainland is unverified. The Edge Add-ons store is used by mainland vendors (a Qihoo 360 extension shows 2M+ users there) and registration is free. 360 and QQ browsers are Chromium-based. **Publish to Edge Add-ons plus the Chrome Web Store, and test reachability on all three carriers.** *(likely: [Edge add-ons 360 listing](https://microsoftedge.microsoft.com/addons/detail/360網頁安全防護/okdacpiidbbphpjpfmecjjhicomjdeie?hl=zh-HK), [Aliyun dev article](https://developer.aliyun.com/article/1627657); inferred: strategy)*

### 5.2 Login and identity

- **Phone + SMS OTP is required** (real-name, see §1.1). SMS providers such as Aliyun need an **approved enterprise qualification**; personal ones can't be used. *(confirmed: [Aliyun SMS signature real-name](https://help.aliyun.com/zh/sms/user-guide/real-name-reporting-of-sms-sign-name?), [Aliyun policy quick view](https://help.aliyun.com/zh/sms/policy-quick-view))*
  - Each **signature** must be filed with the carriers. Use the company name or abbreviation or a registered trademark; app, official-account and website-filing sources are no longer accepted, and "已上线APP" was dropped from 2026-04-27. Filing takes **7–10 working days**.
  - Carriers now restrict content. China Telecom bans links, IPs and contact details in SMS from 2025-05-20; Unicom and Mobile added template filing and "traffic-diversion" interception in 2025.
  - **Implication** *(inferred)*: OTP-only SMS with no links. Re-engagement goes through WeChat service notifications or subscribe messages, not SMS.
- **WeChat login**:
  - *Web:* WeChat Open Platform website app. Needs developer verification (commonly cited as RMB 300 for mainland entities, with legal-rep face check, corporate account and RMB 0.1 verification transfer), a **filed domain**, app review, then a separate request for login permission.
  - *Mini program:* wx.login plus the **phone-number quick-verification component**, billed per successful call: RMB 0.03 (quick) or 0.04 (real-time), with 1,000 free trial calls (2023 pricing; re-check). If the account runs out of balance the phone sheet fails silently, so build a fallback.

  *(likely: [Tencent Cloud dev community](https://cloud.tencent.com/developer/information/%E5%B0%8F%E5%BE%AE%E7%A1%AC%E4%BB%B6%E5%BC%80%E6%94%BE%E5%B9%B3%E5%8F%B0%E4%BB%B7%E9%92%B1), [Authing docs](https://docs.authing.cn/v2/guides/wechat-ecosystem/wechat-web-app.html), [ITHome 2023](https://www.ithome.com/0/702/003.htm), [WeChat docs](https://developers.weixin.qq.com/miniprogram/en/dev/framework/open-ability/getPhoneNumber), [V2EX](https://www.v2ex.com/t/952436))*
- **Do not offer** Google or Apple-only sign-in as the primary path. Apple sign-in is still needed in iOS apps if other social logins exist (App Store rule; inferred). LinkedIn is not a meaningful identity provider in the mainland (inferred).

### 5.3 Payments and pricing

- **WeChat Pay**: JSAPI inside WeChat (official account and mini program), **Native** QR for PC web, **H5** for mobile browsers outside WeChat (needs authorised domain and Referer; not callable inside WeChat's browser). Merchant onboarding needs a mainland business licence, a corporate account and the legal rep's ID. Most guides assume a filed site. *(likely: [PingPong WeChat Pay notes](https://acquirer-api-docs-v4.pingpongx.com/notes/zh/paymentMethods/WeChatPay/), [WeChat Pay H5 intro](https://pay.weixin.qq.com/wiki/doc/api_external/en/open/chapter3_6_1.shtml), [Huawei Cloud site-builder doc](https://support.huaweicloud.com/adaptive-cloudsite/adaptive_8001.html))*
- **Alipay**: PC website, mobile web and in-app payments. Enterprise entity plus filed site expected. *(inferred; not fetched)*
- **iOS mini programs.** Before Nov 2025, iOS mini programs could not sell virtual goods. On **2025-11-14** Apple launched a Mini Apps Partner Program: **15%** commission on eligible digital goods through Apple IAP, with conditions (host app on the App Store, age-range and advanced-commerce APIs, refund data sharing). WeChat announced iOS virtual-payment support the same day. Subscription-specific rates are unverified. *(likely: [Huxiu](https://www.huxiu.com/article/4805952.html), [ITHome](https://www.ithome.com/0/897/349.htm), [Digitimes](https://www.digitimes.com/news/a20251117PD205.html))*
- **Price anchors**: 职悟空 free; 超级简历 about RMB 39/month; 猎聘 AI mock interview about US$8.99 per pack (store listing). *(likely; sources in §4)*
- **Licence dependency**: charging needs the operating ICP licence (§1.1). Seekers may not be charged deposits and fees must be published (network-recruitment rules Art. 19).

---

## 6. Engineering requirements: hosting, data, LLMs, real-time voice

### 6.1 Hosting and network

- **Vercel**: no servers or CDN nodes in the mainland; *.vercel.app may be blocked or throttled per ISP; in-country hosting needs an ICP; Vercel cannot guarantee availability. It suggests a custom domain, self-hosted fonts and analytics, and a mirror or in-country deployment if reliable access matters. It does **not** recommend a proxy in front of a deployment. Guide published 2025-11-03, updated 2026-09-11. *(confirmed: [Vercel KB](https://vercel.com/kb/guide/accessing-vercel-hosted-sites-from-mainland-china))*
- **Cloudflare China Network**: Enterprise-only add-on; needs a valid ICP for each apex, the ICP number in the footer, and **JD Cloud content vetting** (even for a PoC). Not every product is available. IPv6 is mandatory for internet-facing services in the mainland and is auto-enabled. *(confirmed: [Cloudflare China Network FAQ](https://developers.cloudflare.com/china-network/faq/), [get started](https://developers.cloudflare.com/china-network/get-started/))*
- **Recommendation** *(inferred)*:
  - Run GoApply as a **separate deployment** (same monorepo, brand flag) on **Aliyun ACK/ECS or Tencent Cloud** in a mainland region (Shanghai or Beijing), with **ApsaraDB/TencentDB Postgres** (Prisma-compatible) and OSS/COS for resume files.
  - Use a mainland CDN (Aliyun CDN, Tencent EdgeOne CN) with IPv6.
  - Keep Next.js and Express as containers. Do not proxy from Vercel.
  - Self-host fonts. RoboApply currently uses Google Fonts (Inter and Instrument Sans) per project memory, and those must be bundled.
  - Remove Google Analytics, Sentry SaaS, cdnjs/jsdelivr and other overseas third-party endpoints, or swap them for domestic equivalents.
- **No cross-border data plane** (see §1.3). RoboApply's Neon us-east-1 DB, OpenRouter and Anthropic must never receive GoApply user data. Brand-level config must hard-fail if a GoApply request resolves to a non-CN model or DB URL. *(inferred)*
- **GoHire bank link security.** Internal memory notes the GoHire Postgres is reached over the public internet with `sslmode=disable`. Fix with VPC peering or a private link plus TLS before any CN launch. *(confirmed internal: project memory `crossbank-jobsearch-agent-team.md`)*

### 6.2 LLMs available domestically (status as of Oct 2026; verify before wiring)

| Vendor / platform | Current models (per 2026 coverage) | Notes | Confidence / evidence |
|---|---|---|---|
| **DeepSeek** (api.deepseek.com) | **V4-Pro** and **V4-Flash**, 1M context, thinking toggle, JSON, tools, OpenAI Responses API format. V4 preview 2026-04-24, Pro GA 2026-08-13. | **Peak/off-peak pricing from 2026-08-17.** Peak is Beijing 09:00–12:00 and 14:00–18:00; off-peak is half of peak. V4-Pro peak per 1M tokens: about RMB 9 input (cache miss) and 27 output. `deepseek-chat` and `deepseek-reasoner` deprecated 2026-07-24 as aliases to v4-flash. | likely: [Caixin Global 2026-08-14](https://www.caixinglobal.com/2026-08-14/tech-brief-aug-14-deepseek-launches-v4-pro-and-raises-api-prices-by-as-much-as-1100-102474222.html), [Wallstreetcn](https://wallstreetcn.com/articles/3779377), [ifeng](https://tech.ifeng.com/c/8vYt8W2gwlg) |
| **Alibaba Qwen** (Model Studio / 百炼, DashScope) | **Qwen3.8-Max** (2026-08-03; about 1M context API, vision), qwen3.7-plus, qwen3.8-flash. Qwen3.5 now listed as legacy. | Region-specific pricing. Also hosts **Paraformer** real-time ASR and **CosyVoice** TTS. | likely: [Aliyun model list](https://help.aliyun.com/zh/model-studio/models), [datalearner](https://www.datalearner.com/ai-models/pretrained-models/qwen3-8-max), [qbitai](https://www.qbitai.com/2026/02/382054.html) |
| **Moonshot Kimi** | **Kimi K3** (2026-07-16; 2.8T params, vision, 1M context, open weights 07-27); **kimi-k2.6** API. **K2 series API retired 2026-05-25.** | Rapid model churn. | likely: [STDaily](https://www.stdaily.com/web/gdxw/2026-07/17/content_548916.html), [QQ News](https://news.qq.com/rain/a/20260526A02G8T00) |
| **Zhipu GLM** (bigmodel.cn) | **GLM-5.2** (2026-06-15; 744B MoE, 1M context, text/code), **GLM-5.3** (2026-08-14, coding) | Zhipu offered a Claude→GLM migration kit after Anthropic's restriction. | likely: [Zhipu release notes](https://docs.bigmodel.cn/cn/update/new-releases), [Sina](https://finance.sina.com.cn/tech/digi/2026-08-14/doc-ininhhrs2630952.shtml) |
| **ByteDance Doubao** (Volcano Engine Ark / 火山方舟) | **Seed 2.0 Pro / Lite / Mini / Code** (2026-02-14) | Base `ark.cn-beijing.volces.com/api/v3`. Pairs with Volcano RTC conversational AI and Doubao ASR/TTS. | likely: [Volcano dev article](https://developer.volcengine.com/articles/7610285824933445675), [Ark Chat API](https://www.volcengine.com/docs/82379/1494384?lang=zh) |

**Requirements** *(inferred)*:
- (1) Add a **per-brand model routing table**, the CN equivalent of `RA_MODEL_*`. Every agent role (parser, matcher, tailor, interviewer, coach) maps to a CN model ID, with OpenAI-compatible clients.
- (2) Use the **model-churn guardrail** that already exists in RoboApply memory (dated slugs break). Pin snapshot IDs and run a startup probe like `verify:llm`.
- (3) Run batch work (bulk match scoring, digest generation) **off-peak** for DeepSeek.
- (4) Keep an **in-product disclosure** block listing model names and filing or launch numbers.
- (5) Prompt locale: the existing `getStrictOutputLanguageDirective(locale,'content')` must default to zh-CN for GoApply.
- (6) Thinking-model token budgets: the existing "reasoning-token budget starvation" lesson applies to DeepSeek V4 thinking mode and Qwen thinking modes.

### 6.3 Real-time voice and video mock interviews ("also fix the video live interview issues")

**Facts**
- **LiveKit Cloud region groups**: US, Asia Pacific (Japan, Singapore), Canada, EU, India, Middle East, Africa, Australia, Israel, South America. **No mainland China or Hong Kong.** Agent deployment regions: us-east, eu-central, ap-south. *(confirmed: [LiveKit regions](https://docs.livekit.io/deploy/admin/regions/endpoints))*
- RoboApply's current worker (`interview-agent/`) uses LiveKit Cloud and LiveKit Inference: Deepgram nova-3 STT, gpt-5.4 LLM, Cartesia sonic-3 TTS, plus an OpenAI TTS floor. **None of these is usable for mainland users** (vendors not domestic; OpenAI blocked). *(confirmed internal: project memory `livekit-interview-worker.md`; likely: OpenAI block in §1.5)*
- **Self-hosted LiveKit OSS**:
  - Needs a domain with a publicly trusted certificate and a separate TURN domain and certificate.
  - The embedded TURN with **TURN/TLS on 443** gives the widest firewall coverage; set `rtc.use_external_ip`.
  - In mainland China it needs an ICP-filed domain and mainland cloud (Aliyun, Tencent, Huawei). Test China Telecom, Unicom and Mobile separately.
  - One Chinese developer found LiveKit's built-in TURN beat their separate TURN server.

  *(confirmed: [LiveKit self-hosting](https://docs.livekit.io/transport/self-hosting/deployment/); likely: [Vonage China relay guide](https://developer.vonage.com/en/blog/china-relay-eol-build-your-own-relay-with-vonage-video-api), [Juejin](https://juejin.cn/post/7467852027822506011))*
- **Domestic conversational-AI RTC options**:
  - **Volcano Engine RTC 实时对话式AI**: RTC plus Doubao ASR, LLM and TTS; interruption; client-side VAD; about 1s end-to-end (vendor claim). API is `StartVoiceChat` / `UpdateVoiceChat` / `StopVoiceChat`. *(likely: [qbitai 2024-08](https://www.qbitai.com/2024/08/182911.html), [EMQX Volcano RTC API](https://docs.emqx.com/zh/emqx/latest/emqx-ai/rtc-services/volcengine-rtc/api.md))*
  - **Agora 对话式AI引擎** (Mar 2025): RMB **0.098/min**, 650ms median latency, 340ms interruption (vendor claims). *(likely: [China.com](https://m.tech.china.com/redian/2025/0306/032025_1644651.html), [qbitai](https://www.qbitai.com/2025/03/262255.html))*
  - **Tencent TRTC Conversational AI**: about US$0.01/min service fee plus US$0.02/min built-in STT (international pricing); LLM and TTS billed separately; up to 10k free minutes/month with a TRTC monthly package; has an **"AI Interview"** solution doc. *(likely: [trtc.io AI interview](https://trtc.io/document/75309), [TRTC pricing blog](https://trtc.io/blog/details/conversational-ai-pricing-2026), [Tencent CN doc](https://www.tencentcloud.com/zh/document/product/647/52816))*
  - **Aliyun AI 实时互动** (ARTC + 百炼 agents): mainland audio RMB 0.098/min bundled; supports Qwen, 百炼, custom OpenAI-compatible LLMs; interruption, hotwords, sensitive words, recording, archiving. DeepSeek-R1 and QwQ are not supported for voice. Agents auto-generated from 百炼 cannot be edited. **Paraformer-realtime-v2** ASR costs RMB 0.00024/s (about RMB 0.0144/min, list price) and supports dialects and hotwords. *(likely: [Aliyun IMS basic features](https://help.aliyun.com/zh/ims/user-guide/conversational-ai-basic-features/), [Paraformer](https://help.aliyun.com/zh/model-studio/paraformer-realtime-v2), [Aliyun AI realtime](https://help.aliyun.com/zh/ims/ai-realtime-interaction))*

**Recommendation** *(inferred)*:
1. Introduce a **`VoiceSessionProvider` seam** in `server/src/interview-engine`: create room or session, mint client token, dispatch agent, receive transcript and lifecycle callbacks. Implement `livekit-cloud` (RoboHire.io) and `cn-*` (GoApply).
2. **GoApply path A (preferred for code reuse)**: self-hosted LiveKit server on Aliyun Shanghai with TURN/TLS:443 on an ICP domain. Run the same `interview-agent` worker under a distinct agent name (e.g. `GoApply-Interview`, following the existing rule that a shared agent name causes cross-product dispatch). Use LiveKit Agents plugins pointed at **Paraformer/Doubao ASR**, **Qwen/DeepSeek/Doubao LLM** (OpenAI-compatible) and **CosyVoice/Doubao TTS**. Custom STT/TTS plugin adapters may be needed.
3. **Path B (fastest to ship)**: Volcano RTC conversational AI or TRTC AI Interview. Less control over turn-taking, but managed and mainland-native.
4. **Interview format**: replicate employer AI interviews. 20–30 minutes; competency questions (communication, logic, behavioural), timed answers, optional "video on". Report covers dimensions (Beisen-style), STAR completeness, filler words and suggested answers.
5. **Compliance**: recording consent screen; no face recognition or face templates; if expression analysis is offered, opt-in and processed in session; transcripts stored in CN; retention limit (e.g. 90 days default).

### 6.4 Job-content quality and anti-fraud
*(confirmed basis: CAC 2026 notice; implementation inferred)*

- Show the **original source** ("来源：XX 官网 / GoHire / 国家24365") on every card and detail page.
- Show **expiry/updated date**.
- Flag postings missing **basic pay** ("薪资未披露").
- Block **招转培 / 培训贷** patterns (training fees, loans, "先交钱"), MLM, gambling and telecom-fraud lures with a classifier and keyword rules. Log evidence and keep a blacklist.
- Ranking must never boost unverified or suspicious postings.

### 6.5 Privacy UX
*(basis: PIPL, NDSMR; implementation inferred)*

- First run: privacy policy and user agreement, plus a **separate consent** for resume parsing by AI and for any sensitive fields.
- Optional consents: personalised recommendations (with an off switch in settings), sharing with employers or GoHire, and mock-interview recording.
- Settings: data export, correction, deletion, account closure, withdraw consent, and an explanation of match scores ("为什么推荐").
- No address-book, location or clipboard permissions without need.

### 6.6 Localisation (zh-CN for GoApply)
*(inferred; repo has `zh` and `zh-TW` locales in `lib/localeConfig.ts`)*

- Brand strings: GoApply / goapply.top. Footer: ICP filing number, 公安备案 number, AI model disclosure, HR-service licence number.
- Salary: "15-25K·13薪"; internship pay in "元/天" (inferred convention). Cities: province → city picker with 新一线 grouping. Education enums: 大专/本科/硕士/博士 with 统招 flag; school DB with 985/211/双一流 flags; 届别 (e.g. "2027届").
- Remove US-only concepts (H1B, visa sponsorship, EEO and veteran questions, SSN). Add 户口/编制/央国企 tags, CET-4/6, 政治面貌 (optional), 籍贯 (optional) and a photo slot (optional).

---

## 7. Jobright feature → GoApply adaptation map

| Jobright capability | GoApply adaptation | Confidence / evidence |
|---|---|---|
| AI job matching ("matches in under a minute") | Match against GoHire, curated 校招 and imported jobs. Inputs: 届别 eligibility, 学历, 院校层次 (as a *user filter only*, not a ranking penalty), 期望城市/行业/薪资. Explanations satisfy PIPL Art. 24. | confirmed: [jobright.ai](https://jobright.ai/); inferred: adaptation |
| H1B sponsorship filter (built by an immigrant founder; about 30% of users are foreign workers) | **户口/落户、央国企、编制、外企** filters, only when an official source supports the tag | likely: [TechCrunch 2024-06-25](https://techcrunch.com/2024/06/25/jobright-uses-ai-to-help-foreign-workers-navigate-the-us-job-market/); inferred |
| One-click ATS autofill (Chrome extension) | **一键网申** extension for Beisen, Moka, 大易, Feishu and self-built portals: fill all, fill blanks, fill selection; field mapping for 家庭成员 / 政治面貌 / 生源地; always a human review before submit | likely: §3.3 |
| Resume AI (tailored resume per job) | Chinese resume templates (photo optional), 求职意向, 实习 and 项目 STAR rewriting, CET and awards, **bilingual zh/en export**; AI labelling per §1.4 | likely: §3.4 |
| Insider connections (LinkedIn alumni and hiring managers) | **内推 hub**: collect employer 内推码, alumni referral requests (opt-in alumni network by school), partnerships with 牛客 and 脉脉. LinkedIn is not viable in the mainland. | inferred; [maimai.cn](https://www.maimai.cn/) |
| Orion 24/7 copilot | 求职助手 with **long-term career memory** (职悟空 sets the bar), proactive deadline nudges via WeChat subscribe messages | likely: [ITHome 职悟空](https://www.ithome.com/1/004/863.htm) |
| Jobright Agent (auto-apply, launched 2025-06) | **Not on BOSS or 智联** (ToS and fraud controls). Allowed: assisted 网申 queue the user confirms one by one; no auto-greet. | likely: [The Register 2025-06-24](https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/); inferred |
| Interview prep | **AI面试 simulation** (Beisen and 牛客 format), 笔试/测评 practice, HR-interview question bank, Offer comparison (职悟空 parity) | likely: §3.3, §4 |
| Application tracker | Stages 网申 → 测评 → 笔试 → AI面试 → 面试 rounds → Offer → 三方; **校招日历** with 网申截止 alerts | inferred |

---

## 8. Taiwan (served by the international brand, RoboHire.io)

### 8.1 Job platforms and data access

- **104人力銀行** (the dominant board):
  - About 1.17M openings (Mar-2025) and over 600k job seekers per month.
  - Over 30 in-site AI tools with 86.8% AI-service usage. AI-recommended jobs give 3.2× the interview rate (company figure). PDF→104 resume import cuts build time 73%. AI resume check returns advice in about 3s.
  - **104 decided against AI interviews because of discrimination risk**; any future version would be self-practice only. Its algorithm is tuned so it does not simply follow employer preferences on gender, age or zodiac.
  - **No public jobs API.** Only the HR Max HRIS has an Open API for HR-tech partners.

  *(likely: [Inside](https://www.inside.com.tw/article/39657-ai-recruitment-104), [iThome TW](https://www.ithome.com.tw/news/161630), [104 HR Max](https://blog.104.com.tw/hr-max-exclusive-functions/), [UAnalyze](https://uanalyze.com.tw/articles/4544347429))*
- **1111**: founded 1998; over 9M job seekers and 4M employers; on AWS with GenAI. No public API found. *(likely: [AWS case](https://aws.amazon.com/tw/solutions/case-studies/1111/))*
- **Cake (CakeResume)**: AI resume checker (content, skills, sections, format, tone) live in US, TW, ID and VN; paid plan launched Nov-2025. *(likely: [Commercial Times 2025-11-21](https://www.ctee.com.tw/news/20251121700763-431204), [Cake AI](https://img.cake.me/ai))*
- **Yourator**: startup and digital talent, 25 industry categories, smaller inventory. *(likely: [Yourator](https://www.yourator.co/articles/990), [Stockfeel](https://www.stockfeel.com.tw/?p=146098))*
- **Data strategy** *(inferred)*: in Taiwan, don't scrape 104. Use employer ATS feeds where TW companies use Greenhouse, Lever or Workday (the existing RoboApply provider seam), plus partnerships with Cake/Yourator or 104 if available.

### 8.2 Law and conventions

- **Salary disclosure (Employment Services Act Art. 5(2)(6))**:
  - Since 2018-11-30, if a vacancy's **regular monthly wage is below NT$40,000**, the ad must state a range, fixed amount or minimum (no "面議" (negotiable)).
  - Fines are **NT$60k–300k**.
  - Regular wage includes base pay and fixed monthly allowances and bonuses, but excludes overtime, year-end and festival bonuses.
  - A guideline suggests ranges no wider than NT$5,000.
  - Reform toward **1.75× the minimum wage** (about NT$51,625 at a NT$29,500 minimum) is still in drafting.

  *(confirmed: [MOL](https://www.mol.gov.tw/1607/1632/1640/44243/); likely: [104 blog](https://blog.104.com.tw/the-threshold-for-salary-disclosure-will-be-raised/), [UDN](https://udn.com/news/story/7269/9673564))*

  **Product**: parse "面議" vs ranges, show "待遇面議" honestly, and offer a salary filter that treats ≥40k "面議" as unknown.
- **Resume conventions**:
  - 104 resumes have a **自傳** (autobiography) field that traditional employers still read.
  - **Photos** are generally expected by local firms and dropped for foreign firms (DEI). 104 claims a 3× interview gap with a suitable photo.
  - **期望待遇** is usually "依公司規定" for new grads or the current salary plus "面議".
  - Use a one-page English resume for foreign firms.
  - 104's 求職條件 fields (希望職稱/職類 (desired title and category), 希望地點 (location), 希望待遇 (salary)) are the core searchable fields.

  *(likely: [104 photo](https://blog.104.com.tw/should-i-post-a-photo-on-resume/), [Yourator](https://www.yourator.co/articles/465), [104 salary tips](https://blog.104.com.tw/tips-about-expected-salary/), [104 resume fields](https://blog.104.com.tw/?p=23581), [ResumeGeni TW](https://resumegeni.com/zh-hant/blog/how-to-write-resume-taiwan))*
- **PDPA**:
  - Amended (passed 2025-10-17, promulgated 2025-11-11): breach notification to data subjects and the regulator, with fines of NT$20k–200k for failing notification duties.
  - A PDPC prep office exists; it still used that name in Mar-2026.
  - Earlier 2023 amendment: security-duty fines up to NT$15M for serious cases.

  *(likely: [MOJ/PDPC prep office](https://www.chp.moj.gov.tw/311528/311989/312114/575711), [UDN](https://udn.com/news/story/7314/9077132), [Lee and Li](https://www.leeandli.com/TW/NewslettersDetail/7365.htm))*
- **AI Basic Act**: passed 2025-12-23, promulgated **2026-01-14**, 20 articles. Competent authority is the **NSTC**; MODA sets the risk-classification framework. Ministries have two years for implementing rules. *(likely: [UDN](https://udn.com/news/story/7238/9223381), [Lee and Li](https://www.leeandli.com/TW/NewslettersDetail/7566.htm), [KPMG TW](https://assets.kpmg.com/content/dam/kpmg/tw/pdf/2026/01/tw-law-monthly-alert-202601.pdf))*
- **Tax**: foreign e-service sellers to TW individuals must register, issue **cloud e-invoices** and file business tax once annual B2C sales exceed **NT$600k** (threshold effective 2025-04-07). *(likely: [World Journal](https://www.worldjournal.com/wj/story/121347/8834622), [KPMG TW](https://assets.kpmg.com/content/dam/kpmgsites/tw/pdf/2025/04/tw-KPMG-jp-news-2025-vol.07-cht.pdf))*
- **Payments**: ECPay (credit-card subscriptions; Visa token auto-update 2025-03), TapPay (NT$5,000 setup, NT$9,600/yr, 2.75% domestic cards, 3.5% foreign), NewebPay, LINE Pay, JKOPay. Foreign-company eligibility is unverified; Stripe and card billing on the international stack may be simpler. *(likely: [TechNews ECPay](https://finance.technews.tw/2025/03/12/visa-token/), [TapPay pricing](https://tappaysdk.com/taiwan-en/help/pricing), [iThome help](https://ithelp.ithome.com.tw/articles/10396944))*
- **Login**: LINE has about 22M users in Taiwan and 92% weekly usage among 15–65-year-olds, so **add LINE Login** alongside Google and Apple. *(likely: [TechNews](https://technews.tw/?p=1321003), [PTS](https://news.pts.org.tw/article/729263), [LINE Login](https://developers.line.biz/en/services/line-login))*
- **Traditional Chinese copy** *(inferred)*: 履歷 (not 简历), 職缺, 薪資/待遇, 面議, 年終, 新台幣/NT$, 自傳, 應徵, 面試, 人力銀行. Use the existing `zh-TW` locale and the i18n-locale-sync skill. Never reuse Simplified Chinese terms like 简历/岗位/网申/校招 verbatim; Taiwan says 校園徵才 for campus hiring (inferred).
- **Cross-strait separation** *(inferred)*: Taiwan users stay on RoboHire.io's international stack. Route by brand and domain, never by IP alone. Do not mix TW user data into the GoApply CN database.

---

## 9. Consolidated requirements for the GoApply.Top variant

Priority: **P0** blocks launch, **P1** needed for competitive parity, **P2** later.

### Legal / ops (P0)
- **CN-L-01** Set up a mainland operating entity. Decide whether GoApply operates under GoHire's entity (if licensed) or a new one, and check the cap-table impact on the international brand's Anthropic access.
- **CN-L-02** File the ICP for goapply.top. First verify .top filing eligibility after the 2026 registry-operator change. Get the 公安备案 too.
- **CN-L-03** Obtain the operating ICP licence before charging.
- **CN-L-04** Obtain the 人力资源服务许可证 with the 网络招聘 scope, or route all job inventory through a licensed partner.
- **CN-L-05** Complete generative-AI **登记** with the local CAC, plus an algorithm filing for recommendations if counsel agrees.
- **CN-L-06** File the mini program and app (App 备案).
- **CN-L-07** Register the SMS enterprise qualification and signature (7–10 working days).
- **CN-L-08** WeChat Open Platform developer verification; WeChat Pay and Alipay merchant accounts.
- **CN-L-09** Privacy policy, user agreement, AI-labelling terms, PIA, and a data-classification inventory.

### Data and infra (P0)
- **CN-E-01** Separate CN deployment (Aliyun or Tencent, Shanghai or Beijing) with a CN Postgres and object storage. No Vercel, Neon, OpenRouter or Anthropic in the GoApply data path. A brand-guard hard-fails any non-CN endpoint.
- **CN-E-02** Self-host fonts and assets; remove overseas analytics and CDNs; enable IPv6.
- **CN-E-03** Per-brand model routing to DeepSeek V4 / Qwen3.x / Doubao Seed 2.0 / GLM-5.x / Kimi through OpenAI-compatible clients. Snapshot pinning, startup probe, off-peak batch scheduling.
- **CN-E-04** Footer disclosure of model names and filing or launch numbers; ICP and licence numbers in the footer.
- **CN-E-05** GoHire bank access over a private network with TLS; materialise RAJob with **source attribution, expiry and pay-missing flags**.
- **CN-E-06** `VoiceSessionProvider` seam. GoApply implementation is self-hosted LiveKit (TURN/TLS:443, ICP domain) with domestic ASR/TTS/LLM, or Volcano RTC / TRTC conversational AI. Distinct agent name per product.
- **CN-E-07** AI-content labelling: in-app marker, implicit metadata in PDF/DOCX exports, and 6-month logs for any unlabelled export.
- **CN-E-08** Anti-fraud classifier for 招转培, 培训贷, MLM and fraud postings, with evidence retention and a blacklist.

### Product (P0/P1)
- **CN-P-01 (P0)** Phone + SMS OTP signup; WeChat login (mini-program phone quick-verify; web QR).
- **CN-P-02 (P0)** Onboarding that captures 身份 (应届/在校/社招), 毕业届别 and dates, 学历, 学校 (with tier flags), 专业, 求职状态 (4 options), 期望职位/城市/行业/薪资 (K/月, ·N薪), 工作性质 (全职/实习), internship availability (days per week and months), and 到岗时间. Resume upload (PDF/Word/image) with Chinese parsing; GoHire's parse-resume path already exists.
- **CN-P-03 (P0)** Chinese resume builder: optional photo, 基本信息 (optional 籍贯/政治面貌), 求职意向, 教育, 实习, 项目, 校园经历, 技能证书 (CET), 获奖, 自我评价; zh/en bilingual export.
- **CN-P-04 (P0)** **校招日历** with 网申 open/close, 笔试/面试 waves and 届别 eligibility; reminders through WeChat subscribe messages.
- **CN-P-05 (P1)** **一键网申** extension (Edge Add-ons + Chrome Web Store) for Beisen, Moka, 大易, Feishu and big-tech portals; fill all, fill blanks, fill selection; human submit.
- **CN-P-06 (P1)** **AI面试 simulation** (20–30 minutes, Beisen/牛客 style) with a multidimensional report; 笔试/测评 practice; HR-interview bank.
- **CN-P-07 (P1)** Tracker with Chinese stages up to 三方; offer comparison.
- **CN-P-08 (P1)** 内推 hub (codes, alumni requests) and 牛客/脉脉 partnerships.
- **CN-P-09 (P1)** Copilot with long-term memory and proactive nudges.
- **CN-P-10 (P1)** Membership: free core (to match 职悟空); paid tiers for unlimited tailoring, interviews and autofill. WeChat Pay, Alipay, and iOS mini-program IAP at 15%.
- **CN-P-11 (P2)** 考公/考编 track (国考/省考 calendar, 岗位 search over official announcements).
- **CN-P-12 (P2)** Overseas-job track for mainland users targeting foreign firms or abroad. Hand off to the international brand with explicit cross-border consent.

---

## 10. Open questions and risks

1. **Licensing ownership.** Does GoHire's operating entity already hold a 人力资源服务许可证 and an operating ICP licence? If yes, GoApply could be a GoHire product line. If no, which entity applies, and in which city (Shanghai is likely, given GoHire's footprint)?
2. **.top filing after the 2026 registry move.** IANA now lists a Hong Kong sponsoring organisation. Confirm with MIIT's domain registry list that .top is still fileable and that the registrar is approved. Fallback domain: goapply.cn or .com.cn.
3. **AI labelling vs user expectations.** Will an explicit "AI generated" marker on exported resumes hurt users? We need a legal opinion on whether resume text edited by the user still counts as generated content requiring explicit labels.
4. **Mock-interview video.** Is expression or tone analysis worth the face-data compliance load? Recommendation: audio-first; video optional and analysed in session with no storage.
5. **Self-hosted LiveKit vs managed CN RTC.** The cost and latency trade-off needs a carrier test from Shanghai, Beijing and Guangzhou on Telecom, Unicom and Mobile. Do the LiveKit Agents plugins support Paraformer, CosyVoice and Doubao natively, or do we need custom adapters?
6. **Algorithm filing threshold.** Does a job-recommendation feed for job seekers have "public-opinion attributes or social-mobilisation capacity"? Comparable boards (猎聘) filed.
7. **24365 job-sharing.** What are the partnership criteria, and is a licensed commercial agency enough?
8. **Extension distribution.** Is the Chrome Web Store reachable from mainland networks in 2026 without a VPN? (Not verified.) Is the 360 browser extension store worth a listing?
9. **Model volatility.** In the last six months Kimi retired K2, DeepSeek renamed and repriced, and Qwen moved 3.5 to legacy. Budget for a quarterly model-migration cycle.
10. **Taiwan payments.** Can a non-Taiwan entity contract ECPay or TapPay for recurring billing, or should TW stay on the international processor? When does the NT$600k B2C threshold trigger VAT and e-invoice registration?
11. **Cap table and Anthropic.** If a PRC-HQ investor ends up with majority control of any RoboApply/GoApply entity, Claude access may be lost for the international brand too.

---

## 11. Source index (primary first)

**Primary**
- CAC 2026 recruitment notice: https://www.cac.gov.cn/2026-01/15/c_1770207718756257.htm
- CAC AI labelling: https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
- CAC face recognition measures: https://www.cac.gov.cn/2025-03/21/c_1744259796594932.htm
- CAC NDSMR: https://www.cac.gov.cn/2024-09/30/c_1729384452126506.htm
- CAC PI export certification: https://www.cac.gov.cn/2025-10/17/c_1762449728518762.htm
- CAC algorithm list 2022-08: https://www.cac.gov.cn/2022-08/12/c_1661927474338504.htm
- PIPL: https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm
- Network recruitment provisions: https://www.gov.cn/zhengce/zhengceku/2020-12/25/content_5573141.htm
- Beijing HR licence procedure: https://rsj.beijing.gov.cn/xxgk/2024zcwj/202406/W020240617396922300833.docx
- Aliyun ICP domain prep: https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/prepare-and-check-the-domain-name
- IANA .top: https://www.iana.org/domains/root/db/top
- Aliyun SMS real-name: https://help.aliyun.com/zh/sms/user-guide/real-name-reporting-of-sms-sign-name? and policy: https://help.aliyun.com/zh/sms/policy-quick-view
- WeChat phone-number component: https://developers.weixin.qq.com/miniprogram/en/dev/framework/open-ability/getPhoneNumber
- Vercel China guide: https://vercel.com/kb/guide/accessing-vercel-hosted-sites-from-mainland-china
- Cloudflare China Network FAQ: https://developers.cloudflare.com/china-network/faq/
- LiveKit regions: https://docs.livekit.io/deploy/admin/regions/endpoints
- LiveKit self-hosting: https://docs.livekit.io/transport/self-hosting/deployment/
- Aliyun model list: https://help.aliyun.com/zh/model-studio/models
- Paraformer realtime: https://help.aliyun.com/zh/model-studio/paraformer-realtime-v2
- Aliyun AI realtime: https://help.aliyun.com/zh/ims/ai-realtime-interaction
- Zhipu release notes: https://docs.bigmodel.cn/cn/update/new-releases
- Volcano Ark: https://www.volcengine.com/docs/82379/1494384?lang=zh
- TRTC AI interview: https://trtc.io/document/75309
- Jobright: https://jobright.ai/
- Taiwan MOL salary disclosure: https://www.mol.gov.tw/1607/1632/1640/44243/
- LINE Login: https://developers.line.biz/en/services/line-login
- TapPay pricing: https://tappaysdk.com/taiwan-en/help/pricing

**Secondary**: all other links are cited inline above.

**Internal**
- `docs/CROSSBANK_JOBSEARCH_SPEC.md`
- `lib/localeConfig.ts` (zh, zh-TW locales)
- Project memory: `crossbank-jobsearch-agent-team.md`, `livekit-interview-worker.md`, `gohire-domain-is-gohire-top.md`
