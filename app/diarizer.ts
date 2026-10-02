// Lightweight in-browser speaker separation ("who spoke this line?").
// Each transcript segment gets a voice fingerprint — median pitch plus a
// loudness-normalized spectral envelope — which is matched to the nearest
// known speaker or starts a new one. Approximate by design: no server, no
// extra API, works best with distinct voices and one person talking at a time.

export type Speaker = {
  id: string;
  name: string;
  color: string;
  centroid: number[] | null; // [pitchSemitones, ...bandsDb]
  count: number;
  renamed?: boolean; // user or AI set a real name
};

export type VoicePrint = number[];

const COLORS = ['#6366f1', '#0d9488', '#d97706', '#db2777', '#16a34a', '#2563eb', '#9333ea', '#65a30d'];
const BANDS = 12;
const F_LO = 250; // above the fundamental, so the envelope reflects timbre rather than pitch
const F_HI = 5000;
const PITCH_SCALE = 3; // semitones that count as "one unit" of difference
const BAND_SCALE = 40; // dB (euclidean over all bands) that counts as one unit
const MIN_VOICED_FRAMES = 8;
const MAX_SPEAKERS = 8;

export function makeSpeaker(index: number): Speaker {
  return { id: `s${index + 1}`, name: `Speaker ${index + 1}`, color: COLORS[index % COLORS.length], centroid: null, count: 0 };
}

/** Collects per-frame features from an AnalyserNode between transcript segments. */
export class VoiceProfiler {
  private time: Float32Array<ArrayBuffer>;
  private freq: Float32Array<ArrayBuffer>;
  private pitches: number[] = [];
  private bandSum = new Array(BANDS).fill(0);
  private voiced = 0;
  private recentRms = new Float32Array(300); // ~5 s of frames, for a rolling noise floor
  private rmsIdx = 0;
  private noiseFloor = 0.008;
  private bandEdges: number[];

  constructor(private analyser: AnalyserNode, private sampleRate: number) {
    this.time = new Float32Array(analyser.fftSize);
    this.freq = new Float32Array(analyser.frequencyBinCount);
    const binHz = sampleRate / analyser.fftSize;
    this.bandEdges = Array.from({ length: BANDS + 1 }, (_, i) =>
      Math.round((F_LO * Math.pow(F_HI / F_LO, i / BANDS)) / binHz),
    );
  }

  /** Call once per animation frame. Returns the current RMS level (0..1-ish). */
  sample(): number {
    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (const v of this.time) sum += v * v;
    const rms = Math.sqrt(sum / this.time.length);

    // Noise floor = quiet end (10th percentile) of the last few seconds; even
    // continuous speech has gaps between words, so this tracks the room, not the talker.
    this.recentRms[this.rmsIdx++ % this.recentRms.length] = rms;
    if (this.rmsIdx % 30 === 0) {
      const sorted = [...this.recentRms.slice(0, Math.min(this.rmsIdx, this.recentRms.length))].sort((a, b) => a - b);
      this.noiseFloor = sorted[Math.floor(sorted.length * 0.1)];
    }
    if (rms < Math.max(0.008, this.noiseFloor * 2)) return rms;

    const pitch = detectPitch(this.time, this.sampleRate);
    if (!pitch) return rms;

    this.analyser.getFloatFrequencyData(this.freq);
    const bands: number[] = [];
    for (let b = 0; b < BANDS; b++) {
      let p = 0;
      const lo = this.bandEdges[b];
      const hi = Math.max(lo + 1, this.bandEdges[b + 1]);
      for (let k = lo; k < hi && k < this.freq.length; k++) p += Math.pow(10, this.freq[k] / 10);
      bands.push(10 * Math.log10(p / (hi - lo) + 1e-12));
    }
    const mean = bands.reduce((a, c) => a + c, 0) / BANDS; // remove loudness
    // Clamp near-empty bands so gaps between harmonics don't dominate the print.
    for (let b = 0; b < BANDS; b++) this.bandSum[b] += Math.max(bands[b] - mean, -20);
    this.pitches.push(12 * Math.log2(pitch / 100));
    this.voiced++;
    return rms;
  }

  /** Fingerprint of everything heard since the last call, or null if too little voice. */
  take(): VoicePrint | null {
    const enough = this.voiced >= MIN_VOICED_FRAMES;
    const print = enough ? [median(this.pitches), ...this.bandSum.map((s) => s / this.voiced)] : null;
    this.pitches = [];
    this.bandSum.fill(0);
    this.voiced = 0;
    return print;
  }
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Autocorrelation pitch detector for the human voice range (70–400 Hz). */
function detectPitch(buf: Float32Array, sampleRate: number): number | null {
  const minLag = Math.floor(sampleRate / 400);
  const maxLag = Math.min(Math.floor(sampleRate / 70), buf.length >> 1);
  let energy = 0;
  for (let i = 0; i < buf.length - maxLag; i++) energy += buf[i] * buf[i];
  if (energy === 0) return null;
  const corr = new Float32Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < buf.length - maxLag; i++) c += buf[i] * buf[i + lag];
    corr[lag] = c / energy;
    if (corr[lag] > best) best = corr[lag];
  }
  if (best < 0.5) return null;
  // Take the first strong peak (shortest period) to avoid octave-down errors.
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= best * 0.9 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) return sampleRate / lag;
  }
  return null;
}

export function distance(a: VoicePrint, b: VoicePrint) {
  const dp = (a[0] - b[0]) / PITCH_SCALE;
  let sq = 0;
  for (let i = 1; i < a.length; i++) sq += (a[i] - b[i]) ** 2;
  const db = Math.sqrt(sq) / BAND_SCALE;
  return Math.sqrt(dp * dp + db * db);
}

/**
 * Pick the speaker for a fingerprint, creating one if nobody is close enough.
 * `sensitivity` 0..1: higher = splits voices more eagerly.
 * Returns the chosen id and the updated speaker list.
 */
export function assignSpeaker(
  print: VoicePrint | null,
  speakers: Speaker[],
  lastId: string | null,
  sensitivity: number,
): { id: string; speakers: Speaker[] } {
  if (!speakers.length) speakers = [makeSpeaker(0)];
  if (!print) return { id: lastId ?? speakers[0].id, speakers };

  const threshold = 1.6 - sensitivity * 1.1; // 0.5 (eager) … 1.6 (conservative)
  const known = speakers.filter((s) => s.centroid);
  let bestId: string | null = null;
  let best = Infinity;
  for (const s of known) {
    let d = distance(print, s.centroid!);
    if (s.id === lastId) d *= 0.85; // people usually keep talking — mild stickiness
    if (d < best) {
      best = d;
      bestId = s.id;
    }
  }

  let id: string;
  const blank = speakers.find((s) => !s.centroid);
  if (bestId && (best < threshold || speakers.length >= MAX_SPEAKERS)) id = bestId;
  else if (blank) id = blank.id;
  else {
    const s = makeSpeaker(speakers.length);
    speakers = [...speakers, s];
    id = s.id;
  }

  speakers = speakers.map((s) => {
    if (s.id !== id) return s;
    const n = Math.min(s.count, 20); // running mean that keeps adapting
    const centroid = s.centroid ? s.centroid.map((v, i) => (v * n + print[i]) / (n + 1)) : [...print];
    return { ...s, centroid, count: s.count + 1 };
  });
  return { id, speakers };
}
