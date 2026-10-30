// =============================================================================
// player.js
// Control en primera persona (Pointer Lock + WASD) sobre el mundo físico:
// cuerpo cilíndrico (círculo con franja vertical) contra colisionadores
// exactos, suelos y rampas de escalera con gravedad, pisadas según material.
// Biometría: pulso (ECG en el HUD), resistencia y fatiga que hacen temblar la
// cámara y la puntería; salud, daño por proyectiles/arcos/vapor, O₂ según la
// presión de la zona, muerte y reanudación desde el último punto de control.
// Interacción por mirada, inventario de 5 ranuras, linterna con sombras y haz
// volumétrico, y la capa de HUD (DOM).
// =============================================================================
import * as THREE from 'three';
import { LEVEL } from './level.js';
import { STEP, BODY_LO, BODY_HI } from './physics.js';
import { FlashlightVolume } from './volumetric.js';
import { Save } from './save.js';

const EYE = 1.65;
const SVG = (body) =>
  `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

export const ITEM_INFO = {
  linterna: {
    icon: SVG('<rect x="3" y="12" width="15" height="8" rx="1"/><path d="M18 10l8-3v18l-8-3z"/><path d="M7 16h6"/>'),
    desc: 'Haz de 22 m con sombras. [F] encender / apagar.',
  },
  tarjeta: {
    icon: SVG('<rect x="4" y="8" width="24" height="16" rx="2"/><path d="M4 13h24"/><rect x="7" y="17" width="6" height="4"/>'),
    desc: 'Credencial de nivel 3. Abre el Laboratorio B-3.',
  },
  celula: {
    icon: SVG('<rect x="9" y="6" width="14" height="22" rx="2"/><path d="M13 3h6v3"/><path d="M17 11l-4 6h6l-4 6"/>'),
    desc: 'Carga al 34 %. Alimenta compuertas sin energía.',
  },
  maletin: {
    icon: SVG('<rect x="3" y="10" width="26" height="17" rx="2"/><path d="M12 10V6h8v4"/><path d="M11 14c4 3 6 6 10 9M21 14c-4 3-6 6-10 9M13 18h6M13 21h6"/>'),
    desc: 'Contención genética HELIX-ARES. NO ABRIR.',
  },
  plasma: {
    icon: SVG('<path d="M3 13h18l3-2h5v6h-5l-3-2H14l-2 7H8l1-7H3z"/><path d="M17 13v2M20 13v2"/>'),
    desc: 'Rifle de plasma HX-9. [CLIC] disparar · carga regenerativa.',
  },
};

// Forma de onda de ECG (P, QRS, T) en función de la fase del latido.
const g = (p, c, w) => Math.exp(-((p - c) / w) * ((p - c) / w));
const ecgWave = (p) => 0.12 * g(p, 0.12, 0.03) - 0.15 * g(p, 0.235, 0.008) + g(p, 0.26, 0.011) - 0.28 * g(p, 0.285, 0.01) + 0.24 * g(p, 0.5, 0.05);

// -----------------------------------------------------------------------------
// HUD: único punto de contacto con el DOM.
// -----------------------------------------------------------------------------
export class Hud {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.root = $('hud');
    this.prompt = $('prompt');
    this.reticle = $('reticle');
    this.toasts = $('toasts');
    this.objective = $('objective');
    this.caption = $('caption');
    this.fadeEl = $('fade');
    this.bars = $('cinebars');
    this.itemLabel = $('item-label');
    this.o2El = $('o2');
    this.o2Bar = $('o2-bar');
    this.locEl = $('location');
    this.pauseEl = $('pause');
    this.endEl = $('end');
    this.alertEl = $('alert');
    this.hackEl = $('hack');
    this.hackTitle = $('hack-title');
    this.hackCursor = $('hack-cursor');
    this.hackZone = $('hack-zone');
    this.hackPips = $('hack-pips');
    this.weaponEl = $('weapon');
    this.weaponBar = $('weapon-bar');
    this.weaponPct = $('weapon-pct');
    this.hpBar = $('hp-bar');
    this.hpEl = $('hp');
    this.stBar = $('st-bar');
    this.bpmEl = $('bpm');
    this.ecg = $('ecg').getContext('2d');
    this.vacEl = $('vac');
    this.logEl = $('log');
    this.logBody = $('log-body');
    this.xorEl = $('xor');
    this.deathEl = $('death');
    this.warnEl = $('sys-warn');
    this._weapon = -1;
    this._bio = { hp: -1, st: -1, bpm: -1, x: 0, y: 17, phase: 0 };
    this.slots = [];
    const inv = $('inventory');
    for (let i = 0; i < 5; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.innerHTML = `<span class="key">${i + 1}</span><div class="icon"></div><span class="name"></span>`;
      inv.appendChild(s);
      this.slots.push(s);
    }
    // Panel XOR: celdas de bits creadas una vez.
    const bits = (id) => {
      const row = $(id), cells = [];
      for (let i = 0; i < 8; i++) { const c = document.createElement('i'); row.appendChild(c); cells.push(c); }
      return cells;
    };
    this.xorReg = bits('xor-reg');
    this.xorTarget = bits('xor-target');
    this.xorKeys = [];
    const keys = $('xor-keys');
    for (let k = 0; k < 4; k++) {
      const row = document.createElement('div');
      row.className = 'xkey';
      row.innerHTML = `<b>${k + 1}</b><span class="bits"></span>`;
      const cells = [];
      for (let i = 0; i < 8; i++) { const c = document.createElement('i'); row.lastChild.appendChild(c); cells.push(c); }
      keys.appendChild(row);
      this.xorKeys.push({ row, cells });
    }
    this._prompt = null;
    this._o2 = -1;
    this._pips = '';
  }

  show(v) { this.root.classList.toggle('hidden', !v); }
  cinematic(v) { this.bars.classList.toggle('on', v); }
  setFade(v) { this.fadeEl.style.opacity = v.toFixed(3); }
  setLocation(text) { this.locEl.textContent = text; }
  setCaption(html) { this.caption.innerHTML = html; this.caption.classList.toggle('on', !!html); }
  setAlert(v) { this.alertEl.classList.toggle('on', v); this.root.classList.toggle('alert', v); }
  setVacuum(v) { this.vacEl.classList.toggle('on', v); }
  warn(text) { this.warnEl.textContent = text; this.warnEl.classList.toggle('on', !!text); }

  setObjective(text) {
    this.objective.innerHTML = `<span class="tag">OBJETIVO</span>${text}`;
    this.objective.classList.remove('pulse');
    void this.objective.offsetWidth;
    this.objective.classList.add('pulse');
  }

  setPrompt(text, warn = false) {
    const key = text ? text + warn : null;
    if (key === this._prompt) return;
    this._prompt = key;
    this.prompt.textContent = text || '';
    this.prompt.classList.toggle('on', !!text);
    this.prompt.classList.toggle('warn', warn);
    this.reticle.classList.toggle('active', !!text);
  }

  toast(text, kind = '') {
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    d.textContent = text;
    this.toasts.appendChild(d);
    setTimeout(() => d.classList.add('out'), 3600);
    setTimeout(() => d.remove(), 4200);
  }

  renderInventory(slots, selected) {
    for (let i = 0; i < 5; i++) {
      const el = this.slots[i], item = slots[i];
      el.classList.toggle('filled', !!item);
      el.classList.toggle('active', i === selected);
      el.querySelector('.icon').innerHTML = item ? ITEM_INFO[item.id].icon : '';
      el.querySelector('.name').textContent = item ? item.name.split(' ')[0] : '';
    }
    const it = slots[selected];
    this.itemLabel.innerHTML = it ? `<b>${it.name}</b><span>${ITEM_INFO[it.id].desc}</span>` : '';
    this.itemLabel.classList.toggle('on', !!it);
  }

  setO2(v) {
    const r = Math.round(v);
    if (r === this._o2) return;
    this._o2 = r;
    this.o2El.textContent = `${r}%`;
    this.o2Bar.style.width = `${r}%`;
    this.o2Bar.classList.toggle('low', r < 25);
  }

  // Biometría: barras de salud/resistencia y monitor ECG que barre de
  // izquierda a derecha (sólo se dibuja el tramo nuevo de cada fotograma).
  setBio(dt, bpm, hp, stamina) {
    const B = this._bio, h = Math.round(hp), st = Math.round(stamina * 100), b = Math.round(bpm);
    if (h !== B.hp) { B.hp = h; this.hpBar.style.width = `${Math.max(0, h)}%`; this.hpEl.textContent = Math.max(0, h); this.hpBar.classList.toggle('low', h < 30); }
    if (st !== B.st) { B.st = st; this.stBar.style.width = `${st}%`; }
    if (b !== B.bpm) { B.bpm = b; this.bpmEl.textContent = b; }
    const c = this.ecg, W = c.canvas.width, H = c.canvas.height;
    B.phase += dt * bpm / 60;
    const nx = B.x + dt * 55;
    const ny = H * 0.62 - ecgWave(B.phase % 1) * H * 0.5;
    c.clearRect(Math.floor(nx) + 1, 0, 8, H);
    c.strokeStyle = hp < 30 ? '#ff5040' : '#5aff8a';
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(B.x, B.y);
    c.lineTo(nx, ny);
    c.stroke();
    B.x = nx; B.y = ny;
    if (B.x > W) { B.x = 0; c.clearRect(0, 0, 9, H); }
  }

  // Indicador de carga del arma (sólo toca el DOM cuando cambia el valor).
  setWeapon(visible, charge) {
    const v = visible ? Math.round(charge * 100) : -1;
    if (v === this._weapon) return;
    this._weapon = v;
    this.weaponEl.classList.toggle('on', visible);
    if (visible) {
      this.weaponBar.style.width = `${v}%`;
      this.weaponPct.textContent = `${v}%`;
      this.weaponEl.classList.toggle('low', v < 16);
    }
  }

  showHack(v, title = '') {
    this.hackEl.classList.toggle('on', v);
    if (v) { this.hackTitle.textContent = title; this._pips = ''; }
  }
  setHack(cursor, center, width, done, rounds) {
    this.hackCursor.style.left = `${(cursor * 100).toFixed(2)}%`;
    this.hackZone.style.left = `${((center - width / 2) * 100).toFixed(2)}%`;
    this.hackZone.style.width = `${(width * 100).toFixed(2)}%`;
    const pips = '▮'.repeat(done) + '▯'.repeat(rounds - done);
    if (pips !== this._pips) { this._pips = pips; this.hackPips.textContent = pips; }
  }
  hackFlash(xor = false) {
    const el = xor ? this.xorEl : this.hackEl;
    el.classList.remove('fail');
    void el.offsetWidth;
    el.classList.add('fail');
  }

  // Descifrado XOR.
  showXor(v, title = '') {
    this.xorEl.classList.toggle('on', v);
    if (v) this.$('xor-title').textContent = title;
  }
  setXor(P) {
    const paint = (cells, byte) => { for (let i = 0; i < 8; i++) cells[i].className = (byte >> (7 - i)) & 1 ? 'on' : ''; };
    paint(this.xorReg, P.reg);
    paint(this.xorTarget, P.target);
    for (let k = 0; k < 4; k++) {
      paint(this.xorKeys[k].cells, P.keys[k]);
      this.xorKeys[k].row.classList.toggle('used', P.used[k]);
    }
    this.$('xor-reg').classList.toggle('match', P.reg === P.target);
    this.$('xor-pips').textContent = '▮'.repeat(P.done) + '▯'.repeat(P.rounds - P.done);
  }
  setXorTime(f) {
    const bar = this.$('xor-time');
    bar.style.width = `${(f * 100).toFixed(1)}%`;
    bar.classList.toggle('low', f < 0.3);
  }

  // Bitácoras.
  showLog(log) {
    this.logEl.classList.toggle('on', !!log);
    if (!log) return;
    this.$('log-title').textContent = log.title;
    this.$('log-meta').textContent = log.meta;
    this.logBody.innerHTML = '';
    for (const p of log.body) {
      const el = document.createElement('p');
      el.textContent = p;
      this.logBody.appendChild(el);
    }
    this.logBody.scrollTop = 0;
  }
  scrollLog(dy) { this.logBody.scrollTop += dy; }

  showDeath(msg, ready = false, hasSave = false) {
    this.deathEl.classList.toggle('on', !!msg);
    if (!msg) return;
    this.$('death-msg').textContent = msg;
    const hint = this.$('death-hint');
    hint.textContent = ready ? (hasSave ? '[CLIC] o [E] — REANUDAR DESDE EL ÚLTIMO PUNTO DE CONTROL' : '[CLIC] o [E] — REINICIAR LA MISIÓN') : '';
  }

  showPause(v) { this.pauseEl.classList.toggle('on', v); }
  showEnd() { this.endEl.classList.add('on'); }
}

// -----------------------------------------------------------------------------
// Inventario de 5 ranuras
// -----------------------------------------------------------------------------
export class Inventory {
  constructor(hud) {
    this.hud = hud;
    this.slots = [null, null, null, null, null];
    this.selected = 0;
    this.render();
  }
  add(item) {
    const i = this.slots.indexOf(null);
    if (i < 0) return false;
    this.slots[i] = item;
    this.selected = i;
    this.render();
    return true;
  }
  remove(id) {
    const i = this.slots.findIndex((s) => s && s.id === id);
    if (i >= 0) { this.slots[i] = null; this.render(); }
  }
  has(id) { return this.slots.some((s) => s && s.id === id); }
  select(i) {
    this.selected = (i + 5) % 5;
    this.render();
  }
  render() { this.hud.renderInventory(this.slots, this.selected); }
}

const DEATH_MSG = {
  bolt: 'ABATIDO POR LA SEGURIDAD AUTOMÁTICA',
  arc: 'DESCARGA ELÉCTRICA LETAL',
  steam: 'QUEMADURAS POR VAPOR A PRESIÓN',
  o2: 'ASFIXIA — RESERVA DE O₂ AGOTADA',
  fall: 'CAÍDA MORTAL',
};

// -----------------------------------------------------------------------------
// Jugador
// -----------------------------------------------------------------------------
export class Player {
  constructor(engine, ship, mission, synth, hud, physics) {
    this.engine = engine;
    this.rig = engine.rig;
    this.ship = ship;
    this.mission = mission;
    this.synth = synth;
    this.hud = hud;
    this.physics = physics;
    this.inventory = new Inventory(hud);

    this.radius = 0.28;
    this.walkSpeed = 2.6;
    this.runSpeed = 4.4;
    this.accel = 9;
    this.sensitivity = 0.0022;
    this.vel = new THREE.Vector2();
    this.keys = new Set();
    this.lookEnabled = false;
    this.moveEnabled = false;
    this.busy = false;
    this.scripted = false;
    this.locked = false;
    this.everLocked = false;
    this.done = false;
    this.o2 = 100;

    // Cuerpo y biometría.
    this.feetY = 0;
    this.vy = 0;
    this.grounded = true;
    this.groundMat = 'solid';
    this.hp = 100;
    this.dead = false;
    this.deathT = 0;
    this.bpm = 72;
    this.stamina = 1;
    this.exhausted = false;
    this.sprinting = false;
    this.aimShake = 0;
    this.threat = 0;
    this.atmosphere = 'normal';
    this._hurtT = 9;
    this._hurtSnd = 0;
    this._beatT = 0;
    this._breathT = 0;
    this._lastAtmo = 'normal';

    this._dir = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this.focus = null;

    // Linterna anclada a la cámara: penumbra amplia, atenuación física
    // (decay 2) y sombra PCF filtrada; el mismo mapa de sombras recorta el
    // haz volumétrico.
    const fl = (this.flashlight = new THREE.SpotLight(0xfff1d6, 0, 24, 0.5, 0.85, 2));
    fl.position.set(0.2, -0.15, 0.05);
    fl.castShadow = true;
    fl.shadow.mapSize.set(1024, 1024);
    fl.shadow.camera.near = 0.15;
    fl.shadow.camera.far = 24;
    fl.shadow.bias = -0.0004;
    fl.shadow.normalBias = 0.02;
    fl.shadow.radius = 4;
    fl.target.position.set(0.05, -0.05, -1);
    engine.camera.add(fl, fl.target);
    this.flashOn = false;
    this._flashI = 0;
    this.volume = new FlashlightVolume(fl, engine.scene);
    engine.addLate(() => {
      engine.camera.updateMatrixWorld(true);
      this.volume.update(this._flashI);
    });

    this.rig.onStep = (a) => {
      if (!this.grounded) return;
      this.synth.step(Math.min(1.2, (0.5 + a * 0.4) * (this.sprinting ? 1.25 : 1)), this.groundMat);
    };
    this._bindEvents();
    engine.add((dt, t) => this.update(dt, t));
  }

  placeAt(pos, yaw, pitch = 0) {
    this.rig.position.copy(pos);
    this.feetY = pos.y - EYE;
    this.rig.snapLook(yaw, pitch);
    this.vel.set(0, 0);
    this.vy = 0;
  }

  enableControls() {
    this.lookEnabled = true;
    this.moveEnabled = true;
    // Ajusta los pies al suelo real bajo la posición actual.
    const p = this.rig.position, gnd = this.physics.groundAt(p.x, p.z, p.y - EYE + 0.2);
    this.feetY = Number.isFinite(gnd) ? gnd : p.y - EYE;
    this.grounded = true;
  }
  setBusy(v) { this.busy = v; if (v) this.hud.setPrompt(null); }

  // La linterna sólo alumbra si es el objeto que el brazo sostiene. Si ya está
  // en la mano, el pulgar hunde el pulsador y la luz conmuta al fondo del recorrido.
  heldId() { const s = this.inventory.slots[this.inventory.selected]; return s ? s.id : null; }
  setFlashlight(on) {
    if (!this.inventory.has('linterna')) return;
    const apply = () => { this.flashOn = on; this.synth.click(); };
    if (this.heldId() !== 'linterna') {
      this.inventory.select(this.inventory.slots.findIndex((s) => s && s.id === 'linterna'));
      apply();
    } else if (this.viewmodel) this.viewmodel.pressThumb(apply);
    else apply();
  }

  // Sobresalto (drones que detectan, torretas que fijan): el pulso se dispara.
  startle(n) {
    this.bpm = Math.min(190, this.bpm + n);
    this.rig.addShake(n * 0.004);
  }

  push(dx, dz) {
    const p = this.rig.position;
    p.x += dx; p.z += dz;
  }

  damage(amount, src, kind) {
    if (this.dead || !this.moveEnabled || this.done || !(amount > 0)) return;
    this.hp -= amount;
    this._hurtT = 0;
    const burst = kind === 'bolt';
    this.engine.hurt(burst ? 0.45 : Math.min(0.4, amount * 0.08));
    if (burst) { this.engine.impact(0.55); this.rig.addShake(0.35); this.startle(8); }
    else if (kind === 'arc') { this.engine.impact(Math.min(0.3, amount * 0.05)); this.rig.addShake(amount * 0.03); }
    const now = this.engine.time;
    if (now - this._hurtSnd > 0.4) { this._hurtSnd = now; this.synth.hurt(kind); }
    if (this.hp <= 0) this.die(kind);
  }

  die(kind) {
    this.hp = 0;
    this.dead = true;
    this.deathT = 0;
    this.moveEnabled = false;
    this.busy = false;
    if (this.mission.hack) this.mission.cancelHack();
    if (this.mission.reading) this.mission.closeLog();
    this.flashOn = false;
    this.hud.setPrompt(null);
    this.engine.impact(1);
    this.engine.hurt(1);
    this.deathMsg = DEATH_MSG[kind] || 'SEÑALES VITALES PERDIDAS';
    this.hud.showDeath(this.deathMsg);
  }

  _respawn() {
    Save.requestAutoContinue();
    location.reload();
  }

  snapshot() {
    const p = this.rig.position;
    return {
      x: p.x, z: p.z, feetY: this.feetY, yaw: this.rig.yaw, o2: this.o2, hp: Math.max(this.hp, 40),
      charge: this.viewmodel ? this.viewmodel.charge : 1, flash: this.flashOn,
    };
  }

  restore(s) {
    if (!s || !Number.isFinite(s.x + s.z + s.feetY)) return;
    this.placeAt(new THREE.Vector3(s.x, s.feetY + EYE, s.z), Number.isFinite(s.yaw) ? s.yaw : 0, 0);
    this.o2 = Math.max(20, Math.min(100, s.o2 || 100));
    this.hp = Math.max(40, Math.min(100, s.hp || 100));
    if (this.viewmodel && Number.isFinite(s.charge)) this.viewmodel.charge = s.charge;
    this.flashOn = !!s.flash;
  }

  requestLock() {
    const c = this.engine.canvas;
    if (document.pointerLockElement !== c && c.requestPointerLock) {
      const p = c.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }

  _bindEvents() {
    const canvas = this.engine.canvas;
    canvas.addEventListener('click', () => { if (!this.done && !this.dead) this.requestLock(); });
    document.getElementById('pause').addEventListener('click', () => this.requestLock());
    document.getElementById('death').addEventListener('click', () => { if (this.dead && this.deathT > 2) this._respawn(); });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) this.everLocked = true;
      const pause = this.everLocked && !this.locked && !this.done && !this.dead;
      this.engine.paused = pause;
      this.hud.showPause(pause);
      if (pause) this.keys.clear();
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.lookEnabled || this.engine.paused || this.dead) return;
      if (!this.locked && !(e.buttons & 1)) return; // sin Pointer Lock: arrastrar
      this.rig.targetYaw -= e.movementX * this.sensitivity;
      this.rig.targetPitch = THREE.MathUtils.clamp(this.rig.targetPitch - e.movementY * this.sensitivity, -1.45, 1.45);
    });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (this.dead) { if (e.code === 'KeyE' && this.deathT > 2) this._respawn(); return; }
      if (this.engine.paused) return;
      const m = this.mission;
      if (this.busy) {
        if (m.reading) {
          if (e.code === 'KeyE' || e.code === 'KeyQ' || e.code === 'Space' || e.code === 'Backspace') { e.preventDefault(); m.closeLog(); }
          else if (e.code === 'ArrowDown' || e.code === 'KeyS') this.hud.scrollLog(60);
          else if (e.code === 'ArrowUp' || e.code === 'KeyW') this.hud.scrollLog(-60);
          return;
        }
        if (m.hack && m.hack.type === 'xor') {
          if (e.code.startsWith('Digit')) { const n = parseInt(e.code.slice(5), 10); if (n >= 1 && n <= 4) m.hackKey(n - 1); }
          if (e.code === 'KeyQ' || e.code === 'Backspace') m.cancelHack();
          return;
        }
        if (e.code === 'KeyE' || e.code === 'Space') { e.preventDefault(); m.hackInput(); }
        if (e.code === 'KeyQ' || e.code === 'Backspace') m.cancelHack();
        return;
      }
      if (!this.moveEnabled) return;
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= 5) { this.inventory.select(n - 1); this.synth.click(); }
      }
      if (e.code === 'KeyE' && this.focus) this.focus.use();
      if (e.code === 'KeyF') this.setFlashlight(this.heldId() !== 'linterna' ? true : !this.flashOn);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.locked || this.engine.paused) return;
      if (this.dead) { if (this.deathT > 2) this._respawn(); return; }
      if (this.busy) { if (this.mission.hack && this.mission.hack.type === 'timing') this.mission.hackInput(); }
      else if (this.moveEnabled && this.viewmodel) this.viewmodel.fire();
    });
    window.addEventListener('wheel', (e) => {
      if (this.busy && this.mission.reading) { this.hud.scrollLog(e.deltaY); return; }
      if (!this.moveEnabled || this.busy || this.engine.paused) return;
      this.inventory.select(this.inventory.selected + (e.deltaY > 0 ? 1 : -1));
    }, { passive: true });
  }

  _key(a, b) { return this.keys.has(a) || this.keys.has(b) ? 1 : 0; }

  update(dt, t) {
    const rig = this.rig, p = rig.position;
    if (this.dead) { this._updateDeath(dt); return; }
    if (!this.moveEnabled) {
      // Movimiento guionizado (intro): los pies siguen a la cámara.
      if (!this.scripted) { this.vel.set(0, 0); rig.moveFactor = 0; rig.strafe = 0; }
      this.feetY = p.y - EYE;
    } else {
      const ox = p.x, oz = p.z;
      let f = 0, s = 0;
      if (!this.busy) {
        f = this._key('KeyW', 'ArrowUp') - this._key('KeyS', 'ArrowDown');
        s = this._key('KeyD', 'ArrowRight') - this._key('KeyA', 'ArrowLeft');
      }
      let wx = 0, wz = 0;
      if (f || s) {
        const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
        wx = -sy * f + cy * s;
        wz = -cy * f - sy * s;
        const inv = 1 / Math.hypot(wx, wz);
        wx *= inv; wz *= inv;
      }
      this.sprinting = !!(f || s) && this._key('ShiftLeft', 'ShiftRight') && !this.exhausted && this.grounded;
      const speed = (this.sprinting ? this.runSpeed : this.walkSpeed) * (this.hp < 30 ? 0.85 : 1) * (this.exhausted ? 0.85 : 1);
      // En el aire apenas hay control (inercia de la caída).
      const k = 1 - Math.exp(-(f || s ? this.accel : this.accel * 1.4) * (this.grounded ? 1 : 0.1) * dt);
      this.vel.x += (wx * speed - this.vel.x) * k;
      this.vel.y += (wz * speed - this.vel.y) * k;
      p.x += this.vel.x * dt;
      p.z += this.vel.y * dt;
      this._physics(dt, ox, oz);
      const sp = this.vel.length();
      rig.moveFactor = this.grounded ? sp / this.walkSpeed : 0;
      rig.strafe = s * Math.min(1, sp / this.walkSpeed);
    }

    // Linterna con atenuación cuadrática (decay 2) y control de exposición.
    const lit = this.flashOn && this.moveEnabled && this.heldId() === 'linterna';
    let target = 0;
    if (lit) {
      const d = this._probe();
      target = 40 * Math.min(1, Math.max(0.1, (d / 2.2) * (d / 2.2))) * (0.97 + 0.03 * Math.sin(t * 50) * Math.sin(t * 7));
    }
    this._flashI += (target - this._flashI) * (1 - Math.exp(-14 * dt));
    this.flashlight.intensity = Math.min(40, this._flashI);
    // Sin luz no hay pasada de sombras (ahorra cientos de llamadas de dibujo).
    this.flashlight.shadow.autoUpdate = this._flashI > 0.05;

    if (this.moveEnabled) {
      this._biometrics(dt);
      if (!this.busy) this._updateFocus();
      this._updateLocation();
    }
  }

  // Cuerpo contra el mundo: círculo con franja vertical, suelo y gravedad.
  _physics(dt, ox, oz) {
    const ph = this.physics, p = this.rig.position;
    ph.resolveCircle(p, this.feetY + BODY_LO, this.feetY + BODY_HI, this.radius);
    if (!Number.isFinite(p.x + p.z)) { p.x = ox; p.z = oz; this.vel.set(0, 0); }
    const gnd = ph.groundAt(p.x, p.z, this.feetY);
    this.groundMat = ph.lastMat;
    if (gnd === -Infinity) {
      // Fuera de toda superficie (no debería ocurrir): vuelve a la última posición válida.
      p.x = ox; p.z = oz;
    } else if (this.grounded && gnd >= this.feetY - STEP) {
      // Andando: sube escalones suavemente y se pega a rampas al bajar.
      this.feetY = gnd > this.feetY ? this.feetY + (gnd - this.feetY) * (1 - Math.exp(-28 * dt)) : gnd;
      this.vy = 0;
    } else {
      this.grounded = false;
      this.vy -= 9.81 * dt;
      this.feetY += this.vy * dt;
      if (this.feetY <= gnd) {
        const v = -this.vy;
        this.feetY = gnd;
        this.vy = 0;
        this.grounded = true;
        if (v > 2.5) { this.synth.land(v, this.groundMat); this.rig.addShake(Math.min(0.5, v * 0.05)); }
        if (v > 8) this.damage((v - 8) * 6, null, 'fall');
      }
    }
    if (!Number.isFinite(this.feetY)) { this.feetY = 0; this.vy = 0; }
    p.y = this.feetY + EYE;
  }

  // Pulso, resistencia, temblor, O₂ y regeneración.
  _biometrics(dt) {
    const moving = this.vel.lengthSq() > 0.3;
    const alert = this.mission.state === 'alert' ? 10 : 0;
    const target = 68 + (this.sprinting ? 58 : moving ? 12 : 0) + 48 * this.threat + alert +
      (this.atmosphere === 'vacuum' ? 14 : 0) + (this.hp < 40 ? 22 : 0) + (this.o2 < 15 ? 18 : 0);
    this.bpm += (target - this.bpm) * (1 - Math.exp(-(target > this.bpm ? 0.4 : 0.1) * dt));
    this.bpm = Math.max(55, Math.min(190, this.bpm));
    if (this.sprinting) this.stamina = Math.max(0, this.stamina - dt / 7);
    else this.stamina = Math.min(1, this.stamina + dt * (this.bpm < 105 ? 0.2 : 0.11));
    if (this.stamina <= 0) this.exhausted = true;
    else if (this.exhausted && this.stamina > 0.35) this.exhausted = false;
    const fatigue = 1 - this.stamina;
    const tremor = Math.min(1, Math.max(0, (this.bpm - 95) / 70) * 0.75 + fatigue * 0.35 + (this.hp < 30 ? 0.2 : 0));
    this.rig.tremor = tremor;
    this.aimShake = tremor;
    // Latido audible con el pulso alto; respiración agitada con fatiga.
    if (this.bpm > 108) {
      this._beatT -= dt;
      if (this._beatT <= 0) { this.synth.heartbeat(Math.min(1, (this.bpm - 100) / 60)); this._beatT = 60 / this.bpm; }
    }
    if (this.exhausted || fatigue > 0.75) {
      this._breathT -= dt;
      if (this._breathT <= 0) { this.synth.breath(0.5 + fatigue * 0.7); this._breathT = 210 / this.bpm; }
    }

    // Oxígeno según la presión de la zona.
    if (this.atmosphere !== this._lastAtmo) {
      if (this.atmosphere === 'vacuum') { this.synth.suitBeep('warn'); this.hud.toast('BRECHA DE CASCO — CONSUMO DE O₂ ×10', 'warn'); }
      else if (this.atmosphere === 'pressurized' && this.o2 < 99) this.hud.toast('ATMÓSFERA PRESURIZADA — RECARGANDO O₂');
      this.hud.setVacuum(this.atmosphere === 'vacuum');
      this._lastAtmo = this.atmosphere;
    }
    if (this.atmosphere === 'pressurized') this.o2 = Math.min(100, this.o2 + dt * 6);
    else this.o2 = Math.max(0, this.o2 - (dt / 9) * (this.atmosphere === 'vacuum' ? 10 : 1));
    if (this.o2 <= 0) this.damage(5 * dt, null, 'o2');
    this.hud.setO2(this.o2);

    this._hurtT += dt;
    if (this._hurtT > 5 && this.hp < 100 && this.o2 > 0) this.hp = Math.min(100, this.hp + dt * 3);
    this.hud.setBio(dt, this.bpm, this.hp, this.stamina);
  }

  _updateDeath(dt) {
    this.deathT += dt;
    const rig = this.rig, p = rig.position;
    // Caída al suelo: la vista baja y se ladea.
    p.y += (this.feetY + 0.35 - p.y) * (1 - Math.exp(-3 * dt));
    rig.strafe = -10;
    rig.moveFactor = 0;
    rig.tremor = 0;
    this.bpm = Math.max(0, this.bpm - dt * 60);
    this.hud.setBio(dt, this.bpm, 0, 0);
    if (this.deathT > 2 && !this._deathReady) {
      this._deathReady = true;
      this.hud.showDeath(this.deathMsg, true, !!Save.load());
    }
  }

  // Distancia a la primera superficie en la dirección de la mirada (mundo físico).
  _probe() {
    const rig = this.rig, o = this.engine.camera.position, cp = Math.cos(rig.pitch);
    const dx = -Math.sin(rig.yaw) * cp, dy = Math.sin(rig.pitch), dz = -Math.cos(rig.yaw) * cp;
    const ph = this.physics;
    let t = 24 * ph.segment(o.x, o.y, o.z, o.x + dx * 24, o.y + dy * 24, o.z + dz * 24);
    if (dy < -1e-3) t = Math.min(t, (o.y - this.feetY) / -dy);
    else if (dy > 1e-3) t = Math.min(t, (ph.ceilingAt(o.x, this.feetY, o.z) - o.y) / dy);
    return Math.max(0.05, t);
  }

  // Interactuable más centrado en la mirada y dentro de su alcance.
  _updateFocus() {
    const rig = this.rig, eye = rig.position;
    const cp = Math.cos(rig.pitch);
    this._dir.set(-Math.sin(rig.yaw) * cp, Math.sin(rig.pitch), -Math.cos(rig.yaw) * cp);
    let best = null, bestScore = -1;
    const list = this.mission.interactables;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it.active()) continue;
      this._to.subVectors(it.pos, eye);
      const d = this._to.length();
      if (d > it.range) continue;
      const dot = this._to.dot(this._dir) / d;
      const score = dot - d * 0.04;
      if (dot > 0.8 && score > bestScore) { best = it; bestScore = score; }
    }
    this.focus = best;
    if (!best) this.hud.setPrompt(null);
    else {
      const [text, warn] = best.prompt();
      this.hud.setPrompt(text, warn);
    }
  }

  _updateLocation() {
    const p = this.rig.position, z = p.z, x = p.x, O = LEVEL.office, H = LEVEL.hub, S = LEVEL.stair;
    let loc;
    if (this.feetY > 3.5) loc = z > S.z0 - 0.3 ? 'PUENTE DE MANDO // CUBIERTA 3' : 'ESCALERA DE SERVICIO // CUBIERTA 3';
    else if (x > S.x0 && x < S.x1 && z < S.z0 && z > S.z1) loc = 'ESCALERA DE SERVICIO';
    else if (z > LEVEL.hatchZ) loc = 'ESCLUSA 2 // ACOPLE';
    else if (z > LEVEL.room.z1) loc = 'SALA DE DESCOMPRESIÓN';
    else if (x > LEVEL.corr.halfW + 0.1 && z < O.z0 && z > O.z1) loc = 'OFICINA DE SEGURIDAD C-2';
    else if (x < LEVEL.server.x0) loc = 'NÚCLEO DE DATOS';
    else if (x < -H.halfW) loc = 'ALA OESTE // SERVIDORES';
    else if (x > LEVEL.crew.x0) loc = 'DORMITORIOS · ARMERÍA';
    else if (x > H.halfW) loc = 'ALA ESTE // TRIPULACIÓN';
    else if (z > LEVEL.collapse.z0) loc = 'PASILLO PRINCIPAL // SECTOR C';
    else if (z > LEVEL.collapse.z1) loc = 'SECCIÓN COLAPSADA';
    else if (z > H.z0) loc = 'PASILLO PRINCIPAL // SECTOR D';
    else if (z > H.z1) loc = 'NODO D // DISTRIBUIDOR';
    else if (z > LEVEL.lab.z0) loc = 'ACCESO B-3 // CUARENTENA';
    else loc = 'LABORATORIO B-3';
    if (loc !== this._loc) { this._loc = loc; this.hud.setLocation(loc); }
  }

  finish() {
    this.done = true;
    this.moveEnabled = false;
    this.lookEnabled = false;
    this.hud.setPrompt(null);
    if (document.exitPointerLock) document.exitPointerLock();
  }
}
