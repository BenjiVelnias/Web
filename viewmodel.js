// =============================================================================
// viewmodel.js
// Primer plano: brazo enfundado en el traje EVA que sostiene SOLO el objeto
// seleccionado en la barra de inventario, con balanceo al andar, inercia de
// mirada, respiración y animación de cambio de objeto. Se dibuja en una escena
// propia con el z-buffer limpio (nunca atraviesa paredes).
//
// Dedos articulados: el pulgar hunde el pulsador de la linterna al pulsar [F]
// (la luz conmuta en el fondo del recorrido) y el índice aprieta el gatillo
// del rifle; el disparo sale al final del recorrido, sincronizado con el
// retroceso de la corredera y el destello de boca.
//
// Rifle de plasma HX-9: carga regenerativa, retroceso, destello de boca,
// proyectiles con luz dinámica (pool del motor) que iluminan los pasillos,
// colisión exacta contra el mundo físico (muros con rango vertical, suelos,
// techos y cristal curvo del puente), impactos en drones/torretas, chispas,
// destello de impacto y quemaduras. La puntería tiembla con el pulso.
// Todo con pools preasignados: cero asignaciones durante el juego.
// =============================================================================
import * as THREE from 'three';
import { ITEM_BUILDERS } from './items.js';
import { createTrail, newCanvas } from './procedural-assets.js';
import { buildEVAArm } from './mannequin.js';

const COST = 0.16, REGEN = 0.22, COOLDOWN = 0.24, SPEED = 38, MAX_BOLTS = 10, MAX_DECALS = 24, MAX_IMPACTS = 4;
const PULL = 0.05, RELEASE = 0.13, PRESS = 0.06, UNPRESS = 0.1;
const CYAN = 0x5fd8ff;

// Pose del puño en espacio de cámara y encaje del objeto respecto al puño.
const POSES = {
  linterna: { pos: [0.19, -0.18, -0.42], rot: [0.05, 0.12, 0] },
  plasma: { pos: [0.15, -0.16, -0.38], rot: [0.02, 0.05, 0] },
  tarjeta: { pos: [0.15, -0.16, -0.36], rot: [0.3, 0.35, -0.15] },
  celula: { pos: [0.17, -0.17, -0.4], rot: [0.2, 0.3, 0] },
  maletin: { pos: [0.2, -0.22, -0.42], rot: [0, -0.2, 0] },
};
// Colocación de cada objeto respecto al centro de la empuñadura (origen de la mano).
const GRIPS = {
  linterna: { pos: [0, 0, 0.03], rot: [0, 0, 0] },
  plasma: { pos: [0, 0.02, -0.02], rot: [0, 0, 0] },
  tarjeta: { pos: [0, 0.0, -0.05], rot: [0, 0, 0.3] },
  celula: { pos: [0, 0, 0], rot: [0, 0, 0] },
  maletin: { pos: [0.17, -0.18, 0], rot: [0, Math.PI / 2, 0] },
};
// Agarre de la mano por objeto (ver buildEVAArm): eje y radio de la empuñadura,
// lado de la palma, dirección de la muñeca y pulgar (envolvente o presionando).
const GRIP_SPECS = {
  linterna: { axis: [0, 0, -1], palm: [1, 0, 0], r: 0.023, wrist: [0.2, -0.1, 1], thumb: [0, 0.026, -0.03], movable: 'thumb' },
  // Índice fuera de la empuñadura: entra en el guardamonte por el costado y
  // apoya la yema en el gatillo; los otros tres dedos bajan bajo el guardamonte.
  plasma: {
    axis: [0, Math.cos(0.25), Math.sin(0.25)], palm: [1, 0, 0], r: 0.034, wrist: [0, -0.247, 0.969], thumb: 'wrap',
    index: [[0.042, 0.024, -0.05], [0.017, 0.026, -0.083], [0.0, 0.024, -0.0845]], fingerS: [0.033, -0.012, -0.032, -0.052], movable: 'index',
  },
  tarjeta: { axis: [0, 0, -1], palm: [1, 0, 0], r: 0.011, wrist: [0.2, -0.1, 1], thumb: [0, 0.004, -0.03] },
  celula: { axis: [0, 0, -1], palm: [1, 0, 0], r: 0.038, wrist: [0.2, -0.1, 1], thumb: 'wrap' },
  maletin: { axis: [0, 0, -1], palm: [1, 0, 0], r: 0.017, wrist: [0.3, 1, 0.3], thumb: 'wrap' },
};


