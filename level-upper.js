// =============================================================================
// level-upper.js
// Verticalidad: torre de escalera (dos tramos con rellano) desde el pasillo
// principal hasta la cubierta superior, y el PUENTE DE MANDO: planta en "D"
// con ventanal curvo panorámico (vista a Marte y a los restos de la flota),
// consolas en arco con LEDs y radar, mesa holográfica de navegación,
// terminales de bitácora y la consola de mando. Incluye los módulos
// exteriores correspondientes y los restos flotantes de la flota.
// Las colisiones llevan rango vertical y las escaleras son rampas
// transitables (superficies 'hollow': pasos metálicos huecos).
// =============================================================================
import * as THREE from 'three';
import { mulberry32, globalUniforms, newCanvas, createHologramMaterial, scaleUV, pbr } from './procedural-assets.js';

export function buildUpperDeck(K, XT, rng) {
  const {
    box, addCollider, addCircle, addLight, addLamp, addBeacon, addSign, addTerminal, makeDoor, doorPart, statusStrip,
    emissiveMat, addEmissiveFlicker, settle, M, group, animators, surfaces, arcs, ceilings, LEVEL, ledMat, T, supportMeshes,
  } = K;
  const S = LEVEL.stair, UY = LEVEL.upper.y, B = LEVEL.bridge, X = LEVEL.corr.halfW;

  // ------------------------------------------------------- Torre de escalera
  const sw = S.x1 - S.x0, sl = S.z0 - S.z1, smx = (S.x0 + S.x1) / 2, smz = (S.z0 + S.z1) / 2;
  box(sw + T, 0.2, sl, M.floor, smx + T / 2, -0.1, smz);
  box(sw + T, 0.2, sl, M.ceil, smx + T / 2, S.h + 0.1, smz);
  box(T, S.h + 0.2, sl + 2 * T, M.wall, S.x1 + T / 2, S.h / 2, smz, { collide: true });
  box(sw + 2 * T, S.h + 0.2, T, M.wall, smx, S.h / 2, S.z1 - T / 2, { collide: true });
  box(T, S.h - 3.2, sl, M.wall, X + T / 2, (S.h + 3.2) / 2, smz, { collide: true });
  // Muro norte: macizo abajo; arriba, vano de la puerta del puente (x 2.0..3.8).
  const nz = S.z0 + T / 2;
  box(sw + 2 * T, UY, T, M.wall, smx, UY / 2, nz, { collide: true });
  box(2.0 - X, S.h - UY, T, M.wall, (X + 2.0) / 2, (UY + S.h) / 2, nz, { collide: true });
  box(S.x1 + T - 3.8, S.h - UY, T, M.wall, (3.8 + S.x1 + T) / 2, (UY + S.h) / 2, nz, { collide: true });
  box(1.8, S.h - UY - 2.4, T, M.wall, 2.9, (UY + 2.4 + S.h) / 2, nz);

  const grate = M.floor;
  // Tramo 1 (carril este): bloque macizo de 11 peldaños, 0 → 2.2 m.
  for (let i = 0; i < 11; i++) {
    const top = (i + 1) * 0.2;
    box(1.8, top, 0.3, M.dark, 4.85, top / 2, -13.5 - i * 0.3 - 0.15);
    box(1.8, 0.02, 0.06, M.hazard, 4.85, top + 0.01, -13.5 - i * 0.3 - 0.27, { tex: 0.5 });
  }
  surfaces.push({ minX: 3.95, maxX: 5.75, minZ: -16.8, maxZ: -13.5, axis: 'z', a0: -13.5, a1: -16.8, y0: 0, y1: 2.2, mat: 'hollow' });
  // Rellano intermedio (2.2 m) con cierre inferior.
  box(3.75, 0.2, 2.0, grate, 3.875, 2.1, -17.8, { support: true });
  box(3.75, 2.0, 0.1, M.dark, 3.875, 1.0, -16.85);
  addCollider(2.0, 5.75, -18.8, -16.8, 0, 2.0);
  surfaces.push({ minX: 2.0, maxX: 5.75, minZ: -18.8, maxZ: -16.8, y: 2.2, mat: 'hollow' });
  // Tramo 2 (carril oeste): peldaños calados con zancas, 2.2 → 4.4 m.
  for (let i = 0; i < 11; i++) {
    box(1.8, 0.05, 0.3, grate, 2.9, 2.2 + (i + 1) * 0.2 - 0.025, -16.8 + i * 0.3 + 0.15);
  }
  const ang = Math.atan2(2.2, 3.3), slen = Math.hypot(2.2, 3.3);
  for (const zx of [2.0, 3.8]) {
    const st = box(0.06, 0.3, slen, M.dark, zx, 3.2, -15.15);
    st.rotation.x = -ang;
  }
  box(1.8, 2.2, 3.3, M.wall, 2.9, 1.1, -15.15, { collide: true }); // cierre bajo el tramo 2
  surfaces.push({ minX: 2.0, maxX: 3.8, minZ: -16.8, maxZ: -13.5, axis: 'z', a0: -16.8, a1: -13.5, y0: 2.2, y1: 4.4, mat: 'hollow' });
  // Rellano superior (4.4 m) hasta la puerta del puente.
  box(1.8, 0.2, 4.7, grate, 2.9, UY - 0.1, -11.15, { support: true });
  surfaces.push({ minX: 2.0, maxX: 3.8, minZ: -13.5, maxZ: S.z0, y: UY, mat: 'hollow' });
  // Barandillas (visual + colisión sólo en su franja vertical).
  const railMat = M.pipe;
  for (let z = -9.2; z > -16.8; z -= 1.2) {
    const yb = z > -13.5 ? UY : 2.2 + ((z + 16.8) / 3.3) * 2.2;
    box(0.05, 1.0, 0.05, railMat, 3.85, yb + 0.5, z);
  }
  box(0.05, 0.05, 4.7, railMat, 3.85, UY + 1.0, -11.15);
  const tr = box(0.05, 0.05, slen, railMat, 3.85, 3.3 + 1.0, -15.15);
  tr.rotation.x = -ang;
  addCollider(3.8, 3.9, -13.5, S.z0, UY, UY + 1.2);
  addCollider(3.8, 3.9, -16.8, -13.5, 2.2, UY + 1.0);

  // Puerta interior desde el pasillo, rótulo, luces.
  addSign('PUENTE ↑', 'CUBIERTA DE MANDO // ESCALERA 1', 1.2, 0.3, X - 0.01, 2.5, -12.0, -Math.PI / 2, '#7fd8ff');
  addLamp(smx, S.h, -12.0, 0xcfe0ff, 6, 'flicker', { distance: 10 });
  addLamp(smx, S.h, -17.5, 0xffd2a0, 5, 'broken', { distance: 9 });
  addBeacon(S.x1 - 0.12, 3.0, -10.0);

  // Puerta del puente (sin energía hasta re-enrutarla en la sala de servidores).
  const dPart = doorPart(1.8, 2.4, 0.12, M.door, 2.9, UY + 1.2, S.z0, -1.85, 0, 0);
  const bridgeDoor = makeDoor([dPart], addCollider(2.0, 3.8, S.z0 - 0.2, S.z0 + 0.2, UY, UY + 2.6), 0, 0.7);
  bridgeDoor.statusMats.push(statusStrip(2.9, UY + 2.55, S.z0 + 0.32, 0.6, 0.05, 0xff2010));
  const bridgePower = addTerminal(S.x0 + 0.02, UY + 1.35, -9.8, 1);
  bridgePower.draw('PUENTE', 'SIN ENERGÍA', '#ff5a3a');

  // --------------------------------------------------------- Puente de mando
  const hw = B.hw, zc = B.zc, R = B.R, H = B.h, bz0 = S.z0 - T;
  box(2 * hw + 2 * T, 0.2, zc - bz0, M.floor, 0, UY - 0.1, (zc + bz0) / 2, { support: true });
  box(2 * hw + 2 * T, 0.2, zc - bz0, M.ceil, 0, UY + H + 0.1, (zc + bz0) / 2);
  const halfDisc = (y, mat) => {
    const g = new THREE.CylinderGeometry(R + T, R + T, 0.2, 48, 1, false, -Math.PI / 2, Math.PI);
    scaleUV(g, 2.4, 2.4);
    const m = new THREE.Mesh(g, mat);
    m.position.set(0, y, zc);
    m.receiveShadow = true; m.castShadow = true;
    group.add(m);
    return m;
  };
  supportMeshes.push(halfDisc(UY - 0.1, M.floor));
  halfDisc(UY + H + 0.1, M.ceil);
  surfaces.push({ minX: -hw, maxX: hw, minZ: bz0, maxZ: zc + R, y: UY, mat: 'solid' });
  // Losa entre cubiertas: bloquea visión, sonido y proyectiles a través del suelo
  // (su franja vertical no toca la del cuerpo en ninguno de los dos niveles).
  addCollider(-hw - T, hw + T, bz0, zc + R + T, UY - 0.32, UY - 0.02);
  ceilings.push({ minX: -hw - 0.3, maxX: hw + 0.3, minZ: bz0 - 0.3, maxZ: zc + R + 0.3, floorY: UY, y: UY + H });
  arcs.push({ cx: 0, cz: zc, R: R - 0.1, zMin: zc, yMin: UY - 0.2, yMax: UY + H + 0.2 });
  // Muro trasero con el vano de la puerta.
  const rz = bz0 + T / 2;
  box(2.0 + hw + T, H + 0.2, T, M.wall, (-hw - T + 2.0) / 2, UY + H / 2, rz, { collide: true });
  box(hw + T - 3.8, H + 0.2, T, M.wall, (3.8 + hw + T) / 2, UY + H / 2, rz, { collide: true });
  box(1.8, H - 2.4, T, M.wall, 2.9, UY + 2.4 + (H - 2.4) / 2, rz);
  // Muro derecho macizo; izquierdo con ventanal largo hacia Marte.
  const sideLen = zc - bz0, sideMid = (zc + bz0) / 2;
  box(T, H + 0.2, sideLen, M.wall, hw + T / 2, UY + H / 2, sideMid, { collide: true });
  const wy0 = UY + 0.6, wy1 = UY + 2.6;
  box(T, wy0 - UY + 0.1, sideLen, M.wall, -hw - T / 2, (UY - 0.1 + wy0) / 2, sideMid, { collide: true });
  box(T, UY + H + 0.1 - wy1, sideLen, M.wall, -hw - T / 2, (wy1 + UY + H + 0.1) / 2, sideMid, { collide: true });
  addCollider(-hw - T, -hw, bz0, zc, UY, UY + H);
  const sideGlass = new THREE.Mesh(new THREE.PlaneGeometry(sideLen, wy1 - wy0), M.glass);
  sideGlass.rotation.y = Math.PI / 2;
  sideGlass.position.set(-hw - 0.08, (wy0 + wy1) / 2, sideMid);
  sideGlass.renderOrder = 10;
  const sideMask = new THREE.Mesh(sideGlass.geometry, M.mask);
  sideMask.position.copy(sideGlass.position); sideMask.rotation.copy(sideGlass.rotation); sideMask.renderOrder = 1;
  group.add(sideGlass, sideMask);
  for (let z = zc - 1.45; z > bz0 + 0.5; z -= 1.45) box(0.14, wy1 - wy0, 0.1, M.dark, -hw + 0.02, (wy0 + wy1) / 2, z);

  // Ventanal curvo panorámico (semicilindro), con zócalo, dintel y montantes.
  const wallD = M.wall.clone();
  wallD.side = THREE.DoubleSide;
  const arc = (r, y0, y1, mat, ro) => {
    const g = new THREE.CylinderGeometry(r, r, y1 - y0, 64, 1, true, -Math.PI / 2, Math.PI);
    scaleUV(g, 7, (y1 - y0) / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(0, (y0 + y1) / 2, zc);
    if (ro !== undefined) m.renderOrder = ro;
    group.add(m);
    return m;
  };
  const gy0 = UY + 0.55, gy1 = UY + H - 0.35;
  arc(R, UY - 0.1, gy0, wallD).castShadow = true;
  arc(R, gy1, UY + H + 0.2, wallD).castShadow = true;
  const glassD = M.glass.clone();
  glassD.side = THREE.DoubleSide;
  arc(R - 0.04, gy0, gy1, glassD, 10);
  const maskD = M.mask.clone();
  maskD.side = THREE.DoubleSide;
  arc(R - 0.04, gy0, gy1, maskD, 1);
  for (let k = 0; k <= 8; k++) {
    const a = -Math.PI / 2 + (k / 8) * Math.PI;
    const mm = box(0.1, gy1 - gy0, 0.14, M.dark, Math.sin(a) * (R - 0.06), (gy0 + gy1) / 2, zc + Math.cos(a) * (R - 0.06));
    mm.rotation.y = a;
  }

  // Consolas en arco frente al ventanal (LEDs + pantallas de navegación).
  const screenTex = (kind) => {
    const c = newCanvas(256, 160), x = c.getContext('2d'), rr = mulberry32(kind.length * 7);
    x.fillStyle = '#020608'; x.fillRect(0, 0, 256, 160);
    x.strokeStyle = '#4fc3ff'; x.lineWidth = 2; x.strokeRect(4, 4, 248, 152);
    x.fillStyle = '#9fe8ff'; x.font = 'bold 14px Consolas, monospace'; x.fillText(kind, 12, 22);
    if (kind === 'TRAYECTORIA') {
      x.strokeStyle = '#ff7a3a'; x.beginPath(); x.ellipse(128, 92, 70, 40, -0.3, 0, Math.PI * 2); x.stroke();
      x.fillStyle = '#ff7a3a'; x.beginPath(); x.arc(128, 92, 12, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#7affc8'; x.setLineDash([4, 4]); x.beginPath(); x.moveTo(40, 140); x.quadraticCurveTo(110, 40, 190, 70); x.stroke();
    } else {
      for (let k = 0; k < 9; k++) {
        const h = 10 + rr() * 90;
        x.fillStyle = h > 80 ? '#ff5a3a' : '#4fc3ff';
        x.fillRect(16 + k * 26, 148 - h, 16, h);
      }
      x.fillStyle = '#ff5a3a'; x.fillText('ESTADO: CRÍTICO', 12, 44);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const radarMat = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * vec2(1.6, 1.0);
        float r = length(p), a = atan(p.y, p.x);
        float sweep = fract((a / 6.2831853) - uTime * 0.25);
        float g = exp(-sweep * 9.0) * step(r, 0.48);
        float rings = (1.0 - smoothstep(0.0, 0.012, abs(fract(r * 8.0) - 0.5) - 0.47)) * 0.35 * step(r, 0.48);
        float blip = step(0.97, fract(sin(floor(a * 6.0) * 91.3 + floor(r * 9.0) * 17.1) * 4375.5)) * step(r, 0.45) * g * 3.0;
        gl_FragColor = vec4(vec3(0.2, 1.0, 0.6) * (g * 0.9 + rings + blip) * 1.3 + vec3(0.01, 0.03, 0.03), 1.0);
      }`,
  });
  const texs = [screenTex('TRAYECTORIA'), screenTex('SISTEMAS'), screenTex('TRAYECTORIA'), screenTex('SISTEMAS')];
  const consolePos = [];
  [-60, -30, 0, 30, 60].forEach((deg, k) => {
    const a = THREE.MathUtils.degToRad(deg), px = Math.sin(a) * 3.2, pz = zc + Math.cos(a) * 3.2;
    const g = new THREE.Group();
    g.position.set(px, UY, pz);
    g.lookAt(0, UY, zc);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.5), M.dark);
    base.position.y = 0.4; base.castShadow = base.receiveShadow = true;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.55), M.heavy);
    top.position.set(0, 0.84, 0.05); top.rotation.x = 0.45;
    const leds = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.42), ledMat);
    leds.position.set(0, 0.875, 0.065); leds.rotation.x = -Math.PI / 2 + 0.45;
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.48), k === 2 ? radarMat : new THREE.MeshBasicMaterial({ map: texs[k % 4], color: new THREE.Color(1.4, 1.4, 1.4) }));
    scr.position.set(0, 1.22, -0.16); scr.rotation.x = -0.2;
    const scrBack = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.54, 0.04), M.dark);
    scrBack.position.set(0, 1.22, -0.19); scrBack.rotation.x = -0.2;
    g.add(base, top, leds, scrBack, scr);
    group.add(g);
    g.updateMatrixWorld(true);
    supportMeshes.push(base);
    addCircle(px, pz, 0.55, UY, UY + 1.5);
    consolePos.push([px, pz, a]);
  });
  addLight(0, UY + 1.2, zc + 2.6, 0x40ff90, 1.6, 'steady', { distance: 6 });

  // Silla del capitán y navegante muerto frente a la consola central.
  box(0.6, 0.12, 0.6, M.rubber, 0, UY + 0.45, zc - 0.6);
  box(0.6, 0.8, 0.1, M.rubber, 0, UY + 0.85, zc - 0.92);
  box(0.12, 0.45, 0.12, M.dark, 0, UY + 0.2, zc - 0.6);
  addCircle(0, zc - 0.6, 0.42, UY, UY + 1.3);
  const navX = 0, navZ = zc + 3.2 - 0.95;
  box(0.5, 0.45, 0.5, M.rubber, navX, UY + 0.225, navZ, { support: true });
  K.placeBody('slumped', 'uniform', navX, UY + 0.3, navZ - 0.05, 0, { baseY: UY });

  // Mesa holográfica de navegación: Marte, órbita, la nave y restos de la flota.
  const tz = bz0 + 2.2;
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 1.0, 24), M.dark);
  ped.position.set(0, UY + 0.5, tz); ped.castShadow = ped.receiveShadow = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.015, 6, 48), emissiveMat(0x4fc3ff, 3));
  ring.rotation.x = Math.PI / 2; ring.position.set(0, UY + 1.02, tz);
  group.add(ped, ring);
  addCircle(0, tz, 0.72, UY, UY + 1.4);
  const holo = new THREE.Group();
  holo.position.set(0, UY + 1.55, tz);
  const hm = (c, op = 0.85) => { const m = createHologramMaterial({ color: c }); m.uniforms.uOpacity.value = op; return m; };
  const marsW = hm(0xff8a5a);
  marsW.wireframe = true;
  holo.add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 14), marsW));
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.004, 4, 80), hm(0x9fe8ff));
  orbit.rotation.x = Math.PI / 2 + 0.25;
  holo.add(orbit);
  const shipMark = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), hm(0x7affc8, 1));
  holo.add(shipMark);
  const rr = mulberry32(9);
  for (let k = 0; k < 7; k++) {
    const w = new THREE.Mesh(new THREE.TetrahedronGeometry(0.022), hm(0xff3020, 1));
    const a = rr() * Math.PI * 2, r = 0.55 + rr() * 0.2;
    w.position.set(Math.cos(a) * r, (rr() - 0.5) * 0.2, Math.sin(a) * r);
    holo.add(w);
  }
  group.add(holo);
  animators.push((dt, t) => {
    holo.rotation.y += dt * 0.15;
    const a = t * 0.4;
    shipMark.position.set(Math.cos(a) * 0.48, Math.sin(a) * 0.12, Math.sin(a) * 0.48);
  });
  addLight(0, UY + 1.6, tz, 0x4fb4ff, 2.0, 'steady', { distance: 6 });

  // Terminales: bitácoras y consola de mando (descifrado de la cuarentena).
  const logCaptain = addTerminal(hw - 0.02, UY + 1.35, bz0 + 1.6, -1);
  logCaptain.draw('BITÁCORA', 'CAPITÁN', '#7fd8ff');
  const logNav = addTerminal(hw - 0.02, UY + 1.35, bz0 + 3.6, -1);
  logNav.draw('BITÁCORA', 'NAVEGACIÓN', '#7fd8ff');
  const bridgeCmd = addTerminal(hw - 0.02, UY + 1.35, zc - 0.4, -1);
  bridgeCmd.draw('MANDO', 'CUARENTENA', '#ff5a3a');

  addLamp(-1.5, UY + H, bz0 + 2.0, 0xdfe8ff, 6, 'flicker', { distance: 10, w: 0.4, d: 1.4 });
  addLamp(1.5, UY + H, zc - 1.0, 0xdfe8ff, 5, 'steady', { distance: 10, w: 0.4, d: 1.4 });
  addBeacon(hw - 0.12, UY + 2.9, bz0 + 0.8);
  addSign('PUENTE DE MANDO', 'ODISEA-IX // CUBIERTA 3', 1.6, 0.36, 0, UY + H - 0.35, bz0 + 0.01, 0, '#7fd8ff');

  // --------------------------------------------------- Módulos exteriores
  const { addX, XM } = XT;
  const prism = (cx, hwid, y0, y1, ch, z0, z1, mat) => {
    const s = new THREE.Shape();
    [[cx - hwid + ch, y0], [cx + hwid - ch, y0], [cx + hwid, y0 + ch], [cx + hwid, y1 - ch], [cx + hwid - ch, y1], [cx - hwid + ch, y1], [cx - hwid, y1 - ch], [cx - hwid, y0 + ch]]
      .forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    const g = new THREE.ExtrudeGeometry(s, { depth: z0 - z1, bevelEnabled: false });
    scaleUV(g, 0.25, 0.25);
    return addX(g, mat, 0, 0, z1);
  };
  prism(4.0, 2.5, -0.6, S.h + 0.5, 0.6, S.z0 + 0.4, S.z1 - 0.4, XM.dark);           // torre de escalera
  prism(0, hw + 0.5, UY - 0.4, UY + H + 0.5, 0.7, zc, bz0 - 0.4, XM.hull);         // puente (parte trasera)
  const dome = new THREE.CylinderGeometry(R + 0.5, R + 0.5, H + 0.9, 40, 1, false, -Math.PI / 2, Math.PI);
  scaleUV(dome, 4, 1);
  addX(dome, XM.hull, 0, UY + (H + 0.1) / 2, zc);
  const band = new THREE.CylinderGeometry(R + 0.52, R + 0.52, gy1 - gy0, 48, 1, true, -Math.PI / 2, Math.PI);
  addX(band, XM.window, 0, (gy0 + gy1) / 2, zc);
  const sideX = addX(new THREE.PlaneGeometry(sideLen, wy1 - wy0), XM.window, -hw - 0.51, (wy0 + wy1) / 2, sideMid);
  sideX.rotation.y = -Math.PI / 2;
  addX(new THREE.CylinderGeometry(0.08, 0.08, 3.5, 8), XM.trim, -2.5, UY + H + 2.2, bz0 + 1.5);
  const dish = addX(new THREE.SphereGeometry(1.1, 20, 10, 0, Math.PI * 2, 0, 0.7), XM.dark, -2.5, UY + H + 3.9, bz0 + 1.5);
  dish.rotation.set(-0.8, 0, 0.4);
  addX(new THREE.SphereGeometry(0.6, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), XM.trim, 2.0, UY + H + 0.5, bz0 + 3.0);

  return {
    doors: { bridge: bridgeDoor },
    terminals: { bridgePower, bridgeCmd },
    logTerms: [{ pos: logCaptain.pos, id: 'capitan' }, { pos: logNav.pos, id: 'navegacion' }],
    wrecks: buildFleetWrecks(K.lib),
  };
}

// -----------------------------------------------------------------------------
// Restos de la flota: cascos partidos con bordes desgarrados (vértices
// desplazados), escombros orbitando y luces de emergencia moribundas.
// -----------------------------------------------------------------------------
function buildFleetWrecks(lib) {
  const g = new THREE.Group();
  g.name = 'wrecks';
  const hull = pbr(lib.hull, { color: 0x6a655e, envMapIntensity: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.9, metalness: 0.4 });
  const rr = mulberry32(2024);
  const spots = [[-70, 22, 120, 26], [-150, -25, 55, 34], [-60, 40, 230, 40], [-230, 18, -10, 30], [-20, -45, 300, 52], [-110, 60, 170, 22]];
  const debrisGeo = new THREE.BoxGeometry(1, 1, 1);
  for (const [x, y, z, len] of spots) {
    const wr = new THREE.Group();
    wr.position.set(x, y, z);
    wr.rotation.set(rr() * 0.6, rr() * Math.PI * 2, rr() * 0.8);
    const rad = len * 0.12;
    for (const side of [-1, 1]) {
      const pl = len * (0.35 + rr() * 0.15);
      const geo = new THREE.CylinderGeometry(rad, rad * (0.8 + rr() * 0.3), pl, 8, 6, false);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const yy = p.getY(i);
        if (yy * side < -pl * 0.3) {   // extremo partido: desgarro irregular
          p.setY(i, yy + (rr() - 0.5) * pl * 0.25);
          p.setX(i, p.getX(i) * (0.7 + rr() * 0.5));
          p.setZ(i, p.getZ(i) * (0.7 + rr() * 0.5));
        }
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, hull);
      m.rotation.z = Math.PI / 2;
      m.position.x = side * (pl / 2 + len * 0.06 + rr() * len * 0.1);
      m.rotation.y = (rr() - 0.5) * 0.4 * side;
      wr.add(m);
      const tower = new THREE.Mesh(new THREE.BoxGeometry(rad * 0.8, rad * 0.9, rad * 1.2), dark);
      tower.position.set(m.position.x * 0.6, rad * 1.1, 0);
      wr.add(tower);
    }
    const deb = new THREE.InstancedMesh(debrisGeo, dark, 24);
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), ps = new THREE.Vector3(), sc = new THREE.Vector3();
    for (let i = 0; i < 24; i++) {
      ps.set((rr() - 0.5) * len * 0.5, (rr() - 0.5) * len * 0.5, (rr() - 0.5) * len * 0.5);
      q.setFromEuler(e.set(rr() * 3, rr() * 3, rr() * 3));
      const s = rad * (0.08 + rr() * 0.35);
      sc.set(s * (1 + rr()), s * 0.4, s);
      deb.setMatrixAt(i, mt.compose(ps, q, sc));
    }
    wr.add(deb);
    const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.4, 0.2) });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(rad * 0.08, 8, 6), lm);
    lamp.position.set(len * 0.2, rad, 0);
    wr.add(lamp);
    g.add(wr);
  }
  return g;
}
