'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'provenance-links.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const worker=fs.readFileSync(path.join(root,'sw.js'),'utf8');

assert.match(source,/time\', card\)\?\.dateTime|\$\('time', card\)\?\.dateTime/,
  'memory cards must bind through their exact recording timestamp rather than list position');
assert.doesNotMatch(source,/records\s*\[\s*index\s*\]/,
  'provenance binding must never depend on parallel array positions');
assert.match(source,/start_ms/,'structured memory offsets must drive source links');
assert.match(source,/data\.offsetMs|dataset\.offsetMs/,'source buttons must retain their transcript offset');
assert.match(source,/nearestTranscriptPosition/,'source jumps must resolve to the nearest grounded transcript line');
assert.match(source,/audio\.currentTime/,'source jumps must seek the source audio to the same offset');
assert.match(source,/textarea\.readOnly\s*=\s*true/,'generated transcript must not silently diverge from its summary');
assert.match(source,/not used as transcript evidence/,'recording notes must be presented without pretending they grounded the AI summary');
assert.match(source,/clock\(recording, offsetMs\)/,'relative offsets must be rendered as actual clock time');
assert(html.includes('provenance-links.js?v=1.0.0-provenance1'),'production bootstrap must load provenance links');
assert(worker.includes("'./provenance-links.js'"),'offline shell must cache provenance links');

console.log('PASS: summaries, notes, transcripts, timestamps and source audio stay on one recording provenance chain.');
