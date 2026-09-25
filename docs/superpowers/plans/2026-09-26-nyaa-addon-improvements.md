# Nyaa Addon Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add anime tracker support, Torrentio-style stream labels, live best-trackers, and a flag-gated `parse-torrent-title` matcher to `nyaa-nuvio`, with a committed corpus and A/B benchmark that proves whether each part actually helps.

**Architecture:** Three independent, individually revertible blocks inside the single-file plugin `nyaa-nuvio/nyaa.js` (the runtime loads one file per scraper and provides no bundler, so nothing can be imported). Part C takes the union of the existing regex matcher and a vendored copy of `parse-torrent-title`, gated behind a `NYAA_PTT` global, so default behaviour is byte-identical to today. Measurement lives outside the plugin: `corpus.json` (frozen ground truth) plus `bench.js` (three matchers, precision/recall/F1) and `tracker-health.js` (Stage 4 probe).

**Tech Stack:** JavaScript ES5-style CommonJS (Hermes-compatible, no optional chaining), Node `vm` for the offline test harness, `parse-torrent-title@3.0.1` vendored verbatim, Node `dgram`/`https` for tracker probes.

**Design spec:** `docs/superpowers/specs/2026-09-26-nyaa-addon-improvements-design.md`

**Ground rules for every task:**
- The plugin is loaded by a `vm` context that only provides: `console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, String, parseInt, isNaN, Math, Promise, RegExp, Object, Array, Error, JSON, fetch, module, global`. **Do not use `parseFloat`, `Array.isArray`, `Object.assign`, template literals, or optional chaining in `nyaa.js`** — they will be `undefined` in the sandbox and in Hermes. Use `typeof x !== "undefined"` guards for any new global.
- `node nyaa-nuvio/test.js` must print `ALL TESTS PASSED` (exit 0) after every task.
- Commit after every task. Never amend.

---

### Task 1: Freeze the corpus and build the A/B benchmark

Nothing else can be measured until a baseline exists. This task produces the numbers every later task is judged against, and it must land **first**.

**Files:**
- Create: `nyaa-nuvio/corpus.json`
- Create: `nyaa-nuvio/bench.js`
- Modify: `nyaa-nuvio/test.js` (no change needed — `bench.js` is standalone)

- [ ] **Step 1: Create `nyaa-nuvio/corpus.json`**

Every `expect` value below is the ground truth already asserted in `nyaa-nuvio/test.js:79-102`. Copy it exactly; do not invent new expectations.

```json
{
  "generatedAt": "2026-09-26",
  "note": "Ground truth mirrors the assertions in test.js runOffline(). Do not edit expect values to make a matcher look good.",
  "cases": [
    { "id": "01-subsplease-s1-absolute", "title": "Super no Ura de Yani Suu Futari - 08 (1080p)", "season": 1, "episode": 8, "absolute": null, "expect": true },
    { "id": "02-subsplease-s1-absolute-bare", "title": "Super no Ura de Yani Suu Futari - 08", "season": 1, "episode": 8, "absolute": null, "expect": true },
    { "id": "03-wrong-episode", "title": "Super no Ura de Yani Suu Futari - 09 (1080p)", "season": 1, "episode": 8, "absolute": null, "expect": false },
    { "id": "04-explicit-s01e08", "title": "[SubsPlease] Show - S01E08 (1080p)", "season": 1, "episode": 8, "absolute": null, "expect": true },
    { "id": "05-sequel-batch-false-positive", "title": "[Erai-raws] Code Geass: Dakkan no Roze - 01 ~ 12 [1080p][BATCH][MultiSub]", "season": 1, "episode": 1, "absolute": null, "expect": false },
    { "id": "06-generic-season-pack", "title": "Show - Season 1 Pack [1080p]", "season": 1, "episode": 8, "absolute": null, "expect": false },
    { "id": "07-s2-absolute", "title": "[SubsPlease] Show S2 - 08 (1080p)", "season": 2, "episode": 8, "absolute": null, "expect": true },
    { "id": "08-s1-absolute-plain", "title": "Show - 08 (1080p)", "season": 1, "episode": 8, "absolute": null, "expect": true },
    { "id": "09-season-mismatch", "title": "Show S1 - 08 (1080p)", "season": 2, "episode": 8, "absolute": null, "expect": false },
    { "id": "10-spelled-season-reject", "title": "Solo Leveling Season 2 -Arise from the Shadow- - 08 [1080p]", "season": 1, "episode": 8, "absolute": null, "expect": false },
    { "id": "11-s2-token-reject", "title": "[Raze] Solo Leveling S2 - 08 x265 1080p", "season": 1, "episode": 8, "absolute": 8, "expect": false },
    { "id": "12-cross-season-absolute", "title": "[SubsPlease] Solo Leveling - 25 (1080p)", "season": 2, "episode": 13, "absolute": 25, "expect": true },
    { "id": "13-absolute-unknown", "title": "[SubsPlease] Solo Leveling - 25 (1080p)", "season": 2, "episode": 13, "absolute": null, "expect": false },
    { "id": "14-bracket-chain-ep08", "title": "[北宇治字幕组] 再见，菈菈 / Sayonara Lara [08][WebRip][HEVC_AAC][简日内嵌]", "season": 1, "episode": 8, "absolute": null, "expect": true },
    { "id": "15-bracket-chain-wrong-ep", "title": "[北宇治字幕组] 再见，菈菈 / Sayonara Lara [08][WebRip][HEVC_AAC][简日内嵌]", "season": 1, "episode": 9, "absolute": null, "expect": false },
    { "id": "16-bracket-chain-ep05", "title": "Show [05][1080p][HEVC] release", "season": 1, "episode": 5, "absolute": null, "expect": true },
    { "id": "17-h264-not-an-episode", "title": "[ToonsHub] Grand Blue Dreaming S03E09 1080p AMZN WEB-DL DDP2.0 H.264 (Multi-Subs)", "season": 1, "episode": 264, "absolute": null, "expect": false },
    { "id": "18-s03e09-real-match", "title": "[ToonsHub] Grand Blue Dreaming S03E09 1080p AMZN WEB-DL DDP2.0 H.264 (Multi-Subs)", "season": 3, "episode": 9, "absolute": null, "expect": true },
    { "id": "19-ep239-s1", "title": "[Shridhuu][1080p] Swallowed Star - Tunshi Xingkong - EP239", "season": 1, "episode": 239, "absolute": null, "expect": true },
    { "id": "20-ep239-not-s2", "title": "[Shridhuu][1080p] Swallowed Star - Tunshi Xingkong - EP239", "season": 2, "episode": 239, "absolute": null, "expect": false }
  ]
}
```

