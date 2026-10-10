// PHASE 2 — APPLY. Reads queue.json (built by collect.js), submits applications.
// Policy (user-confirmed): automation does everything it can; any unknown
// field goes to OpenCode SDK mid-application, then the flow CONTINUES to
// Submit. SDK is ON unless --no-sdk. Nothing is ever guessed.
// Timestamps on every line so timing is visible.
// Usage:
//   node apply.js --dry                        # show queue, submit nothing
//   node apply.js --cdp --yes --max=5          # auto-submit up to 5
//   node apply.js --cdp --yes --max=5 --no-sdk # automation only, skip unknowns
const _log = console.log.bind(console);
console.log = (...a) => _log(new Date().toISOString().slice(11, 19), ...a);

import { chromium } from "playwright";
import fs from "node:fs";
import { PROFILE, VERIFY } from "./profile.js";
import { ensureLoggedIn } from "./lib/login.js";
import { completeEasyApply } from "./lib/dialog.js";
import { close as closeSdk, setSdkPort } from "./lib/escalate.js";

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has("--dry");
const AUTO_YES = args.has("--yes");
const USE_CDP = args.has("--cdp");
const USE_SDK = !args.has("--no-sdk");
const CDP_URL = "http://127.0.0.1:9222";
const MAX = (() => {
  const m = argv.find((a) => a.startsWith("--max="));
  const n = m ? parseInt(m.split("=")[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const RUN_TIMEOUT_MS = (() => {
  const m = argv.find((a) => a.startsWith("--timeout-mins="));
  const n = m ? parseFloat(m.split("=")[1]) : NaN;
  return (Number.isFinite(n) && n > 0 ? n : 10) * 60 * 1000;
})();
const DAILY_CAP = (() => {
  const m = argv.find((a) => a.startsWith("--daily-cap="));
  const n = m ? parseInt(m.split("=")[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20; // LinkedIn rate safety
})();
const DAILY_FILE = "./daily.json";
function dailyCount() {
  try {
    const d = JSON.parse(fs.readFileSync(DAILY_FILE, "utf8"));
    return d.date === new Date().toISOString().slice(0, 10) ? d.count : 0;
  } catch { return 0; }
}
function bumpDaily() {
  const today = new Date().toISOString().slice(0, 10);
  let d;
  try { d = JSON.parse(fs.readFileSync(DAILY_FILE, "utf8")); } catch { d = { date: today, count: 0 }; }
  if (d.date !== today) d = { date: today, count: 0 };
  d.count++;
  fs.writeFileSync(DAILY_FILE, JSON.stringify(d));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUEUE_FILE = "./queue.json";
const STATE_FILE = "./applied.json";
const SDK_PORT = (() => {
  const m = argv.find((a) => a.startsWith("--sdk-port="));
  const n = m ? parseInt(m.split("=")[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
})();
if (SDK_PORT) setSdkPort(SDK_PORT);
const loadState = () =>
  fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { applied: [], skipped: [] };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms))]);

async function verifyViaBackgroundPage(ctx, compHref) {
  let bg = null;
  try {
    bg = await ctx.newPage();
    await bg.goto(compHref.split("?")[0], { waitUntil: "domcontentloaded", timeout: 20000 });
    let followers = 0;
    for (let i = 0; i < 3 && followers === 0; i++) {
      if (i > 0) await bg.waitForTimeout(1200);
      const t = await bg.locator("body").innerText().catch(() => "");
      const m = t.match(/([\d,]+)\s+followers/);
      followers = m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
    }
    const tier =
      followers >= VERIFY.topTier ? "top" : followers >= VERIFY.midTier ? "mid" : followers >= VERIFY.minFollowers ? "popular" : "small";
    return { genuine: followers >= VERIFY.minFollowers, tier, followers };
  } catch (e) {
    return { genuine: false, tier: "unknown", followers: 0 };
  } finally {
    await bg?.close().catch(() => {});
  }
}

async function run() {
  const t0 = Date.now();
  const globalTimer = setTimeout(() => {
    console.log(`[timeout] global budget hit — stopping. Saved state is kept.`);
    process.exit(2);
  }, RUN_TIMEOUT_MS);
  globalTimer.unref?.();
  if (!fs.existsSync(QUEUE_FILE)) {
    console.log(`No ${QUEUE_FILE} — run collect.js first (Phase 1).`);
    process.exit(1);
  }
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  const state = loadState();
  const today = dailyCount();
  if (today >= DAILY_CAP) {
    console.log(`[cap] daily cap reached (${today}/${DAILY_CAP}) — stopping to protect the account. Rerun tomorrow.`);
    process.exit(0);
  }
  console.log(`[cap] today ${today}/${DAILY_CAP} submits used`);
  const done = new Set(state.applied);
  const jobs = queue.jobs.filter((j) => j.easyApply && !j.skipped && !done.has(j.jobId));
  console.log(`[init] queue: ${jobs.length} pending Easy Apply jobs (SDK ${USE_SDK ? `ON (ports ${SDK_PORT ? SDK_PORT + " override" : "4499→4498→4497"})` : "OFF (--no-sdk)"})`);

  let ctx, page, closeBrowser;
  if (USE_CDP) {
    console.log(`[init] connecting to Chrome at ${CDP_URL} ...`);
    const browser = await chromium.connectOverCDP(CDP_URL);
    ctx = browser.contexts()[0];
    page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(25000);
    closeBrowser = async () => withTimeout(page.close(), 10000, "page-close").catch(() => {});
  } else {
    const browser = await chromium.launchPersistentContext("./chrome-profile", {
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    ctx = browser;
    page = browser.pages()[0] || (await browser.newPage());
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(25000);
    closeBrowser = async () => withTimeout(browser.close(), 15000, "browser-close").catch(() => {});
  }
  let appliedTotal = 0;

  try {
    if (!(await ensureLoggedIn(page))) throw new Error("login-failed");
    for (const job of jobs) {
      if (appliedTotal >= MAX) break;
      const jt0 = Date.now();
      try {
        console.log(`[job] ${job.title} @ ${job.company} (${job.jobId})`);
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.locator(".jobs-unified-top-card, .job-details-jobs-unified-top-card__container").first().scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForFunction(() => /Easy Apply/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
        const easyCount = await page.locator("button").filter({ hasText: /^Easy Apply$/ }).count().catch(() => 0);
        if (easyCount === 0) {
          const body = await page.locator("body").innerText().catch(() => "");
          const already = /application submitted|your application was sent/i.test(body);
          console.log(`[skip] ${already ? "already-applied" : "easy-apply-gone"}`);
          state.skipped.push({ jobId: job.jobId, reason: already ? "already-applied" : "easy-apply-gone" });
          continue;
        }
        const compHref = await page.locator("a[href*='/company/']").first().getAttribute("href").catch(() => null);
        if (compHref) {
          const v = await verifyViaBackgroundPage(ctx, compHref);
          // Trust the HIGHER of queue-time vs re-verified followers (lazy render
          // can read 0 and wrongly kill top-tier employers).
          const followers = Math.max(job.followers || 0, v.followers);
          const tier = followers >= VERIFY.topTier ? "top" : followers >= VERIFY.midTier ? "mid" : followers >= VERIFY.minFollowers ? "popular" : "small";
          if (followers < VERIFY.minFollowers) { console.log(`[skip] unverified (followers=${followers})`); state.skipped.push({ jobId: job.jobId, reason: `unverified:${followers}` }); continue; }
          console.log(`[verify] tier=${tier} followers=${followers}`);
        }
        if (DRY) { console.log(`[dry] WOULD APPLY`); continue; }
        if (!AUTO_YES) {
          console.log(`READY — Enter to submit, 'skip' to skip:`);
          const ans = await new Promise((res) => process.stdin.once("data", (d) => res(String(d).trim())));
          if (ans.toLowerCase().startsWith("s")) { state.skipped.push({ jobId: job.jobId, reason: "human-skip" }); continue; }
        }
        const res = await completeEasyApply(page, PROFILE, USE_SDK);
        if (res.ok) {
          console.log(`[APPLIED] in ${Math.round((Date.now() - jt0) / 1000)}s`);
          state.applied.push(job.jobId);
          appliedTotal++;
          bumpDaily();
          const pause = 20000 + Math.floor(Math.random() * 25000); // human jitter 20-45s between submits
          console.log(`[jitter] pausing ${Math.round(pause / 1000)}s before next job...`);
          await sleep(pause);
        } else if (res.needsHuman) {
          console.log(`[needs-human] ${(res.question || "").slice(0, 120).replace(/\n/g, " ")} [${res.reason || "no-reason"}]`);
          state.skipped.push({ jobId: job.jobId, reason: `needs-human:${(res.question || "").slice(0, 80)}` });
        } else {
          console.log(`[error] ${res.error}`);
          state.skipped.push({ jobId: job.jobId, reason: `error:${res.error}` });
        }
        saveState(state);
      } catch (jobErr) {
        console.log(`[job-error] ${String(jobErr).slice(0, 150)}`);
        state.skipped.push({ jobId: job.jobId, reason: "job-error" });
        saveState(state);
      }
    }
  } catch (e) {
    console.error("[fatal]", String(e).slice(0, 200));
  } finally {
    saveState(state);
    await closeSdk().catch(() => {});
    clearTimeout(globalTimer);
    console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. Applied this run: ${appliedTotal}.`);
    await closeBrowser();
    process.exit(0);
  }
}

run();
