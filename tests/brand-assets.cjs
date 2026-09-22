'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const palettes=['olive','blue','pink','lavender'];
const modes=['light','dark'];

test('all four palettes ship the same S geometry in day and night variants',()=>{
  let geometry='';
  for(const palette of palettes)for(const mode of modes){
    const svg=read('synap-mark-'+palette+'-'+mode+'.svg');
    assert.match(svg,/viewBox="0 0 180 256"/);
    assert.equal((svg.match(/<stop /g)||[]).length,3);
    assert.doesNotMatch(svg,/<text\b/i);
    const d=svg.match(/<path d="([^"]+)"/)[1];
    assert(d.length>500);
    if(!geometry)geometry=d;else assert.equal(d,geometry);
  }
});

test('live branding follows palette and light-dark appearance everywhere',()=>{
  const html=read('index.html'),theme=read('theme.js'),capture=read('capture-ui.js'),sw=read('sw.js');
  assert.match(html,/synap-mark-olive-light\.svg\?v=1\.0\.0-mark1/);
  assert.match(html,/<span class="brand-name">synap<\/span>/);
  assert.match(read('brand.css'),/\.brand-name\{[^}]*font-size:26\.4px/);
  assert.match(read('compact.css'),/@media\(max-width:640px\)[\s\S]*\.brand-name\{font-size:24px\}/);
  assert(theme.includes("synap-mark-'+palette+'-'+mode+'.svg?v=1.0.0-mark1"));
  assert.match(capture,/dataset\.palette \|\| 'olive'/);
  for(const palette of palettes)for(const mode of modes)assert(sw.includes("'./synap-mark-"+palette+"-"+mode+".svg'"));
  for(const source of [html,theme,capture,sw])assert(!source.includes('synap-logo-light.png'));
  assert.match(sw,/CACHE_REVISION='1\.0\.0-shell158-brand-lockup'/);
});

test('favicon and installed launcher use the same S identity',()=>{
  const html=read('index.html'),manifest=JSON.parse(read('manifest.webmanifest')),icon=read('icon.svg');
  assert.match(html,/icon\.svg\?v=1\.0\.0-brand3/);
  assert.match(html,/icon-192\.png\?v=1\.0\.0-brand3/);
  assert.match(icon,/<rect width="512" height="512" fill="#183e33"\/>/);
  assert.equal(icon.match(/<path d="([^"]+)"/)[1],read('synap-mark-olive-dark.svg').match(/<path d="([^"]+)"/)[1]);
  for(const size of [192,512]){
    const entry=manifest.icons.find(x=>x.sizes===size+'x'+size);
    assert(entry&&entry.purpose.includes('maskable'));
    assert.match(entry.src,/brand3$/);
    const bytes=fs.readFileSync(path.join(root,entry.src.split('?')[0]));
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.equal(bytes.readUInt32BE(16),size);
    assert.equal(bytes.readUInt32BE(20),size);
  }
});

test('Memories offline storage copy is device-agnostic',()=>{
  const html=read('index.html'),preview=read('devices/chakshu/capture-preview.js');
  assert.match(html,/Offline device storage/);
  assert.match(html,/Checking offline device storage/);
  assert.match(html,/Activity indicators vary by device/);
  assert.match(html,/Check storage/);
  assert.match(html,/View offline content/);
  assert.match(preview,/Connect your device to check or sync offline content/);
  assert.match(preview,/saved to device storage/);
  assert.match(preview,/Offline storage ready/);
  assert.doesNotMatch(preview,/Connect Chakshu to check or sync its SD card/);
});