- [ ] **Step 2: Create `nyaa-nuvio/bench.js`**

```javascript
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

function score(fn) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const wrong = [];
  for (const c of CORPUS.cases) {
    const got = fn(c);
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
  results[name] = score(m[name]);
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
```

- [ ] **Step 3: Run the benchmark to establish the baseline**

Run: `node nyaa-nuvio/bench.js`
Expected: `ptt` row shows all zeros (no `matchEpisodePTT` yet), `current` row shows the true baseline, and the gate line prints `GATE FAIL` because `hybrid` is currently identical to `current` (equal F1, not greater). **Record the `current` precision/recall/F1 numbers — you will compare against them in Task 6.**

- [ ] **Step 4: Commit**

```bash
git add nyaa-nuvio/corpus.json nyaa-nuvio/bench.js
git commit -m "test(nyaa): freeze 20-case matcher corpus + A/B bench harness"
```

---

### Task 2: Part A1 — anime tracker set with a hard 25-tracker cap

**Files:**
- Modify: `nyaa-nuvio/nyaa.js:1-12` (add `TRACKERS_ANIME`, `MAX_TRACKERS`, `mergeTrackers`)
- Modify: `nyaa-nuvio/nyaa.js:608-615` (`buildMagnet` uses `mergeTrackers`)
- Modify: `nyaa-nuvio/test.js` (new assertions at end of `runOffline`)

- [ ] **Step 1: Write the failing test**

Append these lines inside `runOffline()` in `nyaa-nuvio/test.js`, immediately before the `return ctx.getStreams(...)` line (currently `nyaa-nuvio/test.js:113`):

```javascript
  // ---- Part A1: tracker merge ----
  var merged = ctx.mergeTrackers([]);
  assert("mergeTrackers includes all 4 anime trackers",
    merged.indexOf("http://nyaa.tracker.wf:7777/announce") !== -1 &&
    merged.indexOf("http://anidex.moe:6969/announce") !== -1 &&
    merged.indexOf("http://tracker.anirena.com:80/announce") !== -1 &&
    merged.indexOf("udp://tracker.uw0.xyz:6969/announce") !== -1);
  assert("mergeTrackers keeps legacy generic trackers", merged.indexOf("udp://tracker.opentrackr.org:1337/announce") !== -1);
  assert("mergeTrackers default length is 14", merged.length === 14);

  var many = [];
  for (var mi = 0; mi < 40; mi++) many.push("udp://best" + mi + ".example:6969/announce");
  var capped = ctx.mergeTrackers(many);
  assert("mergeTrackers caps at 25", capped.length === 25);
  assert("mergeTrackers never evicts anime trackers under cap pressure",
    capped.indexOf("http://nyaa.tracker.wf:7777/announce") !== -1 &&
    capped.indexOf("udp://tracker.uw0.xyz:6969/announce") !== -1);
  assert("mergeTrackers anime block comes first", capped[0] === "http://nyaa.tracker.wf:7777/announce");

  var magnet = ctx.buildMagnet("AAA11111111111111111111111111111111111111", "Some Title");
  assert("buildMagnet embeds anime tracker", magnet.indexOf(encodeURIComponent("http://nyaa.tracker.wf:7777/announce")) !== -1);
  var trCount = magnet.split("&tr=").length - 1;
  assert("buildMagnet tracker count within cap", trCount <= 25 && trCount >= 14);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node nyaa-nuvio/test.js`
Expected: FAIL on `mergeTrackers includes all 4 anime trackers` — `ctx.mergeTrackers` is not a function, so the script throws `TypeError: ctx.mergeTrackers is not a function` and exits non-zero.

- [ ] **Step 3: Implement `mergeTrackers`**

Insert directly after the `TRACKERS` array closes at `nyaa-nuvio/nyaa.js:12`:

```javascript
// Anime-specific swarms. Generic trackers carry almost no anime peers, so these
// are what actually make a magnet find leechers. Ported from Torrentio's
// addon/lib/magnetHelper.js (ANIME_TRACKERS).
var TRACKERS_ANIME = [
  "http://nyaa.tracker.wf:7777/announce",
  "http://anidex.moe:6969/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://tracker.uw0.xyz:6969/announce"
];

var MAX_TRACKERS = 25;

// Order: anime set first, then live best trackers, then the legacy generic set.
// Anime goes first deliberately — if the best-tracker list went first it could
// consume all 25 slots alone and silently drop the anime trackers, which are the
// whole point for this plugin. Eviction happens from the tail only.
function mergeTrackers(best) {
  var out = [];
  var seen = {};
  function push(t) {
    if (t && !seen[t]) { seen[t] = true; out.push(t); }
  }

  for (var a = 0; a < TRACKERS_ANIME.length; a++) push(TRACKERS_ANIME[a]);

  var bestList = best || [];
  var room = MAX_TRACKERS - out.length;
  for (var b = 0; b < bestList.length && b < room; b++) push(bestList[b]);

  for (var g = 0; g < TRACKERS.length && out.length < MAX_TRACKERS; g++) push(TRACKERS[g]);

  return out;
}
```

- [ ] **Step 4: Rewire `buildMagnet`**

Replace the tracker loop in `buildMagnet()` (`nyaa-nuvio/nyaa.js:608-615`) with:

```javascript
function buildMagnet(infoHash, title) {
  var encodedName = encodeURIComponent(title.replace(/\[[^\]]*\]/g, "").trim());
  var magnet = "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodedName;
  var trackers = mergeTrackers(getBestTrackers());
  for (var ti = 0; ti < trackers.length; ti++) {
    magnet += "&tr=" + encodeURIComponent(trackers[ti]);
  }
  return magnet;
}
```

`getBestTrackers()` is added in Task 4. Until then it must already exist as a stub so this task is runnable — add it now, above `buildMagnet`:

```javascript
// Returns the live best-tracker list if it has been fetched, otherwise an empty
// list. Populated by initBestTrackers() (see below); the stub keeps buildMagnet
// correct before that fetch lands.
function getBestTrackers() {
  return bestTrackersCache || [];
}

var bestTrackersCache = null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0.

Run: `node nyaa-nuvio/bench.js`
Expected: `current` F1 unchanged from the Task 1 baseline. Trackers must not alter matching.

- [ ] **Step 6: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "feat(nyaa): add anime tracker set with 25-tracker cap"
```

---

