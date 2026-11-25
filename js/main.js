import { AudioEngine } from "./audio.js";
import { Viewport } from "./viewport.js";
import { pickFolderWithHandle, filesFromInput, classify, songName, syllablesToCSV, saveFile, canWriteFolders, ANNOT_DIR } from "./io.js";
import { drawWave, drawSpec, drawPitch, drawSyll, drawAxis, drawOverview, overviewPeaks, buildSpecTiles,
         pitchRange, fmtTime, SERIES, BOX_Y, BOX_H, boxWidth, clearStyleCache } from "./render.js";

const $ = (id) => document.getElementById(id);
const audio = new AudioEngine();

// ---------------------------------------------------------------- state
const S = {
  audio, vp: new Viewport(() => requestDraw()), time: 0,
  tracks: [],            // [{id, notes, pitch, visible}]
  layers: [],            // loaded syllable files [{id, rows}]
  editId: null,          // id of layer being edited ("new" for empty)
  sylls: [],             // editable syllables [{t, label}] sorted by t
  refLayers: [],         // other layers shown as read-only ticks
  selected: -1, tokens: [], queue: 0,
  spec: null, overviewPeaks: null, pitchRange: [48, 72], showF0: true, waveGain: 1,
  folder: null, dirHandle: null, song: "", dirty: false,
};
const undoStack = [], redoStack = [];
audio.getOnsets = () => S.sylls.map(s => s.t);

// ---------------------------------------------------------------- loading
async function openFolder() {
  try {
    if (window.showDirectoryPicker) await loadFolder(await pickFolderWithHandle());
    else $("dir-input").click();
  } catch (e) { if (e.name !== "AbortError") status(`Could not open folder: ${e.message}`, true); }
}
$("dir-input").addEventListener("change", async (e) => { if (e.target.files.length) await loadFolder(filesFromInput(e.target.files)); e.target.value = ""; });

async function loadFolder(src) {
  if (S.dirty && !confirm("Discard unsaved changes?")) return;
  S.dirty = false;                                       // already confirmed; don't ask again in selectLayer
  status("Loading…");
  const c = await classify(src);
  if (!c.audio) { status("No audio file (.wav/.mp3/…) found in that folder.", true); return; }
  if (audio.playing) audio.el.pause();
  specWorker?.terminate(); specWorker = null;
  await audio.load(c.audio);
  Object.assign(S, { folder: src.folderName, dirHandle: src.dirHandle, song: songName(c.audio.name), time: 0, selected: -1, spec: null });
  const ids = [...new Set([...c.notes.map(n => n.id), ...c.pitches.map(p => p.id)])];
  S.tracks = ids.map(id => ({ id, notes: c.notes.find(n => n.id === id)?.rows ?? null,
                              pitch: c.pitches.find(p => p.id === id)?.rows ?? null, visible: true }));
  S.layers = c.syllables.map(l => ({ id: l.id, rows: l.rows }));
  S.pitchRange = pitchRange(S.tracks);
  S.overviewPeaks = overviewPeaks(audio.samples);
  S.textSource = c.texts[0]?.text ?? "";
  $("empty-state").hidden = true; $("workspace").hidden = false;
  $("track-name").textContent = S.song; $("track-name").title = `${S.folder}/${c.audio.name}`;
  for (const id of ["btn-play", "sel-speed", "sel-layer", "btn-save"]) $(id).disabled = false;
  buildLegend(); buildLayerSelect();
  S.vp.width = $("cv-syll").clientWidth;
  S.vp.setDuration(audio.duration);
  selectLayer(S.layers.find(l => /mms/i.test(l.id) === false)?.id ?? S.layers[0]?.id ?? "new");
  if ($("chk-spec").checked) computeSpectrogram();
  status(`Loaded ${c.audio.name}: ${S.tracks.length} transcriber layer(s), ${S.layers.length} syllable file(s)` +
         (c.texts.length ? `, text “${c.texts[0].name}”` : "") +
         (S.dirHandle ? ` — saves go to ${S.folder}/${ANNOT_DIR}/` : " — this browser can only download saved files (use Chrome/Edge to save into the folder)"));
}

