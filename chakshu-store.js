/* Visuals never enter the audio journal. Every row belongs to one account. */
(function (root) {
  'use strict';
  const TARGET = 'xiao-esp32s3-sense-8m';
  function windowFrames(frames, atMs, radius = 2) {
    if (!Number.isFinite(atMs) || atMs < 0 || !frames.length) return [];
    const ordered = [...frames].sort((a, b) => a.atMs - b.atMs);
    let nearest = 0;
    for (let i = 1; i < ordered.length; i++)
      if (Math.abs(ordered[i].atMs - atMs) < Math.abs(ordered[nearest].atMs - atMs)) nearest = i;
    // A long radio gap is not visual evidence of the requested moment.
    if (Math.abs(ordered[nearest].atMs - atMs) > 10000) return [];
    return ordered
      .slice(Math.max(0, nearest - Math.min(2, radius)), nearest + Math.min(2, radius) + 1)
      .filter((frame) => Math.abs(frame.atMs - atMs) <= 10000);
  }
  function explainWords(words) {
    return (words || [])
      .filter(
        (word) =>
          typeof word.text === 'string' &&
          /\bexplain\b/i.test(word.text) &&
          Number.isFinite(word.start_ms) &&
          word.start_ms >= 0,
      )
      .map((word) => Math.round(word.start_ms));
  }
  function splitMJPEG(bytes, times) {
    const frames = [];
    let start = -1;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (start < 0 && bytes[i] === 255 && bytes[i + 1] === 216) start = i;
      else if (start >= 0 && bytes[i] === 255 && bytes[i + 1] === 217) {
        frames.push({
          atMs: times?.[frames.length] ?? frames.length * 500,
          blob: new Blob([bytes.slice(start, i + 2)], { type: 'image/jpeg' }),
        });
        start = -1;
        i++;
      }
    }
    if (start >= 0 || !frames.length)
      throw Error('This camera file is incomplete or contains no JPEG frames.');
    return frames;
  }
  const request = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  class Store {
    constructor(ownerUid) {
      if (!ownerUid) throw Error('Sign in to open the photo/video library.');
      this.uid = ownerUid;
      this.db = null;
    }
    async open() {
      if (this.db) return this.db;
      const req = root.indexedDB.open('synap-visual-library', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('media', { keyPath: ['ownerUid', 'id'] }).createIndex(
          'owner',
          'ownerUid',
        );
        db.createObjectStore('frames', { keyPath: ['ownerUid', 'mediaId', 'index'] }).createIndex(
          'media',
          ['ownerUid', 'mediaId'],
        );
      };
      this.db = await request(req);
      this.db.onversionchange = () => {
        this.db.close();
        this.db = null;
      };
      return this.db;
    }
    async transaction(names, action) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, 'readwrite');
        let value;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error || Error('Visual library write failed.'));
        try {
          action(
            Object.fromEntries(names.map((name) => [name, tx.objectStore(name)])),
            (result) => {
              value = result;
            },
          );
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    }
    async list() {
      const db = await this.open();
      return (
        await request(db.transaction('media').objectStore('media').index('owner').getAll(this.uid))
      ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    async get(id) {
      const db = await this.open();
      return request(db.transaction('media').objectStore('media').get([this.uid, id]));
    }
    async frames(id) {
      const db = await this.open();
      return request(
        db.transaction('frames').objectStore('frames').index('media').getAll([this.uid, id]),
      );
    }
    async firstFrame(id) {
      const db = await this.open();
      return request(
        db.transaction('frames').objectStore('frames').index('media').get([this.uid, id]),
      );
    }
    async lastFrame(id) {
      const db = await this.open();
      const cursor = await request(
        db
          .transaction('frames')
          .objectStore('frames')
          .index('media')
          .openCursor(root.IDBKeyRange.only([this.uid, id]), 'prev'),
      );
      return cursor?.value;
    }
    async addDescription(id, description) {
      return this.transaction(['media'], (s) => {
        const req = s.media.get([this.uid, id]);
        req.onsuccess = () => {
          if (req.result)
            s.media.put({
              ...req.result,
              descriptions: [...(req.result.descriptions || []), description],
            });
        };
      });
    }
    async ackVoiceRequest(id, key) {
      return this.transaction(['media'], (s) => {
        const req = s.media.get([this.uid, id]);
        req.onsuccess = () => {
          if (req.result)
            s.media.put({
              ...req.result,
              voiceRequests: [...new Set([...(req.result.voiceRequests || []), key])],
            });
        };
      });
    }
    async create(fields) {
      const row = {
        ...fields,
        id: root.crypto.randomUUID(),
        ownerUid: this.uid,
        createdAt: new Date().toISOString(),
        frameCount: 0,
        bytes: 0,
        state: 'capturing',
        descriptions: [],
      };
      await this.transaction(['media'], (s) => s.media.add(row));
      return row;
    }
    async patch(id, fields) {
      return this.transaction(['media'], (s, result) => {
        const req = s.media.get([this.uid, id]);
        req.onsuccess = () => {
          if (!req.result) return;
          const row = { ...req.result, ...fields, id, ownerUid: this.uid };
          s.media.put(row);
          result(row);
        };
      });
    }
    async append(id, frame) {
      if (!(frame.blob instanceof Blob) || !Number.isFinite(frame.atMs) || frame.atMs < 0)
        throw Error('Invalid camera frame.');
      return this.transaction(['media', 'frames'], (s) => {
        const req = s.media.get([this.uid, id]);
        req.onsuccess = () => {
          const row = req.result;
          if (!row || row.state !== 'capturing') return;
          s.frames.add({ ...frame, ownerUid: this.uid, mediaId: id, index: row.frameCount });
          s.media.put({
            ...row,
            frameCount: row.frameCount + 1,
            bytes: row.bytes + frame.blob.size,
            durationMs: Math.max(row.durationMs || 0, frame.atMs),
          });
        };
      });
    }
    async remove(id) {
      return this.transaction(['media', 'frames'], (s) => {
        s.media.delete([this.uid, id]);
        const req = s.frames.index('media').openCursor(root.IDBKeyRange.only([this.uid, id]));
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      });
    }
    async recover() {
      for (const row of await this.list())
        if (row.state === 'capturing') await this.patch(row.id, { state: 'interrupted' });
    }
  }
  const api = { Store, TARGET, windowFrames, explainWords, splitMJPEG };
  root.SynapVisualStore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
