// =============================================================================
// hazards.js
// Peligros ambientales con tiempos cíclicos (hay que calcular el cruce):
//  · Arcos eléctricos de pared a pared (ala oeste): aviso (bobinas brillan y
//    crepitan) → descarga (daño + empuje) → reposo. Geometría de rayo animada
//    en GPU, luz dinámica del pool y chispas.
//  · Chorros de vapor a presión (acceso al laboratorio).
//  · Zonas despresurizadas: el O₂ del traje cae ×10; zonas presurizadas lo
//    recargan. Todo con delta time y sin asignaciones por frame.
// =============================================================================
import * as THREE from 'three';
import { globalUniforms, createTrail } from './procedural-assets.js';
import { LEVEL } from './level.js';

const ARC_PERIOD = 2.8, ARC_ON = 1.1, ARC_WARN = 0.4;
const JET_PERIOD = 5.5, JET_ON = 1.4;

function arcMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uOn: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime, uOn; varying float vS;
      float h(float n) { return fract(sin(n) * 43758.5453); }
      float n1(float x) { float i = floor(x), f = fract(x); return mix(h(i), h(i + 1.0), f * f * (3.0 - 2.0 * f)); }
      void main() {
        vec3 p = position;
        float s = uv.x;
        float seed = modelMatrix[3][1] * 7.31 + modelMatrix[3][0] * 3.1;
        float env = sin(3.14159 * s);
        float k = floor(uTime * 24.0);
        p.y += (n1(s * 14.0 + k * 1.7 + seed) - 0.5) * 0.36 * env;
        p.z += (n1(s * 9.0 + k * 2.3 + seed * 1.3) - 0.5) * 0.2 * env;
        vS = s;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOn; varying float vS;
      void main() { gl_FragColor = vec4(vec3(0.55, 0.8, 1.0) * 4.0 * uOn, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

function steamMaterial(origin, dir) {
  const N = 240, sd = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) sd[i] = Math.random();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uPixelScale: globalUniforms.uPixelScale, uOn: { value: 0 }, uO: { value: origin }, uD: { value: dir } },
    vertexShader: /* glsl */ `
      uniform float uTime, uPixelScale, uOn; uniform vec3 uO, uD; attribute vec3 aSeed; varying float vA;
      void main() {
        float t = fract(aSeed.x + uTime * 1.6);
        vec3 side = normalize(vec3(aSeed.y - 0.5, aSeed.z - 0.5, aSeed.x - 0.5));
        vec3 p = uO + uD * t * 3.2 + (side - uD * dot(side, uD)) * t * 0.7;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uOn > 0.01 ? clamp((0.08 + t * 0.5) * uPixelScale / max(0.4, -mv.z), 1.0, 64.0) : 0.0;
        vA = uOn * (1.0 - t) * 0.22;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(0.85, 0.88, 0.9) * vA * (1.0 - smoothstep(0.0, 0.5, d)), 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

export class Hazards {
  constructor(engine, ship, synth, sound, rng) {
    this.engine = engine;
    this.synth = synth;
    this.sound = sound;
    this.arcs = [];
    this.jets = [];
    this.danger = 0; // 0..1 cercanía a peligros activos (intensidad musical)
    const lights = [];
    const H = LEVEL.hub, sz0 = H.sideZ0, sz1 = H.sideZ1, smid = (sz0 + sz1) / 2;
    this.sparks = createTrail(260, new THREE.Color(0.7, 0.9, 1.0), new THREE.Color(1.0, 0.7, 0.3));
    ship.group.add(this.sparks.points);
    const coilMatBase = () => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x6ad8ff, emissiveIntensity: 0.2 });

    // Arcos eléctricos en el ala oeste (cruzan el pasillo de pared a pared).
    for (const ax of [-7.4, -9.3]) {
      const mat = arcMaterial();
      const coil = coilMatBase();
      const grp = new THREE.Group();
      for (const y of [0.75, 1.35, 1.95]) {
        const geo = new THREE.PlaneGeometry(sz0 - sz1, 0.05, 48, 1);
        geo.rotateY(Math.PI / 2);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(ax, y, smid);
        m.renderOrder = 4;
        grp.add(m);
        for (const zz of [sz0 - 0.05, sz1 + 0.05]) {
          const c = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.02, 6, 12), coil);
          c.position.set(ax, y, zz);
          grp.add(c);
        }
      }
      for (const zz of [sz0 - 0.08, sz1 + 0.08]) {
        const em = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.6, 0.12), new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.8, roughness: 0.55 }));
        em.position.set(ax, 1.35, zz);
        grp.add(em);
      }
      ship.group.add(grp);
      const light = { pos: new THREE.Vector3(ax, 1.4, smid), color: new THREE.Color(0x8fd8ff), base: 0, distance: 7, mat: null, baseE: 0, mode: 'steady', speed: 1, seed: ax, power: 1 };
      lights.push(light);
      const src = sound.add(light.pos, 'arc');
      this.arcs.push({ x: ax, z0: sz1, z1: sz0, mat, coil, light, phase: rng() * ARC_PERIOD, wasOn: false, src });
    }

    // Chorros de vapor en el acceso al laboratorio (desde el muro izquierdo).
    for (const jz of [-57.6, -60.6]) {
      const o = new THREE.Vector3(-1.5, 1.25, jz), d = new THREE.Vector3(1, -0.08, 0).normalize();
      const pts = steamMaterial(o, d);
      ship.group.add(pts);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.25, 12), new THREE.MeshStandardMaterial({ color: 0x6a5240, metalness: 0.85, roughness: 0.55 }));
      nozzle.rotation.z = Math.PI / 2;
      nozzle.position.set(-1.48, 1.25, jz);
      ship.group.add(nozzle);
      const src = sound.add(o, 'steam');
      this.jets.push({ z: jz, pos: o, mat: pts.material, phase: rng() * JET_PERIOD, src, wasOn: false });
    }
    engine.registerFlickers(lights);

    // Zonas despresurizadas (brecha del colapso, ala este junto a la compuerta
    // atascada) y presurizadas (descompresión y puente).
    const C = LEVEL.collapse;
    this.vacuum = [
      { minX: -2, maxX: 2, minZ: C.z1, maxZ: C.z0, minY: -1, maxY: 3.5 },
      { minX: H.halfW, maxX: LEVEL.crew.x0, minZ: sz1 - 0.3, maxZ: sz0 + 0.3, minY: -1, maxY: 3.5 },
    ];
    const R = LEVEL.room;
    this.pressurized = [
      { minX: -R.halfW, maxX: R.halfW, minZ: R.z1, maxZ: R.z0, minY: -1, maxY: 3.5 },
      { minX: -5, maxX: 5, minZ: -9.1, maxZ: 1.6, minY: LEVEL.upper.y - 0.5, maxY: 9 },
    ];
  }

  static inside(b, x, y, z) { return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && y > b.minY && y < b.maxY; }

  // Estado atmosférico en la posición del jugador: 'vacuum' | 'pressurized' | 'normal'.
  atmosphereAt(x, y, z) {
    for (const b of this.vacuum) if (Hazards.inside(b, x, y, z)) return 'vacuum';
    for (const b of this.pressurized) if (Hazards.inside(b, x, y, z)) return 'pressurized';
    return 'normal';
  }

  update(dt, t, player) {
    const eye = player.rig.position, feet = player.feetY;
    let danger = 0;
    for (const a of this.arcs) {
      const ph = (t + a.phase) % ARC_PERIOD;
      const on = ph < ARC_ON;
      const warn = !on && ph > ARC_PERIOD - ARC_WARN;
      const flick = on ? 0.6 + 0.4 * Math.sin(t * 90) * Math.sin(t * 37) : 0;
      a.mat.uniforms.uOn.value = on ? 0.7 + 0.3 * flick : 0;
      a.coil.emissiveIntensity = on ? 6 : warn ? 2 + Math.sin(t * 60) * 1.5 : 0.25;
      a.light.base = on ? 6 * (0.6 + 0.4 * flick) : warn ? 0.6 : 0;
      if (on && !a.wasOn) this.sound.emit('arcZap', a.light.pos, 2);
      a.wasOn = on;
      const da = Math.hypot(eye.x - a.x, eye.z - (a.z0 + a.z1) / 2);
      if (da < 7 && feet < 2) danger = Math.max(danger, (1 - da / 7) * (on || warn ? 1 : 0.6));
      this.sound.setActivity(a.src, on ? 1 : warn ? 0.25 : 0);
      if (on && Math.random() < dt * 40) {
        const z = a.z0 + Math.random() * (a.z1 - a.z0), y = 0.6 + Math.random() * 1.6;
        this.sparks.emit(a.x, y, z, (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3, 0.3 + Math.random() * 0.3, 0.025);
      }
      if (on && player.moveEnabled && Math.abs(eye.x - a.x) < 0.45 && eye.z > a.z0 - 0.2 && eye.z < a.z1 + 0.2 && feet < 2.2) {
        player.damage(35 * dt, a.light.pos, 'arc');
        player.push(Math.sign(eye.x - a.x || 1) * 6 * dt, 0);
      }
    }
    for (const j of this.jets) {
      const ph = (t + j.phase) % JET_PERIOD, on = ph < JET_ON;
      const ramp = on ? Math.min(1, ph / 0.15) * Math.min(1, (JET_ON - ph) / 0.2) : 0;
      j.mat.uniforms.uOn.value = ramp;
      if (on && !j.wasOn) this.sound.emit('steamBlast', j.pos, 1.6);
      j.wasOn = on;
      const dj = Math.hypot(eye.x, eye.z - j.z);
      if (dj < 5 && feet < 2) danger = Math.max(danger, (1 - dj / 5) * 0.8);
      this.sound.setActivity(j.src, ramp);
      if (ramp > 0.3 && player.moveEnabled && Math.abs(eye.z - j.z) < 0.55 && eye.x > -1.6 && eye.x < 1.6 && feet < 1.5) {
        player.damage(25 * dt, null, 'steam');
        player.push(0, 0);
      }
    }
    this.sparks.update(dt);
    player.atmosphere = this.atmosphereAt(eye.x, eye.y, eye.z);
    if (player.atmosphere === 'vacuum') danger = Math.max(danger, 0.5);
    this.danger = danger;
  }
}
