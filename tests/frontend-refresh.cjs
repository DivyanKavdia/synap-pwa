'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('refresh has one deterministic final stylesheet before first-paint theme setup', () => {
  const html=read('index.html');
  assert.equal((html.match(/href="compact\.css[^\"]*"/g)||[]).length,1);
  assert(html.indexOf('brain.css') < html.indexOf('compact.css'));
  assert(html.indexOf('compact.css') < html.indexOf('src="theme.js'));
  assert.match(html,/<body[^>]*class="synap-refresh"/);
});

test('capture stays before memory feed in the DOM and documents the agreed gestures', () => {
  const html=read('index.html');
  assert(html.indexOf('<section id="today"') < html.indexOf('<section id="capture"'));
  assert(html.indexOf('<section id="capture"') < html.indexOf('<section id="insights"'));
  assert.match(html,/<strong>Double tap<\/strong>Record on \/ off/);
  assert.match(html,/<strong>Triple tap<\/strong>Sleep \/ wake/);
  assert.match(html,/Keep this app open while listening/);
});

test('desktop navigation accounts for side rail and keyboard focus', () => {
  const dashboard=read('dashboard-ui.js');
  assert.match(dashboard,/nav\.top>window\.innerHeight\/2\?nav\.top-12:window\.innerHeight/);
  assert.match(dashboard,/target\.focus\(\{preventScroll:true\}\)/);
  assert.match(dashboard,/if\(window\.scrollY<4\)return activeView==='capture'\?'capture':'today'/);
  assert.match(read('brain-ui.js'),/aria-label="Ask a question about your memories"/);
});

test('fresh and cached shells share the refresh generation without changing BLE compatibility', () => {
  const sw=read('sw.js');
  const revision=sw.match(/const CACHE_REVISION='([^']+)'/)[1];
  assert.equal(revision,'1.0.0-shell54-battery-percent');
  assert(read('enhancements.js').includes(`SHELL_REVISION='${revision}'`));
  assert.match(sw,/CLIENT_REVISION='1\.0\.0-audio2'/);
  assert.match(sw,/'\.\/compact\.css'/);
  assert.match(read('index.html'),/compact\.css\?v=/);
});

test('refreshed light and dark semantic palettes meet text and control contrast', () => {
  const css=read('compact.css');
  const vars=block=>Object.fromEntries([...block.matchAll(/--([\w-]+):([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
  const light=vars(css.match(/:root\{([^}]+)\}/)[1]);
  const dark={...light,...vars(css.match(/:root\[data-theme="dark"\]\{([^}]+)\}/)[1])};
  function color(theme,name){const value=theme[name];assert(value);return value.startsWith('var(')?color(theme,value.slice(6,-1)):value;}
  function luminance(hex){const c=hex.slice(1).match(/../g).slice(0,3).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
  const pairs=[['ink','surface'],['ink','bg'],['muted','surface'],['muted','surface-2'],['accent','accent-soft'],['success','success-soft'],['rose','rose-soft'],['amber','amber-soft'],['on-action','action'],['on-action','action-hover'],['on-rose','rose'],['console-text','console'],['hero-ink','hero'],['hero-muted','hero']];
  for(const [mode,theme]of Object.entries({light,dark}))for(const [fg,bg,minimum]of [...pairs,...[['control-border','surface',3],['switch-off','surface',3]]]){
    const a=luminance(color(theme,fg)),b=luminance(color(theme,bg)),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    assert(ratio>=(minimum||4.5),`${mode} ${fg}/${bg}: ${ratio.toFixed(2)}`);
  }
});

test('refresh preserves semantic hiding, reduced motion and visible controls', () => {
  const css=read('compact.css');
  assert.match(css,/body\.synap-refresh \[hidden\]\{display:none!important\}/);
  assert.match(css,/#otaCancel,#otaProgress\)\[hidden\]\{display:none!important/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/@media\(forced-colors:active\)/);
  assert.match(css,/\.synap-refresh \.recording-actions>button\{min-height:44px!important/);
});
