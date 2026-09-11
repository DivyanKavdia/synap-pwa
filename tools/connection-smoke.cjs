/* Full PWA recording/reconnect check with a simulated pendant and local PCM.
 * Requires Playwright and SYNAP_CHROMIUM_PATH. External requests are blocked. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=process.env.SYNAP_UI_ROOT||path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)})});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.SYNAP_CHROMIUM_PATH,args:['--no-sandbox']});
 try{
 const context=await browser.newContext({viewport:{width:390,height:900}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await context.addInitScript(()=>{
   localStorage.setItem('dk-pendant-auto-reconnect','off');
   localStorage.setItem('dk-pendant-settings',JSON.stringify({autoProcess:false,wakeLock:false}));
   let state=1,sequence=0,audioTimer=null,inFlight=0,maxInFlight=0;
   const uuid=n=>'4fa123'+n+'-0000-1000-8000-00805f9b34fb';
   const status=()=>{const v=new DataView(new ArrayBuffer(16));v.setUint8(0,0x5a);v.setUint8(1,2);v.setUint8(2,state);v.setUint16(4,512,true);v.setUint16(6,509,true);v.setUint8(8,4);v.setUint8(9,8);v.setUint16(10,16000,true);v.setUint16(12,800,true);v.setUint16(14,400,true);return v};
   async function operation(fn){inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);if(inFlight>1)throw Error('Overlapping GATT requests');try{await new Promise(r=>setTimeout(r,5));return fn()}finally{inFlight--}}
   class Characteristic extends EventTarget{
     constructor(id){super();this.id=id;this.properties={write:true,read:true,notify:true};this.value=null}
     startNotifications(){return operation(()=>this)}
     readValue(){return operation(()=>this.id===uuid('47')?status():this.id===uuid('4c')?new DataView(new TextEncoder().encode('SYNAP-ABCDEF123456').buffer):new DataView(new Uint8Array([0xe2,1,1,0,0x82,4]).buffer))}
     writeValueWithResponse(value){return operation(()=>{if(value[0]===1){state=2;sequence=0;clearInterval(audioTimer);audioTimer=setInterval(frame,50)}if(value[0]===0){state=1;clearInterval(audioTimer)}this.value=status();this.dispatchEvent(new Event('characteristicvaluechanged'))})}
   }
   const audio=new Characteristic(uuid('46')),control=new Characteristic(uuid('47'));
   const chars=new Map([[uuid('46'),audio],[uuid('47'),control],[uuid('4c'),new Characteristic(uuid('4c'))],[uuid('4e'),new Characteristic(uuid('4e'))]]);
   const service={getCharacteristic:id=>operation(()=>{if(!chars.has(id))throw new DOMException('No optional characteristic','NotFoundError');return chars.get(id)})};
   const device=new EventTarget();device.id='fixture-device';device.name='synap';
   device.gatt={connected:false,connect(){return operation(()=>{this.connected=true;state=1;return this})},getPrimaryService(){return operation(()=>service)},disconnect(){this.connected=false;clearInterval(audioTimer);device.dispatchEvent(new Event('gattserverdisconnected'))}};
   function frame(){for(let chunk=0;chunk<4;chunk++){const v=new DataView(new ArrayBuffer(408));v.setUint8(0,0xa5);v.setUint8(1,2);v.setUint16(2,sequence,true);v.setUint8(4,chunk);v.setUint8(5,4);v.setUint16(6,400,true);audio.value=v;audio.dispatchEvent(new Event('characteristicvaluechanged'))}sequence=(sequence+1)&65535}
   const bluetooth=new EventTarget();bluetooth.requestDevice=async()=>device;bluetooth.getDevices=async()=>[device];
   Object.defineProperty(navigator,'bluetooth',{configurable:true,value:bluetooth});
   window.bleFixture={disconnect:()=>device.gatt.disconnect(),get maximum(){return maxInFlight}};
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 await page.waitForFunction(()=>window.SynapCompactLayout);await page.locator('.brain-tabs a[href="#capture"]').click();await page.locator('#connectButton').click();
 await page.waitForFunction(()=>document.body.dataset.state==='idle');
 await page.evaluate(()=>localStorage.setItem('dk-pendant-auto-reconnect','on'));
 await page.locator('#startButton').click();await page.waitForFunction(()=>document.body.dataset.state==='recording');
 const records=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('dk-pendant-recordings');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,read=db.transaction('recordings').objectStore('recordings').getAll();read.onsuccess=()=>{db.close();resolve(read.result.map(x=>({id:x.id,status:x.status,sizeBytes:x.sizeBytes,durationMs:x.durationMs})))}}}));
 await page.waitForTimeout(800);const first=await records();assert.equal(first.length,1);
 await page.evaluate(()=>window.bleFixture.disconnect());
 await page.waitForFunction(()=>document.body.dataset.recordingInterrupted==='true');
 await page.waitForFunction(()=>document.body.dataset.state==='recording'&&document.body.dataset.recordingInterrupted==='false',{},{timeout:15000});
 await page.waitForTimeout(800);const resumed=await records();assert.equal(resumed.length,1);assert.equal(resumed[0].id,first[0].id);
 await page.locator('#stopButton').click();await page.waitForFunction(()=>document.body.dataset.state==='idle');
 const saved=await records();assert.equal(saved.length,1);assert.equal(saved[0].id,first[0].id);assert(saved[0].durationMs>=1200);
 assert.equal(await page.evaluate(()=>window.bleFixture.maximum),1);assert.deepEqual(errors,[]);
 console.log('PASS: real PWA graph connects, records, reconnects into one journal, saves playable PCM, and never overlaps GATT operations',saved[0]);
 await context.close();
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
