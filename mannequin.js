// =============================================================================
// mannequin.js
// Personajes LOW-POLY ESTILIZADOS (maniquí industrial de survival horror):
//  · Cada parte del cuerpo es una función de geometría discreta: segmentos
//    cilíndricos de 8 caras entre articulaciones, con ESFERAS DE TRANSICIÓN del
//    mismo radio en cada unión (sin huecos ni grietas al doblar), torso en cono
//    invertido (hombros anchos, cintura estrecha), pelvis, deltoides definidos,
//    cabeza ovoide facetada, manos y pies en bloques biselados.
//  · Sin texturas: sombreado plano (flatShading, roughness 0.8). El volumen lo
//    dan la linterna y las sombras dinámicas.
//  · Las piezas se fusionan por material: 3-5 llamadas de dibujo por figura.
//  · El brazo EVA en primera persona usa el mismo lenguaje (falanges
//    cilíndricas + esferas de nudillo) sobre la geometría de agarre paramétrica:
//    los dedos rodean la empuñadura a un radio calculado y nunca la atraviesan.
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { globalUniforms } from './procedural-assets.js';

const SEG = 8; // caras radiales: aspecto retro deliberado

// ------------------------------------------------------------ Vectores [x,y,z]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
// Base ortonormal { r, u, f } con u = eje dado y f lo más parecido a la pista.
function frame(up, fwdHint) {
  const u = norm(up);
  let f = madd(fwdHint, u, -dot(fwdHint, u));
  if (len(f) < 1e-4) f = Math.abs(u[1]) < 0.9 ? madd([0, 1, 0], u, -u[1]) : madd([0, 0, 1], u, -u[2]);
  f = norm(f);
  return { r: cross(u, f), u, f };
}
const _m = new THREE.Matrix4();
// Fusión de piezas (todas a no indexadas: el icosaedro no lleva índice).
function mergeParts(list) {
  const flat = list.map((x) => (x.index ? x.toNonIndexed() : x));
  const geo = mergeGeometries(flat, false);
  for (const x of list) x.dispose();
  for (const x of flat) x.dispose();
  return geo;
}
const place = (geo, F, o) => geo.applyMatrix4(_m.makeBasis(
  new THREE.Vector3(...F.r), new THREE.Vector3(...F.u), new THREE.Vector3(...F.f)).setPosition(o[0], o[1], o[2]));

// ------------------------------------------------------- Piezas discretas
// Segmento troncocónico a→b (radios r1 en a, r2 en b), abierto: lo cierran
// las esferas de transición de las articulaciones.
function limb(a, b, r1, r2, seg = SEG, hint = [0, 0, 1]) {
  const d = sub(b, a), L = len(d);
  const g = new THREE.CylinderGeometry(r2, r1, Math.max(L, 1e-4), seg, 1, true);
  return place(g, frame(d, hint), mid(a, b));
}
// Segmento ANATÓMICO a→b por torno de 8 caras: el perfil [t, radio] da el
// vientre muscular (bíceps, antebrazo, muslo, gemelo) y se estrecha hacia las
// articulaciones, cuyos extremos coinciden con el radio de la esfera de unión.
function muscle(a, b, prof, hint = [0, 0, 1]) {
  const d = sub(b, a), L = Math.max(len(d), 1e-4);
  const pts = prof.map(([t, r]) => new THREE.Vector2(Math.max(r, 1e-3), t * L - L / 2));
  const g = new THREE.LatheGeometry(pts, SEG);
  return place(g, frame(d, hint), mid(a, b));
}
// Esfera de unión (mismo número de caras que los segmentos).
function joint(p, r, seg = SEG) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(4, seg / 2 + 1));
  g.translate(p[0], p[1], p[2]);
  return g;
}
// Bloque biselado: caja con aristas achaflanadas (cilindro de 4 caras girado 45°
// y escalado), orientado con su largo sobre `dir`.
function block(center, dir, upHint, w, h, l, bevel = 0.18) {
  const g = new THREE.BoxGeometry(w, h, l, 1, 1, 1);
  // Chaflán: desplaza ligeramente hacia dentro los vértices de las aristas.
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 - bevel * 0.5 * (Math.abs(x) / (w / 2)) * (Math.abs(y) / (h / 2));
    p.setXYZ(i, x * k, y * (1 - bevel * 0.25 * Math.abs(z) / (l / 2)), z);
  }
  const fz = norm(dir), fx = norm(cross(upHint, fz).every((v) => Math.abs(v) < 1e-5) ? [1, 0, 0] : cross(upHint, fz)), fy = cross(fz, fx);
  g.applyMatrix4(_m.makeBasis(new THREE.Vector3(...fx), new THREE.Vector3(...fy), new THREE.Vector3(...fz)).setPosition(...center));
  return g;
}
function ring(p, axis, R, r) {
  const g = new THREE.TorusGeometry(R, r, 4, SEG * 2);
  g.rotateX(Math.PI / 2);
  return place(g, frame(axis, [0, 0, 1]), p);
}

