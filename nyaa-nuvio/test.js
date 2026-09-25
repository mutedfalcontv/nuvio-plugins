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

  // ---- anti-false-positive: season spelled out must not match a different season ----
  assert("reject 'Season 2 - 08' for S1E8 (spelled-out season)", ctx.matchEpisode("Solo Leveling Season 2 -Arise from the Shadow- - 08 [1080p]", 1, 8) === false);
  assert("reject 'S2 - 08' for S1E8 even when abs=8", ctx.matchEpisode("[Raze] Solo Leveling S2 - 08 x265 1080p", 1, 8, 8) === false);
  assert("accept cross-season absolute '- 25' for S2E13 (abs=25)", ctx.matchEpisode("[SubsPlease] Solo Leveling - 25 (1080p)", 2, 13, 25) === true);
  assert("reject cross-season absolute '- 25' when no abs known", ctx.matchEpisode("[SubsPlease] Solo Leveling - 25 (1080p)", 2, 13, null) === false);
  assert("mid-chain bracket ep [08] matches S1E8", ctx.matchEpisode("[北宇治字幕组] 再见，菈菈 / Sayonara Lara [08][WebRip][HEVC_AAC][简日内嵌]", 1, 8, null) === true);
  assert("mid-chain bracket ep [08] rejects wrong ep", ctx.matchEpisode("[北宇治字幕组] 再见，菈菈 / Sayonara Lara [08][WebRip][HEVC_AAC][简日内嵌]", 1, 9, null) === false);
  assert("mid-chain [05][1080p] keeps ep 5", ctx.matchEpisode("Show [05][1080p][HEVC] release", 1, 5, null) === true);
  assert("H.264 trailer must not fake S1E264", ctx.matchEpisode("[ToonsHub] Grand Blue Dreaming S03E09 1080p AMZN WEB-DL DDP2.0 H.264 (Multi-Subs)", 1, 264, null) === false);
  assert("H.264 trailer still matches real S3E09", ctx.matchEpisode("[ToonsHub] Grand Blue Dreaming S03E09 1080p AMZN WEB-DL DDP2.0 H.264 (Multi-Subs)", 3, 9, null) === true);
  assert("EP239 absolute binds to S1 only", ctx.matchEpisode("[Shridhuu][1080p] Swallowed Star - Tunshi Xingkong - EP239", 1, 239, null) === true);
  assert("EP239 must not match S2E239", ctx.matchEpisode("[Shridhuu][1080p] Swallowed Star - Tunshi Xingkong - EP239", 2, 239, null) === false);


  // ---- unit: parseRssItems + parseSize ----
  const items = ctx.parseRssItems(SUBSPLEASE_RSS);
  assert("parseRssItems 1 item", items.length === 1);
  assert("infoHash parsed", items[0].infoHash === "AAA11111111111111111111111111111111111111");
  assert("seeders parsed", items[0].seeders === 75);
  assert("size parsed to bytes", items[0].size === Math.round(1.2 * 1024 * 1024 * 1024) || items[0].size === Math.round(900 * 1024 * 1024));
  assert("padZero", ctx.padZero(8, 2) === "08" && ctx.padZero(1, 2) === "01");

  // ---- Part C: hardened matcher branches ----
  assert("4-digit absolute dash form",
    ctx.matchEpisode("[Anime Time] One Piece - 1122 (1080p) [ABCD1234].mkv", 1, 1122, null) === true);
  assert("4-digit dash form, no parens",
    ctx.matchEpisode("[Animechap] One Piece - 1123 [1080p][HEVC AAC][x265]", 1, 1123, null) === true);
  assert("v2 revision suffix",
    ctx.matchEpisode("[SubsPlease] Show - 09v2 (1080p)", 1, 9, null) === true);
  assert("v3 revision suffix",
    ctx.matchEpisode("[Anime Time] Show - 12v3 (1080p)", 1, 12, null) === true);
  assert("parenthesised Season N",
    ctx.matchEpisode("[Judas] Show (Season 2) - 13 [1080p][HEVC x265 10bit][Multi-Subs]", 2, 13, null) === true);
  assert("spaced S2 - E08 form",
    ctx.matchEpisode("[EngSub] Show S2 - E08 (1080p)", 2, 8, null) === true);

  // Guards. Each of these is a way the widened branches could go wrong.
  // The three resolution/year guards below are spelled as BARE numbers after a
  // dash, which is the only form looksLikeMetadata ever sees: cleanTorrentTitle
  // strips "2160p", "x265" and "(2024)" before any guard runs, so the decorated
  // spellings of these same cases tested cleanTorrentTitle, not the guard (and
  // passed with the guard stubbed out entirely). The decorated spellings are
  // still covered as corpus cases 34-36 and 43-47.
  assert("guard: bare 2160 is not an episode",
    ctx.matchEpisode("[Group] Show - 2160 (1080p)", 1, 2160, null) === false);
  assert("guard: bare 1080 is not an episode",
    ctx.matchEpisode("[Group] Show - 1080 (1080p)", 1, 1080, null) === false);
  assert("guard: year after the dash is not an episode",
    ctx.matchEpisode("[Group] Show - 2024 (1080p)", 1, 2024, null) === false);
  assert("guard: v2 suffix does not shift the episode",
    ctx.matchEpisode("[SubsPlease] Show - 09v2 (1080p)", 1, 8, null) === false);
  assert("guard: v2 suffix does not concatenate to 80",
    ctx.matchEpisode("[Doki] Show - 08v2 (1080p) [HEVC-10bit]", 1, 80, null) === false);
  assert("guard: parenthesised season still blocks S1",
    ctx.matchEpisode("[Judas] Show (Season 2) - 13 [1080p]", 1, 13, null) === false);
  assert("guard: spaced S2 - E08 does not match S1 or S3",
    ctx.matchEpisode("[EngSub] Show S2 - E08 (1080p)", 1, 8, null) === false &&
    ctx.matchEpisode("[EngSub] Show S2 - E08 (1080p)", 3, 8, null) === false);
  assert("guard: batch still rejected after widening",
    ctx.matchEpisode("[Erai-raws] Show - 01 ~ 12 [1080p][BATCH][Multi-Subs]", 2, 5, null) === false);
  assert("guard: raw bracket chain honours the title's season",
    ctx.matchEpisode("[Group] Show S2 [08][WebRip][HEVC_AAC]", 1, 8, null) === false);

  // ---- Part A1: anime tracker set and MAX_TRACKERS cap ----
  // The anime trackers must survive any amount of cap pressure from the live
  // list, so each one is asserted individually by assertAllAnime.
  const ANIME = [
    "http://nyaa.tracker.wf:7777/announce",
    "http://anidex.moe:6969/announce",
    "http://tracker.anirena.com:80/announce",
    "udp://tracker.uw0.xyz:6969/announce"
  ];
  // Names the tracker that vanished in the failure line - which of the four is
  // missing is the only thing a reader needs when this fails.
  function assertAllAnime(name, list) {
    for (var ai = 0; ai < ANIME.length; ai++) {
      if (list.indexOf(ANIME[ai]) === -1) return assert(name + " [" + ANIME[ai] + " missing]", false);
    }
    return assert(name, true);
  }

  const merged = ctx.mergeTrackers([]);
  assertAllAnime("mergeTrackers includes all 4 anime trackers", merged);
  assert("mergeTrackers keeps legacy generic trackers", merged.indexOf("udp://tracker.opentrackr.org:1337/announce") !== -1);
  assert("mergeTrackers default length is 14", merged.length === 14);
  assert("mergeTrackers anime block leads the list",
    merged[0] === ANIME[0] && merged[1] === ANIME[1] && merged[2] === ANIME[2] && merged[3] === ANIME[3]);

  // Live list under the cap: it slots in after the anime block, generic fills the rest.
  const twoBest = ["udp://tracker.one.example:6969/announce", "udp://tracker.two.example:451/announce"];
  const underCap = ctx.mergeTrackers(twoBest);
  assert("mergeTrackers keeps the anime head in place under a short live list", underCap[0] === ANIME[0]);
  assert("mergeTrackers live entries follow the anime block", underCap[4] === twoBest[0]);
  assert("mergeTrackers total is 14 + 2 live", underCap.length === 16);

  // Over the cap: the anime set must survive, and the tail is what gets cut.
  const many = [];
  for (let mi = 0; mi < 40; mi++) many.push("udp://best" + mi + ".example:6969/announce");
  const capped = ctx.mergeTrackers(many);
  assert("mergeTrackers caps at 25", capped.length === 25);
  assertAllAnime("mergeTrackers never evicts anime trackers under cap pressure", capped);
  assert("mergeTrackers anime block comes first", capped[0] === ANIME[0]);
  assert("mergeTrackers cuts the generic tail, not the anime set",
    capped.indexOf("udp://tracker.opentrackr.org:1337/announce") === -1);

  // A live list that repeats an anime tracker must not cost a slot or an entry.
  const dupes = ctx.mergeTrackers(ANIME.concat(ANIME).concat(["udp://best.example:6969/announce"]));
  assert("mergeTrackers dedupes live anime repeats", dupes.length === 15);
  assertAllAnime("mergeTrackers dedupes live anime repeats", dupes);
  assert("mergeTrackers live entries follow the anime block after dedup",
    dupes[4] === "udp://best.example:6969/announce");

  // The live budget is counted in accepted entries, not loop iterations, so a
  // rejected line inside the first 21 must cost the generic tail a slot rather
  // than a live one. Every earlier cap test uses a fully distinct live list,
  // where the two bound semantics are provably identical and the difference is
  // invisible - this is the case that tells them apart. Room is 21 (25 - 4).
  const wasted = [ANIME[0]];
  for (let wi = 0; wi < 30; wi++) wasted.push("udp://w" + wi + ".example:6969/announce");
  const tight = ctx.mergeTrackers(wasted);
  assert("mergeTrackers spends rejected live slots on the generic tail, not the live list",
    tight.filter(function (t) { return t.indexOf("udp://w") === 0; }).length === 21);

  const magnet = ctx.buildMagnet("AAA11111111111111111111111111111111111111", "Some Title");
  assert("buildMagnet keeps the announce prefix and hash verbatim",
    magnet.indexOf("magnet:?xt=urn:btih:AAA11111111111111111111111111111111111111&dn=") === 0);
  // Pins the dn encoding itself, not just the prefix up to "&dn=". Dropping
  // encodeURIComponent here leaves every other assertion green.
  assert("buildMagnet percent-encodes the display name",
    magnet.indexOf("&dn=Some%20Title&tr=") !== -1);
  assert("buildMagnet embeds anime tracker", magnet.indexOf(encodeURIComponent(ANIME[0])) !== -1);
  const trCount = magnet.split("&tr=").length - 1;
  // Static-only build: 4 anime + 10 generic, exactly. Not a range - a loose
  // bound would survive losing a generic tracker.
  assert("buildMagnet emits all 14 static trackers, uncapped", trCount === 14);
  assert("buildMagnet has no duplicate tracker params", (function () {
    const trs = magnet.split("&tr=").slice(1);
    for (let t = 0; t < trs.length; t++) if (trs.indexOf(trs[t]) !== t) return false;
    return true;
  })());

  // ---- Part A2: labels ----
  const tags = ctx.detectAudioTags("[DKB] Some Show - 14 (Dual Audio, Multi-Subs) [1080p]");
  assert("detectAudioTags finds Multi Subs", tags.indexOf("Multi Subs") !== -1);
  assert("detectAudioTags finds Dual Audio", tags.indexOf("Dual Audio") !== -1);

  const dubTags = ctx.detectAudioTags("[EMBER] Show S01E01 1080p WEB-DL English Dub");
  assert("detectAudioTags finds Dubbed", dubTags.indexOf("Dubbed") !== -1);

  assert("detectAudioTags empty for bare title",
    ctx.detectAudioTags("[SubsPlease] Show - 08 (1080p)").length === 0);
  assert("detectAudioTags handles a missing title", ctx.detectAudioTags(null).length === 0);

  const name = ctx.formatStreamName(
    { title: "[SubsPlease] Sousou no Frieren - 08 (1080p)", seeders: 75, sizeLabel: "900.0 MiB" },
    "1080p",
    ["Multi Subs"]
  );
  const nameLines = name.split("\n");
  assert("formatStreamName is 4 lines", nameLines.length === 4);
  assert("formatStreamName line 1 is quality", nameLines[0] === "1080p");
  assert("formatStreamName line 2 is raw title", nameLines[1] === "[SubsPlease] Sousou no Frieren - 08 (1080p)");
  assert("formatStreamName line 3 has seeders and size",
    nameLines[2].indexOf("75") !== -1 && nameLines[2].indexOf("900.0 MiB") !== -1);
  assert("formatStreamName line 4 is tags", nameLines[3] === "Multi Subs");

  const noTags = ctx.formatStreamName({ title: "X", seeders: 1, sizeLabel: "1.0 MiB" }, null, []);
  assert("formatStreamName blank tag line when no tags", noTags.split("\n")[3] === " ");
  assert("formatStreamName blank quality line when unknown", noTags.split("\n")[0] === " ");
  // A blank line must be a space, not "": Stremio renders an empty line as a
  // collapsed gap, so the 4-line shape would not hold for untagged releases.
  assert("formatStreamName never emits an empty line", noTags.split("\n").every(function (l) { return l !== ""; }));

  // Line 3 is pinned by code point, not by substring. The spec calls for a
  // floppy disk before the size and an optical disc before the provider; the
  // three glyphs that are easy to confuse are U+1F4BE / U+1F4BF / U+1F4A9, and
  // substituting any of them left the whole suite green.
  assert("formatStreamName line 3 is exactly the spec's seeders/size/provider line",
    nameLines[2] === "75 \uD83D\uDCBE 900.0 MiB \uD83D\uDCBF Nyaa");
  assert("formatStreamName tags join with ' / '",
    ctx.formatStreamName({ title: "X", seeders: 1, sizeLabel: "1 MiB" }, "720p",
      ["Multi Subs", "Dual Audio"]).split("\n")[3] === "Multi Subs / Dual Audio");
  assert("formatStreamName falls back to '?' for a missing sizeLabel",
    ctx.formatStreamName({ title: "X", seeders: 2 }, "720p", []).split("\n")[2] === "2 \uD83D\uDCBE ? \uD83D\uDCBF Nyaa");
  assert("formatStreamName shows 0 seeders rather than blanking the line",
    ctx.formatStreamName({ title: "X", seeders: 0, sizeLabel: "1 MiB" }, "720p", []).split("\n")[2] === "0 \uD83D\uDCBE 1 MiB \uD83D\uDCBF Nyaa");

  // The spec's vocabulary is exactly Torrentio's four words. "Unsubs" was
  // invented here and false-positives on release names like "H264-Raw".
  assert("detectAudioTags has no tag outside the spec vocabulary",
    ctx.detectAudioTags("Show.S01E08.1080p.WEB-DL.H264-Raw").length === 0);
  assert("detectAudioTags still finds a dub via the loose bare-dub match",
    ctx.detectAudioTags("Show 08 1080p Dub").indexOf("Dubbed") !== -1);

  // detectAudioTags(null) must not rely on RegExp coercion: test(null) matches
  // the string "null", so removing the guard left this assertion green.
  assert("detectAudioTags rejects a missing title without scanning it",
    ctx.detectAudioTags(null).length === 0 && ctx.detectAudioTags(undefined).length === 0);

  // ---- integration (mocked fetch): SubsPlease + English both returned ----
  return ctx.getStreams("122991", "tv", 1, 8).then(function (res) {
    console.log("  integration results:", res.length);
    const hasSubs = res.some(r => /SubsPlease/.test(r.title));
    const hasEng = res.some(r => /Smoking Behind/.test(r.title));
    assert("integration returns SubsPlease", hasSubs);
    assert("integration returns English-dub", hasEng);
    // Pins the Step 4 wiring itself: unit tests call formatStreamName directly,
    // so without this the result object could still carry name: item.title.
    const labelled = res[0];
    assert("integration result uses the 4-line label", labelled.name.split("\n").length === 4);
    assert("integration result keeps title raw for the app to key off",
      res.every(function (r) { return r.title === r.name.split("\n")[1]; }));
    // Spec line 101 pins all eight machine-readable fields. Dropping url,
    // seeders, size or quality from the result object must fail here.
    assert("integration result still carries every machine-readable field",
      res.every(function (r) {
        return r.provider === "Nyaa" && r.type === "tv" &&
          r.infoHash === r.infoHash.toLowerCase() && /^[0-9a-f]{32,}$/.test(r.infoHash) &&
          typeof r.url === "string" && r.url.indexOf("magnet:?xt=urn:btih:") === 0 &&
          typeof r.seeders === "number" && typeof r.size === "number" && r.size > 0 &&
          typeof r.quality === "string" && r.quality.length > 0;
      }));
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
