#!/usr/bin/env node
// scripts/check-zh-variants.mjs — Simplified/Traditional Chinese variant
// guard (CN_TW_LAUNCH_PLAN.md §4.2 WP-TW-LOCALE, §9 glossary).
//
// STUB (FND-7): wired into `npm run check` so the gate exists from Wave 1.
// WP-12 replaces it with the real term lists (i18n/glossary/zh-variants.json):
// mainland terms (简历, 视频, 软件, 默认, 用户, …) fail in zh-TW, Taiwan terms
// (履歷, 影片, 軟體, 預設, 使用者, …) fail in zh, over i18n/messages,
// i18n/staging, i18n/brands and the email bundles.

console.log('✓ zh variants — stub, no rules yet (WP-12 fills scripts/check-zh-variants.mjs)');
process.exit(0);
