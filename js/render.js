// Drawing for all lanes. Every function takes (ctx, w, h, state) and draws in CSS pixels.

// Categorical palette for transcribers (validated light-mode slots 1-6 of the default palette).
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
// CSS colour tokens, read once per frame (getComputedStyle per mark was the hot path)
const _css = new Map();
const css = (v) => { if (!_css.has(v)) _css.set(v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()); return _css.get(v); };
export function clearStyleCache() { _css.clear(); }

// Width of a syllable's label box: shared by drawing and hit-testing so they always agree.
export const LABEL_FONT = "14px system-ui, sans-serif";
export function boxWidth(ctx, label, x, xn) {
  ctx.font = LABEL_FONT;
  return Math.max(14, Math.min(xn - x - 2, Math.max(40, ctx.measureText(label || "·").width + 10)));
}

export function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function playhead(ctx, h, S) {
  const x = S.vp.x(S.time);
  if (x < 0 || x > S.vp.width) return;
  ctx.strokeStyle = css("--playhead"); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
}

function syllableGuides(ctx, h, S) {   // faint onset lines through the non-syllable lanes
  ctx.strokeStyle = css("--syll"); ctx.globalAlpha = 0.25; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (const s of S.sylls) { const x = S.vp.x(s.t); if (x >= 0 && x <= S.vp.width) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); } }
  ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- waveform
