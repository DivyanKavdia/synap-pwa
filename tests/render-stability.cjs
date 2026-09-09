'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','memory-ui-fix.js'),'utf8');
const code=source
  .replace(/\/\*[\s\S]*?\*\//g,'')
  .replace(/^\s*\/\/.*$/gm,'');

assert.doesNotMatch(code,/setInterval\s*\(/,
  'Today processing status must not wake the page on a fixed timer');
assert.doesNotMatch(code,/panel\s*\.\s*replaceChildren\s*\(/,
  'Today processing updates must preserve the mounted panel instead of tearing it down');
assert.match(source,/function setText\(/,
  'Today processing should mutate text only when the value actually changes');
assert.match(source,/node&&node\.textContent!==value/,
  'no-op text writes should be skipped to avoid WebKit repaints');
for(const event of ['synap-processing-state','synap-memory-ready','synap-cloud-history-updated']){
  assert(source.includes(event),`Today processing should refresh from ${event}`);
}
assert.match(source,/updatePipelineSteps/,
  'processing steps should update in place');

console.log('PASS: Today processing is event-driven and preserves stable DOM to prevent repaint flicker.');
