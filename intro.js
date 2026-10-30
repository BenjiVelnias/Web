// =============================================================================
// intro.js
// Secuencia cinemática inicial (saltable con ENTER / ESPACIO):
//   Fase A (0–12 s)    Exterior: la cápsula se aproxima con estela de
//                      partículas, frena con retrocohetes y se acopla.
//   Fase B (12–19.5 s) Primera persona: despresurización, escotilla, la sala
//                      de descompresión se enciende y avanzamos.
//   Fase C (19.5 s–)   Holograma humanoide + ventana de datos con el mensaje
//                      corporativo (sin subtítulos en pantalla: todo es diegético).
// Conducida desde el bucle del motor: la pausa congela la cinemática.
// =============================================================================
import * as THREE from 'three';
import { hash1 } from './procedural-assets.js';
import { LEVEL } from './level.js';
import { Hologram } from './hologram.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const easeOut3 = (x) => 1 - Math.pow(1 - clamp01(x), 2.2);
const easeInOut = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

const T_DOCK = 9.5;
const T_B = 12;
const T_C = 19.5;
const CHARS_PER_SEC = 36;
const LINE_HOLD = 1.8;

const SPEAKER = 'DRA. A. VOSS — DIRECCIÓN DE PROYECTOS ESPECIALES';
const MESSAGE = [
  'Contratista 7-Delta: bienvenido a bordo de la ODISEA-IX.',
  'Hace 41 días perdimos contacto con la tripulación. No necesita saber por qué.',
  'En el Laboratorio B-3 hay un maletín de contención genética: la única muestra viable del proyecto ÁRES.',
  'El acceso requiere una tarjeta B-3. El jefe de seguridad la guardaba en la Oficina C-2.',
  'Al retirar la muestra, la nave activará el protocolo de contención. Está previsto.',
  'Fuerce las compuertas que encuentre. Su traje dispone de módulo de anulación.',
  'Regrese a la cápsula. Sin desvíos. Si encuentra a la tripulación... no la ayude.',
  'Helix-Ares agradece su discreción. Fin de la transmisión.',
];

export class Intro {
  constructor(engine, ship, capsule, mission, synth, hud, player) {
    Object.assign(this, { engine, ship, capsule, mission, synth, hud, player });
    this.t = 0;
    this.running = false;
    this.done = false;
    this.onComplete = null;
    this._fired = new Set();
    this._update = this.update.bind(this);
    this._spike = 0;
    this._camShake = 0;
    this._emitAcc = 0;
    this._baseAberration = engine.post.uAberration.value;

    this.P0 = new THREE.Vector3(30, 10, 80);
    this.P1 = new THREE.Vector3(14, 4, 32);
    this.P2 = new THREE.Vector3(0, 1.35, LEVEL.dockZ);
    this.C0 = new THREE.Vector3(46, 15, 95);
    this.C1 = new THREE.Vector3(15, 4.5, 18);
    this.C2 = new THREE.Vector3(3.5, 2.2, 10);
    this.DOCK = new THREE.Vector3(0, 1.35, 3.5);
    this._v = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._nz = new THREE.Vector3();
    this._dir = new THREE.Vector3();

    this.holo = new Hologram(ship, MESSAGE, SPEAKER);
    engine.scene.add(capsule.trail.points);

    window.addEventListener('keydown', (e) => {
      if (this.running && !this.done && (e.code === 'Enter' || e.code === 'Space')) this.skip();
    });
  }

  _once(key, fn) {
    if (this._fired.has(key)) return;
    this._fired.add(key);
    fn();
  }

