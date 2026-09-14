import { parsePcm16Wav } from '../speaker/audio.js';

/** Read-only exact-zero check. Quiet, uncertain and unsupported audio is sent intact. */
export function isDigitalSilence(audio: Buffer): boolean {
  try {
    const { data } = parsePcm16Wav(audio);
    for (let i = 0; i < data.length; i += 2) if (data.readInt16LE(i) !== 0) return false;
    return true;
  } catch { return false; }
}
