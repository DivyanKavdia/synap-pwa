/* Timestamped JPEG playback. The separately stored soundtrack is the clock when present. */
(function (root) {
  'use strict';
  const timeLabel = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  };
  function frameAt(frames, ms) {
    let low = 0,
      high = frames.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (frames[middle].atMs <= ms) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }
  class Player {
    constructor({
      frames,
      durationMs,
      change,
      now = () => performance.now(),
      schedule = (fn) => setTimeout(fn, 30),
      cancel = (timer) => clearTimeout(timer),
    }) {
      this.frames = frames;
      this.durationMs = Math.max(durationMs || 0, frames.at(-1)?.atMs || 0, 1);
      this.change = change;
      this.now = now;
      this.schedule = schedule;
      this.cancel = cancel;
      this.timeMs = 0;
      this.playing = false;
      this.rate = 1;
      this.audio = null;
      this.audioTail = false;
      this.pendingSeek = null;
      this.timer = null;
      this.disposed = false;
      this.emit();
    }
    get duration() {
      return Math.max(
        this.durationMs,
        Number.isFinite(this.audio?.duration) ? this.audio.duration * 1000 : 0,
      );
    }
    position() {
      if (!this.playing) return this.timeMs;
      if (this.audio && !this.audioTail)
        return Math.min(this.duration, this.audio.currentTime * 1000);
      return Math.min(this.duration, this.anchorTime + (this.now() - this.anchorClock) * this.rate);
    }
    emit() {
      if (this.disposed) return;
      this.change({
        timeMs: this.position(),
        durationMs: this.duration,
        index: frameAt(this.frames, this.position()),
        playing: this.playing,
      });
    }
    tick() {
      this.cancel(this.timer);
      if (!this.playing || this.disposed) return;
      this.timeMs = this.position();
      if (this.timeMs >= this.duration) {
        this.pause();
        return;
      }
      this.emit();
      this.timer = this.schedule(() => this.tick());
    }
    seek(ms) {
      this.pause();
      this.timeMs = Math.max(0, Math.min(this.duration, Number(ms) || 0));
      this.anchorTime = this.timeMs;
      this.anchorClock = this.now();
      if (this.audio) {
        this.audioTail =
          Number.isFinite(this.audio.duration) && this.timeMs >= this.audio.duration * 1000;
        this.pendingSeek = Math.min(this.timeMs / 1000, this.audio.duration || Infinity);
        this.audio.currentTime = this.pendingSeek;
      }
      this.emit();
    }
    async play() {
      if (this.disposed || !this.frames.length) return;
      if (this.position() >= this.duration) this.seek(0);
      this.anchorTime = this.timeMs;
      this.anchorClock = this.now();
      this.playing = true;
      this.tick();
      if (this.audio && this.timeMs < (this.audio.duration || Infinity) * 1000) {
        try {
          await this.audio.play();
        } catch (error) {
          this.pause();
          throw error;
        }
        if (this.disposed || !this.playing) this.audio?.pause();
      }
    }
    pause() {
      this.timeMs = this.position();
      this.playing = false;
      this.cancel(this.timer);
      this.timer = null;
      this.audio?.pause();
      this.emit();
    }
    setRate(rate) {
      this.timeMs = this.position();
      this.anchorTime = this.timeMs;
      this.anchorClock = this.now();
      this.rate = Number(rate) || 1;
      if (this.audio) this.audio.playbackRate = this.rate;
      this.emit();
    }
    setAudio(audio) {
      this.pause();
      if (this.audio)
        for (const [name, fn] of Object.entries(this.listeners))
          this.audio.removeEventListener(name, fn);
      this.audio = audio;
      this.audioTail = false;
      this.pendingSeek = null;
      if (!audio) {
        this.timeMs = Math.min(this.timeMs, this.duration);
        this.emit();
        return;
      }
      this.listeners = {
        play: () => {
          if (this.disposed) return;
          this.audioTail = false;
          this.timeMs = audio.currentTime * 1000;
          this.anchorTime = this.timeMs;
          this.anchorClock = this.now();
          this.playing = true;
          this.tick();
        },
        pause: () => {
          if (!audio.ended && !this.audioTail && audio.paused) this.pause();
        },
        seeked: () => {
          if (this.pendingSeek !== null && Math.abs(audio.currentTime - this.pendingSeek) < 0.05) {
            this.pendingSeek = null;
            this.emit();
            return;
          }
          this.pendingSeek = null;
          this.audioTail = Number.isFinite(audio.duration) && audio.currentTime >= audio.duration;
          this.timeMs = audio.currentTime * 1000;
          this.anchorTime = this.timeMs;
          this.anchorClock = this.now();
          this.emit();
        },
        ended: () => {
          if (!this.audioTail) {
            this.timeMs = audio.currentTime * 1000;
            this.anchorTime = this.timeMs;
            this.anchorClock = this.now();
            this.audioTail = true;
          }
          this.tick();
        },
        loadedmetadata: () => this.emit(),
        ratechange: () => {
          this.timeMs = this.position();
          this.rate = audio.playbackRate;
          this.anchorTime = this.timeMs;
          this.anchorClock = this.now();
          this.emit();
        },
      };
      audio.playbackRate = this.rate;
      for (const [name, fn] of Object.entries(this.listeners)) audio.addEventListener(name, fn);
      this.seek(this.timeMs);
    }
    dispose() {
      this.pause();
      this.setAudio(null);
      this.disposed = true;
    }
  }
  root.SynapChakshuPlayer = { Player, frameAt, timeLabel };
  if (typeof module !== 'undefined') module.exports = root.SynapChakshuPlayer;
})(globalThis);
