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
[anime set]                                  -> always all 4, never evicted
+ [live best trackers (Part B, if available)] -> trimmed to remaining room
+ [existing generic 10]                       -> trimmed to reach MAX_TRACKERS = 25
```

The anime set goes first on purpose. If the live best list were first it could consume all 25 slots on its own and silently drop the anime trackers, which are the entire point of Part A for this plugin. Eviction happens from the tail, never from the anime set.

Order matters for the rest: live best trackers are the healthiest of the remainder, generic trackers fill whatever is left. The result is deterministic for identical inputs, which keeps Stage 4 measurements comparable.

### 3.3 Part B — live best trackers

Port of Torrentio `initBestTrackers()` (`addon/lib/magnetHelper.js:8`):

- Source: `https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt`
- Fetched at most once per process, triggered lazily on the first `buildMagnet()` call
- In-flight promise reused so concurrent `getStreams()` calls do not stack fetches
- 5-second timeout; any failure, non-200, or empty body is logged once and the static set is used unchanged
- Never throws into `getStreams()`

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
| 4-digit absolute (`One Piece - 1122`) | The Rakun trailing-number rule (`nyaa.js:568`) requires end-of-string, so a trailing `.mkv` defeats it | Extend the dash-episode pattern to 1-4 digits, anchored on the release group's dash form, still requiring the absence of a season token unless the season matches |
| `v2`/`v3` suffix (`- 09v2`) | The dash-episode pattern requires a non-alphanumeric boundary after the number | Allow an optional `v\d+` revision suffix and ignore it |
| Spelled `Season N` (`Show (Season 2) - 13`) | `SEASON_TOKEN_PATTERN` matches `S2` and `Season 2` but not the parenthesised `(Season 2)` form | Extend the season-token pattern to tolerate surrounding brackets |
| `S2 - E08` | No episode pattern covers the spaced `S2 - E08` form | Add a dedicated pattern with the season group bound to the request, so it cannot match across seasons |

**Superset guarantee.** Each fix widens an existing branch rather than adding a competing matcher, so no previously-matching verdict can flip to false. The corpus proves that numerically (criterion 2 in 4.5).

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
