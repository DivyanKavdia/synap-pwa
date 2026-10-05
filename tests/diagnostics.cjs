const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
assert(!html.slice(html.indexOf('<main>'),html.indexOf('</main>')).includes('id="diagnostics"'));
const settings=html.slice(html.indexOf('<dialog id="settingsDialog"'),html.indexOf('</dialog>'));
const timestampBlock=source.slice(source.indexOf('  function localIsoTimestamp('),source.indexOf('  function log('));
const timestampContext={};
vm.runInNewContext(timestampBlock,timestampContext);
const fakeDate={
  getFullYear:()=>2026,getMonth:()=>9,getDate:()=>5,
  getHours:()=>22,getMinutes:()=>9,getSeconds:()=>31,getMilliseconds:()=>693,
  getTimezoneOffset:()=>-330
};
assert.equal(timestampContext.localIsoTimestamp(fakeDate),'2026-10-05T22:09:31.693+05:30');
const logBlock=source.slice(source.indexOf('  function log('),source.indexOf('  window.addEventListener("synap-voice-diagnostic"'));
assert.match(logBlock,/localIsoTimestamp\(now\)/);
assert.doesNotMatch(logBlock,/toISOString\(\)/);
assert.match(settings,/<details id="diagnostics" class="settings-disclosure diagnostics-settings">/);
for(const id of ['copyDiagnosticsButton','clearDiagnosticsButton'])assert.match(settings,new RegExp('id="'+id+'"[^>]*type="button"'));
const block=source.slice(source.indexOf('    ui.copyDiagnosticsButton.addEventListener('),source.indexOf('    ui.clearDiagnosticsButton.addEventListener('));
async function check({clipboard=true,copy=true,open=true}={}){
  let click,host,removed=false,focused=false,selected=false;const messages=[];
  const area={style:{},focus(){},select(){selected=true;},setSelectionRange(a,b){assert.equal(a,0);assert.equal(b,3);},remove(){removed=true;}};
  const c={diagnosticLines:['a','b'],ui:{copyDiagnosticsButton:{addEventListener:(_,f)=>click=f,focus:()=>focused=true},settingsDialog:{open,appendChild:()=>host='dialog'}},
    navigator:{clipboard:{writeText:async text=>{assert.equal(text,'a\nb');if(!clipboard)throw Error('unavailable');}}},
    document:{body:{appendChild:()=>host='body'},createElement:()=>area,execCommand:()=>copy},toast:(text)=>messages.push(text)};
  vm.runInNewContext(block,c);await click();
  if(clipboard){assert.equal(host,undefined);assert.equal(messages[0],'Diagnostics copied');}
  else {assert.equal(host,open?'dialog':'body');assert(removed&&focused&&selected);assert.equal(messages[0],copy?'Diagnostics copied':'Could not copy. Select the log text to copy it.');}
}
(async()=>{await check();await check({clipboard:false});await check({clipboard:false,copy:false});await check({clipboard:false,open:false});console.log('PASS: Diagnostics in Settings wireframe, collapsed by default, modal-safe clipboard fallback and failure reporting');})().catch(error=>{console.error(error);process.exitCode=1;});