### Task 3: Part A2 — Torrentio-style stream labels

**Files:**
- Modify: `nyaa-nuvio/nyaa.js` (add `LANGUAGE_TAGS`, `detectAudioTags`, `formatStreamName` after `parseQuality` at `nyaa.js:598-606`)
- Modify: `nyaa-nuvio/nyaa.js:219-232` (result object uses `formatStreamName`)
- Modify: `nyaa-nuvio/test.js` (new assertions)

- [ ] **Step 1: Write the failing test**

Insert before the `return ctx.getStreams(...)` line in `runOffline()`:

```javascript
  // ---- Part A2: labels ----
  var tags = ctx.detectAudioTags("[DKB] Some Show - 14 (Dual Audio, Multi-Subs) [1080p]");
  assert("detectAudioTags finds Multi Subs", tags.indexOf("Multi Subs") !== -1);
  assert("detectAudioTags finds Dual Audio", tags.indexOf("Dual Audio") !== -1);

  var dubTags = ctx.detectAudioTags("[EMBER] Show S01E01 1080p WEB-DL English Dub");
  assert("detectAudioTags finds Dubbed", dubTags.indexOf("Dubbed") !== -1);

  assert("detectAudioTags empty for bare title", ctx.detectAudioTags("[SubsPlease] Show - 08 (1080p)").length === 0);

  var name = ctx.formatStreamName(
    { title: "[SubsPlease] Sousou no Frieren - 08 (1080p)", seeders: 75, sizeLabel: "900.0 MiB" },
    "1080p",
    ["Multi Subs"]
  );
  var nameLines = name.split("\n");
  assert("formatStreamName is 4 lines", nameLines.length === 4);
  assert("formatStreamName line 1 is quality", nameLines[0] === "1080p");
  assert("formatStreamName line 2 is raw title", nameLines[1] === "[SubsPlease] Sousou no Frieren - 08 (1080p)");
  assert("formatStreamName line 3 has seeders and size", nameLines[2].indexOf("75") !== -1 && nameLines[2].indexOf("900.0 MiB") !== -1);
  assert("formatStreamName line 4 is tags", nameLines[3] === "Multi Subs");

  var noTags = ctx.formatStreamName({ title: "X", seeders: 1, sizeLabel: "1.0 MiB" }, null, []);
  assert("formatStreamName blank tag line when no tags", noTags.split("\n")[3] === " ");
  assert("formatStreamName blank quality line when unknown", noTags.split("\n")[0] === " ");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node nyaa-nuvio/test.js`
Expected: FAIL — `ctx.detectAudioTags is not a function`.

- [ ] **Step 3: Implement the label helpers**

Insert after `parseQuality()` (`nyaa-nuvio/nyaa.js:606`):

```javascript
// Audio/subtitle tags, in Torrentio's vocabulary (addon/lib/languages.js).
// Deliberately independent of parse-torrent-title: Part C is flag-gated and
// labels must work with it off.
var LANGUAGE_TAGS = [
  { re: /\bmulti[\s-]?subs?\b|\bmultiple[\s-]?sub(?:title)?s?\b/i, label: "Multi Subs" },
  { re: /\bmulti[\s-]?audio\b/i, label: "Multi Audio" },
  { re: /\bdual[\s-]?audio\b/i, label: "Dual Audio" },
  { re: /\beng(?:lish)?[\s-]?dub\b|\bdubbed\b|\bdub\b/i, label: "Dubbed" },
  { re: /\braw\b|\bunsubbed\b/i, label: "Unsubs" }
];

function detectAudioTags(title) {
  var out = [];
  if (!title) return out;
  for (var i = 0; i < LANGUAGE_TAGS.length; i++) {
    if (LANGUAGE_TAGS[i].re.test(title) && out.indexOf(LANGUAGE_TAGS[i].label) === -1) {
      out.push(LANGUAGE_TAGS[i].label);
    }
  }
  return out;
}

// Four fixed lines so narrow UIs have a predictable shape:
//   <resolution> / <title> / <seeders> <size> <provider> / <tags>
function formatStreamName(item, quality, tags) {
  return [
    quality || " ",
    item.title || " ",
    (item.seeders || 0) + " \u{1F50A} " + (item.sizeLabel || "?") + " \u{1F4BF} Nyaa",
    (tags && tags.length) ? tags.join(" / ") : " "
  ].join("\n");
}
```

- [ ] **Step 4: Use it in the result object**

In `getStreams`, replace `nyaa-nuvio/nyaa.js:219-232`'s `var quality = ...` / `name: item.title` usage so the pushed result reads:

```javascript
          var quality = parseQuality(item.title);
          var tags = detectAudioTags(item.title);
          var magnet = buildMagnet(item.infoHash, item.title);

          results.push({
            title: item.title,
            name: formatStreamName(item, quality, tags),
            url: magnet,
            infoHash: item.infoHash.toLowerCase(),
            quality: quality,
            size: item.size,
            seeders: item.seeders,
            provider: "Nyaa",
            type: "tv"
          });
```

`title` stays the raw torrent title on purpose: the existing integration test at `nyaa-nuvio/test.js:116` greps `r.title` for `SubsPlease`, and the app may key off it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "feat(nyaa): Torrentio-style stream labels with audio/sub tags"
```

---

### Task 4: Part B — live best trackers

**Files:**
- Modify: `nyaa-nuvio/nyaa.js` (add `BEST_TRACKERS_URL`, `initBestTrackers`, next to the `getBestTrackers` stub from Task 2)
- Modify: `nyaa-nuvio/nyaa.js:152-154` (`getStreams` fires the fetch, does not await it)
- Modify: `nyaa-nuvio/test.js` (new assertions)

- [ ] **Step 1: Write the failing test**

Insert before the `return ctx.getStreams(...)` line in `runOffline()`:

```javascript
  // ---- Part B: live best trackers ----
  assert("getBestTrackers defaults to empty before fetch", Array.isArray(ctx.getBestTrackers()) && ctx.getBestTrackers().length === 0);
  return ctx.initBestTrackers().then(function () {
    var best = ctx.getBestTrackers();
    assert("initBestTrackers parses tracker lines", best.length === 2);
    assert("initBestTrackers strips comments and blanks",
      best[0] === "udp://tracker.one.example:6969/announce" && best[1] === "udp://tracker.two.example:451/announce");
    var withBest = ctx.mergeTrackers(best);
    assert("best trackers slot in after the anime block",
      withBest[0] === "http://nyaa.tracker.wf:7777/announce" &&
      withBest[4] === "udp://tracker.one.example:6969/announce");
    return ctx.getStreams("122991", "tv", 1, 8);
  }).then(function (res) {
    console.log("  integration results:", res.length);
    assert("integration returns SubsPlease", res.some(function (r) { return /SubsPlease/.test(r.title); }));
    assert("integration returns English-dub", res.some(function (r) { return /Smoking Behind/.test(r.title); }));
    assert("integration names are formatted", res.every(function (r) { return r.name.split("\n").length === 4; }));
  });
