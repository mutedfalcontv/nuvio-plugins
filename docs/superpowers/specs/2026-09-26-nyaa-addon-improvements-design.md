# Nyaa Addon Improvements — Design Spec

Date: 2026-09-26
Status: approved (option 1 chosen for parse-torrent-title vendoring)
Scope: `nyaa-nuvio/nyaa.js`, `nyaa-nuvio/test.js`, new `nyaa-nuvio/bench.js`, new `nyaa-nuvio/corpus.json`

## 1. Study — what problem are we solving?

### 1.1 Evidence collected

| Source | Signal |
|---|---|
| `git log` on this repo | 8 successive nyaa matcher patches: `9c98f9d`, `62a2110`, `e4db213`, `1102e8f`, `8f7682e` — each one a new hand-patched edge case |
| `nyaa.js:29-52` | 10 ad-hoc regexes plus 5 special-case branches, order-dependent, with comments admitting known weaknesses (e.g. "H.264's 264 must never be treated as a season-1 absolute episode") |
| Torrentio issues #396, #462, #466, #469 | Users report missing/wrong results for recent and older anime |
| Torrentio repo itself | Zero test files. CI is `docker build` + swarm deploy only. No regression net upstream |
| Live measurement (16 titles, 2026-09-26) | NyaaSi returns 146-374 results per title on `torrentio.strem.fun`; nyaa.si itself responds HTTP 200 with parseable HTML |

### 1.2 Diagnosis

Recall is not the bottleneck. nyaa.si is reachable, the RSS path works, and hundreds of candidates come back per request. The suspect is **precision** (streams shown for the wrong episode) and **swarm health** (magnets carrying only generic trackers, which fail to find peers for anime releases).

The matcher has been maintained by patch-accumulation: each bug report adds a branch, and no branch can be proven correct or redundant because there is no corpus to measure against.

### 1.3 Hypotheses

- **H1** — Replacing the regex list with a real torrent-title parser (`parse-torrent-title`, hereafter PTT) reduces false positives without losing true positives.
- **H2** — Anime-specific trackers measurably improve magnet viability versus the current generic 10.
- **H3** — Readable stream labels reduce user-visible confusion at zero risk to the result set.

### 1.4 Goals

1. Convert the matcher from a patch list into a parser-backed decision, gated so today's behavior stays available and reachable.
2. Build a committed corpus + A/B harness so any future matcher change is measurable instead of argued.
3. Improve magnet swarm health for anime releases.
4. Improve stream labels without touching machine-readable fields.

### 1.5 Non-goals

- Debrid resolution. NuvioWeb already resolves magnets (`NuvioWeb/js/core/debrid/directDebridResolver.js:37`, 15-minute resolve cache, `debridFileSelection.js`). Porting Torrentio's `moch/` layer into the plugin would duplicate app behaviour.
- Adding or changing sources/queries.
- Changing the set of titles queried, or the request budget (`MAX_NYAA_REQUESTS = 20`, `nyaa.js:430`).
- Depending on Torrentio's scraper. That code is not in the public repo: the addon only reads a pre-scraped database (`addon.js:87` -> `addon/lib/repository.js:20`), so nothing about nyaa.si parsing is available to copy.

## 2. Constraints

- **Single-file plugin.** `manifest.json` declares one `filename` per scraper and `test.js:8` loads all of `nyaa.js` into a `vm`. No bundler and no runtime `npm install`, so any dependency must be inlined as source.
- **Hermes runtime.** No filesystem, no native modules. PTT is pure JavaScript with zero dependencies, 23.6 KB unpacked across 8 files, so it inlines cleanly at the cost of roughly doubling `nyaa.js` (currently 22.6 KB).
- **Plugin owns magnets only.** The app resolves them.
- **Behaviour preservation.** Parts must be independently removable; the default configuration must produce the same result set as today.

## 3. Architecture

Three independent parts inside `nyaa.js`, plus measurement tooling outside it.

```
nyaa.js
  |-- existing (unchanged default path)
  |     getStreams -> titles -> buildQueries -> searchNyaa -> matchEpisode -> results
  |
  |-- Part A: tracker set + name formatting        [always on, additive]
  |     TRACKERS_ANIME (static)  -> buildMagnet()
  |     formatStreamName()                        -> result.name
  |
  |-- Part B: live best trackers                   [always on, additive]
  |     initBestTrackers() once per process, cached, try/catch
  |     merged into TRACKERS_ANIME at first buildMagnet() call
  |
  |-- Part C: PTT-backed matcher                   [OFF unless NYAA_PTT=1]
  |     vendored parse-torrent-title source (verbatim, upstream commit noted)
  |     matchEpisodePTT() -> superset of matchEpisode() results
  |     selectMatcher() reads NYAA_PTT
```

### 3.1 Part A — trackers and labels

**A1 Tracker set.** Append the anime tracker set used by Torrentio (`addon/lib/magnetHelper.js:9-15`) to the existing generic list at `nyaa.js:1-12`:

```
http://nyaa.tracker.wf:7777/announce
http://anidex.moe:6969/announce
http://tracker.anirena.com:80/announce
udp://tracker.uw0.xyz:6969/announce
```

