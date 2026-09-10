/* Browser-only UI smoke checks. Requires Playwright; no BLE/cloud credentials.
 * Run: node tools/ui-smoke.cjs
 * Optional: SYNAP_CHROMIUM_PATH and SYNAP_UI_OUTPUT for local QA environments.
 * The server binds only to localhost; external browser requests are blocked.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.SYNAP_UI_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'synap-ui-'));
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png' };

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(bytes);
  });
});

async function run() {
  fs.mkdirSync(output, { recursive:true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:true,
    ...(process.env.SYNAP_CHROMIUM_PATH ? { executablePath:process.env.SYNAP_CHROMIUM_PATH, args:['--no-sandbox','--no-zygote','--disable-dev-shm-usage'] } : {}) });
  try {
    for (const mode of ['light','dark']) for (const width of [320,390,768,1440]) {
      const context = await browser.newContext({ viewport:{width,height:900}, reducedMotion:'reduce' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(theme => localStorage.setItem('synap-appearance', theme), mode);
      const page = await context.newPage();
      const errors=[]; page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.SynapDashboardUI && document.querySelectorAll('.brain-tabs a').length === 5);
      await page.waitForTimeout(800);
      assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').getAttribute('href'),'#today','initial view');
      assert.equal(await page.locator('html').getAttribute('data-theme'), mode);
      assert.match(await page.locator('.brand-logo').getAttribute('src'),/^synap-logo\.svg\?v=1\.0\.0-brand2$/);
      assert.equal(await page.locator('.brand-logo').evaluate(node=>getComputedStyle(node).filter),'none','preserve two-tone branding');
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.app-shell,.topbar,main>section,.brain-tabs')]
        .filter(node => { const r=node.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); })
        .map(node => node.id || node.className));
      assert.deepEqual(overflow, [], `${mode}/${width}: horizontal overflow`);
      assert.equal(await page.locator('link[href^="compact.css"]').count(),1,'single presentation stylesheet');
      assert(await page.locator('#startButton').isVisible());
      assert(await page.locator('#startButton').isDisabled());
      assert(!(await page.locator('#stopButton').isVisible()));
      if (width===390 || width===1440) {
        await page.screenshot({path:path.join(output,`${mode}-${width}.png`),fullPage:true});
        await page.screenshot({path:path.join(output,`home-${mode}-${width}.png`)});
        await page.locator('.brand-logo').screenshot({path:path.join(output,`brand-${mode}-${width}.png`)});
      }
      for (const href of ['#capture','#insights','#ask','#library','#today']) {
        await page.locator(`.brain-tabs a[href="${href}"]`).click();
        assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').count(),1);
        assert.equal(await page.locator('.brain-tabs a[aria-current="page"]').getAttribute('href'),href);
        assert(await page.locator(href).isVisible());
      }
      await page.locator('#settingsButton').click();
      assert(await page.locator('#settingsDialog').isVisible());
      assert.equal(await page.locator('.settings-brand-logo').getAttribute('src'),await page.locator('.brand-logo').getAttribute('src'));
      assert.equal(await page.locator('.settings-brand-logo').evaluate(node=>getComputedStyle(node).filter),'none');
      assert(await page.locator('#otaStatus').isVisible());
      assert(!(await page.locator('#otaLatest').isVisible()),'no phantom firmware update');
      assert(!(await page.locator('#otaCancel').isVisible()),'no phantom OTA cancel');
      await page.locator('[data-theme-choice="dark"]').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
      await page.locator('[data-theme-choice="light"]').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
      if(width===390) await page.screenshot({path:path.join(output,'settings-390.png')});
      await page.locator('#closeSettingsButton').click();
      assert(!(await page.locator('#settingsDialog').isVisible()));
      if (mode==='light' && (width===390 || width===1440)) {
        // Isolated localhost fixture; these sample records never touch user data.
        await page.evaluate(async () => {
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('dk-pendant-recordings');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const pcm=new Int16Array(16000);
          const header=new DataView(new ArrayBuffer(44));
          const ascii=(offset,value)=>[...value].forEach((c,i)=>header.setUint8(offset+i,c.charCodeAt(0)));
          ascii(0,'RIFF');header.setUint32(4,36+pcm.byteLength,true);ascii(8,'WAVE');ascii(12,'fmt ');
          header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,1,true);
          header.setUint32(24,16000,true);header.setUint32(28,32000,true);header.setUint16(32,2,true);header.setUint16(34,16,true);
          ascii(36,'data');header.setUint32(40,pcm.byteLength,true);
          const createdAt=new Date().toISOString();
          const conversation={title:'Prototype planning',summary:'We agreed to test the new prototype before choosing the final enclosure.',start_ms:0,end_ms:1000,participants:['You','Alex'],people:[{name:'Alex',role:'Collaborator'}],topics:['Prototype'],decisions:['Test the prototype before selecting the enclosure.'],action_items:[{task:'Prepare the prototype test checklist.',owner:'self',status:'open'}],follow_ups:[]};
          const record={id:'ui-sample',name:'Sample · Prototype planning',createdAt,durationMs:1000,sampleRate:16000,sizeBytes:32044,
            blob:new Blob([header.buffer,pcm],{type:'audio/wav'}),notes:'Sample data for UI testing only.',
            transcript:'Alex: Let’s test the prototype before deciding on an enclosure. You: I’ll prepare the test checklist.',
            summary:conversation.summary,meeting:{executive_summary:conversation.summary,conversations:[conversation],people:conversation.people,decisions:conversation.decisions,action_items:conversation.action_items,topics:['Prototype']}};
          await new Promise((resolve,reject)=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put(record);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
        });
        await page.reload();
        await page.waitForFunction(()=>document.querySelectorAll('.recording-card').length===1);
        await page.waitForTimeout(900);
        assert.equal(await page.locator('#glanceRecordings').innerText(),'1');
        await page.locator('.brain-tabs a[href="#insights"]').click();
        await page.locator('.memory-search input').fill('prototype');
        await page.waitForFunction(()=>document.querySelectorAll('.memory-result').length>0);
        await page.locator('.memory-search input').fill('');
        await page.locator('.brain-tabs a[href="#library"]').click();
        await page.locator('.recording-card>summary').click();
        await page.waitForFunction(()=>document.querySelector('.recording-action-export')?.disabled===false);
        assert(await page.locator('.recording-action-export').isVisible());
        assert(await page.locator('.recording-action-delete').isVisible());
        assert.equal(await page.locator('.recording-card audio').evaluate(audio=>audio.readyState>=1),true,'playable local WAV');
        const download=page.waitForEvent('download');await page.locator('.recording-action-export').click();
        assert((await download).suggestedFilename().endsWith('.wav'));
        await page.locator('.brain-tabs a[href="#ask"]').click();
        await page.locator('#askInput').fill('What did I decide today?');
        await page.locator('#askForm button[type="submit"]').click();
        await page.waitForFunction(()=>document.getElementById('askAnswer').textContent.toLowerCase().includes('prototype'));
        await page.locator('.brain-tabs a[href="#today"]').click();
        await page.screenshot({path:path.join(output,`sample-${width}.png`),fullPage:true});
        console.log(`PASS populated/${width}: local storage, search, playback, WAV export, grounded local Ask`);
      }
      // Presentation-only state simulation. No recording/BLE session is started.
      await page.evaluate(() => { document.body.dataset.state='recording'; document.getElementById('stopButton').disabled=false; });
      assert(await page.locator('#stopButton').isVisible());
      assert(!(await page.locator('#startButton').isVisible()));
      await page.evaluate(() => { document.body.dataset.state='disconnected'; });
      assert.deepEqual(errors,[],`${mode}/${width}: runtime errors`);
      console.log(`PASS ${mode}/${width}: layout, navigation, settings, hidden OTA and recorder states`);
      await context.close();
    }
    console.log(`Screenshots: ${output}`);
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode=1; }).finally(() => server.close());
