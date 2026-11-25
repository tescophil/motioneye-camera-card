// Behavioural tests for the recordings strip: placeholders, instant camera switching,
// background refresh/prefetch and thumbnail preloading. Uses a tiny fake DOM, no browser.
const test = require("node:test");
const assert = require("node:assert");

globalThis.HTMLElement = class {
  attachShadow() {
    return {};
  }
};

const { MotionEyeCameraCard, normalizeConfig } = require("../motioneye-camera-card.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(0);

function makeCard(extra = {}) {
  const card = new MotionEyeCameraCard();
  const strip = { innerHTML: "", hidden: true, scrollLeft: 0, querySelectorAll: () => [] };
  card._q = (sel) => (sel === "#strip" ? strip : null);
  card._config = normalizeConfig({ cameras: ["camera.a", "camera.b", "camera.c"], timeline_bar: false, ...extra });
  card._hass = { states: {}, locale: { language: "en" } };
  card._active = true;
  card._view = "live";
  card._quality = "normal";
  card.fetches = [];
  // fake media source: one video per camera, with a thumbnail
  card._findKinds = async (cam) => ({ movies: `m:${cam.entity}`, images: null });
  card._collect = async (id) => {
    card.fetches.push(id);
    return [{ id: `${id}#1`, thumb: `thumb/${id}`, kind: "video", ts: 1, time: "10:00:00", dateKey: "2020-01-01", title: "" }];
  };
  card._signedUrl = async (raw) => `signed:${raw}`;
  return { card, strip };
}

test("placeholders are shown straight away, before any data", () => {
  const { card, strip } = makeCard();
  card._renderStrip();
  assert.strictEqual(strip.hidden, false);
  assert.strictEqual((strip.innerHTML.match(/item skel/g) || []).length, 8);
  assert.ok(!strip.innerHTML.includes("Loading"));
});

test("placeholders are replaced by clips once loaded", async () => {
  const { card, strip } = makeCard();
  card._renderStrip();
  await card._loadStrip();
  assert.ok(!strip.innerHTML.includes("skel"));
  assert.match(strip.innerHTML, /data-idx="0"/);
});

test("empty and error states keep the strip's height with an invisible spacer", async () => {
  const { card, strip } = makeCard();
  card._collect = async () => [];
  await card._loadStrip();
  assert.match(strip.innerHTML, /item spacer/);
  assert.match(strip.innerHTML, /No recordings yet/);
  const b = makeCard();
  b.card._findKinds = async () => {
    throw new Error("boom");
  };
  await b.card._loadStrip();
  assert.match(b.strip.innerHTML, /item spacer/);
  assert.match(b.strip.innerHTML, /Recordings unavailable: boom/);
});

test("background prefetch loads the other cameras, so switching shows clips instantly", async () => {
  const { card, strip } = makeCard();
  await card._loadStrip(); // selected camera first
  await card._prefetchStrips();
  assert.ok(card._strip["camera.b"] && card._strip["camera.c"]);
  card._sel = 1; // switch camera: no await, no network
  const before = card.fetches.length;
  card._renderStrip();
  assert.ok(!strip.innerHTML.includes("skel"));
  assert.match(strip.innerHTML, /m:camera\.b/);
  assert.strictEqual(card.fetches.length, before);
});

test("prefetch waits for the selected camera and respects strip_prefetch: false", async () => {
  const a = makeCard();
  await a.card._prefetchStrips(); // selected camera has no data yet
  assert.deepStrictEqual(a.card.fetches, []);
  const b = makeCard({ strip_prefetch: false });
  await b.card._loadStrip();
  await b.card._prefetchStrips();
  assert.strictEqual(b.card._strip["camera.b"], undefined);
});

test("a stale strip is still shown at once and refreshed silently", async () => {
  const { card, strip } = makeCard();
  await card._loadStrip();
  card._strip["camera.a"].at = 0; // stale
  const n = card.fetches.length;
  const p = card._loadStrip();
  assert.match(strip.innerHTML, /data-idx="0"/); // still showing clips while it refreshes
  assert.ok(!strip.innerHTML.includes("skel"));
  await p;
  assert.strictEqual(card.fetches.length, n + 1);
});

test("an unchanged refresh doesn't redraw the strip (keeps scroll position)", async () => {
  const { card, strip } = makeCard();
  await card._loadStrip();
  strip.innerHTML = "SENTINEL";
  card._strip["camera.a"].at = 0;
  await card._loadStrip();
  assert.strictEqual(strip.innerHTML, "SENTINEL");
});

test("a failed refresh keeps the clips already on screen", async () => {
  const { card, strip } = makeCard();
  await card._loadStrip();
  card._strip["camera.a"].at = 0;
  card._findKinds = async () => {
    throw new Error("network down");
  };
  await card._loadStrip();
  assert.match(strip.innerHTML, /data-idx="0"/);
  assert.ok(!strip.innerHTML.includes("unavailable"));
  assert.strictEqual(card._strip["camera.a"].error, null);
});

test("thumbnails are preloaded in the background and used instead of re-downloading", async () => {
  const { card } = makeCard();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, blob: async () => new Blob(["x"]) };
  };
  card._preloadStripThumbs([{ thumb: "t1" }, { thumb: "t2" }]);
  await sleep(20);
  assert.strictEqual(requests, 2);
  assert.match(await card._thumbSrc("t1"), /^blob:/);
  assert.strictEqual(requests, 2); // served from the preloaded copy
});

test("a visible thumbnail jumps ahead of the background preload queue", async () => {
  const { card } = makeCard();
  globalThis.fetch = async () => {
    await sleep(15);
    return { ok: true, blob: async () => new Blob(["x"]) };
  };
  card._preloadStripThumbs([1, 2, 3, 4, 5, 6].map((n) => ({ thumb: `t${n}` })));
  // t1, t2 are downloading; t6 is still queued
  const src = await card._thumbSrc("t6");
  assert.strictEqual(src, "signed:t6"); // fetched directly, not after the whole queue
  assert.ok(!card._preQueue.some((x) => x.raw === "t6"));
  await sleep(120);
});

test("no thumbnail preloading on a slow / data-saving connection", () => {
  const { card } = makeCard();
  card._quality = "low";
  card._preloadStripThumbs([{ thumb: "t1" }]);
  assert.strictEqual(card._preQueue.length, 0);
  assert.strictEqual(card._blobPending.size, 0);
});

test("clearing background work revokes preloaded thumbnails and abandons in-flight loads", async () => {
  const { card } = makeCard();
  globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(["x"]) });
  card._preloadStripThumbs([{ thumb: "t1" }]);
  await sleep(20);
  assert.strictEqual(card._blobs.size, 1);
  card._preloadStripThumbs([{ thumb: "t2" }]); // in flight
  card._clearBackground();
  await sleep(20);
  assert.strictEqual(card._blobs.size, 0); // nothing stored after teardown
});

test("blob cache is capped", () => {
  const { card } = makeCard();
  for (let i = 0; i < 320; i++) card._storeBlob(`t${i}`, new Blob(["x"]));
  assert.strictEqual(card._blobs.size, 300);
  assert.ok(!card._blobs.has("t0") && card._blobs.has("t319"));
});
