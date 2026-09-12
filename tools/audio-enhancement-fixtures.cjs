/* Deterministic generated test audio; no user recordings or downloaded speech. */
'use strict';
function wav(
  samples,
  rate = 16000,
  { channels = 1, format = 1, bits = 16, metadata = false } = {},
) {
  const extra = metadata ? 12 : 0,
    bytes = new Uint8Array(44 + extra + samples.length * 2),
    view = new DataView(bytes.buffer);
  const text = (at, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  if (metadata) {
    text(36, 'JUNK');
    view.setUint32(40, 3, true);
    bytes.set([1, 2, 3], 44);
  }
  text(36 + extra, 'data');
  view.setUint32(40 + extra, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + extra + i * 2, samples[i], true);
  return bytes;
}
function fixture(
  rate = 16000,
  seconds = 3.017,
  { noiseOnly = false, voiceThroughout = false } = {},
) {
  const samples = new Int16Array(Math.round(rate * seconds));
  let seed = 93221,
    low = 0;
  for (let i = 0; i < samples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const random = (seed / 4294967296 - 0.5) * 2,
      t = i / rate;
    low = 0.9 * low + 0.1 * random;
    let value = 500 * random + 600 * low + 220 * Math.sin(2 * Math.PI * 60 * t);
    if (!noiseOnly && (voiceThroughout || (t > 0.7 && t < 2.5))) {
      const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.1 * t);
      const phase = 2 * Math.PI * (145 * t + 0.5 * Math.sin(2 * Math.PI * 1.9 * t));
      for (let h = 1; h <= 30; h++) {
        const hz = h * 145,
          weight =
            Math.exp(-Math.pow((hz - 650) / 220, 2)) +
            0.55 * Math.exp(-Math.pow((hz - 1300) / 280, 2)) +
            0.2 * Math.exp(-Math.pow((hz - 2500) / 380, 2));
        value += (1300 * envelope * weight * Math.sin(h * phase)) / Math.sqrt(h);
      }
    }
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }
  return samples;
}
function pcm(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array((bytes.length - 44) / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(44 + i * 2, true);
  return out;
}
function rms(samples, start = 0, end = samples.length) {
  let total = 0;
  for (let i = start; i < end; i++) total += samples[i] * samples[i];
  return Math.sqrt(total / Math.max(1, end - start));
}
module.exports = { wav, fixture, pcm, rms };
