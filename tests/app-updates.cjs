'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
test('a newer shell offers an update even when the Bluetooth protocol revision is unchanged',async()=>{
  const handlers={},notice={hidden:true,textContent:''};
  const c={APP_REVISION:'1.0.0-audio6',APP_SHELL_REVISION:'loaded-shell',Date,
    document:{getElementById:()=>notice,addEventListener(){}},log(){},friendlyError:String,
    navigator:{serviceWorker:{addEventListener:(name,fn)=>{handlers[name]=fn;},
      register:async()=>({update:async()=>{},scope:'https://synap.test/'})}}};
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('  async function registerServiceWorker()'),source.indexOf('  function setupInstallPrompt()')),c);
  await c.registerServiceWorker();
  const send=shellRevision=>handlers.message({data:{type:'APP_VERSION',revision:'1.0.0-audio6',shellRevision}});
  send('loaded-shell');assert.equal(notice.hidden,true);
  send('new-shell');assert.equal(notice.hidden,false);assert.match(notice.textContent,/reload/);
  send('loaded-shell');assert.equal(notice.hidden,true);
  handlers.message({data:{type:'APP_VERSION',revision:'new-protocol',shellRevision:'loaded-shell'}});
  assert.equal(notice.hidden,false);
});

// A stale app constant makes a freshly loaded shell ask for another reload.
{
  const fs = require('node:fs');
  const app = fs.readFileSync('app.js', 'utf8');
  const worker = fs.readFileSync('sw.js', 'utf8');
  const revision = worker.match(/const CACHE_REVISION='([^']+)'/)[1];
  assert.equal(app.match(/const APP_SHELL_REVISION = "([^"]+)"/)[1], revision);
}
