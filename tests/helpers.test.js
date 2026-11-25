const test = require("node:test");
const assert = require("node:assert");

// The card file defines custom elements at load time; give Node a minimal DOM stub.
globalThis.HTMLElement = class {};

const {
  normalizeConfig,
  normalizeCamera,
  parseTimestamp,
  proxyYaml,
  byTsDesc,
  pickThumbEntity,
  firstRisingEdge,
  fingerprint,
  fitMode,
  DEFAULT_CONFIG,
} = require("../motioneye-camera-card.js");

test("normalizeCamera accepts strings and objects, derives low_entity", () => {
  assert.deepStrictEqual(normalizeCamera("camera.garage"), {
    low_entity: "camera.garage_low",
    entity: "camera.garage",
  });
  assert.strictEqual(
    normalizeCamera({ entity: "camera.a", low_entity: "camera.custom" }).low_entity,
    "camera.custom"
  );
});

test("normalizeCamera rejects non-camera entities", () => {
  assert.throws(() => normalizeCamera("light.kitchen"));
  assert.throws(() => normalizeCamera({}));
});

test("normalizeConfig applies defaults and clamps values", () => {
  const cfg = normalizeConfig({ cameras: ["camera.a"], grid_columns: 9, snapshot_interval: 0 });
  assert.strictEqual(cfg.layout, DEFAULT_CONFIG.layout);
  assert.strictEqual(cfg.grid_columns, 4);
  assert.strictEqual(cfg.snapshot_interval, 5); // 0 is falsy -> default
  assert.strictEqual(cfg.cameras[0].entity, "camera.a");
});

test("normalizeConfig validates required fields and enums", () => {
  assert.throws(() => normalizeConfig({}));
  assert.throws(() => normalizeConfig({ cameras: [] }));
  assert.throws(() => normalizeConfig({ cameras: ["camera.a"], layout: "wall" }));
  assert.throws(() => normalizeConfig({ cameras: ["camera.a"], default_quality: "ultra" }));
});

test("parseTimestamp reads date dir + HH-MM-SS filename", () => {
  const r = parseTimestamp("19-04-16.mp4", ["2026-11-22"], "media-source://motioneye/x#y#movies#2026-11-22/19-04-16.mp4");
  assert.strictEqual(r.dateKey, "2026-11-22");
  assert.strictEqual(r.time, "19:04:16");
  assert.strictEqual(r.ts, new Date(2026, 10, 22, 19, 4, 16).getTime());
});

test("parseTimestamp does not mistake the date for a time", () => {
  const r = parseTimestamp("snapshot.jpg", ["2026-11-22"], "");
  assert.strictEqual(r.dateKey, "2026-11-22");
  assert.strictEqual(r.time, null);
});

test("parseTimestamp returns nulls when no date is present", () => {
  assert.deepStrictEqual(parseTimestamp("clip.mp4", [], "abc"), { ts: null, dateKey: null, time: null });
});

test("byTsDesc sorts newest first, unknown last", () => {
  const sorted = [{ ts: 1 }, { ts: null }, { ts: 3 }, { ts: 2 }].sort(byTsDesc).map((x) => x.ts);
  assert.deepStrictEqual(sorted, [3, 2, 1, null]);
});

test("proxyYaml produces names whose slug matches <entity>_low", () => {
  const y = proxyYaml(["camera.living_room", "camera.garage"]);
  assert.match(y, /entity_id: camera\.living_room\n/);
  assert.match(y, /name: "Living Room Low"/);
  assert.match(y, /name: "Garage Low"/);
  assert.match(y, /max_stream_width: 480/);
  assert.ok(y.startsWith("camera:\n  - platform: proxy"));
});

test("timeline defaults load a week of days with a generous item cap", () => {
  const cfg = normalizeConfig({ cameras: ["camera.a"] });
  assert.strictEqual(cfg.timeline_days, 7);
  assert.strictEqual(cfg.timeline_limit, 500);
});

