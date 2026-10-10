// Secure LinkedIn login — Phase 1 helper.
// Credential order: live session -> env (LINKEDIN_EMAIL/PASSWORD) -> hidden terminal prompt.
// The password is NEVER logged, NEVER written to disk, lives only in memory.
import readline from "node:readline";

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    const onData = (ch) => {
      const s = String(ch);
      if (s === "\n" || s === "\r") {
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(password);
      } else if (s === "\u0003") {
        process.exit(1);
      } else {
        password += s.replace(/[\r\n]/g, "");
      }
    };
    let password = "";
    process.stdin.on("data", onData);
  });
}

function promptVisible(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

export async function ensureLoggedIn(page, { timeoutMs = 180000 } = {}) {
  // Fast path: session already alive (persistent profile / --cdp).
  await page.goto("https://www.linkedin.com/jobs/", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2000);
  if (!page.url().includes("authwall") && !(await page.title().catch(() => "")).includes("Sign Up")) {
    console.log("[login] session alive — staying logged in, no credentials needed.");
    return true;
  }
  // Need credentials — never logged, never stored.
  console.log("[login] LinkedIn session expired. Credentials stay in memory only.");
  const email = process.env.LINKEDIN_EMAIL || (await promptVisible("LinkedIn email: "));
  const password = process.env.LINKEDIN_PASSWORD || (await promptHidden("LinkedIn password (hidden): "));
  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.locator("#username").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("button[type='submit']").click();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(5000);
    const url = page.url();
    if (url.includes("/feed") || url.includes("/jobs") || url.includes("/in/")) {
      console.log("[login] logged in — session persists in the browser profile.");
      return true;
    }
    if (/challenge|captcha|verify/i.test(url)) {
      console.log("[login] LinkedIn asks for manual verification — complete it in the opened browser window...");
    }
  }
  console.log("[login] FAILED to log in within budget.");
  return false;
}
