// Web Audio synthesis: a music-box comb, a soft plucked keyboard, and a bowed string.
// Everything is synthesized — no samples, so the repo stays small.

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.8;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 20;
    this.limiter.ratio.value = 6;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.2;

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.75;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.32;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.8, 2.2);

    this.bus = ctx.createGain();
    this.bus.connect(this.dry);
    this.bus.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.dry.connect(this.limiter);
    this.wet.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);
    return ctx;
  }

  resume() {
    this.ensure();
    if (this.ctx.state !== "running") return this.ctx.resume();
    return Promise.resolve();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // early reflections slightly denser, then exponential tail
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < rate * 0.05 ? 0.6 : 1);
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------- instruments

  /** Music-box comb tooth: bright metallic ping with a long pure tail. */
  musicBox(time, midi, velocity = 0.8, duration = 0) {
    const ctx = this.ctx;
    const f = midiToHz(midi);
    const out = ctx.createGain();
    out.gain.value = velocity * 0.55;
    out.connect(this.bus);

    // higher notes ring shorter, like real teeth
    const tail = Math.max(0.6, 2.6 - (midi - 48) * 0.03);
    const partials = [
      [1.0, 1.0, tail],
      [2.0, 0.22, tail * 0.35],
      [2.76, 0.12, 0.18],   // inharmonic bar modes give the "tink"
      [5.4, 0.07, 0.09],
      [8.9, 0.03, 0.05],
    ];
    for (const [ratio, amp, dec] of partials) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(amp, time + 0.002);
      g.gain.exponentialRampToValueAtTime(amp * 0.001, time + dec);
      o.connect(g).connect(out);
      o.start(time);
      o.stop(time + dec + 0.05);
    }
    // the pin's click
    const click = ctx.createBufferSource();
    click.buffer = this.noiseBuffer();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.25, time);
    cg.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
    click.connect(hp).connect(cg).connect(out);
    click.start(time);
    click.stop(time + 0.03);
  }

  /** Soft plucked/struck keyboard tone. */
  pluck(time, midi, velocity = 0.8, duration = 0.5) {
    const ctx = this.ctx;
    const f = midiToHz(midi);
    const out = ctx.createGain();
    out.gain.value = velocity * 0.4;
    out.connect(this.bus);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(Math.min(9000, f * 9), time);
    lp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 1.8), time + 0.35);
    lp.Q.value = 0.4;
    lp.connect(out);
    const hold = Math.max(0.25, Math.min(duration, 3.5));
    const specs = [["triangle", 1.0, 0], ["sine", 0.5, 0], ["sine", 0.25, 12], ["sawtooth", 0.08, 0.1]];
    for (const [type, amp, detuneCents] of specs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detuneCents;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(amp, time + 0.006);
      g.gain.exponentialRampToValueAtTime(amp * 0.35, time + 0.25);
      g.gain.exponentialRampToValueAtTime(amp * 0.12, time + hold);
      g.gain.exponentialRampToValueAtTime(0.0005, time + hold + 0.5);
      o.connect(g).connect(lp);
      o.start(time);
      o.stop(time + hold + 0.6);
    }
  }

  /** Bowed string / sustained voice-like tone. */
  bowed(time, midi, velocity = 0.8, duration = 0.5) {
    const ctx = this.ctx;
    const f = midiToHz(midi);
    const out = ctx.createGain();
    out.gain.value = velocity * 0.22;
    out.connect(this.bus);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.min(6000, f * 5 + 600);
    lp.Q.value = 0.7;
    lp.connect(out);
    const dur = Math.max(0.15, duration);
    const attack = Math.min(0.09, dur * 0.3);
    const release = 0.18;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibGain = ctx.createGain();
    vibGain.gain.setValueAtTime(0, time);
    vibGain.gain.linearRampToValueAtTime(f * 0.004, time + 0.4);
    vib.connect(vibGain);
    for (const detune of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.detune.value = detune;
      vibGain.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(1, time + attack);
      g.gain.setValueAtTime(1, time + dur - Math.min(0.05, dur * 0.2));
      g.gain.linearRampToValueAtTime(0, time + dur + release);
      o.connect(g).connect(lp);
      o.start(time);
      o.stop(time + dur + release + 0.02);
    }
    vib.start(time);
    vib.stop(time + dur + release + 0.02);
  }

  noiseBuffer() {
    if (this._noise) return this._noise;
    const len = this.ctx.sampleRate * 0.05;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }
}

/**
 * Transport: owns playback time (anchored to AudioContext.currentTime) and
 * schedules note events a little ahead so visuals and audio stay locked.
 */
export class Transport {
  constructor(audio) {
    this.audio = audio;
    this.notes = [];      // [time, dur, midi, staff, ...] sorted by time
    this.voice = () => null;  // (note) => (time, midi, vel, dur) => void
    this.rate = 1;
    this.playing = false;
    this.position = 0;    // seconds in piece time
    this._anchorCtx = 0;  // ctx time when position was anchored
    this._anchorPos = 0;
    this._next = 0;       // next note index to schedule
    this.lookahead = 0.12;
    this.duration = 0;
    this.onEnd = null;
    this.onNote = null;
  }

  load(notes, duration) {
    this.stop();
    this.notes = notes;
    this.duration = duration;
    this.position = 0;
    this._next = 0;
  }

  get time() {
    if (!this.playing) return this.position;
    return this._anchorPos + (this.audio.ctx.currentTime - this._anchorCtx) * this.rate;
  }

  async play() {
    if (this.playing) return;
    await this.audio.resume();
    if (this.position >= this.duration) this.position = 0;
    this._anchorCtx = this.audio.ctx.currentTime + 0.05;
    this._anchorPos = this.position;
    this._next = this.findIndex(this.position);
    this.playing = true;
    this._timer = setInterval(() => this.tick(), 25);
  }

  pause() {
    if (!this.playing) return;
    this.position = this.time;
    this.playing = false;
    clearInterval(this._timer);
  }

  stop() {
    this.pause();
    this.position = 0;
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    this.pause();
    this.position = Math.max(0, Math.min(this.duration, seconds));
    if (wasPlaying) this.play();
  }

  setRate(r) {
    const wasPlaying = this.playing;
    this.pause();
    this.rate = r;
    if (wasPlaying) this.play();
  }

  findIndex(t) {
    let lo = 0, hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid][0] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  tick() {
    const ctx = this.audio.ctx;
    const now = this.time;
    const horizon = now + this.lookahead * this.rate + 0.03;
    while (this._next < this.notes.length && this.notes[this._next][0] <= horizon) {
      const n = this.notes[this._next++];
      const when = this._anchorCtx + (n[0] - this._anchorPos) / this.rate;
      if (when < ctx.currentTime - 0.05) continue; // we fell behind; skip
      const play = this.voice(n);
      if (play) play(Math.max(when, ctx.currentTime), n[2], 0.8, n[1] / this.rate);
    }
    if (now >= this.duration + 1.5) {
      this.pause();
      this.position = this.duration;
      if (this.onEnd) this.onEnd();
    }
  }
}
