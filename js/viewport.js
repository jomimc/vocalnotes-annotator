// Shared time window for all lanes: [start, start + span] seconds, mapped onto canvas width.

export class Viewport {
  constructor(onChange) {
    this.start = 0; this.span = 15; this.duration = 1; this.width = 1;
    this.minSpan = 0.25; this.onChange = onChange;
  }
  setDuration(d) { this.duration = d; this.span = Math.min(15, d); this.start = 0; this.changed(); }
  x(t) { return (t - this.start) / this.span * this.width; }
  t(x) { return this.start + x / this.width * this.span; }
  clamp() {
    this.span = Math.max(this.minSpan, Math.min(this.duration, this.span));
    this.start = Math.max(0, Math.min(this.duration - this.span, this.start));
  }
  zoomAt(t, factor) {
    const frac = (t - this.start) / this.span;
    this.span *= factor; this.start = t - frac * this.span;
    this.clamp(); this.changed();
  }
  panBy(dt) { this.start += dt; this.clamp(); this.changed(); }
  centerOn(t) { this.start = t - this.span / 2; this.clamp(); this.changed(); }
  ensureVisible(t) {            // page-follow during playback
    if (t > this.start + this.span * 0.95 || t < this.start) { this.start = t - this.span * 0.05; this.clamp(); this.changed(); }
  }
  changed() { this.onChange?.(); }
}