test("timeline_days 0 means all days and limits are clamped", () => {
  const cfg = normalizeConfig({ cameras: ["camera.a"], timeline_days: 0, timeline_limit: 99999 });
  assert.strictEqual(cfg.timeline_days, 0);
  assert.strictEqual(cfg.timeline_limit, 2000);
});

test("strip defaults: on, both kinds, 30 items", () => {
  const cfg = normalizeConfig({ cameras: ["camera.a"] });
  assert.strictEqual(cfg.strip, true);
  assert.strictEqual(cfg.strip_content, "both");
  assert.strictEqual(cfg.strip_limit, 30);
});

test("strip options are validated and clamped", () => {
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], strip: false }).strip, false);
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], strip_content: "videos" }).strip_content, "videos");
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], strip_limit: 5000 }).strip_limit, 100);
  assert.throws(() => normalizeConfig({ cameras: ["camera.a"], strip_content: "movies" }));
});

test("thumb_quality defaults to follow; select_on_motion is off with a 30s lock", () => {
  const cfg = normalizeConfig({ cameras: ["camera.a"] });
  assert.strictEqual(cfg.thumb_quality, "follow");
  assert.strictEqual(cfg.select_on_motion, false);
  assert.strictEqual(cfg.select_on_motion_lock, 30);
});

test("thumb_quality and select_on_motion options are validated and clamped", () => {
  assert.throws(() => normalizeConfig({ cameras: ["camera.a"], thumb_quality: "medium" }));
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], thumb_quality: "low" }).thumb_quality, "low");
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], select_on_motion: true }).select_on_motion, true);
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], select_on_motion: "yes" }).select_on_motion, false);
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], select_on_motion_lock: 0 }).select_on_motion_lock, 0);
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], select_on_motion_lock: 99999 }).select_on_motion_lock, 3600);
});

test("a legacy thumb_low_res setting no longer affects anything", () => {
  const cfg = normalizeConfig({ cameras: ["camera.a"], thumb_low_res: true });
  assert.strictEqual(cfg.thumb_quality, "follow");
});

test("pickThumbEntity follows the effective quality", () => {
  const cam = normalizeCamera("camera.garage");
  const states = { "camera.garage_low": { state: "idle" } };
  assert.strictEqual(pickThumbEntity(cam, "follow", "normal", states), "camera.garage");
  assert.strictEqual(pickThumbEntity(cam, "follow", "low", states), "camera.garage_low");
});

test("pickThumbEntity honours fixed thumb_quality regardless of the HD/SD button", () => {
  const cam = normalizeCamera("camera.garage");
  const states = { "camera.garage_low": { state: "idle" } };
  assert.strictEqual(pickThumbEntity(cam, "low", "normal", states), "camera.garage_low");
  assert.strictEqual(pickThumbEntity(cam, "normal", "low", states), "camera.garage");
});

test("pickThumbEntity falls back to full-res when the low-res camera is missing or unavailable", () => {
  const cam = normalizeCamera("camera.garage");
  assert.strictEqual(pickThumbEntity(cam, "follow", "low", {}), "camera.garage");
  assert.strictEqual(
    pickThumbEntity(cam, "follow", "low", { "camera.garage_low": { state: "unavailable" } }),
    "camera.garage"
  );
  assert.strictEqual(pickThumbEntity(cam, "follow", "low", undefined), "camera.garage");
});

test("firstRisingEdge finds only cameras whose motion just started", () => {
  assert.strictEqual(firstRisingEdge([false, false, false], [false, true, false]), 1);
  assert.strictEqual(firstRisingEdge([false, true, false], [false, true, false]), -1); // still moving
  assert.strictEqual(firstRisingEdge([false, true, false], [false, true, true]), 2); // new one starts
  assert.strictEqual(firstRisingEdge([true, false], [false, false]), -1); // motion ended
  assert.strictEqual(firstRisingEdge(undefined, [false, true]), 1); // first run: already moving
  assert.strictEqual(firstRisingEdge([], [false, false]), -1);
});

