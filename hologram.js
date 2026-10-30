// =============================================================================
// hologram.js
// Transmisión holográfica de Helix-Ares:
//  · Figura humanoide de alta definición renderizada por RAYMARCHING de un SDF
//    (cabeza con rasgos faciales, peinado, torso, brazos, abrigo) dentro de una
//    caja contenedora: silueta perfecta sin polígonos, ~0 bytes de malla.
//    Sombreado holográfico: fresnel, curvas de nivel, líneas de escaneo, aura
//    volumétrica acumulada durante la marcha y cortes de interferencia.
//  · Haz de proyección desde el techo, anillos de barrido y partículas.
//  · Ventana de datos translúcida integrada en la sala (texto legible en 3D).
// =============================================================================
import * as THREE from 'three';
import { globalUniforms, createHologramMaterial, newCanvas, mulberry32, smoothstep } from './procedural-assets.js';

// -----------------------------------------------------------------------------
// SDF de la figura (unidades en metros, pies en y = 0, mira hacia +Z).
// smin = unión suave polinómica; smax = sustracción suave.
// -----------------------------------------------------------------------------
const SDF_GLSL = /* glsl */ `
  float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
  float smax(float a, float b, float k) { return -smin(-a, -b, k); }
  float sdCap(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
  float sdEll(vec3 p, vec3 r) { float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / k1; }
  float sdRoundCone(vec3 p, float r1, float r2, float h) {
    vec2 q = vec2(length(p.xz), p.y);
    float b = (r1 - r2) / h, a = sqrt(max(1.0 - b * b, 0.0)), k = dot(q, vec2(-b, a));
    if (k < 0.0) return length(q) - r1;
    if (k > a * h) return length(q - vec2(0.0, h)) - r2;
    return dot(q, vec2(a, b)) - r1;
  }
  mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

  // Cabeza articulada en el cuello (giro y cabeceo animados).
  float head(vec3 p) {
    vec3 hp = p - vec3(0.0, 1.5, 0.0);
    hp.xz = rot2(uHeadYaw) * hp.xz;
    hp.zy = rot2(uHeadPitch) * hp.zy;
    p = hp + vec3(0.0, 1.5, 0.0);
    vec3 q = vec3(abs(p.x), p.y, p.z);
    float d = sdEll(p - vec3(0.0, 1.63, 0.0), vec3(0.08, 0.104, 0.097));
    d = smin(d, sdEll(p - vec3(0.0, 1.567, 0.024), vec3(0.064, 0.054, 0.068)), 0.03);          // mandíbula
    d = smin(d, sdEll(q - vec3(0.047, 1.6, 0.06), vec3(0.025, 0.022, 0.025)), 0.02);            // pómulos
    d = smin(d, sdCap(p, vec3(0.0, 1.637, 0.088), vec3(0.0, 1.6, 0.11), 0.011), 0.014);         // nariz
    d = smin(d, sdEll(q - vec3(0.036, 1.657, 0.083), vec3(0.03, 0.011, 0.018)), 0.012);         // cejas
    d = smax(d, -sdEll(q - vec3(0.034, 1.633, 0.094), vec3(0.019, 0.012, 0.014)), 0.008);       // cuencas
    d = smin(d, sdEll(q - vec3(0.034, 1.633, 0.085), vec3(0.012, 0.009, 0.01)), 0.004);         // ojos
    d = smin(d, sdEll(q - vec3(0.034, 1.641, 0.089), vec3(0.016, 0.005, 0.009)), 0.004);        // párpados
    d = smin(d, sdEll(p - vec3(0.0, 1.574, 0.088), vec3(0.022, 0.0075, 0.011)), 0.006);         // labios
    d = smax(d, -sdEll(p - vec3(0.0, 1.574, 0.099), vec3(0.018, 0.0018, 0.006)), 0.002);        // comisura
    d = smin(d, sdEll(q - vec3(0.083, 1.625, -0.004), vec3(0.012, 0.026, 0.018)), 0.01);        // orejas
    float hair = sdEll(p - vec3(0.0, 1.668, -0.014), vec3(0.09, 0.083, 0.1));
    hair = smin(hair, sdEll(p - vec3(0.0, 1.625, -0.105), vec3(0.046, 0.046, 0.04)), 0.03);     // moño
    hair = smax(hair, (p.z - 0.05) + (1.69 - p.y) * 0.85, 0.02);                                // despeja la cara
    return smin(d, hair, 0.008);
  }
  float arm(vec3 p, vec3 sh, vec3 el, vec3 wr) {
    return smin(sdCap(p, sh, el, 0.043), sdCap(p, el, wr, 0.036), 0.02);
  }
  float body(vec3 p) {
    vec3 q = vec3(abs(p.x), p.y, p.z);
    float br = 1.0 + 0.025 * uBreath, lift = 0.004 * uBreath;
    float d = sdCap(p, vec3(0.0, 1.44, -0.005), vec3(0.0, 1.54, 0.0), 0.042);                   // cuello
    float t = sdEll(p - vec3(0.0, 1.27, 0.0), vec3(0.165, 0.17 * br, 0.095 * br));             // pecho (respira)
    t = smin(t, sdEll(p - vec3(0.0, 1.06, 0.0), vec3(0.125, 0.15, 0.085)), 0.07);
    t = smin(t, sdEll(p - vec3(0.0, 0.9, 0.0), vec3(0.16, 0.12, 0.1)), 0.07);
    t = smin(t, sdCap(q, vec3(0.04, 1.4 + lift, -0.01), vec3(0.185, 1.385 + lift, -0.01), 0.055), 0.05); // hombros
    t = smin(t, sdCap(q, vec3(0.055, 1.42, 0.075), vec3(0.03, 1.24, 0.1), 0.011), 0.02);       // solapas
    t = smax(t, -sdEll(p - vec3(0.0, 1.33, 0.1), vec3(0.03, 0.09, 0.02)), 0.01);                // escote en V
    t = smin(t, length(p - vec3(0.0, 1.19, 0.094)) - 0.008, 0.004);                             // botones
    t = smin(t, length(p - vec3(0.0, 1.09, 0.086)) - 0.008, 0.004);
    d = smin(d, t, 0.035);
    // Brazo izquierdo en reposo (espejado) y derecho con gesto de presentación.
    d = smin(d, arm(vec3(-p.x, p.y, p.z), vec3(0.2, 1.37 + lift, -0.01), vec3(0.225, 1.13, 0.0), vec3(0.07, 0.99, 0.1)), 0.02);
    vec3 el = mix(vec3(0.225, 1.13, 0.0), vec3(0.26, 1.15, 0.12), uGesture);
    vec3 wr = mix(vec3(0.07, 0.99, 0.1), vec3(0.3, 1.24, 0.33), uGesture);
    d = smin(d, arm(p, vec3(0.2, 1.37 + lift, -0.01), el, wr), 0.02);
    d = smin(d, sdEll(p - vec3(-0.03 * uGesture, 0.985, 0.115), vec3(0.075 - 0.03 * uGesture, 0.045, 0.045)), 0.03);
    float hand = sdEll(p - wr - vec3(0.0, 0.0, 0.04), vec3(0.045, 0.018 + 0.022 * (1.0 - uGesture), 0.055));
    for (int i = 0; i < 4; i++) {
      vec3 b = wr + vec3(-0.03 + float(i) * 0.02, 0.006, 0.085);
      hand = smin(hand, sdCap(p, b, b + vec3(0.0, 0.012, 0.045 * uGesture), 0.008), 0.008);
    }
    d = smin(d, hand, 0.015);
    vec3 pc = vec3(p.x, p.y - 0.18, p.z * 1.35);
    d = smin(d, sdRoundCone(pc, 0.2, 0.155, 0.72), 0.05);                                       // abrigo largo
    d = smin(d, sdCap(q, vec3(0.075, 0.25, 0.0), vec3(0.08, 0.02, 0.01), 0.047), 0.03);         // piernas
    return d;
  }
  float map(vec3 p) {
    float bound = sdCap(p, vec3(0.0, 0.1, 0.05), vec3(0.0, 1.7, 0.05), 0.5);
    if (bound > 0.06) return bound;
    return min(head(p), body(p));
  }
  vec3 calcNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0007;
    return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                     k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
  }
`;