function buildLegend() {
  const L = $("pitch-legend"); L.innerHTML = "";
  S.tracks.forEach((tr, k) => {
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" checked><span class="swatch" style="background:${SERIES[k % SERIES.length]}"></span>`;
    lab.append(document.createTextNode(tr.id));
    lab.querySelector("input").addEventListener("change", (e) => { tr.visible = e.target.checked; requestDraw(); });
    L.appendChild(lab);
  });
}

function buildLayerSelect() {
  const sel = $("sel-layer"); sel.innerHTML = "";
  for (const l of S.layers) sel.add(new Option(`${l.id} (${l.rows.length})`, l.id));
  sel.add(new Option("New (empty)", "new"));
}

function selectLayer(id) {
  if (S.dirty && !confirm("Discard unsaved changes to the current layer?")) { $("sel-layer").value = S.editId; return; }
  S.editId = id; $("sel-layer").value = id;
  const src = S.layers.find(l => l.id === id);
  S.sylls = src ? src.rows.map(r => ({ t: r.t, label: r.label })) : [];
  S.refLayers = S.layers.filter(l => l.id !== id).map(l => ({ ...l, visible: true }));
  S.queue = 0; undoStack.length = 0; redoStack.length = 0; S.dirty = false; S.selected = -1;
  buildTokens();
  const draft = loadDraft();
  if (draft && confirm(`Restore unsaved work on “${S.song}” (${new Date(draft.when).toLocaleString()})?`)) {
    S.sylls = draft.sylls; S.queue = draft.queue; S.dirty = true;
  }
  updateButtons(); renderTokens(); requestDraw();
}
$("sel-layer").addEventListener("change", (e) => selectLayer(e.target.value));

// ---------------------------------------------------------------- spectrogram
let specWorker = null;
function computeSpectrogram() {
  if (S.spec || !audio.samples) return;
  S.spec = { progress: 0 };
  const w = specWorker = new Worker(new URL("./spectrogram-worker.js", import.meta.url));
  const samples = audio.samples.slice();
  w.onmessage = (e) => {
    if (w !== specWorker) return;                        // result of a previous track: ignore
    if (e.data.progress != null) { if (S.spec) S.spec.progress = e.data.progress; requestDraw(); return; }
    try { S.spec = { ...e.data, tiles: buildSpecTiles(e.data) }; }
    catch (err) { S.spec = null; status(`Spectrogram failed: ${err.message}`, true); }
    w.terminate(); specWorker = null; requestDraw();
  };
  w.onerror = (err) => { if (w === specWorker) { S.spec = null; specWorker = null; status(`Spectrogram failed: ${err.message}`, true); } };
  w.postMessage({ samples, sr: audio.sr }, [samples.buffer]);
}

// ---------------------------------------------------------------- editing (with undo)
function snapshot() { return JSON.stringify({ s: S.sylls, q: S.queue }); }
function commit(fn) {
  undoStack.push(snapshot()); if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  fn();
  S.sylls.sort((a, b) => a.t - b.t);
  S.dirty = true; saveDraft(); updateButtons(); renderTokens(); requestDraw();
}
function restore(json) { const o = JSON.parse(json); S.sylls = o.s; S.queue = o.q; S.selected = -1; S.dirty = true; saveDraft(); updateButtons(); renderTokens(); requestDraw(); }
function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); } }
function updateButtons() {
  $("btn-undo").disabled = !undoStack.length; $("btn-redo").disabled = !redoStack.length;
  $("btn-save").textContent = S.dirty ? "Save*" : "Save";
}

function addSyllable(t) {
  let label = "";
  if ($("chk-place").checked && S.queue < S.tokens.length) label = S.tokens[S.queue];
  commit(() => {
    if (label) S.queue++;
    S.sylls.push({ t, label });
  });
  S.selected = S.sylls.findIndex(s => s.t === t);
  if (label) status(`Placed “${label}” at ${fmtTime(t)}`);
  else { status(`Added onset at ${fmtTime(t)} — type the syllable, Enter to confirm`); openEditorSoon(S.selected); }
}
// Open the label editor after the current pointer/key event has finished (otherwise the
// canvas takes focus back on mousedown and the editor closes immediately).
function openEditorSoon(i) { setTimeout(() => editLabel(i), 0); }

