'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('devices/chakshu/media.js','utf8');
const code=source.slice(source.indexOf('  let recorderHealth ='),source.indexOf('  function decodeWifi('));
function harness(overrides={}) {
  const calls=[], connection={deviceId:'c3'};
  const health={version:1,stage:70,bytes:401364,faultLed:4,micRestarts:0,
    sdState:2,sdLiveProbe:70,readQuarantine:0,writeQuarantine:0,recording:0,stopPending:0,...overrides};
  const ctx={TextDecoder, current:connection, moduleInfo:()=>({id:2}),notify:()=>{},
    forgetSDProbe:()=>calls.push('forget'),
    capabilities:{hasMedia:()=>true,isChakshu:()=>false},
    operation:async fn=>fn(),
    root:{SynapAppControls:{recordingState:()=>({active:false})},
      SynapPowerLifecycle:{wakeForActivity:async()=>calls.push('wake')},
      SynapModules:{refresh:async()=>calls.push('refresh')}},
  };
  ctx.connected=()=>ctx.current;
  ctx.camera=()=>({request:async op=>{calls.push(op);return {bytes:new TextEncoder().encode(JSON.stringify(health))};}});
  vm.createContext(ctx);vm.runInContext(code,ctx);
  return {ctx,calls,health};
}
test('quarantined reads and writes permit only RAM health, never recovery or wake',async()=>{
  for(const flag of ['readQuarantine','writeQuarantine']) {
    const {ctx,calls}=harness({[flag]:1});
    await assert.rejects(ctx.refreshSD(),/power-cycle required/);
    assert.deepEqual(calls,[34]);
    assert.equal(ctx.currentRecorderHealth()[flag],1);
  }
});
test('historical failure alone does not block healthy current controller recovery',async()=>{
  const {ctx,calls}=harness();
  await ctx.refreshSD();
  assert.deepEqual(calls,[34,'forget','wake',14,'refresh']);
});
test('active offline finalization and malformed health fail closed',async()=>{
  for(const overrides of [{recording:1},{stopPending:1},{writeQuarantine:2},{stage:-1},{version:2}]) {
    const {ctx,calls}=harness(overrides);
    await assert.rejects(ctx.refreshSD());assert.deepEqual(calls,[34]);
  }
});
test('health does not leak across reconnects and late replies cannot authorize recovery',async()=>{
  const {ctx,calls,health}=harness({writeQuarantine:1});
  await ctx.readRecorderHealth();
  ctx.current={deviceId:'c3'};
  assert.equal(ctx.currentRecorderHealth(),null);
  ctx.camera=()=>({request:async()=>{ctx.current={deviceId:'other'};return {
    bytes:new TextEncoder().encode(JSON.stringify(health))};}});
  await assert.rejects(ctx.refreshSD(),/connection changed/);assert.deepEqual(calls,[34]);
});
