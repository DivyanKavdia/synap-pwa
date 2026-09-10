'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'..','memory-ready-events.js'),'utf8');
const theme=fs.readFileSync(path.join(__dirname,'..','theme.js'),'utf8');
const sw=fs.readFileSync(path.join(__dirname,'..','sw.js'),'utf8');

const events=[];
class CustomEvent{constructor(type,init){this.type=type;this.detail=init&&init.detail}}
let record={id:'r1',processingStage:'uploaded',processingState:'pending'};
class Processor{
  constructor(){this.store={get:async()=>record};}
  async execute(job){if(job.kind==='consolidate')record={id:'r1',processingStage:'ready',processingState:'done',processedAt:'2026-09-10T03:00:00Z'};return 'ok';}
}
const context={console,Date,Map,Promise,Object,String,Boolean,Number,setTimeout,clearTimeout,DKFIFOProcessor:Processor,CustomEvent,dispatchEvent:e=>events.push(e),globalThis:null};
context.globalThis=context;vm.createContext(context);vm.runInContext(source,context);
assert.equal(typeof context.SynapMemoryReadyEvents.emit,'function');
const p=new context.DKFIFOProcessor();
(async()=>{
  await p.execute({kind:'consolidate',recordingId:'r1'});
  assert.equal(events.filter(e=>e.type==='synap-memory-ready').length,1,'consolidate emits once after the record is ready');
  context.SynapMemoryReadyEvents.emit(record);
  assert.equal(events.filter(e=>e.type==='synap-memory-ready').length,1,'same durable signature is not emitted twice');
  const pending={id:'r2',processingStage:'summarizing',processingState:'pending'};
  assert.equal(context.SynapMemoryReadyEvents.emit(pending),false,'pending memory never reports ready');
  assert.match(theme,/memory-ready-events\.js\?v=/,'production loader includes durable event bridge');
  assert.match(sw,/\.\/memory-ready-events\.js/,'offline shell includes durable event bridge');
  console.log('PASS: memory-ready fires once and only after durable consolidated memory.');
})().catch(error=>{console.error(error);process.exitCode=1});
