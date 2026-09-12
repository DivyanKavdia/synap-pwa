const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.events={};this.attrs={};this.open=false;this.hidden=false;this.textContent='';}
  append(...nodes){for(const node of nodes){if(node.parent)node.remove();node.parent=this;this.children.push(node);}} appendChild(node){this.append(node);return node;}
  insertBefore(node,before){if(node.parent)node.remove();node.parent=this;this.children.splice(this.children.indexOf(before),0,node);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  setAttribute(key,value){this.attrs[key]=value;} addEventListener(type,handler){this.events[type]=handler;}
  querySelectorAll(tag){return this.children.flatMap(child=>[...((tag.startsWith('.')?(child.className||'').split(' ').includes(tag.slice(1)):child.tag===tag)?[child]:[]),...child.querySelectorAll(tag)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  pause(){this.paused=true;}
}
const fixture=i=>({id:String(i),name:'Moment '+i,createdAt:'2026-09-02T09:00:00Z',durationMs:60000,sizeBytes:100,journal:true,notes:'My note',transcript:'Transcript text',summary:'Summary text'});
const ui={recordingsList:new Element('div'),libraryPagination:new Element('div'),libraryCountLabel:new Element('p'),showMoreRecordingsButton:new Element('button'),showLessRecordingsButton:new Element('button')};
const searchStatus=new Element('p'),searchClear=new Element('button');
const c={ui,document:{getElementById:id=>id==='librarySearchStatus'?searchStatus:id==='clearLibrarySearch'?searchClear:null,createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)},libraryQuery:'',libraryVisibleCount:5,libraryRecordings:[],LIBRARY_PAGE_SIZE:5,
  formatDuration:()=> '01:00',formatDate:()=> '2 Sep',formatBytes:()=> '100 B',DEFAULT_SAMPLE_RATE:16000,renderedObjectUrls:[],bindDebouncedSave(){},
  SynapExperienceRecovery:{createTranscriptNotice(){const node=new Element('div');node.className='synap-transcript-notice';return node;},updateTranscriptNotice(){}}};
vm.createContext(c);
vm.runInContext(source.slice(source.indexOf('  function renderLibraryPage()'),source.indexOf('  function bindDebouncedSave(')),c);
for(const length of [0,3,5,8]){
  ui.recordingsList.children=[];c.libraryRecordings=Array.from({length},(_,i)=>fixture(i));c.libraryVisibleCount=5;c.renderLibraryPage();
  assert.equal(ui.recordingsList.children.length,Math.min(5,length));assert.equal(ui.libraryPagination.hidden,length<=5);
  assert.equal(ui.libraryCountLabel.textContent,Math.min(5,length)+' of '+length);
}
c.libraryVisibleCount=10;c.renderLibraryPage();assert.equal(ui.recordingsList.children.length,8);assert.equal(ui.showMoreRecordingsButton.hidden,true);assert.equal(ui.showLessRecordingsButton.hidden,false);
const last=ui.recordingsList.children[7];assert.equal(last.children.length,1,'content stays lazy');last.open=true;last.events.toggle();
assert.equal(last.children.length,2);const content=last.children[1];
assert.equal(content.children[0].tag,'audio');assert.equal(content.children[1].className,'recording-actions');
const disclosures=content.children.filter(node=>node.tag==='details');assert.equal(disclosures.length,4);
assert.deepEqual(disclosures.map(node=>node.children[0].textContent),['Notes','Transcript','Summary','Edit name & details']);
assert(disclosures.every(node=>!node.open),'extra text is initially collapsed');
assert.equal(content.querySelectorAll('textarea')[0].value,'My note');assert.equal(content.querySelectorAll('textarea')[1].value,'Transcript text');
assert.equal(content.querySelectorAll('input')[0].attrs['aria-label'],'Recording name');
assert.equal(content.children[1].children[2].textContent,'Process recording');
last.open=false;last.events.toggle();assert.equal(content.children[0].paused,true);
last.open=true;last.events.toggle();assert.equal(last.children.length,2,'reopening does not duplicate audio');
c.libraryVisibleCount=5;c.renderLibraryPage();assert.equal(last.hidden,true);assert.equal(last.open,false);
// Delayed source refreshes must not replace expanded details or native players.
c.libraryVisibleCount=10;c.renderLibraryPage();last.open=true;last.events.toggle();
const player=last.querySelector('audio'),notes=last.querySelector('.recording-notes');
notes.value='A note still being edited';c.document.activeElement=notes;
c.libraryRecordings=c.libraryRecordings.map(record=>({...record,summary:'Updated grounded summary',transcript:'Updated transcript',processingStage:'ready'}));
c.renderLibraryPage();
assert.equal(ui.recordingsList.children[7],last);assert(last.open);
assert.equal(last.querySelector('audio'),player,'native player survives hydration');
assert.equal(notes.value,'A note still being edited','background refresh does not clobber edits');
assert.equal(last.querySelector('.recording-summary').textContent,'Updated grounded summary');
assert.equal(last.querySelector('.recording-transcript').value,'Updated transcript');
c.libraryRecordings=c.libraryRecordings.filter(record=>record.id!=='7');c.renderLibraryPage();
assert(!ui.recordingsList.children.includes(last),'removed records disappear from the list');assert(player.paused);
assert.equal(last.children[0].children[0].children[0].attrs['aria-hidden'],'true');
assert.match(c.recordingRowMeta(fixture(1)),/2026/,'all-date cards identify the source date');
assert(c.recordingMatchesQuery({name:'Résumé planning',notes:'Bring sketches'},'RÉSUMÉ sketches'),'case-insensitive terms can match name and notes');
assert(c.recordingMatchesQuery({meeting:{conversations:[{title:'Prototype',summary:'Review the enclosure',people:[{name:'Alex'}],topics:['Design']}] }},'Alex design enclosure'),'search includes structured conversation context');
assert(!c.recordingMatchesQuery(fixture(1),'missing phrase'));
ui.recordingsList.children=[];
c.libraryRecordings=Array.from({length:12},(_,i)=>({...fixture(i),summary:i<7?'Enclosure discussion':'Audio notes'}));
c.libraryVisibleCount=5;c.libraryQuery='enclosure';c.renderLibraryPage();
assert.equal(ui.libraryCountLabel.textContent,'5 of 7');
assert.equal(searchStatus.textContent,'7 matching recordings');
c.libraryVisibleCount=10;c.renderLibraryPage();
assert.equal(ui.libraryCountLabel.textContent,'7 of 7');
c.libraryQuery='unmatched';c.renderLibraryPage();
assert(ui.recordingsList.children.every(card=>card.hidden));
assert.equal(ui.libraryPagination.hidden,true);
assert.match(searchStatus.textContent,/No matching recordings/);
c.libraryQuery='';c.renderLibraryPage();
assert.equal(searchStatus.hidden,true);
assert.equal(searchClear.hidden,true);
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
assert(!html.includes('YOUR LIBRARY'));assert(!html.includes('Saved moments'));
assert(html.includes('aria-labelledby="libraryTitle"'));
console.log('PASS: compact Library pagination, lazy content, disclosures, preserved edits and pause on collapse');
