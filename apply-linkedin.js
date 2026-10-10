// Hybrid LinkedIn Easy Apply runner — URL-FIRST v3.
// Architecture (user decision 2026-10-10):
//   RULE: anything addressable by URL is a goto. Clicks exist ONLY where
//   LinkedIn offers no URL (inside the Easy Apply modal).
//
// URL inventory (all goto, zero button-hunting):
//   U1 search  : /jobs/search/?keywords=..&location=..&f_AL..&start={0,25,50}
//                -> paged URLs triple the funnel, no scrolling/clicking.
//   U2 job     : /jobs/view/{id}/ -> title, Easy/External state, followers.
//   U3 company : /company/{slug}/ opened in a BACKGROUND page, read, closed.
//                Main page never navigates away (v2's slowest pattern, gone).
//   U4 external: the company-career apply href is READ from the DOM and logged
//                for manual apply. Never clicked (LinkedIn-only decision).
//   U5 modal   : dropped by navigating to the next job URL. No dismiss clicks.
// CLICK inventory (unavoidable — no URL exists):
//   C1 Easy Apply open (1 click + explicit waitFor).
//   C2 modal Next/Review/Submit + option picks (minimal, value-set first).
//
// Usage:
//   node apply-linkedin.js --dry                  # list only
//   node apply-linkedin.js --cdp --yes --max=5    # fast test
//   node apply-linkedin.js --cdp --yes --max=5 --sdk   # + AI escalation
// Flags: --timeout-mins=N (default 10, global kill timer, always exits).
import { chromium } from "playwright";
import fs from "node:fs";
import { PROFILE, SEARCHES, SKIP, VERIFY } from "./profile.js";
import { escalate, close as closeSdk } from "./lib/escalate.js";

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has("--dry");
const AUTO_YES = args.has("--yes");
const USE_CDP = args.has("--cdp");
const USE_SDK = args.has("--sdk");
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
const SEARCH_PAGES = [0, 25, 50]; // U1: paged search URLs
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms))]);
const STATE_FILE = "./applied.json";
const loadState = () =>
  fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { applied: [], skipped: [] };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

const KNOWN_ANSWERS = [
  [/residing in hyderabad/i, "Yes"],
  [/willing to work full-time|ameerpet.*office|no remote\s*\/\s*hybrid/i, "Yes"],
  [/start immediately/i, "Yes"],
  [/bachelor'?s degree/i, "Yes"],
  [/authorized to work in india|legally authorized.*india/i, "Yes"],
  [/require.*sponsorship/i, "No"],
  [/experience.*react|react.*angular/i, "Yes"],
  [/experience.*node|node\.js.*nestjs|nestjs/i, "Yes"],
  [/remote setup|work from home.*(laptop|internet)|good network.*laptop/i, "Yes"],
];

const TEXT_ANSWERS = [
  [/how soon.*join|join.*days|notice period/i, PROFILE.screening.joiningDays],
  [/expected.*ctc|salary.*expect/i, PROFILE.screening.expectedCtcLakhs],
  [/current.*ctc/i, PROFILE.screening.currentCtcLakhs],
  [/how many years of experience|years of experience.*have|total.*experience/i, PROFILE.screening.totalExperienceYears],
];

function isIrrelevant(title) {
  return SKIP.irrelevantTitles.some((re) => re.test(title));
}

async function maybeEscalate(kind, context) {
  if (!USE_SDK) return { needsHuman: true, reason: "sdk-disabled-fast-path" };
  try {
    return await Promise.race([
      escalate(kind, context),
      new Promise((res) => setTimeout(() => res({ needsHuman: true, reason: "sdk-timeout-45s" }), 45000)),
    ]);
  } catch (e) {
    return { needsHuman: true, reason: `sdk-error:${String(e).slice(0, 100)}` };
  }
}

// U3: company verify in a BACKGROUND page — main page never moves.
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
    return { genuine: false, tier: "unknown", followers: 0, err: String(e).slice(0, 80) };
  } finally {
    await bg?.close().catch(() => {});
  }
}

async function waitForLogin(page, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const title = await page.title().catch(() => "");
    if (!url.includes("authwall") && !title.includes("Sign Up")) return true;
    console.log("[login] waiting for LinkedIn login in the opened browser window...");
    await page.waitForTimeout(8000);
  }
  return false;
}