Total tracker count is capped (see 3.2) so magnet URIs stay within what Stremio-style clients accept.

**A2 Stream labels.** Replace `name: item.title` (`nyaa.js:223`) with a Torrentio-style multi-line label, built from fields already present plus two new detector helpers:

```
1080p
[SubsPlease] Sousou no Frieren - 08 (1080p)
75 💾 900.0 MiB 💿 Nyaa
Multi Subs
```

- resolution: existing `parseQuality()` (`nyaa.js:863`)
- audio/subtitle tags: new `detectAudioTags()` driven by a language-word mapping ported from Torrentio `addon/lib/languages.js` (`dubbed`, `multi audio`, `multi subs`, `dual audio`) and the title-scanning approach of `addon/lib/subtitles.js:60`
- untagged titles get a single space instead of an empty line

**Untouched:** `title`, `url`, `infoHash`, `seeders`, `size`, `quality`, `provider`, `type`. The app's magnet resolution and de-duplication depend on these.

### 3.2 Magnet length cap

`buildMagnet()` (`nyaa.js:715` before this part, `:764` after) appends 10 trackers. With the anime set and Part B it could exceed 25. Rule: build the ordered list as

```
[anime set]                                  -> always all 4, never evicted
+ [live best trackers (Part B, if available)] -> trimmed to remaining room
+ [existing generic 10]                       -> trimmed to reach MAX_TRACKERS = 25
```

The anime set goes first on purpose. If the live best list were first it could consume all 25 slots on its own and silently drop the anime trackers, which are the entire point of Part A for this plugin. Eviction happens from the tail, never from the anime set.

Order matters for the rest: live best trackers are the healthiest of the remainder, generic trackers fill whatever is left. The result is deterministic for identical inputs, which keeps Stage 4 measurements comparable.

**The generic 10 are a fallback, not a floor — and this is the consequence to be aware of.** `room` is computed once, after the anime block, so the live list takes every remaining slot or none of them. Measured generic-survival against live-list length:

| distinct live entries | generic slots kept |
|---|---|
| 0-15 | 10 (all) |
| 16 / 17 / 19 / 20 | 5 / 4 / 2 / 1 |
| **21 or more** | **0** |

The threshold counts only entries *not already in the anime set* — a 21-entry live list that repeats the four anime URLs still leaves 4 generic slots, because dedup returns the freed room. This paragraph originally asserted that the live file "carries far more than 21 unique announce URLs" and that the generic set would therefore get **zero slots in production**. That was an assumption, and Task 5 measured it against the real file.

**Measured 2026-09-26** (live fetch, `best trackers loaded: 20 (20 live slots, 1 generic left)`): 20 announce URLs parse out of `trackers_best.txt`, all 20 distinct, none duplicating the anime set. The tail budget is 21 (25 − 4), so all 20 fit and **one** generic slot remains — filled by `udp://tracker.coppersurfer.tk:6969/announce`.

Two things the first reading of that measurement got wrong, both worth recording because the log exists to prevent them:

- Only **1** of the 10 generic entries reaches the magnet, not 4. Three generic entries (`coppersurfer` plus two others) are byte-identical to entries in the live list, so they arrive via the live list and their generic slots are never consumed. Counting "entries in the merged list that appear in `TRACKERS_GENERIC`" reports 4 and double-counts those three.
- The quantity that decides starvation is **distinct live entries not already in the anime head** — 20 here. Neither the raw parse length nor `mergeTrackers(list).length - 4` is that number: the former counts duplicates and anime repeats, the latter also counts the generic entries filling the leftover slots and reports 21 live slots for a 20-entry list. The log prints the correct figure.

So the generic set is one entry away from being empty in production today, and the list is community-maintained, so treat the starvation path as the expected outcome rather than the current one. The trade is the same either way and is intentional, not an oversight: the generic trackers carry almost no anime peers, so starving them costs this plugin very little, whereas evicting the anime set would defeat Part A entirely.

### 3.3 Part B — live best trackers

Port of Torrentio `initBestTrackers()` (`addon/lib/magnetHelper.js:8`):

- Source: `https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt`
- Fetched at most once per process **per successful fetch**, triggered lazily on the first `getStreams()` call. A *failed* fetch re-arms the guard, but no sooner than `BEST_TRACKERS_RETRY_MS` (5 minutes) later, so a tracker-host outage cannot turn into one outbound GitHub request per stream request for the life of the process while the once-only warning hides it. The guard is released rather than latched, so a transient blip at startup does not disable the live list permanently.
- The trigger sits below the `mediaType` guard: a movie request produces no magnets, so it should not pay for a tracker fetch.
- The trigger cannot be `buildMagnet()` as first written: `buildMagnet()` is synchronous and cannot await, so a first call would always build a magnet with no live trackers. Warming at the top of `getStreams()` means the first request *may* use the static set and later ones use the live list. That is a race, not a guarantee — with a fast or cached response the very first `getStreams()` can already include live trackers, because the TMDB and Nyaa round-trips give the tracker fetch time to land. The outcome is the same either way, and no code path depends on the first call being static.
- In-flight promise reused so concurrent `getStreams()` calls do not stack fetches
- 5-second timeout; any failure, non-200, or empty body is logged once and the static set is used unchanged
- Never throws into `getStreams()`
- On success the log reports the raw parse length, the live slots consumed, and the generic budget left (`best trackers loaded: N (M live slots, K generic left)`) so 3.2's starvation claim is measured, not assumed
- The cache only ever holds a successful list. It is left `null` on failure, so "fetched and empty" is never a state, and `getBestTrackers()` synthesises a fresh empty list

