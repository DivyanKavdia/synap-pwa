'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),css=fs.readFileSync(path.join(root,'compact.css'),'utf8');
const vars=block=>Object.fromEntries([...block.matchAll(/--([\w-]+):([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
function theme(palette,mode){let out={};for(const match of css.matchAll(/(:root[^{}]*)\{([^{}]*)\}/g)){
  const selector=match[1].trim();if(selector.includes(' '))continue;
  const p=selector.match(/data-palette="([^"]+)"/),m=selector.match(/data-theme="([^"]+)"/);
  if((!p||p[1]===palette)&&(!m||m[1]===mode))Object.assign(out,vars(match[2]));
}return out;}
function color(t,name){const v=t[name];assert(v,'missing '+name);return v.startsWith('var(')?color(t,v.slice(6,-1)):v}
function lum(hex){assert.match(hex,/^#[0-9a-f]{6}$/i);const c=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722}
const pairs=[['ink','surface'],['ink','bg'],['muted','surface'],['muted','surface-2'],['accent','accent-soft'],['on-action','action'],['on-action','action-hover'],['hero-ink','hero'],['hero-muted','hero'],['hero-ink','hero-end'],['hero-muted','hero-end'],['console-text','console']];
test('all palettes preserve readable text in light and dark, including both hero gradient stops',()=>{
  for(const palette of['olive','blue','pink','lavender'])for(const mode of['light','dark']){
    const t=theme(palette,mode);
    for(const[fg,bg,min]of[...pairs,['control-border','surface',3],['switch-off','surface',3]]){
      const a=lum(color(t,fg)),b=lum(color(t,bg)),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      assert(ratio>=(min||4.5),`${palette}/${mode} ${fg}/${bg}: ${ratio.toFixed(2)}`);
    }
  }
});
test('each palette wordmark is an explicit light/dark PNG and available offline',()=>{
  const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
  for(const palette of['blue','pink','lavender'])for(const mode of['light','dark']){
    const file=`synap-logo-${palette}-${mode}.png`,bytes=fs.readFileSync(path.join(root,file));
    assert.equal(bytes.readUInt32BE(16),800);assert.equal(bytes.readUInt32BE(20),216);assert(sw.includes(`'./${file}'`));
  }
  assert(sw.includes("'./compact-layout.js'"));
});
