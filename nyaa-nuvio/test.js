// Consolidated test suite for nyaa-nuvio/nyaa.js
// Run offline (unit + mocked integration):  node nyaa-nuvio/test.js
// Run with live Nyaa checks too:           LIVE=1 node nyaa-nuvio/test.js
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "nyaa.js"), "utf8");

function loadSrc(fetchImpl) {
  const ctx = {
    console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    String, parseInt, isNaN, Math, Promise, RegExp, Object, Array, Error, JSON,
    fetch: fetchImpl, module: { exports: {} }, global: {}
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

let failures = 0;
function assert(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

// ---------------------------------------------------------------- OFFLINE
function runOffline() {
  const SUBSPLEASE_RSS = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item>
<title>[SubsPlease] Super no Ura de Yani Suu Futari - 08 (1080p)</title>
<link>https://nyaa.si/download/AAA</link>
<guid isPermaLink="false">https://nyaa.si/view/1</guid>
<nyaa:infoHash>AAA11111111111111111111111111111111111111</nyaa:infoHash>
<nyaa:seeders>75</nyaa:seeders>
<nyaa:leechers>10</nyaa:leechers>
<nyaa:size>900.0 MiB</nyaa:size>
<nyaa:categoryId>1_2</nyaa:categoryId>
<nyaa:trusted>No</nyaa:trusted>
</item></channel></rss>`;

  const ENGLISH_RSS = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item>
<title>Smoking Behind the Supermarket with You S01E08 1080p WEB-DL</title>
<link>https://nyaa.si/download/BBB</link>
<guid isPermaLink="false">https://nyaa.si/view/2</guid>
<nyaa:infoHash>BBB22222222222222222222222222222222222222</nyaa:infoHash>
<nyaa:seeders>120</nyaa:seeders>
<nyaa:leechers>5</nyaa:leechers>
<nyaa:size>1.1 GiB</nyaa:size>
<nyaa:categoryId>1_2</nyaa:categoryId>
<nyaa:trusted>No</nyaa:trusted>
</item></channel></rss>`;

  function fakeFetch(url) {
    let body;
    if (url.indexOf("api.themoviedb.org/3/tv/") !== -1 && url.indexOf("/translations") === -1 && url.indexOf("/alternative_titles") === -1) {
      body = { name: "Smoking Behind the Supermarket with You", original_name: "Super no Ura de Yani Suu Futari" };
    } else if (url.indexOf("/translations") !== -1) {
      body = { translations: [] };
    } else if (url.indexOf("/alternative_titles") !== -1) {
      body = { results: [] };
    } else if (url.indexOf("nyaa.si") !== -1) {
      if (url.indexOf("Super%20no%20Ura") !== -1) {
        return Promise.resolve({ status: 200, text: () => Promise.resolve(SUBSPLEASE_RSS) });
      }
      return Promise.resolve({ status: 200, text: () => Promise.resolve(ENGLISH_RSS) });
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") });
  }

  const ctx = loadSrc(fakeFetch);

  // ---- unit: buildQueries ----
  const q = ctx.buildQueries("Super no Ura de Yani Suu Futari", 1, 8);
  assert("buildQueries has 'Title 8' (absolute) form", q.indexOf("Super no Ura de Yani Suu Futari 8") !== -1);
  assert("buildQueries has S01E08 form", q.indexOf("Super no Ura de Yani Suu Futari S01E08") !== -1);
  assert("buildQueries has bare title", q.indexOf("Super no Ura de Yani Suu Futari") !== -1);

  // ---- unit: matchEpisode ----
  assert("match SubsPlease '- 08'", ctx.matchEpisode("Super no Ura de Yani Suu Futari - 08 (1080p)", 1, 8) === true);
  assert("match SubsPlease '- 08' (no S token)", ctx.matchEpisode("Super no Ura de Yani Suu Futari - 08", 1, 8) === true);
  assert("reject wrong ep", ctx.matchEpisode("Super no Ura de Yani Suu Futari - 09 (1080p)", 1, 8) === false);
  assert("match TV S01E08", ctx.matchEpisode("[SubsPlease] Show - S01E08 (1080p)", 1, 8) === true);

  // ---- exception cases (wrong-series batch + season-2 absolute) ----
  assert("reject sequel BATCH false-positive", ctx.matchEpisode("[Erai-raws] Code Geass: Dakkan no Roze - 01 ~ 12 [1080p][BATCH][MultiSub]", 1, 1) === false);
  assert("reject generic season pack for single ep", ctx.matchEpisode("Show - Season 1 Pack [1080p]", 1, 8) === false);
  assert("match S2 absolute 'Show S2 - 08'", ctx.matchEpisode("[SubsPlease] Show S2 - 08 (1080p)", 2, 8) === true);
  assert("match S1 absolute '- 08' still works", ctx.matchEpisode("Show - 08 (1080p)", 1, 8) === true);
  assert("reject S2 dash when season mismatch", ctx.matchEpisode("Show S1 - 08 (1080p)", 2, 8) === false);

  // ---- unit: parseRssItems + parseSize ----
  const items = ctx.parseRssItems(SUBSPLEASE_RSS);
  assert("parseRssItems 1 item", items.length === 1);
  assert("infoHash parsed", items[0].infoHash === "AAA11111111111111111111111111111111111111");
  assert("seeders parsed", items[0].seeders === 75);
  assert("size parsed to bytes", items[0].size === Math.round(1.2 * 1024 * 1024 * 1024) || items[0].size === Math.round(900 * 1024 * 1024));
  assert("padZero", ctx.padZero(8, 2) === "08" && ctx.padZero(1, 2) === "01");

  // ---- integration (mocked fetch): SubsPlease + English both returned ----
  return ctx.getStreams("122991", "tv", 1, 8).then(function (res) {
    console.log("  integration results:", res.length);
    const hasSubs = res.some(r => /SubsPlease/.test(r.title));
    const hasEng = res.some(r => /Smoking Behind/.test(r.title));
    assert("integration returns SubsPlease", hasSubs);
    assert("integration returns English-dub", hasEng);
  });
}

// ---------------------------------------------------------------- LIVE
function pickEpisode(title) {
  let m = title.match(/S(\d+)\s*E(\d+)/i) || title.match(/(\d+)x(\d+)/i);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
  m = title.match(/-\s*(\d{1,3})\b(?!\s*[pP])/i) || title.match(/\[(\d{1,3})\]\s*$/i);
  if (m) return { s: 1, e: parseInt(m[1], 10) };
  return null;
}

function runLive() {
  const ctx = loadSrc((...a) => fetch(...a));
  const OLD = [
    { title: "Steins;Gate", s: 1, e: 1 },
    { title: "Cowboy Bebop", s: 1, e: 1 },
    { title: "Bakemonogatari", s: 1, e: 1 },
    { title: "Fullmetal Alchemist Brotherhood", s: 1, e: 5 },
    { title: "Clannad", s: 1, e: 3 },
    { title: "Code Geass", s: 1, e: 1 },
    { title: "Neon Genesis Evangelion", s: 1, e: 1 }
  ];

  return (async () => {
    // random live title
    const xml = await (await fetch("https://nyaa.si/?page=rss&c=1_2&s=seeders&o=desc&limit=50&f=0")).text();
    const ritems = ctx.parseRssItems(xml).filter(it => pickEpisode(it.title));
    if (ritems.length) {
      const pick = ritems[Math.floor(Math.random() * ritems.length)];
      const { s, e } = pickEpisode(pick.title);
      const res = await pipeline(ctx, pick.title, s, e);
      assert("live random '" + pick.title.slice(0, 30) + "...' finds torrent", res.length > 0);
    } else {
      console.log("SKIP live random (no parseable episode in sample)");
    }

    // old/seeded releases
    for (const t of OLD) {
      const res = await pipeline(ctx, t.title, t.s, t.e);
      assert("live old '" + t.title + " S" + t.s + "E" + t.e + "' matched=" + res.length, res.length > 0);
    }
  })();
}

async function pipeline(ctx, title, s, e) {
  const queries = ctx.buildQueries(title, s, e);
  const seen = {};
  const results = [];
  for (const q of queries) {
    let rss = await ctx.searchNyaa(q, ctx.NYAA_CATEGORIES.ENGLISH);
    if (!rss || rss.length === 0) rss = await ctx.searchNyaa(q, ctx.NYAA_CATEGORIES.ALL);
    if (!rss) continue;
    for (const item of rss) {
      if (seen[item.infoHash]) continue;
      if (!ctx.matchEpisode(item.title, s, e)) continue;
      seen[item.infoHash] = true;
      results.push(item);
    }
  }
  return results;
}

// ---------------------------------------------------------------- RUN
runOffline()
  .then(() => process.env.LIVE ? runLive() : Promise.resolve())
  .then(() => {
    console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURE(S)"));
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(e => { console.error("ERR", e); process.exit(1); });
