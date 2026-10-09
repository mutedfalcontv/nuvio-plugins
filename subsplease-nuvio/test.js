// Regression tests for the SubsPlease empty-slug -> wrong-show bug.
//
// Root cause: generateSlugs() emitted "" for non-ASCII (Japanese) titles, and
// the season fallback concatenated it to "-<N>" / "-s<N>". subsplease.org
// answers "/shows/-2/" with HTTP 200 pointing at a *different* show
// ("2.43 - Seiin Koukou Danshi Volley-bu"), so "Black Clover" season 2 and
// "The Apothecary Diaries" season 3 returned unrelated streams.
//
// These tests load subsplease.js in a vm with a stub fetch/cheerio so the exact
// wrong-show path is reproduced deterministically and offline.

const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

let passed = 0;
let failed = 0;

function assert(name, cond) {
  if (cond) {
    passed++;
    console.log("  ok  - " + name);
  } else {
    failed++;
    console.error("  FAIL- " + name);
  }
}

function makeCheerio() {
  return {
    load: function (html) {
      var sid = null;
      var m = /id="show-release-table"[^>]*sid="([^"]+)"/.exec(html);
      if (m) sid = m[1];
      var title = "";
      var t = /<title>([\s\S]*?)<\/title>/.exec(html);
      if (t) title = t[1];
      return function (sel) {
        if (sel === "#show-release-table") {
          return { attr: function (n) { return n === "sid" ? (sid || undefined) : undefined; } };
        }
        if (sel === "title") {
          return { text: function () { return title; } };
        }
        return { attr: function () { return undefined; }, text: function () { return ""; } };
      };
    }
  };
}

