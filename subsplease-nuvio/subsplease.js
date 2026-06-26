async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    console.error("SP start:", tmdbId, mediaType, season, episode);
    if (mediaType !== "tv" && mediaType !== "series" && mediaType !== "anime") { console.error("SP: bad type"); return []; }

    var tmdbType = mediaType === "anime" ? "tv" : mediaType;
    var isKitsu = typeof tmdbId === "string" && tmdbId.indexOf("kitsu:") === 0;

    var titles;
    var targetEp = null;

    if (isKitsu) {
      console.error("SP: kitsu path");
      var kitsuId = tmdbId.split(":")[1];
      titles = await getKitsuTitles(tmdbId);
      targetEp = await getKitsuAbsoluteEp(kitsuId, season, episode);
    } else {
      console.error("SP: tmdb path");
      titles = await getTmdbTitles(tmdbId, tmdbType);
      targetEp = await getTmdbAbsoluteEp(tmdbId, season, episode);
    }

    console.error("SP: titles", titles ? titles.join(", ") : "none");
    console.error("SP: targetEp", targetEp);
    if (!titles || titles.length === 0) { console.error("SP: no titles"); return []; }

    var slugs = [];
    for (var ti = 0; ti < titles.length; ti++) {
      var tSlugs = generateSlugs(titles[ti]);
      for (var si = 0; si < tSlugs.length; si++) {
        if (slugs.indexOf(tSlugs[si]) === -1) slugs.push(tSlugs[si]);
      }
    }
    console.error("SP: slugs", slugs.join(", "));

    if (targetEp !== null) {
      for (var si = 0; si < slugs.length; si++) {
        console.error("SP: try slug", slugs[si]);
        var pageResults = await scrapeShowPage(slugs[si], targetEp);
        console.error("SP: slug result", pageResults.length);
        if (pageResults.length > 0) return pageResults;
      }
    }

    var seasonNum = parseInt(season, 10);
    if (seasonNum > 1 && slugs.length > 0) {
      console.error("SP: trying season pages for S" + seasonNum);
      for (var si = 0; si < slugs.length; si++) {
        var sSlug = slugs[si] + "-s" + seasonNum;
        console.error("SP: try season slug", sSlug);
        var sResults = await scrapeSeasonPage(sSlug, episode);
        console.error("SP: season slug result", sResults.length);
        if (sResults.length > 0) return sResults;
      }
    }

    console.error("SP: no match");
    return [];
  } catch (e) {
    console.error("SP error:", e.message);
    return [];
  }
}

async function getTmdbTitles(tmdbId, mediaType) {
  var titles = [];
  var url = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  try {
    var resp = await fetch(url);
    var data = await resp.json();
    if (!data) return titles;

    if (data.title) titles.push(data.title);
    if (data.name && titles.indexOf(data.name) === -1) titles.push(data.name);

    var origName = data.original_name || data.original_title;
    if (origName && titles.indexOf(origName) === -1) {
      var isAscii = true;
      for (var ci = 0; ci < origName.length; ci++) {
        if (origName.charCodeAt(ci) > 127) { isAscii = false; break; }
      }
      if (isAscii) {
        titles.push(origName);
      } else {
        var romaji = await getRomajiTitle(tmdbId, mediaType);
        if (romaji && titles.indexOf(romaji) === -1) titles.push(romaji);
      }
    }
  } catch (e) {
    console.error("TMDB fetch failed:", e.message);
  }
  return titles;
}

async function getRomajiTitle(tmdbId, mediaType) {
  try {
    var url = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "/translations?api_key=" + TMDB_API_KEY;
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
    if (attrs.canonicalTitle) titles.push(attrs.canonicalTitle);
    if (attrs.titles) {
      if (attrs.titles.en_jp && titles.indexOf(attrs.titles.en_jp) === -1) titles.push(attrs.titles.en_jp);
      if (attrs.titles.en && titles.indexOf(attrs.titles.en) === -1) titles.push(attrs.titles.en);
    }
  } catch (e) {
    console.error("Kitsu fetch failed:", e.message);
  }
  return titles;
}

