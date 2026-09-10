const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const runtime=fs.readFileSync(path.join(root,'runtime-ui.js'),'utf8');
const theme=fs.readFileSync(path.join(root,'theme.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const brandCss=fs.readFileSync(path.join(root,'settings-icon-fix.css'),'utf8');

test('startup reset remains isolated while explicit tab navigation is controlled',()=>{
  assert.match(theme,/scrollRestoration='manual'/);
  assert.match(theme,/location\.hash/);
  assert.match(theme,/history\.replaceState\(history\.state,'',location\.pathname\+location\.search\)/);
  assert.doesNotMatch(runtime,/enforceStartupPosition/);
  assert.doesNotMatch(runtime,/stripFragment/);
  assert.match(runtime,/event\.preventDefault\(\)/);
  assert.match(runtime,/section\.scrollIntoView/);
  assert.match(runtime,/lock\(link\)/);
  assert.match(runtime,/history\.replaceState\(history\.state,'',location\.pathname\+location\.search\)/);
});

test('Home and Settings share the self-theming wordmark',()=>{
  const home=html.match(/class="brand-logo synap-brand-image"\s+src="([^"]+)"/);
  const settings=html.match(/class="synap-brand-image settings-brand-logo"\s+src="([^"]+)"/);
  assert(home&&settings,'both wordmarks must exist');
  assert.equal(settings[1],home[1]);
  assert.match(brandCss,/:root\[data-theme="dark"\] \.pendant-settings-top \.settings-brand-logo[\s\S]*filter:none!important/);
  assert.match(runtime,/bindSettingsBrand/);
  assert.match(runtime,/home-wordmark/);
});

console.log('PASS: startup reset stays isolated and tab navigation is controlled');