```

Then delete the old three-line integration block immediately above it (currently `nyaa-nuvio/test.js:113-120`) so the mocked-fetch assertions run after the tracker fetch. The `fakeFetch` in `test.js:53` must also serve the tracker URL — add as the **first** branch:

```javascript
  function fakeFetch(url) {
    let body;
    if (url.indexOf("ngosang/trackerslist") !== -1) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(
          "# comment line\n\nudp://tracker.one.example:6969/announce\nudp://tracker.two.example:451/announce\n\n"
        )
      });
    }
    if (url.indexOf("api.themoviedb.org/3/tv/") !== -1 && url.indexOf("/translations") === -1 && url.indexOf("/alternative_titles") === -1) {
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node nyaa-nuvio/test.js`
Expected: FAIL — `ctx.initBestTrackers is not a function`.

- [ ] **Step 3: Implement the fetch**

Replace the `getBestTrackers` stub added in Task 2 with:

```javascript
var BEST_TRACKERS_URL = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";
var BEST_TRACKERS_TIMEOUT_MS = 5000;

var bestTrackersCache = null;   // null = never fetched
var bestTrackersPromise = null; // in-flight guard so concurrent calls don't stack

// Empty until initBestTrackers() succeeds. Never throws: magnets are still
// valid without trackers, they just swarm worse.
function getBestTrackers() {
  return bestTrackersCache || [];
}

function initBestTrackers() {
  if (bestTrackersCache) return Promise.resolve(bestTrackersCache);
  if (bestTrackersPromise) return bestTrackersPromise;

  bestTrackersPromise = Promise.race([
    fetch(BEST_TRACKERS_URL, { headers: { "User-Agent": USER_AGENT } })
      .then(function (res) {
        if (!res || !res.ok) throw new Error("status " + (res && res.status));
        return res.text();
      }),
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("timeout")); }, BEST_TRACKERS_TIMEOUT_MS);
    })
  ])
    .then(function (text) {
      var list = [];
      var lines = String(text).split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/^\s+|\s+$/g, "");
        // Announce URLs never contain spaces; comment and blank lines do.
        if (line && line.indexOf(" ") === -1 && line.indexOf("#") !== 0) list.push(line);
      }
      bestTrackersCache = list;
      return list;
    })
    .catch(function (e) {
      console.error("best trackers fetch failed:", e.message || e);
      bestTrackersCache = [];
      return [];
    });

  return bestTrackersPromise;
}
```

- [ ] **Step 4: Fire it without blocking `getStreams`**

At the top of `getStreams` (`nyaa-nuvio/nyaa.js:152`), as the first statement inside the function:

```javascript
  // Warm the tracker list in the background. Never awaited: a slow or dead
  // tracker host must not delay or fail a stream request.
  try { initBestTrackers(); } catch (e) { /* best effort */ }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 6: Verify the failure path degrades quietly**

Temporarily point `BEST_TRACKERS_URL` at an unreachable host, run `node nyaa-nuvio/test.js`, confirm `best trackers fetch failed:` is logged and the suite still passes, then restore the URL.

Run: `node nyaa-nuvio/bench.js`
Expected: `current` F1 identical to the Task 1 baseline.

- [ ] **Step 7: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "feat(nyaa): fetch live best trackers once per process with static fallback"
```

---

### Task 5: Part C — vendored `parse-torrent-title`, default off

Read the probe output in Step 4 before writing the matcher. `parse-torrent-title` **has no handler for the SubsPlease bare `- 08` form** — it returns `season` but no `episode` for `S4 - 14` and `Season 2 - 08`. That is exactly why Part C must union with the existing matcher rather than replace it.

**Files:**
- Modify: `nyaa-nuvio/nyaa.js` (vendored PTT block, `USE_PTT`, `matchEpisodePTT`, call-site change at `nyaa-nuvio/nyaa.js:214`)
- Modify: `nyaa-nuvio/test.js` (new assertions)
- Create: `nyaa-nuvio/bench.js` already gates this (Task 1)

- [ ] **Step 1: Write the failing test**

Insert before the tracker assertions from Task 4 in `runOffline()`:

```javascript
  // ---- Part C: parse-torrent-title ----
  assert("PTT namespace is exposed", ctx.PTT && typeof ctx.PTT.parse === "function");
  var pttSxe = ctx.PTT.parse("[DKB] Tensei shitara Slime Datta Ken - S04E14 [1080p][HEVC x265 10bit][Multi-Subs][weekly]");
  assert("PTT reads season 4", pttSxe.season === 4);
  assert("PTT reads episode 14", pttSxe.episode === 14);
  var pttBare = ctx.PTT.parse("[SubsPlease] Sousou no Frieren - 08 (1080p) [ABCD1234].mkv");
  assert("PTT finds no episode for bare '- 08' form", pttBare.episode === undefined);

  assert("matchEpisodePTT matches S04E14", ctx.matchEpisodePTT("Tensei shitara Slime Datta Ken - S04E14 [1080p]", 4, 14, null) === true);
  assert("matchEpisodePTT rejects wrong episode", ctx.matchEpisodePTT("Tensei shitara Slime Datta Ken - S04E14 [1080p]", 4, 15, null) === false);
  assert("matchEpisodePTT rejects wrong season", ctx.matchEpisodePTT("Tensei shitara Slime Datta Ken - S04E14 [1080p]", 3, 14, null) === false);
  assert("matchEpisodePTT delegates bare dash form to matchEpisode",
    ctx.matchEpisodePTT("Super no Ura de Yani Suu Futari - 08 (1080p)", 1, 8, null) === true);
  assert("matchEpisodePTT survives a malformed title",
    ctx.matchEpisodePTT("]]]]", 1, 8, null) === false);
  assert("USE_PTT is false by default", ctx.USE_PTT === false);
