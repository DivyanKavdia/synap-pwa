'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('the original silhouette is self-contained and recolored with theme tokens',()=>{
  const wordmark=read('synap-logo.svg'),icon=read('icon.svg');
  for(const svg of [wordmark,icon]){
    assert.match(svg,/viewBox=/);
    assert.match(svg,/maskUnits="userSpaceOnUse"/);
    const images=[...svg.matchAll(/(?:xlink:)?href="([^"]+)"/g)].map(m=>m[1]);
    assert(images.length>0);
    assert(images.every(src=>src.startsWith('data:image/png;base64,')),'image assets must not depend on external fetches');
  }
  assert.match(wordmark,/--mark-start:#21654c;--mark-end:#75ad91;--wordmark:#183c34/);
  assert.match(wordmark,/@media\(prefers-color-scheme:dark\)/);
  assert.match(wordmark,/--mark-start:#9cdbb7;--mark-end:#75ad91;--wordmark:#edf5ef/);
  assert.match(icon,/fill="#183e33"/);
  assert.match(icon,/stop-color="#9cdbb7"/);
});

test('launcher assets include correctly sized PNGs and opaque maskable backgrounds',()=>{
  const manifest=JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.background_color,'#f4f7f5');
  assert.equal(manifest.theme_color,'#f4f7f5');
  for(const size of [192,512]){
    const entry=manifest.icons.find(icon=>icon.sizes===`${size}x${size}`);
    assert(entry&&entry.purpose.includes('maskable'));
    const bytes=fs.readFileSync(path.join(root,entry.src.split('?')[0]));
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
  }
  const icon=read('icon.svg');
  assert.match(icon,/<rect width="512" height="512" fill="#183e33"\/>/);
  const [x,y,scale]=icon.match(/translate\((\d+) (\d+)\) scale\(([\d.]+)\)/).slice(1).map(Number);
  for(const px of [x,x+208*scale])for(const py of [y,y+216*scale])assert(Math.hypot(px-256,py-256)<512*.4,'monogram must remain inside the maskable safe circle');
});

test('favicon, Home, Settings and offline cache use the new identity consistently',()=>{
  const html=read('index.html'),capture=read('capture-ui.js'),runtime=read('runtime-ui.js'),sw=read('sw.js');
  assert.equal((html.match(/src="synap-logo-light\.png\?v=1\.0\.0-ui-fix1"/g)||[]).length,2);
  for(const source of [capture,runtime,read('theme.js')]){
    assert(source.includes('synap-logo-'));
    assert(source.includes('.png?v=1.0.0-ui-fix1'));
    assert(!source.includes('synap-logo.svg'),'live branding does not rely on embedded SVG media queries');
  }
  assert.match(html,/<link rel="icon" href="icon\.svg\?v=1\.0\.0-brand2" type="image\/svg\+xml">/);
  assert.match(html,/apple-touch-icon" href="icon-192\.png\?v=1\.0\.0-brand2/);
  for(const asset of ['synap-logo-light.png','synap-logo-dark.png','icon.svg','icon-192.png','icon-512.png'])assert(sw.includes(`'./${asset}'`));
  assert.match(sw,/CACHE_REVISION='1\.0\.0-shell42-day-audio'/);
  assert.match(read('settings-icon-fix.css'),/filter:none!important/);
});

test('both display wordmarks are explicit 800px PNGs with alpha',()=>{
  const assets=['light','dark'].map(mode=>fs.readFileSync(path.join(root,`synap-logo-${mode}.png`)));
  for(const bytes of assets){assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),800);assert.equal(bytes.readUInt32BE(20),216);assert.equal(bytes[25],6);}
  assert(!assets[0].equals(assets[1]),'light and dark have separately rendered colors');
});
