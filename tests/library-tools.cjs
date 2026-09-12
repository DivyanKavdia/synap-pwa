'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function load(){
  const context={console,Blob,FormData,AbortController,URL,setTimeout,clearTimeout};
  vm.createContext(context);
  vm.runInContext(read('library-tools.js'),context);
  vm.runInContext(read('audio-store.js'),context);
  vm.runInContext(read('processing-queue.js'),context);
  return context;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('queue did not reach the expected state');}

test('recording filters distinguish missing work, partial text and completed cloud metadata',()=>{
  const {state,matchesStatus}=load().SynapLibraryTools;
  for(const record of [{processingStage:'ready'}, {processingState:'done',transcript:'',summary:''}]){
    assert.equal(matchesStatus(record,'transcript'),false,'complete does not mean transcript text must be cached');
    assert.equal(matchesStatus(record,'ready'),true);
    assert.equal(state(record).canProcess,false);
  }
  assert.equal(matchesStatus({transcript:'Some words',transcriptComplete:false},'transcript'),true);
  assert.equal(matchesStatus({transcript:'Full transcript'},'transcript'),false);
  assert.equal(matchesStatus({transcript:'Full transcript'},'summary'),true);
  const failed={processingStage:'failed',processingState:'done',processingRetryable:true};
  assert.equal(matchesStatus(failed,'retry'),true,'a failed stage overrides stale done metadata');
  assert.equal(state(failed).canProcess,true);
  assert.equal(state({...failed,processingRetryable:false}).canProcess,false);
  const uploads=[{kind:'transcribe',state:'done'}];
  assert.equal(state({},uploads,'synap').transcriptDone,false,'uploaded audio is not yet a cloud transcript');
  assert.equal(state({},uploads,'custom').transcriptDone,true,'completed custom transcription can contain no speech');
  assert.equal(matchesStatus({sealed:false},'processing'),true);
  assert.equal(state({sealed:false}).canProcess,false);
  assert.equal(state({processingStage:'uploading'},[{kind:'transcribe',state:'pending'}]).canProcess,true,'a paused upload must be resumable');
  assert.equal(state({},[{kind:'transcribe',state:'running'}]).canProcess,false);
});

function queueStore(context,jobs){
  return {
    recoveryFailures:new Map(),
    all:async(_name,index,id)=>jobs.filter(job=>!index||job.recordingId===id).map(job=>({...job})),
    patchJob:async(id,fields)=>Object.assign(jobs.find(job=>job.id===id),fields),
    finishJob:async(job)=>Object.assign(jobs.find(row=>row.id===job.id),{state:'done'}),
    nextRunnable:context.DKAudioStore.prototype.nextRunnable
  };
}
test('selected queue preserves unrelated pending and failed jobs and each recording dependency',async()=>{
  const c=load(),jobs=[
    {id:1,recordingId:'other-pending',state:'pending'},
    {id:2,recordingId:'other-failed',state:'failed',attempts:5,lastError:'untouched'},
    {id:3,recordingId:'a',state:'failed',attempts:5,kind:'transcribe'},
    {id:4,recordingId:'a',state:'pending',kind:'consolidate'},
    {id:5,recordingId:'b',state:'pending',kind:'transcribe'},
    {id:6,recordingId:'b',state:'pending',kind:'consolidate'}
  ],before=JSON.stringify(jobs.slice(0,2)),calls=[],active=new Set();
  const processor=new c.DKFIFOProcessor(queueStore(c,jobs),{
    settings:()=>({endpoint:'https://fixture.test/transcribe',llmEndpoint:'https://fixture.test/summary'}),
    locks:{request:async(_name,_options,callback)=>callback({})}
  });
  processor.process=async job=>{
    assert(!active.has(job.recordingId),'dependent jobs may not overlap');active.add(job.recordingId);
    if(job.kind==='consolidate')assert.equal(jobs.find(row=>row.recordingId===job.recordingId&&row.kind==='transcribe').state,'done');
    calls.push(job.id);await tick();active.delete(job.recordingId);return {};
  };
  assert.equal(await processor.queueRecordings(['a','b','a']),2);
  await until(()=>jobs.slice(2).every(job=>job.state==='done')&&!processor.running);
  assert.deepEqual(calls.sort((a,b)=>a-b),[3,4,5,6]);
  assert.equal(JSON.stringify(jobs.slice(0,2)),before);
  // The wake-up path must retain the selection, too.
  await processor.run();assert.equal(JSON.stringify(jobs.slice(0,2)),before);
});

test('pause waits for every in-flight job before destructive work can begin',async()=>{
  const c=load(),jobs=[{id:1,recordingId:'a',state:'pending',kind:'transcribe'},{id:2,recordingId:'b',state:'pending',kind:'transcribe'}],release=new Map();
  const processor=new c.DKFIFOProcessor(queueStore(c,jobs),{
    settings:()=>({endpoint:'https://fixture.test/transcribe'}),locks:{request:async(_name,_options,callback)=>callback({})}
  });
  processor.process=job=>new Promise(resolve=>release.set(job.id,resolve));
  void processor.resume();await until(()=>release.size===2);
  let paused=false;const settled=processor.pause().then(()=>{paused=true;});
  release.get(1)({});await tick();assert.equal(paused,false,'the second job still owns storage');
  release.get(2)({});await settled;assert.equal(processor.running,false);
  assert(jobs.every(job=>job.state==='done'));
});

test('bulk actions cannot mutate recordings before startup, during capture, or during firmware updates',async()=>{
  const source=read('app.js'),start=source.indexOf('  function protectedLibraryRecording('),end=source.indexOf('  function localDateKey(',start);
  for(const blocked of [{startupReady:false},{appLockHeld:false},{currentRecordingId:'active'},{openingCapture:true},{recordingConfirmed:true},{finalizing:true},{firmwareBusy:true},{libraryMutationActive:true},{desktop:true}]){
    const c={startupReady:true,appLockHeld:true,currentRecordingId:null,openingCapture:false,recordingConfirmed:false,finalizing:false,firmwareBusy:false,libraryMutationActive:false,...blocked};
    c.SynapDesktopCapture={state:()=>({active:!!c.desktop,recordingId:c.desktop?'desktop-recording':null})};
    vm.createContext(c);vm.runInContext(source.slice(start,end),c);
    await assert.rejects(c.deleteLibraryRecordings(['active']),/Finish opening|Stop and save|Wait for/);
    await assert.rejects(c.processLibraryRecordings(['active']),/Finish opening|Stop and save|Wait for/);
  }
});
