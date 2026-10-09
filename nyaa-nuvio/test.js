// Regression tests for the Nyaa plugin's AniList-based absolute-episode fix.
//
// Context: anime seasons are split differently by the app's metadata source
// (AniList: Kusuriya no Hitorigoto = 24 / 24 / 12) than by TMDB (one long
// season), while SubsPlease-style Nyaa releases are numbered absolutely across
// the franchise. "The Apothecary Diaries" S3E2 must therefore search for and
// match the absolute episode 50 release ("[SubsPlease] Kusuriya no Hitorigoto
// - 50"), not "S03E02".
//
// The plugin is loaded in a vm with a stub fetch so the whole path is
// reproduced deterministically and offline.

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

function loadSrc(fakeFetch) {
  const src = fs.readFileSync(path.join(__dirname, "nyaa.js"), "utf8");
  const ctx = {
    fetch: fakeFetch,
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

const RELEASE_HASH = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const RELEASE_TITLE = "[SubsPlease] Kusuriya no Hitorigoto - 50 (1080p) [ABCDEF].mkv";

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

const RSS =
  '<rss><channel><item>' +
  '<title>' + RELEASE_TITLE + '</title>' +
  '<link>https://nyaa.si/view/1</link>' +
  '<guid>1</guid>' +
  '<nyaa:infoHash>' + RELEASE_HASH + '</nyaa:infoHash>' +
  '<nyaa:seeders>100</nyaa:seeders>' +
  '<nyaa:leechers>1</nyaa:leechers>' +
  '<nyaa:size>1.4 GiB</nyaa:size>' +
  '<nyaa:categoryId>1_2</nyaa:categoryId>' +
  '<nyaa:trusted>Yes</nyaa:trusted>' +
  '</item></channel></rss>';

function fakeFetch(url, opts) {
  if (url.indexOf("api.themoviedb.org/3/tv/220542/alternative_titles") !== -1) {
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ results: [] }), text: () => Promise.resolve("") });
  }
  if (url.indexOf("api.themoviedb.org/3/tv/220542/translations") !== -1) {
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ translations: [] }), text: () => Promise.resolve("") });
  }
  if (url.indexOf("api.themoviedb.org/3/tv/220542") !== -1) {
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({
        name: "The Apothecary Diaries",
        original_name: "\u85AC\u5C4B\u306E\u3072\u3068\u308A\u3054\u3068"
      }),
      text: () => Promise.resolve("")
    });
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
    if (media) media = JSON.parse(JSON.stringify(media));
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ data: { Media: media } }), text: () => Promise.resolve("") });
  }
  if (url.indexOf("nyaa.si") !== -1) {
    // Only the romaji title ("Kusuriya no Hitorigoto") finds the release.
    if (url.indexOf("Kusuriya") !== -1) {
      return Promise.resolve({ status: 200, text: () => Promise.resolve(RSS) });
    }
    return Promise.resolve({ status: 200, text: () => Promise.resolve("") });
  }
  return Promise.resolve({ status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
}

async function main() {
  const ctx = loadSrc(fakeFetch);

  // ---- unit: getAniListAbsoluteEp ----
  const apoTitles = ["The Apothecary Diaries", "\u85AC\u5C4B\u306E\u3072\u3068\u308A\u3054\u3068", "Kusuriya no Hitorigoto"];
  assert("getAniListAbsoluteEp S1E2 = 2", (await ctx.getAniListAbsoluteEp(apoTitles, 1, 2)) === 2);
  assert("getAniListAbsoluteEp S2E2 = 26", (await ctx.getAniListAbsoluteEp(apoTitles, 2, 2)) === 26);
  assert("getAniListAbsoluteEp S3E2 = 50", (await ctx.getAniListAbsoluteEp(apoTitles, 3, 2)) === 50);
  assert("getAniListAbsoluteEp unknown title = null",
    (await ctx.getAniListAbsoluteEp(["Some Live Action Show"], 2, 1)) === null);

  // ---- unit: matchEpisode accepts the absolute (unseasoned) release ----
  assert("matchEpisode matches absolute release - 50",
    ctx.matchEpisode(RELEASE_TITLE, 1, 50) === true);
  assert("matchEpisode rejects a different episode",
    ctx.matchEpisode(RELEASE_TITLE, 1, 49) === false);

  // ---- unit: buildQueries includes the absolute-episode query ----
  const q = ctx.buildQueries("Kusuriya no Hitorigoto", 3, 50);
  assert("buildQueries includes '<title> 50'", q.indexOf("Kusuriya no Hitorigoto 50") !== -1);
  assert("buildQueries includes season query", q.indexOf("Kusuriya no Hitorigoto S03") !== -1);

  // ---- integration: Apothecary S3E2 resolves to the absolute ep 50 release ----
  const streams = await ctx.getStreams("220542", "tv", 3, 2);
  assert("getStreams('The Apothecary Diaries' S3E2) returns a stream", streams.length > 0);
  assert("getStreams('The Apothecary Diaries' S3E2) returns the ep 50 release",
    streams.length > 0 && streams[0].title.indexOf(" - 50 ") !== -1);

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
