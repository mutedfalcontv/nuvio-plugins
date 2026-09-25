# Nyaa Addon Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add anime tracker support, Torrentio-style stream labels, live best trackers, and four targeted fixes to the episode matcher, with a committed corpus and before/after benchmark that proves each part actually helps.

**Architecture:** Four independent, individually revertible blocks inside the single-file plugin `nyaa-nuvio/nyaa.js` (the runtime loads one file per scraper and provides no bundler, so nothing can be imported). Part C hardens the four branches of the existing `matchEpisode` that were measured to be wrong, rather than adding a competing matcher, so no previously-matching verdict can flip. Measurement lives outside the plugin: `corpus.json` (frozen ground truth) plus `bench.js` (single-matcher scorer with a hard gate) and `tracker-health.js` (Stage 4 probe).

**Tech Stack:** JavaScript ES5-style CommonJS (Hermes-compatible, no optional chaining), Node `vm` for the offline test harness, Node `dgram`/`https` for tracker probes.

**Design spec:** `docs/superpowers/specs/2026-09-26-nyaa-addon-improvements-design.md`

> **Superseded decision.** This plan originally vendored `parse-torrent-title@3.0.1` as a flag-gated second matcher. That was built and then measured, and it resolved **zero** of the 8 real matcher gaps — PTT has no bare-number handler, so every one of them fell back to `matchEpisode` anyway. Part C is now matcher hardening. See spec 3.4.

**Ground rules for every task:**
- The plugin is loaded by a `vm` context that only provides: `console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, String, parseInt, isNaN, Math, Promise, RegExp, Object, Array, Error, JSON, fetch, module, global`. **Do not use `parseFloat`, `Array.isArray`, `Object.assign`, template literals, or optional chaining in `nyaa.js`** — they will be `undefined` in the sandbox and in Hermes. Use `typeof x !== "undefined"` guards for any new global.
- `node nyaa-nuvio/test.js` must print `ALL TESTS PASSED` (exit 0) after every task.
- Commit after every task. Never amend.

---

### Task 1: Extend the corpus so it can actually detect improvement, and fix the bench gate

The 20 cases committed earlier were mirrored from `test.js`, which the pre-existing matcher already passes 10/10 (F1 1.000). That made the old gate `hybrid F1 > current F1` unsatisfiable — nothing beats 1.000 — and it meant the corpus could only ever prove non-regression. This task adds the discriminating cases and makes the gate reachable.

**Files:**
- Modify: `nyaa-nuvio/corpus.json` (append 22 cases)
- Modify: `nyaa-nuvio/bench.js` (single matcher, honest gate)

- [ ] **Step 1: Append 9 positives to `corpus.json`**

Every one of these is a real Nyaa release-name pattern that the current `matchEpisode` gets **wrong**. Insert them after case `20-ep239-not-s2` in the `cases` array:

```json
    { "id": "21-abs-4digit-animatime", "title": "[Anime Time] One Piece - 1122 (1080p) [ABCD1234].mkv", "season": 1, "episode": 1122, "absolute": null, "expect": true },
    { "id": "22-abs-4digit-no-paren", "title": "[Animechap] One Piece - 1123 [1080p][HEVC AAC][x265]", "season": 1, "episode": 1123, "absolute": null, "expect": true },
    { "id": "23-v2-suffix-subsplease", "title": "[SubsPlease] Show - 09v2 (1080p)", "season": 1, "episode": 9, "absolute": null, "expect": true },
    { "id": "24-v2-suffix-doki", "title": "[Doki] Show - 08v2 (1080p) [HEVC-10bit]", "season": 1, "episode": 8, "absolute": null, "expect": true },
    { "id": "25-v2-suffix-animatime", "title": "[Anime Time] Show - 12v2 (1080p)", "season": 1, "episode": 12, "absolute": null, "expect": true },
    { "id": "26-v3-suffix", "title": "[Anime Time] Show - 12v3 (1080p)", "season": 1, "episode": 12, "absolute": null, "expect": true },
    { "id": "27-abs-4digit-subsplease", "title": "[SubsPlease] One Piece - 1150 (1080p) [A1B2C3D4].mkv", "season": 1, "episode": 1150, "absolute": null, "expect": true },
    { "id": "28-parenthesised-season", "title": "[Judas] Show (Season 2) - 13 [1080p][HEVC x265 10bit][Multi-Subs]", "season": 2, "episode": 13, "absolute": null, "expect": true },
    { "id": "29-spaced-s2-e08", "title": "[EngSub] Show S2 - E08 (1080p)", "season": 2, "episode": 8, "absolute": null, "expect": true }
```

