const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const brain=fs.readFileSync(path.join(root,'brain-ui.js'),'utf8');
const product=fs.readFileSync(path.join(root,'product-ui.js'),'utf8');
const runtime=fs.readFileSync(path.join(root,'runtime-ui.js'),'utf8');

test('compact shell presents the day without redundant identity copy',()=>{
  assert.match(html,/<h1 id="dayLensTitle">My day at a glance<\/h1>/);
  assert.doesNotMatch(html,/<p class="brain-kicker">YOUR SECOND BRAIN<\/p>/);
});

test('Settings promotes the firmware-backed synap serial into the device title',()=>{
  const start=html.indexOf('<section class="settings-card settings-device-card">');
  const end=html.indexOf('</section>',start);
  const card=html.slice(start,end);
  assert.match(card,/<h3 id="setupDeviceId">No pendant selected<\/h3>/);
  assert.match(card,/<span id="setupDeviceStatus">Not connected<\/span>/);
  assert.doesNotMatch(card,/>Synap Pendant</);
  assert.match(html,/el\.textContent=id\?id\.toLowerCase\(\):'No pendant selected'/);
  assert.match(html,/el\.dataset\.deviceId=id/);
});

test('static shell never paints a capitalized synap brand before runtime normalization',()=>{
  const start=html.indexOf('<body');
  const end=html.indexOf('<script src="device-identity.js',start);
  const visibleShell=html.slice(start,end);
  assert.doesNotMatch(visibleShell,/\bSynap\b/);
  assert.match(visibleShell,/Day summary/);
  assert.match(visibleShell,/Use the microphone above to start recording/);
  assert.match(visibleShell,/Close settings/);
});

test('runtime does not rewrite user transcripts and names for brand casing',()=>{
  assert.doesNotMatch(runtime,/BRAND_PATTERN|normalizeBrandNode|bindBrandCase/);
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

console.log('PASS: personal-memory identity, lowercase brand rendering and rich UI fallback contract');
