// PHASE 1 — COLLECT + FILTER. No applications are submitted here.
// Flow: login (stay logged in) -> search URLs from resume -> scrape job URLs ->
// per job: senior/irrelevant filter + Easy Apply detect + company VERIFY
// (background tab) -> store ONLY verified-easy jobs as ready:true in queue.json.
// Phase 2 (apply.js) trusts the queue and runs fast — no re-verification.
import { chromium } from "playwright";
import fs from "node:fs";
import { SEARCHES, SKIP, VERIFY } from "./profile.js";
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
          // Per-job URL: filter (senior?) + Easy Apply detect + VERIFY (background
          // tab, main page never moves) -> store ready-only. Phase 2 is fast.
          try {
            await page.goto(`https://www.linkedin.com/jobs/view/${c.jobId}/`, { waitUntil: "domcontentloaded", timeout: 25000 });
            await page.waitForTimeout(2500);
            const body = await page.locator("body").innerText().catch(() => "");
            if (SKIP.seniorSignals.some((re) => re.test(body))) {
              queue.jobs.push({ jobId: c.jobId, title, company, skipped: "senior-role" });
              console.log(`[filtered] senior-role: ${title}`);
              continue;
            }
            const easy = (await page.locator("button").filter({ hasText: /^Easy Apply$/ }).count().catch(() => 0)) > 0;
            if (!easy) {
              const extHref = await page.locator("a[href*='linkedin.com/safety/go']").first().getAttribute("href").catch(() => null);
              queue.jobs.push({ jobId: c.jobId, title, company, url: `https://www.linkedin.com/jobs/view/${c.jobId}/`, easyApply: false, externalUrl: extHref, collectedAt: new Date().toISOString() });
              console.log(`[queued-external] ${title} @ ${company}`);
              continue;
            }
            const compHref = await page.locator("a[href*='/company/']").first().getAttribute("href").catch(() => null);
            let followers = 0;
            if (compHref) {
              let bg = null;
              try {
                bg = await ctx.newPage();
                await bg.goto(compHref.split("?")[0], { waitUntil: "domcontentloaded", timeout: 20000 });
                for (let i = 0; i < 3 && followers === 0; i++) {
                  if (i > 0) await bg.waitForTimeout(1200);
                  const t = await bg.locator("body").innerText().catch(() => "");
                  const m = t.match(/([\d,]+)\s+followers/);
                  followers = m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
                }
              } catch {}
              await bg?.close().catch(() => {});
            } else {
              const fol = body.match(/([\d,]+)\s+followers/);
              followers = fol ? parseInt(fol[1].replace(/,/g, ""), 10) : 0;
            }
            const tier = followers >= VERIFY.topTier ? "top" : followers >= VERIFY.midTier ? "mid" : followers >= VERIFY.minFollowers ? "popular" : "small";
            const ready = followers >= VERIFY.minFollowers;
            queue.jobs.push({
              jobId: c.jobId, title, company,
              url: `https://www.linkedin.com/jobs/view/${c.jobId}/`,
              easyApply: true, ready, followers, tier,
              collectedAt: new Date().toISOString(),
            });
            if (ready) { added++; console.log(`[queued] ${title} @ ${company} [${tier}]`); }
            else console.log(`[filtered] unverified (${followers} followers): ${title}`);
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
    const ready = queue.jobs.filter((j) => j.ready).length;
    console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. +${added} new READY jobs. Queue: ${queue.jobs.length} total (${ready} ready). File: ${QUEUE_FILE}`);
    await page.close().catch(() => {});
    if (!USE_CDP) await browser.close().catch(() => {});
    process.exit(0);
  }
}

run();