async function getKitsuAbsoluteEp(kitsuId, season, episode) {
  try {
    var seasonNum = parseInt(season, 10);
    var epNum = parseInt(episode, 10);
    console.error("KitsuEp: looking for S" + seasonNum + " absolute=" + epNum);
    if (isNaN(seasonNum) || isNaN(epNum)) { console.error("KitsuEp: bad params"); return null; }

    var epsResp = await fetch("https://kitsu.io/api/edge/anime/" + kitsuId + "/episodes?page[limit]=500");
    var epsData = await epsResp.json();
    if (!epsData || !epsData.data) { console.error("KitsuEp: no data"); return null; }

    console.error("KitsuEp: total eps", epsData.data.length);
    for (var ei = 0; ei < epsData.data.length; ei++) {
      var ep = epsData.data[ei].attributes;
      if (!ep) continue;
      if (parseInt(ep.seasonNumber, 10) === seasonNum && parseInt(ep.number, 10) === epNum) {
        console.error("KitsuEp: matched S" + ep.seasonNumber + " number=" + ep.number);
        return epNum;
      }
    }
    console.error("KitsuEp: no match among", epsData.data.length, "eps");
    return null;
  } catch (e) {
    console.error("Kitsu ep lookup failed:", e.message);
    return null;
  }
}

async function getTmdbAbsoluteEp(tmdbId, season, episode) {
  try {
    var seasonNum = parseInt(season, 10);
    var epNum = parseInt(episode, 10);
    console.error("TMDBEp: looking for S" + seasonNum + "E" + epNum);
    if (isNaN(seasonNum) || isNaN(epNum)) { console.error("TMDBEp: bad params"); return null; }

    var seriesResp = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + TMDB_API_KEY);
    var seriesData = await seriesResp.json();
    if (!seriesData || !seriesData.seasons) { console.error("TMDBEp: no seasons"); return null; }

    var offset = 0;
    for (var si = 0; si < seriesData.seasons.length; si++) {
      var s = seriesData.seasons[si];
      var sn = parseInt(s.season_number, 10);
      if (isNaN(sn) || sn <= 0) continue;
      if (sn >= seasonNum) break;
      offset += parseInt(s.episode_count, 10) || 0;
    }

    var result = offset + epNum;
    console.error("TMDBEp: offset=" + offset + " total=" + result);
    return result;
  } catch (e) {
    console.error("TMDB absolute ep failed:", e.message);
    return null;
  }
}

async function scrapeShowPage(slug, targetEp) {
  try {
    var url = "https://subsplease.org/shows/" + slug + "/";
    var resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    var html = await resp.text();
    if (!html || html.indexOf("404") !== -1) return [];

    var $ = cheerio.load(html);
    var sid = $('#show-release-table').attr('sid');
    if (!sid) return [];

    var apiResp = await fetch("https://subsplease.org/api/?f=show&tz=UTC&sid=" + sid);
    var apiData = await apiResp.json();
    if (!apiData || typeof apiData !== "object") return [];

    var episodes = apiData.episode;
    if (!episodes || typeof episodes !== "object") return [];

    var results = [];
    for (var key in episodes) {
      var item = episodes[key];
      if (!item || !item.episode || !item.downloads) continue;

      if (item.episode.indexOf("-") !== -1) continue;

      var itemEp = parseInt(item.episode, 10);
      if (isNaN(itemEp)) continue;
      if (itemEp !== targetEp) continue;

      for (var di = 0; di < item.downloads.length; di++) {
        var dl = item.downloads[di];
        if (!dl.magnet) continue;

        var infoHash = null;
        var xtMatch = dl.magnet.match(/xt=urn:btih:([A-Za-z0-9-]+)/);
        if (xtMatch) {
          var raw = xtMatch[1].toUpperCase();
          if (raw.length === 40) {
            infoHash = raw;
          } else if (raw.length === 32) {
            infoHash = base32ToHex(raw);
          }
        }

        results.push({
          title: item.show + " - " + item.episode + " (" + dl.res + "p)",
          name: item.show + " - " + item.episode,
          url: dl.magnet,
          infoHash: infoHash,
          quality: dl.res + "p",
          size: null,
          provider: "SubsPlease",
          type: "tv"
        });
      }
    }

    results.sort(function(a, b) {
      var qa = parseInt(a.quality, 10) || 0;
      var qb = parseInt(b.quality, 10) || 0;
      return qb - qa;
    });

    return results;
  } catch (e) {
    console.error("Show page scrape failed:", e.message);
    return [];
  }
}