- [ ] **Step 2: Append 13 negatives to `corpus.json`**

Widening episode patterns is exactly the change that turns `[2024]`, `1080p` and `x265` into episode numbers. These are the load-bearing half of the corpus — each one guards a specific branch that Task 2 widens. Insert them after the last positive:

```json
    { "id": "30-neg-4digit-wrong-ep", "title": "[Anime Time] One Piece - 1122 (1080p) [ABCD1234].mkv", "season": 1, "episode": 1123, "absolute": null, "expect": false },
    { "id": "31-neg-4digit-season-2", "title": "[Anime Time] One Piece - 1122 (1080p) [ABCD1234].mkv", "season": 2, "episode": 1122, "absolute": null, "expect": false },
    { "id": "32-neg-v2-not-previous-ep", "title": "[SubsPlease] Show - 09v2 (1080p)", "season": 1, "episode": 8, "absolute": null, "expect": false },
    { "id": "33-neg-v2-not-80", "title": "[Doki] Show - 08v2 (1080p) [HEVC-10bit]", "season": 1, "episode": 80, "absolute": null, "expect": false },
    { "id": "34-neg-resolution-2160", "title": "[Group] Show S01E08 1080p 2160p HEVC x265", "season": 1, "episode": 2160, "absolute": null, "expect": false },
    { "id": "35-neg-codec-265", "title": "[Group] Show S01E08 1080p x265 10bit", "season": 1, "episode": 265, "absolute": null, "expect": false },
    { "id": "36-neg-year-in-parens", "title": "[Group] Movie (2024) [1080p] [x264]", "season": 1, "episode": 2024, "absolute": null, "expect": false },
    { "id": "37-neg-year-after-dash", "title": "[Group] Show - 08 (2024) [1080p]", "season": 1, "episode": 2024, "absolute": null, "expect": false },
    { "id": "38-neg-parenthesised-season-s1", "title": "[Judas] Show (Season 2) - 13 [1080p][HEVC x265 10bit][Multi-Subs]", "season": 1, "episode": 13, "absolute": null, "expect": false },
    { "id": "39-neg-parenthesised-season-wrong-ep", "title": "[Judas] Show (Season 2) - 13 [1080p][HEVC x265 10bit][Multi-Subs]", "season": 2, "episode": 12, "absolute": null, "expect": false },
    { "id": "40-neg-spaced-s2-not-s1", "title": "[EngSub] Show S2 - E08 (1080p)", "season": 1, "episode": 8, "absolute": null, "expect": false },
    { "id": "41-neg-spaced-s2-not-s3", "title": "[EngSub] Show S2 - E08 (1080p)", "season": 3, "episode": 8, "absolute": null, "expect": false },
    { "id": "42-neg-batch-after-widening", "title": "[Erai-raws] Show - 01 ~ 12 [1080p][BATCH][Multi-Subs]", "season": 2, "episode": 5, "absolute": null, "expect": false }
```

- [ ] **Step 3: Replace `bench.js` with a single-matcher scorer**

There is no second matcher any more, so the two-context harness and the three-row table go away. The A/B is now taken across commits: run the bench, record the number, change `matchEpisode`, run it again, compare.

