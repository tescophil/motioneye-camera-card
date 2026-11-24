/*!
 * MotionEye Camera Card for Home Assistant
 * Live MJPEG view, multi-camera grid, SD/HD switching (via HA proxy cameras),
 * motion indication and a still-image + video timeline from motionEye.
 * No build step, no dependencies.  MIT licence.
 */

const CARD_VERSION = "1.1.0";
const CARD_TAG = "motioneye-camera-card";
const QUALITY_KEY = "motioneye-camera-card:quality";
const STRIP_TTL = 120000; // ms before a camera's recordings strip is refreshed in the background
const STRIP_ERROR_TTL = 30000; // ms before a failed strip load is retried
const PRELOAD_PER_CAMERA = 8; // thumbnails fetched ahead of time per camera
const MAX_BLOBS = 300; // cap on preloaded thumbnails kept in memory

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
      this._updateActive();
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
    this._ticker = setInterval(() => this._updateMotion(), 1000);
    if (this._config && this._hass) this._afterHass();
    this._updateActive(true);
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
    this._q("#mClose").onclick = () => this._closeModal();
    this._q("#mPrev").onclick = () => this._openModal(this._modalIdx - 1);
    this._q("#mNext").onclick = () => this._openModal(this._modalIdx + 1);

    this._stripSig = null;
    this._renderPicker();
    this._renderStrip(); // placeholders straight away, so the layout never jumps
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
    else this._loadStrip();
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

  // Load the other cameras' strips one at a time, so switching camera is instant.
  async _prefetchStrips() {
    const c = this._config;
    if (!c.strip || !c.strip_prefetch || this._prefetching || c.cameras.length < 2) return;
    const selected = this._cam().entity;
    if (!this._strip[selected]) return; // the camera on screen always goes first
    const now = Date.now();
    const todo = c.cameras.filter((cam) => {
      if (cam.entity === selected || this._stripFresh(this._strip[cam.entity])) return false;
      const failed = this._prefetchFail[cam.entity];
      return !(failed && now - failed < 300000); // don't hammer a camera that keeps failing
    });
    if (!todo.length) return;
    this._prefetching = true;
    const gen = this._gen;
    try {
      for (const cam of todo) {
        if (gen !== this._gen || !this._active || this._view !== "live") break;
        await this._refreshStrip(cam);
        if (this._strip[cam.entity]?.error) this._prefetchFail[cam.entity] = Date.now();
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
      else if (selected) this._loadStrip(true);
      if (!selected || this._view === "timeline") {
        // mark stale: refreshed in the background (or when this camera is next selected)
        if (this._strip[cam.entity]) this._strip[cam.entity].at = 0;
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
  }

  /* ---------- media modal ---------- */

  async _openModal(idx) {
    const item = this._tlVisible[idx];
    if (!item) return;
    this._modalIdx = idx;
    this._modalOpen = true;
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
    this._config = config;
    this._yaml.querySelector("pre").textContent = proxyYaml(this._entities());
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
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
    parseTimestamp,
    proxyYaml,
    byTsDesc,
    pickThumbEntity,
    firstRisingEdge,
    fingerprint,
    fitMode,
    MotionEyeCameraCard,
    DEFAULT_CONFIG,
  };
}