export function drawWave(cv, S) {
  const { ctx, w, h } = setupCanvas(cv);
  const { samples, sr } = S.audio;
  if (!samples) return;
  const mid = h / 2, amp = h / 2 - 4;
  ctx.fillStyle = css("--ink2");
  const spp = S.vp.span * sr / w;                       // samples per pixel
  const { blockMin, blockMax } = S.audio, B = S.audio.constructor.BLOCK, useBlocks = spp >= 4 * B;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(S.vp.t(x) * sr), b = Math.min(samples.length, Math.floor(a + Math.max(1, spp)));
    if (a >= samples.length || b <= 0) continue;
    let lo = 1, hi = -1;
    if (useBlocks) {                                    // zoomed out: exact min/max from precomputed blocks
      for (let k = Math.max(0, Math.floor(a / B)), e = Math.ceil(b / B); k < e; k++) {
        if (blockMin[k] < lo) lo = blockMin[k]; if (blockMax[k] > hi) hi = blockMax[k];
      }
    } else {
      for (let i = Math.max(0, a); i < b; i++) { const v = samples[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    ctx.fillRect(x, mid - hi * amp * S.waveGain, 1, Math.max(1, (hi - lo) * amp * S.waveGain));
  }
  syllableGuides(ctx, h, S); playhead(ctx, h, S);
}

// ---------------------------------------------------------------- spectrogram
const VIRIDIS = [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
                 [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = i / 255 * (VIRIDIS.length - 1), k = Math.min(VIRIDIS.length - 2, Math.floor(p)), f = p - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = VIRIDIS[k][c] * (1 - f) + VIRIDIS[k + 1][c] * f;
  }
  return lut;
})();

export function buildSpecTiles(spec, tileW = 4096) {     // spec: {data, frames, bins}
  const tiles = [];
  for (let f0 = 0; f0 < spec.frames; f0 += tileW) {
    const fw = Math.min(tileW, spec.frames - f0);
    let cv;                                              // OffscreenCanvas 2D needs Safari 16.4+
    if (typeof OffscreenCanvas !== "undefined") cv = new OffscreenCanvas(fw, spec.bins);
    else { cv = document.createElement("canvas"); cv.width = fw; cv.height = spec.bins; }
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(fw, spec.bins);
    for (let x = 0; x < fw; x++) for (let b = 0; b < spec.bins; b++) {
      const v = spec.data[(f0 + x) * spec.bins + b], o = ((spec.bins - 1 - b) * fw + x) * 4;
      img.data[o] = LUT[v * 3]; img.data[o + 1] = LUT[v * 3 + 1]; img.data[o + 2] = LUT[v * 3 + 2]; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    tiles.push({ f0, fw, cv });
  }
  return tiles;
}

export function drawSpec(cv, S) {
  const { ctx, w, h } = setupCanvas(cv);
  const sp = S.spec;
  if (!sp?.tiles) {
    ctx.fillStyle = css("--muted"); ctx.font = "12px system-ui";
    ctx.fillText(sp?.progress != null ? `Computing spectrogram… ${Math.round(sp.progress * 100)}%` : "", 80, h / 2);
    return;
  }
  const fps = sp.sr / sp.hop;                            // frames per second
  ctx.imageSmoothingEnabled = true;
  for (const t of sp.tiles) {
    const t0 = t.f0 / fps, t1 = (t.f0 + t.fw) / fps;
    if (t1 < S.vp.start || t0 > S.vp.start + S.vp.span) continue;
    ctx.drawImage(t.cv, 0, 0, t.fw, sp.bins, S.vp.x(t0), 0, S.vp.x(t1) - S.vp.x(t0), h);
  }
  ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.font = "10px system-ui";
  for (const f of [1000, 2000, 3000, 4000]) { const y = h - f / sp.fmax * h; if (y > 10) ctx.fillText(`${f / 1000}k`, w - 22, y + 3); }
  syllableGuides(ctx, h, S); playhead(ctx, h, S);
}

// ---------------------------------------------------------------- f0 / notes
const NOTE = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const hz2midi = (f) => 69 + 12 * Math.log2(f / 440);

export function pitchRange(tracks) {                     // robust MIDI range from notes (else f0)
  const v = [];
  for (const tr of tracks) {
    if (tr.notes) for (const n of tr.notes) v.push(hz2midi(n.f));
    if (!tr.notes && tr.pitch) for (let i = 0; i < tr.pitch.f.length; i += 5) v.push(hz2midi(tr.pitch.f[i]));
  }
  if (!v.length) return [48, 72];
  v.sort((a, b) => a - b);
  const lo = v[Math.floor(v.length * 0.01)], hi = v[Math.floor(v.length * 0.99)];
  return [Math.floor(lo - 2), Math.ceil(hi + 2)];
}

export function drawPitch(cv, S) {
  const { ctx, w, h } = setupCanvas(cv);
  const [m0, m1] = S.pitchRange, y = (m) => h - 6 - (m - m0) / (m1 - m0) * (h - 12);
  ctx.font = "10px system-ui"; ctx.fillStyle = css("--muted");
  const every = (m1 - m0) > 24 ? 12 : (m1 - m0) > 12 ? 2 : 1;
  for (let m = Math.ceil(m0); m <= m1; m++) {             // semitone grid, labelled sparsely
    const yy = Math.round(y(m)) + .5;
    ctx.strokeStyle = css("--line"); ctx.globalAlpha = m % 12 === 0 ? 0.9 : 0.35;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke(); ctx.globalAlpha = 1;
    if (m % every === 0 && yy > 18) ctx.fillText(`${NOTE[m % 12]}${Math.floor(m / 12) - 1}`, 4, yy - 2);
  }
  const t0 = S.vp.start, t1 = S.vp.start + S.vp.span;
  S.tracks.forEach((tr, k) => {
    if (!tr.visible) return;
    const col = SERIES[k % SERIES.length];
    if (tr.pitch && S.showF0) {                         // f0 trace, broken at unvoiced gaps
      ctx.strokeStyle = col; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.beginPath();
      const { t, f } = tr.pitch; let prev = -1;
      let i = lowerBound(t, t0 - 0.1);
      for (; i < t.length && t[i] <= t1 + 0.1; i++) {
        const xx = S.vp.x(t[i]), yy = y(hz2midi(f[i]));
        if (prev >= 0 && t[i] - t[prev] < 0.05) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
        prev = i;
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (tr.notes) {                                     // notes: bar + open onset circle
      const off = -k * 0.12;                            // small offset keeps coincident notes visible
      for (const n of tr.notes) {
        if (n.t + n.d < t0 || n.t > t1) continue;
        const x0 = S.vp.x(n.t), x1 = S.vp.x(n.t + n.d), yy = y(hz2midi(n.f) + off);
        ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(Math.max(x0 + 1, x1 - 1), yy); ctx.stroke();
        ctx.fillStyle = css("--surface"); ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(x0, yy, 3.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      }
    }
  });
  syllableGuides(ctx, h, S); playhead(ctx, h, S);
}

function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }

// ---------------------------------------------------------------- syllables
export const BOX_Y = 18, BOX_H = 26, REF_Y = 50;

export function drawSyll(cv, S) {
  const { ctx, w, h } = setupCanvas(cv);
  const sy = S.sylls;
  ctx.textBaseline = "middle";
  for (let i = 0; i < sy.length; i++) {
    const x = S.vp.x(sy[i].t);
    const xn = i + 1 < sy.length ? S.vp.x(sy[i + 1].t) : x + 120;
    if (xn < 0 || x > w) continue;
    const sel = i === S.selected, boxW = boxWidth(ctx, sy[i].label, x, xn);
    ctx.fillStyle = sel ? css("--syll-sel") : css("--syll-box");
    ctx.globalAlpha = sel ? 0.25 : 1;
    ctx.fillRect(x + 1, BOX_Y, boxW, BOX_H); ctx.globalAlpha = 1;
    ctx.strokeStyle = sel ? css("--syll-sel") : css("--line"); ctx.lineWidth = 1;
    ctx.strokeRect(x + 1.5, BOX_Y + .5, boxW - 1, BOX_H - 1);
    ctx.save(); ctx.beginPath(); ctx.rect(x + 2, BOX_Y, boxW - 3, BOX_H); ctx.clip();
    ctx.fillStyle = css("--ink"); ctx.fillText(sy[i].label || "·", x + 5, BOX_Y + BOX_H / 2); ctx.restore();
    ctx.strokeStyle = sel ? css("--syll-sel") : css("--syll"); ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  // reference layers (other syllable files), read-only ticks along the bottom
  ctx.font = "10px system-ui";
  S.refLayers.forEach((L, k) => {
    if (!L.visible) return;
    ctx.strokeStyle = ctx.fillStyle = SERIES[(k + 3) % SERIES.length];
    for (const s of L.rows) {
      const x = S.vp.x(s.t); if (x < 0 || x > w) continue;
      ctx.beginPath(); ctx.moveTo(x, REF_Y); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(s.label, x + 2, REF_Y + 6);
    }
  });
  playhead(ctx, h, S);
}

// ---------------------------------------------------------------- axis & overview
export function drawAxis(cv, S) {
  const { ctx, w, h } = setupCanvas(cv);
  const span = S.vp.span, steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60];
  const step = steps.find(s => w / (span / s) > 70) ?? 60;
  ctx.fillStyle = css("--ink2"); ctx.strokeStyle = css("--line"); ctx.font = "11px system-ui"; ctx.textBaseline = "top";
  for (let t = Math.ceil(S.vp.start / step) * step; t <= S.vp.start + span; t += step) {
    const x = Math.round(S.vp.x(t)) + .5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 5); ctx.stroke();
    ctx.fillText(fmtTime(t, step < 1), x + 2, 6);
  }
}

export function drawOverview(cv, S) {
  const { ctx, w, h } = setupCanvas(cv);
  const pk = S.overviewPeaks;
  if (pk) {
    ctx.fillStyle = css("--muted");
    for (let x = 0; x < w; x++) { const i = Math.floor(x / w * pk.length); const v = pk[i] * (h / 2 - 2); ctx.fillRect(x, h / 2 - v, 1, 2 * v + 1); }
  }
  const d = S.audio.duration || 1, x0 = S.vp.start / d * w, x1 = (S.vp.start + S.vp.span) / d * w;
  ctx.fillStyle = css("--accent"); ctx.globalAlpha = 0.18; ctx.fillRect(x0, 0, x1 - x0, h); ctx.globalAlpha = 1;
  ctx.strokeStyle = css("--accent"); ctx.lineWidth = 1.5; ctx.strokeRect(x0 + .75, .75, Math.max(2, x1 - x0 - 1.5), h - 1.5);
  ctx.strokeStyle = css("--playhead"); ctx.beginPath(); const xp = S.time / d * w; ctx.moveTo(xp, 0); ctx.lineTo(xp, h); ctx.stroke();
}

export function overviewPeaks(samples, n = 2000) {
  const out = new Float32Array(n), per = samples.length / n;
  let max = 1e-9;
  for (let i = 0; i < n; i++) {
    let m = 0; const a = Math.floor(i * per), b = Math.floor((i + 1) * per);
    for (let j = a; j < b; j += 4) { const v = Math.abs(samples[j]); if (v > m) m = v; }
    out[i] = m; if (m > max) max = m;
  }
  return out.map(v => v / max);
}

export function fmtTime(t, frac = true) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${frac ? s.toFixed(2).padStart(5, "0") : String(Math.round(s)).padStart(2, "0")}`;
}
