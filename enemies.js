// =============================================================================
// enemies.js
// Seguridad automática defectuosa:
//  · DRONES centinela con máquina de estados táctica: PATRULLA → SOSPECHA
//    (oyen carreras/disparos) → ATAQUE (mantienen distancia, flanquean con
//    desplazamiento lateral, disparan tras una carga visible) → ACECHO (luces
//    apagadas, van a la última posición vista y barren) → RETIRADA al ser
//    alcanzados. Quien avista al jugador alerta al resto.
//  · TORRETAS de techo: barrido, fijación (pitido) y ráfagas de tres disparos.
// Conos de visión rojos, línea de visión real contra los colisionadores y
// proyectiles en pool (sin asignaciones durante el juego).
// =============================================================================
import * as THREE from 'three';
import { createTrail } from './procedural-assets.js';

const PATROL = 0, SUSPECT = 1, ATTACK = 2, SEARCH = 3, RETREAT = 4, DEAD = 5;
const MAX_BOLTS = 20, BOLT_SPEED = 14, BOLT_DMG = 7;

function coneMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0.5 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform float uI; varying vec2 vUv;
      void main() { gl_FragColor = vec4(vec3(1.0, 0.08, 0.04) * pow(vUv.y, 1.6) * uI * 0.28, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}
function coneGeo(range, deg) {
  const g = new THREE.ConeGeometry(Math.tan(THREE.MathUtils.degToRad(deg)) * range, range, 24, 1, true);
  g.translate(0, -range / 2, 0);
  g.rotateX(Math.PI / 2); // vértice en el emisor, base hacia -Z (frente)
  return g;
}

export class EnemySystem {
  constructor(engine, ship, physics, synth, rng) {
    this.engine = engine;
    this.physics = physics;
    this.synth = synth;
    this.rng = rng;
    this.player = null;
    this.drones = [];
    this.turrets = [];
    this.lights = [];
    this.threat = 0;
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c2f34, metalness: 0.85, roughness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xa04a1c, metalness: 0.4, roughness: 0.55 });
    this.root = new THREE.Group();
    ship.group.add(this.root);

    const mkLight = (seed) => {
      const l = { pos: new THREE.Vector3(), color: new THREE.Color(0xff2010), base: 0, distance: 6, mat: null, baseE: 0, mode: 'steady', speed: 1, seed, power: 1 };
      this.lights.push(l);
      return l;
    };
    const addDrone = (waypoints, active, y) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14), metal);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 8, 32), accent);
      ring.rotation.x = Math.PI / 2;
      g.add(body, ring);
      for (let k = 0; k < 3; k++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.22), metal);
        const a = (k / 3) * Math.PI * 2;
        fin.position.set(Math.cos(a) * 0.2, -0.12, Math.sin(a) * 0.2);
        fin.rotation.y = -a;
        g.add(fin);
      }
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff1a08, emissiveIntensity: 3 });
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), eyeMat);
      eye.position.z = -0.2;
      const coneMat = coneMaterial();
      const cone = new THREE.Mesh(coneGeo(8, 24), coneMat);
      cone.position.z = -0.22;
      cone.renderOrder = 4;
      g.add(eye, cone);
      g.traverse((o) => { if (o.isMesh && o !== cone) o.castShadow = true; });
      const p = waypoints[0];
      g.position.set(p[0], y, p[1]);
      this.root.add(g);
      this.drones.push({
        g, cone, coneMat, eyeMat, pos: g.position, baseY: y, vel: new THREE.Vector3(), yaw: 0, state: PATROL, hp: 3,
        wp: waypoints, wpi: 1, last: new THREE.Vector3(p[0], y, p[1]), t: 0, fireT: 1.5, strafe: 1, strafeT: 1.5, lost: 0,
        active, light: mkLight(this.drones.length * 3.1), spin: 0,
      });
      g.visible = active;
    };
    const addTurret = (x, y, z, baseYaw, active) => {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.16, 16), metal);
      base.position.set(x, y + 0.08, z);
      const head = new THREE.Group();
      head.position.set(x, y - 0.12, z);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.36), metal);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.36, 10), accent);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0.08, -0.02, -0.3);
      const barrel2 = barrel.clone();
      barrel2.position.x = -0.08;
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff1a08, emissiveIntensity: 2 });
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.05, 14), eyeMat);
      lens.position.set(0, 0.04, -0.181);
      lens.rotation.y = Math.PI;
      const coneMat = coneMaterial();
      const cone = new THREE.Mesh(coneGeo(12, 20), coneMat);
      cone.position.set(0, 0.04, -0.19);
      cone.renderOrder = 4;
      head.add(box, barrel, barrel2, lens, cone);
      this.root.add(base, head);
      [base, box, barrel, barrel2].forEach((m) => { m.castShadow = true; });
      this.turrets.push({
        head, cone, coneMat, eyeMat, pos: new THREE.Vector3(x, y - 0.12, z), yaw: baseYaw, pitch: 0, baseYaw, hp: 4,
        state: PATROL, lock: 0, burst: 0, burstT: 0, cool: 0, active, phase: rng() * 6, light: mkLight(40 + this.turrets.length),
      });
      head.visible = true;
    };

    // Rutas semi-procedurales: la del dron inicial cambia con la semilla.
    const routes = [
      [[0, -29.5], [0, -44.5], [2.8, -48.0], [-2.8, -52.0], [0, -44.5]],
      [[0, -44.5], [2.8, -48.2], [0.2, -53.0], [-2.8, -48.2], [0, -36]],
    ];
    addDrone(routes[Math.floor(rng() * routes.length)], true, 2.1);
    addDrone([[0, -56.5], [0, -62.5], [0, -50.0], [3.0, -48.0], [-3.0, -52.0]], false, 2.1);
    addTurret(0, 3.32, -46.6, 0, false);
    addTurret(0, 2.88, -9.4, 0, false);
    engine.registerFlickers(this.lights);

    // Proyectiles enemigos en pool.
    this.bolts = [];
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.6, 0.3) });
    const coreGeo = new THREE.SphereGeometry(0.035, 8, 6);
    for (let i = 0; i < MAX_BOLTS; i++) {
      const m = new THREE.Mesh(coreGeo, coreMat);
      m.scale.set(1, 1, 3);
      m.visible = false;
      this.root.add(m);
      this.bolts.push({ m, active: false, pos: m.position, vel: new THREE.Vector3(), age: 0 });
    }
    this.sparks = createTrail(300, new THREE.Color(1.0, 0.6, 0.4), new THREE.Color(1.0, 0.3, 0.1));
    this.root.add(this.sparks.points);
    this._v = new THREE.Vector3(); this._e = new THREE.Vector3(); this._d = new THREE.Vector3();
  }

  setPlayer(p) { this.player = p; }

  // Punto de control: qué drones y torretas están destruidos.
  snapshot() { return { d: this.drones.map((d) => d.state === DEAD), t: this.turrets.map((t) => t.hp <= 0) }; }
  restore(s) {
    this.drones.forEach((d, i) => {
      if (!s.d || !s.d[i]) return;
      d.state = DEAD; d.hp = 0; d.pos.y = 0.25; d.vel.set(0, 0, 0);
      d.light.base = 0; d.coneMat.uniforms.uI.value = 0; d.eyeMat.emissiveIntensity = 0;
    });
    this.turrets.forEach((t, i) => {
      if (!s.t || !s.t[i]) return;
      t.hp = 0; t.light.base = 0; t.coneMat.uniforms.uI.value = 0; t.eyeMat.emissiveIntensity = 0;
    });
  }

  // Alerta de contención: se activan el segundo dron y las torretas.
  onAlert() {
    for (const d of this.drones) { d.active = true; d.g.visible = true; }
    for (const t of this.turrets) t.active = true;
  }

  // Un disparo del jugador cerca: los drones activos sospechan de esa posición.
  noise(pos, radius) {
    for (const d of this.drones) {
      if (!d.active || d.state === DEAD || d.state === ATTACK) continue;
      if (d.pos.distanceTo(pos) < radius) { d.state = SUSPECT; d.t = 0; d.last.copy(pos); d.last.y = d.baseY; }
    }
  }

  // Impacto de un proyectil de plasma del jugador: devuelve true si alcanzó algo.
  hitTest(x, y, z) {
    for (const d of this.drones) {
      if (!d.active || d.state === DEAD) continue;
      if (Math.hypot(x - d.pos.x, y - d.pos.y, z - d.pos.z) < 0.38) { this._hurt(d); return true; }
    }
    for (const t of this.turrets) {
      if (t.hp <= 0) continue;
      if (Math.hypot(x - t.pos.x, y - t.pos.y, z - t.pos.z) < 0.4) {
        t.hp--;
        this._burst(t.pos, 14);
        this._snd('droneHit', t.pos);
        if (t.hp <= 0) { this._snd('droneDie', t.pos); t.light.base = 0; t.coneMat.uniforms.uI.value = 0; t.eyeMat.emissiveIntensity = 0; }
        else t.lock = 1;
        return true;
      }
    }
    return false;
  }

  _hurt(d) {
    d.hp--;
    this._burst(d.pos, 16);
    this._snd('droneHit', d.pos);
    if (d.hp <= 0) {
      d.state = DEAD;
      d.vel.set((Math.random() - 0.5) * 2, 0.5, (Math.random() - 0.5) * 2);
      d.light.base = 0;
      d.coneMat.uniforms.uI.value = 0;
      d.eyeMat.emissiveIntensity = 0;
      this._snd('droneDie', d.pos);
      return;
    }
    d.state = RETREAT; d.t = 0;
    d.last.copy(this.player.rig.position);
  }

  // Sonido posicional con oclusión (muros y compuertas cerradas lo amortiguan).
  _snd(name, pos) {
    const e = this.player.rig.position, d = Math.hypot(pos.x - e.x, pos.y - e.y, pos.z - e.z);
    const k = 1 / (1 + (d / 7) * (d / 7));
    if (k < 0.04) return;
    this.synth[name](k, d > 0.5 && !this.physics.clear(pos.x, pos.y, pos.z, e.x, e.y, e.z));
  }

  _burst(p, n) {
    for (let k = 0; k < n; k++) {
      this.sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 5, Math.random() * 3, (Math.random() - 0.5) * 5, 0.3 + Math.random() * 0.5, 0.03);
    }
  }

  _sees(from, fwdX, fwdZ, range, cosMax) {
    const p = this.player;
    if (!p || p.dead || !p.moveEnabled) return false;
    const e = p.rig.position;
    const dx = e.x - from.x, dy = e.y - 0.3 - from.y, dz = e.z - from.z, d = Math.hypot(dx, dy, dz);
    if (d > range || d < 0.01) return false;
    if ((dx * fwdX + dz * fwdZ) / Math.hypot(dx, dz) < cosMax) return false;
    return this.physics.clear(from.x, from.y, from.z, e.x, e.y - 0.3, e.z);
  }

  _fire(from, inaccuracy) {
    const b = this.bolts.find((x) => !x.active);
    if (!b) return;
    const e = this.player.rig.position;
    this._d.set(e.x - from.x, e.y - 0.35 - from.y, e.z - from.z).normalize();
    this._d.x += (Math.random() - 0.5) * inaccuracy;
    this._d.y += (Math.random() - 0.5) * inaccuracy * 0.5;
    this._d.z += (Math.random() - 0.5) * inaccuracy;
    this._d.normalize();
    b.pos.copy(from).addScaledVector(this._d, 0.3);
    b.vel.copy(this._d).multiplyScalar(BOLT_SPEED);
    b.age = 0; b.active = true; b.m.visible = true;
    this._snd('droneShot', from);
  }

  _moveDrone(d, tx, tz, speed, dt) {
    const dx = tx - d.pos.x, dz = tz - d.pos.z, dist = Math.hypot(dx, dz);
    if (dist > 1e-3) { d.pos.x += (dx / dist) * Math.min(dist, speed * dt); d.pos.z += (dz / dist) * Math.min(dist, speed * dt); }
    return dist;
  }

  update(dt, t) {
    const p = this.player;
    if (!p) return;
    const e = p.rig.position;
    let threat = 0;
    for (const d of this.drones) {
      if (!d.active) continue;
      if (d.state === DEAD) {
        if (d.pos.y > 0.25) { d.vel.y -= 9.8 * dt; d.pos.addScaledVector(d.vel, dt); d.g.rotation.x += dt * 3; }
        else { d.pos.y = 0.25; d.vel.set(0, 0, 0); if (Math.random() < dt * 4) this._burst(d.pos, 1); }
        continue;
      }
      const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
      const sees = this._sees(d.pos, fx, fz, 10, 0.86);
      const dxP = e.x - d.pos.x, dzP = e.z - d.pos.z, distP = Math.hypot(dxP, dzP);
      const heard = p.sprinting && distP < 7 && Math.abs(e.y - d.pos.y) < 3;
      let faceYaw = d.yaw, coneI = 0.6, light = 1.2;
      d.t += dt;
      if (sees && d.state !== ATTACK && d.state !== RETREAT) {
        d.state = ATTACK; d.t = 0; d.fireT = 1.0;
        this._snd('droneAlert', d.pos);
        p.startle(18);
        // Coordinación: alerta al resto de drones activos.
        for (const o of this.drones) if (o !== d && o.active && o.state !== DEAD && o.state !== ATTACK) { o.state = SUSPECT; o.t = 0; o.last.set(e.x, o.baseY, e.z); }
      }
      switch (d.state) {
        case PATROL: {
          const w = d.wp[d.wpi];
          if (this._moveDrone(d, w[0], w[1], 1.3, dt) < 0.4) d.wpi = (d.wpi + 1) % d.wp.length;
          faceYaw = Math.atan2(-(w[0] - d.pos.x), -(w[1] - d.pos.z));
          if (heard) { d.state = SUSPECT; d.t = 0; d.last.set(e.x, d.baseY, e.z); }
          break;
        }
        case SUSPECT: {
          const r = this._moveDrone(d, d.last.x, d.last.z, 1.7, dt);
          faceYaw = Math.atan2(-(d.last.x - d.pos.x), -(d.last.z - d.pos.z)) + (r < 0.6 ? Math.sin(d.t * 2.2) * 0.9 : 0);
          coneI = 0.9;
          if (d.t > 5) { d.state = PATROL; d.t = 0; }
          break;
        }
        case ATTACK: {
          threat = Math.max(threat, 1);
          faceYaw = Math.atan2(-dxP, -dzP);
          const nx = dxP / (distP || 1), nz = dzP / (distP || 1);
          const radial = THREE.MathUtils.clamp(distP - 6, -1, 1) * 2.0;
          d.strafeT -= dt;
          if (d.strafeT < 0) { d.strafe = -d.strafe; d.strafeT = 1.2 + Math.random(); }
          const vx = nx * radial + -nz * d.strafe * 1.6, vz = nz * radial + nx * d.strafe * 1.6;
          const ox = d.pos.x, oz = d.pos.z;
          d.pos.x += vx * dt; d.pos.z += vz * dt;
          if (this.physics.resolveCircle(d.pos, d.pos.y - 0.25, d.pos.y + 0.25, 0.32) && Math.hypot(d.pos.x - ox, d.pos.z - oz) < Math.hypot(vx, vz) * dt * 0.3) { d.strafe = -d.strafe; d.strafeT = 1.0; }
          d.fireT -= dt;
          coneI = 1.2; light = d.fireT < 0.5 ? 5 : 2.5;
          d.eyeMat.emissiveIntensity = d.fireT < 0.5 ? 10 : 4;
          if (d.fireT <= 0) { this._fire(this._e.copy(d.pos).add(this._v.set(fx * 0.25, 0, fz * 0.25)), 0.06 + (p.sprinting ? 0.06 : 0)); d.fireT = 1.4 + Math.random() * 0.5; }
          if (!sees) { d.lost += dt; if (d.lost > 0.8) { d.state = SEARCH; d.t = 0; d.lost = 0; } } else { d.lost = 0; d.last.set(e.x, d.baseY, e.z); }
          break;
        }
        case SEARCH: {
          // Acecho: luces mínimas, avanza a la última posición conocida y barre.
          const r = this._moveDrone(d, d.last.x, d.last.z, 1.4, dt);
          faceYaw = r > 0.6 ? Math.atan2(-(d.last.x - d.pos.x), -(d.last.z - d.pos.z)) : d.yaw + dt * 1.4;
          coneI = 0.15; light = 0.2;
          threat = Math.max(threat, 0.5);
          if (d.t > 7) { d.state = PATROL; d.t = 0; }
          break;
        }
        case RETREAT: {
          const ax = d.pos.x - e.x, az = d.pos.z - e.z, al = Math.hypot(ax, az) || 1;
          d.pos.x += (ax / al) * 2.6 * dt; d.pos.z += (az / al) * 2.6 * dt;
          faceYaw = Math.atan2(-dxP, -dzP);
          if (d.t > 0.8) { d.state = ATTACK; d.t = 0; d.fireT = 0.7; }
          break;
        }
      }
      if (d.state !== ATTACK) this.physics.resolveCircle(d.pos, d.pos.y - 0.25, d.pos.y + 0.25, 0.32);
      let dy = faceYaw - d.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      d.yaw += dy * (1 - Math.exp(-6 * dt));
      d.spin += dt;
      d.pos.y = d.baseY + Math.sin(d.spin * 2.1) * 0.06;
      if (!Number.isFinite(d.pos.x + d.pos.z)) d.pos.set(d.wp[0][0], d.baseY, d.wp[0][1]);
      d.g.rotation.set(0, d.yaw, Math.sin(d.spin * 1.3) * 0.08);
      d.coneMat.uniforms.uI.value += (coneI - d.coneMat.uniforms.uI.value) * (1 - Math.exp(-8 * dt));
      d.light.pos.copy(d.pos).add(this._v.set(fx * 0.3, 0, fz * 0.3));
      d.light.base = light;
      if (d.state !== ATTACK) d.eyeMat.emissiveIntensity = 3 * light / 1.2;
    }

    for (const tu of this.turrets) {
      if (tu.hp <= 0) { tu.head.rotation.x += (0.6 - tu.head.rotation.x) * dt * 2; continue; }
      if (!tu.active) { tu.coneMat.uniforms.uI.value = 0; tu.light.base = 0; tu.eyeMat.emissiveIntensity = 0.3; continue; }
      const fx = -Math.sin(tu.yaw), fz = -Math.cos(tu.yaw);
      const sees = this._sees(tu.pos, fx, fz, 14, 0.82);
      if (sees) {
        threat = Math.max(threat, 1);
        const target = Math.atan2(-(e.x - tu.pos.x), -(e.z - tu.pos.z));
        let dy = Math.atan2(Math.sin(target - tu.yaw), Math.cos(target - tu.yaw));
        tu.yaw += THREE.MathUtils.clamp(dy, -1.8 * dt, 1.8 * dt);
        tu.pitch = Math.atan2(e.y - 0.4 - tu.pos.y, Math.hypot(e.x - tu.pos.x, e.z - tu.pos.z));
        if (tu.lock === 0) { this._snd('turretLock', tu.pos); p.startle(12); }
        tu.lock += dt;
        tu.cool -= dt;
        if (tu.lock > 1.0 && tu.cool <= 0) { tu.burst = 3; tu.burstT = 0; tu.cool = 2.6; }
      } else {
        tu.lock = 0;
        const target = tu.baseYaw + Math.sin(t * 0.7 + tu.phase) * 1.0;
        tu.yaw += (target - tu.yaw) * (1 - Math.exp(-2 * dt));
        tu.pitch += (-0.25 - tu.pitch) * dt * 2;
      }
      if (tu.burst > 0) {
        tu.burstT -= dt;
        if (tu.burstT <= 0) { this._fire(this._e.copy(tu.pos).add(this._v.set(fx * 0.4, -0.02, fz * 0.4)), 0.1 + (p.sprinting ? 0.08 : 0)); tu.burst--; tu.burstT = 0.16; }
      }
      tu.head.rotation.set(tu.pitch, tu.yaw, 0, 'YXZ');
      tu.coneMat.uniforms.uI.value = sees ? 1.3 : 0.6;
      tu.eyeMat.emissiveIntensity = tu.lock > 0 ? 6 + Math.sin(t * 40) * 3 : 2;
      tu.light.pos.copy(tu.pos);
      tu.light.base = sees ? 3 : 1;
    }

    for (const b of this.bolts) {
      if (!b.active) continue;
      b.age += dt;
      const ox = b.pos.x, oy = b.pos.y, oz = b.pos.z;
      b.pos.addScaledVector(b.vel, dt);
      const tt = this.physics.segment(ox, oy, oz, b.pos.x, b.pos.y, b.pos.z);
      const floor = this.physics.groundAt(b.pos.x, b.pos.z, b.pos.y);
      let end = tt < 1 || b.age > 3 || b.pos.y < floor || !Number.isFinite(b.pos.x);
      if (tt < 1) b.pos.set(ox + (b.pos.x - ox) * tt, oy + (b.pos.y - oy) * tt, oz + (b.pos.z - oz) * tt);
      // Impacto en el jugador: distancia del proyectil al eje vertical del cuerpo.
      if (!end && p.moveEnabled && !p.dead) {
        const hx = b.pos.x - e.x, hz = b.pos.z - e.z;
        if (Math.hypot(hx, hz) < 0.35 && b.pos.y < e.y + 0.15 && b.pos.y > e.y - 1.6) { p.damage(BOLT_DMG, b.pos, 'bolt'); end = true; }
      }
      if (end) { b.active = false; b.m.visible = false; this._burst(b.pos, 8); continue; }
      b.m.lookAt(this._v.copy(b.pos).add(b.vel));
    }
    this.sparks.update(dt);
    this.threat += (threat - this.threat) * (1 - Math.exp(-3 * dt));
  }
}