async function nearbyLabelText(el) {
  return el.evaluate((node) => {
    let n = node.parentElement;
    for (let d = 0; d < 5 && n; d++, n = n.parentElement) {
      const t = (n.innerText || "").slice(0, 400);
      if (/\?|days|ctc|salary|experience/i.test(t) && t.length > 20) return t;
    }
    return "";
  }).catch(() => "");
}

function easyDialog(page) {
  return page.locator("dialog:has-text('Apply to')").last();
}

async function fillContact(dialog) {
  for (const sel of await dialog.locator("select").all()) {
    const opts = await sel.locator("option").allInnerTexts().catch(() => []);
    if (opts.length > 50) {
      const idx = opts.findIndex((o) => o.includes("India (+91)"));
      if (idx >= 0) await sel.selectOption({ index: idx }).catch(() => {});
      continue;
    }
    const emailIdx = opts.findIndex((o) => o.includes(PROFILE.email));
    if (emailIdx >= 0) await sel.selectOption({ index: emailIdx }).catch(() => {});
  }
  const tel = dialog.locator("input[type='tel']").first();
  if ((await tel.count()) > 0) {
    const cur = await tel.inputValue().catch(() => "");
    if (!cur) await tel.fill(PROFILE.phone).catch(() => {});
  }
}

async function answerQuestions(dialog) {
  const groups = dialog.locator("[role='radiogroup'], fieldset");
  for (let i = 0; i < (await groups.count()); i++) {
    const g = groups.nth(i);
    let qtext = ((await g.innerText().catch(() => "")) || "").slice(0, 300);
    if (!qtext.trim()) continue;
    if (!/[a-z]{3,}/i.test(qtext.replace(/yes|no/gi, ""))) {
      const near = await g.evaluate((el, minLen) => {
        let n = el.parentElement;
        for (let d = 0; d < 5 && n; d++, n = n.parentElement) {
          const t = (n.innerText || "").slice(0, 400);
          if (/\?/.test(t) && t.length > minLen) return t;
        }
        return "";
      }, qtext.length + 10).catch(() => "");
      if (near) qtext = near.slice(0, 300);
    }
    const checked = await g.locator("input:checked, [aria-checked='true']").count().catch(() => 0);
    if (checked > 0) continue;
    const known = KNOWN_ANSWERS.find(([re]) => re.test(qtext));
    let want = known?.[1];
    if (!want) {
      const esc = await maybeEscalate("screening", { profile: PROFILE, question: qtext, options: ["Yes", "No"] });
      if (esc.needsHuman || !esc.answer) return { needsHuman: true, question: qtext.slice(0, 200) };
      want = esc.answer;
    }
    const opt = g.locator(`text=${want}`).first();
    if ((await opt.count()) > 0) await opt.click().catch(() => {});
  }
  for (const sel of await dialog.locator("select").all()) {
    const opts = await sel.locator("option").allInnerTexts().catch(() => []);
    if (opts.length > 50) continue;
    const scope = await nearbyLabelText(sel);
    if (/email|phone/i.test(scope)) continue;
    const known = KNOWN_ANSWERS.find(([re]) => re.test(scope));
    let want = known?.[1];
    if (!want && opts.some((o) => /^(yes|no)$/i.test(o.trim()))) {
      const esc = await maybeEscalate("screening", { profile: PROFILE, question: scope, options: opts });
      if (esc.needsHuman || !esc.answer) return { needsHuman: true, question: scope.slice(0, 200) };
      want = esc.answer;
    }
    if (want) {
      const idx = opts.findIndex((o) => o.trim().toLowerCase() === want.toLowerCase());
      if (idx >= 0) await sel.selectOption({ index: idx }).catch(() => {});
    }
  }
  const texts = dialog.locator("input[type='text'], input:not([type])");
  for (let i = 0; i < (await texts.count()); i++) {
    const inp = texts.nth(i);
    if (await inp.inputValue().catch(() => "")) continue;
    const label = await nearbyLabelText(inp);
    const known = TEXT_ANSWERS.find(([re]) => re.test(label));
    if (known) {
      await inp.fill(known[1]).catch(() => {});
      console.log(`[fill] text "${label.slice(0, 60).replace(/\n/g, " ")}" -> ${known[1]}`);
    } else if (/[a-z]{4,}/i.test(label)) {
      return { needsHuman: true, question: `text-field: ${label.slice(0, 200)}` };
    }
  }
  return { ok: true };
}

