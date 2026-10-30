// =============================================================================
// items.js
// Modelos procedurales de los objetos del inventario. Los usan el nivel (como
// recogibles) y el brazo en primera persona (como objeto en mano).
// Convención: el objeto apunta hacia -Z y su empuñadura está en el origen.
// =============================================================================
import * as THREE from 'three';

let M = null;
const em = (c, i) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: i });

export function initItemMaterials(lib) {
  M = {
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.8, roughness: 0.4 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.0, roughness: 0.9 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xaab0b8, metalness: 1, roughness: 0.38 }),
    carbon: new THREE.MeshStandardMaterial({ color: 0x23272b, metalness: 0.6, roughness: 0.38, normalMap: lib.floor.normalMap, normalScale: new THREE.Vector2(0.3, 0.3) }),
    body: new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.7, roughness: 0.35, normalMap: lib.capsule.normalMap, normalScale: new THREE.Vector2(0.4, 0.4) }),
    accent: new THREE.MeshStandardMaterial({ color: 0xc8682a, metalness: 0.3, roughness: 0.5 }),
    card: new THREE.MeshStandardMaterial({ color: 0xd8d0c0, roughness: 0.5, metalness: 0.1 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xc8a040, metalness: 1, roughness: 0.3 }),
  };
}

const cyl = (r0, r1, h, mat, seg = 16) => {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg);
  g.rotateX(Math.PI / 2);
  return new THREE.Mesh(g, mat);
};
const boxm = (w, h, d, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
};

// Linterna táctica: cuerpo estriado, cabezal ensanchado y lente emisiva.
export function buildFlashlight() {
  const g = new THREE.Group();
  const lensMat = em(0xfff2c0, 2.5);
  const body = cyl(0.022, 0.022, 0.2, M.dark);
  body.position.z = -0.02;
  const head = cyl(0.034, 0.025, 0.06, M.dark, 20);
  head.position.z = -0.15;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.029, 20), lensMat);
  lens.position.z = -0.181;
  lens.rotation.y = Math.PI;
  const tail = cyl(0.024, 0.024, 0.02, M.chrome);
  tail.position.z = 0.085;
  // Pulsador bajo el pulgar (se hunde al pulsar [F]).
  const sw = boxm(0.012, 0.008, 0.022, M.accent, 0, 0.024, -0.06);
  g.add(body, head, lens, tail, sw);
  for (let k = 0; k < 4; k++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.0225, 0.003, 6, 16), M.grip);
    r.position.z = 0.04 - k * 0.022;
    g.add(r);
  }
  g.userData.lensMat = lensMat;
  g.userData.switch = sw;
  return g;
}

export function buildCard() {
  const g = new THREE.Group();
  g.add(boxm(0.085, 0.004, 0.054, M.card));
  const stripe = boxm(0.085, 0.005, 0.012, em(0xff6a2a, 2), 0, 0, 0.016);
  g.add(stripe, boxm(0.014, 0.005, 0.011, M.gold, -0.025, 0, -0.008));
  return g;
}

export function buildCell() {
  const g = new THREE.Group();
  const glow = em(0x40e0ff, 3);
  g.add(cyl(0.035, 0.035, 0.15, M.dark), cyl(0.036, 0.036, 0.03, glow));
  const c1 = cyl(0.03, 0.03, 0.012, M.chrome); c1.position.z = 0.08;
  const c2 = cyl(0.03, 0.03, 0.012, M.chrome); c2.position.z = -0.08;
  g.add(c1, c2);
  g.userData.glowMat = glow;
  return g;
}

// Maletín de contención: carbono, rieles luminosos, ventana de ADN y cierres.
export function buildBriefcase() {
  const g = new THREE.Group();
  const glow = em(0x30ff90, 5);
  g.add(boxm(0.62, 0.15, 0.44, M.carbon), boxm(0.6, 0.03, 0.42, M.carbon, 0, 0.09, 0));
  g.add(boxm(0.28, 0.012, 0.1, glow, 0, 0.108, 0.05));
  g.add(boxm(0.64, 0.012, 0.012, glow, 0, 0, 0.225), boxm(0.64, 0.012, 0.012, glow, 0, 0, -0.225));
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 8, 16, Math.PI), M.chrome);
  handle.position.set(0, 0.105, -0.17);
  g.add(handle);
  [-0.22, 0.22].forEach((x) => g.add(boxm(0.06, 0.05, 0.03, M.chrome, x, 0.06, 0.228)));
  g.userData.glowMat = glow;
  return g;
}

