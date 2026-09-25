// Tracker reachability probe. Run: node nyaa-nuvio/tracker-health.js
//
// Measures liveness only. It does NOT prove a tracker has peers for a given
// infoHash - a tracker can answer a handshake and still return an empty peer
// list, which is the failure that actually matters for seeding.
//
// UDP uses the BEP 15 connection handshake (8-byte magic, expect a 16-byte
// action-0 response). HTTP(S) uses a plain GET, where any HTTP status proves the
// host answered.
//
// This file is a Node tool, not addon runtime code, so it uses modern syntax.
// nyaa.js keeps the ES5 style it needs for the Stremio host.
const dgram = require("dgram");
const https = require("https");
const http = require("http");
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "nyaa.js"), "utf8");
const ctx = {
  console: { log: function () {}, warn: function () {}, error: function () {} },
  setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
  String, parseInt, isNaN, Math, Date, Promise, RegExp, Object, Array, Error, JSON,
  fetch: function (url, init) { return fetch(url, init); },
  module: { exports: {} }, global: {}
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

const MAGIC = Buffer.from([0x41, 0x42, 0x54, 0x72, 0x61, 0x63, 0x6b, 0x40]);
const CONCURRENCY = 8;
const UDP_TIMEOUT_MS = 4000;
const HTTP_TIMEOUT_MS = 8000;

function probeUdp(url, timeoutMs) {
  return new Promise(function (resolve) {
    let host, port;
    try {
      const u = new URL(url);
      if (u.protocol !== "udp:") throw new Error("not udp");
      host = u.hostname;
      port = parseInt(u.port, 10) || 6969;
    } catch (e) { resolve({ url, ok: false, note: "bad url" }); return; }

    const socket = dgram.createSocket("udp4");
    let done = false;
    const finish = function (ok, note) {
      if (done) return;
      done = true;
      try { socket.close(); } catch (e) { /* already closed */ }
      resolve({ url, ok: ok, note: note || "" });
    };
    socket.on("error", function (e) { finish(false, e.code || e.message); });
    socket.on("message", function (msg) {
      // BEP 15: the connect response is a 16-byte action-0 message.
      const action = msg.length >= 4 ? msg.readUInt32BE(0) : -1;
      finish(msg.length >= 8 && action === 0, "action " + action);
    });
    setTimeout(function () { finish(false, "timeout"); }, timeoutMs);
    socket.send(MAGIC, 0, MAGIC.length, port, host, function (e) {
      if (e) finish(false, e.code || e.message);
    });
  });
}

function probeHttp(url, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (ok, note) {
      if (done) return;
      done = true;
      resolve({ url, ok: ok, note: note || "" });
    };
    const mod = url.indexOf("https:") === 0 ? https : http;
    let req;
    try {
      req = mod.get(url, function (res) {
        res.resume();
        // Any status proves the host answered. 4xx/5xx are reported as-is
        // rather than called dead - the tracker is up, the path is not.
        finish(true, "http " + res.statusCode);
      });
    } catch (e) { finish(false, e.code || e.message); return; }
    req.on("error", function (e) { finish(false, e.code || e.message); });
    req.setTimeout(timeoutMs, function () { req.destroy(); finish(false, "timeout"); });
  });
}

function probe(url) {
  return url.indexOf("udp://") === 0
    ? probeUdp(url, UDP_TIMEOUT_MS)
    : probeHttp(url, HTTP_TIMEOUT_MS);
}

// Bounded concurrency: 59 sequential probes at up to 8s each would take several
// minutes, and a serial run also measures nothing that a parallel one does not.
async function probeAll(list) {
  const results = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await probe(list[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return results;
}

function report(name, results) {
  const alive = results.filter(function (r) { return r.ok; }).length;
  const udp = results.filter(function (r) { return r.url.indexOf("udp://") === 0; });
  const udpAlive = udp.filter(function (r) { return r.ok; }).length;
  console.log("\n" + name + ": " + alive + "/" + results.length + " reachable" +
    (udp.length ? "  (udp " + udpAlive + "/" + udp.length + ")" : ""));
  for (const r of results) {
    console.log("  " + (r.ok ? "ALIVE " : "DEAD  ") + r.url + "  " + r.note);
  }
  return { total: results.length, alive: alive, udpTotal: udp.length, udpAlive: udpAlive };
}

(async function () {
  console.log("probing with " + CONCURRENCY + " workers, udp timeout " +
    UDP_TIMEOUT_MS + "ms, http timeout " + HTTP_TIMEOUT_MS + "ms");
  console.log("liveness only - a reachable tracker may still have no peers for an infoHash");

  let live = [];
  try {
    live = await ctx.initBestTrackers();
  } catch (e) {
    console.log("live list unavailable, probing static sets only: " + (e && e.message));
  }

  const shipped = ctx.mergeTrackers(live);
  const sets = {
    "anime set only": ctx.TRACKERS_ANIME,
    "legacy generic only": ctx.TRACKERS_GENERIC,
    "live list only": live,
    "merged (shipped)": shipped
  };

  const summary = {};
  for (const name of Object.keys(sets)) {
    const list = sets[name];
    if (!list || !list.length) { console.log("\n" + name + ": skipped (empty)"); continue; }
    summary[name] = report(name, await probeAll(list));
  }

  console.log("\n--- summary ---");
  for (const name of Object.keys(summary)) {
    const s = summary[name];
    console.log("  " + name + ": " + s.alive + "/" + s.total);
  }

  // What the cap actually costs: entries evicted from the shipped magnet.
  const room = ctx.MAX_TRACKERS;
  console.log("\nshipped magnet: " + shipped.length + " entries (cap " + room + ")");
  const pool = ctx.TRACKERS_ANIME.concat(live, ctx.TRACKERS_GENERIC)
    .filter(function (u, i, a) { return a.indexOf(u) === i; });
  console.log("distinct pool available: " + pool.length);
  console.log("evicted by the cap: " + (pool.length - shipped.length));
  const evicted = pool.filter(function (u) { return shipped.indexOf(u) === -1; });
  if (evicted.length) console.log("  " + evicted.join("\n  "));
})();
