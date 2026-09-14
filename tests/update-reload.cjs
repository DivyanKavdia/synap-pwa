const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(require.resolve('../app.js'),'utf8');
const enhancements=fs.readFileSync(require.resolve('../enhancements.js'),'utf8');

test('reload safety includes pending pendant audio and every retained desktop session',()=>{
  const source=app.slice(app.indexOf('  function canReload()'),app.indexOf('  globalThis.SynapAppControls ='));
  const c={firmwareBusy:false,recordingConfirmed:false,finalizing:false,openingCapture:null,currentRecordingId:null,unsavedAudio:false,recordingReconnectPending:false,appState:'idle',SynapDesktopCapture:{state:()=>({active:false})}};
  vm.createContext(c);vm.runInContext(source,c);assert(c.canReload());
  for(const field of ['firmwareBusy','recordingConfirmed','finalizing','openingCapture','currentRecordingId','unsavedAudio','recordingReconnectPending']){
    c[field]=true;assert.equal(c.canReload(),false,field);c[field]=false;
  }
  for(const phase of ['starting','recording','saving','save-failed']){
    c.SynapDesktopCapture.state=()=>({active:true,phase});assert.equal(c.canReload(),false,phase);
  }
  c.SynapDesktopCapture.state=()=>({active:false});assert(c.canReload());
});

test('an existing update offer tracks recording transitions and rechecks before reload',()=>{
  let button,reloads=0,safe=true,desktop=false;const observers=[],events={};
  const notice={hidden:false,textContent:'App update ready',querySelector:()=>button,appendChild:b=>{button=b}};
  const c={riskyStates:new Set(['starting','recording','stopping','saving','updating']),document:{body:{dataset:{state:'idle'}},getElementById:()=>notice,createElement:()=>({addEventListener:(_type,fn)=>{events.click=fn}})},
    MutationObserver:class{constructor(fn){observers.push(fn)}observe(){}},addEventListener:(type,fn)=>{events[type]=fn},navigator:{},location:{reload:()=>reloads++},
    SynapDesktopCapture:{state:()=>({active:desktop})},SynapAppControls:{canReload:()=>safe}};
  const source=enhancements.slice(enhancements.indexOf('function maintainUpdateNotice()'),enhancements.indexOf("document.addEventListener('click'",enhancements.indexOf('function maintainUpdateNotice()')));
  vm.createContext(c);vm.runInContext(source,c);c.maintainUpdateNotice();assert.equal(button.disabled,false);
  c.document.body.dataset.state='recording';events.click();assert.equal(reloads,0,'click before observer cannot discard audio');assert(button.disabled);
  c.document.body.dataset.state='idle';observers[1]();assert.equal(button.disabled,false,'the same offer enables after recording');
  desktop=true;events['synap-desktop-capture-changed']();assert(button.disabled);
  desktop=false;events['synap-desktop-capture-stopped']();assert.equal(button.disabled,false);
  safe=false;events.click();assert.equal(reloads,0,'unsaved audio blocks even when body state is idle');assert(button.disabled);
  safe=true;observers[1]();events.click();assert.equal(reloads,1);
  delete c.SynapAppControls;observers[1]();assert(button.disabled,'startup does not assume audio is safe to discard');
});
