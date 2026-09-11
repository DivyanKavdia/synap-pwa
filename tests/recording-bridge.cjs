'use strict';
const {test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'..','recording-bridge.js'),'utf8');
test('hardware stream adoption uses one Start and respects the canonical sleep guard',()=>{
  const events={},timers=new Map();let id=0,starts=0,changed;
  const body={dataset:{deviceState:'1',state:'idle'}};
  const c={document:{body,readyState:'complete',getElementById:()=>({disabled:false,click(){starts++;body.dataset.state='starting'}})},SynapSleepStateGuard:{locked:false},
    setInterval(fn){timers.set(++id,fn);return id},clearInterval(id){timers.delete(id)},addEventListener(t,fn){events[t]=fn},
    MutationObserver:class{constructor(fn){changed=fn}observe(){}}
  };
  c.globalThis=c;vm.runInNewContext(source,c);
  body.dataset.deviceState='2';changed();changed();assert.equal(timers.size,1);
  [...timers.values()][0]();assert.equal(starts,1);changed();assert.equal(timers.size,0);
  body.dataset.state='idle';events['synap-intentional-sleep']({detail:{active:true}});changed();assert.equal(timers.size,0);
  events['synap-intentional-sleep']({detail:{active:false}});assert.equal(timers.size,1);
  body.dataset.deviceState='0';changed();assert.equal(timers.size,0);
  assert.doesNotMatch(source,/localStorage|ROLLOVER_MS|readSession|patchJournal|stop\.click/);
});
