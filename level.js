// =============================================================================
// level.js
// Construcción procedural de la nave ODISEA-IX y de la cápsula:
//   Esclusa (tubo de acople) → Sala de descompresión (origen, holograma)
//   → Pasillo industrial (ventanales panorámicos, sección colapsada,
//     compuerta blindada) → Oficina de seguridad → Laboratorio B-3.
// Devuelve geometría y datos de juego: colisionadores AABB, fuentes de luz
// lógicas (las sirve el pool del motor), puertas, terminales y recogibles.
// =============================================================================
import * as THREE from 'three';
import {
  globalUniforms, mulberry32, worldBox, scaleUV, pbr, MARS_LIGHT_DIR,
  createMarkerMaterial, createFlameMaterial, createDecalTexture, createSignTexture,
  createLightShaftMaterial, createLightShaftGeometry, createDust, createSteamBurst, createTrail,
  newCanvas,
} from './procedural-assets.js';
import { initItemMaterials, buildFlashlight, buildCard, buildCell, buildBriefcase, buildPlasma } from './items.js';
import { buildMannequin, posedJoints, JOINT_R, REST } from './mannequin.js';
import { buildUpperDeck } from './level-upper.js';

export const LEVEL = {
  hatchZ: 1.0, airlockEnd: 3.4, dockZ: 4.0,
  room: { halfW: 3.5, z0: 1.0, z1: -7.0, h: 3.2, doorHalfW: 1.0, doorH: 2.6 },
  corr: { halfW: 1.6, z0: -7.0, z1: -46.0, h: 3.0 },
  win1: { z0: -10, z1: -18, y0: 0.7, y1: 2.4 },
  win2: { z0: -31, z1: -38, y0: 0.7, y1: 2.4 },
  collapse: { z0: -19, z1: -27 },
  breach: { x0: -1.6, x1: 0.3, z0: -21, z1: -24.5 },
  bulkheadZ: -28.5,
  office: { x1: 6.6, z0: -32, z1: -41, doorZ0: -35.2, doorZ1: -36.8 },
  hub: { halfW: 4.5, z0: -46, z1: -54, h: 3.4, sideZ0: -48.4, sideZ1: -51.6 },
  server: { x0: -12, x1: -20, z0: -45, z1: -55, h: 3.2 },
  crew: { x0: 11, x1: 19, z0: -45, z1: -55, h: 3.2 },
  labCorr: { z0: -54, z1: -64 },
  qsZ: -55.4,
  lab: { halfW: 6, z0: -64, z1: -78, h: 4 },
  stair: { x0: 1.85, x1: 5.9, z0: -8.8, z1: -19.0, doorZ0: -11.0, doorZ1: -13.0, h: 8.2 },
  upper: { y: 4.4 },
  bridge: { hw: 4.5, zc: -3.0, R: 4.5, h: 3.3 },
  holo: { x: -0.5, z: -4.4 },
  spawn: new THREE.Vector3(0, 1.65, -1.2),
};

// Altura del techo en (x, z): la usan los proyectiles para impactar arriba.
export function ceilingAt(x, z) {
  const H = LEVEL.hub;
  if (z > LEVEL.hatchZ) return 2.8;
  if (z > LEVEL.room.z1) return LEVEL.room.h;
  const S = LEVEL.stair;
  if (x > S.x0 && x < S.x1 && z < S.z0 && z > S.z1) return S.h;
  if (x < -H.halfW) return x < LEVEL.server.x0 ? LEVEL.server.h : 3.0;
  if (x > H.halfW) return x > LEVEL.crew.x0 ? LEVEL.crew.h : 3.0;
  if (z <= H.z0 && z >= H.z1) return H.h;
  if (z < LEVEL.lab.z0) return LEVEL.lab.h;
  return 3.0;
}

// Haz giratorio de baliza (aditivo, se desvanece a lo largo del cono).
function createBeamMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPower: { value: 0 }, uColor: { value: new THREE.Color(color) },
      uClipP: { value: new THREE.Vector3(0, -1e4, 0) }, uClipN: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vW;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uPower; uniform vec3 uColor, uClipP, uClipN; varying vec2 vUv; varying vec3 vW;
      void main() {
        if (dot(vW - uClipP, uClipN) < 0.0) discard;
        gl_FragColor = vec4(uColor * pow(max(vUv.y, 0.0), 3.0) * uPower * 0.22, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// Cristal de ventanal: material DEDICADO y constante. Reflexión simplificada
// (Fresnel de Schlick con un tinte fijo) y suciedad estática en espacio de
// mundo; no depende del pool de luces ni de mapas de entorno, así que no
// cambia de aspecto al moverse ni de un fotograma a otro. Se dibuja en la cola
// transparente (renderOrder fijo 10), con prueba de profundidad y sin escribirla.
function createGlassMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTint: { value: new THREE.Color(0.55, 0.32, 0.24) } },
    vertexShader: /* glsl */ `varying vec3 vW, vN;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `uniform vec3 uTint; varying vec3 vW, vN;
      float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        float ndv = clamp(abs(dot(normalize(vN), V)), 0.0, 1.0);
        float fr = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
        vec2 q = vec2(vW.x + vW.z, vW.y);
        float grime = smoothstep(0.55, 0.95, vn(q * 2.3) * 0.7 + vn(q * 9.0) * 0.3) * (1.0 - smoothstep(0.4, 1.4, q.y));
        vec3 col = uTint * (0.015 + 0.22 * fr) + vec3(0.03, 0.025, 0.02) * grime;
        gl_FragColor = vec4(col, clamp(0.05 + 0.4 * fr + 0.18 * grime, 0.0, 0.6));
      }`,
    transparent: true, depthWrite: false, depthTest: true,
  });
}

// Estática de cámaras de vigilancia.
function createStaticMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 g = floor(vUv * vec2(160.0, 100.0));
        float n = h(g + floor(uTime * 24.0));
        float roll = smoothstep(0.0, 0.05, fract(vUv.y - uTime * 0.3)) * 0.25 + 0.75;
        gl_FragColor = vec4(vec3(0.35, 0.5, 0.55) * n * roll * 0.9, 1.0);
      }`,
  });
}

// Pantalla de terminal: canvas redibujado sólo al cambiar de estado.
function createTerminalScreen() {
  const c = newCanvas(256, 160), x = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.5, 1.5, 1.5) });
  function draw(title, status, color) {
    x.fillStyle = '#020405'; x.fillRect(0, 0, 256, 160);
    x.strokeStyle = color; x.lineWidth = 3; x.strokeRect(5, 5, 246, 150);
    x.fillStyle = color; x.font = 'bold 20px Consolas, "Courier New", monospace';
    x.fillText(title, 16, 36);
    x.fillRect(16, 46, 224, 2);
    x.font = 'bold 26px Consolas, "Courier New", monospace';
    x.fillText(status, 16, 92);
    x.globalAlpha = 0.5; x.font = '14px Consolas, monospace';
    for (let i = 0; i < 3; i++) x.fillText((Math.random() * 1e8 | 0).toString(16).toUpperCase().padStart(7, '0') + ' ' + '▮'.repeat(1 + (i * 3) % 7), 16, 118 + i * 14);
    x.globalAlpha = 1;
    tex.needsUpdate = true;
  }
  return { mat, draw };
}

