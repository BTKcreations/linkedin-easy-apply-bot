import { createOpencode } from "@opencode-ai/sdk";
const t0 = Date.now();
try {
  const o = await createOpencode({ port: 4499, timeout: 30000 });
  console.log("SERVER-OK");
  const session = await o.client.session.create({ body: { title: "sdk-probe" } });
  console.log("SESSION-OK", session.data?.id || JSON.stringify(session).slice(0, 100));
  const result = await o.client.session.prompt({
    path: { id: session.data.id },
    body: {
      parts: [{ type: "text", text: "Answer with the word ok. Question: Is Rotary Club a service organization? Reply minimal." }],
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            needsHuman: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["answer", "needsHuman", "reason"],
        },
        retryCount: 1,
      },
    },
  });
  console.log("PROMPT-OK:", JSON.stringify(result.data?.info?.structured_output || result.data?.info || result).slice(0, 500));
  await o.server.close();
  console.log(`DONE in ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(0);
} catch (e) {
  console.log("FAIL:", String(e?.message || e).slice(0, 800));
  process.exit(1);
}