const BOX_MIN = new THREE.Vector3(-0.4, -0.01, -0.24);
const BOX_MAX = new THREE.Vector3(0.4, 1.82, 0.46);

export function createHumanoidMaterial(color = 0x5fd0ff) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime,
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
      uGlitch: { value: 0 },
      uBoxMin: { value: BOX_MIN },
      uBoxMax: { value: BOX_MAX },
      uHeadYaw: { value: 0 }, uHeadPitch: { value: 0 }, uBreath: { value: 0 }, uGesture: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vCamLocal;
      void main() {
        vLocal = position;
        vCamLocal = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOpacity, uGlitch; uniform vec3 uColor, uBoxMin, uBoxMax;
      uniform float uHeadYaw, uHeadPitch, uBreath, uGesture;
      varying vec3 vLocal; varying vec3 vCamLocal;
      float h1(float n) { return fract(sin(n) * 43758.5453); }
      ${SDF_GLSL}
      void main() {
        vec3 ro = vCamLocal;
        vec3 rd = normalize(vLocal - vCamLocal);
        // Interferencia: bandas horizontales desplazadas lateralmente.
        float band = floor(vLocal.y * 22.0) + floor(uTime * 11.0) * 3.17;
        ro.x += step(0.975 - 0.12 * uGlitch, h1(band)) * (h1(band + 2.1) - 0.5) * 0.12 * (0.3 + uGlitch);
        // Intersección con la caja contenedora (funciona también desde dentro).
        vec3 inv = 1.0 / rd;
        vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
        vec3 tmn = min(t0, t1), tmx = max(t0, t1);
        float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
        float t = max(tn, 0.0);
        float glow = 0.0;
        bool hit = false;
        for (int i = 0; i < 88; i++) {
          vec3 p = ro + rd * t;
          float d = map(p);
          glow += exp(-max(d, 0.0) * 55.0) * 0.011;
          if (d < 0.0007) { hit = true; break; }
          t += d * 0.92;
          if (t > tf) break;
        }
        vec3 col = uColor * glow * 0.55;
        if (hit) {
          vec3 p = ro + rd * t;
          vec3 n = calcNormal(p);
          float fres = pow(max(1.0 - abs(dot(n, -rd)), 0.0), 2.2);
          float key = 0.3 + 0.7 * max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
          float scan = 0.62 + 0.38 * sin(p.y * 260.0 - uTime * 7.0);
          float contour = smoothstep(0.9, 1.0, fract(p.y * 48.0 + uTime * 0.15));
          float sw = fract(p.y * 0.55 - uTime * 0.4) - 0.5;
          float sweep = exp(-sw * sw * 260.0);
          col += uColor * ((0.22 * key + fres * 1.25) * scan + contour * 0.55 + sweep * 0.9);
        }
        // Se desvanece hacia el emisor del suelo y titila.
        float yb = clamp((ro + rd * t).y, 0.0, 2.0);
        col *= smoothstep(0.0, 0.3, yb);
        col *= 0.88 + 0.12 * sin(uTime * 43.0) * sin(uTime * 17.0);
        gl_FragColor = vec4(col * uOpacity, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
  });
}

