'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','sleep-state-guard.js'),'utf8');

test('intentional sleep keeps reconnect disabled until a new GATT service is ready',()=>{
  const saved=new Map([['dk-pendant-auto-reconnect','on']]);
  const listeners={};
  const body={dataset:{}};
  const checkbox={checked:true};
  const ctx={console,globalThis:null,document:{readyState:'complete',body,getElementById:id=>id==='autoReconnectInput'?checkbox:null,addEventListener(){}},
    localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,String(v)),removeItem:k=>saved.delete(k)},
    addEventListener:(t,f)=>{listeners[t]=f}};
  ctx.globalThis=ctx;
  vm.createContext(ctx);vm.runInContext(source,ctx);
  listeners['synap-event-packet']({detail:{hex:'e2 01 03 01 7b 04'}});
  assert.equal(saved.get('synap-intentional-sleep-v1'),'1');
  assert.equal(saved.get('synap-reconnect-before-sleep-v1'),'on');
  assert.equal(saved.get('dk-pendant-auto-reconnect'),'off');
  assert.equal(body.dataset.intentionalSleep,'1');

  listeners['synap-intentional-sleep']({detail:{active:false}});
  assert.equal(saved.get('dk-pendant-auto-reconnect'),'off','legacy bridge restore cannot re-enable reconnect while sleep lock is active');

  listeners['synap-gatt-service-ready']({detail:{service:{}}});
  assert.equal(saved.has('synap-intentional-sleep-v1'),false);
  assert.equal(saved.get('dk-pendant-auto-reconnect'),'on');
  assert.equal(checkbox.checked,true);
});

test('changing the reconnect preference during sleep survives the next wake',()=>{
  const saved=new Map([['synap-intentional-sleep-v1','1'],['synap-reconnect-before-sleep-v1','on'],['dk-pendant-auto-reconnect','off']]);
  const checkbox={checked:true},ctx={document:{readyState:'complete',body:{dataset:{}},getElementById:()=>checkbox},
    localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},addEventListener(){}};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const guard=ctx.SynapSleepStateGuard;
  assert.equal(guard.reconnectOnWake,true);
  guard.setReconnectPreference(false);
  assert.equal(guard.reconnectOnWake,false);
  guard.clearSleepLock();
  assert.equal(saved.get('dk-pendant-auto-reconnect'),'off');
  assert.equal(checkbox.checked,false);
});
