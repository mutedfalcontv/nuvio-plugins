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

    var rawEp = parseInt(episode, 10);

    // Candidate absolute episodes to try, in priority order. Anime seasons are
    // often split differently by the app's metadata source (e.g. AniList
    // 24/24/12) than by TMDB (one long season), so the TMDB-derived absolute
    // episode can be wrong. Prefer the AniList-derived absolute episode for
    // anime, then fall back to the TMDB/Kitsu-derived one, then the raw
    // episode; the first candidate that yields a release wins. Trying the
    // AniList value first avoids a redundant re-fetch of the matching slug
    // when the TMDB value is wrong.
    var epCandidates = [];
    function addEpCandidate(v) {
      if (v === null || v === undefined || isNaN(v)) return;
      if (epCandidates.indexOf(v) === -1) epCandidates.push(v);
    }
    if (!isKitsu) {
      var aniAbs = await getAniListAbsoluteEp(titles, season, episode);
      if (aniAbs !== null) console.error("SP: anilist absolute ep", aniAbs);
      addEpCandidate(aniAbs);
    }
    addEpCandidate(targetEp);
    addEpCandidate(rawEp);

    // Canonical slugs from the SubsPlease search API come first: they survive
    // title differences (romanization, punctuation) that generateSlugs can miss.
    var slugs = [];
    var searchSlugs = await resolveSlugViaSearch(titles);
    if (searchSlugs.length > 0) console.error("SP: search slugs", searchSlugs.join(", "));
    for (var qi = 0; qi < searchSlugs.length; qi++) {
      if (slugs.indexOf(searchSlugs[qi]) === -1) slugs.push(searchSlugs[qi]);
    }
    for (var ti = 0; ti < titles.length; ti++) {
      var tSlugs = generateSlugs(titles[ti]);
      for (var si = 0; si < tSlugs.length; si++) {
        if (slugs.indexOf(tSlugs[si]) === -1) slugs.push(tSlugs[si]);
      }
    }
    console.error("SP: slugs", slugs.join(", "));
    console.error("SP: ep candidates", epCandidates.join(", "));

    for (var ei = 0; ei < epCandidates.length; ei++) {
      var mainEp = epCandidates[ei];
      for (var si = 0; si < slugs.length; si++) {
        if (!isUsableSlug(slugs[si])) continue;
        console.error("SP: try slug", slugs[si], "targetEp=" + mainEp);
        var pageResults = await scrapeShowPage(slugs[si], mainEp);
        console.error("SP: slug result", pageResults.length);
        if (pageResults.length > 0) return pageResults;
      }
    }

    var seasonNum = parseInt(season, 10);
    if (seasonNum > 1 && slugs.length > 0) {
      console.error("SP: trying season pages for S" + seasonNum);
      for (var si = 0; si < slugs.length; si++) {
        if (!isUsableSlug(slugs[si])) continue;
        var sSlug = slugs[si] + "-s" + seasonNum;
        console.error("SP: try season slug", sSlug);
        var sResults = await scrapeSeasonPage(sSlug, episode, titles);
        console.error("SP: sSlug result", sResults.length);
        if (sResults.length > 0) return sResults;
      }
      for (var si = 0; si < slugs.length; si++) {
        if (!isUsableSlug(slugs[si])) continue;
        var nSlug = slugs[si] + "-" + seasonNum;
        console.error("SP: try bare season slug", nSlug);
        var nResults = await scrapeSeasonPage(nSlug, episode, titles);
        console.error("SP: bare season slug result", nResults.length);
        if (nResults.length > 0) return nResults;
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
      titles.push(origName);
    }

    if (origName) {
      var isAscii = true;
      for (var ci = 0; ci < origName.length; ci++) {
        if (origName.charCodeAt(ci) > 127) { isAscii = false; break; }
      }
      if (!isAscii) {
        var romaji = await getRomajiTitle(tmdbId, mediaType);
        if (romaji && titles.indexOf(romaji) === -1) {
          titles.push(romaji);
        } else {
          var aniRomaji = await searchAniListTitle(data.name || data.title);
          if (aniRomaji && titles.indexOf(aniRomaji) === -1) {
            titles.push(aniRomaji);
          }
        }
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

async function getKitsuAbsoluteEp(kitsuId, season, episode) {
  try {
    var seasonNum = parseInt(season, 10);
    var epNum = parseInt(episode, 10);
    console.error("KitsuEp: looking for S" + seasonNum + " absolute=" + epNum);
    if (isNaN(seasonNum) || isNaN(epNum)) { console.error("KitsuEp: bad params"); return null; }

    var epsResp = await fetch("https://kitsu.io/api/edge/anime/" + kitsuId + "/episodes?page[limit]=20");
    var epsData = await epsResp.json();
    if (!epsData || !epsData.data) { console.error("KitsuEp: no data"); return null; }

    console.error("KitsuEp: total eps", epsData.data.length);
    // Try exact seasonNumber + number match
    for (var ei = 0; ei < epsData.data.length; ei++) {
      var ep = epsData.data[ei].attributes;
      if (!ep) continue;
      if (parseInt(ep.seasonNumber, 10) === seasonNum && parseInt(ep.number, 10) === epNum) {
        console.error("KitsuEp: matched S" + ep.seasonNumber + " number=" + ep.number);
        return epNum;
      }
    }
    // Fallback: season-specific Kitsu entries have seasonNumber=1 for all eps
    // Try matching just on episode number
    if (epsData.data.length > 0) {
      var allSameSeason = true;
      var firstSn = parseInt(epsData.data[0].attributes.seasonNumber, 10);
      for (var ei = 1; ei < epsData.data.length; ei++) {
        if (parseInt(epsData.data[ei].attributes.seasonNumber, 10) !== firstSn) {
          allSameSeason = false; break;
        }
      }
      if (allSameSeason) {
        for (var ei = 0; ei < epsData.data.length; ei++) {
          var ep = epsData.data[ei].attributes;
          if (parseInt(ep.number, 10) === epNum) {
            console.error("KitsuEp: matched by number only, ep=" + ep.number);
            return epNum;
          }
        }
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

// Resolve an absolute (cross-season) episode number from the AniList sequel
// chain. Anime is frequently split into per-season AniList entries (e.g.
// Kusuriya no Hitorigoto = 24 / 24 / 12), so the absolute episode for season S
// is (sum of episodes of the TV entries before S) + episode. This matches the
// way SubsPlease numbers releases continuously across a franchise.
async function getAniListAbsoluteEp(titles, season, episode) {
  try {
    var seasonNum = parseInt(season, 10);
    var epNum = parseInt(episode, 10);
    if (isNaN(seasonNum) || isNaN(epNum)) { console.error("AniListAbs: bad params"); return null; }
    if (seasonNum < 1) { console.error("AniListAbs: season < 1"); return null; }
    if (!titles || titles.length === 0) { console.error("AniListAbs: no titles"); return null; }

    var node = null;
    for (var i = 0; i < titles.length && !node; i++) {
      node = await aniListMediaSearch(titles[i]);
    }
    if (!node) { console.error("AniListAbs: no base media"); return null; }
    console.error("AniListAbs: base", node.id, node.episodes, node.format);

    var offset = 0;
    var seen = {};
    seen[node.id] = true;
    for (var s = 1; s < seasonNum; s++) {
      offset += node.episodes || 0;
      var sequel = findAniListSequel(node);
      if (!sequel) { console.error("AniListAbs: no TV sequel at step " + s); return null; }
      if (seen[sequel.id]) { console.error("AniListAbs: sequel cycle"); return null; }
      seen[sequel.id] = true;
      if (s === seasonNum - 1) {
        if (!sequel.episodes) { console.error("AniListAbs: sequel episodes unknown"); return null; }
        console.error("AniListAbs: offset=" + offset + " abs=" + (offset + epNum) + " (S" + seasonNum + "E" + epNum + ")");
        return offset + epNum;
      }
      node = await aniListMediaById(sequel.id);
      if (!node) { console.error("AniListAbs: sequel fetch failed"); return null; }
    }

    console.error("AniListAbs: offset=0 abs=" + epNum + " (S" + seasonNum + "E" + epNum + ")");
    return epNum;
  } catch (e) {
    console.error("AniList absolute ep failed:", e.message);
    return null;
  }
}

function findAniListSequel(node) {
  if (!node || !node.relations) return null;
  for (var i = 0; i < node.relations.length; i++) {
    var edge = node.relations[i];
    if (edge && edge.relationType === "SEQUEL" && edge.node && edge.node.format === "TV") {
      return edge.node;
    }
  }
  return null;
}

function normalizeAniListMedia(media) {
  if (!media) return null;
  media.relations = (media.relations && media.relations.edges) ? media.relations.edges : [];
  return media;
}

async function aniListMediaSearch(search) {
  if (!search) return null;
  try {
    var query = "query ($search: String) { Media(search: $search, type: ANIME) { id episodes format relations { edges { relationType node { id episodes format } } } } }";
    var resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Nuvio/1.0"
      },
      body: JSON.stringify({ query: query, variables: { search: search } })
    });
    if (resp.status === 429) { console.error("AniListAbs: rate limited"); return null; }
    var data = await resp.json();
    if (!data || !data.data || !data.data.Media) return null;
    return normalizeAniListMedia(data.data.Media);
  } catch (e) {
    console.error("AniListAbs search failed:", e.message);
    return null;
  }
}

async function aniListMediaById(id) {
  if (!id) return null;
  try {
    var query = "query ($id: Int) { Media(id: $id, type: ANIME) { id episodes format relations { edges { relationType node { id episodes format } } } } }";
    var resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Nuvio/1.0"
      },
      body: JSON.stringify({ query: query, variables: { id: id } })
    });
    if (resp.status === 429) { console.error("AniListAbs: rate limited"); return null; }
    var data = await resp.json();
    if (!data || !data.data || !data.data.Media) return null;
    return normalizeAniListMedia(data.data.Media);
  } catch (e) {
    console.error("AniListAbs fetch failed:", e.message);
    return null;
  }
}

async function scrapeShowPage(slug, targetEp) {
  if (!isUsableSlug(slug)) return [];
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

      // Skip non-integer episodes (65.5, 66v2, etc.)
      var epStr = item.episode;
      if (epStr.indexOf("-") !== -1) continue;
      var epInt = parseInt(epStr, 10);
      if (isNaN(epInt)) continue;
      if (String(epInt) !== epStr) continue;
      if (epInt !== targetEp) continue;

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

async function scrapeSeasonPage(seasonSlug, episode, expectedTitles) {
  if (!isUsableSlug(seasonSlug)) return [];
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

      if (expectedTitles && expectedTitles.length > 0 && !nameMatchesShow(item.show, expectedTitles)) {
        console.error("SP: season show mismatch, rejecting", item.show);
        continue;
      }

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

  // Also generate a version with apostrophes removed (it's → its)
  var baseNoApos = base.replace(/'/g, "");
  if (baseNoApos !== base) {
    slugs.push(baseNoApos.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));
  }

  slugs.push(base.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));

  var parenless = base.replace(/\([^)]*\)/g, "").trim();
  if (parenless !== base) {
    slugs.push(parenless.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));
  }

  var beforeColon = base.split(":")[0].trim();
  if (beforeColon !== base) {
    var bcSlug = beforeColon.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (bcSlug.length >= 4) slugs.push(bcSlug);
    var beforeColonParenless = beforeColon.replace(/\([^)]*\)/g, "").trim();
    if (beforeColonParenless !== beforeColon) {
      var bcpSlug = beforeColonParenless.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      if (bcpSlug.length >= 4) slugs.push(bcpSlug);
    }
  }

  var clean = (beforeColon !== base ? beforeColon : parenless);
  var words = clean.split(/\s+/).filter(function(w) { return w.length > 0; });
  if (words.length > 3) {
    slugs.push(words.slice(0, 3).join("-"));
  }

  // Add underscore variants for first hyphen (handles slugs like d_cide-traumerei)
  var extra = [];
  for (var si = 0; si < slugs.length; si++) {
    var underPos = slugs[si].indexOf("-");
    if (underPos > 0) {
      var underV = slugs[si].substring(0, underPos) + "_" + slugs[si].substring(underPos + 1);
      if (slugs.indexOf(underV) === -1 && extra.indexOf(underV) === -1) extra.push(underV);
    }
  }

  var deduped = [];
  for (var si = 0; si < slugs.length; si++) {
    if (isUsableSlug(slugs[si]) && deduped.indexOf(slugs[si]) === -1) {
      deduped.push(slugs[si]);
    }
  }
  for (var si = 0; si < extra.length; si++) {
    if (isUsableSlug(extra[si]) && deduped.indexOf(extra[si]) === -1) {
      deduped.push(extra[si]);
    }
  }
  return deduped;
}

