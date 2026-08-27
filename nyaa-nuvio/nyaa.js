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
  { re: /Season\s+(\d+)\s+Episode\s+(\d+)/i, seasonGroup: 1, epGroup: 2 },
  { re: /(\d+)x(\d+)/i, seasonGroup: 1, epGroup: 2 },
  { re: /\[(\d+)\]$/i, seasonGroup: null, epGroup: 1 },
  { re: /\bE(\d+)\b/i, seasonGroup: null, epGroup: 1 },
  { re: /\bEP(\d+)\b/i, seasonGroup: null, epGroup: 1 },
  { re: /\bEpisodes?\s*(\d+)\b/i, seasonGroup: null, epGroup: 1 },
  { re: /\[(\d+)v\d\]/i, seasonGroup: null, epGroup: 1 }
];

var DASH_EP_PATTERN = /-\s*(\d{1,2})\b(?!\s*[pP])/i;
var BATCH_PATTERN = /\b(batch|complete|season\s+\d+\s+pack)\b/i;
var RANGE_PATTERN = /S(\d+)\s*E(\d+)\s*[-–]\s*E?(\d+)/i;
var RES_PATTERN = /\b(4K|2160p|1080p|720p|480p|360p)\b/i;
var TRUSTED_PATTERN = /\b(trusted|v2|remaster)\b/i;

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
// Build multiple candidates per title and try them all.
function buildQueries(title, season, episode) {
  var out = [];
  var ep = parseInt(episode, 10);
  var s = parseInt(season, 10);

  if (!isNaN(ep)) out.push(title + " " + ep);                              // anime/absolute: "Futari 08"
  if (!isNaN(s) && !isNaN(ep)) out.push(title + " S" + padZero(s, 2) + "E" + padZero(ep, 2)); // TV: "Show S01E08"
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

    var seen = {};
    var results = [];

    // Try every title, and for each title every candidate query. Do NOT break
    // on the first hit — the English TMDB title returns English-dub torrents
    // while the romaji title returns SubsPlease/Erai. Both are valid sources.
    for (var ti = 0; ti < titles.length; ti++) {
      var queries = buildQueries(titles[ti], season, episode);
      for (var qi = 0; qi < queries.length; qi++) {
        var rssItems = await searchNyaa(queries[qi], NYAA_CATEGORIES.ENGLISH);
        if (!rssItems || rssItems.length === 0) {
          rssItems = await searchNyaa(queries[qi], NYAA_CATEGORIES.ALL);
        }
        if (!rssItems) continue;

        for (var ri = 0; ri < rssItems.length; ri++) {
          var item = rssItems[ri];
          if (seen[item.infoHash]) continue;
          var match = matchEpisode(item.title, season, episode);
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
    var resp = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + TMDB_KEY);
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

    var altResp = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "/alternative_titles?api_key=" + TMDB_KEY);
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

function matchEpisode(title, requestedSeason, requestedEpisode) {
  var reqEp = parseInt(requestedEpisode, 10);
  var reqSeason = parseInt(requestedSeason, 10);
  if (isNaN(reqEp)) return false;

  var cleaned = cleanTorrentTitle(title);

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
    }
    var foundEp = parseInt(m[pat.epGroup], 10);
    if (foundEp === reqEp) return true;
  }

  var dashMatch = cleaned.match(DASH_EP_PATTERN);
  if (dashMatch) {
    var dashEp = parseInt(dashMatch[1], 10);
    var knownSeasonInTitle = /\bS(\d+)\b/i.test(cleaned);
    if (!knownSeasonInTitle && reqSeason === 1 && dashEp === reqEp) {
      return true;
    }
  }

  // Rakun post-processor: trailing number as episode (when no season in title)
  if (!/\bS(\d+)\b/i.test(cleaned)) {
    if (reqSeason === 1) {
      var trailingEp = cleaned.match(/\b(\d{2,4})\s*$/);
      if (trailingEp) {
        var num = parseInt(trailingEp[1], 10);
        if (num === reqEp) return true;
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
