/*!
 * MotionEye Camera Card for Home Assistant
 * Live MJPEG view, multi-camera grid, SD/HD switching (via HA proxy cameras),
 * motion indication and a still-image + video timeline from motionEye.
 * No build step, no dependencies.  MIT licence.
 */

const CARD_VERSION = "1.2.1";
const CARD_TAG = "motioneye-camera-card";
const QUALITY_KEY = "motioneye-camera-card:quality";
const STRIP_TTL = 120000; // ms before a camera's recordings strip is refreshed in the background
const STRIP_ERROR_TTL = 30000; // ms before a failed strip load is retried
const PRELOAD_PER_CAMERA = 8; // thumbnails fetched ahead of time per camera
const MAX_BLOBS = 300; // cap on preloaded thumbnails kept in memory
const BAR_TTL = 120000; // ms before the day timeline bar is refreshed in the background

const DEFAULT_CONFIG = {
  layout: "grid", // grid | single
  default_quality: "auto", // auto | normal | low
  thumb_mode: "snapshot", // snapshot | stream
  thumb_quality: "follow", // follow | low | normal: which feed the grid tiles use (follow = same as the HD/SD button)
  snapshot_interval: 5, // seconds between thumbnail refreshes
  grid_columns: 2,
  aspect_ratio: "16:9",
  motion_hold: 30, // seconds to keep the motion indicator after an event
  select_on_motion: false, // make a camera the main camera when it starts detecting motion
  select_on_motion_lock: 30, // seconds to leave your own choice alone before auto-selecting again
  timeline: true,
  strip: true, // horizontal strip of recent recordings under the main image
  strip_content: "both", // both | videos | snapshots
  strip_limit: 30, // max items in the strip
  strip_prefetch: true, // load every camera's strip (and its first thumbnails) in the background
  timeline_bar: true, // 24-hour activity bar under the recordings strip
  timeline_days: 7, // how many of the newest days to load (0 = all available days)
  timeline_limit: 500, // safety cap on items per kind (videos / images) per camera
};

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

function normalizeCamera(c) {
  if (typeof c === "string") c = { entity: c };
  if (!c || typeof c.entity !== "string" || !/^camera\.[a-z0-9_]+$/.test(c.entity)) {
    throw new Error(`Invalid camera entry: ${JSON.stringify(c)}`);
  }
  return { low_entity: `${c.entity}_low`, ...c };
}

// Per-camera options the visual editor can set (anything else in a camera entry is kept as it is).
const CAMERA_FIELDS = ["name", "low_entity", "motion_entity"];

// Build a config entry for one camera: a plain entity id when nothing is customised, otherwise an object.
function buildCamera(entity, existing, fields) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  delete base.entity;
  for (const k of CAMERA_FIELDS) delete base[k];
  const out = { entity, ...base };
  for (const k of CAMERA_FIELDS) {
    const v = fields && typeof fields[k] === "string" ? fields[k].trim() : "";
    if (v) out[k] = v;
  }
  return Object.keys(out).length === 1 ? entity : out;
}

function normalizeConfig(config) {
  if (!config || !Array.isArray(config.cameras) || config.cameras.length === 0) {
    throw new Error("`cameras` must be a non-empty list of camera entities");
  }
  const cfg = { ...DEFAULT_CONFIG, ...config };
  cfg.cameras = config.cameras.map(normalizeCamera);
  if (!["grid", "single"].includes(cfg.layout)) throw new Error("`layout` must be grid or single");
  if (!["auto", "normal", "low"].includes(cfg.default_quality)) {
    throw new Error("`default_quality` must be auto, normal or low");
  }
  if (!["snapshot", "stream"].includes(cfg.thumb_mode)) {
    throw new Error("`thumb_mode` must be snapshot or stream");
  }
  if (!["follow", "low", "normal"].includes(cfg.thumb_quality)) {
    throw new Error("`thumb_quality` must be follow, low or normal");
  }
  cfg.select_on_motion = cfg.select_on_motion === true;
  const lock = Number(cfg.select_on_motion_lock);
  cfg.select_on_motion_lock = Number.isFinite(lock) ? Math.min(3600, Math.max(0, lock)) : 30;
  cfg.grid_columns = Math.min(4, Math.max(1, Number(cfg.grid_columns) || 2));
  cfg.snapshot_interval = Math.max(1, Number(cfg.snapshot_interval) || 5);
  cfg.motion_hold = Math.max(0, Number(cfg.motion_hold) || 0);
  cfg.timeline_limit = Math.min(2000, Math.max(1, Number(cfg.timeline_limit) || 500));
  cfg.timeline_days = Math.max(0, Math.floor(Number(cfg.timeline_days)) || 0);
  if (!["both", "videos", "snapshots"].includes(cfg.strip_content)) {
    throw new Error("`strip_content` must be both, videos or snapshots");
  }
  cfg.strip = cfg.strip !== false;
  cfg.strip_prefetch = cfg.strip_prefetch !== false;
  cfg.timeline_bar = cfg.timeline_bar !== false;
  cfg.strip_limit = Math.min(100, Math.max(1, Math.floor(Number(cfg.strip_limit)) || 30));
  return cfg;
}

// Which camera entity a grid tile should show: "follow" tracks the HD/SD choice.
// Falls back to the full-resolution camera when the low-res one is missing or unavailable.
function pickThumbEntity(cam, thumbQuality, effectiveQuality, states) {
  const q = thumbQuality === "follow" ? effectiveQuality : thumbQuality;
  if (q === "low") {
    const low = states && states[cam.low_entity];
    if (low && low.state !== "unavailable") return cam.low_entity;
  }
  return cam.entity;
}

// Short fingerprint of a list of recordings, so an unchanged refresh doesn't redraw the strip.
function fingerprint(items) {
  let h = 5381;
  const str = items.map((i) => i.id).join("|");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `${items.length}:${(h >>> 0).toString(36)}`;
}

// How to fit a thumbnail into a clip tile. A thumbnail whose shape is close to the tile's fills it
// edge to edge (no thin letterbox bars); one that is very different, such as a generic placeholder
// picture, is shown whole instead of being cropped.
function fitMode(imgRatio, boxRatio) {
  if (!(imgRatio > 0) || !(boxRatio > 0)) return "contain";
  return Math.abs(imgRatio / boxRatio - 1) <= 0.15 ? "cover" : "contain";
}

// ---- day timeline bar helpers ----

// Start, end and length (ms) of a local calendar day, e.g. "2026-11-24". Length is 23/25 h on DST days.
function dayBounds(dateKey) {
  const [Y, M, D] = dateKey.split("-").map(Number);
  const start = new Date(Y, M - 1, D).getTime();
  const end = new Date(Y, M - 1, D + 1).getTime();
  return { start, end, length: end - start };
}

// Where in the day (0 to 1) a timestamp falls.
function dayFraction(ts, dateKey) {
  const { start, length } = dayBounds(dateKey);
  return Math.min(1, Math.max(0, (ts - start) / length));
}

// Axis labels for a day: one every `stepMin` minutes, with their position (0 to 1).
function hourMarks(dateKey, stepMin) {
  const [Y, M, D] = dateKey.split("-").map(Number);
  const { start, length } = dayBounds(dateKey);
  const out = [];
  for (let m = 0; m < 1440; m += stepMin) {
    const t = new Date(Y, M - 1, D, 0, m).getTime();
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    out.push({ label: `${hh}:${mm}`, frac: (t - start) / length });
  }
  return out;
}

// Merge recording times that are close together into spans, like the green "coverage" on a CCTV timeline.
function mergeSpans(times, gapMs, padMs) {
  const sorted = times.filter(Number.isFinite).sort((a, b) => a - b);
  const spans = [];
  for (const t of sorted) {
    const last = spans[spans.length - 1];
    if (last && t - last.end <= gapMs) last.end = t;
    else spans.push({ start: t, end: t });
  }
  return spans.map((s) => ({ start: s.start - padMs, end: s.end + padMs }));
}

