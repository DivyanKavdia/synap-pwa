const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.NAV_SOURCE||path.join(__dirname,'../app.js'),'utf8');
const block=source.slice(source.indexOf('  function bindSectionNavigation()'),source.indexOf('  async function initialize()'));
const events={},frames=[],offsets=[500,950,1450],links=['insights','library','processing'].map(id=>({attrs:{href:'#'+id},active:false,
  getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},addEventListener(t,f){this.click=f;}}));
links.forEach(l=>l.classList={toggle(k,on){l.active=on;}});
const sections=offsets.map((_,i)=>({getBoundingClientRect:()=>({top:offsets[i]-c.window.scrollY})}));
let resize;
const c={APP_SHELL_REVISION:'test-shell',document:{querySelectorAll:()=>links,querySelector:selector=>selector==='.topbar'?{getBoundingClientRect:()=>({bottom:78})}:selector==='main'?{}:sections[links.findIndex(l=>l.attrs.href===selector)],documentElement:{scrollHeight:2400}},
  window:{scrollY:0,innerHeight:700,location:{hash:'#insights'},addEventListener(t,f){events[t]=f;},requestAnimationFrame:f=>frames.push(f)},ResizeObserver:class{constructor(f){resize=f;}observe(){}}};
vm.runInNewContext(block,c);c.bindSectionNavigation();
function flush(){while(frames.length)frames.shift()();}
function expect(i){assert.equal(links.findIndex(l=>l.active),i);assert.equal(links.filter(l=>l.attrs['aria-current']==='location').length,1);}
expect(0);
c.window.scrollY=900;events.scroll();flush();expect(1); // Stale #insights must not pin the highlight.
c.window.scrollY=1400;events.scroll();flush();expect(2);
c.window.scrollY=450;events.scroll();flush();expect(0);
links[2].click();expect(2);c.window.scrollY=1400;events.hashchange();flush();expect(2);
offsets[2]=2100;resize();flush();expect(1); // Expanded content shifts the visible section.
c.window.scrollY=1700;events.scroll();flush();expect(2); // End of page selects the final tab.
c.window.scrollY=0;events.scroll();flush();expect(0);
console.log('PASS: scroll ignores stale fragments, click/back navigation, layout changes and end-of-page selection');
