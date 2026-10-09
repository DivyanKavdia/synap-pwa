'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),
  fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
test('shell update revision is identical across service worker, app and enhancement UX',()=>{
  const sw=read('sw.js'),app=read('app.js'),enhancements=read('enhancements.js'),html=read('index.html');
  const cache=sw.match(/const CACHE_REVISION='([^']+)'/);
  const recovery=sw.match(/const UI_RECOVERY_REVISION='([^']+)'/);
  const application=app.match(/const APP_SHELL_REVISION = "([^"]+)"/);
  const enhancement=enhancements.match(/const SHELL_REVISION='([^']+)'/);
  assert(cache&&recovery&&application&&enhancement,'revision owners must remain explicit');
  assert.equal(recovery[1],cache[1]);
  assert.equal(application[1],cache[1]);
  assert.equal(enhancement[1],cache[1]);
  assert(html.includes('enhancements.js?v='+cache[1]),'enhancements cache-bust must match the release');
});
test('C3 calibrated battery UI is explicitly cache-busted independently of firmware',()=>{
  const battery=read('battery-v2-ui.js'),html=read('index.html');
  assert.match(battery,/synap-odyssey-c3-full-adc-v1:/);
  assert.match(html,/battery-v2-ui\.js\?v=1\.0\.0-battery6/);
});
