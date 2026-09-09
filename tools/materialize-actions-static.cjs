'use strict';
const fs=require('node:fs');

function replaceOnce(source,before,after,label){
  const first=source.indexOf(before);
  if(first<0)throw new Error(`Missing anchor: ${label}`);
  if(source.indexOf(before,first+before.length)>=0)throw new Error(`Ambiguous anchor: ${label}`);
  return source.slice(0,first)+after+source.slice(first+before.length);
}

let index=fs.readFileSync('index.html','utf8');
index=replaceOnce(index,
  '  <link rel="stylesheet" href="polish.css?v=1.0.0-ui5">',
  '  <link rel="stylesheet" href="polish.css?v=1.0.0-ui5">\n  <link rel="stylesheet" href="brain.css?v=1.0.0-brain2">',
  'brain stylesheet');

const briefAnchor='<p id="dayBriefText" class="day-brief-text">As conversations are processed, synap will build a concise brief of your day here.</p><div class="glance-grid">';
const actions='<p id="dayBriefText" class="day-brief-text">As conversations are processed, synap will build a concise brief of your day here.</p><div id="actionableMemory" class="actionable-memory"><div class="memory-pulse"><div><span class="pulse-label">TODAY AT A GLANCE</span><strong id="pulseLine">When synap understands a conversation, your decisions and commitments appear here.</strong></div><div class="pulse-actions"><button id="rememberThis" class="remember-pill" type="button">★ Remember this</button><button id="openAsk" class="ask-pill" type="button">Ask synap ↗</button></div></div><div class="action-grid"><section><header><span>Decisions</span><b id="decisionCount">0</b></header><div id="decisionList"><p class="brain-empty">Nothing detected yet.</p></div></section><section><header><span>My commitments</span><b id="commitmentCount">0</b></header><div id="commitmentList"><p class="brain-empty">Nothing detected yet.</p></div></section><section><header><span>Waiting on</span><b id="waitingCount">0</b></header><div id="waitingList"><p class="brain-empty">Nothing detected yet.</p></div></section></div><div id="contextChips" class="context-chips"></div><section class="conversation-lane"><header><span>Conversations</span><b id="conversationCount">0</b></header><div id="conversationList" class="conversation-list"><p class="brain-empty">Newly processed memories will be separated into real conversations here.</p></div></section></div><div class="glance-grid">';
index=replaceOnce(index,briefAnchor,actions,'static actionable memory');
fs.writeFileSync('index.html',index);

let brain=fs.readFileSync('brain-ui.js','utf8');
brain=replaceOnce(brain,
  "  function install(){\n    if($('#actionableMemory'))return;\n    const brief=$('.day-brief'),glance=brief?.querySelector('.glance-grid');\n    if(brief&&glance){",
  "  function install(){\n    const brief=$('.day-brief'),glance=brief?.querySelector('.glance-grid');\n    if(brief&&glance&&!$('#actionableMemory')){",
  'brain install static shell support');
fs.writeFileSync('brain-ui.js',brain);

const test=`'use strict';\nconst assert=require('node:assert/strict');\nconst fs=require('node:fs');\nconst index=fs.readFileSync('index.html','utf8');\nconst brain=fs.readFileSync('brain-ui.js','utf8');\nassert(index.includes('href="brain.css?v=1.0.0-brain2"'),'brain.css must be linked by the document, not merely cached');\nassert(index.includes('id="actionableMemory"'),'Actions must exist in the base Today HTML');\nfor(const id of ['decisionCount','commitmentCount','waitingCount','decisionList','commitmentList','waitingList'])assert(index.includes('id="'+id+'"'),'missing static Actions node '+id);\nassert(!/function install\\(\\)\\{\\s*if\\(\\$\\('#actionableMemory'\\)\\)return/.test(brain),'brain-ui must not abort installation when static Actions exists');\nassert(brain.includes("if(brief&&glance&&!$('#actionableMemory'))"),'brain-ui should keep dynamic Actions only as a fallback');\nconsole.log('PASS: Actions is a static visible Today surface and brain-ui enhances it without aborting.');\n`;
fs.writeFileSync('tests/actions-visible.cjs',test);
