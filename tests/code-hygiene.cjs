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
