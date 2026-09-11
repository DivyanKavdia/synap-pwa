'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const product=fs.readFileSync(path.join(__dirname,'..','product-ui.js'),'utf8');
const brain=fs.readFileSync(path.join(__dirname,'..','brain-ui.js'),'utf8');

assert.match(brain,/ask\.id='ask'/,'brain-ui remains the legacy creator of the Ask surface');
assert.match(product,/function dedupeSingletons\(/,'product runtime must enforce singleton product sections');
assert.match(product,/dedupeSelector\('#ask'\)/,'duplicate Ask sections must be removed');
assert.match(product,/querySelectorAll\('a\[href="#myActions"\]'\)/,'duplicate Actions navigation links must be removed');
assert.match(product,/dedupeSelector\('#followupInbox'\)/,'follow-up surface should share the singleton guarantee');
assert.match(product,/dedupeSelector\('#peopleMemory'\)/,'people surface should share the singleton guarantee');
assert.match(product,/observe\(main,\{childList:true\}\)/,'singleton repair should watch only direct main-section insertions, not the whole subtree');
assert.doesNotMatch(product,/observe\(main,\{childList:true,subtree:true\}\)/,'singleton repair must not create a broad DOM observer');

console.log('PASS: Ask Synap, Follow-ups and People are enforced as singleton product surfaces.');