#### Where things live (as of Task 5)

Line numbers in this document drift as code is added, and many citations above are deliberately frozen at their *pre-change* values because they describe the problem being fixed. For current positions, resolve by symbol:

| Symbol | `nyaa.js` line |
|---|---|
| `TRACKERS_GENERIC` | 4 |
| `TRACKERS_ANIME` | 20 |
| `MAX_TRACKERS` | 29 |
| `mergeTrackers()` | 35 |
| `ANNOUNCE_LINE` | 107 |
| `parseBestTrackers()` | 109 |
| `initBestTrackers()` | 126 |
| `MAX_STREAMS` | 207 |
| `getStreams()` | 418 |
| `MAX_NYAA_REQUESTS` | 466 |
| `matchEpisode()` | 763 |
| `parseQuality()` | 899 |
| `LANGUAGE_TAGS` | 915 |
| `detectAudioTags()` | 935 |
| `formatStreamName()` | 967 |
| `buildMagnet()` | 976 |

#### Known follow-up

`withTimeout()` does not `clearTimeout()` its timer, so a fast response leaves the timer pending for the rest of its window. `Promise.race` absorbs the later rejection, so there is no unhandled rejection — the cost is a retained timer per fetch. This predates Part B and was left alone rather than widened into, but the tracker fetch adds a 5-second timer to every `getStreams()` call, so it is worth a separate fix.

### 3.4 Part C — matcher hardening (replaces the vendored PTT matcher)

**This section was rewritten after measurement. See 4.2 for the evidence.**

The original design vendored `parse-torrent-title@3.0.1` and unioned it with the existing matcher behind an `NYAA_PTT` flag. That was built, then measured, and it does not work:

- A probe of 32 realistic Nyaa title patterns found **8 genuine misses** in the current `matchEpisode()`: 4-digit absolute episode numbers (`One Piece - 1122`), `v2`/`v3` revision suffixes (`- 09v2`), spelled-out `Season N` (`Show (Season 2) - 13`), and the `S2 - E08` form.
- `parse-torrent-title` 3.0.1 was run against all 8. It resolved **zero** of them, returning `season: undefined, episode: undefined` for every one. PTT has no handler for bare numbers, because a bare number in a release name is usually a resolution or a year, not an episode.
- Since PTT finds no episode, the proposed `matchEpisodePTT` would have delegated every one of the 8 back to `matchEpisode`, which already fails them. The union would have been `current || current` — identical to `current`, at the cost of ~200 vendored lines.
- The corpus independently could not have caught this: its 20 cases were mirrored from `test.js`, which the current matcher already passes 10/10 (F1 1.000), and the pre-committed gate `hybrid F1 > current F1` is unsatisfiable because nothing exceeds F1 1.000.

Conclusion: PTT solves a problem this plugin does not have, and does not touch the problem it has. Part C is dropped. The fix is to harden `matchEpisode` at its four actual fault lines.

All four fixes are additions to the existing rule chain in `matchEpisode()` (`nyaa.js:492-596`). Each is guarded so it can only fire on a shape that is unambiguously an episode marker, and each keeps the existing batch/range/season guards in force:

| Gap | Root cause | Fix shape |
|---|---|---|
| 4-digit absolute (`One Piece - 1122`) | The Rakun trailing-number rule  requires end-of-string, so a trailing `.mkv` defeats it | Extend the dash-episode pattern to 1-4 digits, anchored on the release group's dash form, still requiring the absence of a season token unless the season matches |
| `v2`/`v3` suffix (`- 09v2`) | The dash-episode pattern requires a non-alphanumeric boundary after the number | Allow an optional `v\d+` revision suffix and ignore it |
| Spelled `Season N` (`Show (Season 2) - 13`) | `cleanTorrentTitle` deletes the parentheses *and* the season token before `SEASON_TOKEN_PATTERN` ever runs — `[Judas] Show (Season 2) - 13 [1080p][HEVC x265 10bit][Multi-Subs]` cleans to `Judas Show - 13 10bit Multi-Subs` | Read the season off the **raw** title, before cleaning, and feed that single value to every branch that asks "does this title declare a season?" |
| `S2 - E08` | No episode pattern covers the spaced `S2 - E08` form | Add a dedicated pattern with the season group bound to the request, so it cannot match across seasons |
| Bare year or resolution read as an episode (`Show [2024] [1080p]`, `Show [1080] [HEVC]`) | `cleanTorrentTitle` strips `2160p`/`1080p`/`720p` but nothing strips a `[2024]` or a resolution written without its `p`, so the number survives into a 4-digit-tolerant branch | Reject year-shaped and resolution-shaped values in the dash and trailing-number branches |
| Season-less `E(\d+)` matching a titled season (`S2 - E08` answering an S1E8 request) | The guard checks the *request's* season but never the *title's*, so a bare `E08` is reported season-less regardless of the `S2` in the same title | Widen the guard to also require that the title declares no season |

