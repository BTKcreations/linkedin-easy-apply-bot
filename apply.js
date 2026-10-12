// PHASE 2 — APPLY. Reads queue.json (collect.js FILTERED + VERIFIED it already,
// so this phase is fast: open job URL -> dialog -> submit).
// Answer order per field: learned answers.json -> truth table -> SDK -> DEFER.
// Deferred jobs (human input needed) are parked during the run and answered
// ONE BY ONE in an interactive batch at the end — then each submits immediately
// and the answer is saved, so it's never asked twice.
// Usage:
//   node apply.js --dry                        # show queue, submit nothing
//   node apply.js --cdp --yes --max=5          # auto + end-batch for unknowns
//   node apply.js --cdp --yes --max=5 --no-ask # no interactive batch (scheduled runs)
const _log = console.log.bind(console);
console.log = (...a) => _log(new Date().toISOString().slice(11, 19), ...a);

import { chromium } from "playwright";
import fs from "node:fs";
import readline from "node:readline";
import { PROFILE } from "./profile.js";
import { ensureLoggedIn } from "./lib/login.js";
import { completeEasyApply } from "./lib/dialog.js";
import { saveAnswer, shortKey } from "./lib/learn.js";
import { close as closeSdk, setSdkPort } from "./lib/escalate.js";

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has("--dry");
const AUTO_YES = args.has("--yes");
const USE_CDP = args.has("--cdp");
const USE_SDK = !args.has("--no-sdk");
const NO_ASK = args.has("--no-ask");
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

function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

async function submitJob(page, job, state, counters) {
  // Returns "applied" | "deferred" | "skipped". Single dialog attempt.
  const jt0 = Date.now();
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
    return "skipped";
  }
  if (DRY) { console.log(`[dry] WOULD APPLY`); return "skipped"; }
  const res = await completeEasyApply(page, PROFILE, USE_SDK);
  if (res.ok) {
    console.log(`[APPLIED] in ${Math.round((Date.now() - jt0) / 1000)}s`);
    state.applied.push(job.jobId);
    counters.applied++;
    bumpDaily();
    const pause = 20000 + Math.floor(Math.random() * 25000);
    console.log(`[jitter] pausing ${Math.round(pause / 1000)}s before next job...`);
    await sleep(pause);
    return "applied";
  }
  if (res.needsHuman) {
    console.log(`[defer] ${(res.question || "").slice(0, 120).replace(/\n/g, " ")} [${res.reason || "no-reason"}]`);
    return "deferred";
  }
  console.log(`[error] ${res.error}`);
  state.skipped.push({ jobId: job.jobId, reason: `error:${res.error}` });
  return "skipped";
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
  // ready flag (v4+) OR legacy easyApply entries collected before the flag existed.
  const jobs = queue.jobs.filter((j) => (j.ready || (j.easyApply && !j.skipped)) && !done.has(j.jobId));
  console.log(`[init] queue: ${jobs.length} READY jobs (SDK ${USE_SDK ? `ON (ports ${SDK_PORT ? SDK_PORT + " override" : "4499→4498→4497"})` : "OFF (--no-sdk)"})`);

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
  const counters = { applied: 0 };
  const deferred = [];
  const seen = new Set();

  try {
    if (!(await ensureLoggedIn(page))) throw new Error("login-failed");

    // PASS 1 — automatic: stream through; park human-needed jobs, never stop.
    for (const job of jobs) {
      if (counters.applied >= MAX) break;
      if (seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      if (!AUTO_YES && !DRY) {
        console.log(`READY: ${job.title} @ ${job.company} — Enter to submit, 'skip' to skip:`);
        const ans = await new Promise((res) => process.stdin.once("data", (d) => res(String(d).trim())));
        if (ans.toLowerCase().startsWith("s")) { state.skipped.push({ jobId: job.jobId, reason: "human-skip" }); continue; }
      }
      try {
        const outcome = await submitJob(page, job, state, counters);
        if (outcome === "deferred") deferred.push(job);
        saveState(state);
      } catch (jobErr) {
        console.log(`[job-error] ${String(jobErr).slice(0, 150)}`);
        state.skipped.push({ jobId: job.jobId, reason: "job-error" });
        saveState(state);
      }
    }

    // PASS 2 — interactive batch: deferred jobs answered ONE BY ONE at the end.
    // SDK already declined these, so each answer is saved permanently (never asked twice).
    if (deferred.length && !NO_ASK && process.stdin.isTTY && !DRY) {
      clearTimeout(globalTimer); // you are present and answering — no guillotine
      console.log(`\n[batch] ${deferred.length} jobs need your answers — one by one, each submits right after you answer.`);
      for (const job of deferred) {
        if (counters.applied >= MAX || dailyCount() >= DAILY_CAP) { console.log(`[batch] cap reached, stopping.`); break; }
        let attempts = 0;
        for (;;) {
          if (attempts++ >= 4) { console.log(`[batch] too many unknowns — leaving for manual apply: ${job.url}`); state.skipped.push({ jobId: job.jobId, reason: "batch-gave-up" }); break; }
          console.log(`\n=== ${job.title} @ ${job.company} [${job.tier || "?"}] ===\n${job.url}`);
          await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          // Re-run the dialog to surface the CURRENT unknown question.
          const probe = await completeEasyApply(page, PROFILE, USE_SDK);
          if (probe.ok) {
            console.log(`[APPLIED] (no input was even needed)`);
            state.applied.push(job.jobId);
            counters.applied++;
            bumpDaily();
            break;
          }
          if (!probe.needsHuman) { console.log(`[batch-error] ${probe.error} — leaving for manual: ${job.url}`); state.skipped.push({ jobId: job.jobId, reason: `error:${probe.error}` }); break; }
          const q = (probe.question || "unknown question").replace(/\n/g, " ").slice(0, 300);
          console.log(`Q: ${q}`);
          const ans = await promptUser("Your answer (or 'skip' for manual later): ");
          if (!ans || /^skip$/i.test(ans)) { console.log(`[batch] skipped by you — apply manually: ${job.url}`); state.skipped.push({ jobId: job.jobId, reason: "human-skip-batch" }); break; }
          saveAnswer(shortKey(probe.question), ans);
          console.log(`[learned] saved — retrying ${job.title}...`);
          const retry = await submitJob(page, job, state, counters);
          if (retry === "applied") break;
          if (retry === "skipped") break; // error recorded inside submitJob
          // else deferred again with the NEXT unknown -> loop asks continuously
        }
        saveState(state);
      }
    } else if (deferred.length) {
      console.log(`\n[deferred] ${deferred.length} jobs need answers (non-interactive run — rerun in a terminal to answer):`);
      for (const job of deferred) console.log(`  - ${job.title} @ ${job.company}: ${job.url}`);
    }
  } catch (e) {
    console.error("[fatal]", String(e).slice(0, 200));
  } finally {
    saveState(state);
    await closeSdk().catch(() => {});
    clearTimeout(globalTimer);
    console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. Applied this run: ${counters.applied}. Deferred: ${deferred.length}.`);
    await closeBrowser();
    process.exit(0);
  }
}

run();
