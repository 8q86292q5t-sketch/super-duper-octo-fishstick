// Microphone capture, cleanup (resample, trim, normalize), quality checks and WAV encoding.

export const SAMPLE_RATE = 22050; // Piper / LJSpeech standard

export class Recorder {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.mediaRecorder = null;
    this.chunks = [];
  }

  async init() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access needs a secure page (https:// or localhost). See README.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Raw, unprocessed audio gives the best training data.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.levelBuf = new Float32Array(this.analyser.fftSize);
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    for (const v of this.levelBuf) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  async start() {
    await this.init();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
    const mimeType = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
    this.mediaRecorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mediaRecorder.start();
  }

  stop() {
    return new Promise((resolve) => {
      const mr = this.mediaRecorder;
      if (!mr || mr.state === "inactive") return resolve(null);
      mr.onstop = () => resolve(new Blob(this.chunks, { type: mr.mimeType }));
      mr.stop();
    });
  }

  get recording() {
    return this.mediaRecorder?.state === "recording";
  }
}

function decode(ctx, arrayBuffer) {
  // Safari's older callback-style API needs this wrapper.
  return new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer, resolve, reject));
}

/** Convert a compressed recording into clean mono 22.05 kHz samples plus a quality report. */
export async function processRecording(blob, ctx, opts = {}) {
  const decoded = await decode(ctx, await blob.arrayBuffer());

  // Mix to mono and resample in one offline render.
  const length = Math.ceil(decoded.duration * SAMPLE_RATE);
  const off = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  let samples = rendered.getChannelData(0);

  let rawPeak = 0;
  let clipped = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > rawPeak) rawPeak = a;
    if (a >= 0.99) clipped++;
  }

  // Estimate noise floor and trim leading/trailing silence.
  const frame = Math.round(SAMPLE_RATE * 0.02);
  const rms = [];
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(i + frame, samples.length);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    rms.push(Math.sqrt(sum / (end - i)));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const threshold = Math.max(noise * 3, loud * 0.08, 0.004);
  let first = rms.findIndex((v) => v > threshold);
  let last = rms.length - 1 - [...rms].reverse().findIndex((v) => v > threshold);
  if (first < 0) { first = 0; last = rms.length - 1; }
  if (opts.trim !== false) {
    const pad = Math.round(0.15 * SAMPLE_RATE); // keep 150 ms of breathing room
    const s = Math.max(0, first * frame - pad);
    const e = Math.min(samples.length, (last + 1) * frame + pad);
    samples = samples.slice(s, e);
  } else {
    samples = samples.slice();
  }

  // Remove DC offset and peak-normalize to -1 dBFS.
  let mean = 0;
  for (const v of samples) mean += v;
  mean /= samples.length || 1;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] -= mean;
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (opts.normalize !== false && peak > 0) {
    const gain = Math.min(0.89 / peak, 20);
    for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  }

  const duration = samples.length / SAMPLE_RATE;
  const snrDb = Math.min(60, 20 * Math.log10(Math.max(loud, 1e-5) / Math.max(noise, 1e-5)));
  const warnings = [];
  if (clipped > SAMPLE_RATE * 0.002) warnings.push("Clipping detected: move back from the mic or speak a little softer.");
  if (rawPeak < 0.05) warnings.push("Very quiet: move closer to the mic.");
  if (snrDb < 20) warnings.push("Noisy background: try a quieter room.");
  if (duration < 0.4) warnings.push("Very short: did the whole phrase get captured?");
  if (duration > 20) warnings.push("Over 20 seconds: long clips can hurt training.");

  return { samples, duration, snrDb, rawPeak, warnings };
}

export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (const s of samples) {
    const c = Math.max(-1, Math.min(1, s));
    v.setInt16(o, c < 0 ? c * 0x8000 : c * 0x7fff, true);
    o += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Draw a simple waveform of a WAV blob onto a canvas. */
export async function drawWaveform(canvas, blob, ctx) {
  const g = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  g.clearRect(0, 0, w, h);
  if (!blob) return;
  const audio = await decode(ctx, await blob.arrayBuffer());
  const data = audio.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  g.fillStyle = getComputedStyle(canvas).color;
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    for (let j = x * step; j < (x + 1) * step && j < data.length; j++) {
      if (data[j] < min) min = data[j];
      if (data[j] > max) max = data[j];
    }
    if (min > max) break;
    g.fillRect(x, ((1 - max) / 2) * h, 1, Math.max(1, ((max - min) / 2) * h));
  }
}
