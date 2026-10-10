// OpenCode SDK escalation — PLAIN-TEXT contract (v2).
// Why not json_schema structured output? The configured model rejects it:
//   APIError: only `"auto"` is supported for `tool_choice`.
// So we prompt for a strict 3-line reply and parse with regex. No tools used.
// Contract:
//   ANSWER: <value|empty>
//   NEEDS_HUMAN: yes|no
//   REASON: <short>
// Server ports avoid 4096 (often occupied) with fallback + timeouts, so a
// broken server can NEVER hang or kill a run (lesson from v1).
import { createOpencode } from "@opencode-ai/sdk";

const PORTS = [4499, 4498, 4497];
let opencode = null;

async function getClient() {
  if (opencode) return opencode.client;
  let lastErr = new Error("no-ports-tried");
  for (const port of PORTS) {
    try {
      opencode = await createOpencode({ port, timeout: 20000 });
      return opencode.client;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function assistantText(result) {
  const d = result?.data ?? result;
  const parts = d?.parts ?? d?.info?.parts ?? [];
  for (const p of parts) {
    if (p && (p.type === "text" || p.typeText) && typeof p.text === "string") return p.text;
  }
  if (typeof d?.info?.text === "string") return d.info.text;
  return "";
}

function parseReply(text) {
  let answer = (text.match(/ANSWER:\s*(.+)/i)?.[1] || "").trim();
  if (/needs_human/i.test(answer) || /^datasets$/i.test(answer)) answer = ""; // model echoed the template instead of answering
  const needsHuman = /NEEDS_HUMAN:\s*yes/i.test(text) || answer === "";
  const reason = (text.match(/REASON:\s*(.+)/i)?.[1] || "").trim().slice(0, 200);
  return { answer, needsHuman, reason };
}

const PROMPTS = {
  screening: (c) =>
    `You answer ONE job-application form question. Use ONLY these candidate facts:\n${JSON.stringify(c.profile)}\nQuestion: "${c.question}"\nOptions: ${JSON.stringify(c.options)}\nRules: if one option is directly supported by the facts, choose it. Salary/location/availability: use facts only. NEVER invent employers, degrees, or years.\nReply EXACTLY:\nANSWER: <chosen option, or empty>\nNEEDS_HUMAN: <yes|no>\nREASON: <under 10 words>`,
  verify: (c) =>
    `Judge if this employer looks genuine from LinkedIn signals: ${JSON.stringify(c.signals)}\nGenuine = real website/product + plausible size/followers; shell/recruit-scam patterns = not genuine.\nReply EXACTLY:\nANSWER: <genuine-top|genuine-mid|genuine-small|not-genuine>\nNEEDS_HUMAN: <yes|no>\nREASON: <under 10 words>`,
  error: (c) =>
    `A job-apply bot hit this error: ${c.error}\nPage: ${c.url}\nShould it retry the step, or skip this job?\nReply EXACTLY:\nANSWER: <retry|skip>\nNEEDS_HUMAN: <no>\nREASON: <under 10 words>`,
};

export async function escalate(kind, context) {
  const call = (async () => {
    const client = await getClient();
    const session = await client.session.create({ body: { title: `job-apply:${kind}` } });
    const res = await client.session.prompt({
      path: { id: session.data.id },
      body: { parts: [{ type: "text", text: (PROMPTS[kind] || PROMPTS.error)(context) }] },
    });
    const text = assistantText(res);
    if (!text) return { needsHuman: true, reason: "sdk-empty-reply" };
    const p = parseReply(text);
    const out = { needsHuman: p.needsHuman, reason: p.reason || "sdk-answer", answer: p.answer || undefined };
    if (kind === "verify") {
      out.genuine = p.answer.startsWith("genuine");
      out.tier = (p.answer.split("-")[1] || "unknown");
    }
    if (kind === "error") out.action = p.answer === "retry" ? "retry" : "skip";
    return out;
  })();
  return Promise.race([
    call,
    new Promise((res) => setTimeout(() => res({ needsHuman: true, reason: "sdk-timeout-60s" }), 60000)),
  ]).catch((e) => ({ needsHuman: true, reason: `sdk-error:${String(e).slice(0, 100)}` }));
}

export async function close() {
  try {
    await opencode?.server?.close();
  } catch {}
  opencode = null;
}
