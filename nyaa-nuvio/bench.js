// Corpus scorer for the nyaa matcher. Run:  node nyaa-nuvio/bench.js
// Gate: node nyaa-nuvio/bench.js --gate   (exit 1 if precision or recall < 1.0)
//
// Scores the single in-file matchEpisode(). The before/after comparison is taken
// across commits, not across matchers: record this output, make the change, run
// it again, diff the numbers.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "nyaa.js"), "utf8");
const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, "corpus.json"), "utf8"));

// Mirrors the restricted context Nuvio hands the plugin, so the bench measures
// the same code path the real runtime executes.
const ctx = {
  console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
  String, parseInt, isNaN, Math, Promise, RegExp, Object, Array, Error, JSON,
  fetch: function () { return Promise.reject(new Error("offline")); },
  module: { exports: {} },
  global: {}
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

if (typeof ctx.matchEpisode !== "function") {
  console.error("matchEpisode is not exposed by nyaa.js - cannot score");
  process.exit(2);
}

let tp = 0, fp = 0, fn = 0, tn = 0;
const missed = [], falsePositives = [], thrown = [];

for (const c of CORPUS.cases) {
  let got, err = null;
  try {
    got = ctx.matchEpisode(c.title, c.season, c.episode, c.absolute) === true;
  } catch (e) {
    got = false;
    err = e;
  }
  if (c.expect && got) tp++;
  else if (!c.expect && got) { fp++; falsePositives.push(c.id + " matched but should be rejected"); }
  else if (c.expect && !got) { fn++; missed.push(c.id); }
  else tn++;
  // Reported separately: a throw is already counted as FN or TN by the cascade
  // above, so listing it here too would desync the header count from the FP tally.
  if (err) thrown.push(c.id + " threw: " + (err.message || err));
}

const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);

console.log("cases " + CORPUS.cases.length + "   (positives " + (tp + fn) + ", negatives " + (fp + tn) + ")");
console.log("TP " + tp + "  FP " + fp + "  FN " + fn + "  TN " + tn);
console.log("precision " + precision.toFixed(3) + "   recall " + recall.toFixed(3) + "   F1 " + f1.toFixed(3));

if (missed.length) {
  console.log("\nfalse negatives (" + missed.length + ") - real releases we failed to match:");
  for (const id of missed) console.log("  " + id);
}
if (falsePositives.length) {
  console.log("\nfalse positives (" + falsePositives.length + ") - things we matched that must not match:");
  for (const s of falsePositives) console.log("  " + s);
}
if (thrown.length) {
  console.log("\nthrew (" + thrown.length + ") - matchEpisode raised on these; scored as non-match:");
  for (const s of thrown) console.log("  " + s);
}

const ok = precision === 1 && recall === 1;
console.log("\n" + (ok
  ? "GATE PASS: precision 1.000, recall 1.000, zero false negatives, zero false positives"
  : "GATE FAIL: precision " + precision.toFixed(3) + ", recall " + recall.toFixed(3) +
    ", FN " + fn + ", FP " + fp));

if (process.argv.indexOf("--gate") !== -1) process.exit(ok ? 0 : 1);