**These are corrections, not widenings.** An earlier draft of this section claimed a "superset guarantee" — that each fix only widens a branch, so no previously-matching verdict can flip to false. That was wrong, and the corpus in this same design disproves it: cases 38, 40, 43-47 and 53 were all `true` before Task 2 and are `false` after, which is the entire point of fixing them. A false positive is a matcher returning the wrong file; suppressing one necessarily flips a verdict. The invariant that actually holds is narrower and is the one worth stating:

> Every verdict change must be either a false negative becoming a match, or a false positive becoming a rejection — and the corpus is the only thing permitted to decide which.

Nothing guarantees supersetness. What the corpus guarantees is that all 66 cases now resolve correctly (Appendix A.2), and that the 39 of them asserting `false` did not stop asserting it.

### 3.5 Error handling

| Failure | Behaviour |
|---|---|
| Best-tracker fetch fails / times out | Static sets only, one `console.error`, no throw |
| `detectAudioTags` finds nothing | Single-space line, label still well-formed |
| Part A/B/C code paths | No new failure mode reaches `getStreams()`'s existing `try/catch` (`nyaa.js:247`) |

### 3.6 Data flow (unchanged shape)

```
getStreams(tmdbId, mediaType, season, episode)
  -> getTitles / getKitsuTitles        (unchanged)
  -> getAbsoluteEpisode                (unchanged)
  -> buildQueries per title            (unchanged, budget 20)
  -> searchNyaa (RSS)                  (unchanged)
  -> matchEpisode                    (Part C: hardened, same function)
  -> buildMagnet (+ Part B trackers)   (Part B)
  -> formatStreamName                  (Part A2)
  -> sort by seeders, slice 40         (unchanged)
```

## 4. Measurement — proving improvement

The deliverable of this work is a number, not an opinion. Four stages, run before and after.

### 4.1 Stage 1 — golden corpus

New file `nyaa-nuvio/corpus.json`:

```json
{
  "generatedAt": "2026-09-26",
  "cases": [
    {
      "id": "frieren-s1-e08",
      "tmdbId": "209867", "season": 1, "episode": 8,
      "titles": ["[SubsPlease] Sousou no Frieren - 08 (1080p)"],
      "expect": true
    }
  ]
}
```

- 15 request shapes minimum, chosen to cover the classes that broke in past patches: S1 absolute (`- 08`), S2 absolute (`- 13`), cross-season absolute (S2E13 -> absolute 25), explicit `S02E08`, dub-only, multi-audio, batch pack (expect `false`), sequel-name false positive (expect `false`), resolution-as-episode trap (`H.264`), bracket-chain `[08][WebRip]`, 3-digit episode, episode 100+, hyphen season form `S2 - 08`, `EP239`-style long counter, and one non-anime false-positive guard
- Plus a second block, added after the first measurement round showed the first block could not detect improvement (see 4.2): 8 positives harvested from a 32-pattern probe of real release names, each one a pattern the pre-existing matcher actually misses, plus a negative counterpart for every one of them
- Real titles harvested through the existing `LIVE=1` path in `test.js`, then frozen
- `expect` is the ground truth for "should this title match this request"

### 4.2 Stage 2 — matcher A/B (the primary result)

**The corpus has two parts, and the second is the one that matters.**

The first 20 cases were mirrored from `test.js` to prove the hardened matcher breaks nothing. On their own they are worthless as an improvement signal: the pre-existing matcher already scored 10 TP / 0 FP / 0 FN on them, F1 1.000, which also made the original gate `hybrid F1 > current F1` mathematically unsatisfiable. A corpus derived only from passing tests cannot measure improvement.

So the corpus is extended with 8 positives harvested from a 32-pattern probe of realistic Nyaa release names — every pattern the pre-existing `matchEpisode` actually gets wrong — plus a matching set of negatives that guard each new branch against the false positives it invites. The negatives matter more than the positives here: widening episode patterns is exactly the kind of change that turns `[2024]` and `1080p` into episode numbers.

`bench.js` loads `nyaa.js` into the restricted sandbox context and scores the single in-file `matchEpisode` over every case, printing true/false positives, true/false negatives, precision, recall, F1, and the id of every failing case. The A/B is therefore taken across commits: run the bench before the Part C change, record the number, change `matchEpisode`, run it again, compare. Both numbers go in the appendix. There is no second matcher and no flag, because there is no second matcher to compare against.

Gate: precision 1.000, recall 1.000, F1 1.000, zero false negatives, zero false positives.

### 4.3 Stage 3 — live end-to-end

For the same 15 requests, record before/after: streams returned, Nyaa HTTP requests spent, wall-clock seconds. Guardrail: no request returns fewer streams than baseline. Results appended to the spec as an appendix.

### 4.4 Stage 4 — magnet health

