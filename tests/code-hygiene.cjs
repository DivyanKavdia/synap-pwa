'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('top-level browser modules stay reachable from the production shell/cache graph',()=>{
  const index=read('index.html');
  const worker=read('sw.js');
  const files=fs.readdirSync(root,{withFileTypes:true})
    .filter(entry=>entry.isFile()&&/\.(?:js|css)$/.test(entry.name))
    .map(entry=>entry.name)
    .filter(name=>name!=='sw.js');
  const orphaned=files.filter(name=>!index.includes(name)&&!worker.includes('./'+name)&&!worker.includes("'"+name+"'")&&!worker.includes('"'+name+'"'));
  assert.deepEqual(orphaned,[],
    'production-root browser files need an explicit shell/cache entry; move manual code under tools or remove it');
});

test('every browser smoke script belongs to the canonical browser suite',()=>{
  const orchestrator=read('tools/browser-tests.cjs');
  const declared=new Set(
    [...orchestrator.matchAll(/\['([^']+)'(?:,|\])/g)].map(match=>match[1])
  );
  const smoke=fs.readdirSync(path.join(root,'tools'))
    .filter(name=>name.endsWith('-smoke.cjs'))
    .map(name=>name.slice(0,-'-smoke.cjs'.length));
  const orphaned=smoke.filter(name=>!declared.has(name));
  assert.deepEqual(orphaned,[],
    'standalone browser smokes require an explicit canonical-suite entry or should be removed');
});

const collectShellAssets=()=>{
  const match=read('sw.js').match(/const APP_SHELL=\[([\s\S]*?)\];/);
  assert.ok(match,'service worker must declare its offline shell');
  return [...match[1].matchAll(/['"]\.\/([^'"]*)['"]/g)].map(item=>item[1]);
};

test('device and recording browser modules remain part of the live shell',()=>{
  const index=read('index.html'),cache=new Set(collectShellAssets());
  const directories=['devices','recording'];
  const orphaned=[];
  function visit(directory){
    for(const entry of fs.readdirSync(path.join(root,directory),{withFileTypes:true})){
      const relative=path.posix.join(directory,entry.name);
      if(entry.isDirectory())visit(relative);
      else if(entry.isFile() && /\.(?:js|css)$/.test(entry.name) &&
        !index.includes(relative) && !cache.has(relative))orphaned.push(relative);
    }
  }
  for(const directory of directories)visit(directory);
  assert.deepEqual(orphaned,[],'remove unused device/recording modules or wire them into the production shell');
});

test('every offline shell asset exists and each local HTML dependency is cached',()=>{
  const cache=collectShellAssets(),cacheSet=new Set(cache);
  assert.equal(cache.length,cacheSet.size,'service worker must not cache duplicate paths');
  const missing=cache.filter(asset=>asset && !fs.existsSync(path.join(root,asset)));
  assert.deepEqual(missing,[],'service worker cache must not reference deleted files');
  const html=read('index.html');
  const localAssets=[...html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)]
    .map(match=>match[1].split('?')[0].split('#')[0])
    .filter(asset=>asset&&!/^(?:https?:|data:|\/|#)/.test(asset));
  const offlineMisses=[...new Set(localAssets)].filter(asset=>!cacheSet.has(asset));
  assert.deepEqual(offlineMisses,[],'a new HTML dependency must be cached before shipping the PWA');
  assert.match(read('audio-enhancement.js'),/audio-enhancement-worker\.js/);
  assert.match(read('audio-enhancement-worker.js'),/vendor\/audio-enhancement\/rnnoise-sync\.js/);
});
