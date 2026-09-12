/* Synap AI provider presets: transcription, conversation segmentation, people and structured memory. */
(function (root) {
  'use strict';
  const PREF_KEY = 'synap-ai-provider-settings',
    OPENAI_TRANSCRIBE = 'https://api.openai.com/v1/audio/transcriptions',
    OPENAI_RESPONSES = 'https://api.openai.com/v1/responses',
    SEGMENTS_PER_BLOCK = 10,
    DEFAULTS = {
      provider: 'openai',
      sttModel: 'gpt-4o-mini-transcribe',
      llmModel: 'gpt-5-mini',
      language: 'auto',
    };
  const ACTION = {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: { type: 'string' },
      owner: { type: 'string' },
      due_date: { type: 'string' },
    },
    required: ['task', 'owner', 'due_date'],
  };
  const PERSON = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      role: { type: 'string' },
      evidence: { type: 'string' },
    },
    required: ['name', 'role', 'evidence'],
  };
  const CONVERSATION = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      start_seconds: { type: 'number' },
      end_seconds: { type: 'number' },
      summary: { type: 'string' },
      people: { type: 'array', items: PERSON },
      topics: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } },
      action_items: { type: 'array', items: ACTION },
      follow_ups: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'title',
      'start_seconds',
      'end_seconds',
      'summary',
      'people',
      'topics',
      'decisions',
      'action_items',
      'follow_ups',
    ],
  };
  const BLOCK = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      key_points: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } },
      action_items: { type: 'array', items: ACTION },
      questions: { type: 'array', items: { type: 'string' } },
      follow_ups: { type: 'array', items: { type: 'string' } },
      topics: { type: 'array', items: { type: 'string' } },
      people: { type: 'array', items: PERSON },
    },
    required: [
      'summary',
      'key_points',
      'decisions',
      'action_items',
      'questions',
      'follow_ups',
      'topics',
      'people',
    ],
  };
  const MEETING = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      executive_summary: { type: 'string' },
      key_points: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } },
      action_items: { type: 'array', items: ACTION },
      questions: { type: 'array', items: { type: 'string' } },
      follow_ups: { type: 'array', items: { type: 'string' } },
      topics: { type: 'array', items: { type: 'string' } },
      people: { type: 'array', items: PERSON },
      conversations: { type: 'array', items: CONVERSATION },
    },
    required: [
      'title',
      'executive_summary',
      'key_points',
      'decisions',
      'action_items',
      'questions',
      'follow_ups',
      'topics',
      'people',
      'conversations',
    ],
  };
  function prefs(storage = root.localStorage) {
    try {
      return { ...DEFAULTS, ...JSON.parse(storage?.getItem(PREF_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  function save(v, storage = root.localStorage) {
    const x = {
      provider: v.provider === 'custom' ? 'custom' : 'openai',
      sttModel: String(v.sttModel || DEFAULTS.sttModel),
      llmModel: String(v.llmModel || DEFAULTS.llmModel),
      language: String(v.language || 'auto'),
    };
    storage?.setItem(PREF_KEY, JSON.stringify(x));
    return x;
  }
  function output(d) {
    if (typeof d?.output_text === 'string' && d.output_text.trim()) return d.output_text;
    const p = [];
    for (const i of d?.output || [])
      for (const c of i?.content || [])
        if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string')
          p.push(c.text);
    return p.join('\n').trim();
  }
  async function parsed(r) {
    const ct = r.headers?.get?.('content-type') || '';
    let d;
    try {
      d = ct.includes('application/json') ? await r.json() : await r.text();
    } catch (_) {
      d = '';
    }
    if (!r.ok) {
      const e = new Error(
        'OpenAI HTTP ' + r.status + ': ' + (d?.error?.message || d?.message || ''),
      );
      e.retryable = [408, 409, 425, 429].includes(r.status) || r.status >= 500;
      throw e;
    }
    return d;
  }
  function ts(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      x = s % 60;
    return (
      (h ? String(h).padStart(2, '0') + ':' : '') +
      String(m).padStart(2, '0') +
      ':' +
      String(x).padStart(2, '0')
    );
  }
  function groups(a) {
    const g = [];
    for (let i = 0; i < a.length; i += SEGMENTS_PER_BLOCK)
      g.push(a.slice(i, i + SEGMENTS_PER_BLOCK));
    return g;
  }
  function identity(g) {
    return g.map((s) => s.index + ':' + String(s.transcript || '').length).join('|');
  }
  function input(g) {
    return g
      .map(
        (s) => '[' + ts(s.index * 30) + '–' + ts((s.index + 1) * 30) + ']\n' + (s.transcript || ''),
      )
      .join('\n\n');
  }
  function meetingText(m) {
    const l = [m.executive_summary || ''],
      add = (t, a) => {
        if (a?.length) {
          l.push('', t);
          a.forEach((v) => l.push('• ' + v));
        }
      };
    add('Key points', m.key_points);
    add('Decisions', m.decisions);
    if (m.action_items?.length) {
      l.push('', 'Action items');
      m.action_items.forEach((a) =>
        l.push(
          '• ' + a.task + (a.owner ? ' — ' + a.owner : '') + (a.due_date ? ' · ' + a.due_date : ''),
        ),
      );
    }
    add('Follow-ups', m.follow_ups);
    return l.join('\n').trim();
  }
  async function structured(p, j, c, pr, o) {
    const r = await p.fetch(OPENAI_RESPONSES, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'Content-Type': 'application/json',
        'Idempotency-Key': o.key,
      },
      body: JSON.stringify({
        model: pr.llmModel || DEFAULTS.llmModel,
        store: false,
        instructions: o.instructions,
        input: o.input,
        text: { format: { type: 'json_schema', name: o.name, strict: true, schema: o.schema } },
      }),
      signal: p.controllers.get(j.id)?.signal,
    });
    const t = output(await parsed(r));
    if (!t) throw new Error('OpenAI response contained no text');
    return JSON.parse(t);
  }
  async function persistBlock(p, id, b) {
    await p.store.atomic(['recordings'], (s) => {
      const r = s.recordings.get(id);
      r.onsuccess = () => {
        if (r.result)
          s.recordings.put({
            ...r.result,
            meetingBlocks: [
              ...(r.result.meetingBlocks || []).filter((x) => x.index !== b.index),
              b,
            ].sort((a, z) => a.index - z.index),
            processingState: 'processing',
          });
      };
    });
  }
  async function continuousContext(p, r, blocks) {
    const all = await p.store.all('recordings');
    let parts = [r];
    if (r?.continuousGroupId)
      parts = all
        .filter(
          (x) =>
            x.continuousGroupId === r.continuousGroupId &&
            Number(x.continuousPart || 1) <= Number(r.continuousPart || 1),
        )
        .sort((a, b) => Number(a.continuousPart || 1) - Number(b.continuousPart || 1));
    const finalInput = [],
      lines = [];
    let offset = 0;
    for (const part of parts) {
      const bs = part.id === r.id ? blocks : part.meetingBlocks || [];
      for (const b of bs)
        finalInput.push({
          part: Number(part.continuousPart || 1),
          block: Number(b.index || 0) + 1,
          time:
            ts(offset + Number(b.startSeconds || 0)) + '–' + ts(offset + Number(b.endSeconds || 0)),
          start_seconds: offset + Number(b.startSeconds || 0),
          end_seconds: offset + Number(b.endSeconds || 0),
          memory: b.memory,
        });
      const seg = (await p.store.all('segments', 'recording', part.id))
        .filter((x) => String(x.transcript || '').trim())
        .sort((a, b) => a.index - b.index);
      seg.forEach((s) =>
        lines.push(
          '[' +
            ts(offset + s.index * 30) +
            '–' +
            ts(offset + (s.index + 1) * 30) +
            '] ' +
            s.transcript,
        ),
      );
      offset += (Number(part.durationMs) || 0) / 1000;
    }
    return { parts, finalInput, transcript: lines.join('\n'), durationSeconds: offset };
  }
  async function transcribe(p, j, c, pr) {
    if (!c.token) {
      const e = new Error('Add your OpenAI API key in Settings → AI processing');
      e.retryable = false;
      throw e;
    }
    const s = await p.store.segment(j.recordingId, j.segmentIndex);
    if (!s.blob && !s.frames.length) throw new Error('Segment has no complete PCM frames');
    const f = new FormData();
    f.append(
      'file',
      s.blob || root.DKAudioCodec.wav(s.frames),
      'synap-' + j.recordingId + '-' + j.segmentIndex + '.wav',
    );
    f.append('model', pr.sttModel || DEFAULTS.sttModel);
    f.append('response_format', 'json');
    if (pr.language && pr.language !== 'auto') f.append('language', pr.language);
    f.append(
      'prompt',
      'Natural conversation transcription. Preserve names, speaker self-identification, numbers, acronyms, decisions and commitments. Do not summarize.',
    );
    const d = await parsed(
      await p.fetch(OPENAI_TRANSCRIBE, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + c.token, 'Idempotency-Key': j.dedupe },
        body: f,
        signal: p.controllers.get(j.id)?.signal,
      }),
    );
    const t = d?.text ?? d?.transcript;
    if (typeof t !== 'string')
      throw new Error('OpenAI transcription response did not contain text');
    return { transcript: t.trim(), provider: 'openai', sttModel: pr.sttModel };
  }
  async function respond(p, j, c, pr) {
    if (!c.token) {
      const e = new Error('Add your OpenAI API key in Settings → AI processing');
      e.retryable = false;
      throw e;
    }
    if (j.kind === 'summarize') {
      const s = await p.store.get('segments', [j.recordingId, j.segmentIndex]);
      if (!s || typeof s.transcript !== 'string') throw new Error('Missing prior transcription');
      return { summary: s.transcript.trim(), contextReady: true, provider: 'openai' };
    }
    const seg = (await p.store.all('segments', 'recording', j.recordingId))
      .filter((s) => String(s.transcript || '').trim())
      .sort((a, b) => a.index - b.index);
    if (!seg.length) throw new Error('Missing transcript segments');
    const rec = await p.store.get('recordings', j.recordingId),
      saved = new Map((rec?.meetingBlocks || []).map((b) => [b.index, b])),
      gs = groups(seg),
      blocks = [];
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i],
        id = identity(g),
        old = saved.get(i);
      if (old?.identity === id && old?.memory) {
        blocks.push(old);
        continue;
      }
      const memory = await structured(p, j, c, pr, {
          key: j.dedupe + ':block:' + i + ':' + id,
          name: 'synap_memory_block',
          schema: BLOCK,
          instructions:
            'Extract reliable memory from this consecutive transcript block. Identify people only when a name or role is evidenced in the words; use role such as self, participant, colleague, customer, or unknown. Preserve chronology, names, numbers, commitments, decisions, unresolved questions and topics. Never invent identity, owner, date or fact.',
          input: input(g),
        }),
        b = {
          index: i,
          identity: id,
          startSeconds: g[0].index * 30,
          endSeconds: (g[g.length - 1].index + 1) * 30,
          start: ts(g[0].index * 30),
          end: ts((g[g.length - 1].index + 1) * 30),
          segmentStart: g[0].index,
          segmentEnd: g[g.length - 1].index,
          memory,
          model: pr.llmModel,
          processedAt: new Date().toISOString(),
        };
      await persistBlock(p, j.recordingId, b);
      blocks.push(b);
    }
    const ctx = await continuousContext(p, rec, blocks),
      m = await structured(p, j, c, pr, {
        key:
          j.dedupe +
          ':final:' +
          ctx.finalInput.map((x) => x.part + ':' + x.block + ':' + x.time).join(';'),
        name: 'synap_memory',
        schema: MEETING,
        instructions:
          'Build a reliable personal memory from chronological blocks. Automatically rolled 45-minute capture parts are one continuous conversation stream for continuity; never create a boundary merely because the browser rolled to a new part. Segment the timeline into distinct real-world conversations only when there is evidence of a true conversational boundary such as a clear topic, participant or context transition. Adjacent blocks from the same conversation must stay together. start_seconds/end_seconds must be grounded in supplied block times. Identify people conservatively: canonicalize repeated variants of the same evidenced name, label the wearer/user as role self when evident, and never guess an identity. For each conversation preserve its people, topics, decisions, actions and follow-ups. Merge duplicates globally. Later explicit decisions supersede earlier proposals. Never invent facts.',
        input: JSON.stringify(ctx.finalInput),
      });
    return {
      name: m.title || undefined,
      summary: meetingText(m),
      meeting: m,
      people: m.people,
      conversations: m.conversations,
      meetingBlocks: blocks,
      transcript: ctx.transcript,
      processingState: 'done',
      provider: 'openai',
      sttModel: pr.sttModel,
      llmModel: pr.llmModel,
      processingStrategy:
        'conversation-segmented-30s-stt-5m-memory continuous-45m-parts-30s-stt-5m-blocks-final',
      continuousGroupId: rec?.continuousGroupId || null,
      continuousParts: ctx.parts.length,
      continuousDurationMs: Math.round(ctx.durationSeconds * 1000),
      processedAt: new Date().toISOString(),
    };
  }
  function register() {
    root.DKFIFOProcessor?.registerProvider('openai', {
      prepare(_processor, config) {
        return { ...config, endpoint: OPENAI_TRANSCRIBE, llmEndpoint: OPENAI_RESPONSES };
      },
      process(processor, job, config) {
        const preferences = prefs();
        return job.kind === 'transcribe'
          ? transcribe(processor, job, config, preferences)
          : respond(processor, job, config, preferences);
      },
    });
  }
  function bind() {
    if (!root.document) return;
    const provider = document.getElementById('providerInput'),
      stt = document.getElementById('sttModelInput'),
      llm = document.getElementById('llmModelInput'),
      lang = document.getElementById('languageInput'),
      endpoint = document.getElementById('endpointInput'),
      llmEndpoint = document.getElementById('llmEndpointInput'),
      token = document.getElementById('tokenInput'),
      form = document.getElementById('settingsForm'),
      auto = document.getElementById('autoProcessInput');
    if (!provider || !stt || !llm || !lang || !endpoint || !llmEndpoint || !token || !form) return;
    const pr = prefs();
    provider.value = pr.provider;
    stt.value = pr.sttModel;
    llm.value = pr.llmModel;
    lang.value = pr.language;
    if (!localStorage.getItem('synap-ai-autoprocess-initialized')) {
      auto.checked = true;
      localStorage.setItem('synap-ai-autoprocess-initialized', '1');
    }
    const custom = document.getElementById('customEndpointFields'),
      open = document.getElementById('openAIModelFields'),
      label = document.getElementById('apiKeyLabel');
    function apply() {
      const yes = provider.value === 'openai';
      if (custom) custom.hidden = yes;
      if (open) open.hidden = !yes;
      if (label) label.textContent = yes ? 'OpenAI API key' : 'Access token';
      if (yes) {
        endpoint.value = OPENAI_TRANSCRIBE;
        llmEndpoint.value = OPENAI_RESPONSES;
        token.required = true;
      } else token.required = false;
    }
    provider.addEventListener('change', apply);
    apply();
    form.addEventListener(
      'submit',
      (e) => {
        if (provider.value === 'openai' && !token.value.trim()) {
          e.preventDefault();
          token.focus();
          return;
        }
        save({
          provider: provider.value,
          sttModel: stt.value,
          llmModel: llm.value,
          language: lang.value,
        });
        setTimeout(() => {
          if (auto.checked) document.getElementById('runQueueButton')?.click();
        }, 0);
      },
      true,
    );
  }
  function init() {
    bind();
  }
  register();
  if (root.document?.readyState === 'loading')
    root.document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  root.SynapAIProviders = { readPrefs: prefs, savePrefs: save };
})(globalThis);