test("strip_prefetch defaults to on and can be turned off", () => {
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"] }).strip_prefetch, true);
  assert.strictEqual(normalizeConfig({ cameras: ["camera.a"], strip_prefetch: false }).strip_prefetch, false);
});

test("fingerprint changes with the list of recordings, not with identical refreshes", () => {
  const a = [{ id: "x" }, { id: "y" }];
  assert.strictEqual(fingerprint(a), fingerprint([{ id: "x" }, { id: "y" }]));
  assert.notStrictEqual(fingerprint(a), fingerprint([{ id: "y" }, { id: "x" }]));
  assert.notStrictEqual(fingerprint(a), fingerprint([{ id: "x" }]));
  assert.match(fingerprint([]), /^0:/);
});

test("fitMode fills the tile when the thumbnail is close to its shape, otherwise shows it whole", () => {
  assert.strictEqual(fitMode(16 / 9, 1.7), "cover"); // slightly different shape: no letterbox bars
  assert.strictEqual(fitMode(1.7, 1.7), "cover");
  assert.strictEqual(fitMode(1.0, 1.7), "contain"); // near-square placeholder picture
  assert.strictEqual(fitMode(4 / 3, 16 / 9), "contain");
  assert.strictEqual(fitMode(0, 1.7), "contain");
  assert.strictEqual(fitMode(NaN, 1.7), "contain");
  assert.strictEqual(fitMode(1.7, 0), "contain");
});

// ---- day timeline bar helpers ----
const bar = require("../motioneye-camera-card.js");

test("dayBounds spans a local calendar day and hourMarks sit within it", () => {
  const b = bar.dayBounds("2026-11-24");
  assert.equal(b.length, 24 * 3600 * 1000);
  const marks = bar.hourMarks("2026-11-24", 180);
  assert.equal(marks.length, 8);
  assert.equal(marks[0].label, "00:00");
  assert.equal(marks[1].label, "03:00");
  assert.ok(Math.abs(marks[4].frac - 0.5) < 1e-9);
});

test("dayFraction clamps to the day", () => {
  const b = bar.dayBounds("2026-11-24");
  assert.equal(bar.dayFraction(b.start - 1000, "2026-11-24"), 0);
  assert.equal(bar.dayFraction(b.end + 1000, "2026-11-24"), 1);
  assert.ok(Math.abs(bar.dayFraction(b.start + b.length / 2, "2026-11-24") - 0.5) < 1e-9);
});

test("mergeSpans joins nearby recordings and pads them", () => {
  const m = 60000;
  const spans = bar.mergeSpans([0, 2 * m, 3 * m, 30 * m], 5 * m, m);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0], { start: -m, end: 4 * m });
  assert.deepEqual(spans[1], { start: 29 * m, end: 31 * m });
});

test("nearestIndex respects tolerance and ignores undated items", () => {
  const items = [{ ts: 1000 }, { ts: null }, { ts: 5000 }];
  assert.equal(bar.nearestIndex(items, 4800, 500), 2);
  assert.equal(bar.nearestIndex(items, 3000, 500), -1);
  assert.equal(bar.nearestIndex([], 0, 10), -1);
});

test("fmtClock pads HH:MM:SS", () => {
  assert.equal(bar.fmtClock(new Date(2026, 10, 24, 7, 5, 9).getTime()), "07:05:09");
});

test("rollFrac puts now at 0 and 24 hours ago at 1", () => {
  const now = Date.now();
  assert.equal(bar.rollFrac(now, now), 0);
  assert.equal(bar.rollFrac(now - 864e5, now), 1);
  assert.ok(Math.abs(bar.rollFrac(now - 432e5, now) - 0.5) < 1e-9);
});

test("rollingMarks starts at Now and labels whole hours going back", () => {
  const now = new Date(2026, 10, 25, 11, 48).getTime();
  const m = bar.rollingMarks(now, 3);
  assert.equal(m[0].label, "Now");
  assert.equal(m[1].label, "09:00");
  assert.ok(m.every((x) => x.frac >= 0 && x.frac < 1));
  assert.equal(m.length, 8);
});
