// Renders tools/og-card.html to web/og.png.
// Usage: python3 -m http.server 8766 (from repo root) & node tools/render-og.mjs
// Requires `playwright` (npm i playwright) and a Chrome/Chromium install.
import { chromium } from 'playwright';

const base = process.env.OG_BASE ?? 'http://localhost:8766';
const out = process.env.OG_OUT ?? new URL('../web/og.png', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error(e));
await page.goto(`${base}/tools/og-card.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="1"]');
await page.screenshot({ path: out, type: 'png' });
await browser.close();
console.log(`wrote ${out}`);
