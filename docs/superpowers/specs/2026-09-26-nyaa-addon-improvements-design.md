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
- Changing the set of titles queried, or the request budget (`MAX_NYAA_REQUESTS = 20`, `nyaa.js:196`).
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

- resolution: existing `parseQuality()` (`nyaa.js:598`)
- audio/subtitle tags: new `detectAudioTags()` driven by a language-word mapping ported from Torrentio `addon/lib/languages.js` (`dubbed`, `multi audio`, `multi subs`, `dual audio`) and the title-scanning approach of `addon/lib/subtitles.js:60`
- untagged titles get a single space instead of an empty line

**Untouched:** `title`, `url`, `infoHash`, `seeders`, `size`, `quality`, `provider`, `type`. The app's magnet resolution and de-duplication depend on these.

### 3.2 Magnet length cap

`buildMagnet()` (`nyaa.js:608`) currently appends 10 trackers. With the anime set and Part B it could exceed 25. Rule: build the ordered list as

```
[merged best trackers (Part B, if available)]  -> capped
+ [anime set]                                    -> always all 4
+ [existing generic 10]                          -> trimmed to reach MAX_TRACKERS = 25
```

Order matters: the live best trackers are the healthiest, then anime-specific, then generic. Deterministic given the same inputs, which keeps Part 4 measurements comparable.

### 3.3 Part B — live best trackers

Port of Torrentio `initBestTrackers()` (`addon/lib/magnetHelper.js:8`):

- Source: `https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt`
- Fetched at most once per process, triggered lazily on the first `buildMagnet()` call
- In-flight promise reused so concurrent `getStreams()` calls do not stack fetches
- 5-second timeout; any failure, non-200, or empty body is logged once and the static set is used unchanged
- Never throws into `getStreams()`

### 3.4 Part C — PTT matcher (default off)

- Vendor the full `parse-torrent-title@3.0.1` source verbatim into `nyaa.js` behind a clearly marked block, with the upstream version and retrieval date recorded in the block header. No edits to parser internals.
- `matchEpisodePTT(title, season, episode, absolute)` parses the raw title, then applies the same acceptance rules the current code already uses, so behaviour stays comparable:
  - reject batch/complete/season-pack for a single-episode request (`BATCH_PATTERN`, `nyaa.js:43`)
  - require season equality when the parsed title declares a season
  - accept a parsed episode equal to the requested episode, or equal to the computed absolute number
- Selection is one line, and when the flag is on it takes the **union**, not a replacement:
  `var match = USE_PTT ? (matchEpisode(...) || matchEpisodePTT(...)) : matchEpisode(...);`
  where `USE_PTT` is read once at module load from `NYAA_PTT === '1'` (global injected by Nuvio, same mechanism as the existing `TMDB_API_KEY` global at `nyaa.js:21`).
- **Superset guarantee:** a matcher that only replaced the old one could silently lose results. The union cannot, and the corpus proves it numerically (criterion 2 in 4.5).

### 3.5 Error handling

| Failure | Behaviour |
|---|---|
| Best-tracker fetch fails / times out | Static sets only, one `console.error`, no throw |
| PTT throws on a malformed title | Fall back to `matchEpisode()` for that title, one log line, no stream loss |
| `detectAudioTags` finds nothing | Single-space line, label still well-formed |
| Part A/B/C code paths | No new failure mode reaches `getStreams()`'s existing `try/catch` (`nyaa.js:247`) |

### 3.6 Data flow (unchanged shape)

