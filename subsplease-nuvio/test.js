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
    if (slug === APOTHECARY_SLUG) {
      return Promise.resolve({ status: 200, text: () => Promise.resolve(APOTHECARY_PAGE) });
    }
    return Promise.resolve({ status: 200, text: () => Promise.resolve("404 Not Found") });
  }
  // SubsPlease show API for sid 999 -> Seiin episode 02.
  if (url.indexOf("subsplease.org/api/") !== -1) {
    if (url.indexOf("sid=671") !== -1) {
      var apoBody = { episode: {} };
      apoBody.episode[APOTHECARY_SHOW + " - 50"] = {
        show: APOTHECARY_SHOW,
        episode: "50",
        downloads: [{ res: "1080", magnet: "magnet:?xt=urn:btih:" + APOTHECARY_HASH }]
      };
      return Promise.resolve({ status: 200, json: () => Promise.resolve(apoBody), text: () => Promise.resolve("") });
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

  // ---- integration: S2E2 must not return the "-2" wrong show ----
  const streams = await ctx.getStreams("71499", "tv", 2, 2);
  assert("getStreams('Black Clover' S2E2) returns no wrong-show streams", streams.length === 0);
  assert("getStreams never returns the Seiin show", streams.every(function (s) { return s.name.indexOf("Seiin") === -1; }));

  // ---- integration: Apothecary S3E2 resolves via AniList absolute ep 50 ----
  const apoStreams = await ctx.getStreams("220542", "tv", 3, 2);
  assert("getStreams('The Apothecary Diaries' S3E2) returns a stream", apoStreams.length > 0);
  assert("getStreams('The Apothecary Diaries' S3E2) resolves to absolute ep 50",
    apoStreams.length > 0 && apoStreams[0].name === APOTHECARY_SHOW + " - 50");

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
