# job-auto-apply

Hybrid LinkedIn Easy Apply automation: **deterministic browser automation does everything it can; OpenCode SDK (AI) fills only the gaps mid-application.** Nothing is ever guessed — form answers come only from your `profile.js` facts; unknowns escalate to AI with those facts, and only truly unanswerable items are skipped.

> ⚠️ **Disclaimer — read before use.** Automating job applications may violate LinkedIn's Terms of Service and can lead to account restrictions. This tool rate-limits itself (~5 per run, state-tracked to avoid duplicates), but you use it at your own risk. Keep volumes human (~20–30 applications/day max), review `queue.json` before submitting, and never let it invent facts about you.

---

## Requirements

| Requirement | Why | Check |
|---|---|---|
| **Node.js 18+** | Runtime | `node --version` |
| **Google Chrome (desktop)** | Holds your logged-in LinkedIn session | Any recent version |
| **LinkedIn account** | Job search + Easy Apply | Must be able to log in |
| **(Optional) OpenCode model access** | AI escalation for unknown form fields | Only used without `--no-sdk` |

No password is ever stored. Login reuses your Chrome profile session; if it expires, the script prompts securely (hidden input) and the password lives in memory only.

## Install

```bash
git clone <your-repo-url> job-auto-apply
cd job-auto-apply
npm install                    # playwright + @opencode-ai/sdk
npx playwright install chromium
```

For `--cdp` mode (recommended — drives your already-logged-in Chrome), start Chrome once with remote debugging:

```powershell
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList "--remote-debugging-port=9222","--user-data-dir=$env:TEMP\chrome-debug"
```

On macOS/Linux:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

## Setup (required — 3 minutes)

1. **Create your profile** (gitignored — stays on your machine):
   ```bash
   copy profile.example.js profile.js   # Windows
   # cp profile.example.js profile.js   # macOS/Linux
   ```
   Then edit `profile.js`: name, email, phone, location, resume PDF path, and the `screening` answers. **Only add answers that are true** — the bot fills these verbatim; anything missing escalates instead of guessing. Extra facts the engine understands: `languages` (e.g. Hindi questions resolve from it), `cloud` (AWS/GCP/Azure hands-on), `remoteEquipped` (own device for WFH), `productionApi` (shipped third-party integrations). Tune `SEARCHES` (keywords mirroring your resume) and `VERIFY.minFollowers` (company quality bar).
2. **Log in to LinkedIn** in that Chrome profile (one time; session persists).
3. (Optional) `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` env vars for unattended re-login. Otherwise you'll get a secure hidden prompt if the session expires.

## How to use

Two phases — collect first (safe, submits nothing), review, then apply:

```bash
# Phase 1 — COLLECT: login check → resume-keyword search URLs (paged)
#           → scrape job URLs → Easy Apply detect → queue.json
node collect.js --cdp

# Review / edit queue.json (delete lines you don't want), then:

# Phase 2 — APPLY: verify company → fill dialog → SDK fills unknowns → submit
node apply.js --cdp --yes --max=5      # auto-submit up to 5
node apply.js --cdp                    # ask before each submit
node apply.js --dry                    # preview queue, submit nothing
node apply.js --cdp --yes --max=5 --no-sdk   # automation only, skip unknowns
```

Shared flags: `--timeout-mins=N` (global kill timer, default 10 — runs always exit cleanly), `--daily-cap=N` (default 20 submits/day — run refuses past the cap to protect the account). A random 20–45s pause runs between submits. Legacy all-in-one runner: `node apply-linkedin.js --cdp --yes --max=5`.

## How it works

```
Phase 1 (collect.js)                    Phase 2 (apply.js)
 login → search URLs (paged)              read queue.json
   → scrape job URLs                       → company verify (background tab)
   → Easy Apply detect                     → Easy Apply dialog:
   → queue.json (reviewable)                 automation fills knowns
                                             SDK fills unknowns  ─┐
                                             Submit               │ only the gaps
                                                                  └─ lib/escalate.js
```

- **URL-first:** searches, job pages, company pages, pagination are direct `goto`s — no button-hunting. Clicks exist only inside LinkedIn's Easy Apply modal (no URL exists there).
- **Truth-table discipline:** answers come from `profile.js` + `lib/dialog.js` known lists. Unknown → SDK prompt carrying your facts (plain-text `ANSWER / NEEDS_HUMAN / REASON` contract — works with any model, 60s timeout) → `needs-human` skip if still unsure.
- **State:** `applied.json` (never double-applies, survives reruns), `queue.json` (human-reviewable work list). Both gitignored.
- **Safety rails:** per-job try/catch, 15s action / 25s navigation / global timeouts, guaranteed `process.exit`, `--dry` previews.

## Project map

```
profile.example.js    template — copy to profile.js and fill in (gitignored)
collect.js            Phase 1: login → scrape → queue.json
apply.js              Phase 2: queue → verify → submit → applied.json
apply-linkedin.js     legacy all-in-one runner (backup)
lib/login.js          secure login (session → env → hidden prompt; never stored)
lib/dialog.js         Easy Apply engine (fill knowns, escalate unknowns, submit)
lib/verify.js         company check (followers/website/size → tier)
lib/escalate.js       OpenCode SDK bridge (plain-text contract + timeouts)
probe-sdk.js          SDK connectivity self-test (node probe-sdk.js)
```

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `authwall` / login prompt | Session expired → log in to LinkedIn in the Chrome window, rerun (or set `LINKEDIN_EMAIL`/`LINKEDIN_PASSWORD`) |
| `unverified (followers=0)` skips | LinkedIn lazy-rendered; rerun — Phase 2 retries the read |
| `needs-human: ...` skips | Genuinely new question → add your answer to `profile.js` screening, rerun (state kept) |
| `stalled-at:3/4pages` | Required field the bot couldn't fill — read the log line above it for the field name |
| `Server exited with code 1` (port 4096) | Port clash — escalation tries 4499→4498→4497 automatically |
| SDK `tool_choice` errors | Old structured-output path — already replaced by the plain-text contract |
| Run feels slow | LinkedIn renders ~10–30s/job; `--timeout-mins` bounds it. Keep ≤20–30 applies/day |
