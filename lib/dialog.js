// Shared Easy Apply dialog engine (used by apply.js; apply-linkedin.js keeps its own copy).
// Answers come ONLY from the passed profile truth table. Anything else => needs-human.
import { escalate } from "./escalate.js";

const KNOWN_ANSWERS = [
  [/residing in hyderabad/i, "Yes"],
  [/willing to work full-time|ameerpet.*office|no remote\s*\/\s*hybrid/i, "Yes"],
  [/comfortable commuting|commute to.*location/i, "Yes"],
  [/start immediately/i, "Yes"],
  [/bachelor'?s degree/i, "Yes"],
  [/authorized to work in india|legally authorized.*india/i, "Yes"],
  [/require.*sponsorship/i, "No"],
  [/experience.*react|react.*angular/i, "Yes"],
  [/experience.*node|node\.js.*nestjs|nestjs/i, "Yes"],
  [/remote setup|work from home.*(laptop|internet)|good network.*laptop/i, "Yes"],
  [/customizing zoho|zoho crm/i, "No"],
];

export function textAnswersFor(profile) {
  return [
    [/how soon.*join|join.*days|notice period/i, profile.screening.joiningDays],
    [/expected.*ctc|salary.*expect/i, profile.screening.expectedCtcLakhs],
    [/current.*ctc/i, profile.screening.currentCtcLakhs],
    [/current.*location/i, profile.location],
    [/how many years of experience|years of experience.*have|total.*experience/i, profile.screening.totalExperienceYears],
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
    const known = KNOWN_ANSWERS.find(([re]) => re.test(qtext));
    let want = known?.[1];
    if (!want) {
      const esc = await maybeEscalate(useSdk, "screening", { profile, question: qtext, options: ["Yes", "No"] });
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
      const esc = await maybeEscalate(useSdk, "screening", { profile: PROFILE_SAFE(profile), question: scope, options: opts });
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
    const known = textAnswersFor(profile).find(([re]) => re.test(label));
    if (known) {
      await inp.fill(known[1]).catch(() => {});
      console.log(`[fill] text "${label.slice(0, 60).replace(/\n/g, " ")}" -> ${known[1]}`);
    } else if (/[a-z]{4,}/i.test(label)) {
      return { needsHuman: true, question: `text-field: ${label.slice(0, 200)}` };
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
