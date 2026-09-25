var TRACKERS = [
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
  { re: /S(\d+)\s*E(\d+)/i, seasonGroup: 1, epGroup: 2 },
  { re: /S(\d+)\s*\.\s*E(\d+)/i, seasonGroup: 1, epGroup: 2 },
  { re: /S(\d+)\s*[-–]\s*(\d{1,3})\b/i, seasonGroup: 1, epGroup: 2 },
  { re: /\bS(\d{1,2})\s*[-–]\s*E(\d{1,3})\b/i, seasonGroup: 1, epGroup: 2 },
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
// stops the match from landing mid-digit-run ("1122" must not be read as "11")
// and from eating the stem of a "1080p"-style tag.
var DASH_EP_PATTERN = /-\s*(\d{1,4})(\s*v\d+)?(?![0-9a-z])/i;
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
var RAW_SEASON_PATTERN = /(?:^|[^A-Za-z0-9])(?:S(\d{1,2})\b|(?:Season|Saison)[.\s_-]?(\d{1,2})\b)/i;

function rawTitleSeason(title) {
  var m = String(title || "").match(RAW_SEASON_PATTERN);
  if (!m) return null;
  return parseInt(m[1] || m[2], 10);
}

// Numbers that are never episode numbers, in either of the two digit-tolerant
// branches. A 4-digit group in the 19xx/20xx range is a year; 480/720/1080/
// 1440/2160 are resolutions. cleanTorrentTitle only strips the "p" forms
// ("1080p"), never a bare "1080" or a "[2024]" year, so all of these survive
// cleaning and land in the dash and trailing-number branches.
function looksLikeMetadata(n) {
  return (n >= 1900 && n <= 2099) ||
    n === 480 || n === 720 || n === 1080 || n === 1440 || n === 2160;
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
  var rest = {};
  for (var k in init) { if (k !== "retries") rest[k] = init[k]; }
  var lastError;
  for (var attempt = 0; attempt <= retries; attempt++) {
    try {
      var res = await withTimeout(fetch(url, rest), FETCH_TIMEOUT_MS, url);
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
          var magnet = buildMagnet(item.infoHash, item.title);

          results.push({
            title: item.title,
            name: item.title,
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
    // low episode number ("09v2", "12v3"). On a 3-4 digit number the same
    // "- 265v2" shape is a codec or resolution tag that lost its leading "x", so
    // reject it as a revision rather than blanket-refusing 265 outright - "One
    // Piece - 265" is a real episode.
    var dashIsRevision = !!dashMatch[2] && dashEp >= 100;
    // Rejecting the candidate (rather than returning false) lets the batch
    // handler below still see a year-shaped title such as
    // "Show - 2024 [1080p] [BATCH]".
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
        // Absolute "- 15" (Bookworm S2 absolute numbering).
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

  var isBatch = BATCH_PATTERN.test(cleaned);
  if (isBatch) {
    var batchSeasonMatch = cleaned.match(/\bSeason\s+(\d+)\b/i);
    if (!batchSeasonMatch) {
      batchSeasonMatch = cleaned.match(/S(\d+)/i);
    }
    if (batchSeasonMatch) {
      var batchSeason = parseInt(batchSeasonMatch[1], 10);
      if (batchSeason === reqSeason) return true;
    }
  }

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

function buildMagnet(infoHash, title) {
  var encodedName = encodeURIComponent(title.replace(/\[[^\]]*\]/g, "").trim());
  var magnet = "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodedName;
  for (var ti = 0; ti < TRACKERS.length; ti++) {
    magnet += "&tr=" + encodeURIComponent(TRACKERS[ti]);
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