function radialTexture(stops) {
  const c = newCanvas(64), x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ViewModel {
  constructor(engine, player, synth, hud, lib) {
    this.engine = engine;
    this.player = player;
    this.synth = synth;
    this.hud = hud;
    const scene = (this.scene = engine.viewScene);

    // Iluminación propia del primer plano (número fijo de luces).
    this.hemi = new THREE.HemisphereLight(0x9a8a7a, 0x141010, 1.1);
    const key = new THREE.DirectionalLight(0xffe2c8, 1.4);
    key.position.set(1, 2, 1.5);
    const rim = new THREE.DirectionalLight(0x6080ff, 0.6);
    rim.position.set(-1.5, 0.5, -1);
    this.muzzleLight = new THREE.PointLight(CYAN, 0, 2.5, 2);
    scene.add(this.hemi, key, rim);

    this.root = new THREE.Group();
    this.root.scale.setScalar(0.62);
    scene.add(this.root);
    this._buildArms();
    this.socket = new THREE.Group();
    this.root.add(this.socket);
    this.items = {};
    for (const id of Object.keys(ITEM_BUILDERS)) {
      const obj = ITEM_BUILDERS[id]();
      const gp = GRIPS[id];
      obj.position.fromArray(gp.pos);
      obj.rotation.fromArray(gp.rot);
      obj.visible = false;
      this.socket.add(obj);
      this.items[id] = obj;
    }
    const plasma = this.items.plasma;
    this.coilMat = plasma.userData.coilMat;
    this.cellMat = plasma.userData.cellMat;
    const glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(120,220,255,0.9)'], [1, 'rgba(0,80,255,0)']]);
    this.flashMat = new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color(2, 3, 4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.flash = new THREE.Group();
    for (let k = 0; k < 2; k++) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), this.flashMat);
      pl.rotation.z = k * Math.PI / 4;
      this.flash.add(pl);
    }
    const side = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.3), this.flashMat);
    side.rotation.x = Math.PI / 2;
    side.position.z = -0.12;
    this.flash.add(side);
    plasma.userData.muzzle.add(this.flash, this.muzzleLight);

    // Haz tenue de la linterna en mano.
    const warmTex = radialTexture([[0, 'rgba(255,250,235,1)'], [0.3, 'rgba(255,220,170,0.6)'], [1, 'rgba(255,200,120,0)']]);
    this.beamMat = new THREE.MeshBasicMaterial({ map: warmTex, color: new THREE.Color(1.2, 1.1, 0.9), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), this.beamMat);
    beam.position.z = -0.19;
    this.items.linterna.add(beam);

    this.current = null;
    this.lower = 1;
    this.root.visible = false;
    this.swayX = 0; this.swayY = 0; this.kick = 0; this.heat = 0;
    this.charge = 1; this.cooldown = 0;
    this.trigT = -1; this.fired = false; this.thumbT = -1; this.onThumb = null; this.slideZ = 0;
    this.physics = null; this.enemies = null;
    this.trigger = plasma.userData.trigger;
    this.slide = plasma.userData.slide;
    this.switchMesh = this.items.linterna.userData.switch;
    this._lastYaw = 0; this._lastPitch = 0;

    this._buildWorldFx(glowTex);
  }

  // Un brazo EVA low-poly por objeto (mannequin.js), con la mano cerrada
  // sobre la empuñadura de ESE objeto. El antebrazo apunta siempre hacia la
  // esquina inferior derecha de la pantalla: se deshace la rotación de la pose.
  _buildArms() {
    this.arms = {};
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffa040, emissiveIntensity: 1.6 });
    const camDir = new THREE.Vector3(0.35, -0.55, 0.76).normalize();
    for (const id of Object.keys(GRIP_SPECS)) {
      const inv = new THREE.Quaternion().setFromEuler(new THREE.Euler(...POSES[id].rot)).invert();
      const fa = camDir.clone().applyQuaternion(inv);
      const arm = buildEVAArm({ ...GRIP_SPECS[id], forearm: [fa.x, fa.y, fa.z] });
      const sc = arm.userData.screen;
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.008), screenMat);
      screen.position.copy(sc.pos);
      screen.lookAt(sc.pos.clone().add(sc.normal));
      arm.add(screen);
      arm.visible = false;
      this.root.add(arm);
      this.arms[id] = arm;
    }
  }

  // Efectos en el mundo: proyectiles, chispas, luces de impacto y quemaduras.
  _buildWorldFx(glowTex) {
    const scene = this.engine.scene;
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 6, 8) });
    const haloMat = new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color(0.5, 1.2, 2.0), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreGeo = new THREE.SphereGeometry(0.03, 10, 8), haloGeo = new THREE.PlaneGeometry(0.4, 0.4);
    this.bolts = [];
    const lights = [];
    for (let i = 0; i < MAX_BOLTS; i++) {
      const g = new THREE.Group();
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.scale.set(1, 1, 3.5);
      const halo = new THREE.Mesh(haloGeo, haloMat);
      g.add(core, halo);
      g.visible = false;
      scene.add(g);
      const light = { pos: new THREE.Vector3(), color: new THREE.Color(CYAN), base: 0, distance: 7, mat: null, baseE: 0, mode: 'steady', speed: 1, seed: i, power: 1 };
      lights.push(light);
      this.bolts.push({ g, halo, active: false, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, light });
    }
    this.impacts = [];
    for (let i = 0; i < MAX_IMPACTS; i++) {
      const light = { pos: new THREE.Vector3(), color: new THREE.Color(0x8fe4ff), base: 0, distance: 6, mat: null, baseE: 0, mode: 'steady', speed: 1, seed: 50 + i, power: 1 };
      lights.push(light);
      this.impacts.push({ light, t: 1 });
    }
    this.muzzleWorld = { pos: new THREE.Vector3(), color: new THREE.Color(CYAN), base: 0, distance: 6, mat: null, baseE: 0, mode: 'steady', speed: 1, seed: 77, power: 1 };
    lights.push(this.muzzleWorld);
    this.engine.registerFlickers(lights);
    this._impactIdx = 0;

    this.sparks = createTrail(500, new THREE.Color(0.7, 0.95, 1.0), new THREE.Color(1.0, 0.55, 0.2));
    scene.add(this.sparks.points);

    const scorchTex = radialTexture([[0, 'rgba(0,0,0,0.85)'], [0.55, 'rgba(10,8,6,0.55)'], [1, 'rgba(0,0,0,0)']]);
    const scorchMat = new THREE.MeshBasicMaterial({ map: scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const decalGeo = new THREE.CircleGeometry(0.14, 20);
    this.decals = [];
    for (let i = 0; i < MAX_DECALS; i++) {
      const g = new THREE.Group();
      const scorch = new THREE.Mesh(decalGeo, scorchMat);
      const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color(1.5, 2.5, 3.0), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5 });
      const glow = new THREE.Mesh(decalGeo, glowMat);
      glow.scale.setScalar(0.8);
      g.add(scorch, glow);
      g.visible = false;
      scene.add(g);
      this.decals.push({ g, glowMat });
    }
    this._decalIdx = 0;
    this._fwd = new THREE.Vector3(); this._right = new THREE.Vector3(); this._up = new THREE.Vector3();
    this._tmp = new THREE.Vector3(); this._n = new THREE.Vector3(); this._q = new THREE.Quaternion();
  }

  // Compila los shaders del primer plano en el arranque (sin tirones al equipar).
  precompile() {
    this.root.visible = true;
    for (const id in this.items) { this.items[id].visible = true; this.arms[id].visible = true; }
    this.engine.renderer.compile(this.scene, this.engine.viewCamera);
    for (const id in this.items) { this.items[id].visible = false; this.arms[id].visible = false; }
    this.root.visible = false;
  }

  attach(physics, enemies) { this.physics = physics; this.enemies = enemies; }

  heldId() { return this.current; }

  // Pulgar sobre el pulsador: la acción se ejecuta en el fondo del recorrido.
  pressThumb(action) {
    if (this.current !== 'linterna' || this.lower > 0.15) { action(); return; }
    if (this.onThumb) this.onThumb();
    this.thumbT = 0;
    this.onThumb = action;
  }

  fire() {
    if (this.current !== 'plasma' || this.lower > 0.15 || this.cooldown > 0 || this.trigT >= 0) return;
    this.trigT = 0;
    this.fired = false;
    this.cooldown = COOLDOWN;
  }

  _shoot() {
    if (this.charge < COST) { this.synth.plasmaEmpty(); this.cooldown = 0.3; return; }
    this.charge -= COST;
    this.kick = 1;
    this.heat = 1;
    const cam = this.engine.camera;
    cam.getWorldDirection(this._fwd);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this._right.crossVectors(this._fwd, this._up).normalize();
    let b = this.bolts[0];
    for (let i = 0; i < this.bolts.length; i++) if (!this.bolts[i].active) { b = this.bolts[i]; break; }
    b.pos.copy(cam.position).addScaledVector(this._fwd, 0.55).addScaledVector(this._right, 0.13).addScaledVector(this._up, -0.11);
    // Converge hacia la retícula a 25 m; el pulso alto y la fatiga dispersan el tiro.
    const spread = 0.004 + 0.035 * this.player.aimShake;
    this._tmp.copy(cam.position).addScaledVector(this._fwd, 25).sub(b.pos).normalize();
    this._tmp.addScaledVector(this._right, (Math.random() - 0.5) * 2 * spread).addScaledVector(this._up, (Math.random() - 0.5) * 2 * spread).normalize();
    b.vel.copy(this._tmp).multiplyScalar(SPEED);
    b.prev.copy(b.pos);
    b.age = 0;
    b.active = true;
    b.g.visible = true;
    b.light.base = 5;
    this.muzzleWorld.pos.copy(b.pos);
    this.muzzleWorld.base = 9;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.synth.plasmaShot();
    this.player.rig.addShake(0.08);
    if (this.enemies) this.enemies.noise(b.pos, 16);
  }

  _impact(b, nx, ny, nz, target = false) {
    const p = b.pos, n = this._n.set(nx, ny, nz);
    for (let k = 0; k < 26; k++) {
      this._tmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4).add(n).normalize();
      const s = 1.5 + Math.random() * 4.5;
      this.sparks.emit(p.x, p.y, p.z, this._tmp.x * s, this._tmp.y * s - 0.5, this._tmp.z * s, 0.25 + Math.random() * 0.5, 0.025 + Math.random() * 0.02);
    }
    const im = this.impacts[this._impactIdx];
    this._impactIdx = (this._impactIdx + 1) % MAX_IMPACTS;
    im.light.pos.copy(p).addScaledVector(n, 0.25);
    im.t = 0;
    if (!target) {
      const d = this.decals[this._decalIdx];
      this._decalIdx = (this._decalIdx + 1) % MAX_DECALS;
      d.g.position.copy(p).addScaledVector(n, 0.004);
      this._tmp.copy(d.g.position).add(n);
      d.g.lookAt(this._tmp);
      d.g.rotateZ(Math.random() * 6.28);
      d.g.visible = true;
      d.glowMat.opacity = 1;
    }
    this.synth.plasmaImpact(p.distanceTo(this.engine.camera.position));
    b.active = false;
    b.g.visible = false;
    b.light.base = 0;
  }

  _updateBolts(dt) {
    const ph = this.physics;
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.age += dt;
      if (b.age > 2.5 || !Number.isFinite(b.pos.x + b.pos.y + b.pos.z)) { b.active = false; b.g.visible = false; b.light.base = 0; continue; }
      const steps = Math.max(1, Math.ceil((SPEED * dt) / 0.25));
      const h = dt / steps;
      let hit = false;
      for (let s = 0; s < steps && !hit; s++) {
        const q = b.prev.copy(b.pos);
        b.pos.addScaledVector(b.vel, h);
        const p = b.pos;
        // Muros, puertas y mobiliario (con su rango vertical).
        const t = ph.segment(q.x, q.y, q.z, p.x, p.y, p.z);
        if (t < 1) {
          p.set(q.x + (p.x - q.x) * t, q.y + (p.y - q.y) * t, q.z + (p.z - q.z) * t);
          const n = ph.hitN;
          p.addScaledVector(n, 0.01);
          this._impact(b, n.x, n.y, n.z);
          hit = true; break;
        }
        // Drones y torretas.
        if (this.enemies && this.enemies.hitTest(p.x, p.y, p.z)) { this._impact(b, -b.vel.x / SPEED, -b.vel.y / SPEED, -b.vel.z / SPEED, true); hit = true; break; }
        // Suelo (superficie bajo el proyectil) y techo del nivel en que está.
        const g = ph.groundAt(p.x, p.z, p.y);
        if (p.y < g + 0.01) { p.y = g + 0.01; this._impact(b, 0, 1, 0); hit = true; break; }
        const c = ph.ceilingAt(p.x, q.y, p.z);
        if (p.y > c - 0.01) { p.y = c - 0.01; this._impact(b, 0, -1, 0); hit = true; break; }
        // Cristal curvo del puente: la normal apunta al centro del semicírculo.
        const arc = ph.outsideArc(p.x, p.y, p.z);
        if (arc) {
          const dx = p.x - arc.cx, dz = p.z - arc.cz, d = Math.hypot(dx, dz) || 1;
          p.x = arc.cx + (dx / d) * (arc.R - 0.02); p.z = arc.cz + (dz / d) * (arc.R - 0.02);
          this._impact(b, -dx / d, 0, -dz / d);
          hit = true; break;
        }
      }
      if (hit) continue;
      b.g.position.copy(b.pos);
      this._tmp.copy(b.pos).add(b.vel);
      b.g.lookAt(this._tmp);
      this._q.copy(b.g.quaternion).invert();
      b.halo.quaternion.copy(this._q).multiply(this.engine.camera.quaternion);
      b.light.pos.copy(b.pos);
      if (Math.random() < 0.6) this.sparks.emit(b.pos.x, b.pos.y, b.pos.z, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 0.25, 0.03);
    }
  }

  update(dt, t) {
    const p = this.player, inv = p.inventory, rig = p.rig;
    const sel = inv.slots[inv.selected];
    const want = p.moveEnabled && !p.busy && !p.done && sel ? sel.id : null;
    if (this.current !== want) {
      this.lower = Math.min(1, this.lower + dt * 5);
      if (this.lower >= 1) {
        if (this.current) { this.items[this.current].visible = false; this.arms[this.current].visible = false; }
        this.current = want;
        if (want) { this.items[want].visible = true; this.arms[want].visible = true; this.synth.equip(); }
      }
    } else if (this.current) this.lower = Math.max(0, this.lower - dt * 3.5);
    this.root.visible = !!this.current;

    // Inercia de mirada, balanceo al andar, respiración y retroceso.
    const k = 1 - Math.exp(-10 * dt);
    const dyaw = rig.yaw - this._lastYaw, dpitch = rig.pitch - this._lastPitch;
    this._lastYaw = rig.yaw; this._lastPitch = rig.pitch;
    const inv_dt = 1 / Math.max(dt, 1e-3);
    this.swayX += (THREE.MathUtils.clamp(dyaw * inv_dt * 0.012, -0.05, 0.05) - this.swayX) * k;
    this.swayY += (THREE.MathUtils.clamp(-dpitch * inv_dt * 0.01, -0.04, 0.04) - this.swayY) * k;
    this.kick *= Math.exp(-11 * dt);
    this.heat *= Math.exp(-2.5 * dt);
    const a = rig.bobAmount, ph = rig.bobPhase;
    const bx = Math.cos(ph) * 0.012 * a, by = -Math.abs(Math.sin(ph)) * 0.016 * a;
    const breathe = Math.sin(t * 1.4) * 0.004;
    if (this.current) {
      const pose = POSES[this.current];
      this.root.position.set(
        pose.pos[0] + this.swayX + bx,
        pose.pos[1] + this.swayY + by + breathe - this.lower * 0.4,
        pose.pos[2] + this.kick * 0.06,
      );
      this.root.rotation.set(pose.rot[0] + this.kick * 0.14 + this.lower * 0.6, pose.rot[1] + this.swayX * 0.6, pose.rot[2] - this.swayX * 0.8);
    }

    // Gatillo: recorrido (PULL) → disparo → retorno (RELEASE). El índice gira
    // sobre su nudillo en sincronía con la lámina del gatillo.
    let pull = 0;
    if (this.trigT >= 0) {
      this.trigT += dt;
      if (this.trigT < PULL) pull = this.trigT / PULL;
      else {
        if (!this.fired) { this.fired = true; this._shoot(); }
        pull = Math.max(0, 1 - (this.trigT - PULL) / RELEASE);
        if (pull <= 0) this.trigT = -1;
      }
    }
    const pe = pull * pull * (3 - 2 * pull);
    this.trigger.rotation.x = -0.24 * pe;
    const idx = this.arms.plasma.userData.digit;
    if (idx) idx.pivot.quaternion.setFromAxisAngle(idx.axis, 0.03 * pe);
    // Corredera: retroceso seco y retorno amortiguado.
    this.slideZ += ((this.kick > 0.05 ? this.kick * 0.028 : 0) - this.slideZ) * (1 - Math.exp(-40 * dt));
    this.slide.position.z = this.slideZ;

    // Pulgar sobre el pulsador de la linterna.
    let press = 0;
    if (this.thumbT >= 0) {
      this.thumbT += dt;
      if (this.thumbT < PRESS) press = this.thumbT / PRESS;
      else {
        if (this.onThumb) { const fn = this.onThumb; this.onThumb = null; fn(); }
        press = Math.max(0, 1 - (this.thumbT - PRESS) / UNPRESS);
        if (press <= 0) this.thumbT = -1;
      }
    }
    const pr = press * press * (3 - 2 * press);
    const th = this.arms.linterna.userData.digit;
    if (th) th.pivot.quaternion.setFromAxisAngle(th.axis, 0.05 * pr);
    this.switchMesh.position.y = 0.024 - 0.0022 * pr;
    if (this.current !== 'linterna' && this.onThumb) { const fn = this.onThumb; this.onThumb = null; this.thumbT = -1; fn(); }

    // Arma: carga, bobinas y destello de boca.
    this.charge = Math.min(1, this.charge + REGEN * dt);
    this.cooldown -= dt;
    this.coilMat.emissiveIntensity = 0.35 + this.charge * 0.8 + this.heat * 2.5 + Math.sin(t * 9) * 0.1;
    this.cellMat.emissiveIntensity = 0.4 + this.charge * 1.4;
    const fl = Math.max(0, this.kick * 1.4 - 0.4);
    this.flashMat.opacity = fl;
    this.muzzleLight.intensity = fl * 3;
    this.muzzleWorld.base *= Math.exp(-28 * dt);
    if (this.muzzleWorld.base < 0.05) this.muzzleWorld.base = 0;

    // Linterna en mano: lente y halo según su estado.
    const lit = p.flashOn && this.current === 'linterna';
    this.items.linterna.userData.lensMat.emissiveIntensity = lit ? 6 : 0.4;
    this.beamMat.opacity = lit ? 0.5 : 0;

    // Iluminación del primer plano: se tiñe de rojo en alerta.
    const al = this.engine.alert;
    this.hemi.color.setRGB(0.6 + 0.4 * al, 0.54 - 0.3 * al, 0.48 - 0.3 * al);

    this._updateBolts(dt);
    for (const im of this.impacts) {
      if (im.t >= 1) { im.light.base = 0; continue; }
      im.t = Math.min(1, im.t + dt / 0.35);
      im.light.base = 14 * (1 - im.t) * (1 - im.t);
    }
    for (const d of this.decals) if (d.glowMat.opacity > 0) d.glowMat.opacity = Math.max(0, d.glowMat.opacity - dt * 0.5);
    this.sparks.update(dt);
    this.hud.setWeapon(this.current === 'plasma', this.charge);
  }
}

