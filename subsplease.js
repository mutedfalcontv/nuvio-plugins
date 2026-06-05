var SUBSIMAGES_BASE = "https://subsplease.org";
var RSS_FEED = "https://subsplease.org/rss";

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (mediaType !== "tv") return [];

    var title = await getTmdbTitle(tmdbId, mediaType);
    if (!title) return [];

    var rssXml = await fetchXml(RSS_FEED);
    if (!rssXml) return [];

    var results = parseRssForShow(rssXml, title, season, episode);
    if (results.length === 0) {
      var slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      var pageResults = await scrapeShowPage(slug, title, season, episode);
      return pageResults;
    }
    return results;
  } catch (e) {
    console.error("SubsPlease error:", e.message);
    return [];
  }
}

async function getTmdbTitle(tmdbId, mediaType) {
  var url = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  try {
    var resp = await fetch(url);
    var data = await resp.json();
    return data.title || data.name || null;
  } catch (e) {
    console.error("TMDB fetch failed:", e.message);
    return null;
  }
}

async function fetchXml(url) {
  try {
    var resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    return await resp.text();
  } catch (e) {
    console.error("RSS fetch failed:", e.message);
    return null;
  }
}

function parseRssForShow(xml, showTitle, season, episode) {
  var results = [];
  var episodeNum = parseInt(episode, 10);
  if (isNaN(episodeNum)) episodeNum = null;

  var normalizedTitle = normalize(showTitle);

  var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];

    var title = extractTag(item, "title");
    if (!title) continue;

    var link = extractTag(item, "link");
    if (!link) continue;

    var size = extractTag(item, "subsplease:size") || null;
    var pubDate = extractTag(item, "pubDate") || null;

    if (title.indexOf("[SubsPlease]") === -1) continue;

    var showPart = title.replace(/^\[SubsPlease\]\s*/, "");

    var epMatch = showPart.match(/-\s*(\d+)/);
    var itemEpNum = epMatch ? parseInt(epMatch[1], 10) : null;

    var qualityMatch = title.match(/\((\d+p)\)/);
    var quality = qualityMatch ? qualityMatch[1] : null;

    var showName = showPart.replace(/-\s*\d+\s+\(\d+p\)/, "").replace(/\s+$/, "").trim();

    var itemNormalized = normalize(showName);
    if (!isMatch(normalizedTitle, itemNormalized)) continue;

    if (episodeNum !== null && itemEpNum !== null && itemEpNum !== episodeNum) continue;

    var hashMatch = title.match(/\[([A-Fa-f0-9]{8})\]/);
    var titleClean = showName + " - " + (itemEpNum || episodeNum);
    if (quality) titleClean += " (" + quality + ")";

    var infoHash = null;
    var xtMatch = link.match(/xt=urn:btih:([A-Fa-f0-9]+)/);
    if (xtMatch) infoHash = xtMatch[1].toUpperCase();

    if (infoHash) {
      results.push({
        title: titleClean,
        name: showName + " - Episode " + (itemEpNum || episodeNum),
        url: link,
        infoHash: infoHash,
        quality: quality || "unknown",
        size: size || null,
        provider: "SubsPlease",
        type: "tv",
        seeders: null,
        peers: null
      });
    }
  }

  results.sort(function(a, b) {
    var qa = parseInt(a.quality, 10) || 0;
    var qb = parseInt(b.quality, 10) || 0;
    return qb - qa;
  });

  return results;
}

async function scrapeShowPage(slug, showTitle, season, episode) {
  try {
    var url = "https://subsplease.org/shows/" + slug + "/";
    var resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    var html = await resp.text();
    if (!html || html.indexOf("404") !== -1) return [];

    var episodeNum = parseInt(episode, 10);
    if (isNaN(episodeNum)) episodeNum = null;

    var results = [];

    var $ = cheerio.load(html);
    var links = $("a[href*='/download/']");
    var found = {};
    for (var i = 0; i < links.length; i++) {
      var href = $(links[i]).attr("href");
      var text = $(links[i]).text();
      if (!href) continue;

      var epMatch = text.match(/(\d+)/);
      var textEp = epMatch ? parseInt(epMatch[1], 10) : null;
      if (episodeNum !== null && textEp !== null && textEp !== episodeNum) continue;

      var quality = "unknown";
      if (text.indexOf("1080") !== -1) quality = "1080p";
      else if (text.indexOf("720") !== -1) quality = "720p";
      else if (text.indexOf("480") !== -1) quality = "480p";

      var url = href.indexOf("http") === 0 ? href : "https://subsplease.org" + href;
      if (found[url]) continue;
      found[url] = true;

      results.push({
        title: slug + " - Episode " + (textEp || episodeNum || "?"),
        name: slug + " - " + (textEp || episodeNum || "?") + (quality ? " (" + quality + ")" : ""),
        url: url,
        quality: quality,
        size: null,
        provider: "SubsPlease",
        type: "tv"
      });
    }

    return results;
  } catch (e) {
    console.error("Show page scrape failed:", e.message);
    return [];
  }
}

function extractTag(xml, tag) {
  var cdMatch = xml.match(new RegExp("<" + tag + "><!\\[CDATA\\[(.*?)\\]\\]><\/" + tag + ">"));
  if (cdMatch) return cdMatch[1];
  var valMatch = xml.match(new RegExp("<" + tag + ">(.*?)<\/" + tag + ">"));
  return valMatch ? valMatch[1].trim() : null;
}

function normalize(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMatch(normalized, itemNormalized) {
  if (itemNormalized.indexOf(normalized) !== -1) return true;
  if (normalized.indexOf(itemNormalized) !== -1) return true;
  var nWords = normalized.split(" ");
  var iWords = itemNormalized.split(" ");
  var matchCount = 0;
  for (var i = 0; i < nWords.length; i++) {
    if (nWords[i].length < 3) continue;
    for (var j = 0; j < iWords.length; j++) {
      if (iWords[j].indexOf(nWords[i]) !== -1 || nWords[i].indexOf(iWords[j]) !== -1) {
        matchCount++;
        break;
      }
    }
  }
  return matchCount >= 2;
}

module.exports = { getStreams };