For each tracker set (current 10, +anime 4, +live best), test reachability of the announce URL for a sample of 3 real infoHashes from the corpus. Metric: count of trackers that respond rather than time out. Directional only — it does not prove swarm participation, and is reported as such.

### 4.5 Success criteria (pre-committed)

1. Corpus F1 = 1.000 on the extended corpus, with **zero false negatives and zero false positives**. The negatives are the load-bearing half: a recall win bought with a false positive is not a win.
2. Pre-change F1 is strictly worse than post-change F1. If the hardened matcher does not move the number on the extended corpus, the change is reverted regardless of how reasonable it looks.
3. Live streams per request not lower than baseline for any request.
4. `url` / `infoHash` semantics unchanged; `seeders`, `size`, `quality` values identical to baseline for the same magnet.
5. Magnet tracker count never exceeds 25.
6. `test.js` offline suite still passes.

Criterion 2 is what keeps this honest. The first draft of this spec used a strictly-greater F1 gate against a PTT matcher and would have failed on arithmetic alone; the criterion is now written so that "no measurable change" is a failure, not a pass.

## 5. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Widening the episode patterns creates false positives (`[2024]`, `1080p`, `x265` read as episodes) | Every new branch is anchored on a release-group dash form or an explicit `SxE` token; the corpus carries a negative for every widened branch | Revert the `matchEpisode` branch |
| The corpus is derived from `test.js` and therefore only proves non-regression | Corpus extended with 8 probe-harvested positives and a matching negative set, so the pre-change matcher scores strictly worse than 1.000 | Extend the corpus further in a later spec |
| More trackers lengthen magnet URIs; some clients truncate | Hard cap 25 with a documented priority order | Revert `buildMagnet()` tracker assembly |
| Part B adds a boot-time network call | Lazy, once per process, in-flight shared, 5s timeout, silent fallback | Remove the `initBestTrackers()` call site |
| Labels too long for narrow UIs | Fixed 4-line format with single-space fallback; measured on a real title set | Restore `name: item.title` |
| Corpus too small to be conclusive | Corpus is committed so it grows over time | Corpus is additive; extend in later specs |

Each part is an isolated block. A, B, and C can be reverted independently, in any combination.

## 6. File-by-file change list

| File | Change |
|---|---|
| `nyaa-nuvio/nyaa.js` | Add `TRACKERS_ANIME`; add `initBestTrackers()` + lazy hook; add `mergeTrackers()` with 25 cap; rewrite tracker assembly in `buildMagnet()`; add `LANGUAGE_TAGS` + `detectAudioTags()` + `formatStreamName()`; harden four branches of `matchEpisode()` (4-digit absolute, `v2` suffix, parenthesised `Season N`, `S2 - E08`); set `name` via `formatStreamName()` |
| `nyaa-nuvio/test.js` | Add cases for the tracker cap, label formatting, language tags, and each hardened matcher branch with its negative counterpart |
| `nyaa-nuvio/bench.js` | New. Corpus runner, metrics table, failing-case list, `--gate` exit |
| `nyaa-nuvio/corpus.json` | New. 20 regression cases from `test.js` plus 8 probe-harvested positives and their negative counterparts |
| `nyaa-nuvio/tracker-health.js` | New. Stage 4 tracker reachability probe |
| `nyaa-nuvio/manifest.json` | No functional change; bump `version` to `1.1.0` for the label/tracker/matcher release |

## 7. Decisions already made

- Part C is matcher hardening in `matchEpisode`, **not** a vendored `parse-torrent-title`. The PTT option was chosen, built, measured, and rejected on evidence; see 3.4. Its premise was that a general parser would recover releases the hand-rolled matcher misses. It does not, because the misses are bare-number shapes that a general parser deliberately refuses to guess at.
- Debrid work is out of scope — the app already does it
- No new npm dependencies; everything inlined into `nyaa.js`
- The anime tracker set stays ahead of the live best trackers under the 25 cap — the best list alone can fill all 25 slots and evict the anime trackers, which are the point of Part A

## Appendix A — Measured results (2026-09-26)

### A.1 Matcher, before hardening

`node nyaa-nuvio/bench.js` at commit `8e19183`, over the 52-case corpus (20 positives, 32 negatives):

| TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| 10 | 7 | 10 | 25 | 0.588 | 0.500 | 0.541 |

The corpus was extended twice. The first 20 cases were mirrored from `test.js` and the existing matcher passed all of them, so they could only detect regression. Cases 21-42 came from probing 32 realistic Nyaa release names. Cases 43-52 came from a code-quality review that noticed the first batch of "token collision" guards could not fail, because `cleanTorrentTitle` deletes the very tokens they existed to guard — the numbers below are the ones that matter.

False negatives — real Nyaa releases the matcher fails to return:

