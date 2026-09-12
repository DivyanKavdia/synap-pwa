'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {MessageChannel}=require('node:worker_threads');
const root=path.resolve(__dirname,'..');

function workerFixture(){
  const handlers={},clients=new Map(),notifications=new Map(),opened=[];
  let beforeShow=async()=>{};
  const scope='https://synap.test/app/';
  const self={Notification:{maxActions:2},location:{origin:'https://synap.test'},
    registration:{scope,getNotifications:async()=>[...notifications.values()],
      async showNotification(title,options){
        await beforeShow();
        const notification={title,...options,close(){if(notifications.get(options.tag)===this)notifications.delete(options.tag)}};
        notifications.set(options.tag,notification);
      }},
    clients:{get:async id=>clients.get(id),openWindow:async url=>opened.push(url)},
    addEventListener(name,handler){handlers[name]=handler}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),
    {self,URL,MessageChannel,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,50)),clearTimeout}, {filename:'sw.js'});
  function client(id){
    const result={id,type:'window',url:scope,focused:0,messages:[],
      async focus(){this.focused++},postMessage(data,ports){this.messages.push(data);ports[0].postMessage({ok:true});ports[0].close()}};
    clients.set(id,result);return result;
  }
  async function update(owner,state){
    let work,reply;
    handlers.message({data:{type:'SYNAP_RECORDING_NOTIFICATION',state},source:owner,
      ports:[{postMessage(value){reply=value}}],waitUntil(p){work=p}});
    await work;return reply;
  }
  async function click(notification,action=''){
    let work;handlers.notificationclick({notification,action,waitUntil(p){work=p}});await work;
  }
  const state={active:true,sessionId:'take-1',source:'pendant',phase:'recording',canStop:true,canMark:true,startedAt:Date.now()};
  return {client,clients,notifications,opened,update,click,state,self,setBeforeShow(fn){beforeShow=fn}};
}

test('worker shows supported recording actions, removes them during saving, then closes',async()=>{
  const f=workerFixture(),owner=f.client('owner');
  assert.equal((await f.update(owner,f.state)).ok,true);
  const recording=f.notifications.get('synap-recording');
  assert.equal(recording.title,'Synap is recording');
  assert.deepEqual(Array.from(recording.actions,a=>a.action),['stop','mark']);
  assert.equal(recording.data.ownerClientId,'owner');assert(recording.silent);
  await f.update(owner,{...f.state,phase:'interrupted',canMark:false});
  assert.equal(f.notifications.get('synap-recording').actions[0].title,'Save received audio');
  await f.update(owner,{...f.state,phase:'saving',canMark:false,canStop:false});
  assert.equal(f.notifications.get('synap-recording').actions.length,0);
  await f.update(owner,{active:false});assert.equal(f.notifications.size,0);
});

test('notification Stop goes to its owner only; dead owners open the app without replaying Stop',async()=>{
  const f=workerFixture(),owner=f.client('owner'),other=f.client('other');
  await f.update(owner,f.state);const notification=f.notifications.get('synap-recording');
  await f.click(notification,'stop');
  assert.equal(owner.messages.length,1);assert.equal(owner.messages[0].sessionId,'take-1');
  assert.equal(other.messages.length,0);assert.equal(owner.focused,0);
  f.clients.delete(owner.id);await f.click(notification,'stop');
  assert.equal(f.notifications.size,0);assert.deepEqual(f.opened,['https://synap.test/app/']);
  assert.equal(other.messages.length,0);
});

test('body tap and unavailable actions focus the existing page; timeout cannot claim success',async()=>{
  const f=workerFixture(),owner=f.client('owner');await f.update(owner,f.state);
  const notification=f.notifications.get('synap-recording');
  await f.click(notification);assert.equal(owner.focused,1);assert.equal(owner.messages.length,0);
  owner.postMessage=(data,ports)=>{ports[0].postMessage({ok:false});ports[0].close()};
  await f.click(notification,'mark');assert.equal(owner.focused,2);
  owner.postMessage=(data,ports)=>ports[0].close();
  await f.click(notification,'stop');assert.equal(owner.focused,3);
});

test('another tab cannot close or replace a live owner notification; stale owners are cleaned',async()=>{
  const f=workerFixture(),owner=f.client('owner'),other=f.client('other');
  await f.update(owner,f.state);await f.update(other,{active:false});
  assert.equal(f.notifications.size,1);
  assert.equal((await f.update(other,{...f.state,sessionId:'take-2'})).ok,false);
  assert.equal(f.notifications.get('synap-recording').data.sessionId,'take-1');
  f.clients.delete(owner.id);await f.update(other,{active:false});assert.equal(f.notifications.size,0);
});

