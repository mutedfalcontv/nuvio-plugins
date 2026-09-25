// Corpus scorer for the nyaa matcher. Run:  node nyaa-nuvio/bench.js
// Gate: node nyaa-nuvio/bench.js --gate   (exit 1 on any miss, false positive, or throw)
//
// Scores the single in-file matchEpisode(). The before/after comparison is taken
// across commits, not across matchers: record this output, make the change, run
// it again, diff the numbers.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "nyaa.js"), "utf8");
const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, "corpus.json"), "utf8"));

// Same restricted context as test.js, so the bench and the offline suite cannot
// drift apart. It is NOT the production sandbox: vm.createContext always provides
// a full ES realm, so the allowlist below only strips host globals (process,
// require, Buffer, setInterval, URL, performance, crypto) and cannot catch a
// plugin that reaches for parseFloat or Object.assign. The ES5-only constraint is
// enforced by review, not by this harness.
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

// "S1E8" / "S1E1122" / "S1 abs 25" - enough of a request to act on from a log line.
function requestLabel(c) {
  if (c.absolute !== null && c.absolute !== undefined) return "S" + c.season + " abs " + c.absolute;
  return "S" + c.season + "E" + c.episode;
}

for (const c of CORPUS.cases) {
  let got, err = null;
  try {
    got = ctx.matchEpisode(c.title, c.season, c.episode, c.absolute) === true;
  } catch (e) {
    got = false;
    err = e;
  }
  if (c.expect && got) tp++;
  else if (!c.expect && got) { fp++; falsePositives.push(c.id + "  " + requestLabel(c) + "  " + c.title); }
  else if (c.expect && !got) { fn++; missed.push(c.id + "  " + requestLabel(c) + "  " + c.title); }
  else tn++;
  // A throw is scored once, above, as either FN or TN. This list is diagnostic
  // only, so a throwing positive appears under both headings by design.
  if (err) thrown.push(c.id + "  " + (err.message || err));
}

const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);

console.log("cases " + CORPUS.cases.length + "   (positives " + (tp + fn) + ", negatives " + (fp + tn) + ")");
console.log("TP " + tp + "  FP " + fp + "  FN " + fn + "  TN " + tn);
console.log("precision " + precision.toFixed(3) + "   recall " + recall.toFixed(3) + "   F1 " + f1.toFixed(3));

if (missed.length) {
  console.log("\nfalse negatives (" + missed.length + ") - id  request  title");
  for (const id of missed) console.log("  " + id);
}
if (falsePositives.length) {
  console.log("\nfalse positives (" + falsePositives.length + ") - id  request  title");
  for (const s of falsePositives) console.log("  " + s);
}
if (thrown.length) {
  console.log("\nthrew (" + thrown.length + ") - scored as non-match, but a throw is a gate failure:");
  for (const s of thrown) console.log("  " + s);
}

// Throws gate as hard as a miss. matchEpisode is called inside getStreams' single
// try block (nyaa.js:214, catch at :247 returns []), so a throw discards every
// stream accumulated for the whole query loop - the search silently returns
// nothing. A matcher that crashes on an unrecognised title shape must not be
// able to pass a gate that only counts true/false.
const ok = fp === 0 && fn === 0 && thrown.length === 0;
console.log("\n" + (ok
  ? "GATE PASS: precision 1.000, recall 1.000, zero false negatives, zero false positives, zero throws"
  : "GATE FAIL: precision " + precision.toFixed(3) + ", recall " + recall.toFixed(3) +
    ", FN " + fn + ", FP " + fp +
    (thrown.length ? ", threw " + thrown.length : "")));

if (process.argv.indexOf("--gate") !== -1) process.exit(ok ? 0 : 1);
