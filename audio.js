// =============================================================================
// audio.js
// Síntesis de audio en tiempo real (Web Audio API). Cero archivos de sonido.
// =============================================================================

// -----------------------------------------------------------------------------
// Sintetizador procedural: cero archivos de audio.
// Drone (sierras desafinadas + filtro con LFO), ventilación (ruido filtrado),
// crujidos metálicos aleatorios y efectos FM; reverb por convolución con una
// respuesta impulsional generada (ruido con caída exponencial).
// -----------------------------------------------------------------------------
export class Synth {
  constructor() { this.ctx = null; }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = new AC());
    this.master = c.createGain();
    this.master.gain.value = 0.75;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4;
    this.master.connect(comp).connect(c.destination);

    this.reverb = c.createConvolver();
    this.reverb.buffer = this._impulse(3.2, 2.4);
    const wet = c.createGain();
    wet.gain.value = 0.5;
    this.reverb.connect(wet).connect(this.master);

    const len = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  _impulse(sec, decay) {
    const c = this.ctx, len = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Resonancias metálicas: ruido modulado por un par de senos (eco de casco).
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (0.7 + 0.3 * Math.sin(i * 0.031 + ch));
      }
    }
    return buf;
  }

  // Conecta un nodo a la salida seca y al envío de reverb.
  _out(node, dry = 1, wet = 0.3) {
    const g1 = this.ctx.createGain(); g1.gain.value = dry;
    const g2 = this.ctx.createGain(); g2.gain.value = wet;
    node.connect(g1).connect(this.master);
    node.connect(g2).connect(this.reverb);
  }

  _env(param, t0, attack, peak, decay) {
    param.setValueAtTime(0.0001, t0);
    param.exponentialRampToValueAtTime(peak, t0 + attack);
    param.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _noise(loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = loop;
    if (!loop) s.loopStart = 0;
    return s;
  }

  _osc(type, freq) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  startAmbience() {
    if (!this.ctx || this._ambience) return;
    this._ambience = true;
    const c = this.ctx, t = c.currentTime;
    const drone = c.createGain();
    drone.gain.setValueAtTime(0.0001, t);
    drone.gain.exponentialRampToValueAtTime(0.16, t + 5);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 170; lp.Q.value = 6;
    const lfo = this._osc('sine', 0.06), lfoGain = c.createGain();
    lfoGain.gain.value = 80;
    lfo.connect(lfoGain).connect(lp.frequency);
    [['sawtooth', 41.2], ['sawtooth', 41.55], ['sine', 55], ['triangle', 82.6]].forEach(([ty, f]) => {
      const o = this._osc(ty, f);
      o.connect(lp);
      o.start();
    });
    lfo.start();
    lp.connect(drone);
    this._out(drone, 1, 0.2);

    const air = this._noise(true), bp = c.createBiquadFilter(), ag = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.6;
    ag.gain.value = 0.012;
    air.connect(bp).connect(ag);
    this._out(ag, 1, 0.1);
    air.start();

    const rum = this._noise(true), rl = c.createBiquadFilter(), rg = c.createGain();
    rl.type = 'lowpass'; rl.frequency.value = 110;
    rg.gain.value = 0.18;
    rum.connect(rl).connect(rg);
    this._out(rg, 1, 0);
    rum.start(0, 0.7);

    const scheduleCreak = () => {
      this.creak();
      setTimeout(scheduleCreak, 5000 + Math.random() * 9000);
    };
    setTimeout(scheduleCreak, 4000);
  }

  // Gemido estructural del casco.
  creak() {
    const c = this.ctx, t = c.currentTime;
    const f0 = 70 + Math.random() * 70;
    const o = this._osc('sawtooth', f0);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.68, t + 2.2);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 9;
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(260, t + 2.2);
    const g = c.createGain();
    this._env(g.gain, t, 0.4, 0.07, 2.0);
    o.connect(bp).connect(g);
    this._out(g, 0.5, 1.2);
    o.start(t); o.stop(t + 2.6);
  }

  setThruster(level) {
    if (!this.ctx) return;
    if (!this._thr) {
      const c = this.ctx, n = this._noise(true), lp = c.createBiquadFilter(), g = c.createGain();
      lp.type = 'lowpass'; lp.frequency.value = 380;
      g.gain.value = 0;
      n.connect(lp).connect(g);
      this._out(g, 1, 0.15);
      n.start();
      this._thr = g;
    }
    this._thr.gain.setTargetAtTime(level * 0.35, this.ctx.currentTime, 0.12);
  }

  // Acople: golpe grave + clang metálico FM.
  dock() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = this._osc('sine', 75), g = c.createGain();
    o.frequency.exponentialRampToValueAtTime(28, t + 0.6);
    this._env(g.gain, t, 0.01, 0.9, 0.8);
    o.connect(g); this._out(g, 1, 0.4);
    o.start(t); o.stop(t + 1);
    this._thud(t + 0.01, 0.55, 500);
    this._thud(t + 0.14, 0.25, 350);
  }

  // Golpe sordo mecánico (cierre, enclavamiento): ruido muy corto filtrado
  // en graves. Sin tono: no "suena a sintetizador".
  _thud(t, peak, cut) {
    const c = this.ctx, n = this._noise(), lp = c.createBiquadFilter(), g = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = cut;
    this._env(g.gain, t, 0.002, peak, 0.12);
    n.connect(lp).connect(g); this._out(g, 1, 0.35);
    n.start(t, Math.random()); n.stop(t + 0.18);
  }

  _metal(t, carrier, peak, decay) {
    const c = this.ctx, bus = c.createGain();
    bus.gain.value = peak;
    this._out(bus, 0.7, 0.9);
    // Modos de una placa rígida (razones inarmónicas) con amplitud y caída propias.
    [[1, 1, 1], [2.32, 0.55, 0.7], [4.25, 0.35, 0.45], [6.63, 0.2, 0.3]].forEach(([r, a, d]) => {
      const o = this._osc('sine', carrier * r), g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(a, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay * d);
      o.connect(g).connect(bus);
      o.start(t); o.stop(t + decay * d + 0.05);
    });
    // Impacto: ráfaga de ruido de pocos milisegundos.
    const n = this._noise(), lp = c.createBiquadFilter(), ng = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 2500;
    this._env(ng.gain, t, 0.001, 0.6, 0.03);
    n.connect(lp).connect(ng).connect(bus);
    n.start(t, Math.random()); n.stop(t + 0.05);
  }

  // Escotilla: siseo de despresurización + servo + golpe de tope.
  hatch() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const n = this._noise(), hp = c.createBiquadFilter(), g = c.createGain();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(4500, t);
    hp.frequency.exponentialRampToValueAtTime(700, t + 2.4);
    this._env(g.gain, t, 0.05, 0.35, 2.4);
    n.connect(hp).connect(g); this._out(g, 1, 0.4);
    n.start(t); n.stop(t + 2.6);
    this._thud(t + 0.2, 0.3, 700);
    this._thud(t + 2.05, 0.45, 450);
  }

  holoOn() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const g = c.createGain(), lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.025, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    lp.connect(g); this._out(g, 1, 0.3);
    for (const [f, a] of [[100, 1], [200, 0.35]]) {
      const o = this._osc('sine', f), v = c.createGain();
      v.gain.value = a;
      o.connect(v).connect(lp);
      o.start(t); o.stop(t + 2.5);
    }
  }

  glitch(dur = 0.12) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const n = this._noise(), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 2500 + Math.random() * 2000; bp.Q.value = 2;
    this._env(g.gain, t, 0.005, 0.12, dur);
    n.connect(bp).connect(g); this._out(g, 1, 0.2);
    n.start(t, Math.random()); n.stop(t + dur + 0.05);
  }

  blip() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    // Clic suave de teletipo (seno grave y corto), no un pitido cuadrado agudo.
    const o = this._osc('sine', 700 + Math.random() * 80), g = c.createGain();
    this._env(g.gain, t, 0.002, 0.008, 0.02);
    o.connect(g); this._out(g, 1, 0.1);
    o.start(t); o.stop(t + 0.04);
  }

  // Pisada según el material: 'solid' = acero macizo (golpe sordo grave y un
  // único armónico seco); 'hollow' = rejilla/escalera hueca (caja resonante
  // ~150 Hz y varios modos metálicos de vibración largos).
  step(intensity = 1, surface = 'solid') {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, hollow = surface === 'hollow';
    const n = this._noise(), lp = c.createBiquadFilter(), g = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = (hollow ? 950 : 600) + Math.random() * 300;
    this._env(g.gain, t, 0.004, 0.22 * intensity, hollow ? 0.07 : 0.09);
    n.connect(lp).connect(g); this._out(g, 1, 0.25);
    n.start(t, Math.random() * 1.5); n.stop(t + 0.15);
    const o = this._osc('sine', hollow ? 145 + Math.random() * 30 : 62 + Math.random() * 12), og = c.createGain();
    this._env(og.gain, t, 0.004, (hollow ? 0.15 : 0.25) * intensity, hollow ? 0.3 : 0.12);
    o.connect(og); this._out(og, 1, hollow ? 0.5 : 0.1);
    o.start(t); o.stop(t + 0.36);
    const modes = hollow ? [1240, 1880, 2730] : [2300 + Math.random() * 500];
    for (const f of modes) {
      const r = this._noise(), rb = c.createBiquadFilter(), rg = c.createGain();
      rb.type = 'bandpass'; rb.frequency.value = f * (0.97 + Math.random() * 0.06); rb.Q.value = hollow ? 32 : 18;
      this._env(rg.gain, t, 0.002, (hollow ? 0.08 : 0.05) * intensity, hollow ? 0.5 : 0.25);
      r.connect(rb).connect(rg); this._out(rg, 1, 0.5);
      r.start(t, Math.random()); r.stop(t + 0.55);
    }
  }

  // Aterrizaje tras una caída: pisada doble reforzada.
  land(v, surface) {
    const k = Math.min(1.6, 0.6 + v * 0.18);
    this.step(k, surface);
    if (this.ctx) setTimeout(() => this.step(k * 0.6, surface), 70);
  }

  // Salida espacial de un efecto puntual: ganancia por distancia y paso-bajo
  // si hay un muro o compuerta entre la fuente y el oyente.
  _spatial(node, k, muffled, wet = 0.4) {
    const c = this.ctx, g = c.createGain();
    g.gain.value = k;
    if (muffled) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 420;
      node.connect(lp).connect(g);
    } else node.connect(g);
    this._out(g, 1, wet + (muffled ? 0.3 : 0));
  }

  // Descarga de arco eléctrico: chasquido de ruido + zumbido de red a 50 Hz.
  arcZap(k = 1, muffled = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, bus = c.createGain();
    this._spatial(bus, k, muffled, 0.5);
    // Chasquido seco (impulso muy corto, no un siseo) + zumbido eléctrico.
    const n = this._noise(), hp = c.createBiquadFilter(), g = c.createGain();
    hp.type = 'bandpass'; hp.frequency.value = 3200; hp.Q.value = 0.8;
    this._env(g.gain, t, 0.001, 0.4, 0.05);
    n.connect(hp).connect(g).connect(bus);
    n.start(t, Math.random()); n.stop(t + 0.08);
    const o = this._osc('square', 100), og = c.createGain(), ol = c.createBiquadFilter();
    ol.type = 'lowpass'; ol.frequency.value = 1400;
    this._env(og.gain, t, 0.005, 0.07, 0.5);
    o.connect(ol).connect(og).connect(bus);
    o.start(t); o.stop(t + 1.0);
  }

  // Fuga de vapor: siseo que se abre de golpe.
  steamBlast(k = 1, muffled = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, bus = c.createGain();
    this._spatial(bus, k, muffled, 0.35);
    const n = this._noise(), hp = c.createBiquadFilter(), g = c.createGain();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(5000, t);
    hp.frequency.exponentialRampToValueAtTime(1500, t + 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.05);
    g.gain.setValueAtTime(0.3, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    n.connect(hp).connect(g).connect(bus);
    n.start(t, Math.random()); n.stop(t + 1.5);
  }

  // Dron: gorjeo de detección ascendente (dos chirridos cuadrados).
  droneAlert(k = 1, muffled = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, bus = c.createGain();
    this._spatial(bus, k, muffled);
    [0, 0.11].forEach((d, i) => {
      const o = this._osc('square', 900 + i * 500), g = c.createGain();
      o.frequency.exponentialRampToValueAtTime(1600 + i * 700, t + d + 0.08);
      this._env(g.gain, t + d, 0.003, 0.06, 0.09);
      o.connect(g).connect(bus);
      o.start(t + d); o.stop(t + d + 0.12);
    });
  }

  droneHit(k = 1, muffled = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, bus = c.createGain();
    this._spatial(bus, k, muffled, 0.6);
    const n = this._noise(), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1.5;
    this._env(g.gain, t, 0.002, 0.25, 0.2);
    n.connect(bp).connect(g).connect(bus);
    n.start(t, Math.random()); n.stop(t + 0.25);
    const car = this._osc('sine', 820), mod = this._osc('sine', 1210), mg = c.createGain(), cg = c.createGain();
    mg.gain.setValueAtTime(900, t);
    mg.gain.exponentialRampToValueAtTime(10, t + 0.5);
    mod.connect(mg).connect(car.frequency);
    this._env(cg.gain, t, 0.003, 0.12, 0.5);
    car.connect(cg).connect(bus);
    car.start(t); mod.start(t); car.stop(t + 0.55); mod.stop(t + 0.55);
  }

  droneDie(k = 1, muffled = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, bus = c.createGain();
    this._spatial(bus, k, muffled, 0.7);
    const o = this._osc('sawtooth', 900), lp = c.createBiquadFilter(), g = c.createGain();
    o.frequency.exponentialRampToValueAtTime(40, t + 1.2);
    lp.type = 'lowpass'; lp.frequency.value = 1500;
    this._env(g.gain, t, 0.01, 0.1, 1.2);
    o.connect(lp).connect(g).connect(bus);
    o.start(t); o.stop(t + 1.3);
    const n = this._noise(), nl = c.createBiquadFilter(), ng = c.createGain();
    nl.type = 'lowpass'; nl.frequency.value = 900;
    this._env(ng.gain, t + 0.05, 0.005, 0.5, 0.7);
    n.connect(nl).connect(ng).connect(bus);
    n.start(t + 0.05); n.stop(t + 0.8);
  }

  droneShot(k = 1, muffled = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, bus = c.createGain();
    this._spatial(bus, k, muffled, 0.5);
    const o = this._osc('square', 2200), lp = c.createBiquadFilter(), g = c.createGain();
    o.frequency.exponentialRampToValueAtTime(260, t + 0.16);
    lp.type = 'lowpass'; lp.frequency.value = 3200;
    this._env(g.gain, t, 0.002, 0.09, 0.17);
    o.connect(lp).connect(g).connect(bus);
    o.start(t); o.stop(t + 0.2);
  }

  // Torreta fijando blanco: tres pitidos rápidos.
  turretLock(k = 1, muffled = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, bus = c.createGain();
    this._spatial(bus, k, muffled, 0.3);
    for (let i = 0; i < 3; i++) {
      const o = this._osc('square', 1760), g = c.createGain();
      this._env(g.gain, t + i * 0.09, 0.002, 0.05, 0.05);
      o.connect(g).connect(bus);
      o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.07);
    }
  }

  // Impacto recibido: golpe en el traje + crepitar del visor (o zumbido si es arco).
  hurt(kind = 'bolt') {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = this._osc('sine', 90), g = c.createGain();
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    this._env(g.gain, t, 0.003, 0.4, 0.22);
    o.connect(g); this._out(g, 1, 0.1);
    o.start(t); o.stop(t + 0.3);
    this.glitch(kind === 'arc' ? 0.25 : 0.1);
  }

  // Latido percibido dentro del casco (lo dispara el jugador a su ritmo cardiaco).
  heartbeat(strength = 1) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    [0, 0.2].forEach((d, i) => {
      const o = this._osc('sine', 52), g = c.createGain();
      this._env(g.gain, t + d, 0.01, (i ? 0.16 : 0.28) * strength, 0.22);
      o.connect(g); this._out(g, 1, 0.05);
      o.start(t + d); o.stop(t + d + 0.3);
    });
  }

  // Respiración agitada en el casco (fatiga).
  breath(strength = 1) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    // Exhalación por la boca dentro del casco: dos formantes estrechos (vocal
    // neutra) sobre ruido, ataque suave y volumen bajo.
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.018 * strength, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    this._out(g, 1, 0.02);
    const n = this._noise();
    for (const [f, q, k] of [[520, 6, 1], [1450, 8, 0.45]]) {
      const bp = c.createBiquadFilter(), v = c.createGain();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q; v.gain.value = k;
      n.connect(bp).connect(v).connect(g);
    }
    n.start(t, Math.random()); n.stop(t + 0.75);
  }

  // Aviso del traje (O₂ bajo / despresurización / punto de control).
  suitBeep(kind = 'warn') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = kind === 'save' ? [880, 1320] : [1040, 780];
    f.forEach((fr, i) => {
      const o = this._osc('sine', fr), g = this.ctx.createGain();
      this._env(g.gain, t + i * 0.13, 0.004, 0.05, 0.12);
      o.connect(g); this._out(g, 1, 0.15);
      o.start(t + i * 0.13); o.stop(t + i * 0.13 + 0.16);
    });
  }

  pickup() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [660, 880, 1320].forEach((f, i) => {
      const o = this._osc('triangle', f), g = this.ctx.createGain();
      this._env(g.gain, t + i * 0.07, 0.005, 0.09, 0.18);
      o.connect(g); this._out(g, 1, 0.4);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.25);
    });
  }

  denied() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [0, 0.16].forEach((d) => {
      const o = this._osc('square', 170), g = this.ctx.createGain(), lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      this._env(g.gain, t + d, 0.005, 0.07, 0.12);
      o.connect(lp).connect(g); this._out(g, 1, 0.2);
      o.start(t + d); o.stop(t + d + 0.15);
    });
  }

  unlock() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [520, 780].forEach((f, i) => {
      const o = this._osc('sine', f), g = this.ctx.createGain();
      this._env(g.gain, t + i * 0.1, 0.005, 0.08, 0.2);
      o.connect(g); this._out(g, 1, 0.3);
      o.start(t + i * 0.1); o.stop(t + i * 0.1 + 0.3);
    });
    setTimeout(() => this.hatch(), 250);
  }

  click() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc('square', 2400), g = this.ctx.createGain();
    this._env(g.gain, t, 0.001, 0.04, 0.02);
    o.connect(g); this._out(g, 1, 0.1);
    o.start(t); o.stop(t + 0.04);
  }

  // ------------------------------------------------------------ Alerta
  // Sirena de dos tonos (sierra filtrada con LFO cuadrado), clúster disonante
  // de tensión y latido grave. Todo cuelga de un bus que stopAlarm() apaga.
  startAlarm() {
    if (!this.ctx || this._alarm) return;
    const c = this.ctx, t = c.currentTime;
    const bus = c.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(1, t + 0.6);
    this._out(bus, 1, 0.45);
    const nodes = [];
    const siren = this._osc('sawtooth', 700), sf = c.createBiquadFilter(), sg = c.createGain();
    sf.type = 'bandpass'; sf.frequency.value = 1100; sf.Q.value = 3;
    sg.gain.value = 0.02;
    const lfo = this._osc('square', 0.9), lg = c.createGain();
    lg.gain.value = 160;
    lfo.connect(lg).connect(siren.frequency);
    siren.connect(sf).connect(sg).connect(bus);
    nodes.push(siren, lfo);
    const tl = c.createBiquadFilter(), tg = c.createGain();
    tl.type = 'lowpass'; tl.frequency.value = 800;
    tg.gain.value = 0.03;
    for (const f of [73.4, 77.8, 110, 116.5]) {
      const o = this._osc('sawtooth', f);
      o.connect(tl);
      nodes.push(o);
    }
    tl.connect(tg).connect(bus);
    nodes.forEach((n) => n.start(t));
    this._alarm = { bus, nodes };
  }

  stopAlarm() {
    if (!this._alarm) return;
    const t = this.ctx.currentTime;
    this._alarm.bus.gain.setTargetAtTime(0.0001, t, 0.3);
    this._alarm.nodes.forEach((n) => n.stop(t + 1.5));
    this._alarm = null;
  }

  // Compuerta blindada que cae de golpe.
  slam() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = this._osc('sine', 60), g = c.createGain();
    o.frequency.exponentialRampToValueAtTime(24, t + 0.7);
    this._env(g.gain, t, 0.005, 1.0, 0.9);
    o.connect(g); this._out(g, 1, 0.6);
    o.start(t); o.stop(t + 1.1);
    const n = this._noise(), lp = c.createBiquadFilter(), ng = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 1400;
    this._env(ng.gain, t, 0.003, 0.5, 0.35);
    n.connect(lp).connect(ng); this._out(ng, 1, 0.7);
    n.start(t); n.stop(t + 0.5);
    this._metal(t + 0.01, 140, 0.3, 2.8);
    this._metal(t + 0.03, 233, 0.15, 2.0);
  }

  // Puerta neumática.
  doorOpen() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const n = this._noise(), hp = c.createBiquadFilter(), g = c.createGain();
    hp.type = 'bandpass'; hp.Q.value = 0.8;
    hp.frequency.setValueAtTime(3000, t);
    hp.frequency.exponentialRampToValueAtTime(900, t + 0.9);
    this._env(g.gain, t, 0.02, 0.18, 0.9);
    n.connect(hp).connect(g); this._out(g, 1, 0.35);
    n.start(t, Math.random()); n.stop(t + 1.1);
    this._thud(t + 1.0, 0.3, 500);
  }

  // Pirateo: ráfaga de chirridos tipo módem.
  hackStart() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    for (let i = 0; i < 6; i++) {
      const o = this._osc('square', 600 + Math.random() * 1800), g = c.createGain();
      this._env(g.gain, t + i * 0.06, 0.003, 0.025, 0.05);
      o.connect(g); this._out(g, 1, 0.1);
      o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.07);
    }
  }

  hackOk() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [1500, 2000].forEach((f, i) => {
      const o = this._osc('square', f), g = this.ctx.createGain();
      this._env(g.gain, t + i * 0.05, 0.002, 0.04, 0.06);
      o.connect(g); this._out(g, 1, 0.15);
      o.start(t + i * 0.05); o.stop(t + i * 0.05 + 0.08);
    });
  }

  hackFail() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = this._osc('sawtooth', 110), g = c.createGain(), lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700;
    this._env(g.gain, t, 0.005, 0.1, 0.28);
    o.connect(lp).connect(g); this._out(g, 1, 0.2);
    o.start(t); o.stop(t + 0.32);
    this.glitch(0.1);
  }

  hackDone() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1046].forEach((f, i) => {
      const o = this._osc('triangle', f), g = this.ctx.createGain();
      this._env(g.gain, t + i * 0.08, 0.005, 0.07, 0.2);
      o.connect(g); this._out(g, 1, 0.4);
      o.start(t + i * 0.08); o.stop(t + i * 0.08 + 0.3);
    });
  }

  // Restauración de energía: barrido ascendente + zumbido eléctrico.
  powerUp() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = this._osc('sawtooth', 50), lp = c.createBiquadFilter(), g = c.createGain();
    o.frequency.exponentialRampToValueAtTime(240, t + 1.4);
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(2400, t + 1.4);
    this._env(g.gain, t, 0.2, 0.12, 1.4);
    o.connect(lp).connect(g); this._out(g, 1, 0.4);
    o.start(t); o.stop(t + 1.7);
  }

  // --------------------------------------------------------- Arma de plasma
  // Disparo: barrido FM descendente + chasquido de ruido.
  plasmaShot() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const car = this._osc('sawtooth', 1400), mod = this._osc('sine', 330), mg = c.createGain(), g = c.createGain(), lp = c.createBiquadFilter();
    car.frequency.exponentialRampToValueAtTime(140, t + 0.28);
    mg.gain.setValueAtTime(900, t);
    mg.gain.exponentialRampToValueAtTime(20, t + 0.25);
    mod.connect(mg).connect(car.frequency);
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(6000, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.3);
    this._env(g.gain, t, 0.003, 0.16, 0.3);
    car.connect(lp).connect(g); this._out(g, 1, 0.5);
    car.start(t); mod.start(t); car.stop(t + 0.35); mod.stop(t + 0.35);
    const n = this._noise(), hp = c.createBiquadFilter(), ng = c.createGain();
    hp.type = 'highpass'; hp.frequency.value = 2500;
    this._env(ng.gain, t, 0.002, 0.12, 0.08);
    n.connect(hp).connect(ng); this._out(ng, 1, 0.3);
    n.start(t, Math.random()); n.stop(t + 0.12);
  }

  // Impacto: crepitar eléctrico + golpe sordo, atenuado por la distancia.
  plasmaImpact(dist = 5) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, k = 1 / (1 + dist * 0.15);
    const n = this._noise(), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 1.2;
    this._env(g.gain, t, 0.002, 0.3 * k, 0.35);
    n.connect(bp).connect(g); this._out(g, 1, 0.8);
    n.start(t, Math.random()); n.stop(t + 0.4);
    const o = this._osc('sine', 110), og = c.createGain();
    o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    this._env(og.gain, t, 0.003, 0.35 * k, 0.22);
    o.connect(og); this._out(og, 1, 0.5);
    o.start(t); o.stop(t + 0.3);
  }

  plasmaEmpty() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc('square', 220), g = this.ctx.createGain();
    this._env(g.gain, t, 0.002, 0.05, 0.05);
    o.connect(g); this._out(g, 1, 0.1);
    o.start(t); o.stop(t + 0.08);
  }

  // Cambio de objeto: roce de tejido del traje + clic metálico.
  equip() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const n = this._noise(), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    this._env(g.gain, t, 0.03, 0.06, 0.18);
    n.connect(bp).connect(g); this._out(g, 1, 0.1);
    n.start(t, Math.random()); n.stop(t + 0.25);
    this._metal(t + 0.12, 1200, 0.03, 0.12);
  }
}
