// Folder loading, CSV parsing and saving.
// A track folder holds one audio file plus optional annotations, auto-detected by suffix:
//   *.wav|mp3|m4a|flac|ogg   audio (first match)
//   *notes.csv / *segments.csv   notes (ONSET, F0 Hz, DURATION), one file per transcriber
//   *pitches.csv              f0 trace (TIME, F0 Hz), one per transcriber
//   *syllables.csv            syllable onsets (TIME, LABEL[, SCORE])
//   *.txt                     plain text to place
// Human annotations are saved to (and also read from) the subfolder  annotations/.
// Transcriber/annotator id = the middle part of SONG__ID__type.csv, else the file stem.

const AUDIO_RE = /\.(wav|mp3|m4a|flac|ogg|aac)$/i;

export const ANNOT_DIR = "annotations";
export const canWriteFolders = typeof window.showDirectoryPicker === "function";   // Chromium only

export async function pickFolderWithHandle() {
  // File System Access API (Chromium): lets us save back into the folder.
  const dir = await window.showDirectoryPicker({ id: "syllable-annotator", mode: "readwrite" });
  const files = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file") files.push(await h.getFile());
    else if (h.kind === "directory" && name === ANNOT_DIR)
      for await (const [, h2] of h.entries()) if (h2.kind === "file") files.push(await h2.getFile());
  }
  return { files, dirHandle: dir, folderName: dir.name };
}

export function filesFromInput(fileList) {
  // top-level files of the chosen folder, plus files in its annotations/ subfolder
  const files = [...fileList].filter(f => {
    const parts = (f.webkitRelativePath || f.name).split("/");
    return parts.length <= 2 || (parts.length === 3 && parts[1] === ANNOT_DIR);
  });
  const folderName = (files[0]?.webkitRelativePath || "").split("/")[0] || "folder";
  return { files, dirHandle: null, folderName };
}

function idFromName(name, suffix) {
  const stem = name.replace(/\.[^.]+$/, "");
  const parts = stem.split("__");
  if (parts.length >= 3) return parts[parts.length - 2];
  return stem.replace(new RegExp(`[_-]*${suffix}$`, "i"), "") || stem;
}

export function songName(audioName) {
  return audioName.replace(/\.[^.]+$/, "");
}

export async function classify({ files }) {
  const out = { audio: null, notes: [], pitches: [], syllables: [], texts: [] };
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const n = f.name;
    if (n.startsWith(".")) continue;
    if (AUDIO_RE.test(n)) { if (!out.audio) out.audio = f; continue; }
    const lower = n.toLowerCase();
    if (lower.endsWith("syllables.csv")) out.syllables.push({ id: idFromName(n, "syllables"), file: f, rows: parseSyllables(await f.text()) });
    else if (lower.endsWith("notes.csv")) out.notes.push({ id: idFromName(n, "notes"), file: f, rows: parseNotes(await f.text()) });
    else if (lower.endsWith("segments.csv") && !files.some(g => g.name === n.replace(/segments\.csv$/i, "notes.csv")))
      out.notes.push({ id: idFromName(n, "segments"), file: f, rows: parseNotes(await f.text()) });
    else if (lower.endsWith("pitches.csv")) out.pitches.push({ id: idFromName(n, "pitches"), file: f, rows: parsePitches(await f.text()) });
    else if (lower.endsWith(".txt") && !/readme/i.test(n)) out.texts.push({ name: n, text: await f.text() });
  }
  return out;
}

// ---------------------------------------------------------------- CSV
export function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  text = text.replace(/^﻿/, "");
  // separator: comma, unless the first line has semicolons and no commas (European exports)
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const SEP = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === SEP) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(x => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field); if (row.some(x => x !== "")) rows.push(row);
  return rows;
}

function splitHeader(rows) {
  if (!rows.length) return { header: null, body: [] };
  const first = rows[0];
  // header iff the FIRST column is non-numeric ("0.52,la" is data, "TIME,LABEL" is a header)
  const isHeader = isNaN(Number(first[0].trim().replace(",", ".")));
  return isHeader ? { header: first.map(h => h.trim().toLowerCase()), body: rows.slice(1) } : { header: null, body: rows };
}

function col(header, names, fallback) {
  if (!header) return fallback;
  const i = header.findIndex(h => names.includes(h));
  return i >= 0 ? i : fallback;
}

const num = (s) => Number(String(s ?? "").trim().replace(",", "."));   // tolerate decimal commas

export function parseNotes(text) {
  const { header, body } = splitHeader(parseCSV(text));
  const ci = col(header, ["onset", "time", "start"], 0), cf = col(header, ["f0", "freq", "pitch", "value"], 1),
        cd = col(header, ["duration", "dur"], 2);
  return body.map(r => ({ t: num(r[ci]), f: num(r[cf]), d: num(r[cd]) })).filter(n => isFinite(n.t) && n.f > 0 && n.d > 0);
}

export function parsePitches(text) {
  const { header, body } = splitHeader(parseCSV(text));
  const ct = col(header, ["time", "t"], 0), cf = col(header, ["f0", "freq", "pitch", "value"], 1);
  const t = [], f = [];
  for (const r of body) { const a = num(r[ct]), b = num(r[cf]); if (isFinite(a) && b > 0) { t.push(a); f.push(b); } }
  return { t: Float64Array.from(t), f: Float32Array.from(f) };
}

export function parseSyllables(text) {
  const { header, body } = splitHeader(parseCSV(text));
  const ct = col(header, ["time", "onset", "start"], 0), cl = col(header, ["label", "syll", "syllable", "text"], 1),
        cs = col(header, ["score"], -1);
  return body.map(r => ({ t: num(r[ct]), label: (r[cl] ?? "").trim(), score: cs >= 0 ? num(r[cs]) : null }))
             .filter(s => isFinite(s.t) && s.label !== "*")
             .sort((a, b) => a.t - b.t);
}

function q(s) { return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export function syllablesToCSV(sylls) {
  return "TIME,LABEL\n" + sylls.map(s => `${s.t.toFixed(4)},${q(s.label)}`).join("\n") + "\n";
}

// ---------------------------------------------------------------- saving
export async function saveFile(dirHandle, name, content) {
  if (dirHandle) {
    try {
      if ((await dirHandle.queryPermission?.({ mode: "readwrite" })) !== "granted")
        await dirHandle.requestPermission?.({ mode: "readwrite" });
      const sub = await dirHandle.getDirectoryHandle(ANNOT_DIR, { create: true });
      const fh = await sub.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(content); await w.close();
      return "folder";
    } catch (e) { console.warn("Folder save failed, downloading instead", e); }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "download";
}
