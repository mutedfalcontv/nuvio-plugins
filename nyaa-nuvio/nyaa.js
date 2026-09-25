// Legacy generic swarms, kept as a fallback for a short or failed live list.
// mergeTrackers orders them last, so once the live list fills its 21 slots these
// receive none and are absent from every production magnet. See spec 3.2.
var TRACKERS_GENERIC = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.leechers-paradise.org:6969/announce",
  "udp://p4p.arenabg.ch:1337/announce",
  "udp://tracker.internetwarriors.net:1337/announce",
  "udp://tracker.cyberia.is:6969/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "https://tracker.bt-hash.com:443/announce",
  "udp://open.demonii.com:1337/announce"
];

// Anime-specific swarms. Generic trackers carry almost no anime peers, so these
// are what actually make a magnet find leechers. Ported from Torrentio's
// addon/lib/magnetHelper.js (ANIME_TRACKERS).
var TRACKERS_ANIME = [
  "http://nyaa.tracker.wf:7777/announce",
  "http://anidex.moe:6969/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://tracker.uw0.xyz:6969/announce"
];

// Stremio-style clients only reliably honour a bounded tracker list, so the
// merged list is trimmed to this many announce URLs.
var MAX_TRACKERS = 25;

// Order: anime set first, then live best trackers, then the legacy generic set.
// Anime goes first deliberately - if the best-tracker list went first it could
// consume all MAX_TRACKERS slots alone and silently drop the anime trackers,
// which are the whole point of this plugin for anime.
function mergeTrackers(best) {
  // The anime set is the head. It is seeded here and never passed to take(),
  // never filtered and never sliced, so no input size can remove it: the
  // guarantee is structural, not a consequence of push order.
  // Null-prototype so a live entry literally named "constructor" or "toString"
  // is tracked as itself rather than being mistaken for an inherited member and
  // silently dropped.
  var seen = Object.create(null);
  var head = [];
  for (var a = 0; a < TRACKERS_ANIME.length; a++) {
    seen[TRACKERS_ANIME[a]] = true;
    head.push(TRACKERS_ANIME[a]);
  }

  // Everything after the head shares one budget, counted in accepted entries so
  // a duplicate or junk line cannot consume a slot. Room is read once, so the
  // live list either fits or takes every remaining slot: with the real
  // trackers_best.txt that is the common case, and the legacy generic set then
  // receives zero slots. It is a fallback for a short or failed live list.
  // See spec 3.2.
  var room = MAX_TRACKERS - head.length;
  var tail = [];
  function take(list) {
    for (var k = 0; k < list.length && tail.length < room; k++) {
      var t = list[k];
      if (t && !seen[t]) { seen[t] = true; tail.push(t); }
    }
  }
  take(best || []);
  take(TRACKERS_GENERIC);

  // The load-bearing line: nothing downstream can reach the head.
  return head.concat(tail);
}

var BEST_TRACKERS_URL = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";
// A separate, much tighter budget than FETCH_TIMEOUT_MS. The tracker list is a
// nice-to-have: a slow GitHub must not hold up a stream request, and by the
// time this resolves the magnets for the current call are already built.
var BEST_TRACKERS_TIMEOUT_MS = 5000;
// Minimum gap between re-attempts after a failure. Without it, a tracker-host
// outage re-issues the GitHub request on every getStreams() call for the life of
// the process while the warned flag hides it behind a single log line. Long
// enough to bound the outbound cost, short enough that recovery is quick.
var BEST_TRACKERS_RETRY_MS = 5 * 60 * 1000;

var bestTrackersCache = null;   // null = never fetched
var bestTrackersPromise = null; // in-flight guard so concurrent calls don't stack
var bestTrackersWarned = false; // spec: any failure is logged once
var bestTrackersRetryAt = 0;    // Date.now() before which no re-attempt is made

// Returns the live best-tracker list, or an empty list before the first fetch
// or after a failure. Must return an array of announce-URL strings -
// mergeTrackers does not validate its input. The cache is returned by
// reference, so a later in-place trim of it would be visible to every
// subsequent buildMagnet.
function getBestTrackers() {
  return bestTrackersCache || [];
}

// Keeps only lines that are announce URLs. Everything the file can legally
// contain and that is not one is dropped here rather than in mergeTrackers,
// which is duck-typed: a bare number would become a literal "&tr=1" in the
// magnet. The body is untrusted input, so it is filtered, not trusted.
// The anchored scheme requirement is also what excludes comments and headings,
// so "#" and "//" lines fail the test without a separate comment check - a
// dedicated one would be unreachable and therefore untestable.
// The strict \/announce$ tail is deliberate: it cannot admit a scrape endpoint.
// Verified 2026-09-26 against both upstream lists - 20 of 20 lines in
// trackers_best.txt and 74 of 74 in trackers_all.txt match, so nothing valid is
// being discarded today. If upstream ever adds a path like /announce.php those
// entries would be dropped, and the "best trackers loaded" log is the signal.
var ANNOUNCE_LINE = /^(https?:\/\/|udp:\/\/)\S*\/announce$/i;

function parseBestTrackers(text) {
  var out = [];
  var lines = String(text).split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^\s+|\s+$/g, "");
    if (line && ANNOUNCE_LINE.test(line)) out.push(line);
  }
  return out;
}