| id | Request | Pattern | Release |
|---|---|---|---|
| 21 | S1E1122 | 4-digit absolute, parenthesised | `[Anime Time] One Piece - 1122 (1080p) [ABCD1234].mkv` |
| 22 | S1E1123 | 4-digit absolute, bare | `[Animechap] One Piece - 1123 [1080p][HEVC AAC][x265]` |
| 23 | S1E9 | `v2` revision suffix | `[SubsPlease] Show - 09v2 (1080p)` |
| 24 | S1E8 | `v2` revision suffix | `[Doki] Show - 08v2 (1080p) [HEVC-10bit]` |
| 25 | S1E12 | `v2` revision suffix | `[Anime Time] Show - 12v2 (1080p)` |
| 26 | S1E12 | `v3` revision suffix | `[Anime Time] Show - 12v3 (1080p)` |
| 27 | S1E1150 | 4-digit absolute | `[SubsPlease] One Piece - 1150 (1080p) [A1B2C3D4].mkv` |
| 28 | S2E13 | spelled `Season N` | `[Judas] Show (Season 2) - 13 [1080p]` |
| 29 | S2E8 | spaced `S2 - E08` | `[EngSub] Show S2 - E08 (1080p)` |
| 48 | S1E1122 | 4-digit absolute, bracketed | `[Anime Time] Show - [1122] [ABCD1234].mkv` |

False positives — strictly worse than the misses, because each returns a real file for the wrong episode, and the addon cannot tell the user it guessed:

| id | Request | Release | Why it wrongly matches |
|---|---|---|---|
| 38 | S1E13 | `[Judas] Show (Season 2) - 13` | `cleanTorrentTitle` strips `(Season 2)`, so no season is detected and the dash branch reads `- 13` as a season-1 absolute. A Season 2 release satisfies a Season 1 request. |
| 40 | S1E8 | `[EngSub] Show S2 - E08` | The bare `E(\d+)` handler matches the `E08` and reports it season-less; the guard checks the *request's* season, never the *title's*. |
| 43 | S1E2024 | `[Group] Show [2024] [1080p] [x265].mkv` | The trailing-number branch reads a bare year as an absolute episode number. |
| 44 | S1E2024 | `[Group] Show [2024][1080p][HEVC]` | Same, with the brackets glued to the resolution tag. |
| 45 | S1E1080 | `[Group] Show [1080] [HEVC]` | `cleanTorrentTitle` strips `1080p` but not `1080`, so the resolution survives as a bare number and is read as an episode. |
| 46 | S1E2160 | `[Group] Show [2160] [HEVC]` | Same, 4K. |
| 47 | S1E720 | `[Group] Show [720] [HEVC]` | Same, 720p. |

Root causes group into four pairs, and each fix clears a miss and a false positive together:

- 38 with 28 — season is read after the parentheses that carry it have been stripped.
- 40 with 29 — the season-less guard honours the request's season but ignores the title's.
- 43, 44, 46, 47 with 21, 22, 27, 48 — the dash branch and the trailing-number branch are both 1-4 digit-tolerant where they should be year- and resolution-aware.
- 45 with 21, 22, 27, 48 — `cleanTorrentTitle`'s resolution list is `4K|2160p|1080p|720p|480p|360p`, so a bare `1080` with no `p` is never removed.

The corpus went from "20 cases that all passed" to "52 cases the existing matcher fails 17 of". That is the honest starting point, and it is why Task 2 must be treated as a correctness task rather than a pattern-tweak.

### A.2 Matcher, after hardening

`node nyaa-nuvio/bench.js` at commits `59906bb`, `9cafa5a`, `b2dfd4d`, `913e755`, over the 66-case corpus (27 positives, 39 negatives):

| TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| 27 | 0 | 0 | 39 | 1.000 | 1.000 | 1.000 |

Every case the matcher got wrong before is now correct, and the two suites that previously disagreed now agree. Each row below was confirmed by reverting that hunk alone and re-scoring the corpus, so the attribution is measured rather than asserted.

| Fix | Cases cleared |
|---|---|
| `DASH_EP_PATTERN` widened to 1-4 digits with an optional `v\d+` revision suffix | 21, 22, 23, 24, 25, 26, 27, 48 |
| Revision suffix required to be **glued** to the number, not whitespace-separated | 58, 59, 60 |
| `dashIsRevision` — a 3-4 digit number carrying `v\d+` is a codec tag, not a re-encode | 50, and 49 alongside `looksLikeMetadata` |
| `rawTitleSeason` reads the season off the raw title, before `cleanTorrentTitle` strips the parentheses that carry it | 28, 38 |
| `RAW_SEASON_PATTERN` extended to English prefix ordinals (`2nd Season`, `(3rd Season)`) | 61, 62, 63 |
| The `rawChain` branch gained the same title-declares-season guard | 53 |
| The season-less episode guard now checks whether the *title* declares a season, not only the request | 40 |
| `EPISODE_PATTERNS` collapsed from four S/E variants to one | 29 |
| `looksLikeMetadata` in the trailing-number branch rejects years and resolutions | 43, 44, 45, 46, 47 |
| `looksLikeMetadata` in the dash branch | 56, 57 |
| `looksLikeMetadata` extended to the 360p and 4320/8K rungs | 64, 65 |

**Two bugs the review caught in the fix itself.** Both are the same defect as an original finding, one token later, which is the argument for measuring rather than pattern-matching:

