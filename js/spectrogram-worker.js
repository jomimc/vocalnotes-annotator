// Short-time Fourier transform in a worker. Input: mono Float32Array, sample rate.
// Output: Uint8Array (frames x bins, row-major by frame) of dB magnitudes scaled 0..255,
// frequencies 0..fmax Hz. Hop is chosen so the number of frames stays <= maxFrames.

function fftInPlace(re, im) {           // iterative radix-2 Cooley-Tukey
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

self.onmessage = (e) => {
  const { samples, sr, nfft = 2048, fmax = 5000, maxFrames = 16000, dynRange = 70 } = e.data;
  const hop = Math.max(128, Math.ceil(samples.length / maxFrames));
  const frames = Math.max(1, Math.floor((samples.length - nfft) / hop) + 1);
  const bins = Math.min(nfft / 2, Math.ceil(fmax / sr * nfft));
  const win = new Float32Array(nfft).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (nfft - 1)));
  const db = new Float32Array(frames * bins);
  const re = new Float32Array(nfft), im = new Float32Array(nfft);
  let max = -Infinity;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < nfft; i++) { re[i] = (samples[off + i] || 0) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let b = 0; b < bins; b++) {
      const v = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-12);
      db[f * bins + b] = v; if (v > max) max = v;
    }
    if (f % 500 === 0) self.postMessage({ progress: f / frames });
  }
  const out = new Uint8Array(frames * bins);
  for (let i = 0; i < db.length; i++) out[i] = Math.max(0, Math.min(255, 255 * (1 + (db[i] - max) / dynRange)));
  self.postMessage({ done: true, data: out, frames, bins, hop, sr, fmax: bins / nfft * sr }, [out.buffer]);
};