// ------------------------------------------------------------- Materiales
const MATS = new Map();
function mat(hex, o = {}) {
  const key = hex + JSON.stringify(o);
  if (!MATS.has(key)) MATS.set(key, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8, metalness: 0.05, flatShading: true, ...o }));
  return MATS.get(key);
}
// Visor dorado pulido: en alerta refleja las balizas rojas (Fresnel + barrido).
let VISOR = null;
function visorMaterial() {
  if (VISOR) return VISOR;
  VISOR = new THREE.MeshStandardMaterial({ color: 0x3a2a10, metalness: 0.85, roughness: 0.32, envMapIntensity: 0.6, flatShading: true });
  VISOR.onBeforeCompile = (sh) => {
    sh.uniforms.uAlert = globalUniforms.uAlert;
    sh.uniforms.uTime = globalUniforms.uTime;
    sh.fragmentShader = 'uniform float uAlert, uTime;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        float vf = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        float sweep = 0.5 + 0.5 * sin(uTime * 4.2 + vViewPosition.x * 9.0 + vViewPosition.y * 4.0);
        totalEmissiveRadiance += vec3(1.0, 0.07, 0.03) * uAlert * (0.06 + 0.9 * vf * vf) * (0.25 + 0.75 * sweep * sweep);
      }`);
  };
  return VISOR;
}

const OUTFITS = {
  uniform: { suit: 0x2c3440, limb: 0x2c3440, skin: 0xb9b2a8, boot: 0x16181b, accent: 0x8a6a2a },
  eva: { suit: 0xa9a59b, limb: 0xa9a59b, skin: 0xb9b2a8, boot: 0x5a5d62, accent: 0xc0602a },
  labcoat: { suit: 0xb0b2ae, limb: 0x3c4148, skin: 0xb9b2a8, boot: 0x1a1a1a, accent: 0x5a8ab0 },
  specimen: { suit: 0xa9a49b, limb: 0xa9a49b, skin: 0xa9a49b, boot: 0xa9a49b, accent: 0x7a7570 },
};

// --------------------------------------------------------------- Posturas
// Coordenadas del cuerpo (m): Y arriba, el sujeto mira hacia +Z. A = lado +X.
export const POSES = {
  slumped: { // sentado (asiento a 0.45 m), desplomado sobre un escritorio
    pelvis: [0, 0.55, 0], chest: [0, 0.84, 0.34], fwd: [0, -0.77, 0.64], neck: [0, 0.9, 0.41], head: [0, 0.95, 0.6], headFwd: [0.2, -0.9, 0.35],
    shoulderA: [0.19, 0.85, 0.31], elbowA: [0.25, 0.72, 0.5], wristA: [0.2, 0.79, 0.72], handA: [0.15, 0.79, 0.82],
    shoulderB: [-0.19, 0.85, 0.31], elbowB: [-0.25, 0.57, 0.4], wristB: [-0.22, 0.35, 0.47], handB: [-0.21, 0.22, 0.5],
    hipA: [0.1, 0.53, 0.02], kneeA: [0.12, 0.5, 0.46], ankleA: [0.12, 0.065, 0.52], toeA: [0.13, 0.025, 0.68],
    hipB: [-0.1, 0.53, 0.02], kneeB: [-0.13, 0.5, 0.45], ankleB: [-0.16, 0.065, 0.46], toeB: [-0.18, 0.025, 0.62],
  },
  lying: { // tendido boca arriba, un brazo colgando
    pelvis: [0, 0.13, 0], chest: [0, 0.15, 0.45], fwd: [0, 1, 0], neck: [0, 0.15, 0.54], head: [0, 0.18, 0.7], headFwd: [0.35, 0.9, 0.15],
    shoulderA: [0.19, 0.14, 0.44], elbowA: [0.26, 0.1, 0.19], wristA: [0.22, 0.12, -0.04], handA: [0.18, 0.13, -0.13],
    shoulderB: [-0.19, 0.14, 0.44], elbowB: [-0.31, 0.0, 0.33], wristB: [-0.36, -0.24, 0.36], handB: [-0.37, -0.36, 0.38],
    hipA: [0.1, 0.12, -0.03], kneeA: [0.12, 0.2, -0.45], ankleA: [0.12, 0.1, -0.88], toeA: [0.14, 0.24, -0.93],
    hipB: [-0.1, 0.12, -0.03], kneeB: [-0.11, 0.14, -0.47], ankleB: [-0.13, 0.09, -0.9], toeB: [-0.17, 0.22, -0.96],
  },
  fetal: { // encogido (espécimen en un tanque)
    pelvis: [0, 0, 0], chest: [0, 0.34, 0.24], fwd: [0, -0.58, 0.81], neck: [0, 0.41, 0.3], head: [0, 0.45, 0.47], headFwd: [0, -0.75, 0.66],
    shoulderA: [0.18, 0.34, 0.2], elbowA: [0.2, 0.22, 0.42], wristA: [0.1, 0.12, 0.48], handA: [0.03, 0.1, 0.47],
    shoulderB: [-0.18, 0.34, 0.2], elbowB: [-0.2, 0.2, 0.4], wristB: [-0.1, 0.1, 0.46], handB: [-0.03, 0.08, 0.45],
    hipA: [0.09, -0.02, 0.02], kneeA: [0.1, 0.2, 0.38], ankleA: [0.09, -0.18, 0.34], toeA: [0.1, -0.22, 0.48],
    hipB: [-0.09, -0.02, 0.02], kneeB: [-0.1, 0.18, 0.37], ankleB: [-0.09, -0.2, 0.32], toeB: [-0.1, -0.24, 0.46],
  },
  sitting: { // en el suelo, espalda contra la pared, cabeza ladeada
    pelvis: [0, 0.16, 0], chest: [0, 0.6, -0.11], fwd: [0, 0.25, 0.97], neck: [0, 0.68, -0.12], head: [0.05, 0.86, -0.07], headFwd: [0.35, -0.2, 0.92],
    shoulderA: [0.21, 0.6, -0.13], elbowA: [0.31, 0.36, -0.04], wristA: [0.33, 0.13, 0.12], handA: [0.34, 0.05, 0.22],
    shoulderB: [-0.21, 0.6, -0.13], elbowB: [-0.29, 0.37, 0.02], wristB: [-0.18, 0.3, 0.24], handB: [-0.1, 0.29, 0.31],
    hipA: [0.1, 0.14, 0.02], kneeA: [0.13, 0.43, 0.42], ankleA: [0.15, 0.09, 0.76], toeA: [0.17, 0.08, 0.92],
    hipB: [-0.1, 0.14, 0.02], kneeB: [-0.12, 0.3, 0.46], ankleB: [-0.16, 0.08, 0.86], toeB: [-0.2, 0.1, 1.01],
  },
};

// -----------------------------------------------------------------------------
// Figura completa: Group con una malla por material.
// -----------------------------------------------------------------------------
// Radio de contacto de cada articulación (distancia del centro a la superficie
// sobre la que apoya) y articulaciones que se dejan caer sobre el apoyo según la
// postura (el resto conserva la pose: un brazo que cuelga sigue colgando).
export const JOINT_R = {
  pelvis: 0.1, chest: 0.11, neck: 0.05, head: 0.1, shoulderA: 0.06, shoulderB: 0.06, elbowA: 0.045, elbowB: 0.045,
  wristA: 0.035, wristB: 0.035, handA: 0.02, handB: 0.02, hipA: 0.09, hipB: 0.09, kneeA: 0.06, kneeB: 0.06,
  ankleA: 0.045, ankleB: 0.045, toeA: 0.035, toeB: 0.035,
};
export const REST = {
  lying: Object.keys(JOINT_R),
  slumped: ['head', 'neck', 'elbowA', 'elbowB', 'wristA', 'wristB', 'handA', 'handB', 'ankleA', 'ankleB', 'toeA', 'toeB'],
  sitting: ['wristA', 'wristB', 'handA', 'handB', 'ankleA', 'ankleB', 'toeA', 'toeB'],
  fetal: [],
};
// Articulaciones de una postura en coordenadas de mundo (giro en Y + traslación).
export function posedJoints(poseName, x, y, z, rotY) {
  const P = POSES[poseName], c = Math.cos(rotY), s = Math.sin(rotY), out = {};
  for (const k in P) {
    const v = P[k], dir = k === 'fwd' || k === 'headFwd';
    const rx = v[0] * c + v[2] * s, rz = -v[0] * s + v[2] * c;
    out[k] = dir ? [rx, v[1], rz] : [rx + x, v[1] + y, rz + z];
  }
  return out;
}

// pose: nombre de postura o articulaciones ya resueltas (posedJoints + apoyo).
export function buildMannequin(pose, outfit = 'uniform') {
  const P = typeof pose === 'string' ? POSES[pose] : pose, C = OUTFITS[outfit] || OUTFITS.uniform;
  const eva = outfit === 'eva', bare = outfit === 'specimen';
  const inf = eva ? 0.016 : bare ? -0.004 : 0.004; // holgura de la prenda
  const parts = new Map(); // material → geometrías
  const add = (m, g) => { if (!parts.has(m)) parts.set(m, []); parts.get(m).push(g); };
  const suit = mat(C.suit), limbM = mat(C.limb), skin = mat(C.skin), boot = mat(C.boot), accent = mat(C.accent);

  // Torso: columna alineada pelvis→pecho; caja torácica por torno (cintura
  // estrecha → costillas → hombros: cono invertido), aplanada en profundidad.
  const up = sub(P.chest, P.pelvis), TL = len(up), T = frame(up, P.fwd);
  const H0 = TL + 0.1, rib = [[0, 0.118], [0.18, 0.124], [0.45, 0.152], [0.72, 0.168], [0.9, 0.162], [1, 0.12]];
  const chestG = new THREE.LatheGeometry(rib.map(([t, r]) => new THREE.Vector2(r + inf, t * H0 - H0 / 2)), SEG);
  chestG.scale(1, 1, 0.62);
  // Esternón algo adelantado: la mitad delantera de las costillas, más profunda.
  const cp = chestG.attributes.position;
  for (let i = 0; i < cp.count; i++) if (cp.getZ(i) > 0 && cp.getY(i) > -H0 * 0.1) cp.setZ(i, cp.getZ(i) * 1.12);
  add(suit, place(chestG, T, madd(P.pelvis, T.u, TL / 2 + 0.06)));
  const pelvisG = new THREE.LatheGeometry([[0.1, -0.09], [0.125, -0.03], [0.13, 0.04], [0.118, 0.08]].map(([r, y]) => new THREE.Vector2(r + inf, y)), SEG);
  pelvisG.scale(1, 1, 0.72);
  add(eva || bare ? suit : limbM, place(pelvisG, T, madd(P.pelvis, T.u, -0.02)));
  // Hombros definidos: yugo + deltoides esféricos.
  const shR = 0.058 + inf;
  add(suit, limb(P.shoulderA, P.shoulderB, shR * 0.9, shR * 0.9, SEG, T.f));
  add(suit, joint(P.shoulderA, shR + 0.004));
  add(suit, joint(P.shoulderB, shR + 0.004));

  // Cuello y cabeza ovoide facetada (maniquí sin rasgos).
  const H = frame(sub(P.head, P.neck), P.headFwd);
  const neckTop = madd(P.neck, H.u, 0.05);
  add(skin, limb(madd(P.chest, T.u, 0.04), neckTop, 0.045, 0.04));
  add(skin, joint(neckTop, 0.04));
  const headC = madd(P.neck, H.u, 0.12);
  if (eva) {
    const helm = new THREE.IcosahedronGeometry(0.16, 1);
    add(suit, place(helm, H, headC));
    const visor = new THREE.SphereGeometry(0.162, 10, 6, Math.PI / 2 - 0.85, 1.7, 0.95, 0.85);
    add(visorMaterial(), place(visor, H, madd(headC, H.f, 0.012)));
    add(accent, ring(madd(P.chest, T.u, 0.07), T.u, 0.085, 0.018));
  } else {
    const head = new THREE.SphereGeometry(0.1, SEG, 6);
    head.scale(0.86, 1.15, 0.98);
    add(skin, place(head, H, headC));
    // Mandíbula: bloque achaflanado bajo la cara.
    add(skin, block(madd(madd(headC, H.u, -0.07), H.f, 0.03), H.f, H.u, 0.11, 0.06, 0.09, 0.3));
  }

  // Extremidades: segmentos + esferas de transición del mismo radio.
  for (const s of ['A', 'B']) {
    const sh = P['shoulder' + s], el = P['elbow' + s], wr = P['wrist' + s], ha = P['hand' + s];
    const hi = P['hip' + s], kn = P['knee' + s], an = P['ankle' + s], to = P['toe' + s];
    const rU = 0.05 + inf, rE = 0.041 + inf, rW = 0.031 + inf * 0.6;
    // Brazo: deltoides/bíceps abultado y antebrazo ancho junto al codo.
    add(suit, muscle(sh, el, [[0, rU], [0.3, rU * 1.06], [0.62, rU * 0.96], [0.88, rE * 1.04], [1, rE]], T.f));
    add(suit, joint(el, rE));
    add(suit, muscle(el, wr, [[0, rE], [0.22, rE * 1.14], [0.55, rE * 0.98], [0.85, rW * 1.06], [1, rW]], T.f));
    add(suit, joint(wr, rW));
    add(eva ? boot : skin, block(madd(wr, norm(sub(ha, wr)), 0.045), sub(ha, wr), T.f, 0.075 + inf, 0.03 + inf, 0.11, 0.3));
    const rH = 0.085 + inf, rK = 0.058 + inf, rA = 0.04 + inf;
    // Pierna: muslo cónico con cuádriceps, rodilla estrecha, gemelo y tobillo fino.
    add(limbM, muscle(hi, kn, [[0, rH], [0.25, rH * 1.02], [0.6, rH * 0.86], [0.88, rK * 1.03], [1, rK]], T.f));
    add(limbM, joint(hi, rH));
    add(limbM, joint(kn, rK));
    add(limbM, muscle(kn, an, [[0, rK], [0.25, rK * 1.12], [0.5, rK * 0.98], [0.82, rA * 1.04], [1, rA]], T.f));
    add(limbM, joint(an, rA));
    const fd = sub(to, an);
    add(boot, block(madd(an, norm(fd), 0.05), fd, [0, 1, 0], 0.095 + inf, 0.075 + inf * 0.5, len(fd) + 0.11, 0.35));
    if (eva) {
      add(accent, ring(el, sub(wr, sh), rE + 0.008, 0.012));
      add(accent, ring(kn, sub(an, hi), rK + 0.008, 0.013));
    }
  }

  // Indumentaria.
  if (eva) {
    add(boot, place(new THREE.BoxGeometry(0.3, 0.38, 0.13), T, madd(madd(P.pelvis, T.u, TL * 0.72), T.f, -0.17)));
    add(accent, place(new THREE.BoxGeometry(0.17, 0.11, 0.05), T, madd(madd(P.pelvis, T.u, 0.3), T.f, 0.12)));
  } else if (outfit === 'uniform') {
    add(boot, place(new THREE.CylinderGeometry(0.13, 0.13, 0.04, SEG, 1, true).scale(1, 1, 0.7), T, madd(P.pelvis, T.u, 0.08)));
    add(accent, place(new THREE.BoxGeometry(0.1, 0.015, 0.07), T, madd(P.shoulderA, T.u, shR * 0.9)));
    add(accent, place(new THREE.BoxGeometry(0.1, 0.015, 0.07), T, madd(P.shoulderB, T.u, shR * 0.9)));
  } else if (outfit === 'labcoat') {
    // Bata: falda troncocónica abierta desde la cintura hasta las rodillas.
    const skirt = new THREE.CylinderGeometry(0.15, 0.22, 0.5, SEG, 1, true);
    skirt.scale(1, 1, 0.75);
    add(suit, place(skirt, T, madd(P.pelvis, T.u, -0.17)));
    add(accent, place(new THREE.BoxGeometry(0.05, 0.02, 0.01), T, madd(madd(P.pelvis, T.u, TL * 0.75), T.f, 0.12).map((v, i) => v + T.r[i] * 0.08)));
  }

  const g = new THREE.Group();
  for (const [m, list] of parts) {
    const geo = mergeParts(list);
    if (!geo) continue;
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

// -----------------------------------------------------------------------------
// Brazo EVA de primera persona, low-poly, con AGARRE PARAMÉTRICO.
// spec: { axis, palm, r, wrist, forearm, thumb: 'wrap' | [x,y,z],
//         index?: [j1, j2, tip], fingerS?: [s0..s3], movable?: 'thumb' | 'index' }
// Falanges: troncos de cono de 8 caras; nudillos: esferas del mismo radio.
// Devuelve un Group con userData.screen y userData.digit = { pivot, axis }.
// -----------------------------------------------------------------------------
export function buildEVAArm(spec) {
  const A = norm(spec.axis), Pd = norm(spec.palm), Wd = norm(cross(A, Pd));
  const r = spec.r, sep = spec.movable || null;
  // Radio de los nudillos: una cuerda de 60° entre nudillos queda tangente al cilindro.
  const RF = (r + 0.0108) / Math.cos(Math.PI / 6) + 0.0015;
  const ringPt = (s, deg, rad) => {
    const a = (deg * Math.PI) / 180;
    return madd(madd(madd([0, 0, 0], A, s), Pd, Math.cos(a) * rad), Wd, Math.sin(a) * rad);
  };
  const segs = []; // [a, b, r1, r2, articulado]
  const fS = spec.fingerS || [0.033, 0.011, -0.011, -0.033];
  for (let i = 0; i < 4; i++) {
    const s = fS[i], k = i === 3 ? 0.88 : 1, mov = sep === 'index' && i === 0;
    const base = madd(madd(madd([0, 0, 0], A, s), Pd, r + 0.024), Wd, 0.018);
    if (i === 0 && spec.index) {
      const [j1, j2, tip] = spec.index;
      segs.push([base, j1, 0.0118, 0.0112, mov], [j1, j2, 0.0112, 0.0102, mov], [j2, tip, 0.0102, 0.0092, mov]);
      continue;
    }
    const j1 = ringPt(s, 40, RF), j2 = ringPt(s, 100, RF), j3 = ringPt(s, 100 + 60 * k, RF), tip = ringPt(s, 160 + 50 * k, RF);
    segs.push([base, j1, 0.0118, 0.0112, mov], [j1, j2, 0.0112, 0.0104, mov], [j2, j3, 0.0104, 0.0096, mov], [j3, tip, 0.0096, 0.009, mov]);
  }
  const palmC = madd([0, 0, 0], Pd, r + 0.028);
  const W = madd(palmC, norm(spec.wrist), 0.06);
  const D = norm(spec.forearm), E = madd(W, D, 0.62);
  const up = norm(madd([0, 1, 0], D, -dot([0, 1, 0], D)));
  const thumbBase = madd(madd(palmC, A, 0.03), Wd, -0.026);
  let th1, th2;
  if (spec.thumb === 'wrap') { th1 = ringPt(0.045, -45, RF); th2 = ringPt(0.04, -105, RF); }
  else { th2 = madd(spec.thumb, up, 0.013); th1 = [0, 1, 2].map((i) => (thumbBase[i] + th2[i]) / 2 + up[i] * 0.012); }
  segs.push([thumbBase, th1, 0.0135, 0.012, sep === 'thumb'], [th1, th2, 0.012, 0.0105, sep === 'thumb']);

  const glove = mat(0x55565b), plate = mat(0x3a3d42, { metalness: 0.3 }), cuff = mat(0x4a4e55), sleeve = mat(0xb8b1a3), gaunt = mat(0xc0602a);
  const parts = new Map(), digitParts = [];
  const add = (m, g) => { if (!parts.has(m)) parts.set(m, []); parts.get(m).push(g); };
  const fingerGeo = (sg, out) => {
    out.push(limb(sg[0], sg[1], sg[2], sg[3], SEG, Pd));
    out.push(joint(sg[0], sg[2]));
    out.push(joint(sg[1], sg[3]));
  };
  const gl = [];
  for (const sg of segs) fingerGeo(sg, sg[4] ? digitParts : gl);
  for (const x of gl) add(glove, x);

  // Palma y placas dorsales: bloques biselados en el marco de la palma.
  const palmF = { r: Pd, u: A, f: [-Wd[0], -Wd[1], -Wd[2]] }; // base dextrógira
  const pb = (c, w, h, d, m) => add(m, place(new THREE.BoxGeometry(w, h, d), palmF, c));
  pb(palmC, 0.044, 0.112, 0.088, glove);
  pb(madd([0, 0, 0], Pd, r + 0.046), 0.01, 0.086, 0.062, plate);
  pb(madd(madd([0, 0, 0], Pd, r + 0.03), Wd, 0.03), 0.014, 0.1, 0.018, plate);
  // Muñeca, puño del guante, manga y guantelete.
  add(glove, limb(palmC, W, 0.03, 0.037, SEG, up));
  add(glove, joint(W, 0.037));
  add(cuff, ring(madd(W, D, 0.03), D, 0.058, 0.016));
  add(sleeve, limb(madd(W, D, 0.02), E, 0.054, 0.08, 10, up));
  const DF = frame(D, up);
  add(gaunt, place(new THREE.BoxGeometry(0.1, 0.27, 0.016), { r: DF.r, u: DF.u, f: DF.f }, madd(madd(W, D, 0.205), up, 0.068)));
  add(sleeve, ring(madd(W, D, 0.43), D, 0.071, 0.009));

  const group = new THREE.Group();
  for (const [m, list] of parts) {
    group.add(new THREE.Mesh(mergeParts(list), m));
  }
  if (sep && digitParts.length) {
    const ds = segs.filter((g) => g[4]);
    const hinge = ds[0][0], tip = ds[ds.length - 1][1];
    const v = norm(sub(tip, hinge));
    // Ángulo positivo: el pulgar hunde el pulsador / el índice va hacia la empuñadura.
    const pushDir = sep === 'thumb' ? [-up[0], -up[1], -up[2]] : [-Wd[0], -Wd[1], -Wd[2]];
    const axis = new THREE.Vector3(...norm(cross(v, pushDir)));
    const dGeo = mergeParts(digitParts);
    dGeo.translate(-hinge[0], -hinge[1], -hinge[2]);
    const pivot = new THREE.Group();
    pivot.position.set(hinge[0], hinge[1], hinge[2]);
    pivot.add(new THREE.Mesh(dGeo, glove));
    group.add(pivot);
    group.userData.digit = { pivot, axis };
  }
  const sp = madd(madd(W, D, 0.13), up, 0.072);
  group.userData.screen = { pos: new THREE.Vector3(...sp), normal: new THREE.Vector3(...up) };
  return group;
}