- The `v\d+` suffix was originally matched with `\s*`, so a **stripped codec tag's dangling suffix** read as an episode revision. `cleanTorrentTitle` removes `x265`/`HEVC` but leaves the `v2`, so `[SubsPlease] One Piece - 1122 (1080p) [x265 v2].mkv` — the long-running-show case the digit widening exists to serve — did not match, while the same title with `[x265]` did. Requiring the suffix to be glued fixed it (cases 58-60).
- `RAW_SEASON_PATTERN` required digits *before* `Season`, so `Show 2nd Season - 08` read as season-less and answered an S1E8 request with a Season 2 file. Postfix ordinals already worked; prefix ordinals did not (cases 61-63).

**The year band is a hole in both directions, on purpose.** `looksLikeMetadata` treats 1900-2099 as a year. Measured on current code: `1899` → match, `1900` → no, `2099` → no, `2100` → **match**, `3000` → match. So the digit widening silently stops working for a long-runner once it passes 2099, and a four-digit absolute above that range reads as an episode. The trade is still right — the false positive being prevented is an S1E2024 request no show will generate, while the miss being risked is a real episode — and case 66 pins `1899` as a tripwire. This is a deliberate expiry, not an oversight. Anyone who believes long-running series will eventually cross 2100 should revisit the band, not the digit cap.

**What the digit widening costs.** `dashIsRevision` exists because widening `DASH_EP_PATTERN` to 1-4 digits would *newly* have matched `Show - 265v2` as episode 265, and `- 265v2` is a codec tag, not a release. Suppressing it by value would mean refusing 264/265/266 outright, costing a real `One Piece - 265`. Suppressing it by shape declines the re-encode `One Piece - 265v2` instead. `One Piece - 265` still matches.

To be precise about direction of travel: **`Show - 265v2` did not match before Task 2 either.** The old 1-2 digit pattern could not reach it, so this is a prevented new false positive and a declined real-world match, **not** a regression of anything that previously worked. An earlier draft of this appendix called it a deliberate regression; that was wrong.

**Known limitation, deliberately not fixed.** `[Group] Show [09v2] [1080p]` does not match an S1E9 request. `EPISODE_PATTERNS` has carried an `\[(\d+)v\d\]` entry for this shape, but `cleanTorrentTitle` strips every bracket before the pattern loop runs, so the entry is dead code. This is pre-existing, unrelated to Task 2's root causes, and is recorded in `corpus.json` under `knownLimitations` rather than asserted, because asserting it would fail the gate. The dash form `- 09v2` does match, via cases 23-26.

**Test-suite coverage is uneven, and the corpus is doing the work.** Neutering `looksLikeMetadata` to `return false` breaks 3 of 45 `test.js` assertions and 9 corpus cases. Six of the original "guard:" assertions were decorative — they passed with the guard machinery deleted, because `cleanTorrentTitle` strips the very tokens they relied on (`2160p`, `x265`, `(2024)`) before any new code runs. They were reshaped to the bare forms the guards actually see. `dashIsRevision` still has no `test.js` coverage; corpus case 50 is its only guard. **`corpus.json`, not `test.js`, is the safety net for this change.**

**On the non-string input caveat.** `matchEpisode` still throws if handed a non-string `title` or an object `season`/`episode`/`absolute`, because `cleanTorrentTitle` calls `.replace` unguarded. Pre-existing and unchanged. Unreachable from `getStreams`: `parseRssItems` gates on a truthy `item.title`, and season and episode arrive as numbers. A 147,465-input string fuzz returns a strict boolean with zero throws.

### A.3 Matcher before/after on one corpus

A.1 and A.2 are **not** comparable to each other: A.1 scored the 52-case corpus that existed at `8e19183`, and A.2 scored the 66-case corpus that Task 2 grew it into. The extra 14 cases include 10 that specifically target the defects A.1 lists, so A.2's clean sweep was partly measured against a harder corpus. The commit message for `59906bb` reports the old matcher as `TP 10 FP 7 FN 10 TN 25` — that is the 52-case figure, not a 66-case one.

Scoring both matcher versions against the **same** 66 cases isolates the matcher:

| Stage | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| before hardening (`261015b`) | 11 | 13 | 16 | 26 | 0.458 | 0.407 | 0.431 |
| after hardening (`f3ce2af`) | 27 | 0 | 0 | 39 | 1.000 | 1.000 | 1.000 |

16 of 27 real releases were missed before, and 13 negatives were wrongly returned. Reproduce with the current `corpus.json` and `bench.js` pointed at each version of `nyaa.js`.

### A.4 Live end-to-end

`LIVE=1 node nyaa-nuvio/test.js` passes, including the random current-release pick. Per-title stream counts come from an A/B that fetches each Nyaa query **once** and replays the identical RSS items through both matchers — nyaa.si results drift between runs, so fetching separately per version would have measured the network rather than the matcher.

