// =============================================================================
// music.js
// · Music: banda sonora procedural original de estética synthwave/lofi
//   espacial: progresión melancólica i–VI–III–iv en Re menor (72 BPM), pads
//   analógicos desafinados, bajo sub, arpegios dispersos con eco de cinta y
//   textura de vinilo. La intensidad (peligro) abre el filtro y densifica los
//   arpegios; al descubrir el Laboratorio B-3 suena un motivo de campana.
//   Estática de radio esporádica con reverberación espacial.
// · SoundScene: fuentes posicionales (servidores, reactor, arcos, vapor,
//   sirenas, viento de despresurización) con OCLUSIÓN ACÚSTICA: si un muro o
//   una compuerta cerrada corta el segmento oyente→fuente, un paso-bajo cae a
//   ~380 Hz y el volumen se amortigua.
// =============================================================================

const BPM = 72, SIXTEENTH = 60 / BPM / 4;
const CHORDS = [
  [146.83, 174.61, 220.0, 261.63, 329.63], // Rem9
  [116.54, 146.83, 174.61, 220.0],         // Sib maj7
  [174.61, 220.0, 261.63, 329.63],         // Fa maj7
  [98.0, 116.54, 146.83, 174.61],          // Solm7
];
const ARP = [0, 2, 1, 3, 2, 4, 3, 1];

export class Music {
  constructor(synth) {
    this.synth = synth;
    this.intensity = 0;
    this.target = 0;
    this.started = false;
  }

  start() {
    const s = this.synth, c = s.ctx;
    if (!c || this.started) return;
    this.started = true;
    this.out = c.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(s.master);
    const wet = c.createGain();
    wet.gain.value = 0.35;
    this.out.connect(wet).connect(s.reverb);
    // Eco de cinta (corchea con puntillo) con paso-bajo en la realimentación.
    this.delay = c.createDelay(2);
    this.delay.delayTime.value = SIXTEENTH * 3;
    const fb = c.createGain(), lp = c.createBiquadFilter();
    fb.gain.value = 0.38;
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    this.delay.connect(lp).connect(fb).connect(this.delay);
    this.delay.connect(this.out);
    this.step = 0;
    this.next = c.currentTime + 0.3;
    this._timer = setInterval(() => this._tick(), 60);
    this._static = setTimeout(() => this._radio(), 40000);
  }

  setIntensity(v) { this.target = Math.max(0, Math.min(1, v)); }

  // Motivo de descubrimiento (Laboratorio B-3): arpegio de campana ascendente.
  discover() {
    const c = this.synth.ctx;
    if (!c || !this.out) return;
    const t = c.currentTime + 0.05;
    [293.66, 349.23, 440, 523.25, 659.25, 880].forEach((f, i) => this._bell(f, t + i * 0.32, 0.05));
  }

  _tick() {
    const c = this.synth.ctx;
    this.intensity += (this.target - this.intensity) * 0.08;
    while (this.next < c.currentTime + 0.25) {
      this._schedule(this.step, this.next);
      this.step++;
      this.next += SIXTEENTH;
    }
  }

  _schedule(i, t) {
    const chord = CHORDS[Math.floor(i / 32) % CHORDS.length], I = this.intensity;
    if (i % 32 === 0) {
      this._pad(chord, t, SIXTEENTH * 32);
      this._bass(chord[0] / 2, t, SIXTEENTH * 30);
    }
    if (i % 2 === 0 && Math.random() < 0.16 + 0.5 * I) {
      const n = chord[ARP[(i / 2) % ARP.length] % chord.length] * (Math.random() < 0.3 ? 4 : 2);
      this._pluck(n, t, 0.018 + 0.012 * I);
    }
    if (I > 0.45 && i % 2 === 0) this._pluck(chord[0] / 2, t, 0.02 * I, 0.12, 'square', 600);
    if (Math.random() < 0.05) this._crackle(t);
  }