// Warm the cache from getStreams, best effort. Never awaited and never throws
// into the caller: a slow or dead tracker host must not delay or fail a stream
// request. buildMagnet reads the cache synchronously and cannot await, so this
// fetch can only ever serve magnets built after it resolves. Whether that
// includes the current call's own magnets depends on whether GitHub answers
// before the TMDB and Nyaa round-trips finish, which nothing here guarantees
// and nothing depends on.
function initBestTrackers() {
  // One guard for the "at most once per process until it succeeds" invariant:
  // the in-flight promise is both the concurrency guard and the settled-cache
  // guard, since a completed chain stays assigned. A separate cache check here
  // would be masked by this line after every success and could not be tested
  // independently.
  if (bestTrackersPromise) return bestTrackersPromise;
  // Throttled after a failure: fall back to the static set without going out to
  // the network again. The guard is released on the far side of this window
  // rather than latched, so a blip at startup cannot disable the live list
  // permanently.
  if (bestTrackersRetryAt && Date.now() < bestTrackersRetryAt) return Promise.resolve([]);

  // No in-call retries (retries: 0): a tracker list that is late is worth less
  // than a stream request that is on time, and the static set is a usable answer
  // meanwhile. A later getStreams() call retries, subject to the throttle above.
  bestTrackersPromise = fetchResilient(BEST_TRACKERS_URL, {
    headers: { "User-Agent": USER_AGENT },
    retries: 0,
    timeoutMs: BEST_TRACKERS_TIMEOUT_MS
  })
    .then(function (res) {
      if (!res || res.status !== 200) throw new Error("status " + (res && res.status));
      return res.text();
    })
    .then(function (text) {
      var list = parseBestTrackers(text);
      // An empty body is a failure, not an empty preference: caching [] would
      // suppress every later retry for the life of the process.
      if (!list.length) throw new Error("no announce URLs in response");
      bestTrackersCache = list;
      // Record the number that actually decides 3.2's starvation question: the
      // count of distinct live entries that are not already in the anime head,
      // since those are what consume the tail budget. Neither list.length nor
      // mergeTrackers(list).length works - the first counts duplicates and anime
      // repeats, the second also counts the generic entries that fill whatever
      // is left over, and reads 21 live slots for a 20-entry list.
      var liveSlots = 0;
      var counted = [];
      for (var i = 0; i < list.length; i++) {
        if (TRACKERS_ANIME.indexOf(list[i]) !== -1) continue;
        if (counted.indexOf(list[i]) !== -1) continue;
        counted.push(list[i]);
        liveSlots++;
      }
      console.log("best trackers loaded: " + list.length + " (" + liveSlots +
        " live slots, " + (MAX_TRACKERS - TRACKERS_ANIME.length - liveSlots) +
        " generic left)");
      return list;
    })
    .catch(function (e) {
      if (!bestTrackersWarned) {
        bestTrackersWarned = true;
        console.error("best trackers fetch failed:", (e && e.message) || e);
      }
      // The cache is left null rather than set to []: it only ever holds a
      // successful list, so getBestTrackers() synthesises a fresh empty array
      // and "cached empty" cannot be confused with "fetched and empty".
      // Release the in-flight guard and re-arm it no sooner than the throttle
      // window, so recovery stays possible without a per-request retry loop.
      bestTrackersPromise = null;
      bestTrackersRetryAt = Date.now() + BEST_TRACKERS_RETRY_MS;
      return [];
    });

  return bestTrackersPromise;
}

var NYAA_CATEGORIES = {
  ALL: "1_0",
  ENGLISH: "1_2"
};

// Community TMDB key fallback (public, from nuvio-torlink-addon) in case the
// Nuvio-injected TMDB_API_KEY global is missing in some runtimes.
var TMDB_KEY = (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY)
  ? TMDB_API_KEY
  : "1865f43a0549ca50d341dd9ab8b29f49";

var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

var MAX_STREAMS = 40;

var EPISODE_PATTERNS = [
  // One pattern for every "S<n> [sep] E<n>" spelling. The separator is optional,
  // so S01E08, S01.E08 and S01 - E08 all land here, which is what the three
  // former variants were doing between them.
  //
  // NO \b next to the "E": in "S01E08" the position between the season digits and
  // the "E" is not a word boundary (both sides are word characters), so
  // \s*[.\-–]?\s*\bE would stop matching the single most common S/E form in the
  // corpus. A \b before "S" or after the episode digits is harmless, but there is
  // no reason to add either.
  { re: /S(\d+)\s*[.\-–]?\s*E(\d+)/i, seasonGroup: 1, epGroup: 2 },
  { re: /S(\d+)\s*[-–]\s*(\d{1,3})\b/i, seasonGroup: 1, epGroup: 2 },
  { re: /Season\s+(\d+)\s+Episode\s+(\d+)/i, seasonGroup: 1, epGroup: 2 },
  { re: /(\d+)x(\d+)/i, seasonGroup: 1, epGroup: 2 },
  { re: /\[(\d+)\]$/i, seasonGroup: null, epGroup: 1 },
  { re: /\bE(\d+)\b/i, seasonGroup: null, epGroup: 1 },
  { re: /\bEP(\d+)\b/i, seasonGroup: null, epGroup: 1 },
  { re: /\bEpisodes?\s*(\d+)\b/i, seasonGroup: null, epGroup: 1 },
  { re: /\[(\d+)v\d\]/i, seasonGroup: null, epGroup: 1 }
];