```
getStreams(tmdbId, mediaType, season, episode)
  -> getTitles / getKitsuTitles        (unchanged)
  -> getAbsoluteEpisode                (unchanged)
  -> buildQueries per title            (unchanged, budget 20)
  -> searchNyaa (RSS)                  (unchanged)
  -> matchEpisode | matchEpisodePTT    (Part C, flag-gated)
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
- Real titles harvested through the existing `LIVE=1` path in `test.js`, then frozen
- `expect` is the ground truth for "should this title match this request"

### 4.2 Stage 2 — matcher A/B (the primary result)

New file `nyaa-nuvio/bench.js` runs three matchers over every corpus case:

| Matcher | Definition |
|---|---|
| `current` | existing `matchEpisode()` — regex list |
| `ptt` | vendored PTT path only |
| `hybrid` | `current \|\| ptt` — exactly what Part C ships when `NYAA_PTT=1` |

Metrics: true positives, false positives, false negatives, precision, recall, F1, plus a per-case diff list showing exactly which cases change verdict and in which direction. Output is a printed table and a committed `corpus.json` `results` block.

### 4.3 Stage 3 — live end-to-end

For the same 15 requests, record before/after: streams returned, Nyaa HTTP requests spent, wall-clock seconds. Guardrail: no request returns fewer streams than baseline. Results appended to the spec as an appendix.

### 4.4 Stage 4 — magnet health

For each tracker set (current 10, +anime 4, +live best), test reachability of the announce URL for a sample of 3 real infoHashes from the corpus. Metric: count of trackers that respond rather than time out. Directional only — it does not prove swarm participation, and is reported as such.

### 4.5 Success criteria (pre-committed)

1. `hybrid` F1 > `current` F1 on the corpus.
2. `hybrid` false negatives = 0 — no true positive is ever lost.
3. Live streams per request not lower than baseline for any of the 15 requests.
4. `url` / `infoHash` semantics unchanged; `seeders`, `size`, `quality` values identical to baseline for the same magnet.
5. Magnet tracker count never exceeds 25.
6. `test.js` offline suite still passes with Parts A and B on and Part C off.

If criterion 1 or 2 fails, Part C is removed from the design and A + B ship alone. That decision is data-driven, not deferred.

## 5. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Vendored PTT bloats `nyaa.js` and confuses Hermes | C is flag-gated and off by default; corpus proves value before anyone enables it | Delete the vendored block and the selector line |
| More trackers lengthen magnet URIs; some clients truncate | Hard cap 25 with a documented priority order | Revert `buildMagnet()` tracker assembly |
| Part B adds a boot-time network call | Lazy, once per process, in-flight shared, 5s timeout, silent fallback | Remove the `initBestTrackers()` call site |
| Labels too long for narrow UIs | Fixed 4-line format with single-space fallback; measured on a real title set | Restore `name: item.title` |
| Corpus too small to be conclusive | 15 requests x 3 matchers, committed so it grows over time | Corpus is additive; extend in later specs |

Each part is an isolated block. A, B, and C can be reverted independently, in any combination.

## 6. File-by-file change list

| File | Change |
|---|---|
| `nyaa-nuvio/nyaa.js` | Add `TRACKERS_ANIME`; add `initBestTrackers()` + lazy hook; add `mergeTrackers()` with 25 cap; rewrite tracker assembly in `buildMagnet()`; add `LANGUAGE_TAGS` + `detectAudioTags()` + `formatStreamName()`; add vendored PTT block + `matchEpisodePTT()`; add `USE_PTT` selector; set `name` via `formatStreamName()` |
| `nyaa-nuvio/test.js` | Add cases for tracker cap, label formatting, language tags, PTT fallback-on-throw, and a guard that default mode still uses `matchEpisode` |
| `nyaa-nuvio/bench.js` | New. Corpus runner, three matchers, metrics table, per-case diff |
| `nyaa-nuvio/corpus.json` | New. 15+ frozen cases with expected verdicts, plus recorded results |
| `nyaa-nuvio/manifest.json` | No functional change; bump `version` to `1.1.0` for the label/tracker release |

## 7. Decisions already made

- Vendor full PTT source (option 1), not a partial re-implementation and not skipping it
- Part C ships default-off; the flag decides at runtime
- Debrid work is out of scope — the app already does it
- No new npm dependencies; everything inlined into `nyaa.js`
