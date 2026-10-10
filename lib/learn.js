// Learned answers — user replies from interactive batch sessions live here.
// answers.json is gitignored (personal). Checked FIRST by the dialog engine:
// anything you taught once is never asked twice.
import fs from "node:fs";

const FILE = "./answers.json";
let cache = null;

export function loadAnswers() {
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    cache = [];
  }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

// Most-recent-first substring match (LinkedIn rewords slightly; short keys survive).
export function findAnswer(question) {
  const list = cache ?? loadAnswers();
  const q = (question || "").toLowerCase();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = (list[i].match || "").toLowerCase();
    if (m && q.includes(m)) return list[i].answer;
  }
  return null;
}

export function shortKey(question) {
  return (question || "").replace(/\s+/g, " ").trim().slice(0, 100);
}

export function saveAnswer(match, answer) {
  const list = loadAnswers();
  list.push({ match, answer, at: new Date().toISOString() });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  cache = list;
}