function deleteSyllable(i) {
  if (i < 0) return;
  const s = S.sylls[i];
  commit(() => S.sylls.splice(i, 1));
  S.selected = -1; status(`Deleted “${s.label}”`);
}

// ---------------------------------------------------------------- text queue
function tokenize(text, mode) {
  text = text.replace(/[\[\]{}()「」、。,.;:!?׃]/g, " ");
  if (mode === "char") {                 // one token per character; Japanese small kana / ー join the
    const out = [];                      // previous character so morae stay whole (じょ, きゃ, こー)
    for (const ch of text.replace(/\s+/g, "")) {
      if (out.length && /[ゃゅょぁぃぅぇぉャュョァィゥェォーゎ]/.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }
  return text.split(/[\s\-‐–]+/).filter(Boolean);
}
function buildTokens() { S.tokens = tokenize(S.textSource || "", $("sel-split").value); }
function renderTokens() {
  const box = $("text-tokens"); box.innerHTML = "";
  if (!S.tokens.length) {
    box.innerHTML = `<span class="muted">No text file in this folder. Add a <code>.txt</code> to place syllables from text.</span>`;
    $("queue-info").textContent = ""; return;
  }
  S.tokens.forEach((tok, i) => {
    const sp = document.createElement("span");
    sp.textContent = tok; sp.className = i < S.queue ? "placed" : i === S.queue ? "next" : "";
    sp.title = "Click to make this the next syllable to place";
    sp.addEventListener("click", () => { S.queue = i; renderTokens(); });
    box.appendChild(sp);
    if (i === S.queue) requestAnimationFrame(() => { box.scrollTop = Math.max(0, sp.offsetTop - box.offsetTop - 20); });
  });
  $("queue-info").textContent = S.queue < S.tokens.length ? `next: “${S.tokens[S.queue]}” (${S.queue + 1}/${S.tokens.length})` : "all placed";
}
$("sel-split").addEventListener("change", () => { buildTokens(); S.queue = 0; renderTokens(); });

// ---------------------------------------------------------------- drawing loop
let drawPending = false, lastNav = -1e9;
function userNavigated() { lastNav = performance.now(); }
function requestDraw() { if (!drawPending) { drawPending = true; requestAnimationFrame(draw); } }
function draw() {
  drawPending = false;
  clearStyleCache();
  if ($("workspace").hidden) return;
  S.time = audio.time;
  S.vp.width = $("cv-syll").clientWidth;
  if (audio.playing && performance.now() - lastNav > 2000) S.vp.ensureVisible(S.time);
  if ($("chk-wave").checked) drawWave($("cv-wave"), S);
  if ($("chk-spec").checked) drawSpec($("cv-spec"), S);
  if ($("chk-pitch").checked) drawPitch($("cv-pitch"), S);
  drawSyll($("cv-syll"), S); drawAxis($("cv-axis"), S); drawOverview($("overview"), S);
  $("time-readout").textContent = `${fmtTime(S.time)} / ${fmtTime(audio.duration)}`;
  if (audio.playing) requestDraw();
}
window.addEventListener("resize", requestDraw);

// ---------------------------------------------------------------- lane toggles
for (const [chk, lane] of [["chk-wave", "wave"], ["chk-spec", "spec"], ["chk-pitch", "pitch"]]) {
  $(chk).addEventListener("change", (e) => {
    document.querySelector(`.lane[data-lane="${lane}"]`).hidden = !e.target.checked;
    if (lane === "spec" && e.target.checked) computeSpectrogram();
    requestDraw();
  });
}

// ---------------------------------------------------------------- playback
$("btn-play").addEventListener("click", togglePlay);
async function togglePlay() { await audio.toggle(); $("btn-play").textContent = audio.playing ? "❚❚ Pause" : "▶ Play"; requestDraw(); }
audio.el.addEventListener("ended", () => { $("btn-play").textContent = "▶ Play"; requestDraw(); });
$("sel-speed").addEventListener("change", (e) => { audio.rate = +e.target.value; status(`Speed ${e.target.value}×`); e.target.blur(); });
$("chk-clicks").addEventListener("change", (e) => { audio.clicks = e.target.checked; });
function stepSpeed(d) {
  const sel = $("sel-speed"), i = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + d));
  sel.selectedIndex = i; audio.rate = +sel.value; status(`Speed ${sel.value}×`);
}
function seek(t) { audio.time = t; S.time = audio.time; requestDraw(); }