// Group dash form: "- 08", "- 09v2", "- 1122". 1-4 digits covers long-running
// series (One Piece E1122). Group 2 captures an optional "v2"/"v3" revision
// suffix so a re-encode of the same episode still matches. The trailing
// (?![0-9a-z]) boundary replaces the old (?!\s*[pP]) guard and subsumes it: it
// rejects a match that runs straight into the stem of a "1080p"-style tag, so
// "- 1080" in an unstripped title cannot be read as episode 1080.
//
// That lookahead is NOT what keeps "1122" from being read as "11" - \d{1,4} is
// greedy and nothing in this pattern forces a backtrack, so 4 digits are taken
// whole. The digit cap is the thing protecting a long-running show's number, so
// relaxing it (not the lookahead) is what would break "One Piece - 1122".
//
// The revision suffix must be GLUED to the number ("- 09v2", never "- 09 v2").
// cleanTorrentTitle strips the codec token out of a tag like "[x265 v2]" but
// leaves the "v2" behind, so "[SubsPlease] Show - 265 (1080p) [x265 v2]" cleans
// to "Show - 265 v2": with \s* in front of the suffix, the orphan "v2" was
// captured as a revision, dashIsRevision fired on a 3-digit episode, and the
// release was dropped. That voided the whole point of the 4-digit widening for
// exactly the shows that needed it. With the glue required, a stripped codec
// tag no longer costs the match, and the cost is only that a hand-written
// "Show - 265 v2" now reads as episode 265 - which no release group writes.
var DASH_EP_PATTERN = /-\s*(\d{1,4})(v\d+)?(?![0-9a-z])/i;
var BATCH_PATTERN = /\b(batch|complete|season\s+\d+\s+pack)\b/i;
var RANGE_PATTERN = /S(\d+)\s*E(\d+)\s*[-–]\s*E?(\d+)/i;
var RES_PATTERN = /\b(4K|2160p|1080p|720p|480p|360p)\b/i;
var TRUSTED_PATTERN = /\b(trusted|v2|remaster)\b/i;
// Any explicit season marker ("S2", "S03E09", "S02", "Season 3"). Deliberately
// uses NO trailing \b after the digits: "S03E09" has no word boundary between
// "03" and "E", but it still declares a season. When a title carries a season
// token, a bare trailing number (e.g. H.264's "264") must never be treated as a
// season-1 absolute episode.
var SEASON_TOKEN_PATTERN = /\bS\s*(\d+)|Season\s+(\d+)/i;

// Season marker read off the RAW title. cleanTorrentTitle strips "(...)" before
// any season pattern runs, so "Show (Season 2) - 13" looks season-less by the
// time SEASON_TOKEN_PATTERN sees it and its dash number reads as a season-1
// absolute. Release groups routinely parenthesise the season, so the raw title
// has to be consulted. Stricter than SEASON_TOKEN_PATTERN on the "S<n>" arm (it
// requires a real word boundary, so "S03E09" falls through to the cleaned-title
// fallback) and looser on the spelled-out arm ("Season.2", "Season2", "Saison").
//
// The third arm is the English prefix ordinal, "2nd Season" / "3rd Season". The
// other two arms need digits BEFORE the word "Season", so a prefix ordinal
// slipped past and the title read as season-less - which is wrong in both
// directions: "Show 2nd Season - 08" missed S2E8 entirely AND answered an S1E8
// request with a season-2 file. Same defect the "(Season 2)" arm fixed, one
// token later. The ordinal goes in its own group because it comes first.
var RAW_SEASON_PATTERN = /(?:^|[^A-Za-z0-9])(?:S(\d{1,2})\b|(?:Season|Saison)[.\s_-]?(\d{1,2})\b|(\d{1,2})(?:st|nd|rd|th)\s+(?:Season|Saison)\b)/i;

function rawTitleSeason(title) {
  var m = String(title || "").match(RAW_SEASON_PATTERN);
  if (!m) return null;
  return parseInt(m[1] || m[2] || m[3], 10);
}

// Numbers that are never episode numbers, in either of the two digit-tolerant
// branches. A 4-digit group in the 19xx/20xx range is a year; 360/480/720/1080/
// 1440/2160/4320 are resolutions. cleanTorrentTitle only strips the "p" forms
// ("1080p"), never a bare "1080" or a "[2024]" year, so all of these survive
// cleaning and land in the dash and trailing-number branches. The resolution
// ladder is deliberately the full set RES_PATTERN and cleanTorrentTitle already
// know about - a rung missing here is a rung those two strip on the way in and
// this one has to catch on the way out. 360 and 4320 were the two holes: "360p"
// is stripped as a resolution but a bare "- 360" was read as episode 360, and
// "4K" is known to parseQuality but a bare "- 4320" was read as episode 4320.
//
// The 2099 ceiling on the year band is a deliberate expiry, not an oversight,
// and it cuts both ways. Downwards it costs us: the moment a long-runner
// crosses 1900 episodes ("One Piece - 1900" and up) every one of its releases
// silently stops matching, because 1900..2099 is exactly the set the band
// filters. Upwards it buys us: from 2100 the band stops filtering, so "One Piece
// - 2100" is read as an episode again. The trade is still right - the false
// positive the band prevents is an S1E2024 request no show will ever generate,
// while the miss it risks is a real episode - but the expiry is a real cliff
// and the day One Piece ships episode 1900 this band has to move.
function looksLikeMetadata(n) {
  return (n >= 1900 && n <= 2099) ||
    n === 360 || n === 480 || n === 720 || n === 1080 || n === 1440 ||
    n === 2160 || n === 4320;
}

// ---- Network helpers (ported from nuvio-torlink-addon, Hermes-safe) ----

