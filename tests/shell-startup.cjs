const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const runtime=fs.readFileSync(path.join(root,'runtime-ui.js'),'utf8');
const theme=fs.readFileSync(path.join(root,'theme.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

test('startup preserves explicit section links for the navigation owner',()=>{
  assert.match(theme,/scrollRestoration='manual'/);
  assert.doesNotMatch(theme,/location\.hash|history\.replaceState/);
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

console.log('PASS: startup preserves section links and tab navigation is controlled');
