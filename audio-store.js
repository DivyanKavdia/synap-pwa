/* Synap browser journal and resilient processing queue.
 * Durable recording storage stays in the PWA; pendant recovery buffers are volatile.
 */
(function (root) {
  'use strict';
  const SEGMENT_FRAMES = 600; // 30 seconds at 50 ms/frame.
  const PCM_BYTES_PER_FRAME = 1600;
  const MAX_BUFFER_PACKETS = 1600;
  const MAX_PROCESSING_CONCURRENCY = 2; // Never run two dependent jobs for one recording together.
  const ZERO_FRAME = new Uint8Array(PCM_BYTES_PER_FRAME);

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function enqueueJob(store, job) {
    const existing=store.index('dedupe').get(job.dedupe);
    existing.onsuccess=()=>{if(!existing.result)store.add(job);};
  }
  function wav(frames) {
    const bytes = frames.reduce((n, f) => n + f.byteLength, 0);
    const header = new ArrayBuffer(44), view = new DataView(header);
    const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');view.setUint32(4, bytes + 36, true);text(8, 'WAVE');text(12, 'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);
    view.setUint16(34,16,true);text(36,'data');view.setUint32(40,bytes,true);
    return new Blob([header,...frames], {type:'audio/wav'});
  }
  function assemble(packets, options={}) {
    const groups = new Map(), complete = new Map();
    for (const packet of packets) {
      if (!groups.has(packet.sequence)) groups.set(packet.sequence, []);
      groups.get(packet.sequence).push(packet);
    }
    let incomplete = 0;
    for (const sequence of [...groups.keys()].sort((a,b)=>a-b)) {
      const unique = new Map(groups.get(sequence).map(p=>[p.chunk,p]));
      const parts = [...unique.values()].sort((a,b)=>a.chunk-b.chunk);
      const total = parts[0]?.total || 0;
      if (!total || parts.length !== total || parts.some((p,i)=>p.chunk!==i || p.total!==total) ||
          parts.reduce((n,p)=>n+p.payload.byteLength,0)!==PCM_BYTES_PER_FRAME) { incomplete++;continue; }
      const frame = new Uint8Array(PCM_BYTES_PER_FRAME);let offset=0;
      for (const p of parts) {frame.set(p.payload,offset);offset+=p.payload.byteLength;}
      complete.set(sequence,frame);
    }
    const keys=[...groups.keys()].sort((a,b)=>a-b);
    const firstSequence=keys.length?keys[0]:-1,lastSequence=keys.length?keys[keys.length-1]:-1;
    const start=Number.isInteger(options.startSequence)?options.startSequence:firstSequence;
    const end=Number.isInteger(options.endSequence)?options.endSequence:lastSequence;
    const frames=[];let missing=0;
    if(options.preserveTimeline && start>=0 && end>=start) {
      for(let sequence=start;sequence<=end;sequence++) {
        const frame=complete.get(sequence);
        if(frame)frames.push(frame);
        else {frames.push(ZERO_FRAME);if(!groups.has(sequence))missing++;}
      }
    } else frames.push(...[...complete.keys()].sort((a,b)=>a-b).map(k=>complete.get(k)));
    return {frames,incomplete,missing,completeFrames:complete.size,packets:packets.length,
      frameGroups:groups.size,firstSequence,lastSequence};
  }

  class AudioStore {
    constructor(options={}) {
      this.idb = options.indexedDB || root.indexedDB;
      this.keys = options.IDBKeyRange || root.IDBKeyRange;
      this.name = options.name || 'dk-pendant-recordings';
      this.onError = options.onError || (()=>{});
      this.buffer = [];this.timer=null;this.writing=Promise.resolve();
      this.failed=null;this.dbPromise=null;this.bufferedCount=0;
      this.recoveryFailures=new Map();
    }
    async open() {
      if (this.dbPromise) return this.dbPromise;
      let failed = false;
      this.dbPromise = new Promise((resolve,reject)=>{
        const fail=error=>{failed=true;reject(error);};
        const req=this.idb.open(this.name,3);
        req.onupgradeneeded=()=>{
          const db=req.result,tx=req.transaction;
          if (!db.objectStoreNames.contains('recordings')) {
            db.createObjectStore('recordings',{keyPath:'id'}).createIndex('createdAt','createdAt');
          }
          if (!db.objectStoreNames.contains('packets')) {
            const packets=db.createObjectStore('packets',{keyPath:['recordingId','sequence','chunk']});
            packets.createIndex('recording','recordingId');packets.createIndex('segment',['recordingId','segmentIndex']);
          }
          if (!db.objectStoreNames.contains('segments')) {
            db.createObjectStore('segments',{keyPath:['recordingId','index']}).createIndex('recording','recordingId');
          }
          if (!db.objectStoreNames.contains('jobs')) {
            const jobs=db.createObjectStore('jobs',{keyPath:'id',autoIncrement:true});
            jobs.createIndex('recording','recordingId');jobs.createIndex('dedupe','dedupe',{unique:true});
            jobs.createIndex('state','state');
          } else if(tx) {
            const jobs=tx.objectStore('jobs');if(!jobs.indexNames.contains('state'))jobs.createIndex('state','state');
          }
        };
        req.onblocked=()=>fail(new Error('Storage upgrade blocked. Close other Synap tabs, then tap Retry. Your recordings are kept.'));
        req.onerror=()=>fail(req.error);
        req.onsuccess=()=>{
          const db=req.result;
          if(failed){db.close();return;}
          db.onversionchange=()=>{db.close();this.dbPromise=null;};
          resolve(db);
        };
      }).catch(error=>{this.dbPromise=null;throw error;});
      return this.dbPromise;
    }
    async atomic(names, action) {
      const db=await this.open();
      return new Promise((resolve,reject)=>{
        let tx;
        try {tx=db.transaction(names,'readwrite',{durability:'strict'});}
        catch (e) {if(e.name!=='TypeError') {reject(e);return;}tx=db.transaction(names,'readwrite');}
        let result, failure;
        tx.oncomplete=()=>resolve(result);
        // Request errors bubble before tx.error is populated. Keep the cause,
        // and wait for rollback to finish before allowing a recovery attempt.
        tx.onerror=event=>{failure ||= event.target?.error;};
        tx.onabort=()=>reject(failure || tx.error || new Error('Storage transaction aborted'));
        try {action(Object.fromEntries(names.map(n=>[n,tx.objectStore(n)])),v=>{result=v;},tx);}
        catch(e){failure=e;tx.abort();}
      });
    }
    async get(store,key) {
      const db=await this.open();return requestValue(db.transaction(store).objectStore(store).get(key));
    }
    async all(store,index,key) {
      const db=await this.open();let source=db.transaction(store).objectStore(store);
      if(index)source=source.index(index);return requestValue(source.getAll(key));
    }
    async verifyWritable() {
      const id='storage-check:'+root.crypto.randomUUID();
      // These rows are added and removed in one transaction: they are never
      // visible to readers and do not change any saved recording or job.
      await this.atomic(['recordings','packets','segments','jobs'],s=>{
        s.recordings.add({id});s.recordings.delete(id);
        s.packets.add({recordingId:id,sequence:0,chunk:0,payload:new Uint8Array(1)});
        s.packets.delete([id,0,0]);
        s.segments.add({recordingId:id,index:0,pcmBlob:new Blob([new Uint8Array(1)])});
        s.segments.delete([id,0]);
        s.jobs.add({id,recordingId:id,dedupe:id});s.jobs.delete(id);
      });
    }
    async begin(name, association = null) {
      if(this.failed) throw this.failed;
      const id=root.crypto.randomUUID();
      await this.atomic(['recordings'],s=>s.recordings.add({id,name,createdAt:new Date().toISOString(),
        journal:true,status:'recording',sampleRate:16000,
        deviceId:association?.deviceId || null,deviceAssociationId:association?.associationId || null,
        pwaInstallationId:association?.installationId || null,notes:'',transcript:'',summary:'',durationMs:0,sizeBytes:0}));
      return id;
    }
    append(recordingId,packet) {
      if(this.failed)throw this.failed;
      if(this.bufferedCount>=MAX_BUFFER_PACKETS)throw new Error('Browser storage cannot keep up with BLE; stopping to preserve buffered audio.');
      this.buffer.push({recordingId,sequence:packet.sequence,chunk:packet.chunk,total:packet.total,
        segmentIndex:Math.floor(packet.sequence/SEGMENT_FRAMES),payload:packet.payload.slice()});
      this.bufferedCount++;
      if(!this.timer)this.timer=setTimeout(()=>{this.timer=null;this.flush().catch(this.onError);},100);
    }
    async flush() {
      clearTimeout(this.timer);this.timer=null;if(this.failed)throw this.failed;
      const batch=this.buffer.splice(0);
      this.writing=this.writing.then(async()=>{
        if(!batch.length)return;
        try {
          await this.atomic(['packets','segments'],s=>{
            const segments=new Map();
            for(const p of batch){s.packets.put(p);segments.set(p.recordingId+':'+p.segmentIndex,p);}
            for(const p of segments.values()){
              const req=s.segments.get([p.recordingId,p.segmentIndex]);
              req.onsuccess=()=>{if(!req.result)s.segments.put({recordingId:p.recordingId,index:p.segmentIndex,closed:false});};
            }
          });
          this.bufferedCount-=batch.length;
        } catch(e){this.buffer.unshift(...batch);this.failed=e;throw e;}
      },e=>{this.buffer.unshift(...batch);throw e;});
      return this.writing;
    }
    async retryFlush() {this.failed=null;this.writing=Promise.resolve();return this.flush();}
    async segment(recordingId,index) {
      const meta=await this.get('segments',[recordingId,index]);
      if(meta?.legacy)return {blob:(await this.get('recordings',recordingId))?.blob,frames:[],incomplete:0,missing:0,packets:0,completeFrames:meta.frameCount||0};
      if(meta?.pcmBlob) {
        const pcm=new Uint8Array(await meta.pcmBlob.arrayBuffer());
        return {blob:wav([pcm]),frames:[],incomplete:meta.incomplete||0,missing:meta.missing||0,
          packets:meta.packets||0,completeFrames:meta.frameCount||0,timelineFrames:meta.timelineFrameCount||Math.floor(pcm.byteLength/PCM_BYTES_PER_FRAME)};
      }
      return assemble(await this.all('packets','segment',[recordingId,index]));
    }
    async enqueueLegacy(recordingId) {
      return this.atomic(['recordings','segments','jobs'],s=>{
        const req=s.recordings.get(recordingId);
        req.onsuccess=()=>{
          const r=req.result;if(!r || r.journal || r.queuedLegacy || !r.blob)return;
          s.recordings.put({...r,queuedLegacy:true});
          s.segments.put({recordingId,index:0,closed:true,legacy:true,frameCount:Math.max(1,Math.ceil((r.durationMs||50)/50))});
          for(const kind of ['transcribe','summarize','consolidate'])enqueueJob(s.jobs,{recordingId,
            segmentIndex:kind==='consolidate'?-1:0,kind,dedupe:recordingId+':legacy:'+kind,state:'pending',attempts:0,nextAt:0});
        };
      });
    }
    async compactSegment(recordingId,index,data) {
      const pcmBlob=new Blob(data.frames,{type:'application/octet-stream'});
      await this.atomic(['segments','packets','jobs'],s=>{
        const req=s.segments.get([recordingId,index]);
        req.onsuccess=()=>{
          const current=req.result||{recordingId,index};
          s.segments.put({...current,closed:true,compacted:true,pcmBlob,
            frameCount:data.completeFrames,timelineFrameCount:data.frames.length,incomplete:data.incomplete,
            missing:data.missing,packets:data.packets,firstSequence:data.firstSequence,lastSequence:data.lastSequence});
        };
        const cursor=s.packets.index('segment').openCursor(this.keys.only([recordingId,index]));
        cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}};
        if(data.completeFrames)for(const kind of ['transcribe','summarize']){
          enqueueJob(s.jobs,{recordingId,segmentIndex:index,kind,dedupe:recordingId+':'+index+':'+kind,state:'pending',attempts:0,nextAt:0});
        }
      });
    }
    async close(recordingId,reason='normal') {
      await this.flush();
      const record=await this.get('recordings',recordingId);if(!record || !record.journal)return;
      const segments=(await this.all('segments','recording',recordingId)).sort((a,b)=>a.index-b.index);
      const byIndex=new Map(segments.map(segment=>[segment.index,segment])),raw=new Map();
      let lastSequence=-1,packets=0,incomplete=0;
      for(const segment of segments){
        if(segment.pcmBlob){lastSequence=Math.max(lastSequence,segment.lastSequence??-1);packets+=segment.packets||0;incomplete+=segment.incomplete||0;continue;}
        const list=await this.all('packets','segment',[recordingId,segment.index]);raw.set(segment.index,list);
        const scan=assemble(list);lastSequence=Math.max(lastSequence,scan.lastSequence);packets+=scan.packets;incomplete+=scan.incomplete;
      }
      let complete=0,missing=0,timelineFrames=0;
      if(lastSequence>=0){
        const lastIndex=Math.floor(lastSequence/SEGMENT_FRAMES);
        for(let index=0;index<=lastIndex;index++){
          const segment=byIndex.get(index);
          if(segment?.pcmBlob){complete+=segment.frameCount||0;missing+=segment.missing||0;timelineFrames+=segment.timelineFrameCount||0;continue;}
          const start=index*SEGMENT_FRAMES,end=Math.min(lastSequence,start+SEGMENT_FRAMES-1);
          const data=assemble(raw.get(index)||[],{preserveTimeline:true,startSequence:start,endSequence:end});
          complete+=data.completeFrames;missing+=data.missing;timelineFrames+=data.frames.length;
          await this.compactSegment(recordingId,index,data);
        }
      }
      await this.atomic(['recordings','jobs'],s=>{
        const req=s.recordings.get(recordingId);
        req.onsuccess=()=>{
          if(!req.result)return;const previous=req.result;
          s.recordings.put({...previous,status:complete?'saved':'empty',stopReason:reason,
            durationMs:lastSequence>=0?(lastSequence+1)*50:0,sizeBytes:timelineFrames?44+timelineFrames*PCM_BYTES_PER_FRAME:0,
            stats:{completeFrames:complete,incompleteFrames:incomplete,packetsReceived:packets,missingFrames:missing},sealed:true,compacted:true});
          if(!previous.sealed && complete)enqueueJob(s.jobs,{recordingId,kind:'consolidate',segmentIndex:-1,
            dedupe:recordingId+':consolidate',state:'pending',attempts:0,nextAt:0});
        };
      });
      return this.get('recordings',recordingId);
    }
    async recover(recordingIds) {
      const selected=recordingIds ? new Set(recordingIds) : null;
      const records=(await this.all('recordings')).filter(r=>r.journal&&!r.sealed&&(!selected||selected.has(r.id)))
        .sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
      if(!selected)this.recoveryFailures.clear();
      const resolved=new Set(selected||[]);let recovered=0;
      for(const r of records){
        try{await this.close(r.id,'recovered-after-interruption');resolved.add(r.id);recovered++;}
        catch(error){this.recoveryFailures.set(r.id,error);resolved.delete(r.id);}
      }
      // A page/process crash can leave a durable job marked running even though no
      // worker survives. A later retry only touches the failed recordings, never
      // an active capture or jobs belonging to a live processor.
      for(const job of (await this.all('jobs')).filter(j=>j.state==='running'&&(!selected||selected.has(j.recordingId))&&
        (!this.recoveryFailures.has(j.recordingId)||resolved.has(j.recordingId)))){
        await this.patchJob(job.id,{state:'pending',nextAt:0,lastError:'Recovered after interruption'});
      }
      await this.verifyWritable();
      for(const id of resolved)this.recoveryFailures.delete(id);
      return recovered;
    }
    async blob(record) {
      if(record.blob)return record.blob;
      const segments=(await this.all('segments','recording',record.id)).sort((a,b)=>a.index-b.index);
      const pcm=[];
      for(const segment of segments){
        if(segment.pcmBlob){pcm.push(new Uint8Array(await segment.pcmBlob.arrayBuffer()));continue;}
        const packets=await this.all('packets','segment',[record.id,segment.index]);
        const end=segment.lastSequence??assemble(packets).lastSequence;
        const data=assemble(packets,{preserveTimeline:true,startSequence:segment.index*SEGMENT_FRAMES,endSequence:end});
        pcm.push(...data.frames);
      }
      if(!pcm.length)throw new Error('No complete audio frames are available. Raw partial chunks remain stored.');
      return wav(pcm);
    }
    async remove(id) {
      await this.atomic(['recordings','packets','segments','jobs'],s=>{
        s.recordings.delete(id);
        for(const name of ['packets','segments','jobs']){
          const cursor=s[name].index('recording').openCursor(this.keys.only(id));
          cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}};
        }
      });
    }
    async clear() {await this.atomic(['recordings','packets','segments','jobs'],s=>Object.values(s).forEach(store=>store.clear()));}
    async head() {
      const jobs=await this.all('jobs');return jobs.sort((a,b)=>a.id-b.id).find(j=>j.state!=='done')||null;
    }
    async nextRunnable(now=Date.now(),excludedRecordings=new Set()) {
      const jobs=(await this.all('jobs')).sort((a,b)=>a.id-b.id),blocked=new Set(this.recoveryFailures.keys()),deferred=new Set();let wakeAt=Infinity;
      for(const job of jobs){
        if(job.state==='done')continue;
        if(job.state==='failed'){blocked.add(job.recordingId);continue;}
        if(blocked.has(job.recordingId)||deferred.has(job.recordingId)||excludedRecordings.has(job.recordingId))continue;
        if(job.state==='running') {deferred.add(job.recordingId);continue;}
        if((job.nextAt||0)>now){wakeAt=Math.min(wakeAt,job.nextAt);deferred.add(job.recordingId);continue;}
        return {job,wakeAt:Number.isFinite(wakeAt)?wakeAt:0,blockedCount:blocked.size};
      }
      return {job:null,wakeAt:Number.isFinite(wakeAt)?wakeAt:0,blockedCount:blocked.size};
    }
    async patchJob(id,fields) {
      return this.atomic(['jobs'],(s,result)=>{
        const req=s.jobs.get(id);req.onsuccess=()=>{if(!req.result){result(false);return;}s.jobs.put({...req.result,...fields});result(true);};
      });
    }
    async finishJob(job,output) {
      return this.atomic(['jobs','segments','recordings'],s=>{
        const req=s.jobs.get(job.id);req.onsuccess=()=>{
          if(!req.result)return;
          const store=job.kind==='consolidate'?s.recordings:s.segments;
          const item=store.get(job.kind==='consolidate'?job.recordingId:[job.recordingId,job.segmentIndex]);
          item.onsuccess=()=>{if(!item.result)return;store.put({...item.result,...output});s.jobs.put({...req.result,state:'done',lastError:'',finishedAt:Date.now()});};
        };
      });
    }
  }

  class FIFOProcessor {
    constructor(store,{settings,fetch:fetcher=root.fetch?.bind(root),locks=root.navigator?.locks,
      onChange=()=>{},now=()=>Date.now(),canRun=()=>true}={}){
      this.store=store;this.settings=settings;this.fetch=fetcher;this.locks=locks;this.onChange=onChange;this.now=now;
      this.running=false;this.paused=true;this.controllers=new Map();this.timer=null;this.canRun=canRun;
      root.SynapProcessingQueue={
        retryRecording:(recordingId)=>this.retryRecording(recordingId),
        resume:()=>this.resume()
      };
    }
    pause(){this.paused=true;clearTimeout(this.timer);for(const controller of this.controllers.values())controller.abort();this.onChange('Queue paused');}
    async resume(){if(!this.canRun())return;this.paused=false;return this.run();}
    async retry(){
      const jobs=(await this.store.all('jobs')).sort((a,b)=>a.id-b.id),job=jobs.find(j=>j.state==='failed')||jobs.find(j=>j.state!=='done');
      if(job)await this.store.patchJob(job.id,{state:'pending',attempts:0,nextAt:0,lastError:''});return this.resume();
    }
    async retryRecording(recordingId){
      const id=String(recordingId||'');
      if(!id)return this.resume();
      const jobs=(await this.store.all('jobs','recording',id)).sort((a,b)=>a.id-b.id);
      const failed=jobs.filter(job=>job.state==='failed');
      for(const job of failed){
        await this.store.patchJob(job.id,{state:'pending',attempts:0,nextAt:0,lastError:'',startedAt:null,finishedAt:null});
      }
      if(!failed.length){
        const waiting=jobs.find(job=>job.state!=='done'&&job.state!=='running');
        if(waiting)await this.store.patchJob(waiting.id,{state:'pending',attempts:0,nextAt:0,lastError:''});
      }
      this.onChange('Retrying recording');
      return this.resume();
    }
    async execute(job,config,url){
      await this.store.patchJob(job.id,{state:'running',startedAt:this.now()});
      try {
        const output=await this.process(job,config,url);await this.store.finishJob(job,output);this.onChange('Saved job '+job.id);
      } catch(e) {
        const paused=this.paused||e.name==='AbortError'&&!this.canRun();
        const attempts=(job.attempts||0)+(paused?0:1),permanent=e.retryable===false;
        const failed=permanent||attempts>=5;
        const nextAt=paused?0:this.now()+Math.min(60000,2000*2**Math.max(0,attempts-1));
        await this.store.patchJob(job.id,{state:failed?'failed':'pending',attempts,nextAt:failed?0:nextAt,lastError:(e.name||'Error')+': '+e.message});
        this.onChange(failed?'Recording processing needs retry: '+e.message:'Processing retry scheduled: '+e.message);
      }
    }
    async run(){
      if(this.paused || this.running || !this.canRun())return;
      if(!this.locks){this.onChange('Processing requires Web Locks. Use a current supported browser.');return;}
      this.running=true;clearTimeout(this.timer);
      try {
        await this.locks.request('dk-pendant-processing',{ifAvailable:true},async lock=>{
          if(!lock){this.onChange('Another tab is processing recordings');return;}
          const active=new Map();
          while(!this.paused&&this.canRun()){
            let launched=false;
            while(active.size<MAX_PROCESSING_CONCURRENCY&&!this.paused&&this.canRun()){
              const excluded=new Set([...active.values()].map(x=>x.recordingId));
              const selected=await this.store.nextRunnable(this.now(),excluded);if(!selected.job)break;
              const job=selected.job,config=this.settings(),url=job.kind==='transcribe'?config.endpoint:config.llmEndpoint;
              if(!url){this.onChange('Queue waiting: configure '+(job.kind==='transcribe'?'transcription':'LLM')+' endpoint');break;}
              if(new URL(url).protocol!=='https:')throw new Error('Processing endpoints must use HTTPS');
              this.onChange('Processing '+job.kind+' · segment '+(job.segmentIndex+1));
              const promise=this.execute(job,config,url).then(()=>job.id,()=>job.id);active.set(job.id,{recordingId:job.recordingId,promise});launched=true;
            }
            if(active.size){const done=await Promise.race([...active.values()].map(x=>x.promise));active.delete(done);continue;}
            const selected=await this.store.nextRunnable(this.now());
            if(selected.job){if(!launched)continue;}
            else if(selected.wakeAt>this.now()){
              this.onChange('Processing retry scheduled');this.timer=setTimeout(()=>this.run(),selected.wakeAt-this.now()+20);return;
            } else if(selected.blockedCount){this.onChange(selected.blockedCount+' recording'+(selected.blockedCount===1?'':'s')+' need retry; other recordings are complete');return;}
            else {this.onChange('Queue complete');return;}
          }
        });
      } catch(e){this.onChange('Queue error: '+e.message);}
      finally {this.running=false;}
    }
    async process(job,config,url){
      const headers={'Idempotency-Key':job.dedupe};if(config.token)headers.Authorization='Bearer '+config.token;
      let body;
      if(job.kind==='transcribe'){
        const data=await this.store.segment(job.recordingId,job.segmentIndex);
        if(!data.blob&&!data.frames.length)throw new Error('Segment has no complete PCM frames');
        body=new FormData();body.append('audio',data.blob||wav(data.frames),'segment-'+job.segmentIndex+'.wav');
        body.append('recording_id',job.recordingId);body.append('segment_index',String(job.segmentIndex));body.append('sample_rate','16000');
      } else {
        headers['Content-Type']='application/json';let input;
        if(job.kind==='summarize'){
          const segment=await this.store.get('segments',[job.recordingId,job.segmentIndex]);
          if(!segment || typeof segment.transcript!=='string')throw new Error('Missing prior transcription');input=segment.transcript;
        } else {
          const segments=(await this.store.all('segments','recording',job.recordingId)).filter(s=>s.frameCount).sort((a,b)=>a.index-b.index);
          if(segments.some(s=>typeof s.summary!=='string'))throw new Error('Missing prior segment summary');input=segments.map(s=>({index:s.index,summary:s.summary}));
        }
        body=JSON.stringify({task:job.kind==='summarize'?'summarize_segment':'consolidate',recording_id:job.recordingId,segment_index:job.segmentIndex,input});
      }
      if(this.paused || !this.canRun()){const error=new Error('Processing paused before upload');error.name='AbortError';throw error;}
      const controller=new AbortController();this.controllers.set(job.id,controller);const timeout=setTimeout(()=>controller.abort(),120000);
      try {
        const response=await this.fetch(url,{method:'POST',headers,body,signal:controller.signal});
        if(!response.ok){const e=new Error('HTTP '+response.status);e.retryable=[408,409,425,429].includes(response.status)||response.status>=500;throw e;}
        const json=(response.headers.get('content-type')||'').includes('application/json'),data=json?await response.json():await response.text();
        if(job.kind==='transcribe'){
          const transcript=json?(data.transcript??data.text):data;if(typeof transcript!=='string')throw new Error('Response needs text or transcript');return {transcript};
        }
        const summary=json?data.summary:data;if(typeof summary!=='string')throw new Error('Response needs summary');
        if(job.kind==='consolidate'){
          const segments=(await this.store.all('segments','recording',job.recordingId)).sort((a,b)=>a.index-b.index);
          return {summary,transcript:segments.map(s=>s.transcript||'').join('\n'),processingState:'done'};
        }
        return {summary};
      } finally {clearTimeout(timeout);this.controllers.delete(job.id);}
    }
  }
  root.DKAudioStore=AudioStore;root.DKFIFOProcessor=FIFOProcessor;
  root.DKAudioCodec={assemble,wav,SEGMENT_FRAMES,PCM_BYTES_PER_FRAME};
})(globalThis);