async function completeEasyApply(page) {
  const easyBtn = page.locator("button").filter({ hasText: /^Easy Apply$/ }).first();
  if ((await easyBtn.count()) === 0) return { error: "no-easy-apply-button" };
  await easyBtn.click();
  try {
    await easyDialog(page).waitFor({ state: "attached", timeout: 10000 });
  } catch {
    return { error: "dialog-never-opened" };
  }
  let lastProgress = "";
  let stalls = 0;
  for (let step = 0; step < 12; step++) {
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText().catch(() => "");
    if (/application submitted|your application was sent/i.test(body)) return { ok: true }; // U5: next goto drops the modal
    const dialog = easyDialog(page);
    if ((await dialog.count()) === 0) {
      if (step > 1) return { error: "dialog-vanished" };
      continue;
    }
    const dlgText = await dialog.innerText().catch(() => "");
    const progress = dlgText.match(/(\d+\s*\/\s*\d+\s*pages?)/i)?.[1]?.replace(/\s+/g, "") || "unknown-step";
    if (progress === lastProgress) {
      if (++stalls >= 2) return { error: `stalled-at:${progress}` };
    } else {
      stalls = 0;
      lastProgress = progress;
    }
    await fillContact(dialog);
    const aq = await answerQuestions(dialog);
    if (aq.needsHuman) return aq;
    const submitBtn = dialog.locator("button").filter({ hasText: /submit application/i }).first();
    const reviewBtn = dialog.locator("button").filter({ hasText: /^Review$/ }).first();
    const nextBtn = dialog.locator("button[aria-label='Continue to next step']").first();
    const anyNext = dialog.locator("button").filter({ hasText: /^Next$/ }).first();
    if ((await submitBtn.count()) > 0) await submitBtn.click().catch(() => {});
    else if ((await reviewBtn.count()) > 0) await reviewBtn.click().catch(() => {});
    else if ((await nextBtn.count()) > 0) await nextBtn.click().catch(() => {});
    else if ((await anyNext.count()) > 0) await anyNext.click().catch(() => {});
    else return { error: "no-next-button" };
  }
  return { error: "too-many-steps" };
}

