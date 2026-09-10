'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'processing-pipeline-ui.js'),'utf8');
const backend=fs.readFileSync(path.join(root,'synap-backend.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');

const localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const context={console,localStorage,setTimeout,clearTimeout,setInterval:()=>0,clearInterval:()=>{},Map,Promise,Number,String,Boolean,Array,Object,Math,Date};
context.globalThis=context;
vm.createContext(context);
vm.runInContext(source,context,{filename:'processing-pipeline-ui.js'});
const derive=context.SynapProcessingPipeline.derive;

function cloud(recording,jobs,extra={}){
  return derive(recording,jobs,Object.assign({provider:'synap',signedIn:true,autoProcess:true},extra));
}

{
  const model=cloud({sealed:true},[{kind:'transcribe',state:'pending'}],{signedIn:false});
  assert.equal(model.status,'Waiting for sign-in');
  assert.deepEqual(Array.from(model.steps,item=>item.label),['Recorded','Upload','Transcription','Summary','Ready']);
  assert.equal(model.steps[0].state,'done');
}

{
  const model=cloud({sealed:true,processingStage:'uploading'},[
    {kind:'transcribe',state:'done'},{kind:'transcribe',state:'running'}
  ]);
  assert.match(model.status,/^Uploading/);
  assert.equal(model.steps[1].state,'active');
}

{
  const model=cloud({sealed:true,processingStage:'transcribing',processingProgress:.36},[
    {kind:'transcribe',state:'done'},{kind:'consolidate',state:'running'}
  ]);
  assert.equal(model.status,'Transcribing · 36%');
  assert.equal(model.steps[1].state,'done');
  assert.equal(model.steps[2].state,'active');
}

{
  const model=cloud({sealed:true,processingStage:'understanding',processingProgress:.61},[]);
  assert.equal(model.status,'Summarizing · 61%');
  assert.equal(model.steps[2].state,'done');
  assert.equal(model.steps[3].state,'active');
}

{
  const model=cloud({sealed:true,processingStage:'indexing',processingProgress:.82},[]);
  assert.equal(model.status,'Finalizing · 82%');
  assert.equal(model.steps[3].state,'done');
  assert.equal(model.steps[4].state,'active');
}

{
  const model=cloud({sealed:true,processingStage:'ready',processingState:'done',processingProgress:1},[]);
  assert.equal(model.status,'Ready');
  assert(model.steps.every(item=>item.state==='done'));
}

{
  const model=cloud({sealed:true,processingStage:'failed',processingFailedStage:'understanding',processingError:'Gemini failed'},[
    {kind:'consolidate',state:'failed',lastError:'Error: Gemini failed'}
  ]);
  assert.equal(model.status,'Needs retry');
  assert.equal(model.steps[3].state,'error');
  assert.match(model.error,/Gemini failed/);
}

{
  const model=derive({sealed:true},[
    {kind:'transcribe',state:'done'},
    {kind:'summarize',state:'running'},
    {kind:'consolidate',state:'pending'}
  ],{provider:'custom',signedIn:false,autoProcess:true});
  assert.equal(model.status,'Summarizing');
  assert.deepEqual(Array.from(model.steps,item=>item.label),['Recorded','Transcription','Summary','Ready']);
  assert.equal(model.steps[1].state,'done');
  assert.equal(model.steps[2].state,'active');
}

assert.match(html,/processing-pipeline-ui\.js\?v=1\.0\.0-pipeline1/);
assert.match(sw,/\.\/processing-pipeline-ui\.js/);
// These are semantic contracts, not whitespace/style contracts. Cleanup should
// never be blocked because an object literal gained normal formatting.
assert.match(backend,/processingStage:\s*['"]uploading['"]/);
assert.match(backend,/processingStage:\s*['"]uploaded['"]/);
assert.match(backend,/processingStage:\s*['"]ready['"]/);
assert.match(backend,/processingFailedStage/);
assert.match(source,/Memory pipeline/);
assert.match(source,/Recorded/);
assert.match(source,/Transcription/);
assert.match(source,/Summary/);
assert.match(source,/Ready/);

console.log('visible recording processing pipeline: ok');
