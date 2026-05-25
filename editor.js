"use strict";

/* =========================================================================
 * Wooden Labyrinth — Level Editor
 *
 * Reads/writes the same Levelpack XML format used by the iOS game.
 * Board is 480 x 320 logical pixels (top-left origin, y down).
 *
 * Schema (one .xml file per pack):
 *   <Levelpack>
 *     <packname>…</packname>
 *     <author>…</author>
 *     <Labyrinth>
 *       <name>…</name>
 *       <partime>30</partime>          (integer seconds)
 *       <devtime>5.42</devtime>        (float seconds, 2 decimals)
 *       <jump>1</jump>                 (optional; only emitted if true)
 *       <wall>  <x/><y/><width/><height/><size/>  </wall>   size: 0.5 | 1
 *       <hole>  <x/><y/><width/><height/>          </hole>
 *       <start> <x/><y/><width/><height/>          </start>
 *       <goal>  <x/><y/><width/><height/>          </goal>
 *     </Labyrinth>
 *     <Labyrinth>…</Labyrinth>
 *   </Levelpack>
 * ========================================================================= */

const BOARD_W = 480;
const BOARD_H = 320;
const DEFAULT_HOLE_SIZE = 32;
const DEFAULT_START_SIZE = 30;
const DEFAULT_GOAL_SIZE = 32;
const MIN_WALL = 4;
const HISTORY_LIMIT = 100;

// Resolve paths from this script's folder (reliable on GitHub Pages subpaths).
const EDITOR_BASE = (() => {
  const el = document.querySelector('script[src*="editor.js"]');
  if (el?.src) return new URL(".", el.src).href;
  return new URL("./", location.href).href;
})();

function assetUrl(path) {
  return new URL(path, EDITOR_BASE).href;
}

function packUrl(id) {
  const u = new URL(`packs/${idToFilename(id)}`, EDITOR_BASE);
  u.searchParams.set("_", Date.now());
  return u.href;
}

const HANDLE_HIT = 8;        // logical-pixel hit radius for resize handles
const HANDLE_DRAW = 6;       // visual handle size

// ----------------------- DOM refs -----------------------
const $ = (id) => document.getElementById(id);
const canvas = $("board");
const stage = $("canvas-stage");
const ctx = canvas.getContext("2d");
const coordsEl = $("board-coords");
const toast = $("toast");

// ----------------------- State -----------------------
const state = {
  pack: null,                  // null = no pack open yet (see boardEmpty UI)
  loaded: null,                // { id, sha, isNew, dirty }
  view: "empty",               // "empty" | "pack" | "level"
  currentLevelIdx: 0,
  tool: "select",
  selection: null,             // { kind, idx }
  options: { grid: true, snap: true, step: 8 },
  draft: null,                 // active drag: { kind, start, current, mode, originalRect, handle }
  hover: null,                 // { kind, idx }
};

const history = { past: [], future: [] };

// ----------------------- Asset preloads -----------------------
const assets = {};
function loadImage(name, src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { assets[name] = img; resolve(); };
    img.onerror = () => { assets[name] = null; resolve(); };
    img.src = src;
  });
}
const assetsReady = Promise.all([
  loadImage("frame", assetUrl("assets/wood-frame.jpg")),
  loadImage("board", assetUrl("assets/board-bg.png")),
  loadImage("strip", assetUrl("assets/wood-strip.jpg")),
  loadImage("hole",  assetUrl("assets/hole.png")),
]);

// ----------------------- Helpers -----------------------
// Every pack always has exactly LEVELS_PER_PACK levels (the iOS game's level
// select view is a fixed 2x5 grid). New levels start "empty" — just the start
// ball and goal hole — and the user fills in walls/holes from there.
const LEVELS_PER_PACK = 10;

function emptyLevel() {
  return {
    name: "Untitled",
    partime: 30,
    devtime: 0,
    jump: false,
    walls: [],
    holes: [],
    start: { x: 30,  y: 30,  width: DEFAULT_START_SIZE, height: DEFAULT_START_SIZE },
    goal:  { x: 418, y: 258, width: DEFAULT_GOAL_SIZE,  height: DEFAULT_GOAL_SIZE  },
  };
}

function emptyPack() {
  const levels = [];
  for (let i = 0; i < LEVELS_PER_PACK; i++) levels.push(emptyLevel());
  return {
    packname: "My Pack",
    author: "Anonymous",
    passwordHash: null,     // optional SHA-256 hex of the author's password
    levels,
  };
}

// True if a level has no user content beyond the default start+goal (no walls,
// no holes). Used to mark "untouched" tiles in the overview grid.
function isLevelEmpty(lvl) {
  return !lvl || ((!lvl.walls || lvl.walls.length === 0) &&
                  (!lvl.holes || lvl.holes.length === 0));
}