async function run() {
  const t0 = Date.now();
  const globalTimer = setTimeout(() => {
    console.log(`[timeout] global ${Math.round(RUN_TIMEOUT_MS / 60000)}min budget hit — stopping. State saved so far is kept.`);
    try { saveState(loadState()); } catch {}
    process.exit(2);
  }, RUN_TIMEOUT_MS);
  globalTimer.unref?.();
  const state = loadState();
  const seenThisRun = new Set();
  let ctx, page, closeBrowser;
  if (USE_CDP) {
    console.log(`[init] connecting to logged-in Chrome at ${CDP_URL} ...`);
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
    for (const s of SEARCHES) {
      if (appliedTotal >= Math.min(s.maxApply, MAX)) break;
      for (const start of SEARCH_PAGES) {
        if (appliedTotal >= Math.min(s.maxApply, MAX)) break;
        // U1: paged search URL — no scrolling, no "see more" clicks.
        const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(s.keywords)}&location=${encodeURIComponent(s.location)}&${s.filters}&start=${start}`;
        try {
          await withTimeout(page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }), 35000, `search-nav:${s.keywords}:${start}`);
        } catch (e) {
          console.log(`[search-error] "${s.keywords}" start=${start}: ${String(e).slice(0, 100)}`);
          continue;
        }
        if (start === 0 && !(await waitForLogin(page))) throw new Error("login-timeout");
        await page.waitForTimeout(1500);
        const jobIds = [
          ...new Set(
            (await page.locator("a[href*='/jobs/view/']").evaluateAll((as) =>
              as.map((a) => a.href.match(/\/jobs\/view\/(\d+)/)?.[1]).filter(Boolean)
            )).slice(0, 15)
          ),
        ];
        if (jobIds.length === 0) break; // no more pages
        console.log(`[search] "${s.keywords}" start=${start} -> ${jobIds.length} candidates`);

        for (const jobId of jobIds) {
          if (appliedTotal >= Math.min(s.maxApply, MAX)) break;
          const jt0 = Date.now();
          try {
            if (state.applied.includes(jobId) || seenThisRun.has(jobId)) { console.log(`[skip] ${jobId} already handled`); continue; }
            seenThisRun.add(jobId);
            // U2: job page by URL.
            await page.goto(`https://www.linkedin.com/jobs/view/${jobId}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.locator(".jobs-unified-top-card, .job-details-jobs-unified-top-card__container").first().scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForFunction(() => /Easy Apply/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
            const body = await page.locator("body").innerText().catch(() => "");
            const title = (await page.title().catch(() => "")).replace(" | LinkedIn", "");
            // U4: external apply href is READ (logged for manual), never clicked.
            const easyCount = await page.locator("button").filter({ hasText: /^Easy Apply$/ }).count().catch(() => 0);
            if (easyCount === 0) {
              const already = /application submitted|your application was sent/i.test(body);
              if (already) { console.log(`[skip] ${title} already-applied`); state.skipped.push({ jobId, reason: "already-applied" }); continue; }
              const extHref = await page.locator("a[href*='linkedin.com/safety/go'], a.jobs-apply-button").first().getAttribute("href").catch(() => null);
              console.log(`[skip] ${title} external-apply ${extHref ? extHref.slice(0, 90) : "(no href found)"}`);
              state.skipped.push({ jobId, reason: "external-apply", url: extHref });
              continue;
            }
            if (!title || isIrrelevant(title)) { console.log(`[skip] ${jobId} irrelevant`); state.skipped.push({ jobId, reason: "irrelevant-title" }); continue; }
            if (SKIP.seniorSignals.some((re) => re.test(body))) { console.log(`[skip] ${title} senior-role`); state.skipped.push({ jobId, reason: "senior-role" }); continue; }

            // U3: verify in background page — main page never moves.
            const compHref = await page.locator("a[href*='/company/']").first().getAttribute("href").catch(() => null);
            if (compHref) {
              const v = await verifyViaBackgroundPage(ctx, compHref);
              if (!v.genuine) { console.log(`[skip] ${title} unverified (followers=${v.followers})`); state.skipped.push({ jobId, reason: `unverified:followers=${v.followers}` }); continue; }
              console.log(`[verify] ${title} -> tier=${v.tier} (followers=${v.followers})`);
            }

            if (DRY) { console.log(`[dry] WOULD APPLY: ${title} (${jobId})`); continue; }
            if (!AUTO_YES) {
              console.log(`READY: ${title} (${jobId}) — Enter to submit, 'skip' to skip:`);
              const ans = await new Promise((res) => process.stdin.once("data", (d) => res(String(d).trim())));
              if (ans.toLowerCase().startsWith("s")) { state.skipped.push({ jobId, reason: "human-skip" }); continue; }
            }
            console.log(`[apply] ${title} (${jobId}) ...`);
            const res = await completeEasyApply(page);
            if (res.ok) {
              console.log(`[APPLIED] ${title} (${jobId}) in ${Math.round((Date.now() - jt0) / 1000)}s`);
              state.applied.push(jobId);
              appliedTotal++;
            } else if (res.needsHuman) {
              console.log(`[needs-human] ${title}: ${(res.question || "").slice(0, 120).replace(/\n/g, " ")}`);
              state.skipped.push({ jobId, reason: `needs-human:${(res.question || "").slice(0, 80)}` });
            } else {
              console.log(`[error] ${title}: ${res.error}`);
              state.skipped.push({ jobId, reason: `error:${res.error}` });
            }
            saveState(state);
          } catch (jobErr) {
            console.log(`[job-error] ${jobId}: ${String(jobErr).slice(0, 150)}`);
            state.skipped.push({ jobId, reason: "job-error" });
            saveState(state);
          }
        }
      }
    }
  } catch (e) {
    console.error("[fatal]", String(e).slice(0, 200));
  } finally {
    saveState(state);
    await closeSdk().catch(() => {});
    clearTimeout(globalTimer);
    console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. Applied this run: ${appliedTotal}. State: ${STATE_FILE}`);
    await closeBrowser();
    process.exit(0);
  }
}

run();
