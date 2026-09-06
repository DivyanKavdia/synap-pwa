'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','runtime-compat.js'),'utf8');
const DEFAULT_BACKEND='https://synap-backend-435475937223.asia-south1.run.app';

function storage(initial={}){
  const values=new Map(Object.entries(initial));
  return {
    getItem:key=>values.has(key)?values.get(key):null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:key=>values.delete(key),
    dump:key=>values.get(key)
  };
}

function run(initial={}){
  const localStorage=storage(initial);
  const context={
    console,
    URL,
    Date,
    Math,
    JSON,
    Promise,
    localStorage,
    navigator:{userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome/140.0'},
    document:{getElementById:()=>null},
    crypto:{randomUUID:()=> 'test-owner'},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  context.globalThis=context;
  vm.runInNewContext(source,context,{filename:'runtime-compat.js'});
  return {context,localStorage};
}

{
  const {context,localStorage}=run();
  const provider=JSON.parse(localStorage.dump('synap-ai-provider-settings'));
  const settings=JSON.parse(localStorage.dump('dk-pendant-settings'));
  assert.equal(provider.provider,'synap','fresh installs must select the Synap cloud provider before app startup');
  assert.equal(settings.endpoint,DEFAULT_BACKEND+'/v1/recordings');
  assert.equal(settings.llmEndpoint,DEFAULT_BACKEND+'/v1/recordings');
  assert.equal(settings.autoProcess,true,'Synap cloud processing must default on');
  assert.equal(localStorage.dump('synap-cloud-processing-default-v1'),'1');
  assert.equal(context.SynapRuntimeCompat.synapCloudProcessingBootstrap,true);
}

{
  const {localStorage}=run({
    'synap-ai-provider-settings':JSON.stringify({provider:'custom'}),
    'dk-pendant-settings':JSON.stringify({endpoint:'https://example.test/stt',llmEndpoint:'https://example.test/llm',autoProcess:false})
  });
  const settings=JSON.parse(localStorage.dump('dk-pendant-settings'));
  assert.equal(settings.endpoint,'https://example.test/stt','custom provider settings must remain untouched');
  assert.equal(settings.llmEndpoint,'https://example.test/llm');
  assert.equal(settings.autoProcess,false);
}

{
  const {localStorage}=run({
    'synap-ai-provider-settings':JSON.stringify({provider:'synap'}),
    'synap-backend-config-v1':JSON.stringify({backendUrl:'https://backend.example.test/'}),
    'dk-pendant-settings':JSON.stringify({autoProcess:false}),
    'synap-cloud-processing-default-v1':'1'
  });
  const settings=JSON.parse(localStorage.dump('dk-pendant-settings'));
  assert.equal(settings.endpoint,'https://backend.example.test/v1/recordings','configured Synap backend must drive the queue guard URL');
  assert.equal(settings.llmEndpoint,'https://backend.example.test/v1/recordings');
  assert.equal(settings.autoProcess,false,'an explicit post-migration opt-out must remain respected');
}

{
  const {localStorage}=run({
    'synap-ai-provider-settings':JSON.stringify({provider:'synap'}),
    'synap-backend-config-v1':JSON.stringify({backendUrl:'http://unsafe.example.test'})
  });
  const settings=JSON.parse(localStorage.dump('dk-pendant-settings'));
  assert.equal(settings.endpoint,DEFAULT_BACKEND+'/v1/recordings','non-HTTPS backend config must not enter processing settings');
}

console.log('synap cloud startup processing bootstrap: ok');
