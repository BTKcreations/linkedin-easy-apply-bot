import { escalate, close } from "./lib/escalate.js";
try {
  // Real unknown from the logs: PST-overlap commitment question.
  const r = await escalate("screening", {
    profile: { location: "Hyderabad, India", remote: true, screening: { canStartImmediately: "Yes" } },
    question: "Are you able to work Full-time (40 hours per week) with at least 4 hours of overlap during PST business hours?",
    options: ["Yes", "No"],
  });
  console.log("RESULT:", JSON.stringify(r));
} finally {
  await close().catch(() => {});
  process.exit(0);
}