// Partículas de interferencia que ascienden en espiral dentro del haz.
function createInterference(count, height) {
  const rnd = mulberry32(99);
  const seed = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) seed[i] = rnd();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uPixelScale: globalUniforms.uPixelScale, uOpacity: { value: 0 }, uH: { value: height } },
    vertexShader: /* glsl */ `
      uniform float uTime, uPixelScale, uOpacity, uH; attribute vec3 aSeed; varying float vA;
      float h1(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        float y = fract(aSeed.z * 3.7 + uTime * (0.05 + aSeed.z * 0.1)) * uH;
        float a = aSeed.y * 6.283 + uTime * (aSeed.z - 0.5) * 0.8;
        float r = sqrt(aSeed.x) * mix(0.62, 0.14, y / uH);
        vec3 p = vec3(cos(a) * r, y, sin(a) * r);
        p.x += step(0.96, h1(floor(uTime * 18.0) + aSeed.x * 91.0)) * 0.06;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp((0.006 + aSeed.x * 0.01) * uPixelScale / max(0.05, -mv.z), 1.0, 16.0);
        vA = uOpacity * sin(3.14159 * y / uH) * (0.35 + 0.65 * fract(aSeed.x * 13.0));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(0.45, 0.85, 1.0) * vA * (1.0 - smoothstep(0.0, 0.5, d)) * 1.6, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

// Ajuste de línea por anchura real medida en el canvas.
function wrap(ctx, text, maxW) {
  const words = text.split(' '), out = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
  }
  if (line) out.push(line);
  return out;
}

// =============================================================================
export class Hologram {
  constructor(ship, message, speaker) {
    const H = ship.holo;
    this.ship = ship;
    this.message = message;
    this.speaker = speaker;
    this.mats = [];

    const g = (this.group = new THREE.Group());
    g.position.set(H.x, 0, H.z);
    g.visible = false;
    const holoMat = (o, k = 1) => { const m = createHologramMaterial(o); m.userData.k = k; this.mats.push(m); return m; };

    // Figura raymarcheada (gira levemente hacia la entrada de la sala).
    this.figureMat = createHumanoidMaterial();
    const boxGeo = new THREE.BoxGeometry(BOX_MAX.x - BOX_MIN.x, BOX_MAX.y - BOX_MIN.y, BOX_MAX.z - BOX_MIN.z);
    boxGeo.translate((BOX_MAX.x + BOX_MIN.x) / 2, (BOX_MAX.y + BOX_MIN.y) / 2, (BOX_MAX.z + BOX_MIN.z) / 2);
    this.figure = new THREE.Mesh(boxGeo, this.figureMat);
    this.figure.rotation.y = 0.16;
    this.figure.renderOrder = 5;
    g.add(this.figure);

    // Haz cónico desde el techo y anillos de barrido.
    const beamH = H.ceilY - 0.2;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.62, beamH, 48, 1, true), holoMat({ color: 0x4fc3ff }, 0.22));
    beam.position.y = beamH / 2;
    g.add(beam);
    this.rings = [0, 0.5].map((ph) => {
      const r = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.53, 64), holoMat({ color: 0x9fe8ff }, 0.6));
      r.rotation.x = -Math.PI / 2;
      r.userData.phase = ph;
      g.add(r);
      return r;
    });
    this.particles = createInterference(380, beamH);
    g.add(this.particles);

    // Objetos auxiliares reconocibles: cápsula de muestra con ADN (flota sobre
    // la mano que gesticula), maletín de contención y pizarra de datos.
    const dnaMat = holoMat({ color: 0x7affc8 }, 0.75);
    const shellMat = holoMat({ color: 0x9fe8ff }, 0.5);
    const caseMat = holoMat({ color: 0x4fc3ff }, 0.85);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler();

    this.canister = new THREE.Group();
    this.canister.position.set(0.44, 1.5, 0.36);
    this.canister.add(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.3, 24, 1, true), shellMat));
    for (const y of [0.17, -0.17]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.085, 0.04, 24), caseMat);
      cap.position.y = y;
      this.canister.add(cap);
    }
    for (const y of [0.09, -0.09]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.006, 6, 24), caseMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.canister.add(ring);
    }
    const N = 16, R = 0.045, HH = 0.26;
    const spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(0.011, 8, 6), dnaMat, N * 2);
    const rungs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.004, 0.004, 1, 5), dnaMat, N);
    for (let i = 0; i < N; i++) {
      const y = (i / (N - 1)) * HH - HH / 2, a = i * 0.7;
      s.set(1, 1, 1);
      p.set(Math.cos(a) * R, y, Math.sin(a) * R);
      spheres.setMatrixAt(i * 2, m.compose(p, q.identity(), s));
      p.set(-Math.cos(a) * R, y, -Math.sin(a) * R);
      spheres.setMatrixAt(i * 2 + 1, m.compose(p, q, s));
      p.set(0, y, 0); s.set(1, 2 * R, 1);
      q.setFromEuler(e.set(0, -a, Math.PI / 2));
      rungs.setMatrixAt(i, m.compose(p, q, s));
    }
    this.dna = new THREE.Group();
    this.dna.add(spheres, rungs);
    this.canister.add(this.dna);
    g.add(this.canister);

    this.caseHolo = new THREE.Group();
    this.caseHolo.position.set(-0.74, 0.95, 0.15);
    this.caseHolo.add(new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.13, 0.32), caseMat));
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.006, 0.33), dnaMat);
    seam.position.y = 0.03;
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.01, 8, 16, Math.PI), caseMat);
    handle.position.set(0, 0.065, -0.11);
    const emblem = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.045, 6), dnaMat);
    emblem.rotation.x = -Math.PI / 2;
    emblem.position.y = 0.067;
    this.caseHolo.add(seam, handle, emblem);
    for (const x of [-0.16, 0.16]) {
      const latch = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.02), dnaMat);
      latch.position.set(x, 0.02, 0.165);
      this.caseHolo.add(latch);
    }
    g.add(this.caseHolo);

    // Pizarra de datos: gráfica de secuenciación dibujada una sola vez.
    const sc = newCanvas(256, 160), sx = sc.getContext('2d');
    sx.fillStyle = 'rgba(3,14,24,0.7)'; sx.fillRect(0, 0, 256, 160);
    sx.strokeStyle = '#9fe8ff'; sx.lineWidth = 3; sx.strokeRect(4, 4, 248, 152);
    sx.fillStyle = '#cdf2ff'; sx.font = 'bold 16px Consolas, monospace'; sx.fillText('SECUENCIA ÁRES-7', 14, 26);
    const rr = mulberry32(5);
    for (let k = 0; k < 18; k++) { const h = 20 + rr() * 60; sx.fillStyle = k % 5 === 3 ? '#ff7a4a' : '#7affc8'; sx.fillRect(14 + k * 12.5, 140 - h, 8, h); }
    sx.strokeStyle = '#4fc3ff'; sx.beginPath();
    for (let x = 0; x < 228; x += 4) sx.lineTo(14 + x, 60 + Math.sin(x * 0.09) * 14 + Math.sin(x * 0.31) * 5);
    sx.stroke();
    const slateTex = new THREE.CanvasTexture(sc);
    slateTex.colorSpace = THREE.SRGBColorSpace;
    this.slate = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.225), holoMat({ color: 0x4fc3ff, map: slateTex }, 0.9));
    this.slate.position.set(-0.74, 1.5, 0.22);
    this.slate.rotation.set(-0.15, 0.45, 0);
    g.add(this.slate);
    ship.group.add(g);

    // Ventana de datos: panel translúcido a la derecha, orientado al jugador.
    const cv = (this.canvas = newCanvas(1024, 640));
    this.ctx = cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    const win = (this.window = new THREE.Group());
    win.position.set(H.x + 1.4, 1.74, H.z + 0.65);
    win.rotation.y = -0.33;
    win.visible = false;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.76, 1.1), holoMat({ color: 0x4fc3ff, map: this.tex }, 1));
    win.add(panel);
    const frameMat = holoMat({ color: 0x9fe8ff }, 0.9);
    const fw = 0.9, fh = 0.57, c = 0.12;
    const segs = [
      [-fw, fh, -fw + c, fh], [-fw, fh, -fw, fh - c], [fw, fh, fw - c, fh], [fw, fh, fw, fh - c],
      [-fw, -fh, -fw + c, -fh], [-fw, -fh, -fw, -fh + c], [fw, -fh, fw - c, -fh], [fw, -fh, fw, -fh + c],
    ];
    for (const [x0, y0, x1, y1] of segs) {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(x0 === x1 ? 0.012 : len, x0 === x1 ? len : 0.012), frameMat);
      bar.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.002);
      win.add(bar);
    }
    // Fino haz de proyección del emisor hacia la ventana.
    const link = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.03, 1.0, 6, 1, true), holoMat({ color: 0x4fc3ff }, 0.5));
    link.position.set(-0.95, -0.4, -0.15);
    link.rotation.z = Math.PI / 2.6;
    win.add(link);
    ship.group.add(win);

    this.opacity = 0;
    this._wrapped = null;
    this.drawText(-1, 0);
  }

  setVisible(v) { this.group.visible = v; this.window.visible = v; }

  setOpacity(o, glitch) {
    this.opacity = o;
    for (const m of this.mats) {
      m.uniforms.uOpacity.value = o * m.userData.k;
      m.uniforms.uGlitch.value = glitch;
    }
    this.figureMat.uniforms.uOpacity.value = o;
    this.figureMat.uniforms.uGlitch.value = glitch;
    this.particles.material.uniforms.uOpacity.value = o;
  }

  // Vida procedural: respiración, mirada que deriva, balanceo y un gesto
  // periódico en el que la figura alza la mano bajo la cápsula de muestra.
  update(dt, t) {
    const u = this.figureMat.uniforms;
    const ph = t % 8.0;
    const g = smoothstep(0.5, 1.4, ph) * (1 - smoothstep(4.2, 5.1, ph));
    u.uBreath.value = Math.sin(t * 1.6);
    u.uHeadYaw.value = Math.sin(t * 0.37) * 0.16 + Math.sin(t * 0.11) * 0.1 - g * 0.12;
    u.uHeadPitch.value = Math.sin(t * 0.53) * 0.05 - 0.03 + g * 0.05;
    u.uGesture.value = g;
    this.figure.rotation.y = 0.16 + Math.sin(t * 0.4) * 0.06;
    this.figure.position.y = Math.sin(t * 0.9) * 0.012;
    this.canister.position.y = 1.5 + Math.sin(t * 1.3) * 0.015 + g * 0.05;
    this.canister.rotation.y += dt * 0.9;
    this.caseHolo.rotation.y += dt * 0.5;
    this.slate.position.y = 1.5 + Math.sin(t * 1.1 + 1.0) * 0.015;
    for (const r of this.rings) r.position.y = ((t * 0.35 + r.userData.phase) % 1) * (this.ship.holo.ceilY - 0.4) + 0.05;
  }

  // Redibuja la ventana de datos (sólo cuando avanza el texto).
  drawText(lineIdx, chars) {
    const c = this.ctx, W = 1024, H = 640;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(3,14,24,0.84)';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(79,195,255,0.08)';
    c.lineWidth = 1;
    for (let x = 0; x < W; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y < H; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    c.strokeStyle = 'rgba(120,210,255,0.85)';
    c.lineWidth = 3;
    c.strokeRect(8, 8, W - 16, H - 16);
    c.fillStyle = 'rgba(79,195,255,0.2)';
    c.fillRect(8, 8, W - 16, 64);
    c.fillStyle = '#cdf2ff';
    c.font = 'bold 30px Consolas, "Courier New", monospace';
    c.textBaseline = 'middle';
    c.fillText('HELIX-ARES CORP // TRANSMISIÓN PRIORITARIA Δ-7', 30, 42);
    c.fillStyle = '#ff6a4a';
    c.font = 'bold 22px Consolas, monospace';
    c.fillText('● EN VIVO', W - 160, 42);
    c.fillStyle = 'rgba(160,220,255,0.7)';
    c.font = '22px Consolas, "Courier New", monospace';
    c.fillText('EMISOR: ' + this.speaker, 30, 100);
    c.fillRect(30, 122, W - 60, 2);

    c.font = '31px Consolas, "Courier New", monospace';
    if (!this._wrapped) this._wrapped = this.message.map((l) => wrap(c, l, W - 90));
    const rows = [];
    for (let i = 0; i <= lineIdx && i < this.message.length; i++) {
      const done = i < lineIdx;
      let budget = done ? Infinity : chars;
      for (const seg of this._wrapped[i]) {
        if (budget <= 0) break;
        const txt = seg.slice(0, budget);
        budget -= seg.length + 1;
        rows.push({ txt, done, last: !done && budget <= 0 });
      }
    }
    const maxRows = 10, first = Math.max(0, rows.length - maxRows);
    for (let r = first; r < rows.length; r++) {
      const row = rows[r], y = 160 + (r - first) * 42;
      c.globalAlpha = row.done ? 0.55 : 1;
      c.fillStyle = '#a8e6ff';
      c.fillText(row.txt, 44, y);
      if (row.last || (r === rows.length - 1 && !row.done)) {
        const w = c.measureText(row.txt).width;
        c.fillRect(48 + w, y - 15, 16, 30);
      }
    }
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(160,220,255,0.6)';
    c.font = '20px Consolas, monospace';
    c.fillText('SEÑAL ▮▮▮▮▯ 87%    CIFRADO AES-Q/512    CANAL 07', 30, H - 40);
    const prog = Math.max(0, (lineIdx + (chars > 0 ? 0.5 : 0)) / this.message.length);
    c.fillStyle = 'rgba(79,195,255,0.25)';
    c.fillRect(W - 300, H - 50, 260, 16);
    c.fillStyle = 'rgba(160,230,255,0.9)';
    c.fillRect(W - 300, H - 50, 260 * Math.min(1, prog), 16);
    this.tex.needsUpdate = true;
  }
}