test('slow notification display cannot overtake a newer Stop update; action count follows browser limit',async()=>{
  const f=workerFixture(),owner=f.client('owner');let release;
  f.setBeforeShow(()=>new Promise(resolve=>{release=resolve}));
  const recording=f.update(owner,f.state);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const stopped=f.update(owner,{active:false});release();await Promise.all([recording,stopped]);
  assert.equal(f.notifications.size,0);
  f.setBeforeShow(async()=>{});f.self.Notification.maxActions=1;
  await f.update(owner,f.state);assert.equal(f.notifications.get('synap-recording').actions.length,1);
  assert.equal(f.notifications.get('synap-recording').actions[0].action,'stop');
});

function pageFixture({permission='granted',maxActions=2,ios=false,preference='on'}={}){
  const handlers={},domHandlers={},nodes={recordingNotificationInput:{addEventListener(n,h){this[n]=h}},recordingNotificationHint:{}};
  const state={active:true,sessionId:'take-current',source:'pendant',phase:'recording',canStop:true,canMark:true};
  const calls={stop:0,mark:0,permission:0},worker={},prefs=new Map([['synap-recording-notifications',preference]]);
  const document={readyState:'loading',body:{},visibilityState:'visible',getElementById:id=>nodes[id],addEventListener(n,h){domHandlers[n]=h}};
  const context={document,console,URL,MessageChannel,setTimeout,clearTimeout,isSecureContext:true,location:{origin:'https://synap.test'},
    Notification:{permission,maxActions,requestPermission:async()=>{calls.permission++;return permission}},
    navigator:{userAgent:ios?'iPhone':'Android',serviceWorker:{controller:worker,addEventListener(n,h){handlers[n]=h}}},
    localStorage:{getItem:k=>prefs.get(k),setItem:(k,v)=>prefs.set(k,v)},MutationObserver:class{observe(){}},
    addEventListener(){},SynapAppControls:{recordingState:()=>state,stopCapture:async()=>{calls.stop++;return true}},
    SynapMoments:{mark:async()=>{calls.mark++;return {id:'moment'}}}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'recording-notifications.js'),'utf8'),context);
  domHandlers.DOMContentLoaded();
  async function action(action,sessionId='take-current',expiresAt=Date.now()+5000,source=worker){
    let reply;await handlers.message({source,origin:'https://synap.test',data:{type:'SYNAP_RECORDING_ACTION',action,sessionId,expiresAt},
      ports:[{postMessage:value=>{reply=value}}]});return reply;
  }
  return {context,nodes,state,calls,action};
}

test('page rejects stale, expired, unknown, untrusted and duplicate actions without starting a take',async()=>{
  const f=pageFixture();
  assert.equal((await f.action('stop','old-take')).ok,false);
  assert.equal((await f.action('stop','take-current',Date.now()-1)).ok,false);
  assert.equal((await f.action('start')).ok,false);
  assert.equal(await f.action('stop','take-current',Date.now()+5000,{}),undefined);
  assert.equal(f.calls.stop,0);
  let release;f.context.SynapAppControls.stopCapture=()=>{f.calls.stop++;return new Promise(resolve=>{release=resolve})};
  const first=f.action('stop');assert.equal((await f.action('stop')).ok,false);
  release(true);assert.equal((await first).ok,true);assert.equal(f.calls.stop,1);
  assert.equal((await f.action('mark')).ok,true);assert.equal(f.calls.mark,1);
  f.state.canMark=false;assert.equal((await f.action('mark')).ok,false);
});

test('permission denial and unsupported iOS never prompt on startup or break recording',async()=>{
  const denied=pageFixture({permission:'denied'});
  assert(denied.nodes.recordingNotificationInput.disabled);
  assert.match(denied.nodes.recordingNotificationHint.textContent,/blocked/);
  assert.equal((await denied.action('stop')).ok,false);assert.equal(denied.calls.permission,0);
  const ios=pageFixture({ios:true,maxActions:0});
  assert(ios.nodes.recordingNotificationInput.disabled);
  assert.match(ios.nodes.recordingNotificationHint.textContent,/native iOS app/);
  assert.equal(ios.calls.permission,0);
  const off=pageFixture({preference:'off'});
  assert.equal((await off.action('stop')).ok,false);assert.equal(off.calls.stop,0);
});