// Index of the recording nearest to time t, if it is within tolMs; otherwise -1.
function nearestIndex(items, t, tolMs) {
  let best = -1;
  let bestD = Infinity;
  items.forEach((it, i) => {
    if (it.ts == null) return;
    const d = Math.abs(it.ts - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 && bestD <= tolMs ? best : -1;
}

// Where a time falls in the rolling 24 h window that ends at `now`: 0 = now, 1 = 24 hours ago.
function rollFrac(ts, now) {
  return (now - ts) / 864e5;
}

// Axis labels for the rolling window: "Now", then each whole `stepH` hours back (clock times).
function rollingMarks(now, stepH) {
  const out = [{ label: "Now", frac: 0 }];
  const top = new Date(now);
  top.setMinutes(0, 0, 0);
  let t = top.getTime();
  const seen = [];
  for (let k = 0; k <= 24; k++, t -= 36e5) {
    const f = rollFrac(t, now);
    if (f > 1) break;
    const h = new Date(t).getHours();
    if (h % stepH === 0 && f > 0.03 && f < 0.97) seen.push({ label: `${String(h).padStart(2, "0")}:00`, frac: f });
  }
  return out.concat(seen);
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function pct(f) {
  return `${(Math.min(1, Math.max(0, f)) * 100).toFixed(3)}%`;
}

// Index of the first camera whose motion flag just turned on, or -1.
function firstRisingEdge(prev, flags) {
  return flags.findIndex((m, n) => m && !(prev && prev[n]));
}

// motionEye default layout is <date dir>/<HH-MM-SS>.<ext>, e.g. 2026-11-22/19-04-16.mp4
function parseTimestamp(title, trail = [], id = "") {
  const s = [title, ...trail, id].join(" ");
  const d = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return { ts: null, dateKey: null, time: null };
  const rest = s.replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const t = rest.match(/(?:^|\D)(\d{2})[-:.](\d{2})[-:.](\d{2})(?!\d)/);
  const [H, M, S] = t ? [t[1], t[2], t[3]] : ["00", "00", "00"];
  const ts = new Date(+d[1], +d[2] - 1, +d[3], +H, +M, +S).getTime();
  return { ts, dateKey: `${d[1]}-${d[2]}-${d[3]}`, time: t ? `${H}:${M}:${S}` : null };
}

function proxyYaml(entities, { width = 480, quality = 50 } = {}) {
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const lines = ["camera:"];
  for (const e of entities) {
    const id = e.replace(/^camera\./, "");
    const name = `${id.split("_").map(cap).join(" ")} Low`;
    lines.push(
      "  - platform: proxy",
      `    entity_id: ${e}`,
      `    name: "${name}"`,
      "    mode: resize",
      `    max_image_width: ${width}`,
      `    image_quality: ${quality}`,
      `    max_stream_width: ${width}`,
      `    stream_quality: ${quality}`
    );
  }
  return lines.join("\n");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function byTsDesc(a, b) {
  if (a.ts == null && b.ts == null) return 0;
  if (a.ts == null) return 1;
  if (b.ts == null) return -1;
  return b.ts - a.ts;
}

function localDateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const STYLE = `
:host{display:block}
[hidden]{display:none!important}
ha-card{overflow:hidden;position:relative}
button{font:inherit;color:inherit;cursor:pointer}
.hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 6px}
.title{display:flex;align-items:center;gap:8px;font-size:1.1rem;font-weight:500;min-width:0}
.title span#title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tools{display:flex;gap:8px;align-items:center;flex-shrink:0}
.seg{display:inline-flex;border:1px solid var(--divider-color);border-radius:999px;overflow:hidden}
.seg button{background:none;border:0;padding:5px 12px;font-size:.85rem}
.seg button.on{background:var(--primary-color);color:var(--text-primary-color,#fff)}
.pill{border:1px solid var(--divider-color);background:none;border-radius:999px;padding:5px 12px;font-size:.85rem}
.alert{background:var(--error-color,#db4437);color:#fff;border-radius:999px;font-size:.72rem;padding:2px 8px;display:inline-flex;gap:5px;align-items:center;font-weight:500}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block;animation:blink 1s infinite alternate}
@keyframes blink{from{opacity:1}to{opacity:.25}}
@keyframes pulse{from{box-shadow:0 0 0 0 rgba(219,68,55,.7)}to{box-shadow:0 0 8px 2px rgba(219,68,55,.9)}}
.live{padding:0 8px 8px}
.tile{position:relative;overflow:hidden;background:#000;border-radius:var(--ha-card-border-radius,12px);aspect-ratio:var(--ar,16/9);border:0;padding:0;display:block;width:100%}
.main img{object-fit:contain}
.tile img{width:100%;height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none}
.main.motion,.thumb.motion{outline:2px solid var(--error-color,#db4437);animation:pulse 1s infinite alternate}
.main.expanded{position:fixed;inset:0;z-index:9999;border-radius:0;aspect-ratio:auto;width:100%;height:100%}
.label{position:absolute;left:0;right:0;bottom:0;padding:14px 10px 6px;text-align:left;font-weight:500;color:#fff;text-shadow:0 1px 3px #000;background:linear-gradient(transparent,rgba(0,0,0,.65));pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.main .label{font-size:1.15rem;padding-right:70px}
.thumb .label{font-size:.95rem}
.badge{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.6);color:#fff;border-radius:6px;padding:2px 7px;font-size:.8rem;font-weight:700;border:1px solid rgba(255,255,255,.6)}
.mflag{position:absolute;left:8px;top:8px;display:none}
.motion>.mflag{display:inline-flex}
.mdot{position:absolute;right:8px;top:8px;width:10px;height:10px;border-radius:50%;background:var(--error-color,#db4437);display:none;animation:blink 1s infinite alternate}
.thumb.motion .mdot{display:block}
.fs{position:absolute;right:6px;top:6px;background:rgba(0,0,0,.45);color:#fff;border:0;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;padding:0}
.msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ddd;font-size:.95rem;text-align:center;padding:12px;pointer-events:none}
.note{margin:6px 4px 0;font-size:.8rem;color:var(--secondary-text-color)}
.grid{display:grid;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr));gap:6px;margin-top:6px;align-items:start}
.thumb{cursor:pointer;background:#111}
.thumb.sel{outline:2px solid var(--primary-color)}
.thumb.motion.sel{outline-color:var(--error-color,#db4437)}
.thumb.off img{opacity:.25}
.chips{display:flex;gap:6px;overflow-x:auto;padding:8px 2px 2px}
.chip{border:1px solid var(--divider-color);background:none;border-radius:999px;padding:5px 12px;white-space:nowrap;font-size:.9rem;position:relative}
.chip.sel{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color)}
.chip.motion::after{content:"";position:absolute;right:3px;top:3px;width:8px;height:8px;border-radius:50%;background:var(--error-color,#db4437)}
.tlbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 12px 8px}
.tlbody{padding:0 8px 10px}
.tlinfo{padding:0 4px 4px;font-size:.78rem;color:var(--secondary-text-color)}
.day{font-weight:500;padding:10px 4px 6px;color:var(--secondary-text-color);font-size:.9rem;border-bottom:1px solid var(--divider-color);margin-bottom:6px}
.items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;align-items:start}
@media(min-width:600px){.items{grid-template-columns:repeat(5,minmax(0,1fr))}}
.item{position:relative;aspect-ratio:var(--item-ar,var(--ar,16/9));border-radius:8px;overflow:hidden;background:#1b1b1b;border:0;padding:0}
.item img{width:100%;height:100%;object-fit:contain}
.item.loaded .ph{display:none}
.item.cover img{object-fit:cover}
.item .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888}
.item .t{position:absolute;left:0;right:0;bottom:0;padding:10px 6px 3px;font-size:.75rem;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.7));text-align:left}
.item .k{position:absolute;right:4px;top:4px;color:#fff;background:rgba(0,0,0,.5);border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;--mdc-icon-size:14px}
.empty{padding:24px 12px;text-align:center;color:var(--secondary-text-color);font-size:.9rem}
.empty b{display:block;margin-bottom:4px;color:var(--primary-text-color)}
.strip{display:flex;align-items:flex-start;gap:6px;overflow-x:auto;padding:6px 2px 2px;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity;scrollbar-width:thin}
.strip .item{flex:0 0 120px;scroll-snap-align:start}
.sempty{align-self:center;padding:0 6px;font-size:.85rem;color:var(--secondary-text-color)}
.item.spacer{visibility:hidden}
.item.skel{background:linear-gradient(90deg,#1b1b1b 25%,#2a2a2a 40%,#1b1b1b 60%);background-size:300% 100%;animation:shimmer 1.4s ease-in-out infinite}
.item.skel .ph{color:#3a3a3a}
@keyframes shimmer{from{background-position:100% 50%}to{background-position:0 50%}}
@media(prefers-reduced-motion:reduce){.item.skel{animation:none}}
.tbar{margin:8px 2px 6px}
.tb-bar .win{top:0;bottom:0;min-width:6px;box-sizing:border-box;border:2px solid var(--me-bar-window,var(--primary-text-color,#888));border-radius:4px;background:rgba(128,128,128,.25);z-index:1}
.tb-wrap{position:relative}
.tb-axis{position:relative;height:14px;font-size:.68rem;color:var(--secondary-text-color)}
.tb-axis span{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}
.tb-axis span.first{transform:none}
.tb-bar{position:relative;height:24px;border-radius:6px;background:var(--me-bar-bg,#6a994e);overflow:hidden;cursor:pointer}
.tb-bar i{position:absolute;pointer-events:none}
.tb-bar .sp{top:0;bottom:0;min-width:3px;background:var(--me-bar-activity,#d4f5b8);opacity:.7;border-radius:2px}
.tb-bar .tk{top:0;bottom:0;width:2px;margin-left:-1px;background:var(--me-bar-video,#4f46e5)}
.tb-bar .tk.image{top:auto;height:12px;width:2px;margin-left:-1px;background:var(--me-bar-image,#0a2540)}
.tb-bar .cur{top:0;bottom:0;width:2px;margin-left:-1px;background:var(--me-bar-cursor,#ff4081)}
.tb-bar.skel{background:linear-gradient(90deg,#1b1b1b 25%,#2a2a2a 40%,#1b1b1b 60%);background-size:300% 100%;animation:shimmer 1.4s ease-in-out infinite;cursor:default}
@media(prefers-reduced-motion:reduce){.tb-bar.skel{animation:none}}
.tb-tip{position:absolute;top:-2px;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:2px 8px;border-radius:6px;font-size:.75rem;pointer-events:none;white-space:nowrap;z-index:2}
.modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.92);display:flex;flex-direction:column}
.mbar{display:flex;align-items:center;gap:8px;padding:10px 12px;color:#fff}
.mbar .sp{flex:1;font-size:.95rem}
.mbar button,.mbar a{background:rgba(255,255,255,.12);border:0;color:#fff;border-radius:999px;padding:6px 14px;text-decoration:none;font-size:.9rem}
.mmedia{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 6px 12px}
.mmedia video,.mmedia img{max-width:100%;max-height:100%;border-radius:6px}
`;

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

class MotionEyeCameraCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._sel = 0;
    this._view = "live";
    this._quality = null;
    this._active = false;
    this._visible = true;
    this._motionTs = {};
    this._regInfo = {};
    this._tl = {};
    this._tlFilter = "all";
    this._tlVisible = [];
    this._sign = new Map();
    this._srcCache = {};
    this._thumbKeys = [];
    this._retry = 0;
    this._subTok = 0;
    this._strip = {};
    this._stripSig = null;
    this._stripItems = [];
    this._stripBusy = new Set(); // cameras whose strip is being fetched right now
    this._prefetching = false;
    this._prefetchFail = {};
    this._gen = 0; // bumped to abandon in-flight background work
    this._refreshTimers = {};
    this._arCache = {}; // camera entity -> "w / h" of its picture
    this._blobs = new Map(); // thumbnail URL -> preloaded object URL
    this._blobPending = new Map();
    this._preQueue = [];
    this._preActive = 0;
    this._bar = {}; // camera entity -> { at, items, fp, capped } for the last 24 hours
    this._barErr = {};
    this._barFail = {};
    this._barBusy = new Set();
    this._barCursor = null;
    this._barSig = null;
    this._barItems = [];
    this._barNow = 0;
  }

  /* ---------- Lovelace API ---------- */

  static getConfigElement() {
    return document.createElement(`${CARD_TAG}-editor`);
  }

  static getStubConfig(hass) {
    const cams = Object.keys(hass?.states || {}).filter((e) => e.startsWith("camera.")).slice(0, 4);
    return { cameras: cams };
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._quality = this._loadQuality() || this._config.default_quality;
    if (this._sel >= this._config.cameras.length) this._sel = 0;
    this._tl = {};
    this._strip = {};
    this._bar = {};
    this._barErr = {};
    this._barFail = {};
    this._barCursor = null;
    this._clearBackground();
    this._build();
    if (this._hass) this._afterHass();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._afterHass();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 6 };
  }

  /* ---------- lifecycle ---------- */

  connectedCallback() {
    this._io = new IntersectionObserver((entries) => {
      this._visible = entries.some((e) => e.isIntersecting);
      if (this._config) this._updateActive();
    });
    this._io.observe(this);
    this._onVis = () => this._updateActive();
    document.addEventListener("visibilitychange", this._onVis);
    this._onOnline = () => this._updateActive(true);
    window.addEventListener("online", this._onOnline);
    this._onNet = () => {
      if (this._quality === "auto") {
        this._connectMain(true);
        this._refreshThumbs();
      }
    };
    navigator.connection?.addEventListener?.("change", this._onNet);
    this._onKey = (e) => {
      if (this._modalOpen && e.key === "Escape") this._closeModal();
    };
    window.addEventListener("keydown", this._onKey);
    let ticks = 0;
    this._ticker = setInterval(() => {
      this._updateMotion();
      if (++ticks % 60 === 0) this._updateBarNow(); // slide the 24-hour window along with the clock
    }, 1000);
    if (this._config && this._hass) this._afterHass();
    if (this._config) this._updateActive(true);
  }

  disconnectedCallback() {
    this._io?.disconnect();
    document.removeEventListener("visibilitychange", this._onVis);
    window.removeEventListener("online", this._onOnline);
    window.removeEventListener("keydown", this._onKey);
    navigator.connection?.removeEventListener?.("change", this._onNet);
    clearInterval(this._ticker);
    this._unsubscribe();
    this._active = false;
    this._stopThumbs();
    this._detachMain();
    this._clearBackground();
  }

  /* ---------- helpers ---------- */

  _q(sel) {
    return this.shadowRoot.querySelector(sel);
  }

  _cam(i = this._sel) {
    return this._config.cameras[i];
  }

  _friendly(cam) {
    return cam.name || this._hass?.states[cam.entity]?.attributes?.friendly_name || cam.entity;
  }

  _loadQuality() {
    try {
      const q = localStorage.getItem(QUALITY_KEY);
      return ["auto", "normal", "low"].includes(q) ? q : null;
    } catch (e) {
      return null;
    }
  }

  _effectiveQuality() {
    if (this._quality !== "auto") return this._quality;
    const c = navigator.connection;
    if (c && (c.saveData || ["slow-2g", "2g", "3g"].includes(c.effectiveType))) return "low";
    return "normal";
  }

  _pickEntity(cam, quality) {
    if (quality === "low") {
      const low = this._hass.states[cam.low_entity];
      if (low && low.state !== "unavailable") return { entity: cam.low_entity, low: true };
      return { entity: cam.entity, low: false, missing: true };
    }
    return { entity: cam.entity, low: false };
  }

  _picture(entity) {
    const st = this._hass?.states[entity];
    return st && st.state !== "unavailable" ? st.attributes.entity_picture : null;
  }

  _streamUrl(entity) {
    const pic = this._picture(entity);
    if (!pic) return null;
    return this._hass.hassUrl(pic.replace("/api/camera_proxy/", "/api/camera_proxy_stream/"));
  }

  _snapUrl(entity) {
    const pic = this._picture(entity);
    if (!pic) return null;
    return this._hass.hassUrl(`${pic}${pic.includes("?") ? "&" : "?"}_=${Date.now()}`);
  }

  /* ---------- build ---------- */

  _build() {
    const c = this._config;
    const [w, h] = String(c.aspect_ratio).split(":").map(Number);
    this.style.setProperty("--ar", w && h ? `${w} / ${h}` : "16 / 9");
    this.style.setProperty("--cols", c.grid_columns);
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="hdr">
          <div class="title"><span id="title"></span>
            <span class="alert" id="anyMotion" hidden><i class="dot"></i>Motion</span></div>
          <div class="tools">
            <div class="seg" id="viewSeg" ${c.timeline ? "" : "hidden"}>
              <button data-view="live" class="on">Live</button>
              <button data-view="timeline">Timeline</button>
            </div>
            <button class="pill" id="qBtn"></button>
          </div>
        </div>
        <div class="live" id="live">
          <div class="tile main" id="main">
            <img id="mainImg" alt="" draggable="false">
            <span class="alert mflag"><i class="dot"></i>Motion</span>
            <button class="fs" id="fs" title="Fullscreen"><ha-icon icon="mdi:fullscreen"></ha-icon></button>
            <div class="label" id="mainLabel"></div>
            <div class="badge" id="badge">HD</div>
            <div class="msg" id="msg"></div>
          </div>
          <div class="note" id="note" hidden></div>
          <div class="tbar" id="tbar" hidden></div>
          <div class="strip" id="strip" hidden></div>
          <div id="picker"></div>
        </div>
        <div id="timeline" hidden>
          <div class="tlbar">
            <div class="seg" id="tlFilter">
              <button data-f="all" class="on">All</button>
              <button data-f="video">Videos</button>
              <button data-f="image">Images</button>
            </div>
            <button class="pill" id="tlRefresh">Refresh</button>
          </div>
          <div class="tlbody" id="tlBody"></div>
        </div>
        <div class="modal" id="modal" hidden>
          <div class="mbar">
            <span class="sp" id="mTitle"></span>
            <button id="mPrev">&#8249; Newer</button>
            <button id="mNext">Older &#8250;</button>
            <a id="mDl" download target="_blank" rel="noopener">Download</a>
            <button id="mClose">Close</button>
          </div>
          <div class="mmedia" id="mMedia"></div>
        </div>
      </ha-card>`;

    this._q("#title").textContent = c.title || "";
    this._q(".hdr .title").style.display = c.title ? "" : "flex";
    this._q("#viewSeg").onclick = (e) => {
      const v = e.target.closest("button")?.dataset.view;
      if (v) this._setView(v);
    };
    this._q("#qBtn").onclick = () => this._cycleQuality();
    this._q("#fs").onclick = () => this._toggleFullscreen();
    this._q("#mainImg").ondblclick = () => this._toggleFullscreen();
    this._q("#mainImg").onload = (e) => {
      this._retry = 0;
      this._q("#msg").textContent = "";
      // match the tile to the camera's real aspect ratio so nothing is cropped or letterboxed
      const { naturalWidth: w, naturalHeight: h } = e.target;
      if (w > 0 && h > 0) {
        this._q("#main").style.setProperty("--ar", `${w} / ${h}`);
        // recording clips use one fixed shape (the selected camera's), whatever their thumbnail is
        this.style.setProperty("--item-ar", `${w} / ${h}`);
        this._arCache[this._cam().entity] = `${w} / ${h}`;
      }
    };
    this._q("#mainImg").onerror = () => this._mainError();
    this._q("#picker").onclick = (e) => {
      const el = e.target.closest("[data-i]");
      if (!el) return;
      // a deliberate choice: don't let select-on-motion yank the view away for a while
      this._lockUntil = Date.now() + this._config.select_on_motion_lock * 1000;
      this._select(Number(el.dataset.i));
    };
    this._q("#tlFilter").onclick = (e) => {
      const f = e.target.closest("button")?.dataset.f;
      if (!f) return;
      this._tlFilter = f;
      this._q("#tlFilter").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.f === f));
      this._renderTimeline();
    };
    this._q("#tlRefresh").onclick = () => this._loadTimeline(true);
    this._q("#strip").onclick = (e) => {
      const el = e.target.closest("[data-idx]");
      if (!el) return;
      this._tlVisible = this._stripItems; // modal prev/next walks the strip
      this._openModal(Number(el.dataset.idx));
    };
    this._q("#tlBody").onclick = (e) => {
      const el = e.target.closest("[data-idx]");
      if (el) this._openModal(Number(el.dataset.idx));
    };
    this._q("#strip").addEventListener(
      "scroll",
      () => {
        if (this._winRaf) return;
        this._winRaf = requestAnimationFrame(() => {
          this._winRaf = 0;
          this._updateStripWindow();
        });
      },
      { passive: true }
    );
    if (typeof ResizeObserver !== "undefined") {
      this._tbRO?.disconnect();
      this._tbRO = new ResizeObserver(() => this._snapBar());
      this._tbRO.observe(this._q("#tbar"));
    }
    this._q("#tbar").onclick = (e) => this._onBarClick(e);
    this._q("#tbar").onpointermove = (e) => this._onBarMove(e);
    this._q("#tbar").onpointerleave = () => {
      const tip = this._q(".tb-tip");
      if (tip) tip.hidden = true;
    };
    this._q("#mClose").onclick = () => this._closeModal();
    this._q("#mPrev").onclick = () => this._openModal(this._modalIdx - 1);
    this._q("#mNext").onclick = () => this._openModal(this._modalIdx + 1);

    this._stripSig = null;
    this._barSig = null;
    this._renderPicker();
    this._renderStrip(); // placeholders straight away, so the layout never jumps
    this._renderBar();
    this._updateQualityUi();
    this._mainKey = null;
    this._thumbKeys = [];
  }

  _renderPicker() {
    const c = this._config;
    const picker = this._q("#picker");
    if (c.layout === "grid") {
      picker.innerHTML = `<div class="grid">${c.cameras
        .map(
          (cam, i) => `<button class="tile thumb" data-i="${i}">
            <img alt="" draggable="false"><i class="mdot"></i>
            <span class="label">${esc(this._friendly(cam))}</span></button>`
        )
        .join("")}</div>`;
    } else {
      picker.innerHTML = `<div class="chips">${c.cameras
        .map((cam, i) => `<button class="chip" data-i="${i}">${esc(this._friendly(cam))}</button>`)
        .join("")}</div>`;
    }
    picker.querySelectorAll(".thumb img").forEach((img) => {
      img.onload = () => this._applyFit(img);
    });
    this._updateSelectionUi();
  }

  /* ---------- state updates ---------- */

  _afterHass() {
    if (!this._regLooked) {
      this._regLooked = true;
      this._lookupRegistry();
    }
    this._subscribe();
    this._updateStatus();
    if (this._active) this._connectMain(false);
    if (this._active && this._view === "live") {
      this._loadStrip();
      this._loadBar();
      this._prefetchStrips();
    }
  }

  _updateStatus() {
    const cam = this._cam();
    this._q("#mainLabel").textContent = this._friendly(cam);
    // refresh friendly names (they may arrive after first render)
    this.shadowRoot.querySelectorAll(".thumb .label, .chip").forEach((el) => {
      const i = Number(el.closest("[data-i]")?.dataset.i ?? el.dataset.i);
      const name = this._friendly(this._cam(i));
      if (el.textContent !== name) el.textContent = name;
    });
    this.shadowRoot.querySelectorAll(".thumb").forEach((el) => {
      const st = this._hass.states[this._cam(Number(el.dataset.i)).entity];
      el.classList.toggle("off", !st || st.state === "unavailable");
    });
    this._updateMotion();
  }

  _updateSelectionUi() {
    this.shadowRoot.querySelectorAll("[data-i]").forEach((el) => {
      el.classList.toggle("sel", Number(el.dataset.i) === this._sel);
    });
  }

  _updateQualityUi() {
    const q = this._quality;
    this._q("#qBtn").textContent = q === "auto" ? "Auto" : q === "low" ? "SD" : "HD";
    this._q("#qBtn").title = "Stream quality: tap to change (Auto / SD / HD)";
  }

  _select(i) {
    if (i === this._sel) return;
    this._sel = i;
    const ar = this._arCache[this._cam().entity];
    if (ar) {
      this._q("#main").style.setProperty("--ar", ar);
      this.style.setProperty("--item-ar", ar);
    }
    this._updateSelectionUi();
    this._updateStatus();
    this._connectMain(true);
    if (this._view === "timeline") this._loadTimeline();
    else {
      this._loadStrip();
      this._loadBar();
    }
  }

  _setView(v) {
    this._view = v;
    this._q("#viewSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    this._q("#live").hidden = v !== "live";
    this._q("#timeline").hidden = v !== "timeline";
    this._updateActive(true);
    if (v === "timeline") this._loadTimeline();
  }

  _cycleQuality() {
    const order = ["auto", "low", "normal"];
    this._quality = order[(order.indexOf(this._quality) + 1) % order.length];
    try {
      localStorage.setItem(QUALITY_KEY, this._quality);
    } catch (e) {
      /* ignore */
    }
    this._updateQualityUi();
    this._connectMain(true);
    this._refreshThumbs(); // tiles follow the new quality straight away
  }

  _toggleFullscreen() {
    const main = this._q("#main");
    if (main.requestFullscreen && !main.classList.contains("expanded")) {
      if (document.fullscreenElement) document.exitFullscreen();
      else main.requestFullscreen().catch(() => main.classList.add("expanded"));
    } else {
      main.classList.toggle("expanded");
    }
  }

  _updateActive(force = false) {
    const was = this._active;
    this._active = this.isConnected && this._visible !== false && !document.hidden;
    if (this._active === was && !force) return;
    if (this._active && this._view === "live") {
      this._connectMain(true);
      this._startThumbs();
      this._loadStrip();
      this._loadBar();
    } else {
      this._detachMain();
      this._stopThumbs();
    }
  }

  /* ---------- main MJPEG stream ---------- */

  _detachMain() {
    clearTimeout(this._retryTimer);
    const img = this._q("#mainImg");
    if (img && this._mainKey) img.removeAttribute("src"); // closes the MJPEG connection
    this._mainKey = null;
  }

  _connectMain(force = false) {
    if (!this._hass || !this._config) return;
    if (!this._active || this._view !== "live" || this._modalOpen) {
      this._detachMain();
      return;
    }
    const cam = this._cam();
    const q = this._effectiveQuality();
    const pick = this._pickEntity(cam, q);
    const key = `${pick.entity}|${this._sel}`;
    this._q("#badge").textContent = pick.low ? "SD" : "HD";
    const note = this._q("#note");
    note.hidden = !pick.missing;
    if (pick.missing) {
      note.textContent = `Low-res camera ${cam.low_entity} not found - showing full resolution. See README for the proxy camera YAML.`;
    }
    if (!force && key === this._mainKey) return;
    const url = this._streamUrl(pick.entity);
    const img = this._q("#mainImg");
    if (!url) {
      this._mainKey = null;
      img.removeAttribute("src");
      this._q("#msg").textContent = "Camera unavailable";
      return;
    }
    this._q("#msg").textContent = "Connecting\u2026";
    this._mainKey = key;
    img.src = url;
  }

  _mainError() {
    if (!this._mainKey) return;
    this._q("#msg").textContent = "Reconnecting\u2026";
    clearTimeout(this._retryTimer);
    const delay = Math.min(10000, 1500 * 2 ** this._retry++);
    this._retryTimer = setTimeout(() => this._connectMain(true), delay);
  }

  /* ---------- thumbnails ---------- */

  _startThumbs() {
    this._stopThumbs();
    if (this._config.layout !== "grid") return;
    this._refreshThumbs();
    if (this._config.thumb_mode === "snapshot") {
      this._thumbTimer = setInterval(() => this._refreshThumbs(), this._config.snapshot_interval * 1000);
    }
  }

  _stopThumbs() {
    clearInterval(this._thumbTimer);
    this._thumbTimer = null;
    this._thumbKeys = [];
    this.shadowRoot?.querySelectorAll(".thumb img").forEach((img) => {
      if (this._config?.thumb_mode === "stream") img.removeAttribute("src");
    });
  }

  _thumbEntity(cam) {
    return pickThumbEntity(cam, this._config.thumb_quality, this._effectiveQuality(), this._hass.states);
  }

  _refreshThumbs() {
    if (!this._hass || !this._active || this._view !== "live") return;
    const stream = this._config.thumb_mode === "stream";
    this.shadowRoot.querySelectorAll(".thumb").forEach((tile, n) => {
      const i = Number(tile.dataset.i);
      const entity = this._thumbEntity(this._cam(i));
      const img = tile.querySelector("img");
      if (stream) {
        if (this._thumbKeys[i] === entity) return;
        const url = this._streamUrl(entity);
        if (url) {
          this._thumbKeys[i] = entity;
          img.src = url;
        }
        return;
      }
      // stagger requests so we never exhaust the browser's per-host connection limit
      setTimeout(() => {
        const url = this._snapUrl(entity);
        if (!url || !this._active) return;
        const pre = new Image();
        pre.onload = () => {
          img.src = url;
        };
        pre.src = url;
      }, n * 250);
    });
  }

  /* ---------- motion ---------- */

  _isMotion(cam) {
    const bs = cam.motion_entity && this._hass?.states[cam.motion_entity];
    if (bs && bs.state === "on") return true;
    const ts = this._motionTs[cam.entity];
    return !!ts && Date.now() - ts < this._config.motion_hold * 1000;
  }

  _updateMotion() {
    if (!this._config || !this._hass || !this.shadowRoot.firstChild) return;
    let any = false;
    const flags = this._config.cameras.map((cam) => {
      const m = this._isMotion(cam);
      any = any || m;
      return m;
    });
    this._q("#main").classList.toggle("motion", flags[this._sel]);
    this.shadowRoot.querySelectorAll(".thumb, .chip").forEach((el) => {
      el.classList.toggle("motion", !!flags[Number(el.dataset.i)]);
    });
    this._q("#anyMotion").hidden = !any;
    // select-on-motion: a camera that has just started detecting motion becomes the main camera.
    // _prevMotion is stored first, so the re-entrant call made by _select() sees no new edge.
    const prev = this._prevMotion || [];
    this._prevMotion = flags;
    // new recordings usually appear ~20s after motion starts: refresh that camera's lists then
    flags.forEach((m, n) => {
      if (m && !prev[n]) this._scheduleRecordingsRefresh(this._cam(n));
    });
    if (
      this._config.select_on_motion &&
      this._view === "live" &&
      !this._modalOpen &&
      Date.now() >= (this._lockUntil || 0)
    ) {
      const i = firstRisingEdge(prev, flags);
      if (i >= 0 && i !== this._sel) this._select(i);
    }
  }

  _subscribe() {
    if (this._subbed || !this._hass?.connection || !this.isConnected) return;
    this._subbed = true;
    const tok = ++this._subTok;
    this._hass.connection
      .subscribeEvents((ev) => this._onMotionEvent(ev), "motioneye.motion_detected")
      .then((unsub) => {
        if (this._subbed && tok === this._subTok) this._unsubEv = unsub;
        else unsub();
      })
      .catch(() => {
        this._subbed = false;
      });
  }

  _unsubscribe() {
    this._subbed = false;
    this._subTok++;
    if (this._unsubEv) {
      this._unsubEv();
      this._unsubEv = null;
    }
  }

  _onMotionEvent(ev) {
    const d = ev?.data || {};
    for (const cam of this._config.cameras) {
      const info = this._regInfo[cam.entity] || {};
      const name = String(this._friendly(cam)).toLowerCase();
      if (
        (d.device_id && info.device_id === d.device_id) ||
        (d.name && String(d.name).toLowerCase() === name) ||
        d.entity_id === cam.entity
      ) {
        this._motionTs[cam.entity] = Date.now();
      }
    }
    this._updateMotion();
  }

  async _lookupRegistry() {
    for (const cam of this._config.cameras) {
      if (this._regInfo[cam.entity]) continue;
      this._regInfo[cam.entity] = {};
      try {
        const r = await this._hass.callWS({ type: "config/entity_registry/get", entity_id: cam.entity });
        this._regInfo[cam.entity] = { device_id: r.device_id, config_entry_id: r.config_entry_id };
      } catch (e) {
        /* non-admin users can't read the registry: fall back to name matching */
      }
    }
  }

  /* ---------- timeline ---------- */

  _browse(id) {
    return this._hass.callWS({ type: "media_source/browse_media", media_content_id: id });
  }

  async _signedUrl(url) {
    if (!url) return null;
    const base = this._hass.hassUrl();
    let path = url;
    if (/^https?:\/\//.test(url)) {
      if (!url.startsWith(base)) return url; // external URL, leave alone
      path = url.slice(base.length - (base.endsWith("/") ? 1 : 0));
    }
    if (path.includes("authSig=")) return this._hass.hassUrl(path);
    if (!this._sign.has(path)) {
      const p = this._hass
        .callWS({ type: "auth/sign_path", path, expires: 3600 })
        .then((r) => this._hass.hassUrl(r.path))
        .catch((e) => {
          this._sign.delete(path);
          throw e;
        });
      this._sign.set(path, p);
    }
    return this._sign.get(path);
  }

  async _findKinds(cam) {
    if (cam.movies_source || cam.images_source) {
      return { movies: cam.movies_source, images: cam.images_source };
    }
    if (this._srcCache[cam.entity]) return this._srcCache[cam.entity];
    await this._lookupRegistry();
    const info = this._regInfo[cam.entity] || {};
    const name = String(this._friendly(cam)).toLowerCase();
    const root = await this._browse("media-source://motioneye");
    const devices = [];
    const consider = (n) => devices.push(n);
    for (const entry of root.children || []) {
      if (!entry.can_expand) continue;
      // first level may already be the devices (single config entry) or config entries
      consider(entry);
    }
    let device = this._matchDevice(devices, info, name);
    if (!device) {
      const second = [];
      for (const entry of devices) {
        const node = await this._browse(entry.media_content_id);
        for (const d of node.children || []) if (d.can_expand) second.push(d);
      }
      device = this._matchDevice(second, info, name);
    }
    if (!device) {
      throw new Error(
        "Camera not found in the motionEye media source. Set movies_source / images_source for this camera."
      );
    }
    const node = await this._browse(device.media_content_id);
    const kids = node.children || [];
    const movies = kids.find((k) => /movie|video/i.test(k.title));
    const images = kids.find((k) => /image|picture|photo/i.test(k.title));
    const res = { movies: movies?.media_content_id, images: images?.media_content_id };
    this._srcCache[cam.entity] = res;
    return res;
  }

  _matchDevice(list, info, name) {
    return (
      (info.device_id && list.find((d) => String(d.media_content_id).includes(info.device_id))) ||
      list.find((d) => String(d.title || "").toLowerCase() === name) ||
      list.find((d) => {
        const t = String(d.title || "").toLowerCase();
        return t && (t.includes(name) || name.includes(t));
      })
    );
  }

  // maxDirs (top level only): how many of the newest sub-folders (days) to read; 0 = all
  async _collect(id, limit, trail, kind, depth = 0, maxDirs = 0) {
    const node = await this._browse(id);
    const kids = node.children || [];
    let out = kids
      .filter((k) => !k.can_expand)
      .map((k) => ({
        title: k.title,
        id: k.media_content_id,
        thumb: k.thumbnail,
        kind,
        ...parseTimestamp(k.title, trail, k.media_content_id),
      }))
      .sort(byTsDesc);
    if (depth < 4) {
      const dirs = kids
        .filter((k) => k.can_expand)
        .sort((a, b) => String(b.title).localeCompare(String(a.title), undefined, { numeric: true }));
      for (const d of depth === 0 && maxDirs ? dirs.slice(0, maxDirs) : dirs) {
        if (out.length >= limit) break;
        out = out.concat(await this._collect(d.media_content_id, limit - out.length, [...trail, d.title], kind, depth + 1));
      }
    }
    return out.slice(0, limit);
  }

  // Reads each of the newest `days` day-folders separately, capping each day at `perDay`
  // items, so one busy day can't crowd out the others.
  async _collectByDay(kindId, kind, days, perDay) {
    const node = await this._browse(kindId);
    const kids = node.children || [];
    const loose = kids
      .filter((k) => !k.can_expand)
      .map((k) => ({
        title: k.title,
        id: k.media_content_id,
        thumb: k.thumbnail,
        kind,
        ...parseTimestamp(k.title, [], k.media_content_id),
      }))
      .sort(byTsDesc)
      .slice(0, perDay);
    const dirs = kids
      .filter((k) => k.can_expand)
      .sort((a, b) => String(b.title).localeCompare(String(a.title), undefined, { numeric: true }));
    const use = days ? dirs.slice(0, days) : dirs;
    const results = [];
    for (let i = 0; i < use.length; i += 4) {
      const batch = use.slice(i, i + 4);
      results.push(
        ...(await Promise.all(batch.map((d) => this._collect(d.media_content_id, perDay + 1, [d.title], kind, 1))))
      );
    }
    let truncated = 0;
    const items = [...loose];
    for (const r of results) {
      if (r.length > perDay) truncated++;
      items.push(...r.slice(0, perDay));
    }
    return { items, days: use.length, available: dirs.length, truncated };
  }

  _tlInfoHtml(data) {
    const m = data.meta;
    if (!m) return "";
    const nV = data.items.filter((x) => x.kind === "video").length;
    const nI = data.items.length - nV;
    const loaded = Math.max(m.video.days, m.image.days);
    const avail = Math.max(m.video.available, m.image.available);
    let t = `${loaded} of ${avail} days loaded · ${nV} videos · ${nI} images`;
    if (m.video.truncated + m.image.truncated) {
      t += ` · busiest days capped at ${this._config.timeline_limit} per type (raise timeline_limit)`;
    } else if (this._config.timeline_days && avail > loaded) {
      t += " · raise timeline_days to see older days";
    }
    return `<div class="tlinfo">${esc(t)}</div>`;
  }

  async _loadTimeline(force = false) {
    const cam = this._cam();
    const key = cam.entity;
    const cached = this._tl[key];
    if (!force && cached && Date.now() - cached.at < 60000) {
      this._renderTimeline();
      return;
    }
    this._tlLoading = true;
    this._renderTimeline();
    const limit = this._config.timeline_limit;
    const days = this._config.timeline_days;
    try {
      const src = await this._findKinds(cam);
      const none = { items: [], days: 0, available: 0, truncated: 0 };
      const [vids, imgs] = await Promise.all([
        src.movies ? this._collectByDay(src.movies, "video", days, limit) : none,
        src.images ? this._collectByDay(src.images, "image", days, limit) : none,
      ]);
      this._tl[key] = {
        at: Date.now(),
        items: [...vids.items, ...imgs.items].sort(byTsDesc),
        error: null,
        meta: { video: vids, image: imgs },
      };
    } catch (e) {
      this._tl[key] = { at: Date.now(), items: [], error: e?.message || String(e) };
    }
    this._tlLoading = false;
    if (this._cam().entity === key) this._renderTimeline();
  }

  _dayLabel(dateKey) {
    if (!dateKey) return "Unknown date";
    const now = new Date();
    const y = new Date(now.getTime() - 864e5);
    if (dateKey === localDateKey(now)) return "Today";
    if (dateKey === localDateKey(y)) return "Yesterday";
    const [Y, M, D] = dateKey.split("-").map(Number);
    return new Date(Y, M - 1, D).toLocaleDateString(this._hass?.locale?.language, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  _renderTimeline() {
    const body = this._q("#tlBody");
    if (this._tlLoading) {
      body.innerHTML = `<div class="empty">Loading recordings\u2026</div>`;
      return;
    }
    const data = this._tl[this._cam().entity];
    if (!data) return;
    if (data.error) {
      body.innerHTML = `<div class="empty"><b>Couldn't load recordings</b>${esc(data.error)}</div>`;
      return;
    }
    const f = this._tlFilter;
    this._tlVisible = data.items.filter((it) => f === "all" || it.kind === f);
    if (!this._tlVisible.length) {
      body.innerHTML = `<div class="empty"><b>No ${f === "all" ? "recordings" : f + "s"} found</b>Check that motionEye is storing media and that the media source is enabled.</div>`;
      return;
    }
    const groups = [];
    this._tlVisible.forEach((it, idx) => {
      const last = groups[groups.length - 1];
      if (last && last.key === it.dateKey) last.items.push([it, idx]);
      else groups.push({ key: it.dateKey, items: [[it, idx]] });
    });
    body.innerHTML =
      this._tlInfoHtml(data) +
      groups
      .map(
        (g) => `<div class="day">${esc(this._dayLabel(g.key))}</div>
        <div class="items">${g.items
          .map(
            ([it, idx]) => `<button class="item" data-idx="${idx}">
              ${it.thumb ? `<img alt="" loading="lazy" data-src="${esc(it.thumb)}">` : ""}
              <div class="ph"><ha-icon icon="${it.kind === "video" ? "mdi:movie-outline" : "mdi:image-outline"}"></ha-icon></div>
              <span class="k"><ha-icon icon="${it.kind === "video" ? "mdi:play" : "mdi:camera"}"></ha-icon></span>
              <span class="t">${esc(it.time || it.title)}</span></button>`
          )
          .join("")}</div>`
      )
      .join("");
    this._lazyThumbs(body, "_thumbIO", null, "300px");
  }

  // size a tile to its image's real aspect ratio so nothing is cropped or letterboxed
  _applyFit(img) {
    const tile = img.closest(".thumb");
    const { naturalWidth: w, naturalHeight: h } = img;
    if (!tile || !(w > 0 && h > 0)) return;
    const ar = `${w} / ${h}`;
    if (tile.dataset.ar !== ar) {
      tile.dataset.ar = ar;
      tile.style.setProperty("--ar", ar);
    }
  }

  // sign + load thumbnails only as they scroll into view (hundreds of items are common)
  _lazyThumbs(container, ioKey, root, margin) {
    this[ioKey]?.disconnect();
    container.querySelectorAll("img[data-src]").forEach((img) => {
      img.onload = () => {
        const item = img.closest(".item");
        if (!item) return;
        item.classList.add("loaded"); // hides the icon placeholder
        const { naturalWidth: w, naturalHeight: h } = img;
        const box = item.clientWidth && item.clientHeight ? item.clientWidth / item.clientHeight : 16 / 9;
        item.classList.toggle("cover", fitMode(w / h, box) === "cover");
      };
      img.onerror = () => img.remove(); // broken thumbnail: the small icon placeholder stays
    });
    const load = (img) =>
      this._thumbSrc(img.dataset.src)
        .then((u) => {
          if (u) img.src = u;
        })
        .catch(() => img.remove());
    const imgs = container.querySelectorAll("img[data-src]");
    if (typeof IntersectionObserver === "undefined") {
      imgs.forEach(load);
      return;
    }
    this[ioKey] = new IntersectionObserver(
      (entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          obs.unobserve(e.target);
          load(e.target);
        }
      },
      { root, rootMargin: margin }
    );
    imgs.forEach((img) => this[ioKey].observe(img));
  }

  /* ---------- recordings strip (under the main image) ---------- */

  _stripFresh(d) {
    return !!d && Date.now() - d.at < (d.error ? STRIP_ERROR_TTL : STRIP_TTL);
  }

  // Show the strip at once (cached data even if stale, otherwise placeholders), then refresh
  // it in the background if it is out of date.
  async _loadStrip(force = false) {
    if (!this._config.strip || !this._hass) return;
    const cam = this._cam();
    this._renderStrip();
    if (!force && this._stripFresh(this._strip[cam.entity])) return;
    await this._refreshStrip(cam);
  }

  async _fetchStrip(cam) {
    const c = this._config;
    const lim = c.strip_limit;
    const src = await this._findKinds(cam);
    const [movies, images] = await Promise.all([
      c.strip_content !== "snapshots" && src.movies ? this._collect(src.movies, lim, [], "video") : [],
      c.strip_content !== "videos" && src.images ? this._collect(src.images, lim, [], "image") : [],
    ]);
    const items = [...movies, ...images].sort(byTsDesc).slice(0, lim);
    return { at: Date.now(), items, error: null, fp: fingerprint(items) };
  }

  async _refreshStrip(cam) {
    const key = cam.entity;
    if (this._stripBusy.has(key)) return;
    this._stripBusy.add(key);
    const gen = this._gen;
    const old = this._strip[key];
    try {
      const entry = await this._fetchStrip(cam);
      if (gen !== this._gen) return;
      this._strip[key] = entry;
      this._preloadStripThumbs(entry.items);
    } catch (e) {
      if (gen !== this._gen) return;
      // if a refresh fails, keep showing what we already have
      this._strip[key] =
        old && !old.error
          ? { ...old, at: Date.now() }
          : { at: Date.now(), items: [], error: e?.message || String(e), fp: "error" };
    } finally {
      this._stripBusy.delete(key);
    }
    if (gen === this._gen && this._cam().entity === key) this._renderStrip();
  }

  // Load the other cameras' strips (and day bars) one at a time, so switching camera is instant.
  async _prefetchStrips() {
    const c = this._config;
    if ((!c.strip && !c.timeline_bar) || !c.strip_prefetch || this._prefetching || c.cameras.length < 2) return;
    const selected = this._cam().entity;
    // the camera on screen always goes first
    if (c.strip && !this._strip[selected]) return;
    if (c.timeline_bar && !this._bar[selected] && !this._barErr[selected]) return;
    const now = Date.now();
    // the bar's lists are bigger than the strip's, so skip them on a slow / data-saving connection
    const barToo = c.timeline_bar && this._effectiveQuality() !== "low";
    const todo = c.cameras.filter((cam) => {
      if (cam.entity === selected) return false;
      const stale =
        (c.strip && !this._stripFresh(this._strip[cam.entity])) || (barToo && !this._barFresh(cam.entity));
      if (!stale) return false;
      const failed = this._prefetchFail[cam.entity];
      return !(failed && now - failed < 300000); // don't hammer a camera that keeps failing
    });
    if (!todo.length) return;
    this._prefetching = true;
    const gen = this._gen;
    try {
      for (const cam of todo) {
        if (gen !== this._gen || !this._active || this._view !== "live") break;
        if (c.strip && !this._stripFresh(this._strip[cam.entity])) await this._refreshStrip(cam);
        if (barToo && !this._barFresh(cam.entity)) await this._refreshBar(cam);
        if (this._strip[cam.entity]?.error || this._barErr[cam.entity]) this._prefetchFail[cam.entity] = Date.now();
        await new Promise((r) => setTimeout(r, 400)); // be gentle with Home Assistant and motionEye
      }
    } finally {
      if (gen === this._gen) this._prefetching = false;
    }
  }

  _scheduleRecordingsRefresh(cam) {
    clearTimeout(this._refreshTimers[cam.entity]);
    this._refreshTimers[cam.entity] = setTimeout(() => {
      delete this._tl[cam.entity];
      const selected = this._cam().entity === cam.entity;
      if (selected && this._view === "timeline") this._loadTimeline(true);
      else if (selected) {
        this._loadStrip(true);
        this._loadBar(true);
      }
      if (!selected || this._view === "timeline") {
        // mark stale: refreshed in the background (or when this camera is next selected)
        if (this._strip[cam.entity]) this._strip[cam.entity].at = 0;
        if (this._bar[cam.entity]) this._bar[cam.entity].at = 0;
      }
    }, 20000);
  }

  /* ---------- background thumbnail preloading ---------- */

  _preloadStripThumbs(items) {
    // on a slow or data-saving connection only the thumbnails you can see are fetched
    if (this._effectiveQuality() === "low") return;
    for (const it of items.slice(0, PRELOAD_PER_CAMERA)) if (it.thumb) this._preloadThumb(it.thumb);
  }

  _preloadThumb(raw) {
    if (this._blobs.has(raw) || this._blobPending.has(raw)) return;
    let done;
    this._blobPending.set(raw, new Promise((r) => (done = r)));
    this._preQueue.push({ raw, done });
    this._pumpPreload();
  }

  _pumpPreload() {
    while (this._preActive < 2 && this._preQueue.length) {
      const { raw, done } = this._preQueue.shift();
      const gen = this._gen;
      this._preActive++;
      this._signedUrl(raw)
        .then((url) => fetch(url))
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.blob();
        })
        .then((blob) => {
          if (gen === this._gen) this._storeBlob(raw, blob);
        })
        .catch(() => {})
        .finally(() => {
          this._blobPending.delete(raw);
          this._preActive--;
          done();
          this._pumpPreload();
        });
    }
  }

  _storeBlob(raw, blob) {
    this._blobs.set(raw, URL.createObjectURL(blob));
    if (this._blobs.size > MAX_BLOBS) {
      const [oldKey, oldUrl] = this._blobs.entries().next().value;
      URL.revokeObjectURL(oldUrl);
      this._blobs.delete(oldKey);
    }
  }

  // The image URL to use for a thumbnail: the preloaded copy if there is one.
  async _thumbSrc(raw) {
    if (this._blobs.has(raw)) return this._blobs.get(raw);
    if (this._blobPending.has(raw)) {
      const queued = this._preQueue.findIndex((x) => x.raw === raw);
      if (queued >= 0) {
        // not started yet: a thumbnail you can see goes ahead of the background queue
        const [job] = this._preQueue.splice(queued, 1);
        this._blobPending.delete(raw);
        job.done();
      } else {
        await this._blobPending.get(raw); // already downloading: reuse it
        if (this._blobs.has(raw)) return this._blobs.get(raw);
      }
    }
    return this._signedUrl(raw);
  }

  _clearBackground() {
    this._gen++; // abandon any in-flight background work
    this._prefetching = false;
    for (const t of Object.values(this._refreshTimers)) clearTimeout(t);
    this._refreshTimers = {};
    for (const job of this._preQueue) job.done();
    this._preQueue = [];
    this._blobPending.clear();
    for (const u of this._blobs.values()) URL.revokeObjectURL(u);
    this._blobs.clear();
  }

  /* ---------- recordings strip rendering ---------- */

  _stripLabel(it) {
    const t = it.time || it.title;
    if (!it.dateKey || it.dateKey === localDateKey(new Date())) return t;
    const [Y, M, D] = it.dateKey.split("-").map(Number);
    const day = new Date(Y, M - 1, D).toLocaleDateString(this._hass?.locale?.language, { day: "numeric", month: "short" });
    return `${day} ${t}`;
  }

  // Same-size stand-ins for clips, so the strip keeps its height while loading and in empty states
  _stripPlaceholders() {
    return Array.from(
      { length: 8 },
      () => `<div class="item skel" aria-hidden="true"><div class="ph"><ha-icon icon="mdi:image-outline"></ha-icon></div></div>`
    ).join("");
  }

  _stripMessage(html) {
    return `<div class="item spacer" aria-hidden="true"></div><div class="sempty">${html}</div>`;
  }

  _renderStrip() {
    const el = this._q("#strip");
    if (!el) return;
    el.hidden = !this._config.strip;
    if (!this._config.strip) return;
    const key = this._cam().entity;
    const d = this._strip[key];
    const sig = `${key}|${d ? d.fp : "none"}`;
    if (sig === this._stripSig) return;
    const sameCam = this._stripSig?.split("|")[0] === key;
    const keepScroll = sameCam ? el.scrollLeft : 0;
    this._stripSig = sig;
    this._stripItems = d ? d.items : [];
    if (!d) {
      el.innerHTML = this._stripPlaceholders();
      el.scrollLeft = 0;
      this._updateStripWindow();
      return;
    }
    if (d.error) {
      el.innerHTML = this._stripMessage(`Recordings unavailable: ${esc(d.error)}`);
      return;
    }
    if (!d.items.length) {
      el.innerHTML = this._stripMessage("No recordings yet");
      return;
    }
    el.innerHTML = d.items
      .map(
        (it, idx) => `<button class="item" data-idx="${idx}">
          ${it.thumb ? `<img alt="" data-src="${esc(it.thumb)}">` : ""}
          <div class="ph"><ha-icon icon="${it.kind === "video" ? "mdi:movie-outline" : "mdi:image-outline"}"></ha-icon></div>
          <span class="k"><ha-icon icon="${it.kind === "video" ? "mdi:play" : "mdi:camera"}"></ha-icon></span>
          <span class="t">${esc(this._stripLabel(it))}</span></button>`
      )
      .join("");
    el.scrollLeft = keepScroll;
    this._lazyThumbs(el, "_stripIO", el, "0px 200px");
    this._updateStripWindow();
  }

  /* ---------- 24-hour timeline bar (under the recordings strip) ---------- */
  // A rolling window: "now" is at the far left and time runs back to 24 hours ago on the right.

  _barFresh(key) {
    const failed = this._barFail[key];
    if (failed && Date.now() - failed < 30000) return true; // recently failed: don't retry on every update
    const d = this._bar[key];
    return !!d && Date.now() - d.at < BAR_TTL;
  }

  async _loadBar(force = false) {
    if (!this._config.timeline_bar || !this._hass) return;
    const cam = this._cam();
    this._renderBar(); // cached data (even if stale) or a placeholder, straight away
    if (!force && this._barFresh(cam.entity)) return;
    await this._refreshBar(cam);
  }

  // Which days have recordings, and where each day's folder is (two small requests).
  async _barListDays(cam) {
    const src = await this._findKinds(cam);
    const list = async (rootId, kind) => {
      const out = { dirs: {}, loose: [] };
      if (!rootId) return out;
      const node = await this._browse(rootId);
      for (const k of node.children || []) {
        if (k.can_expand) {
          const dk = parseTimestamp(k.title, [], "").dateKey;
          if (dk) out.dirs[dk] = k.media_content_id;
        } else {
          out.loose.push({
            title: k.title,
            id: k.media_content_id,
            thumb: k.thumbnail,
            kind,
            ...parseTimestamp(k.title, [], k.media_content_id),
          });
        }
      }
      return out;
    };
    const [m, i] = await Promise.all([list(src.movies, "video"), list(src.images, "image")]);
    const days = new Set([...Object.keys(m.dirs), ...Object.keys(i.dirs)]);
    for (const x of [...m.loose, ...i.loose]) if (x.dateKey) days.add(x.dateKey);
    return {
      at: Date.now(),
      days: [...days].sort().reverse(),
      dirs: { video: m.dirs, image: i.dirs },
      loose: { video: m.loose, image: i.loose },
    };
  }

  async _barLoadDay(cam, day, idx) {
    const c = this._config;
    const perDay = c.timeline_limit;
    const want = (kind) => c.strip_content === "both" || (c.strip_content === "videos" ? kind === "video" : kind === "image");
    const one = async (kind) => {
      if (!want(kind)) return [];
      const dirId = idx.dirs[kind][day];
      const fromDir = dirId ? await this._collect(dirId, perDay, [day], kind, 1) : [];
      return fromDir.concat(idx.loose[kind].filter((x) => x.dateKey === day));
    };
    const [v, im] = await Promise.all([one("video"), one("image")]);
    const items = [...v, ...im].filter((x) => x.ts != null).sort(byTsDesc);
    return {
      at: Date.now(),
      items,
      fp: fingerprint(items),
      capped: { video: v.length >= perDay, image: im.length >= perDay },
    };
  }

  async _refreshBar(cam) {
    const key = cam.entity;
    if (this._barBusy.has(key)) return;
    this._barBusy.add(key);
    const gen = this._gen;
    try {
      const idx = await this._barListDays(cam);
      if (gen !== this._gen) return;
      const now = Date.now();
      const since = now - 864e5;
      // the 24 hours reach back into yesterday (or earlier, if the clock moved)
      const wanted = [...new Set([localDateKey(new Date(now)), localDateKey(new Date(since))])].filter((d) => idx.days.includes(d));
      const parts = [];
      for (const day of wanted) parts.push(await this._barLoadDay(cam, day, idx));
      if (gen !== this._gen) return;
      const items = parts.flatMap((x) => x.items).filter((x) => x.ts >= since - 6e4).sort(byTsDesc);
      this._bar[key] = {
        at: Date.now(),
        items,
        fp: fingerprint(items),
        capped: { video: parts.some((x) => x.capped.video), image: parts.some((x) => x.capped.image) },
      };
      this._barErr[key] = null;
      delete this._barFail[key];
    } catch (e) {
      if (gen !== this._gen) return;
      this._barFail[key] = Date.now();
      if (!this._bar[key]) this._barErr[key] = e?.message || String(e); // otherwise keep what we have
    } finally {
      this._barBusy.delete(key);
    }
    if (gen === this._gen && this._cam().entity === key) this._renderBar();
  }

  // force = true redraws even if the recordings are unchanged (the window has moved on)
  _renderBar(force = false) {
    const el = this._q("#tbar");
    if (!el) return;
    const c = this._config;
    el.hidden = !c.timeline_bar;
    if (!c.timeline_bar) return;
    const key = this._cam().entity;
    const d = this._bar[key];
    const err = this._barErr[key];
    const sig = [key, d ? d.fp : "none", err || ""].join("|");
    if (sig === this._barSig && !force) return;
    this._barSig = sig;
    const now = Date.now();
    const items = d ? d.items.filter((i) => rollFrac(i.ts, now) <= 1) : [];
    this._barItems = items;
    this._barNow = now;
    let inner = "";
    if (d) {
      const spans = mergeSpans(items.map((i) => i.ts), 5 * 60000, 60000);
      inner += spans
        .map((sp) => {
          const f1 = rollFrac(sp.end, now);
          const f2 = Math.min(1, rollFrac(sp.start, now));
          return `<i class="sp" style="left:${pct(f1)};width:${pct(f2 - f1)}"></i>`;
        })
        .join("");
      inner += items.map((i) => `<i class="tk ${i.kind}" data-f="${rollFrac(i.ts, now).toFixed(6)}" style="left:${pct(rollFrac(i.ts, now))}"></i>`).join("");
      inner += `<i class="cur" hidden></i>`;
    }
    inner += `<i class="win" hidden></i>`;
    const axis = rollingMarks(now, 3)
      .map((m, n) => `<span${n === 0 ? ' class="first"' : ""} style="left:${pct(m.frac)}">${m.label}</span>`)
      .join("");
    el.innerHTML = `
      <div class="tb-wrap">
        <div class="tb-axis">${axis}</div>
        <div class="tb-bar${d || err ? "" : " skel"}" ${err ? `title="${esc(err)}"` : ""}>${inner}</div>
        <div class="tb-tip" hidden></div>
      </div>`;
    this._placeBarCursor();
    this._snapBar();
    this._updateStripWindow();
  }

  // Put the markers on whole device pixels so their edges stay sharp instead of being smeared across two.
  _snapBar() {
    const bar = this._q(".tb-bar");
    if (!bar || !bar.clientWidth) return;
    const w = bar.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    const snap = (f) => `${Math.round(f * w * dpr) / dpr}px`;
    bar.querySelectorAll(".tk[data-f]").forEach((n) => {
      n.style.left = snap(+n.dataset.f);
    });
    const cur = bar.querySelector(".cur:not([hidden])");
    if (cur && cur.dataset.f) cur.style.left = snap(+cur.dataset.f);
  }

  // Highlight, on the bar, the span of time covered by the clips currently visible in the strip.
  _updateStripWindow() {
    const win = this._q(".tb-bar .win");
    const strip = this._q("#strip");
    if (!win) return;
    const items = this._stripItems || [];
    let first = Infinity;
    let last = -Infinity;
    if (strip && !strip.hidden && this._barNow && items.length) {
      const view = strip.getBoundingClientRect();
      strip.querySelectorAll(".item[data-idx]").forEach((n) => {
        const r = n.getBoundingClientRect();
        const mid = (r.left + r.right) / 2;
        const ts = items[+n.dataset.idx]?.ts;
        if (ts == null || mid < view.left || mid > view.right) return;
        first = Math.min(first, rollFrac(ts, this._barNow)); // newest = nearest the left
        last = Math.max(last, rollFrac(ts, this._barNow));
      });
    }
    if (first === Infinity || first > 1) {
      win.hidden = true;
      return;
    }
    const pad = 0.004;
    const f1 = Math.max(0, first - pad);
    const f2 = Math.min(1, last + pad);
    win.style.left = pct(f1);
    win.style.width = pct(Math.max(0, f2 - f1));
    win.hidden = false;
  }

  // the window moves with the clock, so redraw it every so often
  _updateBarNow() {
    if (this._config?.timeline_bar && this._active !== false) this._renderBar(true);
  }

  _setBarCursor(ts) {
    this._barCursor = { key: this._cam().entity, ts };
    this._placeBarCursor();
  }

  _placeBarCursor() {
    const cur = this._q(".tb-bar .cur");
    if (!cur || !this._barCursor || this._barCursor.key !== this._cam().entity) return;
    const f = rollFrac(this._barCursor.ts, this._barNow || Date.now());
    cur.hidden = f < 0 || f > 1;
    if (!cur.hidden) {
      cur.dataset.f = f.toFixed(6);
      cur.style.left = pct(f);
      this._snapBar();
    }
  }

  // Time under a pointer, and the recording nearest to it (within about a fingertip).
  _barHit(clientX) {
    const bar = this._q(".tb-bar");
    const r = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    const t = this._barNow - frac * 864e5;
    return { t, i: nearestIndex(this._barItems, t, (14 / (r.width || 1)) * 864e5) };
  }

  _showBarTip(text, clientX) {
    const tip = this._q(".tb-tip");
    const wrap = this._q(".tb-wrap");
    if (!tip || !wrap) return;
    const r = wrap.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = `${Math.min(r.width - 30, Math.max(30, clientX - r.left))}px`;
    tip.hidden = false;
  }

  _onBarMove(e) {
    const tip = this._q(".tb-tip");
    if (!tip) return;
    if (e.pointerType !== "mouse" || !this._barNow || !e.target.closest(".tb-bar")) {
      tip.hidden = true;
      return;
    }
    const { t, i } = this._barHit(e.clientX);
    const kind = i >= 0 ? (this._barItems[i].kind === "video" ? " · video" : " · snapshot") : "";
    this._showBarTip(fmtClock(i >= 0 ? this._barItems[i].ts : t) + kind, e.clientX);
  }

  _onBarClick(e) {
    if (!e.target.closest(".tb-bar") || !this._barNow) return;
    const { t, i } = this._barHit(e.clientX);
    if (i >= 0) {
      this._setBarCursor(this._barItems[i].ts);
      this._tlVisible = this._barItems;
      this._openModal(i);
    } else {
      this._setBarCursor(t);
      this._showBarTip(`${fmtClock(t)} · no recording`, e.clientX);
      clearTimeout(this._barTipTimer);
      this._barTipTimer = setTimeout(() => {
        const tip = this._q(".tb-tip");
        if (tip) tip.hidden = true;
      }, 1500);
    }
  }

  /* ---------- media modal ---------- */

  async _openModal(idx) {
    const item = this._tlVisible[idx];
    if (!item) return;
    this._modalIdx = idx;
    this._modalOpen = true;
    if (this._tlVisible === this._barItems && item.ts != null) this._setBarCursor(item.ts);
    this._connectMain(); // pause the live stream while a recording is open
    this._q("#modal").hidden = false;
    this._q("#mPrev").disabled = idx <= 0;
    this._q("#mNext").disabled = idx >= this._tlVisible.length - 1;
    this._q("#mTitle").textContent = `${this._friendly(this._cam())} \u00b7 ${this._dayLabel(item.dateKey)} ${item.time || ""}`;
    const holder = this._q("#mMedia");
    holder.innerHTML = `<div class="msg" style="position:static;color:#ccc">Loading\u2026</div>`;
    const dl = this._q("#mDl");
    dl.removeAttribute("href");
    try {
      const r = await this._hass.callWS({ type: "media_source/resolve_media", media_content_id: item.id, expires: 3600 });
      if (this._modalIdx !== idx || !this._modalOpen) return;
      const url = await this._signedUrl(r.url);
      const isVideo = item.kind === "video" || /^video\//.test(r.mime_type || "");
      holder.innerHTML = isVideo
        ? `<video controls autoplay playsinline src="${esc(url)}"></video>`
        : `<img alt="" src="${esc(url)}">`;
      dl.href = url;
    } catch (e) {
      holder.innerHTML = `<div class="msg" style="position:static;color:#ccc">Couldn't load this item</div>`;
    }
  }

  _closeModal() {
    this._modalOpen = false;
    const v = this._q("#mMedia video");
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    this._q("#mMedia").innerHTML = "";
    this._q("#modal").hidden = true;
    this._connectMain(true); // resume live view (no-op if not on the live tab)
  }
}

