'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','synap-backend.js'),'utf8');

function storage(initial={}){
  const values=new Map(Object.entries(initial));
  return {
    getItem:key=>values.has(key)?values.get(key):null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:key=>values.delete(key),
    dump:key=>values.get(key)
  };
}

function load(signedIn){
  const localStorage=storage({
    'synap-ai-provider-settings':JSON.stringify({provider:'synap'})
  });
  let originalRuns=0;
  class Processor {
    constructor(){
      this.settings=()=>({endpoint:'',llmEndpoint:'',autoProcess:true});
      this.onChange=()=>{};
      this.controllers=new Map();
    }
    run(){ originalRuns+=1; return Promise.resolve(this.settings()); }
    process(){ return Promise.resolve({legacy:true}); }
  }
  const context={
    console,Date,JSON,Error,Set,Map,Promise,URL,Object,Array,String,Number,Boolean,Math,Intl,
    setTimeout,clearTimeout,AbortController,localStorage,DKFIFOProcessor:Processor,
    SynapAuth:{
      isSignedIn:()=>signedIn,
      config:()=>({backendUrl:'https://api.example.test'}),
      authedFetch:()=>{throw new Error('network not expected in run guard test');}
    }
  };
  context.globalThis=context;
  vm.createContext(context);
  vm.runInContext(source,context,{filename:'synap-backend.js'});
  return {context,localStorage,Processor,getOriginalRuns:()=>originalRuns};
}

(async()=>{
  {
    const {localStorage,Processor,getOriginalRuns}=load(true);
    const processor=new Processor();
    const before=processor.settings;
    const config=await processor.run();
    assert.equal(config.endpoint,'https://api.example.test/v1/recordings');
    assert.equal(config.llmEndpoint,'https://api.example.test/v1/recordings');
    assert.equal(getOriginalRuns(),1,'signed-in managed provider should enter the durable FIFO');
    assert.equal(processor.settings,before,'temporary managed settings must be restored after the run');
    assert.equal(localStorage.dump('dk-pendant-settings'),undefined,'managed endpoint must never be persisted as a user setting');
  }

  {
    const {localStorage,Processor,getOriginalRuns}=load(false);
    const messages=[];
    const processor=new Processor();
    processor.onChange=message=>messages.push(message);
    await processor.run();
    assert.equal(getOriginalRuns(),0,'signed-out memories must remain pending rather than entering processing');
    assert.match(messages.join('\n'),/Sign in with Google/);
    assert.equal(localStorage.dump('dk-pendant-settings'),undefined,'signed-out queue must not write managed deployment settings');
  }

  console.log('synap managed processing login boundary: ok');
})().catch(error=>{console.error(error);process.exitCode=1;});