async function scrapeSeasonPage(seasonSlug, episode) {
  try {
    var url = "https://subsplease.org/shows/" + seasonSlug + "/";
    console.error("SP: fetching season page", url);
    var resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    var html = await resp.text();
    if (!html || html.indexOf("404") !== -1) { console.error("SP: season page 404"); return []; }

    var $ = cheerio.load(html);
    var sid = $('#show-release-table').attr('sid');
    if (!sid) { console.error("SP: season page no sid"); return []; }
    console.error("SP: season page sid", sid);

    var apiResp = await fetch("https://subsplease.org/api/?f=show&tz=UTC&sid=" + sid);
    var apiData = await apiResp.json();
    if (!apiData || typeof apiData !== "object") { console.error("SP: season api no data"); return []; }

    var episodes = apiData.episode;
    if (!episodes || typeof episodes !== "object") { console.error("SP: season no episodes"); return []; }

    var epNum = parseInt(episode, 10);
    if (isNaN(epNum)) { console.error("SP: season bad ep num"); return []; }

    var results = [];
    for (var key in episodes) {
      var item = episodes[key];
      if (!item || !item.episode || !item.downloads) continue;

      var itemEp = parseInt(item.episode, 10);
      if (isNaN(itemEp)) continue;
      if (itemEp !== epNum) continue;

      for (var di = 0; di < item.downloads.length; di++) {
        var dl = item.downloads[di];
        if (!dl.magnet) continue;

        var infoHash = null;
        var xtMatch = dl.magnet.match(/xt=urn:btih:([A-Za-z0-9-]+)/);
        if (xtMatch) {
          var raw = xtMatch[1].toUpperCase();
          if (raw.length === 40) {
            infoHash = raw;
          } else if (raw.length === 32) {
            infoHash = base32ToHex(raw);
          }
        }

        results.push({
          title: item.show + " - " + item.episode + " (" + dl.res + "p)",
          name: item.show + " - " + item.episode,
          url: dl.magnet,
          infoHash: infoHash,
          quality: dl.res + "p",
          size: null,
          provider: "SubsPlease",
          type: "tv"
        });
      }
    }

    results.sort(function(a, b) {
      var qa = parseInt(a.quality, 10) || 0;
      var qb = parseInt(b.quality, 10) || 0;
      return qb - qa;
    });

    console.error("SP: season results", results.length);
    return results;
  } catch (e) {
    console.error("Season page scrape failed:", e.message);
    return [];
  }
}

function base32ToHex(b32) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  var bits = "";
  for (var bi = 0; bi < b32.length; bi++) {
    var val = alphabet.indexOf(b32[bi]);
    if (val === -1) continue;
    bits += ("00000" + val.toString(2)).slice(-5);
  }
  var hex = "";
  for (var ni = 0; ni + 4 <= bits.length; ni += 4) {
    hex += parseInt(bits.substr(ni, 4), 2).toString(16);
  }
  return hex.toUpperCase();
}

function generateSlugs(title) {
  var base = title.toLowerCase();
  var slugs = [];

  slugs.push(base.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));

  var parenless = base.replace(/\([^)]*\)/g, "").trim();
  if (parenless !== base) {
    slugs.push(parenless.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));
  }

  var beforeColon = base.split(":")[0].trim();
  if (beforeColon !== base) {
    slugs.push(beforeColon.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));
    var beforeColonParenless = beforeColon.replace(/\([^)]*\)/g, "").trim();
    if (beforeColonParenless !== beforeColon) {
      slugs.push(beforeColonParenless.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));
    }
  }

  var clean = (beforeColon !== base ? beforeColon : parenless);
  var words = clean.split(/\s+/).filter(function(w) { return w.length > 0; });
  if (words.length > 3) {
    slugs.push(words.slice(0, 3).join("-"));
  }

  var deduped = [];
  for (var si = 0; si < slugs.length; si++) {
    if (deduped.indexOf(slugs[si]) === -1) {
      deduped.push(slugs[si]);
    }
  }
  return deduped;
}

module.exports = { getStreams };