function HttpError(status, message) {
  this.name = "HttpError";
  this.status = status;
  this.message = message || ("HTTP " + status);
}
HttpError.prototype = Object.create(Error.prototype);

var RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];
var FETCH_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, url) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new HttpError(0, "Timeout after " + ms + "ms: " + url)); }, ms);
    })
  ]);
}

async function fetchResilient(url, init) {
  init = init || {};
  var retries = (typeof init.retries === "number") ? init.retries : 1;
  // Per-call timeout override. The default suits TMDB calls, but the best-
  // tracker list is a nice-to-have with its own 5s budget: reusing this path
  // rather than a second raw fetch keeps the status classification in one place.
  var timeoutMs = (typeof init.timeoutMs === "number") ? init.timeoutMs : FETCH_TIMEOUT_MS;
  var rest = {};
  for (var k in init) { if (k !== "retries" && k !== "timeoutMs") rest[k] = init[k]; }
  var lastError;
  for (var attempt = 0; attempt <= retries; attempt++) {
    try {
      var res = await withTimeout(fetch(url, rest), timeoutMs, url);
      // A spec-compliant fetch never resolves null, so this guards a host
      // polyfill that does. Without it a null is caught below as a TypeError on
      // res.status, which still fails but reports a property error rather than
      // the missing response it actually is.
      if (!res) throw new HttpError(0, "no response from " + url);
      if (RETRY_STATUS.indexOf(res.status) === -1) return res;
      lastError = new HttpError(res.status, url + " returned " + res.status);
    } catch (e) {
      lastError = e;
    }
    if (attempt < retries) {
      await new Promise(function (r) { setTimeout(r, 500 * Math.pow(2, attempt)); });
    }
  }
  throw lastError;
}

function qs(params) {
  return Object.keys(params)
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
    .join("&");
}

function unescapeEntities(s) {
  return s
    .replace(/&#0?38;|&amp;/g, "&")
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#8217;|&#0?39;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); });
}

var SIZE_UNITS = {
  B: 1, KIB: 1024, MIB: 1024 * 1024, GIB: 1024 * 1024 * 1024, TIB: 1024 * 1024 * 1024 * 1024,
  KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12
};

function parseSize(s) {
  if (!s) return null;
  var m = s.match(/([\d.]+)\s*([KMGT]?I?B)/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (SIZE_UNITS[m[2].toUpperCase()] || 1));
}

// ---- Query builder (the actual fix) ----

// Nyaa ANDs space-separated terms. Fansub releases (SubsPlease/Erai) use an
// absolute "- 08" with NO season token, so a "S01" suffix excludes them.
// Build multiple candidates per title and try them all. `absolute` is TMDB's
// absolute episode number (cross-season shows like Bookworm need it).
function buildQueries(title, season, episode, absolute) {
  var out = [];
  var ep = parseInt(episode, 10);
  var s = parseInt(season, 10);

  if (!isNaN(ep)) out.push(title + " " + ep);                              // anime/absolute: "Futari 8"
  if (!isNaN(s) && !isNaN(ep)) out.push(title + " S" + padZero(s, 2) + "E" + padZero(ep, 2)); // TV: "Show S01E08"
  if (absolute != null && !isNaN(absolute)) out.push(title + " " + absolute); // cross-season absolute: "Bookworm 15"
  out.push(title);                                                        // bare fallback

  // de-dup while preserving order
  var seen = {};
  var deduped = [];
  for (var i = 0; i < out.length; i++) {
    if (!seen[out[i]]) { seen[out[i]] = true; deduped.push(out[i]); }
  }
  return deduped;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (mediaType !== "tv" && mediaType !== "series") return [];

    // Below the media-type guard: a movie request produces no magnets, so an
    // outbound tracker fetch there would be paid for and never used.
    initBestTrackers();

    var titles = (typeof tmdbId === "string" && tmdbId.indexOf("kitsu:") === 0)
      ? await getKitsuTitles(tmdbId)
      : await getTitles(tmdbId);
    if (!titles || titles.length === 0) return [];

    // TMDB absolute episode number (cross-season numbering). null for kitsu.
    var abs = (typeof tmdbId === "string" && tmdbId.indexOf("kitsu:") === 0)
      ? null
      : await getAbsoluteEpisode(tmdbId, season, episode);

    // Dedupe titles and drop non-Latin-script ones (Chinese/Korean/Japanese
    // kanji rarely appear in anime torrent names) — they only burn Nyaa
    // requests. Then bound how many distinct titles we'll try.
    var seenTitle = {};
    var usableTitles = [];
    for (var tt = 0; tt < titles.length && usableTitles.length < 6; tt++) {
      var t2 = titles[tt];
      if (!t2 || seenTitle[t2]) continue;
      seenTitle[t2] = true;
      var latin = 0, total = 0;
      for (var cc = 0; cc < t2.length; cc++) {
        var code = t2.charCodeAt(cc);
        if ((code >= 0x20 && code <= 0x7e) || (code >= 0x00c0 && code <= 0x024f)) latin++; // ASCII + Latin-1/Extended
        total++;
      }
      if (total === 0) continue;
      // Keep titles that are at least ~40% Latin-script.
      if (latin / total < 0.4) continue;
      usableTitles.push(t2);
    }
    if (usableTitles.length === 0) usableTitles = titles.slice(0, 6);

    var seen = {};
    var results = [];

    // Try every usable title, and for each title every candidate query. Do NOT
    // break on the first hit — the English TMDB title returns English-dub
    // torrents while the romaji title returns SubsPlease/Erai. Both are valid
    // sources. Enforce a total Nyaa-request budget (each RSS call, especially
    // a failing one behind a 15s timeout + retry, can cost seconds).
    var MAX_NYAA_REQUESTS = 20;
    var requestsMade = 0;
    for (var ti = 0; ti < usableTitles.length; ti++) {
      var queries = buildQueries(usableTitles[ti], season, episode, abs);
      for (var qi = 0; qi < queries.length; qi++) {
        var rssItems;
        requestsMade++;
        if (requestsMade > MAX_NYAA_REQUESTS) break;
        rssItems = await searchNyaa(queries[qi], NYAA_CATEGORIES.ENGLISH);
        if (!rssItems || rssItems.length === 0) {
          if (++requestsMade > MAX_NYAA_REQUESTS) break;
          rssItems = await searchNyaa(queries[qi], NYAA_CATEGORIES.ALL);
        }
        if (!rssItems) continue;

        for (var ri = 0; ri < rssItems.length; ri++) {
          var item = rssItems[ri];
          if (seen[item.infoHash]) continue;
          var match = matchEpisode(item.title, season, episode, abs);
          if (!match) continue;

          seen[item.infoHash] = true;

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
        }
      }
      if (requestsMade > MAX_NYAA_REQUESTS) break;
    }

    results.sort(function (a, b) {
      var sa = a.seeders || 0;
      var sb = b.seeders || 0;
      return sb - sa;
    });

    if (results.length > MAX_STREAMS) results = results.slice(0, MAX_STREAMS);

    return results;
  } catch (e) {
    console.error("Nyaa plugin error:", e.message || e);
    return [];
  }
}