```javascript
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
const missed = [], falsePositives = [];

for (const c of CORPUS.cases) {
  let got;
  try {
    got = ctx.matchEpisode(c.title, c.season, c.episode, c.absolute) === true;
  } catch (e) {
    got = false;
    falsePositives.push(c.id + " (threw: " + (e.message || e) + ")");
  }
  if (c.expect && got) tp++;
  else if (!c.expect && got) { fp++; falsePositives.push(c.id + " matched but should be rejected"); }
  else if (c.expect && !got) { fn++; missed.push(c.id); }
  else tn++;
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

const ok = precision === 1 && recall === 1;
console.log("\n" + (ok
  ? "GATE PASS: precision 1.000, recall 1.000, zero false negatives, zero false positives"
  : "GATE FAIL: precision " + precision.toFixed(3) + ", recall " + recall.toFixed(3) +
    ", FN " + fn + ", FP " + fp));

if (process.argv.indexOf("--gate") !== -1) process.exit(ok ? 0 : 1);
```

- [ ] **Step 4: Record the BEFORE score**

Run: `node nyaa-nuvio/bench.js`
Expected: **exactly 9 false negatives** (ids `21` through `29`) and **2 false positives** (`38-neg-parenthesised-season-s1`, `40-neg-spaced-s2-not-s1`). Precision 0.833, recall 0.526, F1 0.645. This is the number Part C has to beat. Copy the full output into the spec appendix — you will need it verbatim in Task 6.

The 2 false positives are pre-existing matcher bugs that this corpus newly exposed, not corpus errors. A title explicitly marked `(Season 2)` currently satisfies an S1 request, and `S2 - E08` currently satisfies an S1E8 request — both would open the wrong file. They are in scope for Task 2 and share a root cause with two of the misses, so the same fix clears them.

- [ ] **Step 5: Confirm the existing suite is still green**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0. You changed only measurement files.

- [ ] **Step 6: Commit**

```bash
git add nyaa-nuvio/corpus.json nyaa-nuvio/bench.js
git commit -m "test(nyaa): add probe-harvested cases so the corpus can detect improvement"
```

---

### Task 2: Part C — harden the four branches of `matchEpisode` that are measurably wrong

Every change here widens an existing branch. None of them may cause a previously-passing case to fail, which is why Task 1's negatives exist.

**Files:**
- Modify: `nyaa-nuvio/nyaa.js` (pattern constants near `nyaa.js:20-60`, logic in `matchEpisode` at `nyaa.js:492-596`)
- Modify: `nyaa-nuvio/test.js` (new assertions)

- [ ] **Step 1: Write the failing tests**

Append these inside `runOffline()` in `nyaa-nuvio/test.js`, immediately before the `return ctx.getStreams(...)` line:

```javascript
  // ---- Part C: hardened matcher branches ----
  assert("4-digit absolute dash form",
    ctx.matchEpisode("[Anime Time] One Piece - 1122 (1080p) [ABCD1234].mkv", 1, 1122, null) === true);
  assert("4-digit dash form, no parens",
    ctx.matchEpisode("[Animechap] One Piece - 1123 [1080p][HEVC AAC][x265]", 1, 1123, null) === true);
  assert("v2 revision suffix",
    ctx.matchEpisode("[SubsPlease] Show - 09v2 (1080p)", 1, 9, null) === true);
  assert("v3 revision suffix",
    ctx.matchEpisode("[Anime Time] Show - 12v3 (1080p)", 1, 12, null) === true);
  assert("parenthesised Season N",
    ctx.matchEpisode("[Judas] Show (Season 2) - 13 [1080p][HEVC x265 10bit][Multi-Subs]", 2, 13, null) === true);
  assert("spaced S2 - E08 form",
    ctx.matchEpisode("[EngSub] Show S2 - E08 (1080p)", 2, 8, null) === true);

  // Guards. Each of these is a way the widened branches could go wrong.
  assert("guard: resolution is not an episode",
    ctx.matchEpisode("[Group] Show S01E08 1080p 2160p HEVC x265", 1, 2160, null) === false);
  assert("guard: codec number is not an episode",
    ctx.matchEpisode("[Group] Show S01E08 1080p x265 10bit", 1, 265, null) === false);
  assert("guard: year is not an episode",
    ctx.matchEpisode("[Group] Movie (2024) [1080p] [x264]", 1, 2024, null) === false);
  assert("guard: v2 suffix does not shift the episode",
    ctx.matchEpisode("[SubsPlease] Show - 09v2 (1080p)", 1, 8, null) === false);
  assert("guard: v2 suffix does not concatenate to 80",
    ctx.matchEpisode("[Doki] Show - 08v2 (1080p) [HEVC-10bit]", 1, 80, null) === false);
  assert("guard: parenthesised season still blocks S1",
    ctx.matchEpisode("[Judas] Show (Season 2) - 13 [1080p]", 1, 13, null) === false);
  assert("guard: spaced S2 - E08 does not match S1 or S3",
    ctx.matchEpisode("[EngSub] Show S2 - E08 (1080p)", 1, 8, null) === false &&
    ctx.matchEpisode("[EngSub] Show S2 - E08 (1080p)", 3, 8, null) === false);
  assert("guard: batch still rejected after widening",
    ctx.matchEpisode("[Erai-raws] Show - 01 ~ 12 [1080p][BATCH][Multi-Subs]", 2, 5, null) === false);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node nyaa-nuvio/test.js`
