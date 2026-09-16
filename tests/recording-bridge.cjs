'use strict';
const {test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'..','recording-bridge.js'),'utf8');
test('hardware stream adoption is synchronous, addresses the recorder and respects the canonical sleep guard',()=>{
  const events={};let starts=0,changed;
  const body={dataset:{deviceState:'1',state:'idle'}};
  const c={document:{body,readyState:'complete',getElementById:()=>{throw Error('Hardware adoption must not click UI controls')}},SynapSleepStateGuard:{locked:false},
    SynapAppControls:{adoptHardwareStream(){starts++;body.dataset.state='recording'}},addEventListener(t,fn){events[t]=fn},
    MutationObserver:class{constructor(fn){changed=fn}observe(){}}
  };
  c.globalThis=c;vm.runInNewContext(source,c);
  body.dataset.deviceState='2';c.SynapRecordingBridge.handleStatus();changed();changed();assert.equal(starts,1);
  body.dataset.state='idle';events['synap-intentional-sleep']({detail:{active:true}});changed();assert.equal(starts,1);
  events['synap-intentional-sleep']({detail:{active:false}});assert.equal(starts,2);
  body.dataset.deviceState='0';changed();assert.equal(starts,2);
  assert.doesNotMatch(source,/localStorage|ROLLOVER_MS|readSession|patchJournal|stop\.click/);
});