  _env(g, t, a, peak, hold, rel) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  }

  _pad(freqs, t, dur) {
    const c = this.synth.ctx, lp = c.createBiquadFilter(), g = c.createGain();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420 + 900 * this.intensity, t);
    lp.frequency.linearRampToValueAtTime(700 + 1200 * this.intensity, t + dur * 0.5);
    lp.Q.value = 2;
    this._env(g, t, 2.2, 0.05, dur - 3.5, 2.8);
    lp.connect(g).connect(this.out);
    for (const f of freqs) for (const det of [-7, 6]) {
      const o = c.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      const v = c.createGain(); v.gain.value = 0.11;
      o.connect(v).connect(lp);
      o.start(t); o.stop(t + dur + 0.5);
    }
  }

  _bass(f, t, dur) {
    const c = this.synth.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    this._env(g, t, 0.6, 0.11, dur - 2.2, 1.6);
    o.connect(g).connect(this.out);
    o.start(t); o.stop(t + dur + 0.2);
  }

  _pluck(f, t, peak, dec = 0.42, type = 'triangle', cut = 1900) {
    const c = this.synth.ctx, o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
    o.type = type; o.frequency.value = f;
    lp.type = 'lowpass'; lp.frequency.value = cut + 1500 * this.intensity;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
    o.connect(lp).connect(g);
    g.connect(this.out);
    g.connect(this.delay);
    o.start(t); o.stop(t + dec + 0.05);
  }

  _bell(f, t, peak) {
    const c = this.synth.ctx, car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), g = c.createGain();
    car.frequency.value = f; mod.frequency.value = f * 3.5;
    mg.gain.setValueAtTime(f * 1.4, t);
    mg.gain.exponentialRampToValueAtTime(1, t + 1.6);
    mod.connect(mg).connect(car.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    car.connect(g);
    g.connect(this.out); g.connect(this.delay);
    car.start(t); mod.start(t); car.stop(t + 2.5); mod.stop(t + 2.5);
  }

  _crackle(t) {
    const s = this.synth, c = s.ctx, n = s._noise(), hp = c.createBiquadFilter(), g = c.createGain();
    hp.type = 'highpass'; hp.frequency.value = 3000;
    g.gain.setValueAtTime(0.012 + Math.random() * 0.01, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.01);
    n.connect(hp).connect(g).connect(this.out);
    n.start(t, Math.random()); n.stop(t + 0.02);
  }

  // Transmisión de radio: pitido de apertura, chasquidos de estática SUELTOS
  // (impulsos de pocos ms, nunca un siseo continuo) y pitido de cierre del
  // squelch. Esporádica y muy baja.
  _radio() {
    const s = this.synth, c = s.ctx, t = c.currentTime + 0.05;
    const bus = c.createGain(), bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 0.7;
    bus.gain.value = 0.5;
    bp.connect(bus);
    s._out(bus, 0.6, 1.1);
    const beep = (at, f) => {
      const o = s._osc('sine', f), g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.02, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      o.connect(g).connect(bp);
      o.start(at); o.stop(at + 0.1);
    };
    beep(t, 1850);
    for (let k = 0; k < 14; k++) {
      const at = t + 0.12 + Math.random() * 1.3, n = s._noise(), g = c.createGain();
      g.gain.setValueAtTime(0.012 + Math.random() * 0.012, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.004 + Math.random() * 0.006);
      n.connect(g).connect(bp);
      n.start(at, Math.random() * 1.5); n.stop(at + 0.015);
    }
    beep(t + 1.5, 1400);
    this._static = setTimeout(() => this._radio(), 45000 + Math.random() * 45000);
  }
}

// -----------------------------------------------------------------------------
// Escena sonora posicional con oclusión.
// -----------------------------------------------------------------------------
const KINDS = {
  server: { vol: 0.09, ref: 5, act: 1 },
  reactor: { vol: 0.14, ref: 8, act: 1 },
  arc: { vol: 0.16, ref: 2.5, act: 0 },
  steam: { vol: 0.08, ref: 1.8, act: 0 },
  siren: { vol: 0.1, ref: 9, act: 0 },
  wind: { vol: 0.06, ref: 3, act: 1 },
};

export class SoundScene {
  constructor(synth, physics) {
    this.synth = synth;
    this.physics = physics;
    this.sources = [];
    this.acc = 0;
    this.started = false;
    this.listener = { x: 0, y: 1.6, z: 0 };
  }