// ---------------------------------------------------------------- navigation: wheel, drag, overview
function onWheel(e) {
  if (!audio.samples) return;
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? S.vp.width : 1;   // lines/pages -> px (Firefox)
  const dx = e.deltaX * k, dy = e.deltaY * k;
  const horizontal = e.shiftKey || Math.abs(dx) > Math.abs(dy);
  if (horizontal) S.vp.panBy((dx || dy) / S.vp.width * S.vp.span);   // Shift+wheel arrives as deltaX on some OSes
  else S.vp.zoomAt(S.vp.t(e.clientX - rect.left), Math.exp(dy * 0.0015));
  userNavigated();
}
for (const id of ["cv-wave", "cv-spec", "cv-pitch", "cv-syll", "cv-axis"]) $(id).addEventListener("wheel", onWheel, { passive: false });

// click = seek, drag = pan (waveform / spectrogram / pitch / axis)
for (const id of ["cv-wave", "cv-spec", "cv-pitch", "cv-axis"]) {
  const cv = $(id);
  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !audio.samples) return;
    cv.setPointerCapture(e.pointerId);
    const x0 = e.clientX, start0 = S.vp.start; let moved = false;
    const move = (ev) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (moved) { S.vp.start = start0 - (ev.clientX - x0) / S.vp.width * S.vp.span; S.vp.clamp(); requestDraw(); }
    };
    const end = () => { for (const [t, f] of [["pointermove", move], ["pointerup", up], ["pointercancel", end]]) cv.removeEventListener(t, f); };
    const up = (ev) => {
      end();
      if (!moved) seek(S.vp.t(ev.clientX - cv.getBoundingClientRect().left)); else userNavigated();
    };
    cv.addEventListener("pointermove", move); cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", end);
  });
}

// overview: click/drag centres the window
$("overview").addEventListener("pointerdown", (e) => {
  if (!audio.samples) return;
  const cv = $("overview"); cv.setPointerCapture(e.pointerId);
  const go = (ev) => S.vp.centerOn((ev.clientX - cv.getBoundingClientRect().left) / cv.clientWidth * audio.duration);
  go(e);
  const up = () => { for (const t of ["pointermove", "pointerup", "pointercancel"]) cv.removeEventListener(t, t === "pointermove" ? go : up); userNavigated(); };
  cv.addEventListener("pointermove", go); cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
});

// ---------------------------------------------------------------- syllable lane interactions
const HIT_PX = 6;
function hitTest(x, y) {
  let best = -1, bd = Infinity;
  S.sylls.forEach((s, i) => { const d = Math.abs(S.vp.x(s.t) - x); if (d < bd) { bd = d; best = i; } });
  if (bd <= HIT_PX) return { i: best, part: "line" };
  if (y >= BOX_Y && y <= BOX_Y + BOX_H) {               // inside a label box (from its line to the next)
    for (let i = 0; i < S.sylls.length; i++) {
      const x0 = S.vp.x(S.sylls[i].t), x1 = i + 1 < S.sylls.length ? S.vp.x(S.sylls[i + 1].t) : x0 + 120;
      if (x >= x0 && x <= x0 + 1 + boxWidth(syl.getContext("2d"), S.sylls[i].label, x0, x1)) return { i, part: "box" };
    }
  }
  return null;
}