  start() {
    const e = this.engine;
    this.running = true;
    e.cameraMode = 'cinematic';
    e.scene.fog.density = e.fogTarget = 0.0025;
    e.sunLight.intensity = 3.2;
    this.ship.setExteriorInside(false);
    for (const l of this.ship.introLamps) l.power = 0;
    this.hud.show(false);
    this.hud.cinematic(true);
    this.hud.setFade(1);
    this.synth.startAmbience();
    e.add(this._update);
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    if (t < T_B) this._phaseA(t, dt);
    else if (t < T_C) this._phaseB(t);
    else this._phaseC(t, dt);
    this.capsule.trail.update(dt);
    this._spike *= Math.exp(-3 * dt);
    this.engine.post.uAberration.value = this._baseAberration + this._spike * 0.012;
  }

  // ------------------------------------------------------------- FASE A
  _phaseA(t, dt) {
    const cap = this.capsule.group, v = this._v;
    const u = easeOut3(t / T_DOCK), iu = 1 - u;
    v.copy(this.P0).multiplyScalar(iu * iu).addScaledVector(this.P1, 2 * iu * u).addScaledVector(this.P2, u * u);
    cap.position.copy(v);
    cap.rotation.set(Math.sin(t * 0.6) * 0.04 * iu, 0.4 * iu * iu, Math.sin(t * 0.45) * 0.06 * iu);
    cap.updateMatrixWorld();

    const main = t < 3 ? 1 : Math.max(0, 1 - (t - 3) / 1.5);
    const retro = t > 5.5 && t < T_DOCK - 0.3 ? 0.6 + 0.4 * Math.sin(t * 22) : 0;
    this.capsule.mainFlame.uniforms.uPower.value = main;
    this.capsule.retroFlame.uniforms.uPower.value = retro;
    this.synth.setThruster(main * 0.8 + retro * 0.35);
    this._emitTrail(dt, main, retro);

    const cam = this.engine.camera;
    cam.position.lerpVectors(this.C0, this.C1, easeInOut(t / 11));
    if (t > 10.2) cam.position.lerp(this.C2, easeInOut((t - 10.2) / 1.8) * 0.85);
    this._look.lerpVectors(cap.position, this.DOCK, smooth((t - 6.5) / 4));
    this._camShake *= 0.94;
    const sh = this._camShake * this._camShake;
    cam.position.x += (hash1(t * 53.1) - 0.5) * 0.4 * sh;
    cam.position.y += (hash1(t * 41.7 + 2.0) - 0.5) * 0.4 * sh;
    cam.lookAt(this._look);

    if (t > 0.8) this._once('capA1', () => this.hud.setCaption('<b>ÓRBITA DE MARTE</b>AÑO 2231 · 03:12 UTC'));
    if (t > 5.0) this._once('capA2', () => this.hud.setCaption('<b>ODISEA-IX</b>SIN SEÑALES VITALES · 41 DÍAS'));
    if (t >= T_DOCK) this._once('dock', () => {
      this.synth.dock();
      this.synth.setThruster(0);
      this._camShake = 1;
      this._spike = 1;
      this.hud.setCaption('<b>ACOPLE COMPLETADO</b>ESCLUSA 2 · PRESURIZANDO');
    });
    if (t > 11.0) this._once('capOff', () => this.hud.setCaption(''));

    let fade = 0;
    if (t < 2) fade = 1 - t / 2;
    if (t > 11.2) fade = clamp01((t - 11.2) / 0.8);
    this.hud.setFade(fade);
  }