  // Efecto puntual posicional del sintetizador (synth[name](k, muffled)):
  // atenuación cuadrática con la distancia y paso-bajo si hay oclusión.
  emit(name, pos, ref = 6) {
    const L = this.listener, d = Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z);
    const k = 1 / (1 + (d / ref) * (d / ref));
    if (k < 0.08) return;
    const muffled = d > 0.5 && !this.physics.clear(L.x, L.y, L.z, pos.x, pos.y, pos.z);
    this.synth[name](k, muffled);
  }

  add(pos, kind) {
    const k = KINDS[kind];
    const s = { pos, kind, vol: k.vol, ref: k.ref, activity: k.act, gain: null, filter: null };
    this.sources.push(s);
    if (this.started) this._build(s);
    return s;
  }

  setActivity(s, v) { s.activity = v; }
  setKindActivity(kind, v) { for (const s of this.sources) if (s.kind === kind) s.activity = v; }

  start() {
    if (!this.synth.ctx || this.started) return;
    this.started = true;
    for (const s of this.sources) this._build(s);
  }

  _build(s) {
    const sy = this.synth, c = sy.ctx;
    const f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.frequency.value = 9000;
    g.gain.value = 0;
    f.connect(g);
    sy._out(g, 1, 0.35);
    const src = [];
    const noise = (type, freq, q, gain) => {
      const n = sy._noise(true), b = c.createBiquadFilter(), v = c.createGain();
      b.type = type; b.frequency.value = freq; b.Q.value = q; v.gain.value = gain;
      n.connect(b).connect(v).connect(f);
      src.push(n);
      return v;
    };
    const osc = (type, freq, gain) => {
      const o = sy._osc(type, freq), v = c.createGain();
      v.gain.value = gain;
      o.connect(v).connect(f);
      src.push(o);
      return o;
    };
    switch (s.kind) {
      case 'server': osc('sawtooth', 120, 0.25); osc('sine', 240, 0.2); noise('bandpass', 900, 0.8, 0.6); break;
      case 'reactor': osc('sine', 45, 0.9); osc('sawtooth', 90, 0.1); noise('lowpass', 160, 0.7, 1.2); break;
      case 'arc': {
        const v = noise('highpass', 2500, 0.7, 1.4);
        const lfo = sy._osc('square', 23), lg = c.createGain();
        lg.gain.value = 1.2;
        lfo.connect(lg).connect(v.gain);
        src.push(lfo);
        osc('sawtooth', 60, 0.25);
        break;
      }
      case 'steam': noise('highpass', 1800, 0.5, 1.0); break;
      case 'siren': {
        const o = osc('sawtooth', 700, 0.5);
        const lfo = sy._osc('square', 0.9), lg = c.createGain();
        lg.gain.value = 160;
        lfo.connect(lg).connect(o.frequency);
        src.push(lfo);
        break;
      }
      case 'wind': {
        const v = noise('lowpass', 300, 0.9, 1.2);
        const lfo = sy._osc('sine', 0.11), lg = c.createGain();
        lg.gain.value = 0.15;
        lfo.connect(lg).connect(v.gain);
        src.push(lfo);
        break;
      }
    }
    src.forEach((n) => n.start());
    s.gain = g;
    s.filter = f;
  }

  update(dt, listener) {
    this.listener.x = listener.x; this.listener.y = listener.y; this.listener.z = listener.z;
    if (!this.started) return;
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;
    const c = this.synth.ctx, t = c.currentTime;
    for (const s of this.sources) {
      if (!s.gain) continue;
      const dx = s.pos.x - listener.x, dy = s.pos.y - listener.y, dz = s.pos.z - listener.z;
      const d = Math.hypot(dx, dy, dz);
      let vol = (s.vol * s.activity) / (1 + (d / s.ref) * (d / s.ref));
      let cut = 9000;
      if (vol > 0.0005 && d > 0.5 && !this.physics.clear(listener.x, listener.y, listener.z, s.pos.x, s.pos.y, s.pos.z)) {
        vol *= 0.4;
        cut = 380;
      }
      s.gain.gain.setTargetAtTime(vol, t, 0.12);
      s.filter.frequency.setTargetAtTime(cut, t, 0.15);
    }
  }
}
