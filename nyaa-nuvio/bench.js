// A/B benchmark for the nyaa matcher. Run:  node nyaa-nuvio/bench.js
// Gate: node nyaa-nuvio/bench.js --gate   (exit 1 if the ship criteria fail)
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "nyaa.js"), "utf8");
const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, "corpus.json"), "utf8"));

// Same restricted context as test.js, plus injectable globals (NYAA_PTT).
function loadCtx(extraGlobals) {
  const ctx = {
    console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    String, parseInt, isNaN, Math, Promise, RegExp, Object, Array, Error, JSON,
    fetch: function () { return Promise.reject(new Error("offline")); },
    module: { exports: {} },
    global: {}
  };
  if (extraGlobals) {
    for (const k in extraGlobals) ctx[k] = extraGlobals[k];
  }
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

const ctxDefault = loadCtx(null);
const ctxPtt = loadCtx({ NYAA_PTT: "1" });

function matchers() {
  return {
    current: function (c, t) { return c.matchEpisode(t.title, t.season, t.episode, t.absolute) === true; },
    ptt: function (c, t) {
      if (typeof c.matchEpisodePTT !== "function") return false;
      return c.matchEpisodePTT(t.title, t.season, t.episode, t.absolute) === true;
    },
    hybrid: function (c, t) {
      const a = c.matchEpisode(t.title, t.season, t.episode, t.absolute) === true;
      if (a) return true;
      if (typeof c.matchEpisodePTT !== "function") return false;
      return c.matchEpisodePTT(t.title, t.season, t.episode, t.absolute) === true;
    }
  };
}

function score(ctx, matcherFn) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const wrong = [];
  for (const c of CORPUS.cases) {
    const got = matcherFn(ctx, c);
    if (c.expect && got) tp++;
    else if (!c.expect && got) { fp++; wrong.push(c.id + " (expected reject, matched)"); }
    else if (c.expect && !got) { fn++; wrong.push(c.id + " (expected match, missed)"); }
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return { tp, fp, fn, tn, precision, recall, f1, wrong };
}

const m = matchers();
const results = {};
for (const name of ["current", "ptt", "hybrid"]) {
  results[name] = score(ctxDefault, m[name]);
}

const pad = (s, n) => String(s) + new Array(Math.max(1, n - String(s).length)).join(" ");
console.log("matcher    TP  FP  FN  TN   precision   recall       F1");
for (const name of ["current", "ptt", "hybrid"]) {
  const r = results[name];
  console.log(
    pad(name, 10) + pad(r.tp, 4) + pad(r.fp, 4) + pad(r.fn, 4) + pad(r.tn, 4) +
    pad(r.precision.toFixed(3), 13) + pad(r.recall.toFixed(3), 12) + r.f1.toFixed(3)
  );
}

console.log("\nverdict changes vs current:");
const base = {};
for (const c of CORPUS.cases) base[c.id] = m.current(ctxDefault, c);
for (const name of ["ptt", "hybrid"]) {
  const changes = [];
  for (const c of CORPUS.cases) {
    const got = m[name](ctxPtt, c);
    if (got !== base[c.id]) changes.push(c.id + ": " + base[c.id] + " -> " + got);
  }
  console.log("  " + name + ": " + (changes.length ? changes.join(" | ") : "no verdict changes"));
}

if (results.hybrid.f1 > results.current.f1 && results.hybrid.fn === 0) {
  console.log("\nGATE PASS: hybrid F1 > current F1 and zero false negatives");
} else {
  console.log("\nGATE FAIL: hybrid F1=" + results.hybrid.f1.toFixed(3) +
    " current F1=" + results.current.f1.toFixed(3) + " hybrid FN=" + results.hybrid.fn);
}

if (process.argv.indexOf("--gate") !== -1) {
  const ok = results.hybrid.f1 > results.current.f1 && results.hybrid.fn === 0;
  process.exit(ok ? 0 : 1);
}