Expected: FAIL with this precise shape:
- all **6 positive** assertions fail — those are the gaps
- **2 guard** assertions also fail: `guard: parenthesised season still blocks S1`, and the S1 half of `guard: spaced S2 - E08 does not match S1 or S3`. These are corpus cases `38` and `40`, the pre-existing false positives Task 1 exposed. They are in scope for this task.
- the other 6 guard assertions pass

If a **different** set fails, stop and report. Never edit an assertion to make it pass — the corpus ground truth was frozen for exactly this reason.

- [ ] **Step 3: Fix the dash-episode pattern (4-digit + revision suffix)**

Find `DASH_EP_PATTERN` in the constants block near the top of `nyaa.js`. It currently matches 1-2 digits followed by a non-alphanumeric boundary. Widen it to 1-4 digits and allow an optional `v2`/`v3` revision suffix, so long-running series and re-encoded re-releases resolve:

```javascript
// Group dash form: "- 08", "- 08v2", "- 1122". 1-4 digits covers long-running
// series (One Piece E1122); the trailing \w* boundary absorbs the v2/v3
// revision suffix so a re-encode of the same episode still matches.
var DASH_EP_PATTERN = /-\s+(\d{1,4})\s*(?:v\d+)?(?![0-9a-z])/i;
```

- [ ] **Step 4: Read the season off the RAW title, not the cleaned one**

`cleanTorrentTitle` strips `(...)` at `nyaa.js:483`, so by the time `SEASON_TOKEN_PATTERN` runs, `(Season 2)` is already gone and its absence is indistinguishable from "this title declares no season" — which is precisely why a Season 2 release satisfies an S1 request today. **Widening the season pattern alone cannot fix this.** The season has to be read before cleaning.

Add a raw-title probe:

```javascript
// Read on the RAW title. cleanTorrentTitle() strips "(...)" before any season
// pattern runs, so "Show (Season 2) - 13" would otherwise look season-less and
// satisfy an S1 request. Release groups routinely parenthesise the season.
var RAW_SEASON_PATTERN = /(?:^|[^A-Za-z0-9])(?:S(\d{1,2})\b|(?:Season|Saison)[.\s_-]?(\d{1,2})\b)/i;

function rawTitleSeason(title) {
  var m = String(title || "").match(RAW_SEASON_PATTERN);
  if (!m) return null;
  return parseInt(m[1] || m[2], 10);
}
```

Then, inside `matchEpisode`, compute the effective title season once and use it everywhere the code currently asks "does this title declare a season?":

```javascript
  var rawSeason = rawTitleSeason(title);
  var seasonInTitle = cleaned.match(SEASON_TOKEN_PATTERN);
  var titleSeason = rawSeason !== null
    ? rawSeason
    : (seasonInTitle ? parseInt(seasonInTitle[1] || seasonInTitle[2], 10) : null);
  var titleDeclaresSeason = titleSeason !== null;
```

