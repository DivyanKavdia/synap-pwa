const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const brain=fs.readFileSync(path.join(root,'brain-ui.js'),'utf8');
const product=fs.readFileSync(path.join(root,'product-ui.js'),'utf8');
const runtime=fs.readFileSync(path.join(root,'runtime-ui.js'),'utf8');

test('Sep 4 official fallback uses Digital Twin identity',()=>{
  assert.match(html,/<p class="brain-kicker">YOUR DIGITAL TWIN<\/p>/);
  assert.doesNotMatch(html,/<p class="brain-kicker">YOUR SECOND BRAIN<\/p>/);
});

test('Settings promotes the firmware-backed synap serial into the device title',()=>{
  const start=html.indexOf('<section class="settings-card pendant-settings-card">');
  const end=html.indexOf('</section>',start);
  const card=html.slice(start,end);
  assert.match(card,/<h3 id="setupDeviceId">synap-—<\/h3>/);
  assert.match(card,/<p class="pendant-meta"><span id="setupDeviceStatus">Not connected<\/span><\/p>/);
  assert.doesNotMatch(card,/>Synap Pendant</);
  assert.match(html,/el\.textContent=id\?id\.toLowerCase\(\):'synap-—'/);
  assert.match(html,/el\.dataset\.deviceId=id/);
});

test('static shell never paints a capitalized synap brand before runtime normalization',()=>{
  const start=html.indexOf('<body');
  const end=html.indexOf('<script src="device-identity.js',start);
  const visibleShell=html.slice(start,end);
  assert.doesNotMatch(visibleShell,/\bSynap\b/);
  assert.match(visibleShell,/What synap remembers/);
  assert.match(visibleShell,/let synap listen/);
  assert.match(visibleShell,/Back to synap/);
});

test('all rendered brand references normalize Synap to synap, including dynamic UI',()=>{
  assert.match(runtime,/const BRAND_PATTERN=\/\\bSynap\\b\/g/);
  assert.match(runtime,/replace\(BRAND_PATTERN,'synap'\)/);
  assert.match(runtime,/BRAND_ATTRS=\['aria-label','title','placeholder','alt'\]/);
  assert.match(runtime,/MutationObserver/);
  assert.match(runtime,/bindBrandCase\(\)/);
});

test('rich synap UI feature modules remain present without exposing developer recovery controls',()=>{
  assert.match(brain,/Ask (?:Synap|synap)/);
  assert.match(brain,/Follow-up inbox/);
  assert.match(brain,/People/);
  assert.match(brain,/Decisions/);
  assert.match(brain,/My commitments/);
  assert.doesNotMatch(product,/Advanced & recovery/);
  assert.match(product,/retrySaveButton/);
  assert.match(product,/Create memories automatically/);
});

console.log('PASS: Sep 4 Digital Twin release identity, lowercase brand rendering and rich UI fallback contract');
