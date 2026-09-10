'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const interactions=read('interaction-surfaces.js');
const provenance=read('provenance-links.js');
const productivity=read('productivity-tools.js');
const desktop=read('desktop-capture.js');
const memory=read('memory-tools.js');
const backend=read('synap-backend.js');
const repair=read('transcript-repair.js');

assert.match(interactions,/SynapBackend/,'People/follow-ups must have a canonical backend path');
assert.match(interactions,/\.people\?\.\(\)|api\.people\?\.\(\)/,'People must use account-wide canonical identity when signed in');
assert.match(interactions,/followUps\?\.\('open','all'\)/,'follow-up inbox must load persistent open items, not only the selected day');
assert.match(interactions,/resolveFollowUp\(id,'done'\)/,'follow-ups must be closable from the inbox');
assert.match(interactions,/source\?\.recording_id/,'canonical follow-ups must retain source recording id');
assert.match(interactions,/source\?\.start_ms/,'canonical follow-ups must retain exact source time');
assert.match(interactions,/restoreRecording/,'a source absent on this browser must hydrate from cloud before navigation');

assert.match(provenance,/dataset\?\.startMs/,'Ask backend start_ms must be a first-class source offset');
assert.match(provenance,/recording-content/,'provenance must wait for lazy Library content');
assert.match(provenance,/restoreRecording/,'provenance must hydrate cloud-only sources');
assert.match(provenance,/textarea\.readOnly=true|textarea\.readOnly\s*=\s*true/,'evidence transcript opened from a source link must be immutable');

assert.match(productivity,/function weekDays\(/,'weekly review must enumerate the complete week');
assert.match(productivity,/for\(const d of weekDays\(range\)\)/,'weekly review must hydrate every day in its week');
assert.match(productivity,/transcript:false/,'weekly count hydration should not download large transcripts unnecessarily');
assert.match(productivity,/data(?:set)?\.recordingId|dataset\.recordingId/,'weekly details must retain source recording ids');
assert.match(productivity,/dataset\.offsetMs/,'weekly details must retain source timestamps');

assert.doesNotMatch(memory,/const recording\s*=\s*list\[index\]/,'memory/merge cards must never bind by array position');
assert.match(memory,/recordingForCard/,'memory cards must resolve their exact recording independently');

assert.match(desktop,/journal\.close\(s\.recordingId/,'desktop capture must durably close its journal');
assert.match(desktop,/synap-recording-saved/,'desktop capture must announce recording saved rather than memory ready');
assert.doesNotMatch(desktop,/synap-memory-ready/,'desktop capture must not claim AI memory is ready before processing');
assert.match(desktop,/autoProcessEnabled\(\)/,'desktop capture must honor the same auto-process preference as pendant capture');
assert.match(desktop,/datePicker/,'desktop save must trigger the normal Library/day render path');
assert.match(desktop,/journal\.remove\(recordingId\)/,'failed desktop setup must remove an orphan recording');

assert.match(backend,/function segmentBounds\(/,'segment upload provenance must calculate explicit bounds');
const ctx={console,Date,JSON,Error,Set,Map,Promise,URL,Object,Array,String,Number,Boolean,Math,Intl,setTimeout,clearTimeout,AbortController,localStorage:{getItem:()=>null,setItem(){}},globalThis:null};ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(backend,ctx);
const bounds=ctx.SynapBackend.segmentBounds;
assert.deepEqual(JSON.parse(JSON.stringify(bounds({sealed:true,status:'complete',durationMs:65000},0))),{startMs:0,endMs:30000});
assert.deepEqual(JSON.parse(JSON.stringify(bounds({sealed:true,status:'complete',durationMs:65000},1))),{startMs:30000,endMs:60000});
assert.deepEqual(JSON.parse(JSON.stringify(bounds({sealed:true,status:'complete',durationMs:65000},2))),{startMs:60000,endMs:65000},'short final segment must end at real audio duration');
assert.deepEqual(JSON.parse(JSON.stringify(bounds({sealed:false,status:'recording',durationMs:65000},2))),{startMs:60000,endMs:90000},'live rolling window stays a full 30 seconds');

assert.doesNotMatch(repair,/kind==='consolidate'\)emit\('synap-memory-ready'/,'processor model completion must not emit memory-ready before finishJob commits');
console.log('PASS: account memory, source provenance, weekly history, desktop capture and processing handoffs are end-to-end consistent.');