Substitute `titleDeclaresSeason` for the existing `SEASON_TOKEN_PATTERN.test(cleaned)` guards in the dash branch and the Rakun trailing-number branch, and `titleSeason` for the dash branch's local `titleSeason` computation. Read the current code first and preserve the existing `if / else if` structure exactly — the chain's shape is what makes an S2 title refuse an S1 request while still honouring `absoluteNumber`. Do not introduce a second, competing definition of "does this title have a season".

This is also what makes corpus case `28` pass, not just `38`: once `(Season 2)` is honoured, the dash number `13` is correctly read as season-relative to season 2, so it matches an S2E13 request and is refused for S1.

- [ ] **Step 5: Add the spaced `S2 - E08` pattern, and stop season-less patterns firing on titled seasons**

Add a new entry to the `EPISODE_PATTERNS` array. It must declare its season group, otherwise the season-less guard rejects every non-S1 request:

```javascript
  { re: /\bS(\d{1,2})\s*-\s*E(\d{1,3})\b/i, seasonGroup: 1, epGroup: 2 }
```

That fixes corpus case `29`, but **not** `40`. `EPISODE_PATTERNS` already contains a bare `/\bE(\d+)\b/i` that matches the `E08` in `EngSub Show S2 - E08` and reports it as an episode with no season attached — and the existing guard only refuses when the *request* is not season 1, without ever checking whether the *title* declares a season. So the title's own `S2` is ignored.

Widen that guard, in the `EPISODE_PATTERNS` loop:

```javascript
    } else if (reqSeason !== 1 || titleDeclaresSeason) {
      // Season-less episode marker ("E09", "EP239", "[8]") carries no season, so
      // it only satisfies a S1 request — and only when the title itself declares
      // no season either. "EngSub Show S2 - E08" carries S2, so the bare E(\d+)
      // handler must not treat E08 as an S1 episode.
      continue;
    }
```

**This is the highest-risk edit in the task.** `titleDeclaresSeason` is true for any title containing `S<digit>`, including `S01E08` forms that may be relying on a season-less handler. The corpus is the safety net: cases `04` (`Show - S01E08`) and `18` (`Grand Blue Dreaming S03E09`) both declare a season and must keep matching. If the gate fails on either, the guard is too broad — narrow it rather than touching the corpus.

- [ ] **Step 6: Run the tests**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 7: Run the corpus gate**

Run: `node nyaa-nuvio/bench.js`
Expected: `GATE PASS`, 0 false negatives, 0 false positives, precision 1.000, recall 1.000.

**This is the decision point.** If the gate does not pass, do not proceed. Read the printed false-positive list, find which widened branch is over-matching, and tighten that branch. If you cannot make it pass without weakening a guard assertion, report BLOCKED with the specific case and the two conflicting requirements.

- [ ] **Step 8: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "fix(nyaa): match 4-digit absolute, v2 revisions, (Season N) and S2 - E08"
```

---

### Task 3: Part A1 — anime tracker set with a hard 25-tracker cap

**Files:**
- Modify: `nyaa-nuvio/nyaa.js:1-12` (add `TRACKERS_ANIME`, `MAX_TRACKERS`, `mergeTrackers`)
- Modify: `nyaa-nuvio/nyaa.js:608-615` (`buildMagnet` uses `mergeTrackers`)
- Modify: `nyaa-nuvio/test.js` (new assertions)

- [ ] **Step 1: Write the failing test**

Insert these inside `runOffline()` in `nyaa-nuvio/test.js`, immediately before the `return ctx.getStreams(...)` line:

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
Expected: FAIL — `ctx.mergeTrackers is not a function`, non-zero exit.

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

`getBestTrackers()` arrives in Task 5. Add the stub now so this task is runnable:

```javascript
var bestTrackersCache = null;