function snapTime(t, ev) {                               // Shift: snap to nearest visible note onset
  if (!ev.shiftKey) return t;
  let best = t, bd = HIT_PX * 2 / S.vp.width * S.vp.span;
  for (const tr of S.tracks) if (tr.visible && tr.notes) for (const n of tr.notes) {
    const d = Math.abs(n.t - t); if (d < bd) { bd = d; best = n.t; }
  }
  return best;
}

const syl = $("cv-syll");
syl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const r = syl.getBoundingClientRect(), h = hitTest(e.clientX - r.left, e.clientY - r.top);
  if (h) deleteSyllable(h.i);
  else {                                                 // nearest line within 12 px
    const x = e.clientX - r.left; let bi = -1, bd = 12;
    S.sylls.forEach((s, i) => { const d = Math.abs(S.vp.x(s.t) - x); if (d < bd) { bd = d; bi = i; } });
    deleteSyllable(bi);
  }
});

syl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !audio.samples) return;
  syl.focus();
  const r = syl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const h = hitTest(x, y);
  if (!h) { e.preventDefault(); addSyllable(snapTime(S.vp.t(x), e)); return; }
  S.selected = h.i; requestDraw();
  syl.setPointerCapture(e.pointerId);
  const orig = S.sylls[h.i].t, before = snapshot(); let moved = false;
  let lo = h.i > 0 ? S.sylls[h.i - 1].t + 0.01 : 0;
  let hi = h.i + 1 < S.sylls.length ? S.sylls[h.i + 1].t - 0.01 : audio.duration;
  if (lo > hi) lo = hi = orig;                            // coincident neighbours (e.g. after snapping)
  const move = (ev) => {
    const dx = ev.clientX - r.left - x;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    S.sylls[h.i].t = Math.max(lo, Math.min(hi, snapTime(orig + dx / S.vp.width * S.vp.span, ev)));
    requestDraw();
  };
  const up = () => {
    for (const [t, f] of [["pointermove", move], ["pointerup", up], ["pointercancel", up]]) syl.removeEventListener(t, f);
    if (moved) {
      undoStack.push(before); redoStack.length = 0; S.dirty = true; saveDraft(); updateButtons();
      status(`Moved “${S.sylls[h.i].label}” to ${fmtTime(S.sylls[h.i].t)}`);
    }
  };
  syl.addEventListener("pointermove", move); syl.addEventListener("pointerup", up); syl.addEventListener("pointercancel", up);
});

syl.addEventListener("dblclick", (e) => {
  const r = syl.getBoundingClientRect(), h = hitTest(e.clientX - r.left, e.clientY - r.top);
  if (h) editLabel(h.i);
});

// inline label editor
const ed = $("label-editor");
function editLabel(i) {
  if (i < 0 || i >= S.sylls.length) return;
  S.selected = i; requestDraw();
  const x = S.vp.x(S.sylls[i].t);
  ed.style.left = `${Math.max(0, Math.min(S.vp.width - 120, x + 1))}px`; ed.style.top = `${BOX_Y - 2}px`;
  ed.value = S.sylls[i].label; ed.hidden = false; ed.dataset.index = i; ed.focus(); ed.select();
}
function closeEditor(save) {
  if (ed.hidden) return;
  const i = +ed.dataset.index, v = ed.value.trim();
  ed.hidden = true;
  if (save && S.sylls[i] && v !== S.sylls[i].label) commit(() => { S.sylls[i].label = v; });
  syl.focus();
}
ed.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); closeEditor(true); save(); return; }
  if (e.key === "Enter") closeEditor(true);
  else if (e.key === "Escape") closeEditor(false);
  else if (e.key === "Tab") { e.preventDefault(); const i = +ed.dataset.index; closeEditor(true); editLabel(i + (e.shiftKey ? -1 : 1)); }
});
ed.addEventListener("blur", () => closeEditor(true));