async function getTitles(tmdbId) {
  var titles = [];
  try {
    var resp = await fetchResilient("https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + TMDB_KEY, { retries: 2 });
    var data = await resp.json();
    if (!data) return titles;

    if (data.name) titles.push(data.name);

    var origName = data.original_name || data.original_title;
    if (origName && origName !== data.name && titles.indexOf(origName) === -1) {
      titles.push(origName);
    }

    if (origName) {
      var allAscii = true;
      for (var ci = 0; ci < origName.length; ci++) {
        if (origName.charCodeAt(ci) > 127) { allAscii = false; break; }
      }
      if (!allAscii) {
        var romaji = await getRomajiTitle(tmdbId);
        if (romaji && titles.indexOf(romaji) === -1) {
          titles.push(romaji);
        } else {
          var aniRomaji = await searchAniListTitle(data.name);
          if (aniRomaji && titles.indexOf(aniRomaji) === -1) {
            titles.push(aniRomaji);
          }
        }
      }
    }

    var altResp = await fetchResilient("https://api.themoviedb.org/3/tv/" + tmdbId + "/alternative_titles?api_key=" + TMDB_KEY, { retries: 2 });
    var altData = await altResp.json();
    if (altData && altData.results) {
      for (var i = 0; i < altData.results.length; i++) {
        var alt = altData.results[i];
        if (alt.title && titles.indexOf(alt.title) === -1) {
          titles.push(alt.title);
        }
      }
    }
  } catch (e) {
    console.error("TMDB title fetch failed:", e.message);
  }
  return titles;
}

async function getAbsoluteEpisode(tmdbId, season, episode) {
  // SubsPlease and most fansubs number multi-season anime with ONE continuous
  // counter across seasons, with no season token: "Solo Leveling - 25" (S2E13),
  // "Honzuki no Gekokujou - 36" (S1E36). TMDB's `absolute_number` is often
  // missing for anime, so compute the absolute index by summing the episode
  // counts of every prior numbered season.
  try {
    var resp = await fetchResilient("https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + TMDB_KEY, { retries: 1 });
    var data = await resp.json();
    if (!data || !data.seasons) return null;
    var reqSeason = parseInt(season, 10);
    var ep = parseInt(episode, 10);
    if (isNaN(reqSeason) || isNaN(ep) || reqSeason <= 1) return null;

    var cumulative = 0;
    for (var i = 0; i < data.seasons.length; i++) {
      var sn = data.seasons[i].season_number;
      if (sn <= 0) continue; // skip specials
      if (sn >= reqSeason) break;
      cumulative += data.seasons[i].episode_count || 0;
    }
    return cumulative + ep;
  } catch (e) {
    console.error("absolute episode calc failed:", e.message);
  }
  return null;
}

async function getRomajiTitle(tmdbId) {
  try {
    var url = "https://api.themoviedb.org/3/tv/" + tmdbId + "/translations?api_key=" + TMDB_KEY;
    var resp = await fetch(url);
    var data = await resp.json();
    if (!data || !data.translations) return null;
    var prefer = { id: "ID", tr: "TR", ca: "ES" };
    for (var key in prefer) {
      for (var ti = 0; ti < data.translations.length; ti++) {
        var t = data.translations[ti];
        if (t.iso_3166_1 === prefer[key] && t.data && t.data.name) {
          var romaji = t.data.name;
          var allAscii = true;
          for (var ci = 0; ci < romaji.length; ci++) {
            if (romaji.charCodeAt(ci) > 127) { allAscii = false; break; }
          }
          if (allAscii) return romaji;
        }
      }
    }
  } catch (e) {
    console.error("Romaji fetch failed:", e.message);
  }
  return null;
}

async function getKitsuTitles(tmdbId) {
  var titles = [];
  var kitsuId = tmdbId.split(":")[1];
  var url = "https://kitsu.io/api/edge/anime/" + kitsuId;
  try {
    var resp = await fetch(url);
    var data = await resp.json();
    if (!data || !data.data || !data.data.attributes) return titles;
    var attrs = data.data.attributes;
    if (attrs.titles) {
      if (attrs.titles.en_jp) titles.push(attrs.titles.en_jp);
      if (attrs.titles.en && titles.indexOf(attrs.titles.en) === -1) titles.push(attrs.titles.en);
    }
    if (attrs.canonicalTitle && titles.indexOf(attrs.canonicalTitle) === -1) titles.push(attrs.canonicalTitle);
  } catch (e) {
    console.error("Kitsu fetch failed:", e.message);
  }
  return titles;
}

async function searchAniListTitle(englishTitle) {
  if (!englishTitle) return null;
  try {
    var query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          title { romaji english }
        }
      }`;
    var variables = { search: englishTitle };
    var resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Nuvio/1.0"
      },
      body: JSON.stringify({ query: query, variables: variables })
    });
    if (resp.status === 429) {
      console.error("AniList rate limited, skipping romaji search");
      return null;
    }
    var data = await resp.json();
    if (!data || !data.data || !data.data.Media || !data.data.Media.title) return null;
    var title = data.data.Media.title;
    if (title.romaji && title.romaji !== englishTitle) return title.romaji;
    if (title.english && title.english !== englishTitle) return title.english;
    return null;
  } catch (e) {
    console.error("AniList title search failed:", e.message);
    return null;
  }
}

async function searchNyaa(query, category) {
  try {
    var params = qs({
      page: "rss",
      q: query,
      c: category,
      f: "0",
      s: "seeders",
      o: "desc",
      limit: "100"
    });
    var url = "https://nyaa.si/?" + params;
    console.log("Nyaa RSS URL:", url);

    var resp = await fetchResilient(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/xml, text/xml, */*"
      }
    });
    var xml = await resp.text();
    if (!xml || xml.length < 100) return [];

    return parseRssItems(xml);
  } catch (e) {
    console.error("Nyaa search failed:", e.message);
    return [];
  }
}

function parseRssItems(xml) {
  var items = [];
  var itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  var match;

  while ((match = itemRegex.exec(xml)) !== null) {
    var block = match[1];
    var item = {};

    item.title = unescapeEntities(extractTag(block, "title"));
    item.link = extractTag(block, "link");
    item.guid = extractTag(block, "guid");
    item.infoHash = extractNsTag(block, "nyaa:infoHash");
    item.seeders = parseInt(extractNsTag(block, "nyaa:seeders"), 10) || 0;
    item.leechers = parseInt(extractNsTag(block, "nyaa:leechers"), 10) || 0;
    item.size = parseSize(extractNsTag(block, "nyaa:size")) || null;
    item.sizeLabel = extractNsTag(block, "nyaa:size") || "";
    item.categoryId = extractNsTag(block, "nyaa:categoryId") || "";
    item.trusted = extractNsTag(block, "nyaa:trusted") || "No";

    if (item.title && item.infoHash) {
      items.push(item);
    }
  }

  return items;
}

function extractTag(block, tagName) {
  var re = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)<\\/" + tagName + ">", "i");
  var m = re.exec(block);
  return m ? m[1].trim() : "";
}

function extractNsTag(block, tagName) {
  var re = new RegExp("<" + tagName.replace(":", "\\:") + "[^>]*>([\\s\\S]*?)<\\/" + tagName.replace(":", "\\:") + ">", "i");
  var m = re.exec(block);
  return m ? m[1].trim() : "";
}

function cleanTorrentTitle(title) {
  var cleaned = title;
  cleaned = cleaned.replace(/\[([^\]]*)\]/g, "$1 ");
  cleaned = cleaned.replace(/\([^\)]*\)/g, " ");
  cleaned = cleaned.replace(/\b(4K|2160p|1080p|720p|480p|360p)\b/gi, " ");
  cleaned = cleaned.replace(/\.(mkv|mp4|avi|m2ts|ts|mov|wmv)$/i, " ");
  cleaned = cleaned.replace(/\b(x264|x265|hevc|h264|h265|av1|web[-\s]?dl|hdtv|bluray|bdrip|webrip)\b/gi, " ");
  cleaned = cleaned.replace(/(?<=[a-zA-Z0-9])\.(?=[a-zA-Z0-9])/gi, " ");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return cleaned;
}

function matchEpisode(title, requestedSeason, requestedEpisode, absoluteNumber) {
  var reqEp = parseInt(requestedEpisode, 10);
  var reqSeason = parseInt(requestedSeason, 10);
  var abs = (absoluteNumber != null) ? parseInt(absoluteNumber, 10) : NaN;
  if (isNaN(reqEp)) return false;

  var cleaned = cleanTorrentTitle(title);

  // A batch/complete/season-pack is the whole season, not a single requested
  // episode. Returning it would make Nuvio open the wrong file. This also kills
  // the false-positive where a *sequel* sharing the name prefix (e.g.
  // "Code Geass: Dakkan no Roze - 01 ~ 12 [BATCH]") matches a S1E1 request.
  if (BATCH_PATTERN.test(cleaned)) return false;

  // Does this title declare a season, and which one? Computed once, from the
  // raw title first and the cleaned title as a fallback, and used by every
  // branch below. Two competing definitions of "does this title have a season"
  // is exactly what allowed "Show (Season 2) - 13" to satisfy an S1 request: the
  // dash branch asked the cleaned title, the season-less guards asked only the
  // request.
  var rawSeason = rawTitleSeason(title);
  var seasonInTitle = cleaned.match(SEASON_TOKEN_PATTERN);
  var titleSeason = rawSeason !== null
    ? rawSeason
    : (seasonInTitle ? parseInt(seasonInTitle[1] || seasonInTitle[2], 10) : null);
  var titleDeclaresSeason = titleSeason !== null;

  // Mid-chain bracket episode number on the RAW title: "[08][WebRip][HEVC_AAC]"
  // has its brackets stripped by cleanTorrentTitle, so the episode is lost. Only
  // 1-2 digit numeric brackets are treated as episodes today (resolutions like
  // "[1080p]" and years like "[2024]" are 3-4 digits or contain non-digits).
  // The bracket carries no season, so this only satisfies a request whose own
  // title declares no season either - "Show S2 [08][WebRip]" must not answer an
  // S1E8 request just because the season lives outside the brackets.
  var rawChain = title.match(/\[(\d{1,2})\](?=\[)/i);
  if (rawChain && reqSeason === 1 && !titleDeclaresSeason && reqEp === parseInt(rawChain[1], 10)) {
    return true;
  }

  var rangeMatch = cleaned.match(RANGE_PATTERN);
  if (rangeMatch) {
    var rangeSeason = parseInt(rangeMatch[1], 10);
    var rangeStart = parseInt(rangeMatch[2], 10);
    var rangeEnd = parseInt(rangeMatch[3], 10);
    if (rangeSeason === reqSeason && reqEp >= rangeStart && reqEp <= rangeEnd) {
      return true;
    }
  }

  for (var pi = 0; pi < EPISODE_PATTERNS.length; pi++) {
    var pat = EPISODE_PATTERNS[pi];
    var m = cleaned.match(pat.re);
    if (!m) continue;
    if (pat.seasonGroup !== null) {
      var foundSeason = parseInt(m[pat.seasonGroup], 10);
      if (foundSeason !== reqSeason) continue;
    } else if (reqSeason !== 1 || titleDeclaresSeason) {
      // Season-less episode marker ("E09", "EP239", "[8]") carries no season, so
      // it only satisfies a S1 request — and only when the title itself declares
      // no season either. Without the second half, "EP239" matches S1..S5 all at
      // ep 239, and "EngSub Show S2 - E08" has its own S2 ignored while the bare
      // E(\d+) handler reports E08 as a season-1 episode. Absolute cross-season
      // matching is handled separately via the dash/trailing abs logic.
      continue;
    }
    var foundEp = parseInt(m[pat.epGroup], 10);
    if (foundEp === reqEp) return true;
  }

  var dashMatch = cleaned.match(DASH_EP_PATTERN);
  if (dashMatch) {
    var dashEp = parseInt(dashMatch[1], 10);
    // A revision suffix is a fansub re-encode marker and only ever rides on a
    // low episode number ("09v2", "12v3"). DASH_EP_PATTERN now requires the
    // suffix to be glued, so the only 3-4 digit shape reaching this line is one
    // typed as "- 265v2": a codec or resolution tag that lost its leading "x",
    // not a fansub revision. Those are still rejected as revisions rather than
    // blanket-refusing 265 outright, because "One Piece - 265" is a real episode.
    // The case that used to fire here is gone: "[x265 v2]", whose codec token
    // cleanTorrentTitle had already stripped, leaving an orphan "v2" that \s*
    // read as a revision and cost a real 3-digit episode its match.
    var dashIsRevision = !!dashMatch[2] && dashEp >= 100;
    // Skip the candidate rather than returning false, so a title the dash pattern
    // cannot speak for still reaches the branches below. Note that a genuine batch
    // is already gone by this point - nyaa.js:581 returns false for anything
    // BATCH_PATTERN matches - so this fall-through is about the episode branches,
    // not about rescuing batches.
    if (!dashIsRevision && !looksLikeMetadata(dashEp)) {
      // Any season marker ("S2", "Season 2", "(Season 2)", "S02") makes the dash
      // number SEASON-RELATIVE - e.g. "Solo Leveling Season 2 - 08" is S2E8, so it
      // must NOT match a S1E8 request.
      if (titleSeason !== null) {
        if (titleSeason === reqSeason && dashEp === reqEp) return true;
      } else if (reqSeason === 1 && dashEp === reqEp) {
        // Absolute "- 08" with no season token (SubsPlease S1).
        return true;
      } else if (!isNaN(abs) && dashEp === abs) {
        // Absolute "- 15" (Bookworm S2 absolute numbering). Unlike the trailing
        // branch below this does not test reqSeason !== 1, and that asymmetry is
        // deliberate: getAbsoluteEpisode returns null for season <= 1, so abs is
        // only ever non-null for a season > 1 request and the guard would be
        // unreachable. Reached directly (abs supplied by a caller), the title's
        // own dash number still has to equal abs, so the looser test cannot
        // answer an S1 request with a season-1 file.
        return true;
      }
    }
  }

  // Rakun post-processor: trailing number as episode (when no season in title)
  if (!titleDeclaresSeason) {
    var trailing = cleaned.match(/\b(\d{2,4})\s*$/);
    if (trailing) {
      var num = parseInt(trailing[1], 10);
      // Years and bare resolutions reach this branch: cleanTorrentTitle strips
      // "1080p" but not "1080" or "[2024]".
      if (!looksLikeMetadata(num)) {
        if (reqSeason === 1 && num === reqEp) {
          return true;
        } else if (reqSeason !== 1 && !isNaN(abs) && num === abs) {
          // Absolute numbering with no season token (season > 1).
          return true;
        }
      }
    }
  }

  // A batch/complete/season-pack was returned false at the top of this function
  // (nyaa.js:581, the BATCH_PATTERN test on `cleaned`), and `cleaned` is never
  // reassigned after it, so BATCH_PATTERN cannot start matching again down here.
  // The re-test that used to sit at this point was dead code, and nothing in the
  // corpus would have noticed either way: every batch case is a negative, so the
  // dead block could only ever have returned true for a title already rejected.
  return false;
}

function parseQuality(title) {
  var m = title.match(RES_PATTERN);
  if (m) return m[1];
  if (/\b4K\b/i.test(title) || /\b2160\b/i.test(title)) return "2160p";
  if (/\b1080\b/i.test(title)) return "1080p";
  if (/\b720\b/i.test(title)) return "720p";
  if (/\b480\b/i.test(title)) return "480p";
  return null;
}

// Audio/subtitle tags, in Torrentio's vocabulary (addon/lib/languages.js).
// The order is the display order and groups by kind rather than by
// specificity: subtitle property, then the two audio properties, then dub.
// Every alternative is \b-anchored, so "Subs", "Multilingual", "Dual-Byte" and
// "DUBSTEP" all stay untagged. Pinned by test.js so neither the set nor the
// order can drift.
var LANGUAGE_TAGS = [
  { re: /\bmulti[\s-]?subs?\b|\bmultiple[\s-]?sub(?:title)?s?\b/i, label: "Multi Subs" },
  { re: /\bmulti[\s-]?audio\b/i, label: "Multi Audio" },
  { re: /\bdual[\s-]?audio\b/i, label: "Dual Audio" },
  // The bare \bdub\b alternative does most of the work, since release groups
  // spell it Dub, DUB, Dubbed, Eng Dub, English-Dub and so on. It cannot fire
  // on a non-dub in practice - verified against a near-miss table in test.js.
  { re: /\beng(?:lish)?[\s-]?dub\b|\bdubbed\b|\bdub\b/i, label: "Dubbed" }
];

// Title-scanning, the way Torrentio's addon/lib/subtitles.js does it: the tag
// vocabulary is loose on purpose, because release groups spell these a dozen
// ways and a false positive costs one extra label line while a missed tag looks
// like an unlabelled release.
//
// Scans the RAW title, unlike matchEpisode, which reads a bracket-stripped
// copy. cleanTorrentTitle keeps [] contents but deletes (...) entirely, so
// scanning the cleaned title would silently drop every paren-wrapped tag -
// "Show - 07 (English Dub)" would lose its Dubbed label. The divergence is
// deliberate; test.js pins it with a paren-wrapped case.
function detectAudioTags(title) {
  var out = [];
  if (!title) return out;
  for (var i = 0; i < LANGUAGE_TAGS.length; i++) {
    // The indexOf guard is currently unreachable: labels are unique in the
    // table and each row is tested once per title. It is kept so a future row
    // reusing a label cannot emit it twice.
    if (LANGUAGE_TAGS[i].re.test(title) && out.indexOf(LANGUAGE_TAGS[i].label) === -1) {
      out.push(LANGUAGE_TAGS[i].label);
    }
  }
  return out;
}

// Four fixed lines so narrow UIs have a predictable shape:
//   <resolution> / <title> / <seeders> <size> <provider> / <tags>
// A blank field is a single space, never "": Stremio collapses an empty line,
// so "" would break the 4-line shape. In production this applies to lines 1 and
// 4 - the quality and tag lines. Line 2's fallback is dead, since only items
// with a truthy title are ever pushed, and line 3 never blanks because
// parseNsTag already normalises seeders to a finite number and falls back to
// "?" for a missing size.
//
// The glyphs are U+1F4BE (floppy) before the size and U+1F4BF (optical disc)
// before the provider, matching Torrentio's streamInfo. Written as surrogate
// pairs because \u{...} is ES6 and this file is loaded by a Hermes host; the
// three confusable code points are U+1F4BE, U+1F4BF and U+1F4A9. The "?" reads
// a little like a value rather than an absence, but the spec pins it.
//
// item is not null-guarded, unlike detectAudioTags' title: the only caller
// dereferences item.infoHash several lines earlier, so a null item cannot
// reach here. Guarding it would imply a caller that does not exist.
function formatStreamName(item, quality, tags) {
  return [
    quality || " ",
    item.title || " ",
    (item.seeders || 0) + " \uD83D\uDCBE " + (item.sizeLabel || "?") + " \uD83D\uDCBF Nyaa",
    (tags && tags.length) ? tags.join(" / ") : " "
  ].join("\n");
}

function buildMagnet(infoHash, title) {
  var encodedName = encodeURIComponent(title.replace(/\[[^\]]*\]/g, "").trim());
  var magnet = "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodedName;
  var trackers = mergeTrackers(getBestTrackers());
  for (var ti = 0; ti < trackers.length; ti++) {
    magnet += "&tr=" + encodeURIComponent(trackers[ti]);
  }
  return magnet;
}

function padZero(num, len) {
  var s = String(num);
  while (s.length < len) s = "0" + s;
  return s;
}

module.exports = { getStreams };

// Hermes runtime safety: some Nuvio builds load the file and expect a global.
if (typeof global !== "undefined" && global) {
  global.getStreams = getStreams;
}