```

And add a gated-path test at the end of `runOffline`, before the final return:

```javascript
    var gated = ctx.getStreams("122991", "tv", 1, 8).then(function (r) {
      assert("default run still returns formatted names", r.length > 0 && r[0].name.split("\n").length === 4);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node nyaa-nuvio/test.js`
Expected: FAIL — `ctx.PTT` is undefined.

- [ ] **Step 3: Vendor `parse-torrent-title` into `nyaa.js`**

The vendored block is upstream source, unmodified except for the CommonJS wrapper. Insert near the top of `nyaa-nuvio/nyaa.js`, after the `MAX_STREAMS` declaration:

```javascript
// ---------------------------------------------------------------------------
// parse-torrent-title@3.0.1 — vendored verbatim from
// https://registry.npmjs.org/parse-torrent-title/-/parse-torrent-title-3.0.1.tgz
// Retrieved 2026-09-26. Upstream is ISC licensed (see LICENSE in the tarball).
// The plugin runtime loads a single file with no bundler, so this cannot be a
// dependency. Upstream internals are unmodified; only the CommonJS
// require/exports wrapper is replaced by this IIFE.
// ---------------------------------------------------------------------------
var PTT = (function () {
  function extendOptions(options) {
    options = options || {};
    var defaultOptions = { skipIfAlreadyFound: false, type: "string" };
    options.skipIfAlreadyFound = options.skipIfAlreadyFound || defaultOptions.skipIfAlreadyFound;
    options.type = options.type || defaultOptions.type;
    return options;
  }

  function createHandlerFromRegExp(name, regExp, options) {
    var transformer;
    if (!options.type) transformer = function (input) { return input; };
    else if (options.type.toLowerCase() === "lowercase") transformer = function (input) { return input.toLowerCase(); };
    else if (options.type.toLowerCase().slice(0, 4) === "bool") transformer = function () { return true; };
    else if (options.type.toLowerCase().slice(0, 3) === "int") transformer = function (input) { return parseInt(input, 10); };
    else if (options.type.toLowerCase().slice(0, 5) === "float") transformer = function (input) { return parseFloat(input); };
    else transformer = function (input) { return input; };

    function handler(opts) {
      var title = opts.title, result = opts.result;
      if (result[name] && options.skipIfAlreadyFound) return null;
      var match = title.match(regExp);
      var rawMatch = match ? match[0] : undefined;
      var cleanMatch = match ? match[1] : undefined;
      if (rawMatch) {
        var value = options.value || transformer(cleanMatch || rawMatch);
        if (!options.skipIfAlreadyFound && name in result && result[name] !== value) {
          result[name + "list"] = (result[name + "list"] || []).concat([result[name], value]);
        }
        if (!(name in result)) result[name] = value;
        return match.index;
      }
      return null;
    }
    handler.handlerName = name;
    return handler;
  }

  function cleanTitle(rawTitle) {
    var cleanedTitle = rawTitle.replace(/^\.+|\.+$/g, "");
    if (cleanedTitle.indexOf(" ") === -1 && cleanedTitle.indexOf(".") !== -1) {
      cleanedTitle = cleanedTitle.replace(/\./g, " ");
    }
    cleanedTitle = cleanedTitle.replace(/_/g, " ");
    cleanedTitle = cleanedTitle.replace(/([(_]|- )$/, "").replace(/^\s+|\s+$/g, "");
    return cleanedTitle;
  }

  function Parser() { this.handlers = []; }

  Parser.prototype.addHandler = function (handlerName, handler, options) {
    if (typeof handler === "undefined" && typeof handlerName === "function") {
      handler = handlerName; handler.handlerName = "unknown";
    } else if (typeof handlerName === "string" && handler instanceof RegExp) {
      options = extendOptions(options);
      handler = createHandlerFromRegExp(handlerName, handler, options);
    } else if (typeof handler === "function") {
      handler.handlerName = handlerName;
    } else {
      throw new Error("Handler for " + handlerName + " should be a RegExp or a function.");
    }
    this.handlers.push(handler);
  };

  Parser.prototype.parse = function (title) {
    var result = {};
    var endOfTitle = title.length;
    for (var hi = 0; hi < this.handlers.length; hi++) {
      var matchIndex = this.handlers[hi]({ title: title, result: result });
      if (matchIndex && matchIndex < endOfTitle) endOfTitle = matchIndex;
    }
    result.title = cleanTitle(title.slice(0, endOfTitle));
    return result;
  };

  function addDefaults(parser) {
    parser.addHandler("year", /[^a-zA-Z0-9](?!^)[([]?((?:19[0-9]|20[012])[0-9])[)\]]?/, { type: "integer" });
    parser.addHandler("resolution", /([0-9]{3,4}[pi])/i, { type: "lowercase" });
    parser.addHandler("resolution", /\b(4k)/i, { type: "lowercase" });
    parser.addHandler("extended", /EXTENDED(?:[\s.]CUT)?/i, { type: "boolean" });
    parser.addHandler("theatrical", /Theatrical(?:[. ]Cut)?/, { type: "boolean" });
    parser.addHandler("uncut", /.+\bUNCUT\b/i, { type: "boolean" });
    parser.addHandler("openmatte", /OPEN[. ]MATTE/i, { type: "boolean" });
    parser.addHandler("downscaled", /\bDS4K\b/i, { value: "4k" });
    parser.addHandler("hybrid", /\bhybrid(\b|\d)/i, { type: "boolean" });
    parser.addHandler("convert", /CONVERT/, { type: "boolean" });
    parser.addHandler("hardcoded", /HC|HARDCODED/, { type: "boolean" });
    parser.addHandler("remux", /REMUX/i, { type: "boolean" });
    parser.addHandler("proper", /\b(?:REAL.)?PROPER\b/i, { type: "boolean" });
    parser.addHandler("repack", /REPACK|RERIP/i, { type: "boolean" });
    parser.addHandler("internal", /\b[iI]NTERNAL\b/, { type: "boolean" });
    parser.addHandler("retail", /\bRetail\b/, { type: "boolean" });
    parser.addHandler("remastered", /\bRemaster(?:ed)?\b/i, { type: "boolean" });
    parser.addHandler("unrated", /\bunrated|uncensored\b/i, { type: "boolean" });
    parser.addHandler("extras", /(?<=\b[12]\d{3}\b).*(\b|\.)\b(Extras?|Bonus|Extended[ ._-]Clip|Special Feature[s]?)\b/i, { type: "boolean" });
    parser.addHandler("criterion", /\bCriterion\b/, { type: "boolean" });
    parser.addHandler("region", /(?:\b|[Dd](?:vd|VD))(R[0-9])/);
    parser.addHandler("container", /\b(MKV|AVI|MP4)\b/i, { type: "lowercase" });
    parser.addHandler("source", /\b(?:HD-?)?CAM\b/, { type: "lowercase" });
    parser.addHandler("source", /\b(?:HD-?)?T(?:ELE)?S(?:YNC)?\b/i, { value: "telesync" });
    parser.addHandler("source", /\bHD-?Rip\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bBRRip\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bBDRip|BluRayRip\b/i, { value: "bdrip" });
    parser.addHandler("source", /\bDVDRip\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bDVD(?:R[0-9])?\b/i, { value: "dvd" });
    parser.addHandler("source", /\bDVDscr\b/i, { type: "lowercase" });
    parser.addHandler("source", /\b(?:HD-?)?TVRip\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bTC\b/, { type: "lowercase" });
    parser.addHandler("source", /\bPPVRip\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bR5\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bVHSSCR\b/i, { type: "lowercase" });
    parser.addHandler("source", /((?:\bBlu-?Ray)|((?:\b|\d)BR))\b/i, { value: "bluray" });
    parser.addHandler("source", /\bWEB(?:-?DL)?\b(?!-?RIP)/i, { value: "web-dl" });
    parser.addHandler("source", /\bWEB-?Rip\b/i, { type: "lowercase" });
    parser.addHandler("source", /\b(?:DL|WEB|BD|BR)MUX\b/i, { type: "lowercase" });
    parser.addHandler("source", /\b(DivX|XviD)\b/, { type: "lowercase" });
    parser.addHandler("source", /HDTV/i, { type: "lowercase" });
    parser.addHandler("source", /\bIMAX[. -]Enhanced\b/i, { value: "imax-enhanced" });
    parser.addHandler("source", /\bIMAX\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bHDDVD\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bNTSC\b/i, { type: "lowercase" });
    parser.addHandler("source", /\bPAL\b/i, { type: "lowercase" });
    parser.addHandler("service", /\bAMZN|Amazon\b/i, { value: "AMZN" });
    parser.addHandler("service", /\bH?MAX\b/, { value: "HMAX" });
    parser.addHandler("service", /\b(?<!DTS-HD[\s\-\.])MA\b/i, { value: "MA" });
    parser.addHandler("service", /\b(NFLX|NF|Netflix)\b/i, { value: "NFLX" });
    parser.addHandler("service", /\biT(?:unes)\b/, { value: "iT" });
    parser.addHandler("codec", /h[-. ]?265|hevc/i, { value: "h265" });
    parser.addHandler("codec", /h[-. ]?264|avc/i, { value: "h264" });
    parser.addHandler("codec", /dvix|mpeg2|divx|xvid|x[-. ]?26[45]/i, { type: "lowercase" });
    parser.addHandler("codec", function (opts) {
      if (opts.result.codec) opts.result.codec = opts.result.codec.replace(/[ .-]/, "");
    });
    parser.addHandler("color", /\bHDR(?:10)?\b/i, { value: "HDR" });
    parser.addHandler("color", /\bSDR\b/i, { value: "SDR" });
    parser.addHandler("color", /\b(?:DV|DoVi|Dolby\sVision)\b/i, { value: "DV" });
    parser.addHandler("audio", /\bATMOS\b|DA\d/i, { value: "atmos" });
    parser.addHandler("audio", /MD|MP3|mp3|FLAC|TrueHD/, { type: "lowercase" });
    parser.addHandler("audio", /\bDD-EX(\b|\d)/i, { value: "dd-ex" });
    parser.addHandler("audio", /\bDD(?:\+|P)|EAC-?3/i, { value: "ddp" });
    parser.addHandler("audio", /\b(DD(?!-EX)(?:\b|\d)|AC-?3)/i, { value: "dd" });
    parser.addHandler("audio", /AAC(?:[. ]?2[. ]?0)?/, { value: "aac" });
    parser.addHandler("audio", /DTS-ES/, { type: "lowercase" });
    parser.addHandler("audio", /DTS-HD[\s-.]?(MA|Master Audio)/, { value: "dts-hd-ma" });
    parser.addHandler("audio", /DTS(?:[- ]?HD)/, { value: "dts-hd", skipIfAlreadyFound: true });
    parser.addHandler("audio", /DTS/, { value: "dts", skipIfAlreadyFound: true });
    parser.addHandler("channels", /\d+[.\s](?:1|0)\b/i);
    parser.addHandler("channels", /2(?:ch)/, { value: 2.0 });
    parser.addHandler("channels", /6(?:ch)/, { value: 5.1 });
    parser.addHandler("channels", /8(?:ch)/, { value: 7.1 });
    parser.addHandler("bitdepth", /\b(8|10|12|16|24)[-\s.]?bits?\b/i, { type: "integer" });
    parser.addHandler("samplerate", /\b((?:\d+)(?:\.\d+)?)[-\s.]?kHz?\b/i, { type: "float" });
    parser.addHandler("group", /-[ ([]*(?:\w+[ \][)]+)?(\w+(?:\.\w+)?(?<!\.mkv|\.mp4))[)\]]?(?:\.(?:mkv|mp4))?$/i);
    parser.addHandler("season", /([0-9]{1,2})xall/i, { type: "integer" });
    parser.addHandler("season", /S([0-9]{1,2}) ?E[0-9]{1,2}/i, { type: "integer" });
    parser.addHandler("season", /([0-9]{1,2})x[0-9]{1,2}/, { type: "integer" });
    parser.addHandler("season", /(?:Saison|Season)[. _-]?([0-9]{1,2})/i, { type: "integer" });
    parser.addHandler("season", /\bS([0-9]{1,2})(?![0-9])/i, { type: "integer" });
    parser.addHandler("episode", /S[0-9]{1,2} ?E([0-9]{1,5})/i, { type: "integer" });
    parser.addHandler("episode", /[0-9]{1,2}x([0-9]{1,5})/, { type: "integer" });
    parser.addHandler("episode", /[ée]p(?:isode)?[. _-]?([0-9]{1,5})/i, { type: "integer" });
    parser.addHandler("language", /\bMULTi(?:Lang|-audio|-VF2)?\b/i, { value: "multi" });
    parser.addHandler("language", /Dual(?:[- ]Audio)?|[ .]DL[ .]/i, { value: "dual" });
    parser.addHandler("language", /\bDUBBED\b/, { type: "lowercase" });
    parser.addHandler("language", /\bENG(?:LISH)?\b/i, { value: "eng" });
    parser.addHandler("language", /\bJPN\b/i, { type: "lowercase" });
    parser.addHandler("language", /\bITA(?:LIAN)?\b/, { value: "ita" });
    parser.addHandler("language", /\bFR(?:ENCH)?\b/, { type: "lowercase" });
  }

  var defaultParser = new Parser();
  addDefaults(defaultParser);

  return {
    parse: function (title) { return defaultParser.parse(title); },
    addDefaults: addDefaults,
    addHandler: function (name, handler, options) { defaultParser.addHandler(name, handler, options); },
    Parser: Parser
  };
})();
```

I dropped upstream's per-service abbreviation handlers (`AUBC`, `ATVP`, `BNGE`, `DLWP`, `DSCP`, `DSNP`, `FDNG`, `HULU`, `NL`, `NORDiC`, `ViETNAM`, `FLEMISH`, `GERMAN`, `NORDIC`, `RoSubbed`, `Truefrench`, `VOST`, `RUS`, `UKR`, `encoder`) because this plugin only consumes `season`, `episode`, and `language`. **Verify this claim in Step 4** — if the benchmark shows a false positive that traces to a dropped handler, add that specific handler back.

- [ ] **Step 4: Run a probe before writing the matcher**

Run:

```bash
node -e "const vm=require('vm'),fs=require('vm'),p=require('path');const src=fs.readFileSync(p.join('nyaa-nuvio','nyaa.js'),'utf8');const ctx={console,setTimeout,clearTimeout,encodeURIComponent,decodeURIComponent,String,parseInt,isNaN,Math,Promise,RegExp,Object,Array,Error,JSON,fetch:()=>Promise.reject(new Error('x')),module:{exports:{}},global:{}};vm.createContext(ctx);vm.runInContext(src,ctx);['[SubsPlease] Sousou no Frieren - 08 (1080p) [ABCD1234].mkv','[SubsPlease] Tensei Shitara Slime Datta Ken S4 - 14 (1080p) [22959D06].mkv','[DKB] Tensei shitara Slime Datta Ken - S04E14 [1080p][HEVC x265 10bit][Multi-Subs][weekly]','[EMBER] Show Title S02E08 1080p WEB-DL AAC2.0 H.264-VARYG','[SubsPlease] Code Geass: Dakkan no Roze - 01 ~ 12 [BATCH]','[AniDL] Show [08][WebRip][HEVC_AAC]'].forEach(t=>console.log(JSON.stringify(ctx.PTT.parse(t)),' <= ',t));"
```

Expected: `{season:4, episode:14, ...}` for the S04E14 title, `{resolution:"1080p", container:"mkv"}` with **no** `episode` for the bare `- 08` title, and `{season:2, episode:8, ...}` for S02E08. If any of those differ, fix the vendored handlers before continuing.

- [ ] **Step 5: Implement the matcher and the flag**

Add next to the other episode-matching code, after `matchEpisode()` (`nyaa-nuvio/nyaa.js:596`):

```javascript
// Opt-in. Nuvio injects globals the same way it injects TMDB_API_KEY (nyaa.js:21).
var USE_PTT = (typeof NYAA_PTT !== "undefined" && NYAA_PTT === "1");

// Augments matchEpisode(); it never replaces it. parse-torrent-title has no
// handler for the SubsPlease bare "- 08" absolute form (it returns a season but
// no episode), so delegating the no-episode case to matchEpisode() is what keeps
// this a strict superset of today's results.
function matchEpisodePTT(title, requestedSeason, requestedEpisode, absoluteNumber) {
  var reqEp = parseInt(requestedEpisode, 10);
  var reqSeason = parseInt(requestedSeason, 10);
  var abs = (absoluteNumber != null) ? parseInt(absoluteNumber, 10) : NaN;
  if (isNaN(reqEp)) return false;

  var parsed;
  try {
    parsed = PTT.parse(title);
  } catch (e) {
    console.error("PTT parse failed:", e.message || e);
    return false;
  }

  if (parsed.season !== undefined && parsed.season !== reqSeason) return false;

  if (parsed.episode !== undefined) {
    if (parsed.episode === reqEp) return true;
    if (!isNaN(abs) && parsed.episode === abs) return true;
    return false;
  }

  return matchEpisode(title, requestedSeason, requestedEpisode, absoluteNumber);
}
```

- [ ] **Step 6: Wire the union into the call site**

At `nyaa-nuvio/nyaa.js:214`, replace:

```javascript
          var match = matchEpisode(item.title, season, episode, abs);
```

with:

```javascript
          var match = matchEpisode(item.title, season, episode, abs);
          // Union, never replacement: the current matcher runs first and PTT only
          // gets a say when it found nothing. Guarantees zero lost results.
          if (!match && USE_PTT) match = matchEpisodePTT(item.title, season, episode, abs);
```

- [ ] **Step 7: Run the tests**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0, including `USE_PTT is false by default`.

- [ ] **Step 8: Run the gate**

Run: `node nyaa-nuvio/bench.js --gate`
Expected: a `current` / `ptt` / `hybrid` table, the verdict-change list, and either `GATE PASS` or `GATE FAIL`.

**This is the decision point.** If `GATE FAIL`, Part C does not ship — record the numbers in the spec appendix, and do not flip `USE_PTT` on. If `GATE PASS`, continue to Task 6.

Also run the default-mode check: `node nyaa-nuvio/bench.js` uses two contexts, one with `NYAA_PTT` unset. Confirm the `hybrid` row's false-negative count is `0` — that is the superset guarantee, and a non-zero value means Task 5 Step 6 is wrong.

- [ ] **Step 9: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "feat(nyaa): vendored parse-torrent-title matcher, opt-in via NYAA_PTT"
```

---

### Task 6: Measure the result and record the verdict

**Files:**
- Create: `nyaa-nuvio/tracker-health.js`
- Modify: `nyaa-nuvio/nyaa.js` (use `getStreams` unchanged; nothing required)
- Modify: `docs/superpowers/specs/2026-09-26-nyaa-addon-improvements-design.md` (results appendix)

- [ ] **Step 1: Write `nyaa-nuvio/tracker-health.js`**

Stage 4 probes **reachability**, not swarm participation. UDP uses the BEP 15 connection handshake (8-byte magic, expect a 16-byte action-0 response); HTTP(S) uses a plain GET, where any HTTP status proves the host answered.

```javascript
// Tracker reachability probe. Run: node nyaa-nuvio/tracker-health.js
// Measures liveness only. It does NOT prove the tracker has peers for a given
// infoHash -- a tracker can answer and still return an empty peer list.
const dgram = require("dgram");
const https = require("https");
const http = require("http");
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "nyaa.js"), "utf8");
const ctx = {
  console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
  String, parseInt, isNaN, Math, Promise, RegExp, Object, Array, Error, JSON,
  fetch: function () { return Promise.reject(new Error("offline")); },
  module: { exports: {} }, global: {}
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

const MAGIC = Buffer.from([0x41, 0x42, 0x54, 0x72, 0x61, 0x63, 0x6b, 0x40]);

function probeUdp(url, timeoutMs) {
  return new Promise(function (resolve) {
    let host, port;
    try {
      const u = new URL(url.replace(/^udp:\/\//, "udp://"));
      host = u.hostname; port = parseInt(u.port, 10) || 6969;
    } catch (e) { resolve({ url, ok: false, note: "bad url" }); return; }

    const socket = dgram.createSocket("udp4");
    let done = false;
    const finish = function (ok, note) {
      if (done) return;
      done = true;
      try { socket.close(); } catch (e) { /* already closed */ }
      resolve({ url, ok, note: note || "" });
    };
    socket.on("error", function (e) { finish(false, e.code || e.message); });
    socket.on("message", function (msg) {
      // 16-byte response, action id 0 = connect
      finish(msg.length >= 8 && msg.readUInt32BE(0) === 0, "action " + msg.readUInt32BE(0));
    });
    setTimeout(function () { finish(false, "timeout"); }, timeoutMs || 5000);
    socket.send(MAGIC, 0, MAGIC.length, port, host, function (e) {
      if (e) finish(false, e.code || e.message);
    });
  });
}

function probeHttp(url, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (ok, note) {
      if (done) return;
      done = true;
      resolve({ url, ok, note: note || "" });
    };
    const mod = url.indexOf("https:") === 0 ? https : http;
    const req = mod.get(url, function (res) {
      res.resume();
      finish(true, "http " + res.statusCode);
    });
    req.on("error", function (e) { finish(false, e.code || e.message); });
    req.setTimeout(timeoutMs || 8000, function () { req.destroy(); finish(false, "timeout"); });
  });
}

(async function () {
  const sets = {
    "current (legacy 10)": ctx.TRACKERS,
    "anime set only": ctx.TRACKERS_ANIME,
    "merged (shipped)": ctx.mergeTrackers([])
  };
  for (const name of Object.keys(sets)) {
    const list = sets[name];
    const results = [];
    for (const t of list) {
      results.push(t.indexOf("udp://") === 0 ? await probeUdp(t) : await probeHttp(t));
    }
    const alive = results.filter(function (r) { return r.ok; }).length;
    console.log("\n" + name + ": " + alive + "/" + results.length + " reachable");
    for (const r of results) {
      console.log("  " + (r.ok ? "ALIVE " : "DEAD  ") + r.url + "  " + r.note);
    }
  }
})();
```

- [ ] **Step 2: Run the tracker probe**

Run: `node nyaa-nuvio/tracker-health.js`
Expected: a per-set reachable count. UDP probes may be blocked on some networks — report that honestly rather than tuning the number.

- [ ] **Step 3: Run the live end-to-end comparison**

Run: `LIVE=1 node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED` plus the live assertions. Record the per-title match counts printed by the `live old '...'` lines.

- [ ] **Step 4: Write the results appendix**

Append to the design spec, replacing the placeholder-free structure below with the real numbers you collected:

```markdown
## Appendix A — Measured results (2026-09-26)

### A.1 Matcher A/B (Task 1 baseline vs Task 5)

| Matcher | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| current (baseline) | | | | | | | |
| ptt only | | | | | | | |
| hybrid (shipped) | | | | | | | |

Gate: hybrid F1 > current F1 AND hybrid FN = 0 -> PASS/FAIL

### A.2 Live end-to-end (Task 6 Step 3)

| Title | S | E | Streams before | Streams after |
|---|---|---|---|---|

### A.3 Tracker reachability (Task 6 Step 2)

| Set | Reachable | Total |
|---|---|---|

### A.4 Verdict

State plainly whether Part C ships (gate pass) and whether the anime tracker set
measurably helped. If a number is unavailable, say so instead of estimating.
```

- [ ] **Step 5: Commit**

```bash
git add nyaa-nuvio/tracker-health.js docs/superpowers/specs/2026-09-26-nyaa-addon-improvements-design.md
git commit -m "test(nyaa): measure matcher A/B, live results, and tracker reachability"
```

---

### Task 7: Ship the release metadata

**Files:**
- Modify: `nyaa-nuvio/manifest.json`

- [ ] **Step 1: Bump the version**

In `nyaa-nuvio/manifest.json`, set the top-level `"version"` to `"1.1.0"`, the `scrapers[0].version` to `"1.1.0"`, and update `description` to `"Anime torrents from Nyaa.si - RSS episode matching, anime tracker swarm, formatted labels"`.

- [ ] **Step 2: Verify everything still passes**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`.

Run: `node nyaa-nuvio/bench.js --gate`
Expected: `GATE PASS` (or the recorded FAIL from Task 5, unchanged).

Run: `node -e "JSON.parse(require('fs').readFileSync('nyaa-nuvio/manifest.json','utf8')); console.log('manifest ok')"`
Expected: `manifest ok`.

- [ ] **Step 3: Confirm no stray artifacts**

Run: `git status --short`
Expected: only `nyaa-nuvio/manifest.json` modified. `corpus.json`, `bench.js`, and `tracker-health.js` are already committed and must be tracked, not ignored.

- [ ] **Step 4: Commit**

```bash
git add nyaa-nuvio/manifest.json
git commit -m "chore(nyaa): bump to 1.1.0 for tracker and label improvements"
```

Do not push. Leave the branch for review.

---

## Self-review notes

- **Spec coverage:** Part A1 → Task 2, Part A2 → Task 3, Part B → Task 4, Part C → Task 5, Stages 1-2 → Task 1, Stage 3-4 → Task 6, file list → Tasks 1-7. Every spec section maps to a task.
- **Correction applied during planning:** spec 3.2 originally ordered live-best-trackers before the anime set, which at a 25 cap can evict all four anime trackers. Spec updated to anime-first; Task 2 Step 3 implements anime-first and tests for it explicitly.
- **Type consistency:** `mergeTrackers(best)`, `getBestTrackers()`, `initBestTrackers()`, `detectAudioTags(title)`, `formatStreamName(item, quality, tags)`, `matchEpisodePTT(title, season, episode, absolute)`, `USE_PTT` are each defined once and used with the same signature everywhere.
