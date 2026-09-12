/* Durable processing scheduler. AudioStore owns persistence; registered providers own network work. */
(function (root) {
  'use strict';
  const MAX_PROCESSING_CONCURRENCY = 2;
  const providers = new Map();

  function emitState(job, state) {
    if (typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
    root.dispatchEvent(
      new root.CustomEvent('synap-processing-state', {
        detail: { recordingId: job.recordingId, kind: job.kind, state },
      }),
    );
  }

  class FIFOProcessor {
    static registerProvider(name, provider) {
      if (!name || name === 'custom' || typeof provider?.process !== 'function')
        throw new TypeError('A named processing provider needs a process function');
      providers.set(name, provider);
    }
    static provider(name) {
      return providers.get(name);
    }

    constructor(
      store,
      {
        settings,
        fetch: fetcher = root.fetch?.bind(root),
        locks = root.navigator?.locks,
        onChange = () => {},
        now = () => Date.now(),
        canRun = () => true,
        provider = () => root.SynapAIProviders?.readPrefs().provider || 'custom',
      } = {},
    ) {
      this.store = store;
      this.settings = settings;
      this.fetch = fetcher;
      this.locks = locks;
      this.onChange = onChange;
      this.now = now;
      this.running = false;
      this.paused = true;
      this.controllers = new Map();
      this.timer = null;
      this.canRun = canRun;
      this.provider = provider;
      this.recordingScope = null;
      this.settled = Promise.resolve();
      root.SynapProcessingQueue = {
        retryRecording: (recordingId) => this.retryRecording(recordingId),
        queueRecordings: (recordingIds) => this.queueRecordings(recordingIds),
        resume: () => this.resume(),
      };
    }
    pause() {
      this.paused = true;
      clearTimeout(this.timer);
      for (const controller of this.controllers.values()) controller.abort();
      this.onChange('Queue paused');
      return this.settled;
    }
    async resume(recordingIds = null) {
      if (!this.canRun()) return;
      this.recordingScope = recordingIds ? new Set(recordingIds) : null;
      this.paused = false;
      return this.run();
    }
    async retry() {
      const jobs = (await this.store.all('jobs')).sort((a, b) => a.id - b.id),
        job = jobs.find((j) => j.state === 'failed') || jobs.find((j) => j.state !== 'done');
      if (job)
        await this.store.patchJob(job.id, {
          state: 'pending',
          attempts: 0,
          nextAt: 0,
          lastError: '',
        });
      return this.resume();
    }
    async retryRecording(recordingId) {
      const id = String(recordingId || '');
      if (!id) return;
      return this.queueRecordings([id]);
    }
    async prepareRecordingRetry(id) {
      const jobs = (await this.store.all('jobs', 'recording', id)).sort((a, b) => a.id - b.id);
      const failed = jobs.filter((job) => job.state === 'failed');
      for (const job of failed) {
        await this.store.patchJob(job.id, {
          state: 'pending',
          attempts: 0,
          nextAt: 0,
          lastError: '',
          startedAt: null,
          finishedAt: null,
        });
      }
      if (!failed.length) {
        const waiting = jobs.find((job) => job.state !== 'done' && job.state !== 'running');
        if (waiting)
          await this.store.patchJob(waiting.id, {
            state: 'pending',
            attempts: 0,
            nextAt: 0,
            lastError: '',
          });
      }
    }
    async queueRecordings(recordingIds) {
      const ids = [...new Set((recordingIds || []).map(String).filter(Boolean))];
      if (!ids.length) return 0;
      await this.pause();
      for (const id of ids) await this.prepareRecordingRetry(id);
      this.onChange('Queued ' + ids.length + ' selected recording' + (ids.length === 1 ? '' : 's'));
      void this.resume(ids);
      return ids.length;
    }
    async execute(job, config, url) {
      await this.store.patchJob(job.id, { state: 'running', startedAt: this.now() });
      emitState(job, 'running');
      let saved;
      try {
        const output = await this.process(job, config, url);
        saved = await this.store.finishJob(job, output);
      } catch (e) {
        const paused = this.paused || (e.name === 'AbortError' && !this.canRun());
        const attempts = (job.attempts || 0) + (paused ? 0 : 1),
          permanent = e.retryable === false;
        const failed = permanent || attempts >= 5;
        const nextAt = paused
          ? 0
          : this.now() + Math.min(60000, 2000 * 2 ** Math.max(0, attempts - 1));
        await this.store.patchJob(job.id, {
          state: failed ? 'failed' : 'pending',
          attempts,
          nextAt: failed ? 0 : nextAt,
          lastError: (e.name || 'Error') + ': ' + e.message,
        });
        emitState(job, failed ? 'failed' : 'pending');
        this.onChange(
          failed
            ? 'Recording processing needs retry: ' + e.message
            : 'Processing retry scheduled: ' + e.message,
        );
        return;
      }
      // UI callbacks cannot turn a committed result back into pending work.
      if (saved) {
        emitState(job, 'done');
        if (job.kind === 'consolidate') root.SynapMemoryReadyEvents?.emit(saved);
      }
      this.onChange('Saved job ' + job.id);
    }
    async run() {
      if (this.paused || this.running || !this.canRun()) return;
      if (!this.locks) {
        this.onChange('Processing requires Web Locks. Use a current supported browser.');
        return;
      }
      this.running = true;
      clearTimeout(this.timer);
      let settled;
      this.settled = new Promise((resolve) => {
        settled = resolve;
      });
      try {
        await this.locks.request('dk-pendant-processing', { ifAvailable: true }, async (lock) => {
          if (!lock) {
            this.onChange('Another tab is processing recordings');
            return;
          }
          const name = this.provider(),
            adapter = providers.get(name);
          if (name !== 'custom' && !adapter) {
            this.onChange('Queue waiting: processing provider ' + name + ' is unavailable');
            return;
          }
          let config = { ...this.settings(), provider: name };
          if (adapter?.prepare) config = await adapter.prepare(this, config);
          if (!config) return;
          const active = new Map();
          try {
            while (!this.paused && this.canRun()) {
              while (active.size < MAX_PROCESSING_CONCURRENCY && !this.paused && this.canRun()) {
                const excluded = new Set([...active.values()].map((x) => x.recordingId));
                const selected = await this.store.nextRunnable(
                  this.now(),
                  excluded,
                  this.recordingScope,
                );
                if (!selected.job || this.paused || !this.canRun()) break;
                const job = selected.job,
                  url = job.kind === 'transcribe' ? config.endpoint : config.llmEndpoint;
                if (!url) {
                  this.onChange(
                    'Queue waiting: configure ' +
                      (job.kind === 'transcribe' ? 'transcription' : 'LLM') +
                      ' endpoint',
                  );
                  return;
                }
                if (new URL(url).protocol !== 'https:')
                  throw new Error('Processing endpoints must use HTTPS');
                this.onChange('Processing ' + job.kind + ' · segment ' + (job.segmentIndex + 1));
                const promise = this.execute(job, config, url).then(
                  () => job.id,
                  () => job.id,
                );
                active.set(job.id, { recordingId: job.recordingId, promise });
              }
              if (active.size) {
                const done = await Promise.race([...active.values()].map((x) => x.promise));
                active.delete(done);
                continue;
              }
              const selected = await this.store.nextRunnable(
                this.now(),
                new Set(),
                this.recordingScope,
              );
              if (selected.job) {
                continue;
              } else if (selected.wakeAt > this.now()) {
                this.onChange('Processing retry scheduled');
                this.timer = setTimeout(() => this.run(), selected.wakeAt - this.now() + 20);
                return;
              } else if (selected.blockedCount) {
                this.onChange(
                  selected.blockedCount +
                    ' recording' +
                    (selected.blockedCount === 1 ? '' : 's') +
                    ' need retry; other recordings are complete',
                );
                return;
              } else {
                this.onChange('Queue complete');
                return;
              }
            }
          } finally {
            await Promise.all([...active.values()].map((work) => work.promise));
          }
        });
      } catch (e) {
        this.onChange('Queue error: ' + e.message);
      } finally {
        this.running = false;
        settled();
      }
    }
    async process(job, config, url) {
      const name = config.provider || this.provider(),
        adapter = providers.get(name);
      if (name !== 'custom' && !adapter) throw new Error('Unknown processing provider: ' + name);
      const budget = adapter?.timeout?.(job) || 120000;
      return this.withJobSignal(job, budget, (signal) =>
        adapter
          ? adapter.process(this, job, config, signal)
          : this.processCustom(job, config, url, signal),
      );
    }
    async withJobSignal(job, budget, work) {
      if (this.paused || !this.canRun()) {
        const error = new Error('Processing paused before upload');
        error.name = 'AbortError';
        throw error;
      }
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      const timeout = setTimeout(() => controller.abort(), budget);
      try {
        return await work(controller.signal);
      } finally {
        clearTimeout(timeout);
        this.controllers.delete(job.id);
      }
    }
    async processCustom(job, config, url, signal) {
      const headers = { 'Idempotency-Key': job.dedupe };
      if (config.token) headers.Authorization = 'Bearer ' + config.token;
      let body;
      if (job.kind === 'transcribe') {
        const data = await this.store.segment(job.recordingId, job.segmentIndex);
        if (!data.blob && !data.frames.length)
          throw new Error('Segment has no complete PCM frames');
        body = new FormData();
        body.append(
          'audio',
          data.blob || root.DKAudioCodec.wav(data.frames),
          'segment-' + job.segmentIndex + '.wav',
        );
        body.append('recording_id', job.recordingId);
        body.append('segment_index', String(job.segmentIndex));
        body.append('sample_rate', '16000');
      } else {
        headers['Content-Type'] = 'application/json';
        let input;
        if (job.kind === 'summarize') {
          const segment = await this.store.get('segments', [job.recordingId, job.segmentIndex]);
          if (!segment || typeof segment.transcript !== 'string')
            throw new Error('Missing prior transcription');
          input = segment.transcript;
        } else {
          const segments = (await this.store.all('segments', 'recording', job.recordingId))
            .filter((s) => s.frameCount)
            .sort((a, b) => a.index - b.index);
          if (segments.some((s) => typeof s.summary !== 'string'))
            throw new Error('Missing prior segment summary');
          input = segments.map((s) => ({ index: s.index, summary: s.summary }));
        }
        body = JSON.stringify({
          task: job.kind === 'summarize' ? 'summarize_segment' : 'consolidate',
          recording_id: job.recordingId,
          segment_index: job.segmentIndex,
          input,
        });
      }
      if (this.paused || !this.canRun()) {
        const error = new Error('Processing paused before upload');
        error.name = 'AbortError';
        throw error;
      }
      const response = await this.fetch(url, { method: 'POST', headers, body, signal });
      if (!response.ok) {
        const e = new Error('HTTP ' + response.status);
        e.retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
        throw e;
      }
      const json = (response.headers.get('content-type') || '').includes('application/json'),
        data = json ? await response.json() : await response.text();
      if (job.kind === 'transcribe') {
        const transcript = json ? (data.transcript ?? data.text) : data;
        if (typeof transcript !== 'string') throw new Error('Response needs text or transcript');
        return { transcript };
      }
      const summary = json ? data.summary : data;
      if (typeof summary !== 'string') throw new Error('Response needs summary');
      if (job.kind === 'consolidate') {
        const segments = (await this.store.all('segments', 'recording', job.recordingId)).sort(
          (a, b) => a.index - b.index,
        );
        return {
          summary,
          transcript: segments.map((s) => s.transcript || '').join('\n'),
          processingState: 'done',
        };
      }
      return { summary };
    }
  }
  root.DKFIFOProcessor = FIFOProcessor;
})(globalThis);
