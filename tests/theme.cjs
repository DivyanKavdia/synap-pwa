const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'theme.js'),'utf8');
function setup({saved=null,hour=12,blocked=false}={}){
  const storage=new Map(saved?[['synap-appearance',saved]]:[]),events={},intervals=[],appended=[];
  let currentHour=hour;
  class FakeDate{getHours(){return currentHour}}
  const buttons=['system','light','dark'].map(value=>({dataset:{themeChoice:value},attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(t,f){this.click=f;}}));
  const html={dataset:{},style:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;}},meta={setAttribute(k,v){this[k]=v;}};
  const document={
    documentElement:html,readyState:'complete',hidden:false,
    querySelector(selector){if(selector.startsWith('meta['))return meta;return null;},
    querySelectorAll(selector){return selector==='[data-theme-choice]'?buttons:[];},
    getElementById(){return null;},
    createElement(tag){return {tag,dataset:{},set rel(v){this._rel=v},set href(v){this._href=v},set src(v){this._src=v},set defer(v){this._defer=v}};},
    head:{appendChild(node){appended.push(node);}},
    addEventListener(t,f){events['document:'+t]=f;}
  };
  const c={Date:FakeDate,document,history:{scrollRestoration:'auto'},window:{addEventListener(t,f){events[t]=f;}},localStorage:{getItem:k=>{if(blocked)throw Error('blocked');return storage.get(k);},setItem:(k,v)=>{if(blocked)throw Error('blocked');storage.set(k,v);}},setInterval(f,ms){intervals.push({f,ms});return intervals.length;}};
  vm.runInNewContext(source,c);
  return {html,meta,buttons,storage,events,intervals,appended,setHour:h=>{currentHour=h},document};
}
const click=button=>button.click({preventDefault(){}});
for(const [hour,expected] of [[6,'dark'],[7,'light'],[18,'light'],[19,'dark'],[23,'dark']])assert.equal(setup({hour}).html.dataset.theme,expected,`Auto hour ${hour}`);
let t=setup({hour:18});assert.equal(t.html.dataset.theme,'light');assert.equal(t.html.attributes['data-theme'],'light');assert.equal(t.meta.content,'#f4f7f5');
click(t.buttons[2]);assert.equal(t.html.dataset.theme,'dark');assert.equal(t.storage.get('synap-appearance'),'dark');t.setHour(10);t.intervals[0].f();assert.equal(t.html.dataset.theme,'dark','explicit dark overrides Auto refresh');
click(t.buttons[0]);assert.equal(t.html.dataset.theme,'light');t.setHour(20);t.intervals[0].f();assert.equal(t.html.dataset.theme,'dark','Auto refreshes on the minute');
t.setHour(9);t.events.focus();assert.equal(t.html.dataset.theme,'light','Auto refreshes on focus');t.setHour(21);t.events.pageshow();assert.equal(t.html.dataset.theme,'dark','Auto refreshes on pageshow');
t.setHour(8);t.document.hidden=false;t.events['document:visibilitychange']();assert.equal(t.html.dataset.theme,'light','Auto refreshes on foreground');
assert.equal(t.buttons.filter(b=>b.attributes['aria-pressed']==='true').length,1);assert.equal(t.buttons[0].title,'Auto: light 7 AM–7 PM, dark 7 PM–7 AM');
assert.equal(setup({saved:'dark',hour:10}).html.dataset.theme,'dark');assert.equal(setup({saved:'invalid',hour:20}).html.dataset.theme,'dark');
t=setup({blocked:true,hour:10});click(t.buttons[2]);assert.equal(t.html.dataset.theme,'dark','blocked storage does not block switching');t.events.storage({key:'synap-appearance',newValue:'light'});assert.equal(t.html.dataset.theme,'light');
assert(t.appended.some(node=>node._href==='settings-icon-fix.css?v=1.0.0-brand2'),'settings wordmark stylesheet is loaded after DOM is ready');
assert(t.appended.some(node=>node._src==='capture-ui.js?v=1.0.0-brand2'),'fresh capture UI is loaded');
assert(t.appended.some(node=>node._src==='runtime-ui.js?v=1.0.0-brand2'),'fresh runtime UI is loaded');
const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
const values=block=>Object.fromEntries([...block.matchAll(/--([\w-]+):([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
const light=values(css.match(/:root\{([^}]+)\}/)[1]);const dark={...light,...values(css.match(/:root\[data-theme="dark"\]\{([^}]+)\}/)[1])};
function color(theme,name){const v=theme[name];assert(v,'missing '+name);return v.startsWith('var(')?color(theme,v.slice(6,-1)):v;}
function lum(hex){const c=hex.slice(1).match(/../g).slice(0,3).map(n=>parseInt(n,16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
const pairs=[['ink','surface'],['ink','bg'],['muted','surface'],['muted','surface-2'],['accent','accent-soft'],['success','success-soft'],['rose','rose-soft'],['amber','amber-soft'],['on-action','action'],['on-action','action-hover'],['on-rose','rose'],['console-text','console']];
for(const [mode,theme] of Object.entries({light,dark})){let minimum=100;for(const [fg,bg] of pairs){const a=lum(color(theme,fg)),b=lum(color(theme,bg)),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);minimum=Math.min(minimum,ratio);assert(ratio>=4.5,`${mode} ${fg}/${bg}: ${ratio.toFixed(2)}`);}for(const fg of ['control-border','switch-off']){const a=lum(color(theme,fg)),b=lum(color(theme,'surface'));assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=3,`${mode} control contrast`);}console.log(`${mode}: ${pairs.length} semantic text pairs pass; minimum ${minimum.toFixed(2)}:1`);}
console.log('PASS: local-time Auto theme, explicit overrides, refresh events, persistence and color contrast');
