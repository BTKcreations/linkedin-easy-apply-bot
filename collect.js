// PHASE 1 — COLLECT. No applications are submitted here.
// Flow: login (stay logged in) -> search URLs from resume -> scrape job URLs ->
// detect Easy Apply per job -> store everything in queue.json.
// Safe to run any time; run it first, review queue.json, then run apply.js.
import { chromium } from "playwright";
import fs from "node:fs";
import { SEARCHES, SKIP } from "./profile.js";
const _log = console.log.bind(console);
console.log = (...a) => _log(new Date().toISOString().slice(11, 19), ...a);
import { ensureLoggedIn } from "./lib/login.js";

const argv = process.argv.slice(2);
const args = new Set(argv);
const USE_CDP = args.has("--cdp");
const CDP_URL = "http://127.0.0.1:9222";
const SEARCH_PAGES = [0, 25, 50];
const QUEUE_FILE = "./queue.json";
const loadQueue = () => (fs.existsSync(QUEUE_FILE) ? JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")) : { collectedAt: null, jobs: [] });
const saveQueue = (q) => fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
const t0 = Date.now();

function isIrrelevant(title) {
  return SKIP.irrelevantTitles.some((re) => re.test(title));
}

async function run() {
  const queue = loadQueue();
  const known = new Set(queue.jobs.map((j) => j.jobId));
  const appliedSet = new Set(
    fs.existsSync("./applied.json") ? (JSON.parse(fs.readFileSync("./applied.json", "utf8")).applied || []) : []
  );
  let browser, ctx, page;
  if (USE_CDP) {
    console.log(`[init] connecting to Chrome at ${CDP_URL} ...`);
    browser = await chromium.connectOverCDP(CDP_URL);
    ctx = browser.contexts()[0];
    page = await ctx.newPage();
  } else {
    browser = await chromium.launchPersistentContext("./chrome-profile", {
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    ctx = browser;
    page = browser.pages()[0] || (await browser.newPage());
  }
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(25000);
  let added = 0;

  try {
    if (!(await ensureLoggedIn(page))) throw new Error("login-failed");
    for (const s of SEARCHES) {
      for (const start of SEARCH_PAGES) {
        // URL-built search page — no scrolling, no clicks.
        const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(s.keywords)}&location=${encodeURIComponent(s.location)}&${s.filters}&start=${start}`;
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        } catch (e) {
          console.log(`[search-error] "${s.keywords}" start=${start}`);
          continue;
        }
        await page.waitForTimeout(1500);
        // Card containers carry "Title | Company | Location | ..." — the bare
        // <a> only holds the title, which is why company came out empty before.
        const cards = await page.evaluate(() => {
          const out = [];
          for (const a of document.querySelectorAll("a[href*='/jobs/view/']")) {
            const id = a.href.match(/\/jobs\/view\/(\d+)/)?.[1];
            if (!id) continue;
            const card = a.closest("li, div.job-card-container");
            const lines = (card ? card.innerText : a.innerText).split("\n").map((s) => s.trim()).filter(Boolean);
            out.push({ jobId: id, title: (lines[0] || a.innerText).trim().slice(0, 100), company: (lines[1] || "").slice(0, 80) });
          }
          return [...new Map(out.map((o) => [o.jobId, o])).values()].slice(0, 20);
        }).catch(() => []);
        if (cards.length === 0) break;
        console.log(`[search] "${s.keywords}" start=${start} -> ${cards.length} cards`);
        for (const c of cards) {
          if (known.has(c.jobId)) continue;
          known.add(c.jobId);
          const title = c.title;
          const company = c.company;
          if (!title || isIrrelevant(title)) { queue.jobs.push({ jobId: c.jobId, title, company, skipped: "irrelevant-title" }); continue; }
          if (appliedSet.has(c.jobId)) { queue.jobs.push({ jobId: c.jobId, title, company, skipped: "already-applied" }); continue; }
          // Per-job URL: quick Easy Apply probe (2.5s, no long waits — Phase 2 re-verifies).
          try {
            await page.goto(`https://www.linkedin.com/jobs/view/${c.jobId}/`, { waitUntil: "domcontentloaded", timeout: 25000 });
            await page.waitForTimeout(2500);
            const body = await page.locator("body").innerText().catch(() => "");
            const easy = (await page.locator("button").filter({ hasText: /^Easy Apply$/ }).count().catch(() => 0)) > 0;
            const extHref = easy ? null : await page.locator("a[href*='linkedin.com/safety/go']").first().getAttribute("href").catch(() => null);
            const fol = body.match(/([\d,]+)\s+followers/);
            queue.jobs.push({
              jobId: c.jobId, title, company,
              url: `https://www.linkedin.com/jobs/view/${c.jobId}/`,
              easyApply: easy, externalUrl: extHref,
              followers: fol ? parseInt(fol[1].replace(/,/g, ""), 10) : 0,
              collectedAt: new Date().toISOString(),
            });
            if (easy) { added++; console.log(`[queued] ${title} @ ${company}`); }
            else console.log(`[queued-external] ${title} @ ${company}`);
          } catch (e) {
            queue.jobs.push({ jobId: c.jobId, title, company, skipped: "collect-error" });
          }
          saveQueue({ collectedAt: new Date().toISOString(), jobs: queue.jobs });
        }
      }
    }
  } catch (e) {
    console.error("[fatal]", String(e).slice(0, 200));
  } finally {
    saveQueue({ collectedAt: new Date().toISOString(), jobs: queue.jobs });
    const easy = queue.jobs.filter((j) => j.easyApply).length;
    console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. +${added} new Easy Apply jobs. Queue: ${queue.jobs.length} total (${easy} easy-apply). File: ${QUEUE_FILE}`);
    await page.close().catch(() => {});
    if (!USE_CDP) await browser.close().catch(() => {});
    process.exit(0);
  }
}

run();
