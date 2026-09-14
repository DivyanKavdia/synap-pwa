// Explicit recovery for a leading zero byte before otherwise exact Synap ADPCM
// frames. Writes a separate file; never guesses alignment for general WAVs.
'use strict';
const fs = require('node:fs');
const codec = require('../audio-codec-v3.js');

function repair(bytes) {
  if (bytes.length < 1645 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
      bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 ||
      bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 32000 ||
      bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 ||
      bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== bytes.length - 44 ||
      (bytes.length - 45) % 1600 || bytes[44] !== 0) {
    throw Error('This file does not match the known leading-byte corruption. No file was written.');
  }
  const pcm = bytes.subarray(45);
  for (let offset = 0; offset < pcm.length; offset += 1600) {
    const frame = pcm.subarray(offset, offset + 1600);
    const samples = new Int16Array(800);
    for (let i = 0; i < samples.length; i++) samples[i] = frame.readInt16LE(i * 2);
    const restored = codec.decodeFrame(codec.encodeFrame(samples));
    if (!Buffer.from(restored).equals(frame)) {
      throw Error('Corrected samples do not exactly match Synap codec frames. No file was written.');
    }
  }
  const header = Buffer.from(bytes.subarray(0, 44));
  header.writeUInt32LE(pcm.length + 36, 4);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

if (require.main === module) {
  try {
    const [input, output, extra] = process.argv.slice(2);
    if (!input || !output || extra) throw Error('Usage: node tools/repair-pcm-alignment.cjs input.wav separate-output.wav');
    const corrected = repair(fs.readFileSync(input));
    fs.writeFileSync(output, corrected, { flag: 'wx' });
    console.log(`Recovered ${(corrected.length - 44) / 2} samples at original gain. Source preserved.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { repair };
