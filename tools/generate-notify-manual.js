// generate-notify-manual.js — KeySwitch Desktop
// =============================================================================
// Synthesizes assets/notify-manual.wav: the confirmation sound played when the
// user runs a manual conversion with the global shortcut (Alt+Shift+J).
//
// It is deliberately a COUSIN of the auto-correction sound, not a clone: a
// short, warm two-note ASCENDING chime (a major third, C6 → E6) so the manual
// shortcut has its own recognizable "done" ring while still feeling like part
// of the same product. Pure sine partials with a soft attack and an
// exponential decay keep it click-free and gentle rather than harsh/beepy.
//
// Regenerate with:  node tools/generate-notify-manual.js
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const RATE = 44100;      // samples/sec
const CHANNELS = 1;
const BITS = 16;

// Two notes of a major third, played as a quick rising arpeggio with a little
// overlap so it rings as one gesture rather than two separate beeps.
const NOTES = [
  { freq: 1046.50, start: 0.00, dur: 0.26 }, // C6
  { freq: 1318.51, start: 0.11, dur: 0.30 }  // E6
];
const TOTAL = 0.44; // seconds

function sample(t) {
  let v = 0;
  for (const n of NOTES) {
    const rel = t - n.start;
    if (rel < 0 || rel > n.dur) continue;
    // Soft 6ms linear attack removes the click a hard start would make.
    const attack = Math.min(1, rel / 0.006);
    // Exponential decay for a natural bell-like tail.
    const decay = Math.exp(-rel * 6.5);
    const env = attack * decay;
    // Fundamental + a quiet second/third partial for warmth (not a bare sine).
    const w = Math.sin(2 * Math.PI * n.freq * rel)
            + 0.28 * Math.sin(2 * Math.PI * n.freq * 2 * rel)
            + 0.08 * Math.sin(2 * Math.PI * n.freq * 3 * rel);
    v += env * w;
  }
  return v;
}

const nSamples = Math.round(TOTAL * RATE);
const raw = new Float32Array(nSamples);
let peak = 0;
for (let i = 0; i < nSamples; i++) {
  const t = i / RATE;
  const v = sample(t);
  raw[i] = v;
  if (Math.abs(v) > peak) peak = Math.abs(v);
}

// Normalize to a comfortable level (not full-scale — it's a gentle notifier).
const target = 0.72;
const gain = peak > 0 ? target / peak : 1;

const dataBytes = nSamples * CHANNELS * (BITS / 8);
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);                       // PCM
buf.writeUInt16LE(CHANNELS, 22);
buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * CHANNELS * (BITS / 8), 28);
buf.writeUInt16LE(CHANNELS * (BITS / 8), 32);
buf.writeUInt16LE(BITS, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataBytes, 40);

for (let i = 0; i < nSamples; i++) {
  let s = raw[i] * gain;
  s = Math.max(-1, Math.min(1, s));
  buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
}

const out = path.join(__dirname, '..', 'assets', 'notify-manual.wav');
fs.writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes, ${TOTAL}s, ${RATE}Hz)`);