function loadSrc(fakeFetch) {
  const src = fs.readFileSync(path.join(__dirname, "subsplease.js"), "utf8");
  const ctx = {
    fetch: fakeFetch,
    cheerio: makeCheerio(),
    TMDB_API_KEY: "test-key",
    console: { error: function () {}, log: function () {}, warn: function () {} },
    module: { exports: {} },
    Promise: Promise,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
    isNaN: isNaN,
    parseInt: parseInt,
    Math: Math,
    JSON: JSON,
    String: String,
    Array: Array,
    Object: Object
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

// A 40-char hex infohash so the stream would be surfaced if returned.
const SEIIN_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SEIIN_SHOW = "2.43 - Seiin Koukou Danshi Volley-bu";
const SEIIN_PAGE =
  '<html><head><title>' + SEIIN_SHOW + ' downloads - SubsPlease</title></head>' +
  '<body><table id="show-release-table" sid="999"></table></body></html>';

// Apothecary Diaries: TMDB has it as one 60-episode season, but the app splits
// it AniList-style (24 / 24 / 12). S3E2 must map to the absolute episode 50.
const APOTHECARY_HASH = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const APOTHECARY_SLUG = "kusuriya-no-hitorigoto";
const APOTHECARY_SHOW = "Kusuriya no Hitorigoto";
const APOTHECARY_PAGE =
  '<html><head><title>' + APOTHECARY_SHOW + ' downloads - SubsPlease</title></head>' +
  '<body><table id="show-release-table" sid="671"></table></body></html>';

// Apothecary Diaries S3: the pre-fix degenerate "-3" season slug resolved to a
// completely unrelated show, which must never be surfaced.
const WRONG3_HASH = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const WRONG3_SHOW = "30-sai made Doutei dato Mahoutsukai ni Nareru Rashii";
const WRONG3_PAGE =
  '<html><head><title>' + WRONG3_SHOW + ' downloads - SubsPlease</title></head>' +
  '<body><table id="show-release-table" sid="998"></table></body></html>';

// The "f=latest" feed (recently airing shows). The search endpoint is sometimes
// empty for every term, so the plugin falls back to this feed for a page slug.
const YURU_SLUG = "yuru-camp";
const YURU_SHOW = "Yuru Camp";

function aniMedia(id, episodes, sequelId, sequelEpisodes) {
  var edges = [];
  if (sequelId) {
    edges.push({ relationType: "SEQUEL", node: { id: sequelId, episodes: sequelEpisodes, format: "TV" } });
  }
  return {
    id: id,
    episodes: episodes,
    format: "TV",
    title: { romaji: "Kusuriya no Hitorigoto", english: "The Apothecary Diaries" },
    relations: { edges: edges }
  };
}

const ANILIST_BY_ID = {
  161645: aniMedia(161645, 24, 176301, 24),
  176301: aniMedia(176301, 24, 195516, 12),
  195516: aniMedia(195516, 12, null, 0)
};

function fakeFetch(url, opts) {
  // TMDB show metadata: English name + non-ASCII original (Black Clover).
  if (url.indexOf("api.themoviedb.org/3/tv/") !== -1 && url.indexOf("/translations") === -1) {
    if (url.indexOf("/220542") !== -1) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({
          name: "The Apothecary Diaries",
          original_name: "\u85AC\u5C4B\u306E\u3072\u3068\u308A\u3054\u3068",
          seasons: [{ season_number: 0, episode_count: 51 }, { season_number: 1, episode_count: 60 }]
        }),
        text: () => Promise.resolve("")
      });
    }
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({
        name: "Black Clover",
        original_name: "\u30D6\u30E9\u30C3\u30AF\u30AF\u30ED\u30FC\u30D0\u30FC",
        seasons: [{ season_number: 1, episode_count: 170 }, { season_number: 2, episode_count: 10 }]
      }),
      text: () => Promise.resolve("")
    });
  }
  if (url.indexOf("/translations") !== -1) {
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ translations: [] }), text: () => Promise.resolve("") });
  }
  if (url.indexOf("graphql.anilist.co") !== -1) {
    var reqBody = {};
    try { reqBody = JSON.parse((opts && opts.body) || "{}"); } catch (e) {}
    var vars = reqBody.variables || {};
    var media = null;
    if (vars.id) {
      media = ANILIST_BY_ID[vars.id] || null;
    } else if (vars.search === "The Apothecary Diaries" || vars.search === "Kusuriya no Hitorigoto") {
      media = ANILIST_BY_ID[161645];
    }
    // Deep-clone: the plugin normalizes relations in place; a real fetch always
    // returns a fresh object, so the shared fixture must not leak mutations.
    if (media) media = JSON.parse(JSON.stringify(media));
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ data: { Media: media } }), text: () => Promise.resolve("") });
  }
  // SubsPlease show page: the "-2" slug resolves to a real, unrelated show.
  if (url.indexOf("subsplease.org/shows/") !== -1) {
    var slug = url.replace(/.*\/shows\//, "").replace(/\/.*$/, "");
    if (slug === "-2") {
      return Promise.resolve({ status: 200, text: () => Promise.resolve(SEIIN_PAGE) });
    }
    if (slug === "-3") {
      return Promise.resolve({ status: 200, text: () => Promise.resolve(WRONG3_PAGE) });
    }
    if (slug === APOTHECARY_SLUG) {
      return Promise.resolve({ status: 200, text: () => Promise.resolve(APOTHECARY_PAGE) });
    }
    return Promise.resolve({ status: 200, text: () => Promise.resolve("404 Not Found") });
  }
  // SubsPlease show API for sid 999 -> Seiin episode 02.
  if (url.indexOf("subsplease.org/api/") !== -1) {
    // Latest feed (same shape as search): the empty-search fallback source.
    if (url.indexOf("f=latest") !== -1) {
      var latestBody = {};
      latestBody[YURU_SHOW + " - 05"] = { show: YURU_SHOW, episode: "05", page: YURU_SLUG };
      return Promise.resolve({ status: 200, json: () => Promise.resolve(latestBody), text: () => Promise.resolve("") });
    }
    // Search API -> canonical slug, keyed "<Show> - <ep>".
    if (url.indexOf("f=search") !== -1) {
      if (url.indexOf("Kusuriya") !== -1) {
        var searchBody = {};
        searchBody[APOTHECARY_SHOW + " - 50"] = { show: APOTHECARY_SHOW, episode: "50", page: APOTHECARY_SLUG };
        return Promise.resolve({ status: 200, json: () => Promise.resolve(searchBody), text: () => Promise.resolve("") });
      }
      // Substring hit on an unrelated show: must be filtered by nameMatchesShow.
      if (url.indexOf("Black") !== -1) {
        var blBody = {};
        blBody[SEIIN_SHOW + " - 02"] = { show: SEIIN_SHOW, episode: "02", page: "seiin-koukou-danshi-volley-bu" };
        return Promise.resolve({ status: 200, json: () => Promise.resolve(blBody), text: () => Promise.resolve("") });
      }
      // English-only titles miss: subsplease answers with an empty array.
      return Promise.resolve({ status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve("") });
    }
    if (url.indexOf("sid=671") !== -1) {
      var apoBody = { episode: {} };
      apoBody.episode[APOTHECARY_SHOW + " - 50"] = {
        show: APOTHECARY_SHOW,
        episode: "50",
        downloads: [{ res: "1080", magnet: "magnet:?xt=urn:btih:" + APOTHECARY_HASH }]
      };
      return Promise.resolve({ status: 200, json: () => Promise.resolve(apoBody), text: () => Promise.resolve("") });
    }
    if (url.indexOf("sid=998") !== -1) {
      var w3Body = { episode: {} };
      w3Body.episode[WRONG3_SHOW + " - 02"] = {
        show: WRONG3_SHOW,
        episode: "02",
        downloads: [{ res: "1080", magnet: "magnet:?xt=urn:btih:" + WRONG3_HASH }]
      };
      return Promise.resolve({ status: 200, json: () => Promise.resolve(w3Body), text: () => Promise.resolve("") });
    }
    var body = { episode: {} };
    body.episode[SEIIN_SHOW + " - 02"] = {
      show: SEIIN_SHOW,
      episode: "02",
      downloads: [{ res: "1080", magnet: "magnet:?xt=urn:btih:" + SEIIN_HASH }]
    };
    return Promise.resolve({ status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") });
  }
  return Promise.resolve({ status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
}

async function main() {
  const ctx = loadSrc(fakeFetch);

  // ---- unit: generateSlugs never yields a degenerate slug ----
  const cloverSlugs = ctx.generateSlugs("Black Clover");
  assert("generateSlugs('Black Clover') includes 'black-clover'", cloverSlugs.indexOf("black-clover") !== -1);
  assert("generateSlugs('Black Clover') has no empty entry", cloverSlugs.indexOf("") === -1);

  const jpSlugs = ctx.generateSlugs("\u30D6\u30E9\u30C3\u30AF\u30AF\u30ED\u30FC\u30D0\u30FC");
  assert("generateSlugs(non-ASCII) drops the empty slug", jpSlugs.indexOf("") === -1);
  assert("generateSlugs(non-ASCII) yields no slugs at all", jpSlugs.length === 0);

  const parenSlugs = ctx.generateSlugs("(Kusuriya no Hitorigoto)");
  assert("generateSlugs('(...)') has no empty entry", parenSlugs.indexOf("") === -1);

  // ---- unit: isUsableSlug ----
  assert("isUsableSlug('') is false", ctx.isUsableSlug("") === false);
  assert("isUsableSlug('a') is false", ctx.isUsableSlug("a") === false);
  assert("isUsableSlug('black-clover') is true", ctx.isUsableSlug("black-clover") === true);

  // ---- unit: nameMatchesShow ----
  assert("nameMatchesShow rejects unrelated show",
    ctx.nameMatchesShow(SEIIN_SHOW, ["Black Clover", "\u30D6\u30E9\u30C3\u30AF\u30AF\u30ED\u30FC\u30D0\u30FC"]) === false);
  assert("nameMatchesShow accepts exact title",
    ctx.nameMatchesShow("Black Clover", ["Black Clover"]) === true);
  assert("nameMatchesShow accepts token overlap",
    ctx.nameMatchesShow("Kusuriya no Hitorigoto", ["The Apothecary Diaries", "Kusuriya no Hitorigoto"]) === true);
  assert("nameMatchesShow passes through with no titles",
    ctx.nameMatchesShow(SEIIN_SHOW, []) === true);

  // ---- unit: getAniListAbsoluteEp (sequel-chain absolute numbering) ----
  const apoTitles = ["The Apothecary Diaries", "\u85AC\u5C4B\u306E\u3072\u3068\u308A\u3054\u3068", "Kusuriya no Hitorigoto"];
  assert("getAniListAbsoluteEp S1E2 = 2", (await ctx.getAniListAbsoluteEp(apoTitles, 1, 2)) === 2);
  assert("getAniListAbsoluteEp S2E2 = 26", (await ctx.getAniListAbsoluteEp(apoTitles, 2, 2)) === 26);
  assert("getAniListAbsoluteEp S3E2 = 50", (await ctx.getAniListAbsoluteEp(apoTitles, 3, 2)) === 50);
  assert("getAniListAbsoluteEp unknown title = null",
    (await ctx.getAniListAbsoluteEp(["Some Live Action Show"], 2, 1)) === null);

  // ---- unit: resolveSlugViaSearch (canonical slug from the search API) ----
  const searchHit = await ctx.resolveSlugViaSearch(["Kusuriya no Hitorigoto"]);
  assert("resolveSlugViaSearch returns the canonical slug", searchHit.indexOf(APOTHECARY_SLUG) !== -1);
  const searchFiltered = await ctx.resolveSlugViaSearch(["Black Clover"]);
  assert("resolveSlugViaSearch filters unrelated substring hits", searchFiltered.length === 0);
  const searchMiss = await ctx.resolveSlugViaSearch(["Nonexistent English Title"]);
  assert("resolveSlugViaSearch returns [] on English miss", searchMiss.length === 0);
  const latestFallback = await ctx.resolveSlugViaSearch(["Yuru Camp"]);
  assert("resolveSlugViaSearch falls back to the latest feed", latestFallback.indexOf(YURU_SLUG) !== -1);

  // ---- integration: S2E2 must not return the "-2" wrong show ----
  const streams = await ctx.getStreams("71499", "tv", 2, 2);
  assert("getStreams('Black Clover' S2E2) returns no wrong-show streams", streams.length === 0);
  assert("getStreams never returns the Seiin show", streams.every(function (s) { return s.name.indexOf("Seiin") === -1; }));

  // ---- integration: Apothecary S3E2 resolves via AniList absolute ep 50 ----
  const apoStreams = await ctx.getStreams("220542", "tv", 3, 2);
  assert("getStreams('The Apothecary Diaries' S3E2) returns a stream", apoStreams.length > 0);
  assert("getStreams('The Apothecary Diaries' S3E2) resolves to absolute ep 50",
    apoStreams.length > 0 && apoStreams[0].name === APOTHECARY_SHOW + " - 50");
  assert("getStreams('The Apothecary Diaries' S3E2) never returns the degenerate-s3 show",
    apoStreams.every(function (s) { return s.name.indexOf(WRONG3_SHOW) === -1; }));

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