// =============================================================================
export function buildShip(lib, seed = 1) {
  const rv = mulberry32(seed); // variaciones semi-procedurales de esta partida
  const group = new THREE.Group();
  group.name = 'ship';
  const colliders = [], lights = [], pickups = [], animators = [], beacons = [], shafts = [];
  const state = { alert: false };
  let seedCounter = 1;
  initItemMaterials(lib);

  const M = {
    wall: pbr(lib.wall),
    floor: pbr(lib.floor),
    ceil: pbr(lib.ceil),
    door: pbr(lib.wall, { color: 0xb0a490 }),
    heavy: pbr(lib.wall, { color: 0x8a8070 }),
    crate: pbr(lib.wall, { color: 0x7d8f6a }),
    hazard: pbr(lib.hazard),
    hull: pbr(lib.hull, { envMapIntensity: 0.9 }),
    hullDark: pbr(lib.hull, { color: 0x6a6660, envMapIntensity: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.66, metalness: 0.75, normalMap: lib.wall.normalMap, envMapIntensity: 0.4 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0x6a5240, roughness: 0.6, metalness: 0.85, envMapIntensity: 0.5 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.85, metalness: 0.0 }),
    glass: createGlassMaterial(),
    // Máscara invisible del ventanal: marca el stencil por donde se ve el exterior.
    mask: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp }),
    tankGlass: new THREE.MeshStandardMaterial({ color: 0x9fe0c0, roughness: 0.22, metalness: 0.1, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }),
  };
  const T = 0.25;
  // Luminaria mural/de techo: toda luz lógica tiene una fuente visible.
  function wallFixture(x, y, z, ry, color, ceiling = false) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 3 });
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.32, ceiling ? 0.05 : 0.12, ceiling ? 0.32 : 0.06), mat);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.38, ceiling ? 0.04 : 0.17, ceiling ? 0.38 : 0.05), M.dark);
    lens.position.set(x, y, z); body.position.set(x, ceiling ? y + 0.035 : y, z);
    lens.rotation.y = body.rotation.y = ry;
    if (!ceiling) body.translateZ(-0.03);
    group.add(lens, body);
    return mat;
  }

  // ----------------------------------------------------------------- helpers
  // Superficies de apoyo (muebles): los cuerpos se asientan sobre ellas.
  const supports = [], supportMeshes = [];
  const surfaces = [{ minX: -25, maxX: 25, minZ: -90, maxZ: 6, y: 0, mat: 'solid' }], arcs = [], ceilings = [], logTerms = [];
  // Una superficie sólo sostiene lo que está encima de ella o hundido hasta
  // 12 cm; lo que queda debajo de un tablero (piernas bajo la mesa) la ignora.
  function surfaceAt(x, y, z) {
    let h = 0;
    for (const s of supports) if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ && y > s.top - 0.12 && s.top > h) h = s.top;
    return h;
  }
  // Asentamiento por contacto: desplaza el cuerpo en vertical hasta que su
  // vértice más cercano a una superficie (suelo o mueble) la toque: ninguno se
  // hunde y al menos uno apoya. Después se le da un colisionador AABB.
  // Asentamiento por RAYCAST descendente: desde cada vértice muestreado (12 cm
  // por encima, para detectar hundimientos) se lanza un rayo hacia abajo contra
  // las mallas de apoyo (colchones, sillas, mesas, suelos). El cuerpo se desplaza
  // lo justo para que ningún vértice atraviese la superficie y al menos uno
  // repose sobre ella. Luego recibe colisionadores por celdas de ocupación de
  // 25 cm (exactos, sin cajas diagonales que creen muros invisibles).
  const _ray = new THREE.Raycaster(), _down = new THREE.Vector3(0, -1, 0), _o = new THREE.Vector3();
  function settle(obj, collide = true, baseY = 0) {
    group.updateMatrixWorld(true);
    obj.updateMatrixWorld(true);
    let minD = Infinity;
    const v = new THREE.Vector3();
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      // Mallas low-poly: se prueban todos los vértices (apoyo exacto).
      const st = p.count > 6000 ? 5 : 1;
      for (let i = 0; i < p.count; i += st) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        _o.set(v.x, v.y + 0.12, v.z);
        _ray.set(_o, _down);
        _ray.far = 4;
        const hit = _ray.intersectObjects(supportMeshes, false)[0];
        const gy = hit ? Math.max(hit.point.y, baseY) : baseY;
        const d = v.y - gy;
        if (d < minD) minD = d;
      }
    });
    if (Number.isFinite(minD)) obj.position.y -= minD;
    group.add(obj);
    if (!collide) return;
    obj.updateMatrixWorld(true);
    const cell = 0.25, occ = new Set();
    let y0 = Infinity, y1 = -Infinity;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i += 3) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        occ.add(Math.floor(v.x / cell) + ',' + Math.floor(v.z / cell));
        if (v.y < y0) y0 = v.y;
        if (v.y > y1) y1 = v.y;
      }
    });
    for (const k of occ) {
      const [ix, iz] = k.split(',').map(Number);
      colliders.push({ minX: ix * cell + 0.03, maxX: (ix + 1) * cell - 0.03, minZ: iz * cell + 0.03, maxZ: (iz + 1) * cell - 0.03, minY: y0, maxY: y1, active: true });
    }
  }
  // Cuerpo articulado asentado ARTICULACIÓN A ARTICULACIÓN:
  //  1) rayo vertical bajo la pelvis → la pelvis descansa en su apoyo
  //     (asiento, colchón, consola o suelo);
  //  2) cada articulación lanza su propio rayo: nunca queda por debajo del
  //     apoyo (no atraviesa muebles) y las de reposo de la postura se dejan
  //     caer sobre él si está cerca (cabeza sobre el escritorio, brazo sobre el
  //     colchón); un miembro que cuelga fuera del borde sigue colgando;
  //  3) settle() ajusta el contacto exacto de la malla resultante.
  function surfaceBelow(p, above, baseY) {
    _o.set(p[0], p[1] + above, p[2]);
    _ray.set(_o, _down);
    _ray.far = 8;
    const hit = _ray.intersectObjects(supportMeshes, false)[0];
    return hit ? Math.max(hit.point.y, baseY) : baseY;
  }
  function placeBody(pose, outfit, x, y, z, rotY, { collide = true, baseY = 0 } = {}) {
    group.updateMatrixWorld(true);
    const J = posedJoints(pose, x, y, z, rotY);
    const dy = surfaceBelow(J.pelvis, 0.25, baseY) + JOINT_R.pelvis - J.pelvis[1];
    for (const k in JOINT_R) J[k][1] += dy;
    const rest = new Set(REST[pose] || []);
    for (const k in JOINT_R) {
      if (k === 'pelvis') continue;
      const j = J[k], s0 = surfaceBelow(j, 0.2, baseY) + JOINT_R[k];
      if (j[1] < s0) j[1] = s0;
      else if (rest.has(k) && j[1] - s0 < 0.3) j[1] = s0;
    }
    const body = buildMannequin(J, outfit);
    settle(body, collide, baseY);
    return body;
  }
  function box(w, h, d, mat, x, y, z, o = {}) {
    const m = new THREE.Mesh(worldBox(w, h, d, o.tex ?? 2, x, y, z), mat);
    m.position.set(x, y, z);
    m.castShadow = o.cast ?? true;
    m.receiveShadow = o.receive ?? true;
    (o.parent ?? group).add(m);
    if (o.collide) colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, minY: y - h / 2, maxY: y + h / 2, active: true });
    if (o.support) { supports.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: y + h / 2 }); supportMeshes.push(m); }
    return m;
  }
  function addCollider(minX, maxX, minZ, maxZ, minY = -1, maxY = 3.5) {
    const c = { minX, maxX, minZ, maxZ, minY, maxY, active: true };
    colliders.push(c);
    return c;
  }
  // Cilindro vertical (tanques, pedestales, consolas): sin esquinas fantasma.
  function addCircle(cx, cz, r, minY = -1, maxY = 3.5) {
    const c = { cx, cz, r, minX: cx - r, maxX: cx + r, minZ: cz - r, maxZ: cz + r, minY, maxY, active: true };
    colliders.push(c);
    return c;
  }
  const emissiveMat = (color, intensity = 3) =>
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity });
  // Fuente de luz lógica (el pool del motor decide cuáles se encienden de verdad).
  function addLight(x, y, z, color, base, mode, o = {}) {
    const f = {
      pos: new THREE.Vector3(x, y, z), color: new THREE.Color(color), base, distance: o.distance ?? 9,
      mat: o.mat ?? null, baseE: o.baseE ?? 4, mode, speed: o.speed ?? 1, seed: seedCounter++ * 7.31,
      power: 1, alarm: o.alarm ?? false,
    };
    lights.push(f);
    return f;
  }
  function addLamp(x, y, z, color, base, mode, o = {}) {
    const mat = emissiveMat(color, 4);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(o.w ?? 0.45, 0.06, o.d ?? 1.1), mat);
    lamp.position.set(x, y - 0.03, z);
    group.add(lamp);
    const housing = new THREE.Mesh(new THREE.BoxGeometry((o.w ?? 0.45) + 0.12, 0.08, (o.d ?? 1.1) + 0.12), M.dark);
    housing.position.set(x, y + 0.01, z);
    group.add(housing);
    const f = addLight(x, y - 0.4, z, color, base, mode, { ...o, mat, alarm: o.alarm ?? true });
    f.mesh = lamp;
    return f;
  }
  function addEmissiveFlicker(mat, baseE, mode, speed = 1, seed = seedCounter++ * 3.7) {
    lights.push({ pos: null, base: 0, mat, baseE, mode, speed, seed, power: 1 });
  }
  // Baliza de emergencia: domo rojo + dos haces giratorios. Apagada hasta la alerta.
  // Baliza de pared: placa a ras del panel, brazo y cuerpo giratorio separado del
  // muro. (x, y, z) es sólo una pista: mountWallFixtures() busca el panel más
  // cercano, lee la normal geométrica de su cara y la coloca sobre la superficie.
  const BEACON_D = 0.19; // distancia del centro de la baliza al muro
  function addBeacon(x, y, z) {
    const domeMat = emissiveMat(0xff1a0a, 0);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.08, 16), M.dark);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    dome.position.y = 0.04;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.2), M.dark);
    plate.position.x = -BEACON_D + 0.011;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(BEACON_D - 0.02, 0.035, 0.06), M.dark);
    arm.position.set((-BEACON_D + 0.02) / 2, -0.0575, 0);
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.add(base, dome, plate, arm);
    const beamMat = createBeamMaterial(0xff2010);
    const spin = new THREE.Group();
    spin.position.y = 0.07;
    const beamGeo = new THREE.ConeGeometry(0.9, 3.2, 20, 1, true);
    beamGeo.translate(0, -1.6, 0);
    beamGeo.rotateZ(Math.PI / 2);
    const b1 = new THREE.Mesh(beamGeo, beamMat), b2 = new THREE.Mesh(beamGeo, beamMat);
    b2.rotation.y = Math.PI;
    spin.add(b1, b2);
    holder.add(spin);
    group.add(holder);
    const f = addLight(x, y, z, 0xff1a0a, 0, 'alarm', { mat: domeMat, baseE: 10, distance: 7 });
    beacons.push({ f, spin, beamMat, alertBase: 5, holder });
  }
  // Montaje en pared: rayos horizontales desde la pista en ±X/±Z contra los
  // paneles opacos (ambas caras, por si la pista cae dentro del muro); el
  // impacto más cercano da el punto y la normal de la cara (en mundo, hacia
  // la sala). La baliza queda a BEACON_D del panel y el haz se recorta en él.
  function mountWallFixtures() {
    group.updateMatrixWorld(true);
    const solids = [];
    const holders = new Set(beacons.map((b) => b.holder));
    group.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material) || !o.material.isMeshStandardMaterial || o.material.transparent || o.material.stencilWrite) return;
      for (let p = o; p; p = p.parent) if (holders.has(p)) return;
      solids.push(o);
    });
    // Cara doble TEMPORAL, restaurada por material (no por malla: los materiales
    // compartidos guardarían el valor ya modificado).
    const orig = new Map();
    for (const o of solids) if (!orig.has(o.material)) orig.set(o.material, o.material.side);
    for (const m of orig.keys()) m.side = THREE.DoubleSide;
    const rc = new THREE.Raycaster(), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]], nm = new THREE.Matrix3(), n = new THREE.Vector3();
    for (const b of beacons) {
      const h = b.holder, p = h.position.clone();
      let best = null;
      for (const [dx, dz] of dirs) {
        rc.set(p, new THREE.Vector3(dx, 0, dz));
        rc.far = 0.9;
        const hit = rc.intersectObjects(solids, false)[0];
        if (hit && hit.face && (!best || hit.distance < best.distance)) best = hit;
      }
      if (!best) continue;
      b.mount = best.object.geometry.type;
      n.copy(best.face.normal).applyMatrix3(nm.getNormalMatrix(best.object.matrixWorld));
      n.y = 0;
      if (n.lengthSq() < 1e-6) continue;
      n.normalize();
      if (n.dot(p.clone().sub(best.point)) < 0 && best.distance > 0.02) n.negate();
      // Si la pista estaba dentro del muro, la cara útil es la que mira a la sala.
      h.position.copy(best.point).addScaledVector(n, BEACON_D);
      h.position.y = p.y;
      h.rotation.y = Math.atan2(-n.z, n.x);
      b.f.pos.copy(h.position);
      b.beamMat.uniforms.uClipP.value.copy(best.point).addScaledVector(n, 0.001);
      b.beamMat.uniforms.uClipN.value.copy(n);
    }
    for (const [m, side] of orig) m.side = side;
  }
  function addSign(title, sub, w, h, x, y, z, ry, color) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: createSignTexture(title, sub, color), color: new THREE.Color(1.6, 1.6, 1.6) }));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    group.add(m);
  }
  // Terminal mural. `nx` = sentido de la normal (+1 mira a +X, -1 a -X).
  function addTerminal(x, y, z, nx) {
    const scr = createTerminalScreen();
    const body = box(0.12, 0.62, 0.48, M.dark, x - nx * 0.04, y, z);
    body.castShadow = false;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.25), scr.mat);
    screen.position.set(x + nx * 0.025, y + 0.08, z);
    screen.rotation.y = nx > 0 ? Math.PI / 2 : -Math.PI / 2;
    group.add(screen);
    const keys = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.32), emissiveMat(0x553311, 1));
    keys.position.set(x + nx * 0.04, y - 0.18, z);
    group.add(keys);
    return { pos: new THREE.Vector3(x + nx * 0.05, y, z), draw: scr.draw };
  }
  // Puerta: varias piezas que se interpolan entre posición cerrada y abierta.
  function makeDoor(parts, collider, progress, speed = 0.6) {
    for (const p of parts) p.mesh.position.lerpVectors(p.closed, p.open, progress);
    collider.active = progress < 0.7;
    return { parts, collider, progress, target: progress, speed, statusMats: [] };
  }
  function doorPart(w, h, d, mat, x, y, z, ox, oy, oz) {
    const mesh = box(w, h, d, mat, x, y, z);
    const band = new THREE.Mesh(new THREE.BoxGeometry(w * 1.001, 0.12, d * 1.05), M.hazard);
    band.position.y = -h / 2 + 0.35;
    mesh.add(band);
    return { mesh, closed: new THREE.Vector3(x, y, z), open: new THREE.Vector3(x + ox, y + oy, z + oz) };
  }
  function statusStrip(x, y, z, w, d, color) {
    const m = emissiveMat(color, 4);
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), m);
    s.position.set(x, y, z);
    group.add(s);
    return m;
  }

  // ----------------------------------------------------- Tubo de acople
  const AZ0 = LEVEL.hatchZ, AZ1 = LEVEL.airlockEnd;
  const amid = (AZ0 + AZ1) / 2, alen = AZ1 - AZ0;
  box(2.6, 0.2, alen, M.floor, 0, -0.1, amid);
  box(2.6, 0.2, alen, M.ceil, 0, 2.9, amid);
  box(T, 2.8, alen, M.wall, -1.3 - T / 2, 1.4, amid, { collide: true });
  box(T, 2.8, alen, M.wall, 1.3 + T / 2, 1.4, amid, { collide: true });
  box(2.6 + 2 * T, 3.0, T, M.hazard, 0, 1.4, AZ1 + T / 2, { collide: true, tex: 0.8 });
  const portDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.06, 40), M.door);
  portDisc.rotation.x = Math.PI / 2;
  portDisc.position.set(0, 1.35, AZ1 - 0.03);
  group.add(portDisc);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8), M.dark);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(Math.cos(a) * 0.72, 1.35 + Math.sin(a) * 0.72, AZ1 - 0.07);
    group.add(bolt);
  }
  const beaconMat = emissiveMat(0xff9a20, 0);
  const beaconMesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 8), beaconMat);
  beaconMesh.position.set(0, 2.6, AZ0 + 0.25);
  group.add(beaconMesh);
  const beaconLight = addLight(0, 2.4, AZ0 + 0.6, 0xff9a20, 0, 'steady', { distance: 6 });
  const airlockLamp = addLamp(0, 2.8, 2.4, 0x9fb8ff, 2.5, 'flicker', { w: 0.8, d: 0.3, distance: 5, alarm: false });

  // ----------------------------------------------- Muro y escotilla
  const R = LEVEL.room, RW = R.halfW;
  const HW = 0.9, HH = 2.4;
  box(RW + T - HW, R.h + 0.2, 0.3, M.wall, -(HW + (RW + T - HW) / 2), R.h / 2, AZ0, { collide: true });
  box(RW + T - HW, R.h + 0.2, 0.3, M.wall, HW + (RW + T - HW) / 2, R.h / 2, AZ0, { collide: true });
  box(2 * HW, R.h + 0.2 - HH, 0.3, M.wall, 0, (HH + R.h + 0.2) / 2, AZ0);
  box(0.16, HH, 0.36, M.hazard, -HW - 0.08, HH / 2, AZ0, { tex: 0.8 });
  box(0.16, HH, 0.36, M.hazard, HW + 0.08, HH / 2, AZ0, { tex: 0.8 });
  box(2 * HW + 0.32, 0.16, 0.36, M.hazard, 0, HH + 0.08, AZ0, { tex: 0.8 });
  const hatchL = doorPart(HW, HH, 0.12, M.door, -HW / 2, HH / 2, AZ0, -HW * 0.98, 0, 0);
  const hatchR = doorPart(HW, HH, 0.12, M.door, HW / 2, HH / 2, AZ0, HW * 0.98, 0, 0);
  const hatch = makeDoor([hatchL, hatchR], addCollider(-HW, HW, AZ0 - 0.15, AZ0 + 0.15), 0, 0.5);
  hatch.statusMats.push(statusStrip(0, HH + 0.25, AZ0 - 0.2, 0.6, 0.05, 0xff2010));

  // ------------------------------------------- Sala de descompresión
  const rz0 = R.z0, rz1 = R.z1, rmid = (rz0 + rz1) / 2, rlen = rz0 - rz1;
  box(2 * RW + 2 * T, 0.2, rlen, M.floor, 0, -0.1, rmid);
  box(2 * RW + 2 * T, 0.2, rlen, M.ceil, 0, R.h + 0.1, rmid);
  box(T, R.h + 0.2, rlen, M.wall, -RW - T / 2, R.h / 2, rmid, { collide: true });
  box(T, R.h + 0.2, rlen, M.wall, RW + T / 2, R.h / 2, rmid, { collide: true });
  const DH = R.doorHalfW;
  const fwW = RW + T - DH;
  box(fwW, R.h + 0.2, T, M.wall, -(DH + fwW / 2), R.h / 2, rz1 - T / 2, { collide: true });
  box(fwW, R.h + 0.2, T, M.wall, DH + fwW / 2, R.h / 2, rz1 - T / 2, { collide: true });
  box(2 * DH, R.h + 0.2 - R.doorH, T, M.wall, 0, (R.doorH + R.h + 0.2) / 2, rz1 - T / 2);
  box(0.14, R.doorH, T + 0.1, M.hazard, -DH - 0.07, R.doorH / 2, rz1 - T / 2, { tex: 0.8 });
  box(0.14, R.doorH, T + 0.1, M.hazard, DH + 0.07, R.doorH / 2, rz1 - T / 2, { tex: 0.8 });
  const d0L = doorPart(DH, R.doorH, 0.12, M.door, -DH / 2, R.doorH / 2, rz1 - T / 2, -DH * 0.98, 0, 0);
  const d0R = doorPart(DH, R.doorH, 0.12, M.door, DH / 2, R.doorH / 2, rz1 - T / 2, DH * 0.98, 0, 0);
  const d0 = makeDoor([d0L, d0R], addCollider(-DH, DH, rz1 - T, rz1), 0, 0.7);
  d0.statusMats.push(statusStrip(0, R.doorH + 0.2, rz1 + 0.02, 0.6, 0.05, 0xff2010));
  d0.statusMats.push(statusStrip(0, R.doorH + 0.2, rz1 - T - 0.02, 0.6, 0.05, 0xff2010));

  // Taquillas (izquierda), una abierta.
  for (let k = 0; k < 5; k++) {
    const lz = -1.2 - k * 0.7;
    const lk = box(0.55, 2.0, 0.66, M.crate, -RW + 0.28, 1.0, lz);
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.25, 0.4), M.dark);
    vent.position.set(0.28, 0.55, 0);
    lk.add(vent);
    if (k === 2) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.9, 0.62), M.crate);
      door.position.set(-RW + 0.62, 1.0, lz - 0.3 + 0.24);
      door.rotation.y = -1.1;
      group.add(door);
    }
  }
  addCollider(-RW, -RW + 0.58, -4.25, -0.85);

  // Banco con la linterna y soporte de trajes vacío.
  box(0.5, 0.08, 2.4, M.dark, RW - 0.3, 0.45, -2.6, { support: true });
  box(0.06, 0.45, 0.06, M.dark, RW - 0.3, 0.22, -1.5);
  box(0.06, 0.45, 0.06, M.dark, RW - 0.3, 0.22, -3.7);
  box(0.08, 1.4, 2.4, M.heavy, RW - 0.05, 1.3, -2.6);
  addCollider(RW - 0.6, RW, -3.85, -1.35);
  for (let k = 0; k < 3; k++) {
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 12, Math.PI), M.pipe);
    hook.position.set(RW - 0.15, 2.0, -1.8 - k * 0.8);
    hook.rotation.y = Math.PI / 2;
    group.add(hook);
  }

  // Manómetros y rejillas de descompresión.
  for (let k = 0; k < 3; k++) {
    const g = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 20), M.dark);
    g.rotation.z = Math.PI / 2;
    g.position.set(RW - 0.03, 1.7 + (k % 2) * 0.25, -4.8 - k * 0.35);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.08, 20), emissiveMat(k === 1 ? 0xff3010 : 0xffd080, 1.2));
    face.position.set(RW - 0.06, g.position.y, g.position.z);
    face.rotation.y = -Math.PI / 2;
    group.add(g, face);
  }
  [-1.6, -5.4].forEach((vz) => {
    const grate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.6), M.dark);
    grate.position.set(1.6, R.h - 0.02, vz);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.5), emissiveMat(0xff8a30, 0.6));
    glow.rotation.x = Math.PI / 2;
    glow.position.set(1.6, R.h - 0.045, vz);
    group.add(grate, glow);
  });

  // Proyector holográfico de techo + emisor de suelo enrasado (sin colisión:
  // el paso queda completamente libre).
  const HP = LEVEL.holo;
  const projHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.2, 0.2, 24), M.dark);
  projHousing.position.set(HP.x, R.h - 0.1, HP.z);
  const lensMat = emissiveMat(0x4fc3ff, 0.4);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.14, 24), lensMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(HP.x, R.h - 0.205, HP.z);
  const floorRingMat = emissiveMat(0x4fc3ff, 0.5);
  const floorRing = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.52, 48), floorRingMat);
  floorRing.rotation.x = -Math.PI / 2;
  floorRing.position.set(HP.x, 0.004, HP.z);
  const grille = new THREE.Mesh(new THREE.CircleGeometry(0.45, 48), M.dark);
  grille.rotation.x = -Math.PI / 2;
  grille.position.set(HP.x, 0.003, HP.z);
  group.add(projHousing, lens, floorRing, grille);
  const holoLight = addLight(HP.x, 1.6, HP.z + 0.5, 0x4fb4ff, 0, 'steady', { distance: 6 });

  addSign('ESCLUSA 2', 'DESCOMPRESIÓN // SECTOR C', 1.3, 0.32, RW - 0.01, 2.55, -5.6, -Math.PI / 2);
  const roomLamp = addLamp(0.8, R.h, -1.0, 0xffc58a, 6, 'flicker');
  addLamp(0.8, R.h, -5.6, 0xffd2a0, 0, 'dead');
  addBeacon(RW - 0.02, 2.75, -6.5);

  // ------------------------------------------------------------- Pasillo
  const C = LEVEL.corr, X = C.halfW, W = 2 * X;
  const cz0 = C.z0, cz1 = C.z1, clen = cz0 - cz1, cmid = (cz0 + cz1) / 2;
  const B = LEVEL.breach, O = LEVEL.office, W1 = LEVEL.win1, W2 = LEVEL.win2;
  box(W + 2 * T, 0.2, clen, M.floor, 0, -0.1, cmid);
  const ceilY = C.h + 0.1;
  box(W + 2 * T, 0.2, cz0 - B.z0, M.ceil, 0, ceilY, (cz0 + B.z0) / 2);
  box(W + 2 * T, 0.2, B.z1 - cz1, M.ceil, 0, ceilY, (B.z1 + cz1) / 2);
  box(X + T - B.x1, 0.2, B.z0 - B.z1, M.ceil, (B.x1 + X + T) / 2, ceilY, (B.z0 + B.z1) / 2);

  // Muro derecho con hueco para la oficina de seguridad.
  const SW = LEVEL.stair;
  box(T, 3.2, cz0 - SW.doorZ0, M.wall, X + T / 2, 1.5, (cz0 + SW.doorZ0) / 2, { collide: true });
  box(T, 3.2, SW.doorZ1 - O.doorZ0, M.wall, X + T / 2, 1.5, (SW.doorZ1 + O.doorZ0) / 2, { collide: true });
  box(T, 0.6, SW.doorZ0 - SW.doorZ1, M.wall, X + T / 2, 2.8, (SW.doorZ0 + SW.doorZ1) / 2);
  box(T + 0.08, 2.5, 0.12, M.hazard, X + T / 2, 1.25, SW.doorZ0 - 0.06, { tex: 0.8 });
  box(T + 0.08, 2.5, 0.12, M.hazard, X + T / 2, 1.25, SW.doorZ1 + 0.06, { tex: 0.8 });
  box(T, 3.2, O.doorZ1 - cz1, M.wall, X + T / 2, 1.5, (O.doorZ1 + cz1) / 2, { collide: true });
  box(T, 0.6, O.doorZ0 - O.doorZ1, M.wall, X + T / 2, 2.8, (O.doorZ0 + O.doorZ1) / 2);

  // Muro izquierdo con dos ventanales panorámicos hacia Marte.
  const leftWall = (z0, z1) => box(T, 3.2, z0 - z1, M.wall, -X - T / 2, 1.5, (z0 + z1) / 2, { collide: true });
  const windowSection = (w) => {
    const wm = (w.z0 + w.z1) / 2, wl = w.z0 - w.z1;
    box(T, w.y0 + 0.1, wl, M.wall, -X - T / 2, (w.y0 - 0.1) / 2, wm, { collide: true });
    box(T, 3.1 - w.y1, wl, M.wall, -X - T / 2, (w.y1 + 3.1) / 2, wm);
    box(0.24, 0.1, wl, M.dark, -X + 0.07, w.y0, wm);
    box(0.24, 0.1, wl, M.dark, -X + 0.07, w.y1, wm);
    for (let z = w.z0 - 2; z > w.z1 + 0.5; z -= 2) box(0.16, w.y1 - w.y0, 0.1, M.dark, -X + 0.02, (w.y0 + w.y1) / 2, z);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(wl, w.y1 - w.y0), M.glass);
    glass.rotation.y = Math.PI / 2;
    glass.position.set(-X - 0.08, (w.y0 + w.y1) / 2, wm);
    // El vidrio se dibuja el último (cola transparente), con prueba de profundidad.
    glass.renderOrder = 10;
    const mask = new THREE.Mesh(glass.geometry, M.mask);
    mask.position.copy(glass.position);
    mask.rotation.copy(glass.rotation);
    mask.renderOrder = 1; // tras el interior opaco y con prueba de profundidad
    group.add(mask);
    group.add(glass);
    const mat = createLightShaftMaterial(0xff5a2a, 0.06, new THREE.Vector3(-X - 0.3, 0.0, cz1), new THREE.Vector3(X - 0.02, 3.0, cz0));
    const shaft = new THREE.Mesh(createLightShaftGeometry(new THREE.Vector3(-X + 0.02, (w.y0 + w.y1) / 2, wm),
      new THREE.Vector3(0, 0, wl), new THREE.Vector3(0, w.y1 - w.y0, 0), MARS_LIGHT_DIR, 4.2, 1.15), mat);
    shaft.renderOrder = 3;
    group.add(shaft);
    shafts.push(mat);
    addLight(-0.9, 1.5, wm, 0xff5a30, 3, 'mars', { distance: 7 });
  };
  leftWall(cz0, W1.z0);
  windowSection(W1);
  leftWall(W1.z1, W2.z0);
  windowSection(W2);
  leftWall(W2.z1, cz1);

  // Costillas estructurales (no en ventanales, colapso ni puerta de la oficina).
  const CL = LEVEL.collapse;
  for (let z = -8.5; z > cz1 + 0.5; z -= 3) {
    const inW = (w) => z < w.z0 + 0.4 && z > w.z1 - 0.4;
    if (z < CL.z0 + 0.5 && z > CL.z1) continue;
    if (!inW(W1) && !inW(W2)) box(0.26, 3.0, 0.35, M.dark, -X + 0.13, 1.5, z, { collide: true });
    if (!(z < O.doorZ0 + 0.5 && z > O.doorZ1 - 0.5) && !(z < SW.doorZ0 + 0.4 && z > SW.doorZ1 - 0.4)) box(0.26, 3.0, 0.35, M.dark, X - 0.13, 1.5, z, { collide: true });
    box(W, 0.3, 0.35, M.dark, 0, 2.85, z);
  }

  // Tuberías (las de la izquierda, reventadas en la brecha) y canaleta.
  const pipe = (r, x, y, z0, z1, mat) => {
    const g = new THREE.CylinderGeometry(r, r, z0 - z1, 12);
    g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, (z0 + z1) / 2);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    return m;
  };
  pipe(0.07, -1.2, 2.55, cz0, B.z0 + 0.4, M.pipe);
  pipe(0.07, -1.2, 2.55, B.z1 - 0.5, cz1, M.pipe);
  pipe(0.045, -1.0, 2.66, cz0, B.z0 + 0.4, M.pipe);
  pipe(0.045, -1.0, 2.66, B.z1 - 0.5, cz1, M.pipe);
  pipe(0.11, 1.05, 2.58, cz0, cz1, M.dark);
  const bent = pipe(0.07, -1.2, 2.2, B.z0 + 0.6, B.z0 - 0.2, M.pipe);
  bent.rotation.x = 0.9;
  box(0.3, 0.3, cz0 - SW.doorZ0 + 0.2, M.dark, X - 0.15, 0.15, (cz0 + SW.doorZ0 - 0.2) / 2, { collide: true });
  box(0.3, 0.3, SW.doorZ1 - 0.2 - O.doorZ0 - 0.2, M.dark, X - 0.15, 0.15, (SW.doorZ1 - 0.2 + O.doorZ0 + 0.2) / 2, { collide: true });
  box(0.3, 0.3, O.doorZ1 - 0.2 - cz1, M.dark, X - 0.15, 0.15, (O.doorZ1 - 0.2 + cz1) / 2, { collide: true });

  // Cables colgantes.
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7, metalness: 0.2 });
  const cable = (pts) => {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.025, 6), cableMat);
    m.castShadow = true;
    group.add(m);
  };
  cable([[0.7, 3.0, -13.4], [0.45, 2.2, -14.0], [-0.1, 2.1, -14.4], [-0.5, 3.0, -15.0]]);
  cable([[-0.2, 3.1, -21.2], [-0.25, 2.2, -21.4], [-0.3, 1.5, -21.5]]);
  cable([[1.0, 3.0, -40.8], [1.05, 2.3, -41.0], [1.1, 1.55, -41.1]]);

  // Iluminación del pasillo.
  const corridorLamps = [
    addLamp(0, 3.0, -12, 0xffc58a, 7, 'flicker'),
    addLamp(0, 3.0, -17, 0xffd2a0, 0, 'dead'),
    addLamp(0, 3.0, -32, 0xcfe0ff, 6, 'steady'),
    addLamp(0, 3.0, -38, 0xffd2a0, 0, 'dead'),
    addLamp(0, 3.0, -43, 0xff2a12, 8, 'pulse', { speed: 2.2 }),
  ];
  [-10, -26.5, -40].forEach((z) => addBeacon(X - 0.12, 2.7, z));
  addSign('SECTOR C', 'PASILLO PRINCIPAL // ESCLUSA 2 →', 1.2, 0.3, X - 0.01, 2.2, -8.0, -Math.PI / 2);

  // ------------------------------------------------- Sección colapsada
  const fl = rv() < 0.5 ? 1 : -1; // el colapso se reparte distinto en cada partida
  const slabZ = -20.3 + (rv() - 0.5) * 0.8;
  const slab = box(1.5, 0.08, 2.4, M.ceil, -0.8 * fl, 1.25, slabZ);
  slab.rotation.set(0.15, 0.1 * fl, 0.55 * fl);
  if (fl > 0) addCollider(-X, -0.15, slabZ - 1.1, slabZ + 1.1, 0, 2.2); else addCollider(0.15, X, slabZ - 1.1, slabZ + 1.1, 0, 2.2);
  const beam = box(3.8, 0.3, 0.3, M.dark, 0.0, 1.85, -22.9);
  beam.rotation.z = 0.5 * fl;
  if (fl > 0) addCollider(-X, -0.6, -23.1, -22.7, 0, 1.5); else addCollider(0.6, X, -23.1, -22.7, 0, 1.5);
  const rnd = mulberry32(77);
  for (let k = 0; k < 6; k++) {
    const s = 0.3 + rnd() * 0.45;
    const r = box(s, s * 0.8, s * 1.1, k % 2 ? M.crate : M.heavy, (0.65 + rnd() * 0.7) * fl, s * 0.35, -25.5 + (rnd() - 0.5) * 1.4);
    r.rotation.set(rnd() * 0.5, rnd() * 3, rnd() * 0.4);
  }
  if (fl > 0) addCollider(0.25, X, -26.4, -24.6, 0, 1.0); else addCollider(-X, -0.25, -26.4, -24.6, 0, 1.0);
  // Cascotes sueltos (instanciados, sin colisión).
  const rubble = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.heavy, 70);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), eul = new THREE.Euler();
  for (let i = 0; i < 70; i++) {
    const s = 0.04 + rnd() * 0.16;
    ps.set((rnd() - 0.5) * 3.0, s * 0.3, CL.z0 - rnd() * (CL.z0 - CL.z1));
    q.setFromEuler(eul.set(rnd() * 3, rnd() * 3, rnd() * 3));
    sc.set(s * (1 + rnd()), s * 0.5, s * (1 + rnd()));
    rubble.setMatrixAt(i, mtx.compose(ps, q, sc));
  }
  rubble.castShadow = rubble.receiveShadow = true;
  group.add(rubble);
  // Bordes desgarrados de la brecha y vigas expuestas.
  [[-1.2, -21.05, 0.7], [-0.3, -21.1, -0.5], [0.15, -24.4, 0.4], [-0.9, -24.45, -0.8]].forEach(([x, z, r]) => {
    const p = box(0.6, 0.04, 0.5, M.ceil, x, 2.95, z);
    p.rotation.set(r, 0, r * 0.6);
  });
  box(2.4, 0.22, 0.22, M.dark, -0.65, 3.45, -22.1);
  box(2.4, 0.22, 0.22, M.dark, -0.65, 3.45, -23.6);
  const sparkMat = emissiveMat(0x9fd0ff, 0);
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), sparkMat);
  spark.position.set(-0.3, 1.48, -21.5);
  group.add(spark);
  addEmissiveFlicker(sparkMat, 5, 'broken');
  // Lámpara colgante que oscila (la luz lógica sigue al cuerpo).
  const pivot = new THREE.Group();
  pivot.position.set(0.9, 3.0, -23.2);
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.9, 4), cableMat);
  wire.position.y = -0.45;
  const hangMat = emissiveMat(0xffc58a, 4);
  const hang = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.08, 0.6), hangMat);
  hang.position.y = -0.95;
  pivot.add(wire, hang);
  group.add(pivot);
  const hangLight = addLight(0.9, 2.0, -23.2, 0xffc58a, 6, 'broken', { mat: hangMat, alarm: true });
  animators.push((dt, t) => {
    const a = Math.sin(t * 0.9) * 0.32 + Math.sin(t * 2.3) * 0.04;
    pivot.rotation.z = a;
    hangLight.pos.set(0.9 + Math.sin(a) * 1.0, 3.0 - Math.cos(a) * 1.0, -23.2);
  });
  group.add(createDust(600, new THREE.Vector3(-X, 0, CL.z1), new THREE.Vector3(X, 3, CL.z0), 9, 0xc0a890));

  // --------------------------------------------- Compuerta blindada BD1
  const BZ = LEVEL.bulkheadZ;
  box(0.3, 3.0, 0.6, M.heavy, -X + 0.15, 1.5, BZ, { collide: true });
  box(0.3, 3.0, 0.6, M.heavy, X - 0.15, 1.5, BZ, { collide: true });
  box(W, 0.4, 0.6, M.heavy, 0, 2.8, BZ);
  box(0.06, 3.0, 0.62, M.hazard, -X + 0.33, 1.5, BZ, { tex: 0.8 });
  box(0.06, 3.0, 0.62, M.hazard, X - 0.33, 1.5, BZ, { tex: 0.8 });
  const bdPart = doorPart(W - 0.6, 2.6, 0.25, M.heavy, 0, 1.3, BZ, 0, 2.7, 0);
  const bd1 = makeDoor([bdPart], addCollider(-X, X, BZ - 0.15, BZ + 0.15), 1, 3.0);
  bd1.statusMats.push(statusStrip(0, 2.62, BZ + 0.31, 0.8, 0.02, 0x20ff50));
  bd1.statusMats.push(statusStrip(0, 2.62, BZ - 0.31, 0.8, 0.02, 0x20ff50));
  const t1 = addTerminal(X - 0.02, 1.35, -30.4, -1);
  t1.draw('COMPUERTA BD-1', 'ABIERTA', '#5aff8a');

  // Panel de energía de la compuerta de descompresión (lado pasillo).
  const power = addTerminal(X - 0.02, 1.35, -7.9, -1);
  power.draw('DESCOMPRESIÓN', 'EN LÍNEA', '#5aff8a');

  // --------------------------------------------- Oficina de seguridad
  const ox0 = X, ox1 = O.x1, ow = ox1 - ox0, ol = O.z0 - O.z1;
  const omx = (ox0 + ox1) / 2, omz = (O.z0 + O.z1) / 2;
  box(ow + T, 0.2, ol, M.floor, omx + T / 2, -0.1, omz);
  box(ow + T, 0.2, ol, M.ceil, omx + T / 2, 3.1, omz);
  box(T, 3.2, ol + 2 * T, M.wall, ox1 + T / 2, 1.5, omz, { collide: true });
  box(ow + T, 3.2, T, M.wall, omx + T / 2, 1.5, O.z0 + T / 2, { collide: true });
  box(ow + T, 3.2, T, M.wall, omx + T / 2, 1.5, O.z1 - T / 2, { collide: true });
  const odz = (O.doorZ0 + O.doorZ1) / 2;
  const offPart = doorPart(0.12, 2.5, O.doorZ0 - O.doorZ1, M.door, X + T / 2, 1.25, odz, 0, 0, -1.65);
  const office = makeDoor([offPart], addCollider(X, X + T, O.doorZ1, O.doorZ0), 0, 0.8);
  office.statusMats.push(statusStrip(X - 0.03, 2.58, odz, 0.04, 0.9, 0xff2010));
  const t0 = addTerminal(X - 0.02, 1.35, -34.5, -1);
  t0.draw('SEGURIDAD C-2', 'BLOQUEADA', '#ff5a3a');
  addSign('SEGURIDAD', 'OFICINA C-2 // AUTORIZADOS', 1.2, 0.3, X - 0.01, 2.82, odz - 1.4, -Math.PI / 2, '#ffb347');

  // Escritorio, monitores de vigilancia y un tripulante sin vida.
  // Escritorio: tablero sobre patas y faldón (las piernas caben debajo).
  box(0.8, 0.05, 2.0, M.dark, 4.6, 0.725, -35.2, { support: true });
  for (const lz of [-36.1, -34.3]) box(0.7, 0.7, 0.05, M.dark, 4.6, 0.35, lz);
  box(0.05, 0.5, 1.8, M.dark, 4.25, 0.45, -35.2);
  addCollider(4.2, 5.0, -36.2, -34.2);
  const staticMat = createStaticMaterial();
  for (let k = 0; k < 2; k++) {
    const mon = box(0.08, 0.36, 0.55, M.dark, 4.85, 0.98, -34.7 - k * 0.8);
    mon.castShadow = false;
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.31), staticMat);
    s.position.set(4.8, 0.98, -34.7 - k * 0.8);
    s.rotation.y = -Math.PI / 2;
    group.add(s);
  }
  for (let k = 0; k < 4; k++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.4), staticMat);
    s.position.set(ox1 - 0.01, 1.9 + (k % 2) * 0.46, -34.0 - Math.floor(k / 2) * 0.7);
    s.rotation.y = -Math.PI / 2;
    group.add(s);
  }
  addLight(5.9, 2.0, -34.4, 0x6fa0b0, 1.5, 'flicker', { distance: 5 });
  box(0.5, 0.45, 0.5, M.rubber, 5.45, 0.225, -35.2, { collide: true, support: true });
  box(0.08, 0.6, 0.5, M.rubber, 5.74, 0.75, -35.2);
  placeBody('slumped', 'uniform', 5.45, 0.3, -35.2, -Math.PI / 2, { collide: false });
  placeBody('sitting', 'eva', 1.02, 0.3, -15.6, -Math.PI / 2);
  placeBody('lying', 'labcoat', -3.4, 0.3, -70.2, 0.9);

  // Estantería con la célula de energía y armeros vacíos.
  [0.4, 1.0, 1.6].forEach((y) => box(2.4, 0.04, 0.5, M.dark, 4.0, y, O.z1 + 0.3, { support: true }));
  box(0.05, 1.9, 0.5, M.dark, 2.8, 0.95, O.z1 + 0.3);
  box(0.05, 1.9, 0.5, M.dark, 5.2, 0.95, O.z1 + 0.3);
  addCollider(2.75, 5.25, O.z1, O.z1 + 0.6);
  box(0.5, 2.0, 1.2, M.crate, ox1 - 0.25, 1.0, O.z0 - 1.0, { collide: true });
  const officeLamp = addLamp(4.0, 3.0, -37.5, 0xdfe8ff, 6, 'broken', { distance: 9 });
  const logOffice = addTerminal(ox1 - 0.02, 1.35, -37.6, -1);
  logOffice.draw('BITÁCORA', 'SEGURIDAD', '#7fd8ff');
  logTerms.push({ pos: logOffice.pos, id: 'seguridad' });
  addBeacon(ox1 - 0.12, 2.7, -38.5);

  // ------------------------------------------------ Nodo D (distribuidor)
  const Hb = LEVEL.hub, HXw = Hb.halfW, hz0 = Hb.z0, hz1 = Hb.z1, hmid = (hz0 + hz1) / 2, hlen = hz0 - hz1, HHt = Hb.h;
  const sz0 = Hb.sideZ0, sz1 = Hb.sideZ1, smid = (sz0 + sz1) / 2, swid = sz0 - sz1;
  box(2 * HXw + 2 * T, 0.2, hlen, M.floor, 0, -0.1, hmid);
  box(2 * HXw + 2 * T, 0.2, hlen, M.ceil, 0, HHt + 0.1, hmid);
  const hsw = HXw + T - X;
  for (const wz of [hz0 - T / 2, hz1 - T / 2]) {
    box(hsw, HHt + 0.2, T, M.wall, -(X + hsw / 2), HHt / 2, wz, { collide: true });
    box(hsw, HHt + 0.2, T, M.wall, X + hsw / 2, HHt / 2, wz, { collide: true });
    box(2 * X, HHt + 0.2 - 3.0, T, M.wall, 0, (3.0 + HHt + 0.2) / 2, wz);
  }
  for (const s of [-1, 1]) {
    const wx = s * (HXw + T / 2);
    box(T, HHt + 0.2, hz0 - sz0, M.wall, wx, HHt / 2, (hz0 + sz0) / 2, { collide: true });
    box(T, HHt + 0.2, sz1 - hz1, M.wall, wx, HHt / 2, (sz1 + hz1) / 2, { collide: true });
    box(T, HHt + 0.2 - 3.0, swid, M.wall, wx, (3.0 + HHt + 0.2) / 2, smid);
    box(T + 0.08, 3.0, 0.12, M.hazard, wx, 1.5, sz0 - 0.06, { tex: 0.8 });
    box(T + 0.08, 3.0, 0.12, M.hazard, wx, 1.5, sz1 + 0.06, { tex: 0.8 });
  }
  // Consola central con mapa holográfico de la nave (aristas a escala 1:90).
  const con = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.95, 8), M.dark);
  con.position.set(0, 0.475, hmid);
  const conTop = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.56, 0.08, 8), M.heavy);
  conTop.position.set(0, 0.99, hmid);
  const conRing = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.012, 6, 48), emissiveMat(0x4fc3ff, 3));
  conRing.rotation.x = Math.PI / 2;
  conRing.position.set(0, 1.035, hmid);
  [con, conTop].forEach((m) => { m.castShadow = m.receiveShadow = true; });
  group.add(con, conTop, conRing);
  addCircle(0, hmid, 0.7, 0, 1.4);
  const MAP_S = 1 / 90, MAP_CZ = -38;
  const mapG = new THREE.Group();
  mapG.position.set(0, 1.3, hmid);
  const edge = (c) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const edgeCyan = edge(new THREE.Color(0.3, 0.8, 1.4)), edgeOrange = edge(new THREE.Color(1.6, 0.6, 0.2));
  [[0, 2.2, 2.6, 2.4], [0, -3, 7, 8], [0, -26.5, 3.2, 39], [4.1, -36.5, 5, 9], [0, -50, 9, 8], [-8.4, -50, 7.3, 3.2],
    [-16, -50, 8, 10], [7.9, -50, 6.5, 3.2], [15, -50, 8, 10], [0, -59, 3.2, 10], [0, -71, 12, 14]].forEach(([cx, cz, w, d], i) => {
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w * MAP_S, 0.04, d * MAP_S)), i === 10 ? edgeOrange : edgeCyan);
    l.position.set(cx * MAP_S, 0, (cz - MAP_CZ) * MAP_S);
    mapG.add(l);
  });
  const mapDot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2, 0.6) }));
  mapG.add(mapDot);
  group.add(mapG);
  animators.push((dt, t) => { mapG.position.y = 1.3 + Math.sin(t * 1.2) * 0.01; });
  addLight(0, 1.6, hmid, 0x4fc3ff, 1.5, 'steady', { distance: 5 });
  addLamp(0, HHt, hmid + 2.2, 0xffd2a0, 6, 'flicker');
  addLamp(0, HHt, hmid - 2.2, 0xffd2a0, 0, 'dead');
  addBeacon(HXw - 0.12, 3.0, hz0 - 1.0);
  addBeacon(-HXw + 0.12, 3.0, hz1 + 1.0);
  addSign('LAB B-3', 'CUARENTENA BIOLÓGICA', 1.3, 0.3, 0, 3.2, hz1 + 0.01, 0);
  addSign('SERVIDORES', '← NÚCLEO DE DATOS', 1.2, 0.3, -HXw + 0.01, 2.3, sz0 + 0.9, Math.PI / 2);
  addSign('TRIPULACIÓN', 'DORMITORIOS · ARMERÍA →', 1.2, 0.3, HXw - 0.01, 2.3, sz0 + 0.9, -Math.PI / 2);
  group.add(createDust(300, new THREE.Vector3(-HXw, 0, hz1), new THREE.Vector3(HXw, HHt, hz0), 11));

  // ---------------------------------- Pasillo del laboratorio y cuarentena
  const LC = LEVEL.labCorr, lcmid = (LC.z0 + LC.z1) / 2, lclen = LC.z0 - LC.z1;
  box(W + 2 * T, 0.2, lclen, M.floor, 0, -0.1, lcmid);
  box(W + 2 * T, 0.2, lclen, M.ceil, 0, 3.1, lcmid);
  box(T, 3.2, lclen, M.wall, -X - T / 2, 1.5, lcmid, { collide: true });
  box(T, 3.2, lclen, M.wall, X + T / 2, 1.5, lcmid, { collide: true });
  for (const z of [-58.5, -61.5]) {
    box(0.26, 3.0, 0.35, M.dark, -X + 0.13, 1.5, z, { collide: true });
    box(0.26, 3.0, 0.35, M.dark, X - 0.13, 1.5, z, { collide: true });
    box(W, 0.3, 0.35, M.dark, 0, 2.85, z);
  }
  box(0.3, 0.3, lclen, M.dark, X - 0.15, 0.15, lcmid, { collide: true });
  pipe(0.07, -1.2, 2.55, LC.z0, LC.z1, M.pipe);
  pipe(0.11, 1.05, 2.58, LC.z0, LC.z1, M.dark);
  addLamp(0, 3.0, -60, 0xcfe0ff, 5, 'flicker');
  const QZ = LEVEL.qsZ;
  box(0.3, 3.0, 0.6, M.heavy, -X + 0.15, 1.5, QZ, { collide: true });
  box(0.3, 3.0, 0.6, M.heavy, X - 0.15, 1.5, QZ, { collide: true });
  box(W, 0.4, 0.6, M.heavy, 0, 2.8, QZ);
  box(0.06, 3.0, 0.62, M.hazard, -X + 0.33, 1.5, QZ, { tex: 0.8 });
  box(0.06, 3.0, 0.62, M.hazard, X - 0.33, 1.5, QZ, { tex: 0.8 });
  const qsPart = doorPart(W - 0.6, 2.6, 0.25, M.heavy, 0, 1.3, QZ, 0, 2.7, 0);
  const qs = makeDoor([qsPart], addCollider(-X, X, QZ - 0.15, QZ + 0.15), 0, 0.9);
  qs.statusMats.push(statusStrip(0, 2.62, QZ + 0.31, 0.8, 0.02, 0xff2010));
  qs.statusMats.push(statusStrip(0, 2.62, QZ - 0.31, 0.8, 0.02, 0xff2010));
  const qsInfo = addTerminal(X - 0.02, 1.35, QZ + 0.75, -1);
  qsInfo.draw('CUARENTENA', 'ACTIVA', '#ff5a3a');
  const t2 = addTerminal(X - 0.02, 1.35, QZ - 0.8, -1);
  t2.draw('CUARENTENA', 'EN ESPERA', '#ffb347');

  // ------------------------------------------------- Ala oeste: servidores
  const pipeX = (r, z, y, x0, x1, mat) => {
    const g = new THREE.CylinderGeometry(r, r, Math.abs(x1 - x0), 12);
    g.rotateZ(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set((x0 + x1) / 2, y, z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  };
  const SR = LEVEL.server, CQ = LEVEL.crew;
  function branch(x0, x1, lampMode) {
    const len = Math.abs(x1 - x0), mx = (x0 + x1) / 2;
    box(len, 0.2, swid + 2 * T, M.floor, mx, -0.1, smid);
    box(len, 0.2, swid + 2 * T, M.ceil, mx, 3.1, smid);
    box(len, 3.2, T, M.wall, mx, 1.5, sz0 + T / 2, { collide: true });
    box(len, 3.2, T, M.wall, mx, 1.5, sz1 - T / 2, { collide: true });
    for (const fx of [mx - len / 4, mx + len / 4]) {
      box(0.35, 3.0, 0.26, M.dark, fx, 1.5, sz0 - 0.13, { collide: true });
      box(0.35, 3.0, 0.26, M.dark, fx, 1.5, sz1 + 0.13, { collide: true });
      box(0.35, 0.3, swid, M.dark, fx, 2.85, smid);
    }
    pipeX(0.08, sz0 - 0.4, 2.6, x0, x1, M.pipe);
    pipeX(0.05, sz0 - 0.4, 2.42, x0, x1, M.pipe);
    addLamp(mx, 3.0, smid, 0xbfd8ff, lampMode === 'dead' ? 0 : 5, lampMode, { w: 1.0, d: 0.4 });
  }
  branch(-HXw - T, SR.x0, 'broken');
  branch(HXw + T, CQ.x0, 'dead');

  // Habitación genérica con vano hacia el ramal en el muro `doorSide` (-1/+1 en X).
  function room(R, doorSide) {
    const mx = (R.x0 + R.x1) / 2, mz = (R.z0 + R.z1) / 2, wx = Math.abs(R.x1 - R.x0), lz = R.z0 - R.z1;
    box(wx + 2 * T, 0.2, lz + 2 * T, M.floor, mx, -0.1, mz);
    box(wx + 2 * T, 0.2, lz + 2 * T, M.ceil, mx, R.h + 0.1, mz);
    box(wx + 2 * T, R.h + 0.2, T, M.wall, mx, R.h / 2, R.z0 + T / 2, { collide: true });
    box(wx + 2 * T, R.h + 0.2, T, M.wall, mx, R.h / 2, R.z1 - T / 2, { collide: true });
    const farX = doorSide < 0 ? Math.max(R.x0, R.x1) : Math.min(R.x0, R.x1);
    const nearX = doorSide < 0 ? Math.min(R.x0, R.x1) : Math.max(R.x0, R.x1);
    box(T, R.h + 0.2, lz + 2 * T, M.wall, farX + Math.sign(farX - mx) * T / 2, R.h / 2, mz, { collide: true });
    const dx = nearX + Math.sign(nearX - mx) * T / 2;
    box(T, R.h + 0.2, R.z0 - sz0, M.wall, dx, R.h / 2, (R.z0 + sz0) / 2, { collide: true });
    box(T, R.h + 0.2, sz1 - R.z1, M.wall, dx, R.h / 2, (sz1 + R.z1) / 2, { collide: true });
    box(T, R.h + 0.2 - 3.0, swid, M.wall, dx, (3.0 + R.h + 0.2) / 2, smid);
    return { mx, mz };
  }
  // Para el muro del vano, "near" es el lado que toca el ramal.
  const srC = room({ x0: SR.x1, x1: SR.x0, z0: SR.z0, z1: SR.z1, h: SR.h }, 1);

  // Bastidores de servidores con matrices de LEDs parpadeantes (shader).
  const ledMat = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 g = vUv * vec2(96.0, 28.0), id = floor(g), f = fract(g) - 0.5;
        float cx = fract(vUv.x * 6.0);
        float cab = step(0.04, cx) * step(cx, 0.96);
        float on = step(0.45, h(id + floor(uTime * (1.0 + h(id) * 6.0)) * 0.37));
        float led = (1.0 - smoothstep(0.16, 0.32, length(f))) * on * cab * step(0.5, h(id * 1.7));
        vec3 col = mix(vec3(0.2, 1.0, 0.45), vec3(1.0, 0.6, 0.15), step(0.85, h(id + 3.1)));
        col = mix(col, vec3(0.3, 0.7, 1.0), step(0.93, h(id + 7.7)));
        gl_FragColor = vec4(vec3(0.012, 0.016, 0.02) * cab + col * led * 2.0, 1.0);
      }`,
  });
  for (const rx of [-14.3, -17.7]) {
    box(0.9, 2.3, 7.4, M.dark, rx, 1.15, srC.mz, { collide: true });
    box(0.95, 0.12, 7.45, M.heavy, rx, 2.36, srC.mz);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.9), ledMat);
      p.position.set(rx + s * 0.452, 1.2, srC.mz);
      p.rotation.y = s * Math.PI / 2;
      group.add(p);
    }
  }
  cable([[-14.3, 2.4, -48], [-15.2, 3.05, -48.5], [-16.8, 3.05, -48.5], [-17.7, 2.4, -48]]);
  cable([[-14.3, 2.4, -52], [-16, 2.6, -52.3], [-17.7, 2.4, -52]]);
  const tsr = addTerminal(SR.x1 + 0.02, 1.35, srC.mz, 1);
  tsr.draw('NÚCLEO DE DATOS', 'CUARENTENA', '#ff5a3a');
  addLamp(srC.mx, SR.h, srC.mz, 0x9fc8ff, 5, 'flicker', { w: 0.6, d: 2.0 });
  addLight(srC.mx, 1.2, srC.mz, 0x40ff90, 1.5, 'steady', { distance: 6 });
  addBeacon(SR.x1 + 0.12, 2.8, SR.z0 - 1.0);
  const logServer = addTerminal(SR.x1 + 0.02, 1.35, srC.mz + 2.6, 1);
  logServer.draw('REGISTRO', 'SISTEMA', '#7fd8ff');
  logTerms.push({ pos: logServer.pos, id: 'sistema' });
  addSign('NÚCLEO DE DATOS', 'CONTROL DE CUARENTENA', 1.4, 0.32, SR.x1 + 0.01, 2.6, srC.mz - 2.2, Math.PI / 2);
  group.add(createDust(350, new THREE.Vector3(SR.x1, 0, SR.z1), new THREE.Vector3(SR.x0, SR.h, SR.z0), 13, 0x9fd8ff));

  // --------------------------------- Ala este: compuerta atascada y dormitorios
  const jamX = 8.6;
  box(0.4, 3.0, 0.3, M.heavy, jamX, 1.5, sz0 - 0.15, { collide: true });
  box(0.4, 3.0, 0.3, M.heavy, jamX, 1.5, sz1 + 0.15, { collide: true });
  box(0.4, 0.4, swid, M.heavy, jamX, 2.8, smid);
  const jam = box(0.14, 2.6, swid - 0.3, M.door, jamX, 1.3, smid + 1.75);
  jam.rotation.x = 0.03;
  addCollider(jamX - 0.07, jamX + 0.07, smid + 0.3, sz0);
  const jamSparkMat = emissiveMat(0xffd080, 0);
  const jamSpark = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), jamSparkMat);
  jamSpark.position.set(jamX, 1.8, smid + 0.32);
  group.add(jamSpark);
  addEmissiveFlicker(jamSparkMat, 6, 'broken');
  const eFix = wallFixture(10.0, 2.96, smid, 0, 0xff3010, true);
  addLight(10.0, 2.7, smid, 0xff3010, 2, 'pulse', { speed: 1.4, distance: 6, mat: eFix, baseE: 3 });

  const cqC = room({ x0: CQ.x0, x1: CQ.x1, z0: CQ.z0, z1: CQ.z1, h: CQ.h }, -1);
  const mattress = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.95, metalness: 0 });
  for (const bx of [13.2, 17.0]) {
    box(2.0, 0.18, 0.9, mattress, bx, 0.45, CQ.z1 + 0.55, { support: true });
    box(2.0, 0.18, 0.9, mattress, bx, 1.55, CQ.z1 + 0.55, { support: true });
    for (const cx of [-0.97, 0.97]) for (const cz of [0.12, 0.98]) box(0.06, 2.0, 0.06, M.dark, bx + cx, 1.0, CQ.z1 + cz);
    box(2.0, 0.06, 0.06, M.dark, bx, 1.75, CQ.z1 + 0.98);
    addCollider(bx - 1.05, bx + 1.05, CQ.z1, CQ.z1 + 1.05);
  }
  placeBody('lying', 'uniform', 13.2, 0.8, CQ.z1 + 0.55, Math.PI / 2, { collide: false });
  for (let k = 0; k < 4; k++) box(0.6, 2.0, 0.55, M.crate, CQ.x0 + 0.6 + k * 0.65, 1.0, CQ.z0 - 0.3);
  addCollider(CQ.x0 + 0.25, CQ.x0 + 3.0, CQ.z0 - 0.6, CQ.z0);
  box(2.4, 0.08, 1.0, M.heavy, 14.8, 0.75, cqC.mz, { support: true });
  for (const lx of [-1.05, 1.05]) box(0.08, 0.72, 0.8, M.dark, 14.8 + lx, 0.36, cqC.mz);
  box(2.4, 0.06, 0.35, M.dark, 14.8, 0.45, cqC.mz + 0.85);
  box(2.4, 0.06, 0.35, M.dark, 14.8, 0.45, cqC.mz - 0.85);
  addCollider(13.5, 16.1, cqC.mz - 1.1, cqC.mz + 1.1);
  for (let k = 0; k < 3; k++) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 12), M.pipe);
    cup.position.set(14.2 + k * 0.5, 0.84, cqC.mz + (k - 1) * 0.2);
    if (k === 2) { cup.rotation.z = Math.PI / 2; cup.position.y = 0.83; }
    group.add(cup);
  }
  // Armero en el muro este (aquí está el rifle de plasma).
  box(0.1, 2.0, 2.6, M.heavy, CQ.x1 - 0.05, 1.3, cqC.mz);
  box(0.4, 0.05, 2.2, M.dark, CQ.x1 - 0.25, 1.22, cqC.mz);
  for (const oz of [-0.75, 0.75]) {
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.12), emissiveMat(0x40d8ff, 0.4));
    slot.position.set(CQ.x1 - 0.11, 1.75, cqC.mz + oz);
    slot.rotation.y = -Math.PI / 2;
    group.add(slot);
  }
  addCollider(CQ.x1 - 0.45, CQ.x1, cqC.mz - 1.3, cqC.mz + 1.3);
  addLamp(cqC.mx, CQ.h, cqC.mz, 0xffd2a0, 6, 'broken');
  const armFix = wallFixture(CQ.x1 - 0.05, 2.4, cqC.mz, -Math.PI / 2, 0xff2a12);
  addLight(CQ.x1 - 0.35, 2.4, cqC.mz, 0xff2a12, 2.5, 'pulse', { speed: 1.2, distance: 6, mat: armFix, baseE: 3 });
  addBeacon(CQ.x1 - 0.12, 2.8, CQ.z0 - 1.2);
  const logCrew = addTerminal(CQ.x1 - 0.02, 1.35, CQ.z0 - 2.4, -1);
  logCrew.draw('DIARIO', 'TRIPULACIÓN', '#7fd8ff');
  logTerms.push({ pos: logCrew.pos, id: 'tripulacion' });
  addSign('ARMERÍA', 'ACCESO DE EMERGENCIA', 1.2, 0.3, CQ.x1 - 0.11, 2.55, cqC.mz, -Math.PI / 2);
  group.add(createDust(300, new THREE.Vector3(CQ.x0, 0, CQ.z1), new THREE.Vector3(CQ.x1, CQ.h, CQ.z0), 17));

  // ------------------------------------------------------- Laboratorio B-3
  const L = LEVEL.lab, LW = L.halfW, LH = L.h, LZ0 = L.z0, LZ1 = L.z1;
  const lmid = (LZ0 + LZ1) / 2, llen = LZ0 - LZ1;
  box(2 * LW + 2 * T, 0.2, llen, M.floor, 0, -0.1, lmid);
  box(2 * LW + 2 * T, 0.2, llen, M.ceil, 0, LH + 0.1, lmid);
  box(T, LH + 0.2, llen, M.wall, -LW - T / 2, LH / 2, lmid, { collide: true });
  box(T, LH + 0.2, llen, M.wall, LW + T / 2, LH / 2, lmid, { collide: true });
  box(2 * LW + 2 * T, LH + 0.2, T, M.wall, 0, LH / 2, LZ1 - T / 2, { collide: true });
  const fw = LW + T - X;
  box(fw, LH + 0.2, T, M.wall, -(X + fw / 2), LH / 2, LZ0 - T / 2, { collide: true });
  box(fw, LH + 0.2, T, M.wall, X + fw / 2, LH / 2, LZ0 - T / 2, { collide: true });
  box(W, LH + 0.2 - 3, T, M.hazard, 0, (3 + LH + 0.2) / 2, LZ0 - T / 2, { tex: 0.8 });
  const labPart = doorPart(W, 3.0, 0.15, M.door, 0, 1.5, LZ0 - 0.1, 0, 2.6, 0);
  const lab = makeDoor([labPart], addCollider(-X, X, LZ0 - 0.2, LZ0), 0, 0.55);
  lab.statusMats.push(statusStrip(X - 0.03, 2.4, LZ0 + 0.5, 0.04, 0.5, 0xff2010));
  const keypad = addTerminal(X - 0.02, 1.35, LZ0 + 0.8, -1);
  keypad.draw('LAB B-3', 'INSERTE TARJETA', '#ffb347');
  addSign('LAB B-3', 'CONTENCIÓN GENÉTICA', 1.2, 0.3, X - 0.01, 2.2, LZ0 + 2.2, -Math.PI / 2);
  const logLab = addTerminal(-LW + 0.02, 1.35, LZ0 - 1.2, 1);
  logLab.draw('DIARIO', 'DRA. HALVORSEN', '#7fd8ff');
  logTerms.push({ pos: logLab.pos, id: 'laboratorio' });

  // Arco de descontaminación UV.
  const uvMat = emissiveMat(0x9a6aff, 3);
  [-1, 1].forEach((s) => {
    box(0.25, 3.0, 0.4, M.heavy, s * 1.75, 1.5, LZ0 - 1.4, { collide: true });
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 2.6, 0.12), uvMat);
    strip.position.set(s * 1.61, 1.5, LZ0 - 1.4);
    group.add(strip);
  });
  box(3.75, 0.3, 0.4, M.heavy, 0, 3.15, LZ0 - 1.4);
  addLight(0, 2.4, LZ0 - 1.4, 0x9a6aff, 2.5, 'pulse', { mat: uvMat, baseE: 3, speed: 1.3, distance: 5 });

  // Cámara de contención: vidrio cilíndrico abierto hacia el jugador.
  const CC = new THREE.Vector3(0, 0, LZ0 - 7);
  const chamberGlass = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 2.9, 48, 1, true, 0.6, Math.PI * 2 - 1.2), M.tankGlass);
  chamberGlass.position.set(CC.x, 1.6, CC.z);
  const cBase = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.45, 0.15, 48), M.dark);
  cBase.position.set(CC.x, 0.075, CC.z);
  const cCap = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.35, 0.3, 48), M.dark);
  cCap.position.set(CC.x, 3.2, CC.z);
  const ringMat = emissiveMat(0x40e8ff, 3);
  const cRing = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.025, 8, 64), ringMat);
  cRing.rotation.x = Math.PI / 2;
  cRing.position.set(CC.x, 3.04, CC.z);
  const cRing2 = cRing.clone();
  cRing2.position.y = 0.17;
  [cBase, cCap].forEach((m) => { m.castShadow = m.receiveShadow = true; });
  group.add(chamberGlass, cBase, cCap, cRing, cRing2);
  addCollider(-1.4, -0.72, CC.z - 1.3, CC.z + 1.0);
  addCollider(0.72, 1.4, CC.z - 1.3, CC.z + 1.0);
  addCollider(-1.4, 1.4, CC.z - 1.4, CC.z - 0.7);
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.45, 1.0, 24), M.dark);
  ped.position.set(CC.x, 0.5, CC.z - 0.2);
  ped.castShadow = ped.receiveShadow = true;
  group.add(ped);
  const chamberLight = addLight(CC.x, 2.6, CC.z + 0.3, 0x7fe8ff, 4, 'steady', { distance: 6, alarm: true });

  // Maletín de contención (modelo compartido con el brazo en primera persona).
  const briefcase = buildBriefcase();
  addEmissiveFlicker(briefcase.userData.glowMat, 5, 'pulse', 3);

  // Tanques de cultivo (uno roto, otro con un espécimen).
  const liquidMat = new THREE.MeshStandardMaterial({ color: 0x0a3a1a, emissive: 0x18ff6a, emissiveIntensity: 0.7, transparent: true, opacity: 0.55, depthWrite: false });
  const specimenMat = new THREE.MeshStandardMaterial({ color: 0x14201a, roughness: 0.7, metalness: 0.1 });
  [-4.5, -1.5, 1.5, 4.5].forEach((tx, k) => {
    const tz = LZ1 + 1.3, broken = k === 2;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.3, 32), M.dark);
    base.position.set(tx, 0.15, tz);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.6, 0.3, 32), M.dark);
    cap.position.set(tx, 2.85, tz);
    const gh = broken ? 0.9 : 2.4;
    const gl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, gh, 32, 1, true), M.tankGlass);
    gl.position.set(tx, 0.3 + gh / 2, tz);
    const lh = broken ? 0.2 : 2.1;
    const lq = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, lh, 24), liquidMat);
    lq.position.set(tx, 0.3 + lh / 2, tz);
    const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, LH - 3, 8), M.pipe);
    feed.position.set(tx, 3 + (LH - 3) / 2, tz);
    [base, cap, feed].forEach((m) => { m.castShadow = m.receiveShadow = true; });
    group.add(base, cap, gl, lq, feed);
    addCircle(tx, tz, 0.66, 0, 3.1);
    if (k === 1) {
      // Espécimen encogido apoyado en el fondo del tanque (no flota).
      placeBody('fetal', 'specimen', tx, 0.6, tz, 0.4, { collide: false, baseY: 0.3 });
    }
    if (broken) {
      const r2 = mulberry32(31);
      for (let s = 0; s < 9; s++) {
        const shard = new THREE.Mesh(new THREE.BoxGeometry(0.05 + r2() * 0.18, 0.006, 0.04 + r2() * 0.15), M.tankGlass);
        shard.position.set(tx + (r2() - 0.5) * 2.2, 0.005, tz + 0.5 + r2() * 1.4);
        shard.rotation.y = r2() * 6.28;
        group.add(shard);
      }
    }
  });

  // Bancos de trabajo con monitores.
  [-1, 1].forEach((s) => {
    box(1.0, 0.9, 6, M.dark, s * 5.4, 0.45, LZ0 - 6, { collide: true, support: true });
    for (let k = 0; k < 3; k++) {
      const mon = box(0.06, 0.38, 0.55, M.dark, s * 5.65, 1.12, LZ0 - 4 - k * 2);
      mon.rotation.y = s * 0.15;
      const scrMat = emissiveMat(k === 1 ? 0x30ff90 : 0x2a8cff, k === 2 ? 0 : 1.3);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), scrMat);
      scr.position.set(s * 5.61, 1.12, LZ0 - 4 - k * 2);
      scr.rotation.y = -s * Math.PI / 2 + s * 0.15;
      group.add(scr);
      if (k === 0) addEmissiveFlicker(scrMat, 1.3, 'flicker', 2);
    }
  });
  addLight(0, 1.8, LZ1 + 2.5, 0x30ff80, 5, 'steady', { distance: 10 });
  const labLamp = addLamp(0, LH, LZ0 - 3.5, 0xdfe8ff, 9, 'broken', { distance: 12, w: 0.6, d: 1.6 });
  addBeacon(LW - 0.12, 3.3, LZ0 - 4);
  addBeacon(-LW + 0.12, 3.3, LZ0 - 10);

  // Polvo en suspensión.
  group.add(createDust(900, new THREE.Vector3(-X, 0, cz1), new THREE.Vector3(X, 3, cz0)));
  group.add(createDust(400, new THREE.Vector3(-RW, 0, rz1), new THREE.Vector3(RW, R.h, rz0), 5));
  group.add(createDust(500, new THREE.Vector3(-LW, 0, LZ1), new THREE.Vector3(LW, LH, LZ0), 4, 0xa0ffc0));

  // ---------------------------------------------------------- Recogibles
  const marker = createMarkerMaterial();
  function addPickup(id, name, obj, x, y, z, baseY, ry = 0) {
    obj.position.set(x, y, z);
    obj.rotation.y = ry;
    obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    group.add(obj);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.24, 32), marker);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, baseY + 0.006, z);
    group.add(ring);
    pickups.push({ id, name, mesh: obj, ring, position: new THREE.Vector3(x, y, z), taken: false });
  }
  addPickup('linterna', 'LINTERNA TÁCTICA', buildFlashlight(), RW - 0.3, 0.525, -2.2, 0.49, 2.2);
  const cardSpots = [[4.35, 0.754, -35.9, 0.75], [4.6, 1.64, O.z1 + 0.3, 1.62], [14.2, 0.796, -50.2, 0.79]];
  const cs = cardSpots[Math.floor(rv() * cardSpots.length)];
  addPickup('tarjeta', 'TARJETA DE ACCESO B-3', buildCard(), cs[0], cs[1], cs[2], cs[3], rv() * 3);
  const cellSpots = [[4.0, 1.057, O.z1 + 0.3, 1.02], [15.3, 0.825, -49.8, 0.79], [-5.2, 0.92, LEVEL.lab.z0 - 4.0, 0.9]];
  const ce = cellSpots[Math.floor(rv() * cellSpots.length)];
  addPickup('celula', 'CÉLULA DE ENERGÍA', buildCell(), ce[0], ce[1], ce[2], ce[3], Math.PI / 2);
  addPickup('maletin', 'MALETÍN DE CONTENCIÓN ADN', briefcase, CC.x, 1.075, CC.z - 0.2, 1.0);
  const plasma = buildPlasma();
  addEmissiveFlicker(plasma.userData.coilMat, 3, 'pulse', 2.5);
  addPickup('plasma', 'RIFLE DE PLASMA HX-9', plasma, LEVEL.crew.x1 - 0.25, 1.31, cqC.mz, 1.245);

  addCircle(CC.x, CC.z - 0.2, 0.47, 0, 1.1);

  // ------------------------------------------------------------ Exterior
  // La nave exterior es un conjunto de módulos que ENVUELVEN cada estancia:
  // collar de acople, hábitat de proa, tubo dorsal octogonal, tambor nodal,
  // alas transversales con sus módulos, oficina adosada, cilindro habitable
  // del laboratorio y sección de motores. Todo pieza encaja sobre otra pieza:
  // no hay elementos flotantes. Desde dentro, el exterior sólo se dibuja a
  // través de los ventanales (máscara de stencil), así que lo que se ve por la
  // ventana es exactamente el chasis real.
  const ext = new THREE.Group();
  ext.name = 'exterior';
  group.add(ext);
  const XM = {
    hull: pbr(lib.hull, { envMapIntensity: 0.9 }),
    dark: pbr(lib.hull, { color: 0x7c776e, envMapIntensity: 0.9 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x2e3034, metalness: 0.85, roughness: 0.4, envMapIntensity: 0.8 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0x8a6a4a, metalness: 0.9, roughness: 0.35, envMapIntensity: 0.8 }),
    accent: pbr(lib.hazard),
    window: new THREE.MeshStandardMaterial({ color: 0x0c0806, metalness: 0.6, roughness: 0.38, emissive: 0x501608, emissiveIntensity: 0.5 }),
    solar: new THREE.MeshStandardMaterial({ map: lib.solar, metalness: 0.5, roughness: 0.32, envMapIntensity: 1.2 }),
    fin: new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.7, roughness: 0.5, emissive: 0x6a1e06, emissiveIntensity: 0.55 }),
    scorch: new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 0.95, metalness: 0.2, emissive: 0x3a0e02, emissiveIntensity: 0.4, side: THREE.DoubleSide }),
  };
  const addX = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); ext.add(m); return m; };
  const flatGeo = (g) => { const n = g.toNonIndexed(); n.computeVertexNormals(); return n; };
  const OCT = Math.cos(Math.PI / 8);
  const chamferShape = (hu, y0, y1, ch) => {
    const s = new THREE.Shape();
    [[-hu + ch, y0], [hu - ch, y0], [hu, y0 + ch], [hu, y1 - ch], [hu - ch, y1], [-hu + ch, y1], [-hu, y1 - ch], [-hu, y0 + ch]]
      .forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    return s;
  };
  // Prisma achaflanado a lo largo de Z (sección X-Y) y de X (sección Z-Y).
  function chamferZ(hw, y0, y1, ch, z0, z1, mat) {
    const g = new THREE.ExtrudeGeometry(chamferShape(hw, y0, y1, ch), { depth: z0 - z1, bevelEnabled: false });
    scaleUV(g, 0.25, 0.25);
    return addX(g, mat, 0, 0, z1);
  }
  function chamferX(hd, cz, y0, y1, ch, x0, x1, mat) {
    const g = new THREE.ExtrudeGeometry(chamferShape(hd, y0, y1, ch), { depth: x1 - x0, bevelEnabled: false });
    scaleUV(g, 0.25, 0.25);
    g.rotateY(Math.PI / 2);
    return addX(g, mat, x0, 0, cz);
  }
  // Tubo octogonal con caras planas alineadas a los ejes.
  function octTube(a, len, axis, mat) {
    const R = a / OCT;
    const g = new THREE.CylinderGeometry(R, R, len, 8, 1, true); // abierto: sin tapas dentro del interior
    scaleUV(g, (16 * a * Math.tan(Math.PI / 8)) / 4, len / 4);
    if (axis === 'z') { g.rotateX(Math.PI / 2); g.rotateZ(Math.PI / 8); }
    else { g.rotateZ(Math.PI / 2); g.rotateX(Math.PI / 8); }
    return new THREE.Mesh(flatGeo(g), mat);
  }
  const SPA = 2.6, SPY = 1.5, SPR = SPA / OCT;

  // --- Collar de acople (envuelve el tubo de la esclusa) ---------------------
  const dockGeo = new THREE.CylinderGeometry(2.35, 2.35, 2.6, 24);
  scaleUV(dockGeo, 3.7, 0.65);
  dockGeo.rotateX(Math.PI / 2);
  addX(dockGeo, XM.hull, 0, 1.35, 2.1);
  const collarGeo = new THREE.CylinderGeometry(1.7, 1.9, 0.6, 40);
  collarGeo.rotateX(Math.PI / 2);
  addX(collarGeo, XM.accent, 0, 1.35, AZ1 + 0.3);
  addX(new THREE.TorusGeometry(1.62, 0.12, 12, 48), XM.trim, 0, 1.35, LEVEL.dockZ);
  const ringBandGeo = new THREE.TorusGeometry(2.36, 0.08, 8, 48);
  addX(ringBandGeo, XM.trim, 0, 1.35, 1.2);
  addX(ringBandGeo, XM.trim, 0, 1.35, 3.0);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const m = emissiveMat(k % 2 ? 0x20ff60 : 0xffffff, 0);
    addX(new THREE.SphereGeometry(0.07, 8, 6), m, Math.cos(a) * 1.92, 1.35 + Math.sin(a) * 1.92, LEVEL.dockZ - 0.1);
    addEmissiveFlicker(m, 10, 'blink', 1.2, k / 6);
  }

  // --- Hábitat de proa (sala de descompresión) --------------------------------
  chamferZ(4.2, -0.6, 3.9, 0.8, 1.4, -7.6, XM.hull);
  addX(new THREE.BoxGeometry(6.6, 0.24, 0.3), XM.trim, 0, 4.02, 1.25);
  const sideHatch = addX(new THREE.CylinderGeometry(0.8, 0.8, 0.12, 24), XM.trim, 4.24, 1.4, -3.0);
  sideHatch.rotation.z = Math.PI / 2;
  const sideRing = addX(new THREE.TorusGeometry(0.88, 0.07, 8, 32), XM.accent, 4.26, 1.4, -3.0);
  sideRing.rotation.y = Math.PI / 2;
  const mastF = addX(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 8), XM.trim, -1.6, 5.5, -5.0);
  const domeF = addX(new THREE.SphereGeometry(0.45, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), XM.dark, 1.6, 3.9, -4.0);
  [mastF, domeF].forEach((m) => m.updateMatrix());

  // --- Tubo dorsal y tubo del laboratorio --------------------------------------
  const spine = octTube(SPA, 37.4, 'z', XM.hull);
  spine.position.set(0, SPY, -25.9);
  ext.add(spine);
  const labTube = octTube(SPA, 10.9, 'z', XM.hull);
  labTube.position.set(0, SPY, -58.85);
  ext.add(labTube);
  // Bandas de refuerzo (fuera de los ventanales y de la brecha).
  const bandGeo = flatGeo((() => { const g = new THREE.CylinderGeometry(SPR * 1.035, SPR * 1.035, 0.45, 8, 1, true); g.rotateX(Math.PI / 2); g.rotateZ(Math.PI / 8); return g; })());
  [-8.6, -20.0, -27.4, -40.0, -43.6, -56.2, -61.8].forEach((z) => addX(bandGeo, XM.trim, 0, SPY, z));

  // Ventanales vistos desde fuera: vidrio oscuro con el resplandor interior.
  for (const w of [LEVEL.win1, LEVEL.win2]) {
    const wl = w.z0 - w.z1, wm = (w.z0 + w.z1) / 2;
    const glassX = addX(new THREE.PlaneGeometry(wl, w.y1 - w.y0), XM.window, -SPA - 0.012, (w.y0 + w.y1) / 2, wm);
    glassX.rotation.y = -Math.PI / 2;
    addX(new THREE.BoxGeometry(0.12, 0.12, wl + 0.2), XM.trim, -SPA - 0.03, w.y1 + 0.06, wm);
    addX(new THREE.BoxGeometry(0.12, 0.12, wl + 0.2), XM.trim, -SPA - 0.03, w.y0 - 0.06, wm);
    for (let z = w.z0 - 2; z > w.z1 + 0.5; z -= 2) addX(new THREE.BoxGeometry(0.1, w.y1 - w.y0, 0.1), XM.trim, -SPA - 0.03, (w.y0 + w.y1) / 2, z);
  }

  // Placas de blindaje superpuestas, apoyadas sobre las caras del octógono.
  const faces = [90, 45, 0, -45, -90, 135, -135, 180];
  const inWin = (z) => (z < LEVEL.win1.z0 + 0.6 && z > LEVEL.win1.z1 - 0.6) || (z < LEVEL.win2.z0 + 0.6 && z > LEVEL.win2.z1 - 0.6);
  const platesM = [];
  const pushPlates = (zStart, zEnd) => {
    for (const fdeg of faces) {
      const phi = THREE.MathUtils.degToRad(fdeg);
      for (let z = zStart; z > zEnd + 1; ) {
        const len = 1.4 + rnd() * 2.2;
        const zc = z - len / 2;
        z -= len + 0.25 + rnd() * 0.6;
        if (fdeg === 180 && inWin(zc)) continue;
        if ((fdeg === 90 || fdeg === 135) && zc < -20.4 && zc > -25.2) continue;
        if (fdeg === 0 && zc < -13.8 && zc > -26.2) continue;
        platesM.push([phi, zc, len, (rnd() - 0.5) * 0.3]);
      }
    }
  };
  pushPlates(-7.6, -44.2);
  pushPlates(-53.8, -64.0);
  const plates = new THREE.InstancedMesh(new THREE.BoxGeometry(1.55, 0.06, 1), XM.dark, platesM.length);
  const eulP = new THREE.Euler();
  platesM.forEach(([phi, zc, len, off], i) => {
    const nx = Math.cos(phi), ny = Math.sin(phi);
    ps.set(nx * (SPA + 0.03) - ny * off, SPY + ny * (SPA + 0.03) + nx * off, zc);
    q.setFromEuler(eulP.set(0, 0, phi - Math.PI / 2));
    sc.set(1, 1, len);
    plates.setMatrixAt(i, mtx.compose(ps, q, sc));
  });
  ext.add(plates);

  // Tuberías externas con abrazaderas sobre la cara superior-derecha.
  {
    const phi = Math.PI / 4, nx = Math.cos(phi), ny = Math.sin(phi), tx = -ny, ty = nx;
    [[0.13, -0.35], [0.08, 0.32]].forEach(([r, off]) => {
      const g = new THREE.CylinderGeometry(r, r, 36.6, 12);
      g.rotateX(Math.PI / 2);
      addX(g, XM.pipe, nx * (SPA + r) + tx * off, SPY + ny * (SPA + r) + ty * off, -25.9);
    });
    const clampGeo = new THREE.BoxGeometry(1.0, 0.1, 0.16);
    for (let z = -8.5; z > -44; z -= 2.4) {
      const c = addX(clampGeo, XM.trim, nx * (SPA + 0.28), SPY + ny * (SPA + 0.28), z);
      c.rotation.z = phi - Math.PI / 2;
    }
  }

  // Rótulo en la cara derecha y brecha calcinada sobre la sección colapsada.
  const decal = addX(new THREE.PlaneGeometry(11, 1.9),
    new THREE.MeshStandardMaterial({ map: createDecalTexture('ODISEA-IX', 'HELIX-ARES CORP  //  MÓDULO DE INVESTIGACIÓN GENÉTICA'), transparent: true, roughness: 0.75, metalness: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    SPA + 0.012, SPY, -20);
  decal.rotation.y = Math.PI / 2;
  {
    const sh = new THREE.Shape(), rb = mulberry32(19);
    const B = LEVEL.breach, cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2, r = 0.75 + rb() * 0.6;
      const px = cx + Math.cos(a) * r * 1.2, pz = cz + Math.sin(a) * r * 2.0;
      k ? sh.lineTo(px, -pz) : sh.moveTo(px, -pz);
    }
    const sg = new THREE.ShapeGeometry(sh);
    sg.rotateX(-Math.PI / 2);
    addX(sg, XM.scorch, 0, SPY + SPA + 0.015, 0);
    for (let k = 0; k < 5; k++) {
      const shard = addX(new THREE.BoxGeometry(0.5 + rb() * 0.5, 0.04, 0.4), XM.dark, cx + (rb() - 0.5) * 2.2, SPY + SPA + 0.15, cz + (rb() - 0.5) * 3.4);
      shard.rotation.set((rb() - 0.5) * 1.2, rb() * 3, (rb() - 0.5) * 1.2);
    }
  }

  // Luces de posición secuenciales en las aristas superiores del tubo dorsal.
  const runMat = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime },
    vertexShader: /* glsl */ `
      attribute float aIdx; uniform float uTime; varying float vI;
      void main() {
        float ph = fract(aIdx * 0.04 - uTime * 0.3);
        vI = 0.12 + 3.0 * exp(-ph * ph * 160.0) + 3.0 * exp(-(1.0 - ph) * (1.0 - ph) * 160.0);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `varying float vI; void main() { gl_FragColor = vec4(vec3(1.0, 0.7, 0.35) * vI, 1.0); }`,
  });
  const runPos = [];
  for (let z = -8; z > -44; z -= 1.5) for (const a of [67.5, 112.5]) runPos.push([a, z]);
  const run = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.3), runMat, runPos.length);
  const idx = new Float32Array(runPos.length);
  runPos.forEach(([a, z], i) => {
    const r = THREE.MathUtils.degToRad(a);
    ps.set(Math.cos(r) * SPR * 1.01, SPY + Math.sin(r) * SPR * 1.01, z); q.identity(); sc.set(1, 1, 1);
    run.setMatrixAt(i, mtx.compose(ps, q, sc));
    idx[i] = Math.floor(i / 2);
  });
  run.geometry.setAttribute('aIdx', new THREE.InstancedBufferAttribute(idx, 1));
  ext.add(run);

  // --- Tambor nodal (Nodo D) con paneles solares articulados ------------------
  const drumGeo = new THREE.CylinderGeometry(6.6, 6.6, 4.8, 40);
  scaleUV(drumGeo, 10.4, 1.2);
  addX(drumGeo, XM.hull, 0, 1.6, -50.1);
  addX(new THREE.CylinderGeometry(6.72, 6.72, 0.45, 40, 1, true), XM.trim, 0, 1.6, -50.1);
  addX(new THREE.CylinderGeometry(4.2, 5.2, 0.6, 40), XM.dark, 0, 4.3, -50.1);
  for (const a of [Math.PI * 0.75, -Math.PI * 0.25]) {
    const hx = Math.cos(a) * 6.62, hz = -50.1 + Math.sin(a) * 6.62;
    const hatchD = addX(new THREE.CylinderGeometry(0.75, 0.75, 0.1, 24), XM.trim, hx, 1.4, hz);
    hatchD.rotation.set(Math.PI / 2, 0, 0);
    hatchD.rotation.y = -a + Math.PI / 2;
    hatchD.rotateX(0);
    hatchD.lookAt(hx * 2, 1.4, -50.1 + (hz + 50.1) * 2);
    hatchD.rotateX(Math.PI / 2);
  }
  const solarJoints = [];
  for (const s of [-1, 1]) {
    const base = addX(new THREE.CylinderGeometry(0.22, 0.3, 3.0, 12), XM.trim, s * 3.2, 6.1, -50.1);
    base.castShadow = false;
    const joint = new THREE.Group();
    joint.position.set(s * 3.2, 7.7, -50.1);
    ext.add(joint);
    joint.add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), XM.trim));
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 13, 8), XM.trim);
    boom.rotation.z = Math.PI / 2;
    boom.position.x = s * 6.8;
    joint.add(boom);
    for (let k = 0; k < 3; k++) {
      const pnl = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.05, 7.0), XM.solar);
      pnl.position.x = s * (2.6 + k * 4.1);
      joint.add(pnl);
    }
    solarJoints.push(joint);
  }
  animators.push((dt, t) => { for (const j of solarJoints) j.rotation.x = 0.35 + Math.sin(t * 0.05) * 0.25; });
  const mastH = addX(new THREE.CylinderGeometry(0.08, 0.08, 4, 8), XM.trim, 0, 6.6, -52.5);
  const dishH = addX(new THREE.SphereGeometry(1.4, 24, 12, 0, Math.PI * 2, 0, 0.7), XM.dark, 0, 8.8, -52.5);
  dishH.rotation.set(-0.7, 0, 0.5);
  mastH.updateMatrix();

  // --- Alas: tubos transversales y módulos -------------------------------------
  for (const [x0, x1] of [[-12.0, -4.0], [4.0, 11.8]]) {
    const wt = octTube(SPA, x1 - x0, 'x', XM.hull);
    wt.position.set((x0 + x1) / 2, SPY, -50);
    ext.add(wt);
  }
  chamferX(5.6, -50, -0.6, 3.9, 0.8, -20.7, -11.3, XM.hull);
  chamferX(5.6, -50, -0.6, 3.9, 0.8, 11.3, 19.7, XM.hull);
  chamferX(4.9, -36.5, -0.5, 3.6, 0.6, 1.5, 7.3, XM.dark);
  // Aletas de refrigeración sobre los servidores y la oficina.
  const finGeo = new THREE.BoxGeometry(0.1, 1.2, 3.2);
  const fins = new THREE.InstancedMesh(finGeo, XM.fin, 22);
  q.identity();
  for (let i = 0; i < 22; i++) {
    if (i < 14) ps.set(-19.8 + i * 0.62, 4.5, -50); else ps.set(2.4 + (i - 14) * 0.62, 4.2, -36.5);
    sc.set(1, 1, i < 14 ? 1.6 : 1);
    fins.setMatrixAt(i, mtx.compose(ps, q, sc));
  }
  ext.add(fins);
  // Ojos de buey en el módulo de tripulación (pocos encendidos).
  const portholes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 16), new THREE.MeshBasicMaterial(), 8);
  const col = new THREE.Color();
  for (let i = 0; i < 8; i++) {
    ps.set(19.72, 2.2, -46.2 - i * 1.1); q.setFromEuler(eulP.set(0, 0, Math.PI / 2)); sc.set(1, 1, 1);
    portholes.setMatrixAt(i, mtx.compose(ps, q, sc));
    portholes.setColorAt(i, i % 3 === 1 ? col.setRGB(2.2, 1.1, 0.5) : col.setRGB(0.03, 0.03, 0.035));
  }
  ext.add(portholes);

  // --- Cilindro habitable del laboratorio --------------------------------------
  const labGeo = new THREE.CylinderGeometry(6.9, 6.9, 15, 40);
  scaleUV(labGeo, 10.8, 3.75);
  labGeo.rotateX(Math.PI / 2);
  addX(labGeo, XM.hull, 0, 1.9, -71.1);
  const labBand = new THREE.TorusGeometry(6.92, 0.14, 8, 64);
  [-64.4, -67.8, -71.1, -74.4, -77.8].forEach((z) => addX(labBand, XM.trim, 0, 1.9, z));
  const labPorts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 14), new THREE.MeshBasicMaterial(), 12);
  for (let i = 0; i < 12; i++) {
    const side = i < 6 ? 1 : -1, z = -66 - (i % 6) * 2.0, a = side > 0 ? 0.35 : Math.PI - 0.35;
    ps.set(Math.cos(a) * 6.92, 1.9 + Math.sin(a) * 6.92, z);
    q.setFromEuler(eulP.set(0, 0, a - Math.PI / 2)); sc.set(1, 1, 1);
    labPorts.setMatrixAt(i, mtx.compose(ps, q, sc));
    labPorts.setColorAt(i, col.setRGB(0.2, 1.4, 0.6));
  }
  ext.add(labPorts);
  const rearHatch = addX(new THREE.CylinderGeometry(1.4, 1.4, 0.15, 32), XM.trim, 0, 1.9, -78.62);
  rearHatch.rotation.x = Math.PI / 2;

  // --- Sección de motores: celosía, bloque propulsor, toberas y reactor --------
  const truss = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.22, 1), XM.trim, 12);
  const corners = [[-3.4, -0.4], [3.4, -0.4], [-3.4, 4.2], [3.4, 4.2]];
  corners.forEach(([x, y], i) => { ps.set(x, y, -80.3); q.identity(); sc.set(1, 1, 3.6); truss.setMatrixAt(i, mtx.compose(ps, q, sc)); });
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), up = new THREE.Vector3(0, 0, 1);
  [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2], [2, 1], [3, 0]].forEach(([a, b], k) => {
    tmpA.set(corners[a][0], corners[a][1], -78.6);
    tmpB.set(corners[b][0], corners[b][1], -82.0);
    ps.addVectors(tmpA, tmpB).multiplyScalar(0.5);
    const len = tmpA.distanceTo(tmpB);
    q.setFromUnitVectors(up, tmpB.sub(tmpA).normalize());
    sc.set(0.7, 0.7, len);
    truss.setMatrixAt(4 + k, mtx.compose(ps, q, sc));
  });
  ext.add(truss);
  chamferZ(5.2, -1.8, 5.6, 1.6, -82, -89, XM.dark);
  const reactorMat = emissiveMat(0xff6a20, 1.2);
  addX(new THREE.TorusGeometry(5.7, 0.25, 12, 64), reactorMat, 0, 1.9, -85.5);
  addEmissiveFlicker(reactorMat, 1.2, 'pulse', 0.6);
  const bellGeo = new THREE.CylinderGeometry(1.15, 1.9, 3.2, 32, 1, true);
  bellGeo.rotateX(Math.PI / 2);
  const bellMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, metalness: 0.9, roughness: 0.45, side: THREE.DoubleSide });
  const glowMat = emissiveMat(0xff5a20, 0.5);
  [[-2.4, 0.2], [2.4, 0.2], [-2.4, 3.6], [2.4, 3.6]].forEach(([nx, ny]) => {
    addX(bellGeo, bellMat, nx, ny, -90.6);
    const g = addX(new THREE.CircleGeometry(1.15, 32), glowMat, nx, ny, -89.05);
    g.rotation.y = Math.PI;
  });

  // Luces de navegación (todas sobre una superficie).
  [[0xff2010, -4.25, 3.0, 1.0, 0.0], [0x20ff40, 4.25, 3.0, 1.0, 0.5], [0xffffff, 0, 4.65, -50.1, 0.25], [0xffffff, 0, 6.0, -89.0, 0.7], [0xff2010, -6.95, 1.9, -78.0, 0.3], [0x20ff40, 6.95, 1.9, -78.0, 0.8]]
    .forEach(([c, x, y, z, ph]) => {
      const m = emissiveMat(c, 0);
      addX(new THREE.SphereGeometry(0.16, 12, 8), m, x, y, z);
      addEmissiveFlicker(m, 14, 'blink', 0.7, ph);
    });

  // --- Cubierta superior: torre de escalera y Puente de Mando --------------------
  const K = {
    box, placeBody, addCollider, addCircle, addLight, addLamp, addBeacon, addSign, addTerminal, makeDoor, doorPart, statusStrip,
    emissiveMat, addEmissiveFlicker, settle, M, group, animators, surfaces, arcs, ceilings, LEVEL, ledMat, T, supportMeshes, lib,
  };
  const upper = buildUpperDeck(K, { addX, XM }, rv);
  mountWallFixtures();
  group.add(upper.wrecks);
  logTerms.push(...upper.logTerms);

  // --- Daño estructural de nave a la deriva ------------------------------------
  // Grietas de impacto (canvas: ramas oscuras con núcleo incandescente) y
  // escarcha (cristales radiales). Se colocan como calcas orientadas por la normal.
  const crackTex = (() => {
    const c = newCanvas(256), x = c.getContext('2d'), rr = mulberry32(55);
    const branch = (px, py, ang, len, w) => {
      if (len < 6 || w < 0.4) return;
      const nx = px + Math.cos(ang) * len, ny = py + Math.sin(ang) * len;
      x.strokeStyle = 'rgba(10,6,4,0.95)'; x.lineWidth = w * 2.2; x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke();
      x.strokeStyle = 'rgba(255,120,40,0.9)'; x.lineWidth = w * 0.6; x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke();
      branch(nx, ny, ang + (rr() - 0.5) * 0.9, len * (0.6 + rr() * 0.25), w * 0.75);
      if (rr() < 0.55) branch(nx, ny, ang + (rr() < 0.5 ? -1 : 1) * (0.5 + rr() * 0.6), len * 0.55, w * 0.6);
    };
    for (let k = 0; k < 9; k++) branch(128, 128, (k / 9) * Math.PI * 2 + rr() * 0.4, 30 + rr() * 25, 3);
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 34);
    g.addColorStop(0, 'rgba(8,5,3,1)'); g.addColorStop(1, 'rgba(8,5,3,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const frostTex = (() => {
    const c = newCanvas(256), x = c.getContext('2d'), rr = mulberry32(66);
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 120);
    g.addColorStop(0, 'rgba(230,245,255,0.95)'); g.addColorStop(0.5, 'rgba(200,230,255,0.5)'); g.addColorStop(1, 'rgba(200,230,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = 'rgba(255,255,255,0.8)';
    for (let k = 0; k < 140; k++) {
      const a = rr() * Math.PI * 2, r0 = rr() * 90, l = 6 + rr() * 22;
      const px = 128 + Math.cos(a) * r0, py = 128 + Math.sin(a) * r0;
      x.lineWidth = 0.6 + rr(); x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const crackMat = new THREE.MeshStandardMaterial({ map: crackTex, emissiveMap: crackTex, emissive: 0xff6020, emissiveIntensity: 0.9, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, roughness: 0.9 });
  const frostMat = new THREE.MeshStandardMaterial({ map: frostTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, roughness: 0.35, metalness: 0, envMapIntensity: 1.2 });
  const iceMat = new THREE.MeshStandardMaterial({ color: 0xcfe8ff, roughness: 0.15, metalness: 0, envMapIntensity: 1.4, transparent: true, opacity: 0.85 });
  const cableMatX = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.75, metalness: 0.2 });
  const _n = new THREE.Vector3(), _p = new THREE.Vector3();
  function stamp(mat, size, p, n, rot = 0) {
    const m = addX(new THREE.PlaneGeometry(size, size), mat, p[0] + n[0] * 0.02, p[1] + n[1] * 0.02, p[2] + n[2] * 0.02);
    m.lookAt(_p.set(p[0] + n[0], p[1] + n[1], p[2] + n[2]));
    m.rotateZ(rot);
    return m;
  }
  // Microasteroide: icosaedro desplazado con ruido, medio incrustado.
  function asteroid(p, n, r, seed) {
    const g = new THREE.IcosahedronGeometry(r, 2), pa = g.attributes.position, v = new THREE.Vector3(), rr = mulberry32(seed);
    const k1 = 2 + rr() * 3, k2 = 5 + rr() * 4;
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).normalize();
      const dd = 1 + Math.sin(v.x * k1 + seed) * Math.sin(v.y * k1 * 1.3) * 0.18 + Math.sin(v.z * k2 + v.x * 3) * 0.07;
      v.multiplyScalar(r * dd);
      pa.setXYZ(i, v.x, v.y * 0.85, v.z);
    }
    g.computeVertexNormals();
    const rock = addX(g, new THREE.MeshStandardMaterial({ color: 0x4a3e36, roughness: 0.95, metalness: 0.05 }), p[0] + n[0] * r * 0.35, p[1] + n[1] * r * 0.35, p[2] + n[2] * r * 0.35);
    rock.rotation.set(rr() * 3, rr() * 3, rr() * 3);
    stamp(crackMat, r * 5, p, n, rr() * 6);
  }
  // Pétalos de chapa desgarrada hacia fuera alrededor de un orificio.
  function tornHole(p, n, t1, t2, rad, seed) {
    const rr = mulberry32(seed);
    stamp(XM.scorch, rad * 2.6, p, n);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + rr() * 0.4;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ex = p[0] + (t1[0] * ca + t2[0] * sa) * rad, ey = p[1] + (t1[1] * ca + t2[1] * sa) * rad, ez = p[2] + (t1[2] * ca + t2[2] * sa) * rad;
      const pet = addX(new THREE.BoxGeometry(0.5 + rr() * 0.4, 0.035, 0.35 + rr() * 0.3), XM.dark, ex + n[0] * 0.12, ey + n[1] * 0.12, ez + n[2] * 0.12);
      pet.lookAt(ex + n[0] + (t1[0] * ca + t2[0] * sa), ey + n[1] + (t1[1] * ca + t2[1] * sa), ez + n[2] + (t1[2] * ca + t2[2] * sa));
      pet.rotateX(Math.PI / 2 + 0.6 + rr() * 0.5);
    }
    // Cables sueltos que salen flotando (sin gravedad: se rizan hacia fuera).
    for (let k = 0; k < 5; k++) {
      const pts = [];
      const a0 = rr() * Math.PI * 2;
      for (let s = 0; s <= 5; s++) {
        const out = s * (0.35 + rr() * 0.1), sw = Math.sin(s * 1.3 + k) * 0.25 * s * 0.4;
        const ca = Math.cos(a0 + s * 0.5), sa = Math.sin(a0 + s * 0.5);
        pts.push(new THREE.Vector3(
          p[0] + n[0] * (out - 0.3) + (t1[0] * ca + t2[0] * sa) * (rad * 0.4 + sw),
          p[1] + n[1] * (out - 0.3) + (t1[1] * ca + t2[1] * sa) * (rad * 0.4 + sw),
          p[2] + n[2] * (out - 0.3) + (t1[2] * ca + t2[2] * sa) * (rad * 0.4 + sw)));
      }
      ext.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.02 + rr() * 0.015, 6), cableMatX));
      if (k < 2) {
        const sm = emissiveMat(0x9fd0ff, 0);
        const e = pts[pts.length - 1];
        addX(new THREE.SphereGeometry(0.04, 8, 6), sm, e.x, e.y, e.z);
        addEmissiveFlicker(sm, 12, 'broken');
      }
    }
  }
  // Fuga de refrigerante congelado: penacho de cristales (animado en GPU),
  // escarcha alrededor y carámbanos.
  function coolantLeak(p, n, seed) {
    const N = 260, rr = mulberry32(seed), sd = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) sd[i] = rr();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 3));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: globalUniforms.uTime, uPixelScale: globalUniforms.uPixelScale, uO: { value: new THREE.Vector3(...p) }, uN: { value: new THREE.Vector3(...n).normalize() } },
      vertexShader: /* glsl */ `
        uniform float uTime, uPixelScale; uniform vec3 uO, uN; attribute vec3 aSeed; varying float vA;
        void main() {
          float t = fract(aSeed.x + uTime * (0.08 + aSeed.y * 0.06));
          vec3 sp = normalize(vec3(aSeed.y - 0.5, aSeed.z - 0.5, aSeed.x - 0.5));
          vec3 p = uO + uN * (t * 4.5) + (sp - uN * dot(sp, uN)) * t * (0.6 + aSeed.z * 1.4);
          p += vec3(sin(uTime * 0.7 + aSeed.x * 20.0), cos(uTime * 0.5 + aSeed.y * 17.0), 0.0) * t * 0.15;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp((0.05 + t * 0.25) * uPixelScale / max(0.5, -mv.z), 1.0, 24.0);
          vA = (1.0 - t) * (1.0 - t) * (0.35 + aSeed.z * 0.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(0.75, 0.9, 1.0) * vA * (1.0 - smoothstep(0.1, 0.5, d)) * 0.9, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    ext.add(pts);
    stamp(frostMat, 2.4, p, n, rr() * 6);
    for (let k = 0; k < 7; k++) {
      const ic = addX(new THREE.ConeGeometry(0.03 + rr() * 0.04, 0.25 + rr() * 0.5, 6), iceMat, p[0] + (rr() - 0.5) * 0.9, p[1] + (rr() - 0.5) * 0.9, p[2] + (rr() - 0.5) * 0.9);
      ic.lookAt(ic.position.x + n[0], ic.position.y + n[1], ic.position.z + n[2]);
      ic.rotateX(Math.PI / 2);
    }
  }

  // Brecha dorsal (sobre la sección colapsada del interior).
  tornHole([(LEVEL.breach.x0 + LEVEL.breach.x1) / 2, SPY + SPA + 0.01, (LEVEL.breach.z0 + LEVEL.breach.z1) / 2], [0, 1, 0], [1, 0, 0], [0, 0, 1], 1.1, 21);
  // Ala oeste (visible desde el ventanal W2): orificio, fuga y asteroide.
  tornHole([-15.2, 1.9, -44.37], [0, 0, 1], [1, 0, 0], [0, 1, 0], 0.9, 33);
  coolantLeak([-15.2, 1.9, -44.3], [0.15, 0.25, 1], 34);
  asteroid([-12.4, 3.9, -46.2], [0, 1, 0], 0.9, 41);
  // Hábitat de proa (visible desde el ventanal W1) y tambor nodal.
  asteroid([-3.9, 3.2, -7.62], [-0.3, 0.3, -1], 0.6, 42);
  asteroid([-4.6, 3.6, -54.8], [-0.6, 0.4, -0.7], 0.75, 43);
  // Cilindro del laboratorio y bloque de motores: grietas y fuga de la tubería.
  asteroid([2.8, 8.2, -69.5], [0.4, 0.92, 0], 1.1, 44);
  stamp(crackMat, 3.5, [5.21, 2.6, -85.5], [1, 0, 0], 0.4);
  stamp(crackMat, 2.8, [-1.5, 5.61, -86.2], [0, 1, 0], 1.2);
  stamp(crackMat, 2.2, [5.21, 0.4, -83.2], [1, 0, 0], 2.1);
  coolantLeak([5.25, 1.2, -84.4], [1, 0.2, 0.1], 35);
  coolantLeak([Math.cos(Math.PI / 4) * (SPA + 0.15) + 0.2, SPY + Math.sin(Math.PI / 4) * (SPA + 0.15) + 0.2, -22.0], [0.6, 0.8, 0], 36);

  // Stencil: dentro de la nave el exterior sólo pasa donde la máscara de los
  // ventanales escribió 1; fuera (cinemática) se dibuja siempre.
  const extMats = new Set();
  ext.traverse((o) => {
    if (!o.material) return;
    o.renderOrder = 2; // tras el interior opaco y la máscara de los ventanales
    o.castShadow = false;
    o.receiveShadow = false;
    extMats.add(o.material);
  });
  for (const m of extMats) {
    m.stencilWrite = true;
    m.stencilWriteMask = 0x00;
    m.stencilRef = 1;
    m.stencilFunc = THREE.AlwaysStencilFunc;
  }
  // RECORTE POR VOLÚMENES INTERIORES. Algunas salas (escalera, oficina, Nodo D,
  // puente…) sobresalen del casco principal, así que hay piezas del exterior
  // que atraviesan su interior. Como el exterior se dibuja allí donde la máscara
  // del ventanal marcó el stencil, una pieza situada ENTRE la cámara y el
  // ventanal tapaba la vista ("el cristal muestra una textura de pared").
  // Regla: ningún fragmento del exterior se dibuja dentro de un volumen interior.
  const IN = [];
  const inBox = (x0, y0, z0, x1, y1, z1) => {
    const e = 0.03; // margen: las placas pegadas a un muro no se recortan
    IN.push(new THREE.Vector3(Math.min(x0, x1) + e, Math.min(y0, y1) + e, Math.min(z0, z1) + e),
      new THREE.Vector3(Math.max(x0, x1) - e, Math.max(y0, y1) - e, Math.max(z0, z1) - e));
  };
  {
    const L = LEVEL, Xc = L.corr.halfW, H = L.hub, ST = L.stair, B = L.bridge, UY = L.upper.y;
    inBox(-1.3, 0, L.hatchZ, 1.3, 2.8, L.airlockEnd);                                  // esclusa
    inBox(-L.room.halfW, 0, L.room.z1, L.room.halfW, L.room.h, L.room.z0);              // descompresión
    inBox(-Xc, 0, L.corr.z1, Xc, L.corr.h, L.corr.z0);                                  // pasillo principal
    inBox(Xc, 0, L.office.z1, L.office.x1, 3.0, L.office.z0);                           // oficina C-2
    inBox(-H.halfW, 0, H.z1, H.halfW, H.h, H.z0);                                       // Nodo D
    inBox(L.server.x0, 0, H.sideZ1, -H.halfW, 3.0, H.sideZ0);                           // ala oeste
    inBox(H.halfW, 0, H.sideZ1, L.crew.x0, 3.0, H.sideZ0);                              // ala este
    inBox(L.server.x1, 0, L.server.z1, L.server.x0, L.server.h, L.server.z0);           // servidores
    inBox(L.crew.x0, 0, L.crew.z1, L.crew.x1, L.crew.h, L.crew.z0);                     // dormitorios
    inBox(-Xc, 0, L.labCorr.z1, Xc, 3.1, L.labCorr.z0);                                 // acceso B-3
    inBox(-L.lab.halfW, 0, L.lab.z1, L.lab.halfW, L.lab.h, L.lab.z0);                   // laboratorio
    inBox(ST.x0, 0, ST.z1, ST.x1, ST.h, ST.z0);                                         // escalera
    inBox(-B.hw, UY, ST.z0 - 0.2, B.hw, UY + B.h, B.zc);                                // puente (rectángulo)
    const q = B.R * 0.68;                                                               // puente (semicírculo inscrito)
    inBox(-q, UY, B.zc, q, UY + B.h, B.zc + q);
  }
  const clipChunk = `uniform vec3 uInMin[${IN.length / 2}], uInMax[${IN.length / 2}]; varying vec3 vExtW;\n`;
  const IN_MIN = IN.filter((_, i) => i % 2 === 0), IN_MAX = IN.filter((_, i) => i % 2 === 1);
  for (const m of extMats) {
    if (!(m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) continue;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uInMin = { value: IN_MIN };
      sh.uniforms.uInMax = { value: IN_MAX };
      sh.vertexShader = 'varying vec3 vExtW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef USE_INSTANCING
          vExtW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vExtW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
      sh.fragmentShader = clipChunk + sh.fragmentShader.replace('void main() {', `void main() {
        for (int i = 0; i < ${IN_MIN.length}; i++) {
          if (all(greaterThan(vExtW, uInMin[i])) && all(lessThan(vExtW, uInMax[i]))) discard;
        }`);
    };
    m.customProgramCacheKey = () => 'ext-clip-' + IN_MIN.length;
    m.needsUpdate = true;
  }
  const setExteriorInside = (inside) => {
    for (const m of extMats) m.stencilFunc = inside ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
  };

  const steam = createSteamBurst(new THREE.Vector3(0, 1.3, AZ0 - 0.05));
  group.add(steam.points);

  return {
    group, exterior: ext, colliders, lights, pickups, animators, beacons, shafts, state, steam, setExteriorInside,
    doors: { hatch, d0, bd1, office, lab, qs, ...upper.doors },
    terminals: { t0, t1, t2, tsr, qsInfo, keypad, power, ...upper.terminals },
    surfaces, arcs, ceilings, logTerms, seed, flip: fl,
    introLamps: [roomLamp, airlockLamp], corridorLamps, labLamp, officeLamp,
    beacon: { mesh: beaconMesh, mat: beaconMat, light: beaconLight },
    holo: { x: HP.x, z: HP.z, ceilY: R.h, lensMat, floorRingMat, light: holoLight },
    chamber: { ringMat, light: chamberLight },
    hubMap: { dot: mapDot, scale: MAP_S, cz: MAP_CZ },
    spawn: LEVEL.spawn,
  };
}

// -----------------------------------------------------------------------------
// Cápsula del mercenario: fuselaje hexagonal facetado (torno de 6 lados),
// cúpula de cabina, aristas con luces secuenciales, panel de acople cerrado en
// iris, bloques RCS en cada cara con retrocohetes, tobera triple y estela.
// -----------------------------------------------------------------------------
export function buildCapsule(lib) {
  const group = new THREE.Group();
  group.name = 'capsule';
  const hull = pbr(lib.capsule, { envMapIntensity: 0.9 });
  const armor = new THREE.MeshStandardMaterial({ color: 0x3e4248, metalness: 0.8, roughness: 0.35, normalMap: lib.hull.normalMap });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24262a, metalness: 0.9, roughness: 0.45, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({ color: 0x080c10, metalness: 0.6, roughness: 0.32 });
  const em = (c, i) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: i });
  const facet = (g) => { const n = g.toNonIndexed(); n.computeVertexNormals(); return n; };
  const prof = [[0.001, 0], [0.72, 0], [0.78, 0.14], [1.08, 0.5], [1.46, 1.3], [1.52, 2.4], [1.34, 3.3], [0.98, 3.85], [0.78, 4.0]];
  const radiusAt = (z) => {
    for (let i = 1; i < prof.length; i++) if (z <= prof[i][1]) {
      const [r0, y0] = prof[i - 1], [r1, y1] = prof[i];
      return r0 + ((r1 - r0) * (z - y0)) / (y1 - y0);
    }
    return prof[prof.length - 1][0];
  };
  const bodyGeo = scaleUV(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 6), 3, 2);
  bodyGeo.rotateX(Math.PI / 2);
  bodyGeo.rotateZ(Math.PI / 6); // cara plana arriba
  group.add(new THREE.Mesh(facet(bodyGeo), hull));
  const C30 = Math.cos(Math.PI / 6);

  // Cúpula de cabina sobre la faceta superior delantera.
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 1.0), glass);
  canopy.position.set(0, (radiusAt(1.0) * C30) + 0.02, 1.0);
  canopy.rotation.x = -0.4;
  const canFrame = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.03, 1.08), em(0x60d0ff, 1.2));
  canFrame.position.copy(canopy.position).y -= 0.012;
  canFrame.rotation.x = -0.4;
  group.add(canFrame, canopy);

  // Aristas del hexágono: listones de blindaje con luces secuenciales.
  const ridgeMat = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime },
    vertexShader: /* glsl */ `varying float vZ; void main() { vZ = (modelMatrix * vec4(position, 1.0)).z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying float vZ;
      void main() { float p = fract(vZ * 0.6 - uTime * 1.4); gl_FragColor = vec4(vec3(0.5, 0.85, 1.0) * (0.15 + 3.0 * exp(-p * p * 60.0)), 1.0); }`,
  });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 2 + Math.PI / 6;
    const r = radiusAt(1.9) * 1.005;
    const strake = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 1.8), armor);
    strake.position.set(Math.cos(a) * r, Math.sin(a) * r, 1.9);
    strake.lookAt(Math.cos(a) * radiusAt(1.0), Math.sin(a) * radiusAt(1.0), 1.0);
    group.add(strake);
    if (k === 0 || k === 2) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 1.6), ridgeMat);
      strip.position.copy(strake.position).multiplyScalar(1.03);
      strip.position.z = 1.9;
      strip.quaternion.copy(strake.quaternion);
      group.add(strip);
    }
  }

  // Panel de acople cerrado: anillo hexagonal + iris de seis pétalos.
  const adapter = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.8, 0.8, 0.22, 6)), armor);
  adapter.rotation.x = Math.PI / 2;
  adapter.position.z = 0.08;
  group.add(adapter);
  const petalShape = new THREE.Shape();
  petalShape.moveTo(0, 0); petalShape.lineTo(0.62, -0.36); petalShape.lineTo(0.62, 0.36); petalShape.closePath();
  for (let k = 0; k < 6; k++) {
    const p = new THREE.Mesh(new THREE.ShapeGeometry(petalShape), dark);
    p.rotation.set(0, Math.PI, (k / 6) * Math.PI * 2 + 0.08);
    p.position.z = -0.035;
    group.add(p);
  }
  const flickers = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const m = em(0xffffff, 0);
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), m);
    l.position.set(Math.cos(a) * 0.74, Math.sin(a) * 0.74, -0.04);
    group.add(l);
    flickers.push({ pos: null, base: 0, mat: m, baseE: 10, mode: 'blink', speed: 1.4, seed: k / 6, power: 1 });
  }

  // Bloques RCS en cada faceta (proa y popa) con toberas y chorros de frenado.
  const retroFlame = createFlameMaterial();
  const puffGeo = new THREE.ConeGeometry(0.07, 0.6, 10, 1, true);
  puffGeo.rotateX(-Math.PI / 2);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 2;
    for (const z of [0.75, 3.1]) {
      const r = radiusAt(z) * C30 + 0.06;
      const quad = new THREE.Group();
      quad.position.set(Math.cos(a) * r, Math.sin(a) * r, z);
      quad.rotation.z = a - Math.PI / 2;
      quad.add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.3), armor));
      for (const [dx, dz, rx] of [[0.15, 0, 0], [-0.15, 0, 0], [0, -0.17, 1]]) {
        const n = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.07, 8, 1, true), dark);
        n.position.set(dx, 0, dz);
        n.rotation.set(rx ? -Math.PI / 2 : 0, 0, rx ? 0 : (dx > 0 ? -Math.PI / 2 : Math.PI / 2));
        quad.add(n);
      }
      if (z < 1) {
        const puff = new THREE.Mesh(puffGeo, retroFlame);
        puff.position.set(0, 0, -0.45);
        quad.add(puff);
      }
      group.add(quad);
    }
  }

  // Popa: anillo de blindaje, tobera triple con brillo y llamas.
  const tail = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.95, 0.8, 0.3, 6)), armor);
  tail.rotation.x = Math.PI / 2;
  tail.rotation.y = Math.PI / 6;
  tail.position.z = 3.95;
  group.add(tail);
  const mainFlame = createFlameMaterial();
  const flameGeo = new THREE.ConeGeometry(0.42, 2.4, 20, 1, true);
  flameGeo.rotateX(Math.PI / 2);
  const bellG = new THREE.CylinderGeometry(0.3, 0.42, 0.55, 24, 1, true);
  bellG.rotateX(Math.PI / 2);
  const nozzles = [];
  [[0, 0.36], [-0.32, -0.2], [0.32, -0.2]].forEach(([x, y]) => {
    const b = new THREE.Mesh(bellG, dark);
    b.position.set(x, y, 4.35);
    const g = new THREE.Mesh(new THREE.CircleGeometry(0.3, 20), em(0x80d8ff, 2.5));
    g.position.set(x, y, 4.09);
    g.rotation.y = Math.PI;
    const fl = new THREE.Mesh(flameGeo, mainFlame);
    fl.position.set(x, y, 4.62 + 1.2);
    group.add(b, g, fl);
    nozzles.push(new THREE.Vector3(x, y, 4.65));
  });
  const ion = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.03, 8, 6), em(0x60d0ff, 3));
  ion.rotation.z = Math.PI / 6;
  ion.position.z = 4.12;
  group.add(ion);

  // Luces de posición: babor roja, estribor verde, estrobo blanco en popa.
  [[0xff2010, -1, 0.0], [0x20ff40, 1, 0.5]].forEach(([c, s, ph]) => {
    const m = em(c, 0);
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), m);
    l.position.set(s * radiusAt(2.4) * 1.01, 0, 2.4);
    group.add(l);
    flickers.push({ pos: null, base: 0, mat: m, baseE: 12, mode: 'blink', speed: 1.1, seed: ph, power: 1 });
  });
  const strobeM = em(0xffffff, 0);
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), strobeM);
  strobe.position.set(0, radiusAt(3.6) * C30 + 0.04, 3.6);
  group.add(strobe);
  flickers.push({ pos: null, base: 0, mat: strobeM, baseE: 16, mode: 'blink', speed: 2.2, seed: 0.1, power: 1 });
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6), dark);
  ant.position.set(0.35, radiusAt(3.0) * C30 + 0.35, 3.0);
  group.add(ant);

  const trail = createTrail(900);
  return { group, mainFlame, retroFlame, flickers, trail, nozzle: nozzles[0], nozzles };
}