// Returns the live best-tracker list if it has been fetched, otherwise an empty
// list. Populated by initBestTrackers() in Task 5; the stub keeps buildMagnet
// correct before that fetch lands.
function getBestTrackers() {
  return bestTrackersCache || [];
}
```

- [ ] **Step 5: Run the tests**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0.

Run: `node nyaa-nuvio/bench.js`
Expected: `GATE PASS` still. Trackers must not touch matching.

- [ ] **Step 6: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "feat(nyaa): add anime tracker set with 25-tracker cap"
```

---

### Task 4: Part A2 — Torrentio-style stream labels

**Files:**
- Modify: `nyaa-nuvio/nyaa.js` (add `LANGUAGE_TAGS`, `detectAudioTags`, `formatStreamName` after `parseQuality`)
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

Insert after `parseQuality()`:

```javascript
// Audio/subtitle tags, in Torrentio's vocabulary (addon/lib/languages.js).
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

**Sandbox warning:** `\u{1F50A}` is ES6 code-point escape syntax. If Hermes rejects it, fall back to the surrogate pair `"\uD83D\uDCA9"` and `"\uD83D\uDCBF"`. Verify with `node nyaa-nuvio/test.js` — the assertion only checks that the seeders and size appear on line 3, so it will pass either way, but confirm the file loads in the vm context.

- [ ] **Step 4: Use it in the result object**

In `getStreams`, the pushed result should read:

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

`title` stays the raw torrent title on purpose: the existing integration test greps `r.title` for `SubsPlease`, and the app may key off it.

- [ ] **Step 5: Run the tests**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0.

Run: `node nyaa-nuvio/bench.js`
Expected: `GATE PASS` still.

- [ ] **Step 6: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "feat(nyaa): Torrentio-style stream labels with audio/sub tags"
```

---

### Task 5: Part B — live best trackers

**Files:**
- Modify: `nyaa-nuvio/nyaa.js` (replace the `getBestTrackers` stub from Task 3 with the real loader)
- Modify: `nyaa-nuvio/nyaa.js:152-154` (`getStreams` fires the fetch, does not await it)
- Modify: `nyaa-nuvio/test.js` (new assertions)

- [ ] **Step 1: Write the failing test**

Insert before the `return ctx.getStreams(...)` line in `runOffline()`:

```javascript
  // ---- Part B: live best trackers ----
  assert("getBestTrackers defaults to empty before fetch", ctx.getBestTrackers().length === 0);
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

Then delete the old integration block immediately above it (the three lines ending in the `return` of `runOffline`) so these assertions run after the tracker fetch. The `fakeFetch` helper in `test.js` must also serve the tracker URL — add as the **first** branch:

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

Replace the Task 3 stub with:

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

As the first statement inside `getStreams` (`nyaa-nuvio/nyaa.js:152`):

```javascript
  // Warm the tracker list in the background. Never awaited: a slow or dead
  // tracker host must not delay or fail a stream request.
  try { initBestTrackers(); } catch (e) { /* best effort */ }
```

- [ ] **Step 5: Run the tests**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 6: Verify the failure path degrades quietly**

Temporarily point `BEST_TRACKERS_URL` at an unreachable host, run `node nyaa-nuvio/test.js`, confirm `best trackers fetch failed:` is logged and the suite still passes, then restore the URL.

Run: `node nyaa-nuvio/bench.js`
Expected: `GATE PASS` still.

- [ ] **Step 7: Commit**

```bash
git add nyaa-nuvio/nyaa.js nyaa-nuvio/test.js
git commit -m "feat(nyaa): fetch live best trackers once per process with static fallback"
```

---

### Task 6: Measure the result and record the verdict

**Files:**
- Create: `nyaa-nuvio/tracker-health.js`
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
Expected: `ALL TESTS PASSED` plus the live assertions. Record the per-title match counts.

- [ ] **Step 4: Write the results appendix**

Append to the design spec, filling in the real numbers you collected. The BEFORE row is the Task 1 Step 4 output, the AFTER row is the Task 2 Step 7 output.

```markdown
## Appendix A — Measured results (2026-09-26)

