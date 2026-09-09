'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const product=fs.readFileSync(path.join(__dirname,'..','product-ui.js'),'utf8');

assert.match(product,/function participantNames\(/,'conversation UI must use an explicit participant list');
assert.match(product,/Array\.isArray\(conversation\?\.participants\)/,'legacy conversation.people must not be treated as attendance');
assert.match(product,/summary\.textContent=String\(item\.c\.summary/,'conversation cards must show what was discussed');
assert.match(product,/return index===0\?'Start':zeros>1\?'—':'0:00'/,'repeated legacy zero offsets must not render as misleading 0m labels');
assert.match(product,/Math\.floor\(total\/60\).*padStart\(2,'0'\)/s,'valid offsets should render to minute:second precision');
assert.doesNotMatch(product,/item\.c\.people.*participants/i,'ambiguous legacy people must not be relabeled as participants');

console.log('PASS: conversations distinguish participants from mentioned people and avoid misleading 0m labels.');