  // Estela: partículas emitidas en la tobera (espacio mundo) y chorros de
  // los retrocohetes delanteros.
  _emitTrail(dt, main, retro) {
    const cap = this.capsule.group, tr = this.capsule.trail;
    this._emitAcc += dt * (main * 240 + retro * 120);
    while (this._emitAcc >= 1) {
      this._emitAcc -= 1;
      if (main > 0.05 && Math.random() < main / (main + retro + 1e-3)) {
        const nz = this.capsule.nozzles;
        this._nz.copy(nz[(Math.random() * nz.length) | 0]).applyMatrix4(cap.matrixWorld);
        this._dir.set((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25, 1).applyQuaternion(cap.quaternion);
        const s = 7 + Math.random() * 5;
        tr.emit(this._nz.x, this._nz.y, this._nz.z, this._dir.x * s, this._dir.y * s, this._dir.z * s, 0.8 + Math.random() * 0.8, 0.18);
      } else if (retro > 0) {
        const a = Math.floor(Math.random() * 4) * Math.PI / 2 + Math.PI / 4;
        this._nz.set(Math.cos(a) * 1.22, Math.sin(a) * 1.22, -0.8).applyMatrix4(cap.matrixWorld);
        this._dir.set((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, -1).applyQuaternion(cap.quaternion);
        const s = 4 + Math.random() * 2;
        tr.emit(this._nz.x, this._nz.y, this._nz.z, this._dir.x * s, this._dir.y * s, this._dir.z * s, 0.35 + Math.random() * 0.25, 0.07);
      }
    }
  }

  // ------------------------------------------------------------- FASE B
  _enterInterior() {
    const e = this.engine, cap = this.capsule.group;
    cap.position.copy(this.P2);
    cap.rotation.set(0, 0, 0);
    this.capsule.mainFlame.uniforms.uPower.value = 0;
    this.capsule.retroFlame.uniforms.uPower.value = 0;
    this.synth.setThruster(0);
    this.hud.setCaption('');
    e.sunLight.intensity = 0;
    this.ship.setExteriorInside(true);
    e.scene.fog.density = e.fogTarget = 0.06;
    e.cameraMode = 'rig';
    e.rig.position.set(0, 1.65, 2.95);
    e.rig.snapLook(0, -0.02);
  }

  _phaseB(t) {
    this._once('enterB', () => this._enterInterior());
    const hatch = this.ship.doors.hatch, beacon = this.ship.beacon, rig = this.engine.rig;
    this.hud.setFade(t < T_B + 0.2 ? 1 : 1 - clamp01((t - T_B - 0.2) / 1.0));

    const bp = t < 17 ? Math.pow(0.5 + 0.5 * Math.sin(t * 8), 2) : 0;
    beacon.light.base = 3 * bp;
    beacon.mat.emissiveIntensity = 8 * bp;

    if (t > 13.4) this._once('hatch', () => {
      this.synth.hatch();
      this.mission.setDoorStatus(hatch, 0xffaa20);
      rig.addShake(0.3);
      this._spike = 0.6;
    });
    if (t > 13.8) this._once('open', () => { hatch.target = 1; this.ship.steam.trigger(); });
    if (hatch.progress >= 1) this._once('hatchOpen', () => this.mission.setDoorStatus(hatch, 0x20ff50));

    // Encendido escalonado con tartamudeo.
    const lamps = this.ship.introLamps;
    for (let i = 0; i < lamps.length; i++) {
      const d = t - (14.5 + i * 0.5);
      lamps[i].power = d < 0 ? (i === 1 ? 0.3 : 0) : d < 0.45 ? (hash1(Math.floor(t * 30) + i * 13.1) > 0.5 ? 1 : 0) : 1;
    }

    // Avance guionizado; la derivada de smoothstep alimenta el head-bob.
    const w = clamp01((t - 16.0) / 3.3);
    if (w > 0) {
      const ew = w * w * (3 - 2 * w);
      rig.position.z = 2.95 + (LEVEL.spawn.z - 2.95) * ew;
      rig.moveFactor = 6 * w * (1 - w) * 0.62;
      this.player.scripted = w < 1;
    }
  }

  // ------------------------------------------------------------- FASE C
  _phaseC(t, dt) {
    const k = t - T_C, H = this.holo;
    this._once('holo', () => {
      this.player.scripted = false;
      this.engine.rig.moveFactor = 0;
      this.player.lookEnabled = true;
      H.setVisible(true);
      this._spike = 0.8;
      this._line = 0;
      this._lineT = 0;
      this._chars = -1;
      this._endT = -1;
      this._glitchSlot = -1;
    });

    if (k > 2.0 && this._line < MESSAGE.length) {
      this._lineT += dt;
      const txt = MESSAGE[this._line];
      const chars = Math.min(txt.length, Math.floor(this._lineT * CHARS_PER_SEC));
      if (chars !== this._chars) {
        if (chars > this._chars && chars % 6 === 0 && chars < txt.length) this.synth.blip();
        this._chars = chars;
        H.drawText(this._line, chars);
      }
      if (this._lineT > txt.length / CHARS_PER_SEC + LINE_HOLD) {
        this._line++;
        this._lineT = 0;
        this._chars = -1;
        if (this._line >= MESSAGE.length) { this._endT = t; H.drawText(MESSAGE.length, 0); }
      }
    }

    const appear = smooth(k / 1.6);
    const dissolve = this._endT > 0 ? 1 - clamp01((t - this._endT - 1.5) / 1.2) : 1;
    const opacity = appear * dissolve;
    const slot = Math.floor(t * 3);
    let glitch = 1 - appear * 0.85;
    if (hash1(slot * 1.7) > 0.92) {
      glitch = 0.9;
      if (slot !== this._glitchSlot) { this._glitchSlot = slot; this._spike = Math.max(this._spike, 0.3); }
    }
    if (dissolve < 1) glitch = 1;

    H.setOpacity(opacity, glitch);
    H.update(dt, t);
    this.ship.holo.light.base = 3 * opacity * (0.85 + 0.15 * Math.sin(t * 31));
    this.ship.holo.lensMat.emissiveIntensity = 0.4 + 5 * opacity;
    this.ship.holo.floorRingMat.emissiveIntensity = 0.5 + 3 * opacity;

    if (this._endT > 0 && dissolve <= 0) this._once('finish', () => this._finish());
  }

  // Reanudación desde un punto de control: sin cinemática, aparece en el
  // interior con el estado guardado y un fundido desde negro.
  resume(save) {
    this.running = true;
    this.synth.startAmbience();
    this._once('enterB', () => this._enterInterior());
    for (const l of this.ship.introLamps) l.power = 1;
    this.ship.beacon.light.base = 0;
    this.ship.beacon.mat.emissiveIntensity = 0;
    this.done = true;
    this.holo.setVisible(false);
    this.hud.setCaption('');
    this.hud.cinematic(false);
    this.hud.show(true);
    this.mission.restore(save);
    this.player.enableControls();
    this.hud.toast('PUNTO DE CONTROL RESTAURADO', 'save');
    let f = 1;
    const fade = (dt) => {
      f = Math.max(0, f - dt / 1.2);
      this.hud.setFade(f);
      if (f <= 0) this.engine.remove(fade);
    };
    this.engine.add(fade);
  }

  // ---------------------------------------------------------------------------
  skip() {
    this._once('enterB', () => this._enterInterior());
    const hatch = this.ship.doors.hatch;
    hatch.target = 1;
    hatch.progress = 0.999;
    this.mission.setDoorStatus(hatch, 0x20ff50);
    for (const l of this.ship.introLamps) l.power = 1;
    this.ship.beacon.light.base = 0;
    this.ship.beacon.mat.emissiveIntensity = 0;
    this.player.placeAt(LEVEL.spawn, 0);
    this.hud.setFade(0);
    this.hud.setCaption('');
    this._finish();
  }

  _finish() {
    if (this.done) return;
    this.done = true;
    this.holo.setVisible(false);
    this.ship.holo.light.base = 0;
    this.ship.holo.lensMat.emissiveIntensity = 0.4;
    this.ship.holo.floorRingMat.emissiveIntensity = 0.5;
    this.engine.post.uAberration.value = this._baseAberration;
    this.engine.remove(this._update);
    this.player.scripted = false;
    this.hud.cinematic(false);
    this.hud.show(true);
    this.player.enableControls();
    this.mission.begin();
    this.hud.toast('[WASD] MOVER · [SHIFT] CORRER · [E] INTERACTUAR · [1-5] INVENTARIO');
    if (this.onComplete) this.onComplete();
  }
}