### A.1 Matcher before/after (Task 1 Step 4 vs Task 2 Step 7)

| Stage | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| before hardening | | | | | | | |
| after hardening | | | | | | | |

### A.2 Live end-to-end (Task 6 Step 3)

| Title | S | E | Streams before | Streams after |
|---|---|---|---|---|

### A.3 Tracker reachability (Task 6 Step 2)

| Set | Reachable | Total |
|---|---|---|

### A.4 Verdict

State plainly whether the four hardened branches moved the number, and whether
the anime tracker set measurably helped. If a number is unavailable, say so
instead of estimating.

### A.5 Rejected: vendored parse-torrent-title

Part C was originally specified as a vendored, flag-gated `parse-torrent-title@3.0.1`
second matcher. It was built and measured against the 8 real matcher gaps and
resolved none of them: PTT has no bare-number handler, so every case returned
`season: undefined, episode: undefined` and would have fallen back to
`matchEpisode()` regardless. The design was rewritten to harden the existing
matcher instead. Roughly 200 vendored lines avoided.
```

- [ ] **Step 5: Commit**

```bash
git add nyaa-nuvio/tracker-health.js docs/superpowers/specs/2026-09-26-nyaa-addon-improvements-design.md
git commit -m "test(nyaa): measure matcher before/after, live results, tracker reachability"
```

---

### Task 7: Ship the release metadata

**Files:**
- Modify: `nyaa-nuvio/manifest.json`

- [ ] **Step 1: Bump the version**

Set the top-level `"version"` to `"1.1.0"`, the `scrapers[0].version` to `"1.1.0"`, and update `description` to `"Anime torrents from Nyaa.si - hardened episode matching, anime tracker swarm, formatted labels"`.

- [ ] **Step 2: Verify everything still passes**

Run: `node nyaa-nuvio/test.js`
Expected: `ALL TESTS PASSED`.

Run: `node nyaa-nuvio/bench.js --gate`
Expected: `GATE PASS`, exit 0.

Run: `node -e "JSON.parse(require('fs').readFileSync('nyaa-nuvio/manifest.json','utf8')); console.log('manifest ok')"`
Expected: `manifest ok`.

- [ ] **Step 3: Confirm no stray artifacts**

Run: `git status --short`
Expected: only `nyaa-nuvio/manifest.json` modified. `corpus.json`, `bench.js`, and `tracker-health.js` must be tracked, not ignored. `.playwright-mcp/` stays untracked.

- [ ] **Step 4: Commit**

```bash
git add nyaa-nuvio/manifest.json
git commit -m "chore(nyaa): bump to 1.1.0 for matcher, tracker and label improvements"
```

Do not push. Leave the branch for review.

---

## Self-review notes

- **Spec coverage:** Part C → Task 2, Part A1 → Task 3, Part A2 → Task 4, Part B → Task 5, Stages 1-2 → Task 1, Stage 3-4 → Task 6, file list → Tasks 1-7. Every spec section maps to a task.
- **Corrections applied during execution, both recorded in the spec:**
  - Spec 3.2 ordered live-best-trackers before the anime set, which at a 25 cap can evict all four anime trackers. Now anime-first, tested explicitly in Task 3.
  - Spec 3.4 specified a vendored `parse-torrent-title` matcher. Measured to resolve 0 of 8 real gaps, so it was replaced with four targeted `matchEpisode` fixes. The old gate `hybrid F1 > current F1` was also unsatisfiable at F1 1.000; the gate is now precision 1.000 / recall 1.000 on a corpus that the pre-change matcher provably fails.
- **Type consistency:** `mergeTrackers(best)`, `getBestTrackers()`, `initBestTrackers()`, `detectAudioTags(title)`, `formatStreamName(item, quality, tags)` are each defined once and used with the same signature everywhere. `matchEpisode(title, season, episode, absolute)` keeps its existing signature — Part C changes its internals, not its contract.