function isUsableSlug(slug) {
  return typeof slug === "string" && slug.length >= 2 && /[a-z0-9]/.test(slug);
}

function showNameTokens(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(function(w) {
    return w.length >= 3;
  });
}

function nameMatchesShow(showName, titles) {
  if (!titles || titles.length === 0) return true;
  var showNorm = (showName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!showNorm) return true;
  var showTokens = showNameTokens(showName);
  for (var i = 0; i < titles.length; i++) {
    var tNorm = (titles[i] || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!tNorm) continue;
    if (tNorm.indexOf(showNorm) !== -1 || showNorm.indexOf(tNorm) !== -1) return true;
    var tTokens = showNameTokens(titles[i]);
    for (var a = 0; a < showTokens.length; a++) {
      for (var b = 0; b < tTokens.length; b++) {
        if (showTokens[a] === tTokens[b]) return true;
      }
    }
  }
  return false;
}

// Resolve canonical SubsPlease slugs from the search API. The endpoint returns
// recent uploads keyed "<Show> - <ep>"; each value carries the canonical "page"
// slug (e.g. "kusuriya-no-hitorigoto"). This maps titles that generateSlugs
// cannot reproduce (romanization/spelling differences). It is best-effort:
// any failure falls back silently to the generated slugs. English-only titles
// usually miss (the index is romaji), so query every known title until one hits.
async function resolveSlugViaSearch(titles) {
  var found = [];
  if (!titles || titles.length === 0) return found;
  for (var i = 0; i < titles.length; i++) {
    var query = titles[i];
    if (!query) continue;
    var data = null;
    try {
      var url = "https://subsplease.org/api/?f=search&tz=UTC&s=" + encodeURIComponent(query);
      var resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      data = await resp.json();
    } catch (e) {
      console.error("SP: search failed for", query, e.message);
      continue;
    }
    // Empty array (or non-object) means no match for this title.
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    var matched = [];
    for (var key in data) {
      var item = data[key];
      if (!item || !item.page) continue;
      var slug = String(item.page).trim();
      if (!isUsableSlug(slug)) continue;
      if (!nameMatchesShow(item.show || key, [query])) continue;
      if (matched.indexOf(slug) === -1) matched.push(slug);
    }
    for (var mi = 0; mi < matched.length; mi++) {
      if (found.indexOf(matched[mi]) === -1) found.push(matched[mi]);
    }
    if (found.length > 0) break;
  }
  return found;
}

module.exports = { getStreams };
