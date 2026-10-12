// Shared Easy Apply dialog engine (used by apply.js; apply-linkedin.js keeps its own copy).
// Answer order (cheapest first, never guessed):
//   1. learned answers.json (you taught it once)  2. truth table  3. SDK  4. defer-to-human
import { escalate } from "./escalate.js";
import { findAnswer } from "./learn.js";

const KNOWN_ANSWERS = [
  [/residing in hyderabad/i, "Yes"],
  [/willing to work full-time|ameerpet.*office|no remote\s*\/\s*hybrid/i, "Yes"],
  [/comfortable commuting|commute to.*location/i, "Yes"],
  [/start immediately/i, "Yes"],
  [/bachelor'?s degree/i, "Yes"],
  [/degree completed|have you graduated|course completed/i, (p) => (p.degreeCompleted ? "Yes" : null)],
  [/authorized to work in india|legally authorized.*india/i, "Yes"],
  [/authoriz.*work|legally.*authoriz/i, (p) => (p.authorizedIndia ? "Yes" : null)],
  [/require.*sponsorship/i, "No"],
  [/sponsorship/i, (p) => (p.needSponsorship ? "Yes" : "No")],
  [/experience.*react|react.*angular/i, "Yes"],
  [/experience.*node|node\.js.*nestjs|nestjs/i, "Yes"],
  [/remote setup|work from home.*(laptop|internet)|good network.*laptop/i, "Yes"],
  [/own device/i, (p) => (p.remoteEquipped ? "Yes" : null)],
  [/hands[\s-]*on.*(cloud|aws|gcp|azure)|cloud concepts/i, (p) => (p.cloud?.length ? "Yes" : null)],
  [/openai|anthropic.*api|llm.*experience/i, (p) => (p.skills?.some((s) => /openai|langchain|rag|llm/i.test(s)) ? "Yes" : null)],
  [/third-party api|api.*production|integrations.*production/i, (p) => (p.productionApi ? "Yes" : null)],
  [/know hindi/i, (p) => (p.languages?.some((l) => /hindi/i.test(l)) ? "Yes" : "No")],
  [/customizing zoho|zoho crm/i, "No"],
];

// Entries may be static strings or (profile) => "Yes"|"No"|null (null = escalate).
function resolveAnswer(entry, profile) {
  if (!entry) return null;
  const v = entry[1];
  return typeof v === "function" ? v(profile) : v;
}

export function textAnswersFor(profile) {
  return [
    [/how soon.*join|join.*days|notice period/i, profile.screening.joiningDays],
    [/expected.*ctc|salary.*expect/i, profile.screening.expectedCtcLakhs],
    [/current.*ctc/i, profile.screening.currentCtcLakhs],
    [/current.*location/i, profile.location],
    [/how many years of experience|years of.*experience.*have|total.*experience|experience.*with aiml|aiml.*experience/i, profile.screening.totalExperienceYears],
    [/months of (work )?experience/i, String(profile.internshipMonths ?? "")],
  ];
}

async function maybeEscalate(useSdk, kind, context) {
  if (!useSdk) return { needsHuman: true, reason: "sdk-disabled" };
  try {
    return await Promise.race([
      escalate(kind, context),
      new Promise((res) => setTimeout(() => res({ needsHuman: true, reason: "sdk-timeout-45s" }), 45000)),
    ]);
  } catch (e) {
    return { needsHuman: true, reason: `sdk-error:${String(e).slice(0, 100)}` };
  }
}

async function nearbyLabelText(el) {
  return el.evaluate((node) => {
    let n = node.parentElement;
    for (let d = 0; d < 5 && n; d++, n = n.parentElement) {
      const t = (n.innerText || "").slice(0, 400);
      if (/\?|days|ctc|salary|experience|location/i.test(t) && t.length > 20) return t;
    }
    return "";
  }).catch(() => "");
}

export function easyDialog(page) {
  return page.locator("dialog:has-text('Apply to')").last();
}

async function fillContact(dialog, profile) {
  for (const sel of await dialog.locator("select").all()) {
    const opts = await sel.locator("option").allInnerTexts().catch(() => []);
    if (opts.length > 50) {
      const idx = opts.findIndex((o) => o.includes("India (+91)"));
      if (idx >= 0) await sel.selectOption({ index: idx }).catch(() => {});
      continue;
    }
    const emailIdx = opts.findIndex((o) => o.includes(profile.email));
    if (emailIdx >= 0) await sel.selectOption({ index: emailIdx }).catch(() => {});
  }
  const tel = dialog.locator("input[type='tel']").first();
  if ((await tel.count()) > 0 && !(await tel.inputValue().catch(() => ""))) {
    await tel.fill(profile.phone).catch(() => {});
  }
}

async function answerQuestions(dialog, profile, useSdk) {
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
    if ((await g.locator("input:checked, [aria-checked='true']").count().catch(() => 0)) > 0) continue;
    let want = findAnswer(qtext);
    let reason = want ? "learned" : "";
    if (!want) {
      want = resolveAnswer(KNOWN_ANSWERS.find(([re]) => re.test(qtext)), profile);
      reason = want ? "truth-table" : "";
    }
    if (!want) {
      const esc = await maybeEscalate(useSdk, "screening", { profile, question: qtext, options: ["Yes", "No"] });
      if (esc.needsHuman || !esc.answer) return { needsHuman: true, question: qtext.slice(0, 200), reason: esc.reason };
      want = esc.answer;
      reason = `sdk:${esc.reason}`;
    }
    const opt = g.locator(`text=${want}`).first();
    if ((await opt.count()) > 0) await opt.click().catch(() => {});
  }
  for (const sel of await dialog.locator("select").all()) {
    const opts = await sel.locator("option").allInnerTexts().catch(() => []);
    if (opts.length > 50) continue;
    const scope = await nearbyLabelText(sel);
    if (/email|phone/i.test(scope)) continue;
    let want = findAnswer(scope);
    if (!want) want = resolveAnswer(KNOWN_ANSWERS.find(([re]) => re.test(scope)), profile);
    if (!want && opts.some((o) => /^(yes|no)$/i.test(o.trim()))) {
      const esc = await maybeEscalate(useSdk, "screening", { profile: PROFILE_SAFE(profile), question: scope, options: opts });
      if (esc.needsHuman || !esc.answer) return { needsHuman: true, question: scope.slice(0, 200), reason: esc.reason };
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
    const learned = findAnswer(label);
    if (learned) {
      await inp.fill(learned).catch(() => {});
      console.log(`[fill] text (learned) "${label.slice(0, 60).replace(/\n/g, " ")}" -> ${learned}`);
      continue;
    }
    const known = textAnswersFor(profile).find(([re]) => re.test(label));
    if (known && known[1]) {
      await inp.fill(known[1]).catch(() => {});
      console.log(`[fill] text "${label.slice(0, 60).replace(/\n/g, " ")}" -> ${known[1]}`);
    } else if (/[a-z]{4,}/i.test(label)) {
      return { needsHuman: true, question: `text-field: ${label.slice(0, 200)}`, reason: "no-truth-match" };
    }
  }
  return { ok: true };
}

function PROFILE_SAFE(profile) {
  const { ...rest } = profile; // escalate() never receives secrets (none stored anyway)
  return rest;
}

export async function completeEasyApply(page, profile, useSdk) {
  const easyBtn = page.locator("button").filter({ hasText: /^Easy Apply$/ }).first();
  if ((await easyBtn.count()) === 0) return { error: "no-easy-apply-button" };
  await easyBtn.scrollIntoViewIfNeeded().catch(() => {});
  const pagesBefore = page.context().pages().length;
  await easyBtn.click();
  // Some "Easy Apply" buttons actually open an external tab — detect, close, report.
  await page.waitForTimeout(1500);
  if (page.context().pages().length > pagesBefore) {
    const extra = page.context().pages()[page.context().pages().length - 1];
    const href = extra.url();
    await extra.close().catch(() => {});
    return { error: `external-tab:${href.slice(0, 100)}` };
  }
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
    if (/application submitted|your application was sent/i.test(body)) return { ok: true };
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
    await fillContact(dialog, profile);
    const aq = await answerQuestions(dialog, profile, useSdk);
    if (aq.needsHuman) return aq;
    const submitBtn = dialog.locator("button").filter({ hasText: /submit application/i }).first();
    const submitAny = dialog.locator("button").filter({ hasText: /submit/i }).first();
    const reviewBtn = dialog.locator("button").filter({ hasText: /^Review$/ }).first();
    const nextBtn = dialog.locator("button[aria-label='Continue to next step']").first();
    const anyNext = dialog.locator("button").filter({ hasText: /^Next$/ }).first();
    if ((await submitBtn.count()) > 0) await submitBtn.click().catch(() => {});
    else if ((await submitAny.count()) > 0) await submitAny.click().catch(() => {});
    else if ((await reviewBtn.count()) > 0) await reviewBtn.click().catch(() => {});
    else if ((await nextBtn.count()) > 0) await nextBtn.click().catch(() => {});
    else if ((await anyNext.count()) > 0) await anyNext.click().catch(() => {});
    else {
      // Diagnostics: WHAT is actually in the footer? (fixes blind no-next-button)
      const foot = await dialog.locator("button").allInnerTexts().catch(() => []);
      return { error: `no-next-button footer=[${foot.map((t) => t.trim()).filter(Boolean).join("|").slice(0, 160)}]` };
    }
  }
  return { error: "too-many-steps" };
}