/* ------------------------------------------------------------------ */
/* Visual editor                                                       */
/* ------------------------------------------------------------------ */

class MotionEyeCameraCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    (this._camForms || []).forEach((f) => (f.hass = hass));
  }

  _camSchema() {
    return [
      { name: "name", selector: { text: {} } },
      { name: "low_entity", selector: { entity: { domain: "camera" } } },
      { name: "motion_entity", selector: { entity: { domain: ["binary_sensor", "input_boolean"] } } },
    ];
  }

  // One collapsible section per camera for its own options (name, low-res camera, motion sensor).
  _renderCameras() {
    const box = this._camBox;
    const entities = this._entities();
    const key = JSON.stringify(this._config.cameras || []);
    if (this._camKey === key) return; // nothing changed from outside, so leave what the user is typing alone
    this._camKey = key;
    box.innerHTML = "";
    this._camForms = [];
    if (!entities.length) return;
    const h = document.createElement("div");
    h.style.cssText = "font-weight:500;margin:16px 0 4px";
    h.textContent = "Camera options";
    box.appendChild(h);
    (this._config.cameras || []).forEach((cam) => {
      const entity = typeof cam === "string" ? cam : cam.entity;
      if (!entity) return;
      const obj = typeof cam === "string" ? {} : cam;
      const det = document.createElement("details");
      det.style.cssText = "border:1px solid var(--divider-color);border-radius:8px;padding:4px 12px;margin-bottom:8px";
      const sum = document.createElement("summary");
      sum.style.cssText = "cursor:pointer;padding:8px 0";
      sum.textContent = obj.name ? `${obj.name} (${entity})` : entity;
      det.appendChild(sum);
      const form = document.createElement("ha-form");
      form.hass = this._hass;
      form.schema = this._camSchema();
      form.computeLabel = (sc) =>
        ({
          name: "Display name (blank = the camera's name)",
          low_entity: `Low-res camera (blank = camera.${entity.slice(7)}_low)`,
          motion_entity: "Motion sensor (blank = motionEye motion events)",
        }[sc.name] || sc.name);
      form.data = { name: obj.name || "", low_entity: obj.low_entity || "", motion_entity: obj.motion_entity || "" };
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._cameraChanged(entity, ev.detail.value);
      });
      det.appendChild(form);
      box.appendChild(det);
      this._camForms.push(form);
    });
  }

  _cameraChanged(entity, fields) {
    const cameras = (this._config.cameras || []).map((c) => {
      const e = typeof c === "string" ? c : c.entity;
      return e === entity ? buildCamera(entity, c, fields) : c;
    });
    this._emit({ ...this._config, cameras }, false);
  }

  _emit(config, rebuildCameras = true) {
    this._config = config;
    if (!rebuildCameras) this._camKey = JSON.stringify(config.cameras || []); // keep the open forms as they are
    this._yaml.querySelector("pre").textContent = proxyYaml(this._entities());
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _entities() {
    return (this._config.cameras || []).map((c) => (typeof c === "string" ? c : c.entity)).filter(Boolean);
  }

  _schema() {
    const sel = (options) => ({ select: { mode: "dropdown", options } });
    return [
      { name: "title", selector: { text: {} } },
      { name: "camera_entities", selector: { entity: { domain: "camera", multiple: true } } },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "layout", selector: sel([{ value: "grid", label: "Grid" }, { value: "single", label: "Single + chips" }]) },
          {
            name: "default_quality",
            selector: sel([
              { value: "auto", label: "Auto" },
              { value: "normal", label: "HD (normal)" },
              { value: "low", label: "SD (low-res proxy)" },
            ]),
          },
          { name: "thumb_mode", selector: sel([{ value: "snapshot", label: "Snapshots" }, { value: "stream", label: "Live streams" }]) },
          {
            name: "thumb_quality",
            selector: sel([
              { value: "follow", label: "Follow HD/SD button" },
              { value: "low", label: "Always low-res (SD)" },
              { value: "normal", label: "Always full-res (HD)" },
            ]),
          },
          { name: "grid_columns", selector: { number: { min: 1, max: 4, mode: "box" } } },
          { name: "snapshot_interval", selector: { number: { min: 1, max: 60, unit_of_measurement: "s", mode: "box" } } },
          { name: "motion_hold", selector: { number: { min: 0, max: 600, unit_of_measurement: "s", mode: "box" } } },
          { name: "timeline_days", selector: { number: { min: 0, max: 365, unit_of_measurement: "days", mode: "box" } } },
          {
            name: "strip_content",
            selector: sel([
              { value: "both", label: "Videos and snapshots" },
              { value: "videos", label: "Videos only" },
              { value: "snapshots", label: "Snapshots only" },
            ]),
          },
          { name: "strip_limit", selector: { number: { min: 1, max: 100, mode: "box" } } },
        ],
      },
      { name: "select_on_motion", selector: { boolean: {} } },
      { name: "select_on_motion_lock", selector: { number: { min: 0, max: 3600, unit_of_measurement: "s", mode: "box" } } },
      { name: "strip", selector: { boolean: {} } },
      { name: "strip_prefetch", selector: { boolean: {} } },
      { name: "timeline_bar", selector: { boolean: {} } },
      { name: "timeline", selector: { boolean: {} } },
    ];
  }

  _render() {
    if (!this._form) {
      this.innerHTML = "";
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) =>
        ({
          title: "Title",
          camera_entities: "Cameras",
          layout: "Layout",
          default_quality: "Default quality",
          thumb_mode: "Thumbnail mode",
          grid_columns: "Grid columns",
          snapshot_interval: "Snapshot interval",
          motion_hold: "Motion indicator hold",
          timeline_days: "Timeline days (0 = all)",
          strip: "Show recordings strip under the main image",
          strip_prefetch: "Load other cameras' recordings in the background",
          timeline_bar: "Show the 24-hour timeline bar above the strip",
          strip_content: "Strip content",
          strip_limit: "Strip items",
          thumb_quality: "Grid tile quality",
          select_on_motion: "Select a camera as the main camera when it detects motion",
          select_on_motion_lock: "Pause auto-select after you pick a camera",
          timeline: "Show timeline tab",
        }[s.name] || s.name);
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._changed(ev.detail.value);
      });
      this.appendChild(this._form);
      this._camBox = document.createElement("div");
      this.appendChild(this._camBox);
      this._yaml = document.createElement("details");
      this._yaml.style.marginTop = "16px";
      this._yaml.innerHTML = `<summary style="cursor:pointer">Low-resolution proxy cameras (YAML)</summary>
        <p style="font-size:.85rem;opacity:.8">Home Assistant's <code>proxy</code> camera can only be created in YAML.
        Add this to <code>configuration.yaml</code> (merge with any existing <code>camera:</code> section), restart,
        and the card will pick up <code>camera.&lt;name&gt;_low</code> automatically.</p>
        <pre style="white-space:pre-wrap;font-size:.8rem;background:var(--secondary-background-color);padding:8px;border-radius:6px"></pre>
        <button style="margin-top:6px">Copy YAML</button>`;
      this._yaml.querySelector("button").onclick = async () => {
        try {
          await navigator.clipboard.writeText(this._yaml.querySelector("pre").textContent);
          this._yaml.querySelector("button").textContent = "Copied";
        } catch (e) {
          /* clipboard unavailable */
        }
      };
      this.appendChild(this._yaml);
    }
    this._form.hass = this._hass;
    this._form.schema = this._schema();
    this._form.data = {
      ...DEFAULT_CONFIG,
      ...this._config,
      camera_entities: this._entities(),
    };
    this._yaml.querySelector("pre").textContent = proxyYaml(this._entities());
    this._renderCameras();
  }

  _changed(value) {
    const { camera_entities, ...rest } = value;
    const existing = new Map((this._config.cameras || []).map((c) => [typeof c === "string" ? c : c.entity, c]));
    const config = {
      ...this._config,
      ...rest,
      type: this._config.type || `custom:${CARD_TAG}`,
      cameras: (camera_entities || []).map((e) => existing.get(e) || e),
    };
    delete config.thumb_low_res; // replaced by thumb_quality in 1.1.0
    this._emit(config, true);
    this._renderCameras();
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

if (typeof window !== "undefined" && typeof customElements !== "undefined" && !customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, MotionEyeCameraCard);
  customElements.define(`${CARD_TAG}-editor`, MotionEyeCameraCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TAG,
    name: "MotionEye Camera Card",
    description: "Multi-camera MJPEG view with SD/HD switching, motion indication and a motionEye image/video timeline.",
    documentationURL: "https://github.com/tescophil/motioneye-camera-card",
  });
  console.info(`%c MOTIONEYE-CAMERA-CARD %c v${CARD_VERSION} `, "color:#fff;background:#03a9f4;font-weight:700", "color:#03a9f4;background:#fff");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeConfig,
    normalizeCamera,
    buildCamera,
    parseTimestamp,
    proxyYaml,
    byTsDesc,
    pickThumbEntity,
    firstRisingEdge,
    fingerprint,
    fitMode,
    dayBounds,
    dayFraction,
    rollFrac,
    rollingMarks,
    hourMarks,
    mergeSpans,
    nearestIndex,
    fmtClock,
    MotionEyeCameraCard,
    DEFAULT_CONFIG,
  };
}