// Rifle de plasma compacto: receptor, raíl, mira con punto, cañón con tres
// bobinas de aceleración, célula de energía lateral y emisor de boca.
export function buildPlasma() {
  const g = new THREE.Group();
  const coilMat = em(0x40d8ff, 3);
  const cellMat = em(0x40d8ff, 2);
  g.add(boxm(0.07, 0.09, 0.34, M.body, 0, 0.06, -0.08));
  g.add(boxm(0.072, 0.03, 0.2, M.accent, 0, 0.03, -0.04));
  g.add(boxm(0.03, 0.015, 0.26, M.dark, 0, 0.112, -0.08));
  g.add(boxm(0.026, 0.032, 0.05, M.dark, 0, 0.135, -0.02));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.005, 10), em(0xff3020, 6));
  dot.position.set(0, 0.138, 0.006);
  g.add(dot);
  const slide = new THREE.Group();
  const barrel = cyl(0.032, 0.032, 0.24, M.dark, 20);
  barrel.position.set(0, 0.065, -0.36);
  slide.add(barrel);
  for (let k = 0; k < 3; k++) {
    const c = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.005, 8, 24), coilMat);
    c.position.set(0, 0.065, -0.28 - k * 0.06);
    slide.add(c);
  }
  const emitter = cyl(0.026, 0.03, 0.04, M.chrome, 20);
  emitter.position.set(0, 0.065, -0.495);
  const tip = new THREE.Mesh(new THREE.CircleGeometry(0.02, 20), coilMat);
  tip.position.set(0, 0.065, -0.516);
  tip.rotation.y = Math.PI;
  slide.add(emitter, tip);
  // Manguito fijo sobre el que corre el cañón (oculta la holgura del retroceso).
  const sleeve = cyl(0.036, 0.036, 0.03, M.body, 20);
  sleeve.position.set(0, 0.065, -0.24);
  g.add(slide, sleeve);
  const cell = cyl(0.022, 0.022, 0.12, cellMat);
  cell.position.set(-0.048, 0.05, -0.06);
  const capA = cyl(0.025, 0.025, 0.012, M.chrome); capA.position.set(-0.048, 0.05, 0.0);
  const capB = cyl(0.025, 0.025, 0.012, M.chrome); capB.position.set(-0.048, 0.05, -0.12);
  g.add(cell, capA, capB);
  const grip = boxm(0.04, 0.12, 0.055, M.grip, 0, -0.02, 0.02);
  grip.rotation.x = 0.25;
  // Guardamonte: semiarco de 28 mm colgado del receptor; el índice entra por
  // el costado y apoya la yema en la cara delantera del gatillo.
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.004, 6, 16, Math.PI), M.dark);
  guard.position.set(0, 0.015, -0.06);
  guard.rotation.set(0, Math.PI / 2, Math.PI);
  const trigger = new THREE.Group();
  trigger.position.set(0, 0.015, -0.051);
  const blade = boxm(0.008, 0.022, 0.006, M.chrome, 0, -0.011, 0);
  blade.rotation.x = 0.12;
  trigger.add(blade);
  g.add(grip, guard, trigger, boxm(0.022, 0.045, 0.1, M.dark, 0, 0.055, 0.12), boxm(0.03, 0.06, 0.02, M.accent, 0, 0.045, 0.175));
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.065, -0.53);
  slide.add(muzzle);
  g.userData = { coilMat, cellMat, muzzle, slide, trigger };
  return g;
}

export const ITEM_BUILDERS = {
  linterna: buildFlashlight, tarjeta: buildCard, celula: buildCell, maletin: buildBriefcase, plasma: buildPlasma,
};