// ---------------------------------------------------------------- keyboard
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=text], textarea, select")) return;
  // a focused button/checkbox would also "click" on Space -> double toggle; take focus away
  if (e.key === " " && e.target.matches("button, input")) e.target.blur();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); openFolder(); return; }
  if (mod) return;
  if (e.key === "?") { if (!$("help-dialog").open) $("help-dialog").showModal(); return; }
  if (!audio.samples) return;
  switch (e.key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "ArrowLeft": e.preventDefault(); e.shiftKey ? seek(audio.time - 0.1) : S.vp.panBy(-S.vp.span / 2); break;
    case "ArrowRight": e.preventDefault(); e.shiftKey ? seek(audio.time + 0.1) : S.vp.panBy(S.vp.span / 2); break;
    case "+": case "=": S.vp.zoomAt(S.vp.start + S.vp.span / 2, 0.7); break;
    case "-": case "_": S.vp.zoomAt(S.vp.start + S.vp.span / 2, 1 / 0.7); break;
    case "[": stepSpeed(-1); break;
    case "]": stepSpeed(1); break;
    case "c": case "C": $("chk-clicks").checked = !$("chk-clicks").checked; audio.clicks = $("chk-clicks").checked;
      status(`Clicks ${audio.clicks ? "on" : "off"}`); break;
    case "Delete": case "Backspace": deleteSyllable(S.selected); break;
    case "Enter": editLabel(S.selected); break;
    case "a": case "A": addSyllable(audio.time); break;   // tap along during playback
    case "Tab": if (document.activeElement === syl && S.sylls.length) { e.preventDefault(); S.selected = (S.selected + (e.shiftKey ? -1 : 1) + S.sylls.length) % S.sylls.length;
      S.vp.ensureVisible(S.sylls[S.selected].t); requestDraw(); } break;
  }
});

// ---------------------------------------------------------------- saving & drafts
function annotator() {
  let a = localStorage.getItem("annotator");
  if (!a) {
    a = (prompt("Your initials (used in the saved file name):", "") || "").trim().replace(/[^\w-]/g, "");
    if (!a) return null;
    localStorage.setItem("annotator", a);
  }
  return a;
}
async function save() {
  if (!audio.samples) return;
  const who = annotator(); if (!who) { status("Save cancelled — initials needed.", true); return; }
  const name = `${S.song}__${who}__syllables.csv`;
  if (S.editId !== who && S.layers.some(l => l.id === who) &&
      !confirm(`${name} already exists (your layer). Overwrite it with the “${S.editId}” edits?`)) return;
  const where = await saveFile(S.dirHandle, name, syllablesToCSV(S.sylls));
  clearDraft();
  const rows = S.sylls.map(s => ({ t: s.t, label: s.label }));
  const L = S.layers.find(l => l.id === who);
  if (L) L.rows = rows; else S.layers.push({ id: who, rows });
  S.dirty = false; buildLayerSelect(); S.editId = who; $("sel-layer").value = who;
  S.refLayers = S.layers.filter(l => l.id !== who).map(l => ({ ...l, visible: true }));
  updateButtons(); requestDraw();
  status(where === "folder" ? `Saved ${name} in ${S.folder}/${ANNOT_DIR}/`
         : `Downloaded ${name} — this browser cannot write into folders; move it to ${S.folder}/${ANNOT_DIR}/ (Chrome/Edge save there directly)`);
}
$("btn-save").addEventListener("click", save);
$("btn-undo").addEventListener("click", undo);
$("btn-redo").addEventListener("click", redo);

const draftKey = () => `draft:${S.folder}:${S.song}:${S.editId}`;
function saveDraft() { try { localStorage.setItem(draftKey(), JSON.stringify({ when: Date.now(), sylls: S.sylls, queue: S.queue })); } catch {} }
function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey())); } catch { return null; } }
function clearDraft() { localStorage.removeItem(draftKey()); }
window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------- misc
$("btn-open").addEventListener("click", openFolder);
$("btn-open-2").addEventListener("click", openFolder);
$("browser-note").hidden = canWriteFolders;
$("btn-help").addEventListener("click", () => $("help-dialog").showModal());
function status(msg, err = false) { const s = $("status"); s.textContent = msg; s.style.color = err ? "var(--playhead)" : ""; }

// test hook (used by the smoke test; harmless otherwise)
window.__annotator = { S, audio, loadFolder, save, undo, redo, addSyllable, deleteSyllable, selectLayer };