| Title | S | E | Streams before | Streams after | Delta |
|---|---|---|---|---|---|
| Steins;Gate | 1 | 1 | 2 | 2 | = |
| Cowboy Bebop | 1 | 1 | 1 | 1 | = |
| Bakemonogatari | 1 | 1 | 4 | 4 | = |
| Fullmetal Alchemist Brotherhood | 1 | 5 | 1 | 1 | = |
| Clannad | 1 | 3 | 3 | 4 | **+1** |
| Code Geass | 1 | 1 | 10 | 10 | = |
| Neon Genesis Evangelion | 1 | 1 | 12 | 12 | = |
| **total** | | | **33** | **34** | **+1** |

The single gain is `[dozo]_Clannad_1-3_DVD`, the underscore-delimited `1-3` form, which the old matcher rejected.

**Read the +1 honestly.** The four hardened branches moved the live count by one across seven titles, because these seeded queries return mostly clean `S1E1` shapes that both versions already handled. The branches earn their place on long-running series and odd release shapes, which is what the 16 recovered corpus positives measure and what these seven titles do not exercise. The precision result is the larger one: 13 false positives to 0, where each false positive silently offered a real file for the wrong episode.

### A.5 Tracker reachability

`node nyaa-nuvio/tracker-health.js`, measured 2026-09-26 from one workstation. Liveness only — a reachable tracker may still hold no peers for a given infoHash.

| Set | Reachable | Total | of which UDP |
|---|---|---|---|
| anime set only | 2 | 4 | 0/1 |
| legacy generic only | 0 | 10 | 0/9 |
| live list only | 2 | 20 | 0/18 |
| merged (shipped) | 4 | 25 | 0/20 |

HTTP, 4 of 6 distinct entries answered. `tracker.anirena.com:80` → `200`; `nyaa.tracker.wf:7777`, `tracker.dler.com:6969`, `tracker.renfei.net:8080` → `400`. A `400` on `/announce` is a live host: a GET without announce query parameters is expected to be rejected. The two failures are `anidex.moe:6969` (`ECONNREFUSED`) and `tracker.bt-hash.com:443` (`DEPTH_ZERO_SELF_SIGNED_CERT`).

**The UDP result is real deadness, not a blocked probe.** A first pass reported 0/25 with a binary ALIVE/DEAD, which is indistinguishable from a network that drops UDP. Re-probing serially at 10s with a three-way verdict resolved it: `tracker-udp.gbitt.info:80` returns a genuine 19-byte BEP 15 response with action 3 in **156ms**, so UDP round trips work here. The other 24 sat at the full 10s timeout, meaning no packet came back at all. Of those 24, `tracker.tiny-vps.com` does not resolve (`ENOTFOUND`, 23ms).

| UDP verdict (25 distinct) | Count |
|---|---|
| ok — action 0 connect response | **0** |
| refused — host answered, non-zero action | 1 |
| silent — no response within 10s | 24 |

"Refused" and "silent" are different faults and want different fixes: the first tracker is up and declining, the rest are gone or filtered. The binary verdict in `tracker-health.js` folds both into DEAD, which is why the per-entry note is kept in its output.

**Do not prune UDP on this evidence.** UDP reachability is network-dependent — many routers and ISPs filter it — so a tracker that is silent from this workstation may serve users perfectly well. The plan anticipated this and asked for the number reported rather than tuned; these figures characterise one vantage point and nothing more.

**What the 25 cap costs.** The shipped magnet is 4 anime + 20 live + 1 generic, drawn from a distinct pool of 31. The 6 evicted entries are 5 silent UDP trackers (`leechers-paradise`, `arenabg`, `internetwarriors`, `cyberia`, `tiny-vps`) and the self-signed-cert HTTPS tracker. The cap evicts one broken entry and five dead ones while keeping all four answering HTTP trackers — convenient, not designed.

### A.6 Verdict

- **The matcher hardening paid off, and the payoff is precision, not volume.** 16 of 27 corpus positives recovered and 13 false positives eliminated. On live titles it is worth exactly +1 stream, because the shapes it fixes are rare in a seeded sample and common in long-runners.
- **The anime tracker set is not validated by this probe, in either direction.** 2 of 4 are reachable and the single UDP anime tracker is silent. Reachability cannot show peer availability, so Part A's premise stands unproven rather than refuted. Settling it needs a real scrape — announce a known infoHash and count returned peers — which reachability probing cannot provide. Recorded as an open question, not a result.
- **Generic starvation is confirmed and is intentional.** 1 of 10 generic entries reaches the magnet, the three-way overlap analysis in 3.2 explains why, and the trade is deliberate.
- **The live list did its job as a liveness filter by accident.** The four answering HTTP trackers all came from the live list, and the one broken-certificate tracker in the static set was evicted by the cap. With a stale static list the addon would have shipped the dead-cert entry and missed the working ones. One run on one network is not a trend, but it is consistent with fetching the list at all.

### A.7 Rejected: vendored `parse-torrent-title`

Part C was originally specified as a vendored, flag-gated `parse-torrent-title@3.0.1` second matcher. It was built and measured against the 9 misses above and resolved **none** of them: PTT has no bare-number handler, so every case returned `season: undefined, episode: undefined` and would have fallen back to `matchEpisode()` regardless. The union would have been `current || current`. The design was rewritten to harden the existing matcher instead, avoiding roughly 200 vendored lines and a runtime flag.