// SHA-256 hex digest (Web Crypto). Used only for the editor-side "are you the
// author?" gate, not real crypto — it just prevents casual overwrites of
// password-protected packs through the editor UI.
async function sha256Hex(str) {
  const data = new TextEncoder().encode(String(str));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ----------------------- ID / filename helpers -----------------------
// Every pack file is packs/pack{id}.xml — official packs (1–499) and
// player-created packs (500+). No runtime catalog.
function idToFilename(id) {
  const s = String(id).trim();
  if (!/^\d+$/.test(s)) throw new Error("Pack ID must be a number.");
  return `pack${s}.xml`;
}

function filenameToId(filename) {
  const m = String(filename).replace(/\.xml$/i, "").match(/^pack(\d+)$/i);
  return m ? m[1] : null;
}

function isNumericId(id) { return /^\d+$/.test(String(id).trim()); }

function getAllTakenNumericIds(extraPacks = []) {
  const taken = new Set();
  for (const p of extraPacks) {
    const s = String(p.id);
    if (/^\d+$/.test(s)) taken.add(+s);
  }
  return taken;
}

function getNextFreeNumericId(extraPacks = [], start = 500) {
  const taken = getAllTakenNumericIds(extraPacks);
  let n = start;
  while (taken.has(n)) n++;
  return n;
}

function currentLevel() {
  return state.pack ? state.pack.levels[state.currentLevelIdx] : null;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function snap(v) {
  if (!state.options.snap) return Math.round(v);
  const s = state.options.step;
  return Math.round(v / s) * s;
}

function snapRect(r) {
  return {
    ...r,
    x: clamp(snap(r.x), 0, BOARD_W),
    y: clamp(snap(r.y), 0, BOARD_H),
    width: Math.max(MIN_WALL, snap(r.width)),
    height: Math.max(MIN_WALL, snap(r.height)),
  };
}

function showToast(msg, kind = "", ms = 2200) {
  toast.textContent = msg;
  toast.className = "toast" + (kind ? " " + kind : "");
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, ms);
}

// ----------------------- History -----------------------
function pushHistory() {
  if (!state.pack) return;
  history.past.push({
    pack: clone(state.pack),
    currentLevelIdx: state.currentLevelIdx,
    selection: state.selection ? { ...state.selection } : null,
  });
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future.length = 0;
  markDirty();
}

function restore(snap) {
  state.pack = clone(snap.pack);
  state.currentLevelIdx = Math.min(snap.currentLevelIdx, state.pack.levels.length - 1);
  state.selection = snap.selection ? { ...snap.selection } : null;
  syncAll();
}

function undo() {
  if (!history.past.length) return;
  const cur = {
    pack: clone(state.pack),
    currentLevelIdx: state.currentLevelIdx,
    selection: state.selection ? { ...state.selection } : null,
  };
  const snap = history.past.pop();
  history.future.push(cur);
  restore(snap);
  showToast("Undo");
}

function redo() {
  if (!history.future.length) return;
  const cur = {
    pack: clone(state.pack),
    currentLevelIdx: state.currentLevelIdx,
    selection: state.selection ? { ...state.selection } : null,
  };
  const snap = history.future.pop();
  history.past.push(cur);
  restore(snap);
  showToast("Redo");
}

// ----------------------- XML I/O -----------------------
function parsePack(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = dom.querySelector("parsererror");
  if (err) throw new Error("Invalid XML: " + err.textContent);
  const root = dom.querySelector("Levelpack");
  if (!root) throw new Error("No <Levelpack> root element found");

  const txt = (parent, sel) => {
    const el = parent.querySelector(":scope > " + sel);
    return el ? el.textContent.trim() : "";
  };

  const pwd = txt(root, "password");
  const pack = {
    packname: txt(root, "packname") || "Unnamed Pack",
    author: txt(root, "author") || "",
    // SHA-256 hex of the author's password, or null. Only present in packs
    // saved via this editor; the iOS game silently ignores the element.
    passwordHash: pwd ? pwd.toLowerCase() : null,
    levels: [],
  };

  const labs = root.querySelectorAll(":scope > Labyrinth");
  for (const lab of labs) {
    const rect = (el) => ({
      x: +(txt(el, "x") || 0),
      y: +(txt(el, "y") || 0),
      width: +(txt(el, "width") || 0),
      height: +(txt(el, "height") || 0),
    });
    const wallEl = (el) => ({
      ...rect(el),
      size: parseFloat(txt(el, "size")) === 0.5 ? 0.5 : 1,
    });

    const level = {
      name: txt(lab, "name") || "Untitled",
      partime: +(txt(lab, "partime") || 0),
      devtime: +(txt(lab, "devtime") || 0),
      jump: txt(lab, "jump") === "1",
      walls: Array.from(lab.querySelectorAll(":scope > wall")).map(wallEl),
      holes: Array.from(lab.querySelectorAll(":scope > hole")).map(rect),
      start: null,
      goal: null,
    };
    const startEl = lab.querySelector(":scope > start");
    const goalEl  = lab.querySelector(":scope > goal");
    if (startEl) level.start = rect(startEl);
    if (goalEl)  level.goal  = rect(goalEl);
    pack.levels.push(level);
  }
  // Always normalise to exactly LEVELS_PER_PACK. Pad short packs with empty
  // levels; truncate the (extremely unlikely) over-long pack. Every shipped
  // pack we've ever seen is exactly 10.
  while (pack.levels.length < LEVELS_PER_PACK) pack.levels.push(emptyLevel());
  if (pack.levels.length > LEVELS_PER_PACK) pack.levels.length = LEVELS_PER_PACK;
  return pack;
}

function escapeXml(s) {
  // Only `<`, `>`, `&` need escaping inside element text content. The original
  // packs keep raw apostrophes (e.g. "Don't fall") so we don't touch quotes.
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtPar(n) {
  // partime: integer
  return String(Math.max(0, Math.round(+n || 0)));
}

function fmtDev(n) {
  // devtime: up to 2 decimals, integer if integer-valued (matches existing packs)
  const v = +n || 0;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function fmtCoord(n) {
  // Some shipped levels have fractional coords (e.g. 307.05). Preserve them.
  const v = +n || 0;
  if (Number.isInteger(v)) return String(v);
  // Trim FP noise but keep up to 6 decimals.
  return String(Math.round(v * 1e6) / 1e6);
}
function fmtSize(s) { return s === 0.5 ? "0.5" : "1"; }

function serializePack(pack) {
  const ind1 = "    ";
  const ind2 = "        ";
  const ind3 = "            ";
  const out = [];
  out.push("<Levelpack>");
  out.push(`${ind1}<packname>${escapeXml(pack.packname || "")}</packname>`);
  out.push(`${ind1}<author>${escapeXml(pack.author || "")}</author>`);
  if (pack.passwordHash) {
    out.push(`${ind1}<password>${pack.passwordHash}</password>`);
  }

  for (const lvl of pack.levels) {
    out.push(`${ind1}<Labyrinth>`);
    out.push(`${ind2}<name>${escapeXml(lvl.name || "")}</name>`);
    out.push(`${ind2}<partime>${fmtPar(lvl.partime)}</partime>`);
    out.push(`${ind2}<devtime>${fmtDev(lvl.devtime)}</devtime>`);
    if (lvl.jump) out.push(`${ind2}<jump>1</jump>`);

    for (const w of lvl.walls) {
      out.push(`${ind2}<wall>`);
      out.push(`${ind3}<x>${fmtCoord(w.x)}</x>`);
      out.push(`${ind3}<y>${fmtCoord(w.y)}</y>`);
      out.push(`${ind3}<width>${fmtCoord(w.width)}</width>`);
      out.push(`${ind3}<height>${fmtCoord(w.height)}</height>`);
      out.push(`${ind3}<size>${fmtSize(w.size)}</size>`);
      out.push(`${ind2}</wall>`);
    }
    for (const h of lvl.holes) {
      out.push(`${ind2}<hole>`);
      out.push(`${ind3}<x>${fmtCoord(h.x)}</x>`);
      out.push(`${ind3}<y>${fmtCoord(h.y)}</y>`);
      out.push(`${ind3}<width>${fmtCoord(h.width)}</width>`);
      out.push(`${ind3}<height>${fmtCoord(h.height)}</height>`);
      out.push(`${ind2}</hole>`);
    }
    if (lvl.start) {
      out.push(`${ind2}<start>`);
      out.push(`${ind3}<x>${fmtCoord(lvl.start.x)}</x>`);
      out.push(`${ind3}<y>${fmtCoord(lvl.start.y)}</y>`);
      out.push(`${ind3}<width>${fmtCoord(lvl.start.width)}</width>`);
      out.push(`${ind3}<height>${fmtCoord(lvl.start.height)}</height>`);
      out.push(`${ind2}</start>`);
    }
    if (lvl.goal) {
      out.push(`${ind2}<goal>`);
      out.push(`${ind3}<x>${fmtCoord(lvl.goal.x)}</x>`);
      out.push(`${ind3}<y>${fmtCoord(lvl.goal.y)}</y>`);
      out.push(`${ind3}<width>${fmtCoord(lvl.goal.width)}</width>`);
      out.push(`${ind3}<height>${fmtCoord(lvl.goal.height)}</height>`);
      out.push(`${ind2}</goal>`);
    }
    out.push(`${ind1}</Labyrinth>`);
  }
  out.push("</Levelpack>");
  out.push("");
  return out.join("\n");
}

// ===========================================================================
//   Persistence
//
//   Reads: static files on GitHub Pages (./packs/pack{id}.xml).
//   Writes: public save API (Cloudflare Worker) — players never see tokens.
// ===========================================================================

const SAVE_API_URL = (() => {
  try {
    const s = localStorage.getItem("wlle.saveApi");
    if (s) return s.replace(/\/$/, "");
  } catch (_) {}
  return "https://wl-editor-save.hsy7yf7457-sketch.workers.dev";
})();

function detectRepo() {
  const host = location.hostname;
  const m = host.match(/^([^.]+)\.github\.io$/i);
  if (m) {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length >= 1) {
      return { owner: m[1], repo: parts[0], branch: "main", prefix: "packs" };
    }
  }
  return { owner: "hsy7yf7457-sketch", repo: "wooden-labyrinth-editor", branch: "main", prefix: "packs" };
}

const repo = detectRepo();

const gh = {
  shaCache: new Map(), // id → sha

  pathFor(id) {
    const p = repo.prefix ? repo.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
    return `${p}${idToFilename(id)}`;
  },

  packFile(id) {
    return idToFilename(id);
  },

  async readPack(id) {
    const url = packUrl(id);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw Object.assign(new Error(`Couldn't load pack ${id}: ${res.status}`), { status: res.status });
    const xml = await res.text();
    if (!/^\s*</.test(xml)) {
      throw Object.assign(new Error("No pack found."), { status: 404 });
    }
    const sha = this.shaCache.get(String(id)) || null;
    return { xml, sha };
  },

  async listPacksOnServer() {
    if (!SAVE_API_URL) return [];
    const data = await saveApi.listPacks();
    for (const p of data.packs || []) {
      this.shaCache.set(String(p.id), p.sha);
    }
    return data.packs || [];
  },

  async writePack(id, xml, sha, isNew) {
    const filename = this.packFile(id);
    const data = await saveApi.save({ filename, xml, sha, isNew });
    if (data.sha) this.shaCache.set(String(id), data.sha);
    return { sha: data.sha };
  },
};

const saveApi = {
  async listPacks() {
    const res = await fetch(`${SAVE_API_URL}/packs`, { cache: "no-store" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || `Save service error (${res.status})`), { status: res.status });
    }
    return res.json();
  },

  async getSha(path) {
    const res = await fetch(`${SAVE_API_URL}/sha?file=${encodeURIComponent(path)}`, { cache: "no-store" });
    if (!res.ok) return { sha: null };
    return res.json();
  },

  async save({ filename, xml, sha, isNew }) {
    const res = await fetch(`${SAVE_API_URL}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, xml, sha, isNew }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.error || `Save failed (${res.status})`), { status: res.status });
    return j;
  },
};

// ----------------------- High-level open / save / new -----------------------
function setLoaded(loaded) {
  state.loaded = loaded;
  state.unlock = null;   // session password cache resets when pack changes
  syncLoadedIndicator();
  $("btn-save").disabled = !loaded;
}

function markDirty() {
  if (!state.loaded) return;
  if (!state.loaded.dirty) {
    state.loaded.dirty = true;
    syncLoadedIndicator();
  }
}

function syncLoadedIndicator() {
  const el = $("loaded-indicator");
  if (!state.loaded) { el.hidden = true; return; }
  el.hidden = false;
  const isNew = state.loaded.isNew || state.loaded.id == null;
  el.classList.toggle("dirty", !!state.loaded.dirty && !isNew);
  el.classList.toggle("saved", !state.loaded.dirty && !isNew);
  el.classList.toggle("new",   isNew);
  const tag = isNew ? " (unsaved)" : (state.loaded.dirty ? " •" : "");
  const label = state.loaded.id == null ? "New pack" : "Pack " + state.loaded.id;
  $("loaded-name").textContent = label + tag;
}

function confirmDiscardDirty() {
  if (!state.loaded || !state.loaded.dirty) return true;
  const label = state.loaded.id == null ? "This new pack" : `Pack ${state.loaded.id}`;
  return window.confirm(`${label} has unsaved changes. Discard them?`);
}

function applyLoadedPack(id, pack, sha, { isNew = false, dirty = false } = {}) {
  state.pack = pack;
  state.currentLevelIdx = 0;
  state.selection = null;
  history.past.length = 0;
  history.future.length = 0;
  setLoaded({ id, sha, isNew, dirty });
  // Always land in the pack overview when opening / creating a pack — the user
  // explicitly picks a level from there to enter the editor.
  setView("pack");
  syncAll();
}

// ----------------------- View switching -----------------------
// Three views share the centre column:
//   "empty" — no pack open; shows the welcome card.
//   "pack"  — pack overview (2x5 tile grid).
//   "level" — single-level canvas editor.
function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $("board-empty").hidden    = view !== "empty";
  $("pack-overview").hidden  = view !== "pack";
  $("level-editor").hidden   = view !== "level";
  if (view === "level") {
    // Canvas needs a real DPR-scaled backing buffer the first time it shows.
    requestAnimationFrame(() => { if (state.pack) draw(); });
  }
}

function enterLevel(idx) {
  if (!state.pack) return;
  state.currentLevelIdx = clamp(idx, 0, state.pack.levels.length - 1);
  state.selection = null;
  setView("level");
  syncAll();
}

function backToPack() {
  setView("pack");
  syncAll();
}

async function openPackById(rawId) {
  const id = String(rawId || "").trim();
  if (!id) { showToast("Enter a pack ID.", "error", 3500); return; }
  if (!isNumericId(id)) { showToast("Pack ID must be a number.", "error", 3500); return; }
  if (!confirmDiscardDirty()) return;

  const btn = $("btn-open");
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening…";
  showToast(`Loading pack ${id}…`);

  try {
    const { xml, sha } = await gh.readPack(id);
    const pack = parsePack(xml);
    applyLoadedPack(id, pack, sha);
    showToast(`Opened ${pack.packname}`, "ok");
  } catch (e) {
    console.error(e);
    if (e.status === 404) {
      showToast("No pack found.", "error", 4000);
    } else {
      showToast(e.message || "Failed to open pack", "error", 4000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

// ----------------------- Save flow (public player editor) -----------------------
// New pack:     Save → optional password popup → auto next ID → success popup
// Protected:    Save → verify password → save → success popup
// Unprotected:  Save → save → success popup

let saveModalResolve = null;

function promptSavePassword({ title, message, label, verifyHash = null }) {
  return new Promise((resolve) => {
    saveModalResolve = resolve;
    $("save-title").textContent = title || "Save pack";
    $("save-message").textContent = message || "";
    $("save-password-label").textContent = label || "Password (optional)";
    $("save-password").value = "";
    $("save-password").placeholder = verifyHash ? "Enter password" : "Leave blank for no password";
    $("save-error").textContent = "";
    $("save-modal").dataset.verifyHash = verifyHash || "";
    $("save-modal").hidden = false;
    setTimeout(() => $("save-password").focus(), 0);
  });
}

async function submitSaveModal() {
  const pwd = $("save-password").value;
  const dlg = $("save-modal");
  const verifyHash = dlg.dataset.verifyHash;
  if (verifyHash) {
    const h = await sha256Hex(pwd);
    if (h !== verifyHash) {
      $("save-error").textContent = "Wrong password.";
      $("save-password").select();
      return;
    }
  }
  dlg.hidden = true;
  const r = saveModalResolve; saveModalResolve = null;
  if (r) r(pwd);
}

function cancelSaveModal() {
  $("save-modal").hidden = true;
  const r = saveModalResolve; saveModalResolve = null;
  if (r) r(null);
}

function showSavedSuccess(id) {
  $("saved-message").textContent = `Your pack was saved as ID ${id}. Players can download it in the game using that ID.`;
  $("saved-modal").hidden = false;
}

$("save-submit").addEventListener("click", submitSaveModal);
$("save-cancel").addEventListener("click", cancelSaveModal);
$("saved-ok").addEventListener("click", () => { $("saved-modal").hidden = true; });
$("save-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitSaveModal(); }
});

async function savePack() {
  if (!state.loaded) return;

  // Existing protected pack — verify password first
  if (state.loaded.id != null && state.pack.passwordHash) {
    const cached = state.unlock
                && state.unlock.id === state.loaded.id
                && state.unlock.hash === state.pack.passwordHash;
    if (!cached) {
      $("save-modal").dataset.verifyHash = state.pack.passwordHash;
      const pwd = await promptSavePassword({
        title: "Password required",
        message: "This pack is protected. Enter the password to save your changes.",
        label: "Password",
      });
      $("save-modal").dataset.verifyHash = "";
      if (pwd == null) return;
      state.unlock = { id: state.loaded.id, hash: state.pack.passwordHash };
    }
    try {
      await doSaveCurrent();
      showSavedSuccess(state.loaded.id);
    } catch (e) {
      showToast(e.message || "Save failed", "error");
    }
    return;
  }

  // Brand-new pack — optional password, then auto-assign next ID
  if (state.loaded.id == null) {
    $("save-modal").dataset.verifyHash = "";
    const pwd = await promptSavePassword({
      title: "Save pack",
      message: "Enter a password to protect your pack from being edited by others. You may leave it empty.",
      label: "Password (optional)",
    });
    if (pwd == null) return;

    if (pwd) state.pack.passwordHash = await sha256Hex(pwd);
    else state.pack.passwordHash = null;

    let serverPacks = [];
    try {
      serverPacks = await gh.listPacksOnServer();
    } catch (e) {
      console.warn(e);
    }

    let id = getNextFreeNumericId(serverPacks, 500);
    let attempt = 0;
    while (attempt < 4) {
      try {
        const xml = serializePack(state.pack);
        const { sha } = await gh.writePack(id, xml, null, true);
        state.loaded = { id: String(id), sha, isNew: false, dirty: false };
        if (state.pack.passwordHash) state.unlock = { id: state.loaded.id, hash: state.pack.passwordHash };
        syncAll();
        showSavedSuccess(id);
        return;
      } catch (e) {
        if ((e.status === 422 || e.status === 409) && attempt < 3) {
          serverPacks = await gh.listPacksOnServer().catch(() => serverPacks);
          id = getNextFreeNumericId(serverPacks, id + 1);
          attempt++;
          continue;
        }
        showToast(e.message || "Save failed", "error");
        return;
      }
    }
    return;
  }

  // Existing unprotected pack
  try {
    await doSaveCurrent();
    showSavedSuccess(state.loaded.id);
  } catch (e) {
    showToast(e.message || "Save failed", "error");
  }
}

async function doSaveCurrent() {
  const id = state.loaded.id;
  const xml = serializePack(state.pack);
  const { sha } = await gh.writePack(id, xml, state.loaded.sha, false);
  state.loaded.sha = sha || state.loaded.sha;
  state.loaded.isNew = false;
  state.loaded.dirty = false;
  syncLoadedIndicator();
}

// New-pack flow — purely client-side until Save assigns the next free ID.
function createNewPack({ packname, author }) {
  if (!confirmDiscardDirty()) return;
  const pack = emptyPack();
  pack.packname = packname || "Untitled Pack";
  pack.author = author || "";
  applyLoadedPack(null, pack, null, { isNew: true, dirty: true });
  showToast("New pack started. Click Save when ready.", "ok");
}

// ----------------------- Open by ID -----------------------
$("pack-id").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    openPackById($("pack-id").value);
  }
});

$("btn-open").addEventListener("click", () => openPackById($("pack-id").value));
$("btn-save").addEventListener("click", () => savePack());

// ----------------------- New-pack modal -----------------------
function openNewPack() {
  $("new-name").value = "";
  $("new-author").value = "";
  $("newpack-modal").hidden = false;
  setTimeout(() => $("new-name").focus(), 0);
}

$("btn-new-pack").addEventListener("click", openNewPack);

$("new-create").addEventListener("click", () => {
  closeModals();
  createNewPack({
    packname: $("new-name").value.trim(),
    author: $("new-author").value.trim(),
  });
});

// ----------------------- Sidebar pack section -----------------------
// Read-only — password is set on first save and never changed afterwards.
function syncPackSection() {
  const el = $("pack-pwd-status");
  if (!state.pack) {
    el.textContent = "—";
    el.className = "pwd-status";
    return;
  }
  if (state.loaded && state.loaded.id == null) {
    el.textContent = "(optional — set when you save)";
    el.className = "pwd-status";
  } else if (state.pack.passwordHash) {
    el.textContent = "🔒 Protected";
    el.className = "pwd-status pwd-status-locked";
  } else {
    el.textContent = "🔓 No password";
    el.className = "pwd-status pwd-status-open";
  }
}

function closeModals() {
  $("newpack-modal").hidden = true;
  $("save-modal").hidden = true;
  $("saved-modal").hidden = true;
  if (saveModalResolve) { const r = saveModalResolve; saveModalResolve = null; r(null); }
}

document.querySelectorAll(".modal").forEach((m) => {
  m.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", closeModals);
  });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const open = !$("newpack-modal").hidden || !$("save-modal").hidden || !$("saved-modal").hidden;
    if (open) {
      closeModals();
      e.stopImmediatePropagation();
    }
  }
});

// ----------------------- Coords / hit testing -----------------------
function logicalFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (BOARD_W / rect.width);
  const cy = (e.clientY - rect.top)  * (BOARD_H / rect.height);
  return { x: cx, y: cy };
}

function rectContains(r, p, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad
      && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

function handlePositions(r) {
  const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return [
    { id: "nw", x: x0, y: y0 },
    { id: "n",  x: mx, y: y0 },
    { id: "ne", x: x1, y: y0 },
    { id: "e",  x: x1, y: my },
    { id: "se", x: x1, y: y1 },
    { id: "s",  x: mx, y: y1 },
    { id: "sw", x: x0, y: y1 },
    { id: "w",  x: x0, y: my },
  ];
}

function hitHandle(r, p) {
  for (const h of handlePositions(r)) {
    if (Math.abs(p.x - h.x) <= HANDLE_HIT && Math.abs(p.y - h.y) <= HANDLE_HIT) return h.id;
  }
  return null;
}

function pick(p) {
  const lvl = currentLevel();
  // Top-most first: goal > start > holes (reverse) > walls (reverse)
  if (lvl.goal && rectContains(lvl.goal, p))   return { kind: "goal",  idx: null };
  if (lvl.start && rectContains(lvl.start, p)) return { kind: "start", idx: null };
  for (let i = lvl.holes.length - 1; i >= 0; i--) {
    if (rectContains(lvl.holes[i], p)) return { kind: "hole", idx: i };
  }
  for (let i = lvl.walls.length - 1; i >= 0; i--) {
    if (rectContains(lvl.walls[i], p)) return { kind: "wall", idx: i };
  }
  return null;
}

function getSelectedRect() {
  const sel = state.selection;
  if (!sel) return null;
  const lvl = currentLevel();
  if (sel.kind === "wall")  return lvl.walls[sel.idx]  || null;
  if (sel.kind === "hole")  return lvl.holes[sel.idx]  || null;
  if (sel.kind === "start") return lvl.start || null;
  if (sel.kind === "goal")  return lvl.goal  || null;
  return null;
}

function deleteSelected() {
  const sel = state.selection;
  if (!sel) return;
  const lvl = currentLevel();
  pushHistory();
  if (sel.kind === "wall")  lvl.walls.splice(sel.idx, 1);
  if (sel.kind === "hole")  lvl.holes.splice(sel.idx, 1);
  if (sel.kind === "start") lvl.start = null;
  if (sel.kind === "goal")  lvl.goal = null;
  state.selection = null;
  syncAll();
}

function duplicateSelected() {
  const sel = state.selection;
  if (!sel || (sel.kind !== "wall" && sel.kind !== "hole")) return;
  const r = getSelectedRect();
  if (!r) return;
  pushHistory();
  const lvl = currentLevel();
  const copy = { ...r, x: r.x + 12, y: r.y + 12 };
  if (sel.kind === "wall") {
    lvl.walls.push(copy);
    state.selection = { kind: "wall", idx: lvl.walls.length - 1 };
  } else {
    lvl.holes.push(copy);
    state.selection = { kind: "hole", idx: lvl.holes.length - 1 };
  }
  syncAll();
}

function nudgeSelected(dx, dy) {
  const r = getSelectedRect();
  if (!r) return;
  pushHistory();
  r.x = clamp(r.x + dx, 0, BOARD_W - r.width);
  r.y = clamp(r.y + dy, 0, BOARD_H - r.height);
  syncAll();
}

// ----------------------- Drawing -----------------------
function resizeCanvasForDPR() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  const w = Math.round(r.width  * dpr);
  const h = Math.round(r.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(w / BOARD_W, 0, 0, h / BOARD_H, 0, 0);
}

function drawBoardBackground() {
  // Single stretched texture (same as the iOS game) — never tile; the source
  // image has padding and seams badly when repeated.
  ctx.save();
  if (assets.board) {
    ctx.drawImage(assets.board, 0, 0, BOARD_W, BOARD_H);
  } else {
    ctx.fillStyle = "#c9a67a";
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  }

  // Very subtle edge darkening only.
  const g = ctx.createRadialGradient(BOARD_W / 2, BOARD_H / 2, 100, BOARD_W / 2, BOARD_H / 2, 360);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.08)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.restore();
}

function drawGrid() {
  if (!state.options.grid) return;
  const step = state.options.step;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 230, 200, 0.06)";
  ctx.lineWidth = 1 / (canvas.width / BOARD_W); // 1 device px
  ctx.beginPath();
  for (let x = 0; x <= BOARD_W; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, BOARD_H);
  }
  for (let y = 0; y <= BOARD_H; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(BOARD_W, y + 0.5);
  }
  ctx.stroke();
  // Stronger lines every 8 steps (e.g. 64)
  if (step <= 8) {
    ctx.strokeStyle = "rgba(255, 230, 200, 0.10)";
    ctx.beginPath();
    const major = step * 8;
    for (let x = 0; x <= BOARD_W; x += major) {
      ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, BOARD_H);
    }
    for (let y = 0; y <= BOARD_H; y += major) {
      ctx.moveTo(0, y + 0.5); ctx.lineTo(BOARD_W, y + 0.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawWall(w, hovered, selected) {
  ctx.save();
  // Drop shadow proportional to height (full walls cast more shadow)
  const sh = w.size === 1 ? 3 : 1.5;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  roundRect(ctx, w.x + sh, w.y + sh, w.width, w.height, 1);
  ctx.fill();

  // Plank body — high walls are dark brown, low walls are medium brown.
  const grad = ctx.createLinearGradient(0, w.y, 0, w.y + w.height);
  if (w.size === 1) {
    grad.addColorStop(0, "#5a3a22");
    grad.addColorStop(0.5, "#3a2515");
    grad.addColorStop(1, "#2e1d12");
  } else {
    grad.addColorStop(0, "#9a6638");
    grad.addColorStop(0.5, "#7a5230");
    grad.addColorStop(1, "#6e4a2c");
  }
  ctx.fillStyle = grad;
  roundRect(ctx, w.x, w.y, w.width, w.height, 1);
  ctx.fill();

  // Subtle grain stripes (along the longer dim)
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, w.x, w.y, w.width, w.height, 1);
  ctx.clip();
  ctx.strokeStyle = "rgba(80, 50, 30, 0.25)";
  ctx.lineWidth = 0.5;
  const horizontal = w.width >= w.height;
  ctx.beginPath();
  if (horizontal) {
    for (let y = w.y + 2; y < w.y + w.height; y += 3) {
      ctx.moveTo(w.x, y + 0.5);
      ctx.lineTo(w.x + w.width, y + 0.5);
    }
  } else {
    for (let x = w.x + 2; x < w.x + w.width; x += 3) {
      ctx.moveTo(x + 0.5, w.y);
      ctx.lineTo(x + 0.5, w.y + w.height);
    }
  }
  ctx.stroke();
  ctx.restore();

  // Top highlight
  ctx.strokeStyle = "rgba(255, 235, 200, 0.5)";
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(w.x + 0.5, w.y + 0.5);
  ctx.lineTo(w.x + w.width - 0.5, w.y + 0.5);
  ctx.stroke();

  // Border
  ctx.strokeStyle = "rgba(40, 22, 12, 0.6)";
  ctx.lineWidth = 0.75;
  roundRect(ctx, w.x + 0.5, w.y + 0.5, w.width - 1, w.height - 1, 1);
  ctx.stroke();

  if (hovered || selected) {
    ctx.strokeStyle = selected ? "rgba(232, 177, 106, 1)" : "rgba(232, 177, 106, 0.55)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, w.x - 1, w.y - 1, w.width + 2, w.height + 2, 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHole(h, hovered, selected) {
  ctx.save();
  // Outer dark hollow with metal rim
  const cx = h.x + h.width / 2;
  const cy = h.y + h.height / 2;
  const rOuter = Math.min(h.width, h.height) / 2;

  // Rim shadow
  ctx.beginPath();
  ctx.arc(cx + 1, cy + 1.5, rOuter, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();

  // Metal rim
  const rimGrad = ctx.createRadialGradient(cx - rOuter * 0.4, cy - rOuter * 0.4, rOuter * 0.2,
                                            cx, cy, rOuter);
  rimGrad.addColorStop(0, "#f4f6f8");
  rimGrad.addColorStop(0.45, "#b8bcc0");
  rimGrad.addColorStop(1, "#5a5e62");
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
  ctx.fillStyle = rimGrad;
  ctx.fill();

  // Hole opening
  const rInner = rOuter * 0.78;
  const holeGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rInner);
  holeGrad.addColorStop(0, "#000");
  holeGrad.addColorStop(0.7, "#0a0807");
  holeGrad.addColorStop(1, "#1a1410");
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.fillStyle = holeGrad;
  ctx.fill();

  // Rim highlight
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(cx - 0.3, cy - 0.3, rOuter - 0.5, Math.PI * 0.9, Math.PI * 1.8);
  ctx.stroke();

  if (hovered || selected) {
    ctx.strokeStyle = selected ? "rgba(232, 177, 106, 1)" : "rgba(232, 177, 106, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter + 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMarker(r, color, label, hovered, selected) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  roundRect(ctx, r.x + 1.5, r.y + 2, r.width, r.height, 4);
  ctx.fill();

  // Pad
  const grad = ctx.createLinearGradient(0, r.y, 0, r.y + r.height);
  grad.addColorStop(0, color.light);
  grad.addColorStop(1, color.dark);
  ctx.fillStyle = grad;
  roundRect(ctx, r.x, r.y, r.width, r.height, 4);
  ctx.fill();

  // Edge
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 0.75;
  roundRect(ctx, r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1, 4);
  ctx.stroke();

  // Label
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "bold " + Math.round(Math.min(r.width, r.height) * 0.5) + "px " +
             "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, r.x + r.width / 2, r.y + r.height / 2 + 0.5);

  if (hovered || selected) {
    ctx.strokeStyle = selected ? "rgba(232, 177, 106, 1)" : "rgba(232, 177, 106, 0.55)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, r.x - 1, r.y - 1, r.width + 2, r.height + 2, 5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSelectionHandles(r) {
  ctx.save();
  for (const h of handlePositions(r)) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#e8b16a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(h.x - HANDLE_DRAW / 2, h.y - HANDLE_DRAW / 2, HANDLE_DRAW, HANDLE_DRAW);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawDraft() {
  const d = state.draft;
  if (!d) return;
  if (d.kind === "new-wall") {
    const r = normalizeRect(d.start, d.current);
    ctx.save();
    ctx.strokeStyle = "rgba(232,177,106,0.9)";
    ctx.fillStyle = "rgba(232,177,106,0.2)";
    ctx.lineWidth = 1;
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);
    ctx.restore();
  }
}

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function draw() {
  if (!state.pack) return;
  resizeCanvasForDPR();
  drawBoardBackground();
  drawGrid();

  const lvl = currentLevel();
  const sel = state.selection;
  const hov = state.hover;

  // Order: walls (bottom), holes, start, goal (top)
  for (let i = 0; i < lvl.walls.length; i++) {
    drawWall(lvl.walls[i],
      hov && hov.kind === "wall" && hov.idx === i,
      sel && sel.kind === "wall" && sel.idx === i);
  }
  for (let i = 0; i < lvl.holes.length; i++) {
    drawHole(lvl.holes[i],
      hov && hov.kind === "hole" && hov.idx === i,
      sel && sel.kind === "hole" && sel.idx === i);
  }
  if (lvl.start) {
    drawMarker(lvl.start, { light: "#9ce69a", dark: "#3c8c3a" }, "S",
      hov && hov.kind === "start",
      sel && sel.kind === "start");
  }
  if (lvl.goal) {
    drawMarker(lvl.goal, { light: "#f7b27a", dark: "#c1502a" }, "G",
      hov && hov.kind === "goal",
      sel && sel.kind === "goal");
  }

  // Selection handles last
  if (state.tool === "select") {
    const r = getSelectedRect();
    if (r) drawSelectionHandles(r);
  }

  drawDraft();
}

// ----------------------- Interaction -----------------------
function setTool(name) {
  state.tool = name;
  for (const btn of document.querySelectorAll(".tool")) {
    btn.classList.toggle("active", btn.dataset.tool === name);
  }
  canvas.classList.toggle("tool-select", name === "select");
  canvas.style.cursor = name === "select" ? "default" : "crosshair";
  draw();
}

function setSelection(sel) {
  state.selection = sel ? { ...sel } : null;
  syncSelectionPanel();
  draw();
}

function applyDrag(p) {
  const d = state.draft;
  if (!d) return;
  if (d.kind === "move") {
    const sel = state.selection;
    const r = getSelectedRect();
    if (!r) return;
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const nx = snap(d.originalRect.x + dx);
    const ny = snap(d.originalRect.y + dy);
    r.x = clamp(nx, 0, BOARD_W - r.width);
    r.y = clamp(ny, 0, BOARD_H - r.height);
    draw();
    syncSelectionPanel();
    syncStats();
  } else if (d.kind === "resize") {
    const r = getSelectedRect();
    if (!r) return;
    resizeFromHandle(r, d.originalRect, d.handle, p);
    draw();
    syncSelectionPanel();
  } else if (d.kind === "new-wall") {
    d.current = { x: clamp(snap(p.x), 0, BOARD_W), y: clamp(snap(p.y), 0, BOARD_H) };
    draw();
  }
}

function resizeFromHandle(r, orig, handle, p) {
  // Compute new edges based on handle id
  let left = orig.x;
  let top = orig.y;
  let right = orig.x + orig.width;
  let bottom = orig.y + orig.height;
  const sx = snap(p.x);
  const sy = snap(p.y);

  if (handle.includes("w")) left = sx;
  if (handle.includes("e")) right = sx;
  if (handle.includes("n")) top = sy;
  if (handle.includes("s")) bottom = sy;

  // Enforce min size and order
  if (right - left < MIN_WALL) {
    if (handle.includes("w")) left = right - MIN_WALL;
    else right = left + MIN_WALL;
  }
  if (bottom - top < MIN_WALL) {
    if (handle.includes("n")) top = bottom - MIN_WALL;
    else bottom = top + MIN_WALL;
  }
  left = clamp(left, 0, BOARD_W);
  right = clamp(right, 0, BOARD_W);
  top = clamp(top, 0, BOARD_H);
  bottom = clamp(bottom, 0, BOARD_H);

  r.x = left; r.y = top;
  r.width = right - left;
  r.height = bottom - top;
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (!state.pack) return;
  canvas.setPointerCapture(e.pointerId);
  const p = logicalFromEvent(e);
  const lvl = currentLevel();

  if (state.tool === "select") {
    // Resize handle if selection exists and we hit it
    const selRect = getSelectedRect();
    if (selRect) {
      const h = hitHandle(selRect, p);
      if (h) {
        pushHistory();
        state.draft = {
          kind: "resize",
          handle: h,
          start: p,
          originalRect: { ...selRect },
        };
        return;
      }
    }
    const hit = pick(p);
    setSelection(hit);
    if (hit) {
      const r = getSelectedRect();
      pushHistory();
      state.draft = {
        kind: "move",
        start: p,
        originalRect: { ...r },
      };
    }
  } else if (state.tool === "wall") {
    pushHistory();
    state.draft = {
      kind: "new-wall",
      start: { x: clamp(snap(p.x), 0, BOARD_W), y: clamp(snap(p.y), 0, BOARD_H) },
      current: { x: clamp(snap(p.x), 0, BOARD_W), y: clamp(snap(p.y), 0, BOARD_H) },
    };
    draw();
  } else if (state.tool === "hole") {
    pushHistory();
    const r = snapRect({
      x: p.x - DEFAULT_HOLE_SIZE / 2,
      y: p.y - DEFAULT_HOLE_SIZE / 2,
      width: DEFAULT_HOLE_SIZE,
      height: DEFAULT_HOLE_SIZE,
    });
    lvl.holes.push(r);
    setSelection({ kind: "hole", idx: lvl.holes.length - 1 });
    setTool("select");
    syncAll();
  } else if (state.tool === "start") {
    pushHistory();
    lvl.start = snapRect({
      x: p.x - DEFAULT_START_SIZE / 2,
      y: p.y - DEFAULT_START_SIZE / 2,
      width: DEFAULT_START_SIZE,
      height: DEFAULT_START_SIZE,
    });
    setSelection({ kind: "start", idx: null });
    setTool("select");
    syncAll();
  } else if (state.tool === "goal") {
    pushHistory();
    lvl.goal = snapRect({
      x: p.x - DEFAULT_GOAL_SIZE / 2,
      y: p.y - DEFAULT_GOAL_SIZE / 2,
      width: DEFAULT_GOAL_SIZE,
      height: DEFAULT_GOAL_SIZE,
    });
    setSelection({ kind: "goal", idx: null });
    setTool("select");
    syncAll();
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!state.pack) return;
  const p = logicalFromEvent(e);
  coordsEl.textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;

  if (state.draft) {
    applyDrag(p);
    return;
  }

  // Hover detection (select tool only)
  if (state.tool === "select") {
    const selRect = getSelectedRect();
    if (selRect) {
      const h = hitHandle(selRect, p);
      if (h) {
        canvas.style.cursor = handleCursor(h);
        return;
      }
    }
    const hit = pick(p);
    const changed = (!state.hover && hit) ||
                    (state.hover && !hit) ||
                    (state.hover && hit &&
                     (state.hover.kind !== hit.kind || state.hover.idx !== hit.idx));
    state.hover = hit;
    canvas.style.cursor = hit ? "move" : "default";
    if (changed) draw();
  } else {
    canvas.style.cursor = "crosshair";
  }
});

canvas.addEventListener("pointerup", (e) => {
  const p = logicalFromEvent(e);
  const d = state.draft;
  state.draft = null;
  if (d && d.kind === "new-wall") {
    const lvl = currentLevel();
    const r = normalizeRect(d.start, { x: clamp(snap(p.x), 0, BOARD_W), y: clamp(snap(p.y), 0, BOARD_H) });
    if (r.width >= MIN_WALL && r.height >= MIN_WALL) {
      r.size = 1;
      lvl.walls.push(r);
      setSelection({ kind: "wall", idx: lvl.walls.length - 1 });
      setTool("select");
    } else {
      // Discarded — also drop the speculative history entry
      history.past.pop();
    }
  }
  syncAll();
});

canvas.addEventListener("pointerleave", () => {
  coordsEl.textContent = "—";
  if (!state.draft && state.hover) { state.hover = null; draw(); }
});

function handleCursor(h) {
  return ({
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    nw: "nwse-resize", se: "nwse-resize",
  })[h] || "default";
}

// ----------------------- Tool buttons -----------------------
document.querySelectorAll(".tool").forEach((btn) => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

// ----------------------- Options -----------------------
$("opt-grid").addEventListener("change", (e) => { state.options.grid = e.target.checked; draw(); });
$("opt-snap").addEventListener("change", (e) => { state.options.snap = e.target.checked; });
$("opt-step").addEventListener("change", (e) => { state.options.step = +e.target.value; draw(); });

// ----------------------- Pack / level metadata -----------------------
$("pack-name").addEventListener("input", (e) => {
  if (!state.pack) return;
  state.pack.packname = e.target.value;
  markDirty();
});
$("pack-author").addEventListener("input", (e) => {
  if (!state.pack) return;
  state.pack.author = e.target.value;
  markDirty();
});

$("level-name").addEventListener("input", (e) => {
  const lvl = currentLevel(); if (!lvl) return;
  lvl.name = e.target.value;
  markDirty();
  syncEditorHeader();
});
$("level-partime").addEventListener("input", (e) => {
  const lvl = currentLevel(); if (!lvl) return;
  lvl.partime = +e.target.value || 0;
  markDirty();
});
$("level-devtime").addEventListener("input", (e) => {
  const lvl = currentLevel(); if (!lvl) return;
  lvl.devtime = +e.target.value || 0;
  markDirty();
});
$("level-jump").addEventListener("change", (e) => {
  const lvl = currentLevel(); if (!lvl) return;
  lvl.jump = e.target.checked;
  markDirty();
});

// Capture an undo snapshot once per focus session on text fields.
for (const id of ["pack-name", "pack-author", "level-name", "level-partime", "level-devtime", "level-jump"]) {
  const el = $(id);
  el.addEventListener("focus", () => { if (state.pack) pushHistory(); });
}

// ----------------------- Selection panel -----------------------
function syncSelectionPanel() {
  if (!state.pack) {
    $("sel-empty").hidden = false;
    $("sel-form").hidden = true;
    return;
  }
  const sel = state.selection;
  const r = getSelectedRect();
  if (!sel || !r) {
    $("sel-empty").hidden = false;
    $("sel-form").hidden = true;
    return;
  }
  $("sel-empty").hidden = true;
  $("sel-form").hidden = false;
  $("sel-kind-label").textContent = sel.kind.toUpperCase();
  $("sel-x").value = Math.round(r.x);
  $("sel-y").value = Math.round(r.y);
  $("sel-w").value = Math.round(r.width);
  $("sel-h").value = Math.round(r.height);
  $("sel-wall-extra").hidden = sel.kind !== "wall";
  if (sel.kind === "wall") {
    for (const b of $("sel-wall-extra").querySelectorAll(".seg-btn")) {
      b.classList.toggle("active", +b.dataset.size === r.size);
    }
  }
  $("sel-dup").hidden = sel.kind === "start" || sel.kind === "goal";
}

function bindSelectionField(id, prop) {
  $(id).addEventListener("focus", () => pushHistory());
  $(id).addEventListener("input", () => {
    const r = getSelectedRect();
    if (!r) return;
    let v = +$(id).value;
    if (Number.isNaN(v)) v = 0;
    if (prop === "width" || prop === "height") v = Math.max(MIN_WALL, v);
    if (prop === "x") v = clamp(v, 0, BOARD_W - r.width);
    if (prop === "y") v = clamp(v, 0, BOARD_H - r.height);
    if (prop === "width")  v = Math.min(v, BOARD_W - r.x);
    if (prop === "height") v = Math.min(v, BOARD_H - r.y);
    r[prop] = v;
    draw();
    syncStats();
  });
}
bindSelectionField("sel-x", "x");
bindSelectionField("sel-y", "y");
bindSelectionField("sel-w", "width");
bindSelectionField("sel-h", "height");

$("sel-wall-extra").querySelectorAll(".seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    const sel = state.selection;
    if (!sel || sel.kind !== "wall") return;
    pushHistory();
    const r = getSelectedRect();
    r.size = +b.dataset.size;
    syncSelectionPanel();
    draw();
  });
});

$("sel-dup").addEventListener("click", duplicateSelected);
$("sel-del").addEventListener("click", deleteSelected);

// ----------------------- Pack overview (2x5 thumbnail grid) -----------------------
// Renders the 10 level tiles. Each tile owns a small <canvas> that draws a
// scaled-down preview of the level. The tile root is HTML5-draggable; dropping
// it on another tile swaps the two levels' positions in the pack.
function syncPackOverview() {
  const grid = $("level-grid");
  grid.innerHTML = "";
  if (!state.pack) return;
  $("overview-pack-name").textContent = state.pack.packname || "Untitled Pack";
  $("overview-pack-by").textContent   = state.pack.author
    ? `by ${state.pack.author}` : "(no author)";

  state.pack.levels.forEach((lvl, i) => {
    const tile = document.createElement("div");
    tile.className = "level-tile";
    tile.draggable = true;
    tile.dataset.idx = String(i);
    if (isLevelEmpty(lvl)) tile.classList.add("tile-empty");

    const head = document.createElement("div");
    head.className = "tile-head";
    head.innerHTML = `<span class="tile-num">${i + 1}</span>` +
                     (isLevelEmpty(lvl)
                       ? `<span class="tile-empty-badge">empty</span>`
                       : "");

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "tile-thumb";
    const thumb = document.createElement("canvas");
    // Render at a moderate resolution; CSS scales it to tile width.
    const TW = 240, TH = 160;
    thumb.width = TW;
    thumb.height = TH;
    thumbWrap.appendChild(thumb);

    const name = document.createElement("div");
    name.className = "tile-name";
    name.textContent = lvl.name || "Untitled";

    const meta = document.createElement("div");
    meta.className = "tile-meta";
    meta.innerHTML =
      `<span>${lvl.walls.length}w · ${lvl.holes.length}h</span>` +
      `<span>par ${fmtPar(lvl.partime)}s</span>`;

    tile.appendChild(head);
    tile.appendChild(thumbWrap);
    tile.appendChild(name);
    tile.appendChild(meta);
    grid.appendChild(tile);

    drawLevelThumb(thumb, lvl);

    tile.addEventListener("click", (e) => {
      // Don't enter the editor at the tail end of a drag.
      if (tile.classList.contains("dragging")) return;
      enterLevel(i);
    });

    wireTileDnd(tile);
  });
}

let dragSrcIdx = null;
function wireTileDnd(tile) {
  tile.addEventListener("dragstart", (e) => {
    dragSrcIdx = +tile.dataset.idx;
    tile.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Some browsers won't fire dragstart at all unless something is set.
    try { e.dataTransfer.setData("text/plain", String(dragSrcIdx)); } catch (_) {}
  });
  tile.addEventListener("dragend", () => {
    tile.classList.remove("dragging");
    document.querySelectorAll(".level-tile.drop-target")
      .forEach((t) => t.classList.remove("drop-target"));
    dragSrcIdx = null;
  });
  tile.addEventListener("dragenter", (e) => {
    if (dragSrcIdx == null) return;
    if (+tile.dataset.idx === dragSrcIdx) return;
    e.preventDefault();
    tile.classList.add("drop-target");
  });
  tile.addEventListener("dragover", (e) => {
    if (dragSrcIdx == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  tile.addEventListener("dragleave", () => {
    tile.classList.remove("drop-target");
  });
  tile.addEventListener("drop", (e) => {
    e.preventDefault();
    const dst = +tile.dataset.idx;
    const src = dragSrcIdx;
    tile.classList.remove("drop-target");
    if (src == null || dst === src) return;
    pushHistory();
    // Move src → dst (shift everything in between). Matches what users expect
    // from drag-to-reorder more naturally than a straight swap.
    const arr = state.pack.levels;
    const [moved] = arr.splice(src, 1);
    arr.splice(dst, 0, moved);
    // Keep the editor's current level pointer following the moved tile if it
    // happened to be the one being edited.
    if (state.currentLevelIdx === src) state.currentLevelIdx = dst;
    else if (src < state.currentLevelIdx && dst >= state.currentLevelIdx) state.currentLevelIdx--;
    else if (src > state.currentLevelIdx && dst <= state.currentLevelIdx) state.currentLevelIdx++;
    syncAll();
  });
}

// Tiny renderer for the overview tiles. Doesn't bother with the textures or
// nice gradients — just enough to recognise the level layout.
function drawLevelThumb(canvas, lvl) {
  const c = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  // Plain wood-tone background — lighter than wall planks.
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#d4b48a");
  bg.addColorStop(1, "#c4a070");
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);

  // Map board (BOARD_W x BOARD_H) → canvas (W x H).
  const sx = W / BOARD_W, sy = H / BOARD_H;
  const px = (n) => n * sx;
  const py = (n) => n * sy;

  // Walls — high = dark brown, low = medium brown.
  for (const w of lvl.walls) {
    c.fillStyle = w.size === 0.5 ? "#7a5230" : "#3a2515";
    c.fillRect(px(w.x), py(w.y), px(w.width), py(w.height));
  }
  // Holes
  for (const h of lvl.holes) {
    const cx = px(h.x + h.width / 2);
    const cy = py(h.y + h.height / 2);
    const r = Math.max(2, Math.min(px(h.width), py(h.height)) / 2);
    c.fillStyle = "#0a0807";
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
  }
  // Start (silver ball)
  if (lvl.start) {
    const cx = px(lvl.start.x + lvl.start.width / 2);
    const cy = py(lvl.start.y + lvl.start.height / 2);
    const r = Math.max(2, Math.min(px(lvl.start.width), py(lvl.start.height)) / 2);
    const g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
    g.addColorStop(0, "#fff");
    g.addColorStop(1, "#5a5e62");
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
  }
  // Goal (checker square)
  if (lvl.goal) {
    const gx = px(lvl.goal.x), gy = py(lvl.goal.y);
    const gw = px(lvl.goal.width), gh = py(lvl.goal.height);
    const tile = Math.max(2, gw / 4);
    for (let yy = 0; yy < gh; yy += tile) {
      for (let xx = 0; xx < gw; xx += tile) {
        const dark = ((Math.floor(xx / tile) + Math.floor(yy / tile)) % 2) === 0;
        c.fillStyle = dark ? "#1a1a1a" : "#f4f4f4";
        c.fillRect(gx + xx, gy + yy, tile, tile);
      }
    }
  }
}

// ----------------------- Editor header (back, prev, next) -----------------------
$("btn-back-to-pack").addEventListener("click", backToPack);
$("btn-prev-level").addEventListener("click", () => {
  if (!state.pack) return;
  enterLevel((state.currentLevelIdx - 1 + LEVELS_PER_PACK) % LEVELS_PER_PACK);
});
$("btn-next-level").addEventListener("click", () => {
  if (!state.pack) return;
  enterLevel((state.currentLevelIdx + 1) % LEVELS_PER_PACK);
});

function syncEditorHeader() {
  if (!state.pack) return;
  const lvl = currentLevel();
  $("cur-level-num").textContent = String(state.currentLevelIdx + 1);
  $("cur-level-title").textContent = lvl?.name || "Untitled";
}

// ----------------------- Stats -----------------------
function syncStats() {
  const lvl = currentLevel();
  $("stat-walls").textContent = lvl ? lvl.walls.length : 0;
  $("stat-holes").textContent = lvl ? lvl.holes.length : 0;
  $("stat-start").textContent = lvl && lvl.start ? "✓" : "—";
  $("stat-goal").textContent  = lvl && lvl.goal  ? "✓" : "—";
}

// ----------------------- Sync everything -----------------------
function syncMeta() {
  if (!state.pack) {
    for (const id of ["pack-name", "pack-author", "level-name", "level-partime", "level-devtime"]) {
      $(id).value = "";
    }
    $("level-jump").checked = false;
    return;
  }
  $("pack-name").value   = state.pack.packname || "";
  $("pack-author").value = state.pack.author || "";
  const lvl = currentLevel();
  $("level-name").value    = lvl.name || "";
  $("level-partime").value = lvl.partime ?? 0;
  $("level-devtime").value = lvl.devtime ?? 0;
  $("level-jump").checked  = !!lvl.jump;
}

function syncAll() {
  syncMeta();
  syncPackOverview();
  syncEditorHeader();
  syncSelectionPanel();
  syncStats();
  syncPackSection();
  if (state.pack && state.view === "level") draw();
}

// ----------------------- Keyboard -----------------------
window.addEventListener("keydown", (e) => {
  // Skip if focus is in a text input
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.loaded) savePack();
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (state.loaded) savePack();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelected();
    return;
  }

  if (!state.pack) return;

  // Editor-only shortcuts (tools, nudges, delete). In pack view these
  // would be no-ops at best, surprising at worst.
  if (state.view !== "level") return;

  switch (e.key) {
    case "v": case "V": setTool("select"); break;
    case "w": case "W": setTool("wall"); break;
    case "h":
    case "H":
      // H toggles wall size when a wall is selected, else picks Hole tool
      if (state.selection && state.selection.kind === "wall") {
        pushHistory();
        const r = getSelectedRect();
        r.size = r.size === 1 ? 0.5 : 1;
        syncSelectionPanel();
        draw();
      } else {
        setTool("hole");
      }
      break;
    case "s": case "S": setTool("start"); break;
    case "g": case "G": setTool("goal"); break;
    case "d": case "D":
      if (!e.metaKey && !e.ctrlKey) duplicateSelected();
      break;
    case "Delete": case "Backspace":
      e.preventDefault();
      deleteSelected();
      break;
    case "ArrowLeft":
      e.preventDefault();
      nudgeSelected(e.shiftKey ? -10 : -1, 0); break;
    case "ArrowRight":
      e.preventDefault();
      nudgeSelected(e.shiftKey ?  10 :  1, 0); break;
    case "ArrowUp":
      e.preventDefault();
      nudgeSelected(0, e.shiftKey ? -10 : -1); break;
    case "ArrowDown":
      e.preventDefault();
      nudgeSelected(0, e.shiftKey ?  10 :  1); break;
    case "Escape":
      setSelection(null);
      break;
  }
});

// ----------------------- Boot -----------------------
window.addEventListener("resize", () => { if (state.pack) draw(); });
window.addEventListener("beforeunload", (e) => {
  if (state.loaded && state.loaded.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Belt-and-suspenders: if the browser restores us from bfcache (Safari and
// Chrome do this on back/forward, sometimes on reload), the previous DOM
// state — including any modal that happened to be open — is reinstated.
// Slam every modal shut on restore so the user can never get stranded.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) closeModals();
});

assetsReady.then(() => {
  closeModals();
  setView("empty");

  setTool("select");
  syncAll();
  history.past.length = 0;
});
