// Playback (HTMLAudioElement: time-stretch with preserved pitch for slow-down) plus a decoded
// mono buffer for drawing. Onset clicks are synthesised with Web Audio and scheduled ahead of the
// playhead (lookahead scheduler), so they stay in time at any speed.

export class AudioEngine {
  constructor() {
    this.el = new Audio();
    this.el.preload = "auto";
    for (const k of ["preservesPitch", "mozPreservesPitch", "webkitPreservesPitch"]) if (k in this.el) this.el[k] = true;
    this.ctx = null;
    this.samples = null; this.sr = 0; this.duration = 0;
    this.clicks = false; this.getOnsets = () => [];
    this._scheduled = new Set(); this._timer = null; this._nodes = [];
    this.el.addEventListener("play", () => this._startScheduler());
    this.el.addEventListener("pause", () => { this._stopScheduler(); this._cancelClicks(); });
    this.el.addEventListener("seeked", () => this._cancelClicks());
  }

  // Stop clicks already queued in Web Audio (otherwise a seek/rate change re-schedules the same
  // onset -> double click, and queued clicks sound after pause).
  _cancelClicks() {
    for (const o of this._nodes) { try { o.stop(); } catch {} }
    this._nodes = []; this._scheduled.clear();
  }

  async load(file) {
    if (this.el.src) URL.revokeObjectURL(this.el.src);
    this.el.src = URL.createObjectURL(file);
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const n = buf.length, mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    this.samples = mono; this.sr = buf.sampleRate; this.duration = buf.duration;
    // min/max per block of BLOCK samples, for drawing zoomed-out waveforms without missing peaks
    const B = AudioEngine.BLOCK, nb = Math.ceil(n / B);
    this.blockMin = new Float32Array(nb); this.blockMax = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let lo = 1, hi = -1;
      for (let i = b * B, e = Math.min(n, i + B); i < e; i++) { const v = mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      this.blockMin[b] = lo; this.blockMax[b] = hi;
    }
  }

  get time() { return this.el.currentTime; }
  set time(t) { this.el.currentTime = Math.max(0, Math.min(this.duration, t)); this._cancelClicks(); }
  get playing() { return !this.el.paused; }
  set rate(r) { this.el.playbackRate = r; this._cancelClicks(); }
  get rate() { return this.el.playbackRate; }

  async toggle() {
    if (this.playing) { this.el.pause(); return; }
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    if (this.el.currentTime >= this.duration - 0.01) this.el.currentTime = 0;
    await this.el.play();
  }

  _startScheduler() {
    this._scheduled.clear();
    this._timer = setInterval(() => this._schedule(), 25);
  }
  _stopScheduler() { clearInterval(this._timer); this._timer = null; }

  _schedule() {
    if (!this.clicks || !this.ctx) return;
    const look = 0.15 * this.rate, now = this.el.currentTime, ctxNow = this.ctx.currentTime;
    for (const t of this.getOnsets()) {
      if (t < now || t > now + look) continue;
      const key = t.toFixed(4);
      if (this._scheduled.has(key)) continue;
      this._scheduled.add(key);
      this._click(ctxNow + (t - now) / this.rate);
    }
  }

  _click(when) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = 2000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.5, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
    o.connect(g).connect(this.ctx.destination);
    o.start(when); o.stop(when + 0.04);
    this._nodes.push(o);
    o.onended = () => { const i = this._nodes.indexOf(o); if (i >= 0) this._nodes.splice(i, 1); };
  }
}
AudioEngine.BLOCK = 256;
