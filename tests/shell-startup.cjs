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

test('Settings keeps the single self-theming header wordmark',()=>{
  const home=html.match(/class="brand-logo synap-brand-image"\s+src="([^"]+)"/);
  assert(home,'header wordmark must exist');
  assert(!html.includes('settings-brand-logo'));
  assert(!runtime.includes('bindSettingsBrand'));
  assert(html.includes('settings-panel.js'));
});

console.log('PASS: startup reset stays isolated and tab navigation is controlled');
