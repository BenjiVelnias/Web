// =============================================================================
// procedural-assets.js
// Todo el "arte" del juego nace aquí: texturas, shaders y geometría.
// Cero archivos externos: ruido de valor tileable, celdas de Voronoi (Worley),
// fBm, mapas de normales por Sobel y shaders GLSL para Marte, hologramas,
// haces de luz volumétricos y partículas.
// =============================================================================
import * as THREE from 'three';

// Uniforms globales compartidos por referencia: el motor sólo actualiza estos
// objetos y todos los shaders se animan sin tocar cada material.
export const globalUniforms = {
  uTime: { value: 0 },
  uPixelScale: { value: 600 }, // (altoPx / 2) / tan(fov / 2)  → tamaño de puntos en mundo
  // Linterna del jugador (posición, dirección, intensidad 0..1): el polvo en
  // suspensión destella al cruzar el haz.
  uFlashPos: { value: new THREE.Vector3() },
  uFlashDir: { value: new THREE.Vector3(0, 0, -1) },
  uFlash: { value: 0 },
  uAlert: { value: 0 }, // 0..1 alerta de contención (reflejos rojos en visores)
};

// -----------------------------------------------------------------------------
// Utilidades matemáticas
// -----------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// Ruido de valor 2D periódico (tileable). Los periodos son potencias de 2
// para que el fBm sea continuo en los bordes de la textura.
function makeTileNoise(seed) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  const r = mulberry32(seed);
  for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = r(); }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  const lattice = (ix, iy, px, py) => {
    ix = ((ix % px) + px) % px;
    iy = ((iy % py) + py) % py;
    return vals[perm[(perm[ix & 255] + iy) & 255]];
  };

  function noise(x, y, px, py) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lattice(x0, y0, px, py), b = lattice(x0 + 1, y0, px, py);
    const c = lattice(x0, y0 + 1, px, py), d = lattice(x0 + 1, y0 + 1, px, py);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  // fBm: Σ 0.5^o · noise(2^o · f · p)
  function fbm(u, v, fx, fy, octaves) {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(u * fx, v * fy, fx, fy);
      norm += amp; amp *= 0.5; fx *= 2; fy *= 2;
    }
    return sum / norm;
  }

  // Worley F1 tileable: distancia al punto característico más cercano.
  function worley(u, v, n) {
    const x = u * n, y = v * n;
    const cx = Math.floor(x), cy = Math.floor(y);
    let best = 9;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gy = cy + dy;
        const wx = ((gx % n) + n) % n, wy = ((gy % n) + n) % n;
        const h = perm[(perm[wx & 255] + wy * 7) & 255];
        const px = gx + vals[h], py = gy + vals[(h + 71) & 255];
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }

  return { noise, fbm, worley };
}

// -----------------------------------------------------------------------------
// Empaquetado de mapas: color (sRGB), normal (Sobel sobre altura) y ORM
// (R = oclusión, G = rugosidad, B = metalicidad; el formato que lee three.js).
// -----------------------------------------------------------------------------
function canvasTexture(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function newCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function buildMaps(S, H, C, R, M, A, normalStrength) {
  const cCol = newCanvas(S), cNor = newCanvas(S), cOrm = newCanvas(S);
  const xCol = cCol.getContext('2d'), xNor = cNor.getContext('2d'), xOrm = cOrm.getContext('2d');
  const dCol = xCol.createImageData(S, S), dNor = xNor.createImageData(S, S), dOrm = xOrm.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    const yr = y * S, yu = ((y - 1 + S) % S) * S, yd = ((y + 1) % S) * S;
    for (let x = 0; x < S; x++) {
      const i = yr + x, p = i * 4;
      const xl = (x - 1 + S) % S, xr = (x + 1) % S;
      dCol.data[p] = clamp01(C[i * 3]) * 255;
      dCol.data[p + 1] = clamp01(C[i * 3 + 1]) * 255;
      dCol.data[p + 2] = clamp01(C[i * 3 + 2]) * 255;
      dCol.data[p + 3] = 255;
      // Canvas crece hacia abajo, la V de la UV hacia arriba → signo de Y invertido.
      const nx = -(H[yr + xr] - H[yr + xl]) * normalStrength;
      const ny = (H[yd + x] - H[yu + x]) * normalStrength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      dNor.data[p] = (nx * inv * 0.5 + 0.5) * 255;
      dNor.data[p + 1] = (ny * inv * 0.5 + 0.5) * 255;
      dNor.data[p + 2] = (inv * 0.5 + 0.5) * 255;
      dNor.data[p + 3] = 255;
      dOrm.data[p] = clamp01(A[i]) * 255;
      dOrm.data[p + 1] = clamp01(R[i]) * 255;
      dOrm.data[p + 2] = clamp01(M[i]) * 255;
      dOrm.data[p + 3] = 255;
    }
  }
  xCol.putImageData(dCol, 0, 0);
  xNor.putImageData(dNor, 0, 0);
  xOrm.putImageData(dOrm, 0, 0);
  return { map: canvasTexture(cCol, true), normalMap: canvasTexture(cNor, false), ormMap: canvasTexture(cOrm, false) };
}

// -----------------------------------------------------------------------------
// Paneles metálicos: rejilla de placas biseladas, remaches, rejillas de
// ventilación, abolladuras (fBm), óxido (fBm deformado + Voronoi) y chorreones.
// -----------------------------------------------------------------------------
export function generatePanelSet(opts = {}) {
  const {
    seed = 1, size = 512, base = [0.3, 0.31, 0.3], rust = 0.6, grime = 0.7,
    cellX = 128, cellY = 256, vents = true, normalStrength = 4,
  } = opts;
  const S = size;
  const nz = makeTileNoise(seed);
  const rnd = mulberry32(seed * 7 + 3);
  const H = new Float32Array(S * S), C = new Float32Array(S * S * 3);
  const R = new Float32Array(S * S), M = new Float32Array(S * S), A = new Float32Array(S * S);

  const pcx = Math.ceil(S / cellX), pcy = Math.ceil(S / cellY);
  const tint = new Float32Array(pcx * pcy), vent = new Uint8Array(pcx * pcy);
  for (let i = 0; i < pcx * pcy; i++) { tint[i] = (rnd() - 0.5) * 0.12; vent[i] = vents && rnd() < 0.3 ? 1 : 0; }

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S, i = y * S + x;
      const px = Math.floor(x / cellX), py = Math.floor(y / cellY), pid = py * pcx + px;
      const lx = x - px * cellX, ly = y - py * cellY;
      const dEdge = Math.min(lx, cellX - 1 - lx, ly, cellY - 1 - ly);
      const bevel = dEdge < 2 ? 0 : smoothstep(2, 8, dEdge);
      let h = 0.2 + 0.45 * bevel;
      let cavity = 1;

      if (vent[pid] && lx > 18 && lx < cellX - 18 && ly > cellY * 0.38 && ly < cellY * 0.62) {
        const s = (ly % 9) / 9;
        const slot = smoothstep(0.25, 0.45, s) * (1 - smoothstep(0.75, 0.95, s));
        h -= 0.3 * slot;
        cavity = 1 - slot * 0.85;
      }

      // Remaches a lo largo de los bordes (cada 32 px, a 7 px del canto).
      const ryAlong = Math.round((ly - 16) / 32) * 32 + 16;
      const rxAlong = Math.round((lx - 16) / 32) * 32 + 16;
      const d1 = Math.hypot(Math.min(Math.abs(lx - 7), Math.abs(lx - (cellX - 8))), ly - ryAlong);
      const d2 = Math.hypot(lx - rxAlong, Math.min(Math.abs(ly - 7), Math.abs(ly - (cellY - 8))));
      const riv = 1 - smoothstep(1.5, 3.2, Math.min(d1, d2));
      h += riv * 0.3;

      const n1 = nz.fbm(u, v, 8, 8, 5);
      const nFine = nz.noise(u * 128, v * 128, 128, 128);
      h += (n1 - 0.5) * 0.07 + (nFine - 0.5) * 0.015;
      // Ondulación de chapa de baja frecuencia: rompe los reflejos especulares
      // dentro de cada placa (evita los "parches cuadrados" de brillo plano).
      const dent = nz.fbm(u + 0.21, v + 0.63, 4, 4, 3);
      h += (dent - 0.5) * 0.8;
      // Pintura desconchada en cantos y desgaste: deja ver metal desnudo.
      const chip = clamp01(smoothstep(0.58, 0.7, nz.fbm(u + 0.9, v + 0.4, 16, 16, 4)) + (1 - smoothstep(2, 6, dEdge)) * 0.6);

      const warp = nz.fbm(u + 0.37, v + 0.11, 4, 4, 4);
      const w = nz.worley(u + warp * 0.12, v + warp * 0.12, 8);
      const rustM = smoothstep(0.52, 0.72, nz.fbm(u + warp * 0.3, v, 4, 4, 5) * 0.8 + (1 - w) * 0.3) * rust;
      const streak = smoothstep(0.55, 0.85, nz.fbm(u, v, 64, 2, 3)) * (0.35 + rustM);
      const grimeM = clamp01(((1 - bevel) * 0.7 + smoothstep(0.42, 0.8, nz.fbm(u, v, 4, 4, 5)) * 0.6) * grime);
      h += rustM * (nFine - 0.4) * 0.06;

      const k = (1 + tint[pid]) * (0.86 + 0.28 * n1);
      let r = base[0] * k, g = base[1] * k, b = base[2] * k;
      const rc = nz.fbm(u * 3, v * 3, 16, 16, 3);
      r = mix(r, mix(0.2, 0.52, rc), rustM);
      g = mix(g, mix(0.07, 0.23, rc), rustM);
      b = mix(b, mix(0.03, 0.08, rc), rustM);
      const gm = 1 - grimeM * 0.55, st = streak * 0.45 * (0.3 + rust);
      r = mix(r * gm, 0.22, st); g = mix(g * gm, 0.1, st); b = mix(b * gm, 0.05, st);
      r *= cavity; g *= cavity; b *= cavity;
      r += riv * 0.05; g += riv * 0.05; b += riv * 0.05;
      const bare = chip * (1 - rustM);
      r = mix(r, 0.46, bare * 0.6); g = mix(g, 0.46, bare * 0.6); b = mix(b, 0.45, bare * 0.6);

      H[i] = h;
      C[i * 3] = r; C[i * 3 + 1] = g; C[i * 3 + 2] = b;
      // Pintura industrial: dieléctrico rugoso; el metal desnudo es más pulido.
      // Metal oxidado y pintura industrial: nunca por debajo de 0.55 (dispersión suave).
      R[i] = Math.max(0.55, 0.58 + n1 * 0.18 + grimeM * 0.22 + rustM * 0.35 + nFine * 0.08 - bare * 0.15 - riv * 0.05);
      M[i] = mix(0.35, 0.92, bare) * (1 - rustM * 0.8);
      A[i] = (0.35 + 0.65 * bevel) * cavity;
    }
  }
  return buildMaps(S, H, C, R, M, A, normalStrength);
}

// -----------------------------------------------------------------------------
// Suelo de chapa lagrimada: rombos alternos (rotación ±45°), juntas grandes,
// desgaste brillante en las crestas y suciedad en los valles.
// -----------------------------------------------------------------------------
export function generateFloorSet(seed = 11, S = 512) {
  const nz = makeTileNoise(seed);
  const H = new Float32Array(S * S), C = new Float32Array(S * S * 3);
  const R = new Float32Array(S * S), M = new Float32Array(S * S), A = new Float32Array(S * S);
  const cell = 32;
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S, i = y * S + x;
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const lx = x - cx * cell - cell / 2 + 0.5, ly = y - cy * cell - cell / 2 + 0.5;
      let a = (lx + ly) * 0.7071, b = (lx - ly) * 0.7071;
      if ((cx + cy) & 1) { const t = a; a = b; b = t; }
      const e = (a / 11) * (a / 11) + (b / 3.2) * (b / 3.2);
      const lug = 1 - smoothstep(0.7, 1.0, e);
      const sx = x % 256, sy = y % 256;
      const seam = smoothstep(1, 4, Math.min(sx, 255 - sx, sy, 255 - sy));
      const n = nz.fbm(u, v, 8, 8, 5);
      const wear = smoothstep(0.45, 0.8, nz.fbm(u, v, 4, 4, 4));
      const dirt = clamp01((1 - lug) * smoothstep(0.35, 0.7, nz.fbm(u + 0.5, v, 8, 8, 4)) + (1 - seam) * 0.8);
      const rustM = smoothstep(0.62, 0.8, nz.fbm(u, v + 0.3, 4, 4, 5)) * 0.8;

      H[i] = (0.3 + lug * 0.4) * (0.4 + 0.6 * seam) + (n - 0.5) * 0.05;
      const k = 0.85 + 0.3 * n + lug * wear * 0.35;
      let r = 0.25 * k, g = 0.25 * k, bl = 0.24 * k;
      r = mix(r, 0.1, dirt * 0.8); g = mix(g, 0.075, dirt * 0.8); bl = mix(bl, 0.06, dirt * 0.8);
      r = mix(r, 0.4, rustM); g = mix(g, 0.16, rustM); bl = mix(bl, 0.06, rustM);
      C[i * 3] = r; C[i * 3 + 1] = g; C[i * 3 + 2] = bl;
      R[i] = Math.max(0.52, 0.6 - lug * wear * 0.25 + dirt * 0.35 + rustM * 0.3);
      M[i] = 0.9 - dirt * 0.5 - rustM * 0.7;
      A[i] = (0.55 + 0.45 * lug) * (0.3 + 0.7 * seam);
    }
  }
  return buildMaps(S, H, C, R, M, A, 5);
}

// Franjas de peligro amarillo/negro desgastadas (marcos de escotillas).
export function generateHazardSet(seed = 5, S = 256) {
  const nz = makeTileNoise(seed);
  const H = new Float32Array(S * S), C = new Float32Array(S * S * 3);
  const R = new Float32Array(S * S), M = new Float32Array(S * S), A = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, i = y * S + x;
      const stripe = ((x + y) % 64) < 32 ? 1 : 0;
      const n = nz.fbm(u, v, 8, 8, 5);
      const chip = smoothstep(0.58, 0.66, nz.fbm(u, v, 16, 16, 4));
      const paint = stripe * (1 - chip);
      let r = mix(0.06, 0.78, paint), g = mix(0.06, 0.55, paint), b = mix(0.05, 0.04, paint);
      if (chip > 0.5) { r = 0.32; g = 0.31; b = 0.3; }
      const k = 0.8 + 0.35 * n;
      C[i * 3] = r * k; C[i * 3 + 1] = g * k; C[i * 3 + 2] = b * k;
      H[i] = 0.5 + paint * 0.04 + (n - 0.5) * 0.05;
      R[i] = chip > 0.5 ? 0.55 : 0.7 + n * 0.2;
      M[i] = chip > 0.5 ? 0.9 : 0.05;
      A[i] = 1;
    }
  }
  return buildMaps(S, H, C, R, M, A, 3);
}

// Paneles solares: células azul oscuro con retícula plateada, algunas rotas.
export function generateSolarTexture(seed = 9, S = 512) {
  const c = newCanvas(S), x = c.getContext('2d');
  const rnd = mulberry32(seed);
  x.fillStyle = '#9aa0a6'; x.fillRect(0, 0, S, S);
  const cell = 32;
  for (let cy = 0; cy < S / cell; cy++) {
    for (let cx = 0; cx < S / cell; cx++) {
      const broken = rnd() < 0.12;
      const g = x.createLinearGradient(cx * cell, cy * cell, cx * cell + cell, cy * cell + cell);
      g.addColorStop(0, broken ? '#07070a' : '#0c1a3a');
      g.addColorStop(1, broken ? '#111114' : '#18306a');
      x.fillStyle = g;
      x.fillRect(cx * cell + 1.5, cy * cell + 1.5, cell - 3, cell - 3);
      if (broken) {
        x.strokeStyle = 'rgba(200,200,220,0.35)'; x.lineWidth = 0.7; x.beginPath();
        const ox = cx * cell + cell / 2, oy = cy * cell + cell / 2;
        for (let k = 0; k < 5; k++) { x.moveTo(ox, oy); x.lineTo(ox + (rnd() - 0.5) * cell, oy + (rnd() - 0.5) * cell); }
        x.stroke();
      }
    }
  }
  return canvasTexture(c, true);
}

// Carteles emisivos (letreros de sección).
export function createSignTexture(title, sub, color = '#ff5a2a') {
  const c = newCanvas(512, 128), x = c.getContext('2d');
  x.fillStyle = '#050505'; x.fillRect(0, 0, 512, 128);
  x.strokeStyle = color; x.lineWidth = 4; x.strokeRect(6, 6, 500, 116);
  x.fillStyle = color; x.font = 'bold 52px Consolas, "Courier New", monospace';
  x.textBaseline = 'middle'; x.fillText(title, 24, 50);
  x.font = '22px Consolas, "Courier New", monospace'; x.globalAlpha = 0.75;
  x.fillText(sub, 26, 96);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// -----------------------------------------------------------------------------
// GLSL compartido: ruido de valor 3D + fBm
// -----------------------------------------------------------------------------
const GLSL_NOISE = /* glsl */ `
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
                   mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
                   mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return s;
  }
`;

// Ruido celular 3D (F1 + id de celda) para cráteres.
const GLSL_CELL = /* glsl */ `
  vec2 cell3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    float d1 = 8.0, id = 0.0;
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 o = vec3(hash31(i + g), hash31(i + g + 17.1), hash31(i + g + 31.7));
      vec3 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d1 = d; id = hash31(i + g + 5.3); }
    }
    return vec2(sqrt(d1), id);
  }
`;

// Marte en alta definición:
//  · altura = fBm con domain warping + cañón ecuatorial + cráteres (Worley 3D)
//  · relieve por diferencias finitas en el plano tangente (bump real)
//  · albedo con regiones oscuras, casquete polar, banda crepuscular
//  · neblina atmosférica en el limbo iluminado
// La iluminación se hace en espacio objeto: uSunObj = sol rotado al espacio local.
export function createMarsMaterial(sunDir) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uSunObj: { value: sunDir.clone().normalize() } },
    vertexShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vNormalW; varying vec3 vWorld;
      void main() {
        vObj = position;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSunObj;
      varying vec3 vObj; varying vec3 vNormalW; varying vec3 vWorld;
      ${GLSL_NOISE}
      ${GLSL_CELL}
      float crater(vec3 p, float scale) {
        vec2 c = cell3(p * scale);
        float r = 0.16 + 0.26 * c.y;
        float x = c.x / r;
        float bowl = x < 1.0 ? (x * x - 1.0) * 0.6 : 0.0;
        float rx = (x - 1.0) * 4.0;
        float rim = exp(-rx * rx) * 0.35;
        return (bowl + rim) * step(0.45, c.y);
      }
      float height(vec3 p) {
        vec2 q = vec2(fbm3(p * 2.0), fbm3(p * 2.0 + vec3(5.2, 1.3, 2.8)));
        float h = fbm3(p * 3.0 + vec3(q.x, q.y, q.x) * 1.2);
        float lat = p.y + 0.12 + (fbm3(p * 4.0) - 0.5) * 0.12;
        h -= (1.0 - smoothstep(0.0, 0.04, abs(lat))) * smoothstep(-0.3, 0.3, p.x) * 0.25;
        h += crater(p, 6.0) * 0.08 + crater(p, 15.0) * 0.035;
        return h;
      }
      void main() {
        vec3 p = normalize(vObj);
        float h = height(p);
        vec3 tA = normalize(cross(p, vec3(0.0, 1.0, 0.001)));
        vec3 tB = cross(p, tA);
        const float e = 0.0035;
        float hA = height(normalize(p + tA * e)), hB = height(normalize(p + tB * e));
        vec3 nObj = normalize(p - (tA * (hA - h) + tB * (hB - h)) / e * 0.05);

        float fine = fbm3(p * 26.0);
        vec3 col = mix(vec3(0.1, 0.035, 0.015), vec3(0.45, 0.15, 0.05), smoothstep(0.32, 0.55, h));
        col = mix(col, vec3(0.72, 0.38, 0.18), smoothstep(0.55, 0.75, h + fine * 0.12));
        col *= 1.0 - smoothstep(0.55, 0.7, fbm3(p * 1.6 + 3.0)) * 0.45;
        col *= 0.85 + 0.3 * fine;
        float pole = smoothstep(0.86, 0.93, abs(p.y) + (fine - 0.5) * 0.1);
        col = mix(col, vec3(0.86, 0.82, 0.8), pole);

        float geo = dot(p, uSunObj);
        float diff = max(dot(nObj, uSunObj), 0.0) * smoothstep(-0.1, 0.25, geo);
        float twilight = smoothstep(-0.15, 0.05, geo) * (1.0 - smoothstep(0.05, 0.3, geo));
        vec3 V = normalize(cameraPosition - vWorld);
        float rim = pow(max(1.0 - max(dot(normalize(vNormalW), V), 0.0), 0.0), 4.0);
        vec3 lit = col * diff * 1.6 + vec3(0.6, 0.2, 0.08) * twilight * 0.15;
        vec3 haze = vec3(0.95, 0.5, 0.28) * (rim * 0.8 + 0.04) * smoothstep(-0.25, 0.4, geo);
        gl_FragColor = vec4(lit + haze, 1.0);
      }`,
  });
}

export function createAtmosphereMaterial(sunDir, color = new THREE.Color(1.0, 0.45, 0.2)) {
  return new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: sunDir.clone().normalize() }, uColor: { value: color } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vNW;
      void main() {
        vN = normalize(normalMatrix * normal);
        vNW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir; uniform vec3 uColor;
      varying vec3 vN; varying vec3 vNW;
      void main() {
        float i = pow(max(0.0, 0.62 - dot(vN, vec3(0.0, 0.0, 1.0))), 4.0);
        float lit = smoothstep(-0.45, 0.6, dot(-vNW, uSunDir));
        vec3 c = mix(uColor, vec3(0.55, 0.65, 1.0), 0.15 * lit);
        gl_FragColor = vec4(c * i * lit * 1.4, 1.0);
      }`,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
}

// Capa de estrellas (puntos en esfera, tamaño en píxeles, titileo).
// Varias capas a distinto radio = paralaje multicapa.
export function createStarfield(count = 3000, radius = 1600, seed = 42, sizeScale = 1) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const size = new Float32Array(count), phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    const rr = radius * (0.85 + rnd() * 0.3);
    pos[i * 3] = Math.cos(a) * r * rr; pos[i * 3 + 1] = z * rr; pos[i * 3 + 2] = Math.sin(a) * r * rr;
    const t = rnd();
    // Temperatura estelar: azuladas, blancas y anaranjadas.
    col[i * 3] = t < 0.2 ? 0.7 : t > 0.85 ? 1.0 : 0.95;
    col[i * 3 + 1] = t < 0.2 ? 0.8 : t > 0.85 ? 0.75 : 0.93;
    col[i * 3 + 2] = t < 0.2 ? 1.0 : t > 0.85 ? 0.55 : 0.9;
    size[i] = (0.8 + Math.pow(rnd(), 6) * 3.5) * sizeScale;
    phase[i] = rnd() * 6.283;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime },
    vertexShader: /* glsl */ `
      uniform float uTime; attribute float aSize; attribute float aPhase; attribute vec3 color;
      varying vec3 vCol;
      void main() {
        vCol = color * (0.75 + 0.25 * sin(uTime * 2.3 + aPhase));
        gl_PointSize = min(aSize, 3.2); // estrellas grandes: sin bloques de bloom
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vCol * 0.85, (1.0 - smoothstep(0.05, 0.5, d)));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  return pts;
}

// Fondo galáctico: banda de la Vía Láctea con polvo oscuro (fBm sobre la esfera).
export function createNebula(radius = 1900) {
  const m = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vD;
      void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec3 vD;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vD);
        float bd = dot(d, normalize(vec3(0.3, 0.9, 0.25))) * 3.0;
        float band = exp(-bd * bd);
        float n = fbm3(d * 3.0);
        float n2 = fbm3(d * 7.0 + n * 2.0);
        vec3 col = vec3(0.05, 0.035, 0.08) * band * (0.4 + n2 * 1.2);
        col += vec3(0.13, 0.05, 0.04) * pow(max(n2, 0.0), 3.0) * band * 1.6;
        col *= 1.0 - smoothstep(0.55, 0.75, fbm3(d * 11.0)) * band * 0.75;
        gl_FragColor = vec4(col * 0.55, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), m);
  mesh.renderOrder = -20;
  mesh.frustumCulled = false;
  return mesh;
}

// Escombros orbitales cercanos: puntos con atenuación por distancia
// (paralaje fuerte al mover la cámara).
export function createDebrisField(count, center, radius, seed = 21) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3), sd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1, a = rnd() * 6.283, r = Math.sqrt(1 - z * z), rr = radius * Math.cbrt(rnd());
    pos[i * 3] = center.x + Math.cos(a) * r * rr;
    pos[i * 3 + 1] = center.y + z * rr * 0.5;
    pos[i * 3 + 2] = center.z + Math.sin(a) * r * rr;
    sd[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uPixelScale: globalUniforms.uPixelScale },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uPixelScale; attribute float aSeed; varying float vB;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp((0.04 + aSeed * 0.25) * uPixelScale / -mv.z, 0.6, 6.0);
        vB = (0.25 + 0.75 * abs(sin(uTime * (0.3 + aSeed) + aSeed * 40.0))) * (0.3 + aSeed * 0.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vB;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(0.75, 0.62, 0.55) * vB * 0.5, (1.0 - smoothstep(0.2, 0.5, d)));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

// Sistema de partículas en anillo (estelas de propulsores). CPU ligera:
// arrays preasignados, cero asignaciones por frame; sólo se suben 2 atributos.
export function createTrail(max = 600, hot = new THREE.Color(0.7, 0.85, 1.0), cool = new THREE.Color(1.0, 0.45, 0.15)) {
  const pos = new Float32Array(max * 3), vel = new Float32Array(max * 3);
  const age = new Float32Array(max).fill(1), life = new Float32Array(max).fill(1), size = new Float32Array(max);
  const g = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aAge = new THREE.BufferAttribute(age, 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', aPos);
  g.setAttribute('aAge', aAge);
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const m = new THREE.ShaderMaterial({
    uniforms: { uPixelScale: globalUniforms.uPixelScale, uHot: { value: hot }, uCool: { value: cool } },
    vertexShader: /* glsl */ `
      uniform float uPixelScale; attribute float aAge; attribute float aSize; varying float vAge;
      void main() {
        vAge = aAge;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float alive = step(aAge, 0.999);
        gl_PointSize = alive * min(64.0, aSize * (0.4 + aAge * 1.6) * uPixelScale / max(0.5, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHot; uniform vec3 uCool; varying float vAge;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        vec3 c = mix(uHot * 2.5, uCool, smoothstep(0.0, 0.25, vAge));
        c = mix(c, vec3(0.25), smoothstep(0.35, 0.9, vAge));
        gl_FragColor = vec4(c * pow(max(1.0 - vAge, 0.0), 2.0) * (1.0 - smoothstep(0.0, 0.5, d)) * 0.6, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  let head = 0;
  return {
    points,
    emit(x, y, z, vx, vy, vz, lifeSec, s) {
      const i = head; head = (head + 1) % max;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
      age[i] = 0; life[i] = lifeSec; size[i] = s;
    },
    update(dt) {
      const drag = 1 - 0.5 * dt;
      for (let i = 0; i < max; i++) {
        if (age[i] >= 1) continue;
        age[i] = Math.min(1, age[i] + dt / life[i]);
        const k = i * 3;
        pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
        vel[k] *= drag; vel[k + 1] *= drag; vel[k + 2] *= drag;
      }
      aPos.needsUpdate = true;
      aAge.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
    },
  };
}

// Holograma: fresnel + líneas de escaneo + banda de barrido + glitch por bandas.
export function createHologramMaterial({ color = 0x4fc3ff, map = null, opacity = 0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime,
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uGlitch: { value: 0 },
      uMap: { value: map },
      uUseMap: { value: map ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uGlitch;
      varying vec3 vN; varying vec3 vV; varying vec3 vW; varying vec2 vUv;
      float h1(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        float band = floor(w.y * 18.0) + floor(uTime * 12.0) * 3.17;
        float g = step(0.985 - 0.12 * uGlitch, h1(band)) * (h1(band + 1.3) - 0.5);
        w.x += g * 0.14 * (0.25 + uGlitch);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uOpacity; uniform float uUseMap;
      uniform vec3 uColor; uniform sampler2D uMap;
      varying vec3 vN; varying vec3 vV; varying vec3 vW; varying vec2 vUv;
      void main() {
        float fres = pow(max(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0), 2.0);
        float scan = 0.55 + 0.45 * sin(vW.y * 140.0 - uTime * 5.0);
        float bp = fract(vW.y * 0.45 - uTime * 0.35) - 0.5;
        float band = exp(-bp * bp * 300.0);
        float flick = 0.86 + 0.14 * sin(uTime * 41.0) * sin(uTime * 17.3);
        float a = (0.05 + fres * 0.6) * scan + band * 0.25;
        vec3 col = uColor * (0.35 + fres * 1.1 + band * 1.2);
        if (uUseMap > 0.5) {
          // Panel de texto: fondo oscuro semiopaco (mezcla normal) para que se lea.
          vec4 t = texture2D(uMap, vUv);
          a = t.a * (0.85 + 0.15 * scan);
          col = t.rgb * (1.0 + band * 0.4);
        }
        gl_FragColor = vec4(col, a * flick * uOpacity);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: map ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
}

// Haz de luz volumétrico barato: pila de láminas translúcidas. Alfa por
// distancia a la fuente (aT), bordes suaves (aEdge), atenuación de láminas
// vistas de canto y polvo en suspensión.
// clipMin/clipMax: volumen interior donde el haz puede existir; fuera se
// descarta (el haz nunca atraviesa el muro opuesto ni el suelo).
export function createLightShaftMaterial(color = 0xff6a3a, intensity = 0.25, clipMin = new THREE.Vector3(-1e4, -1e4, -1e4), clipMax = new THREE.Vector3(1e4, 1e4, 1e4)) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uColor: { value: new THREE.Color(color) }, uIntensity: { value: intensity }, uClipMin: { value: clipMin }, uClipMax: { value: clipMax } },
    vertexShader: /* glsl */ `
      attribute float aT; attribute vec2 aEdge;
      varying float vT; varying vec2 vEdge; varying vec3 vW; varying vec3 vN; varying vec3 vV;
      void main() {
        vT = aT;
        vEdge = aEdge;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uIntensity; uniform vec3 uClipMin, uClipMax;
      varying float vT; varying vec2 vEdge; varying vec3 vW; varying vec3 vN; varying vec3 vV;
      ${GLSL_NOISE}
      void main() {
        if (any(lessThan(vW, uClipMin)) || any(greaterThan(vW, uClipMax))) discard;
        float facing = smoothstep(0.05, 0.6, abs(dot(normalize(vN), normalize(vV))));
        float edge = (1.0 - smoothstep(0.55, 1.0, abs(vEdge.x))) * (1.0 - smoothstep(0.4, 1.0, abs(vEdge.y)));
        float dust = 0.5 + 0.5 * vnoise(vW * 2.5 + vec3(0.0, uTime * 0.25, uTime * 0.1));
        float a = pow(max(1.0 - vT, 0.0), 1.6) * smoothstep(0.0, 0.08, vT) * uIntensity * dust * facing * edge;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// Geometría de haz: rectángulo de origen (centro, ejes U/V) extruido según dir
// y cortado en láminas perpendiculares a U. Cada lámina es un quad V×dir.
export function createLightShaftGeometry(center, axisU, axisV, dir, length, spread = 1.25, slices = 12) {
  const pos = [], aT = [], aEdge = [], idx = [];
  const tmp = new THREE.Vector3();
  for (let k = 0; k < slices; k++) {
    const u = (k + 0.5) / slices - 0.5;
    const base = pos.length / 3;
    for (const [v, t] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]) {
      const s = mix(1, spread, t);
      tmp.copy(center)
        .addScaledVector(axisU, u * s)
        .addScaledVector(axisV, v * s)
        .addScaledVector(dir, t * length);
      pos.push(tmp.x, tmp.y, tmp.z);
      aT.push(t);
      aEdge.push(u * 2, v * 2);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(aEdge, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Polvo en suspensión: deriva senoidal en GPU y envoltura modular en una caja.
export function createDust(count, min, max, seed = 3, color = 0xffb08a) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3), sd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = mix(min.x, max.x, rnd());
    pos[i * 3 + 1] = mix(min.y, max.y, rnd());
    pos[i * 3 + 2] = mix(min.z, max.z, rnd());
    sd[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime, uPixelScale: globalUniforms.uPixelScale,
      uFlashPos: globalUniforms.uFlashPos, uFlashDir: globalUniforms.uFlashDir, uFlash: globalUniforms.uFlash,
      uMin: { value: min.clone() }, uBox: { value: max.clone().sub(min) },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uPixelScale; uniform vec3 uMin; uniform vec3 uBox;
      uniform vec3 uFlashPos, uFlashDir; uniform float uFlash;
      attribute float aSeed; varying float vA;
      void main() {
        vec3 p = position + vec3(sin(uTime * 0.13 + aSeed * 6.28) * 0.35,
                                 uTime * 0.03 * (aSeed - 0.4),
                                 cos(uTime * 0.11 + aSeed * 12.0) * 0.35);
        p = uMin + mod(p - uMin, uBox);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp((0.008 + aSeed * 0.014) * uPixelScale / max(0.05, -mv.z), 1.0, 20.0);
        vA = (0.2 + 0.6 * fract(aSeed * 7.31)) * smoothstep(0.2, 1.2, -mv.z) * (1.0 - smoothstep(3.0, 12.0, -mv.z));
        // Dentro del cono de la linterna la mota dispersa la luz (destello cálido).
        vec3 L = (modelMatrix * vec4(p, 1.0)).xyz - uFlashPos;
        float dl = length(L);
        float inBeam = smoothstep(0.86, 0.95, dot(L / max(dl, 1e-3), uFlashDir)) / (1.0 + dl * dl * 0.08);
        vA *= 1.0 + uFlash * inBeam * 5.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(uColor * vA * (1.0 - smoothstep(0.0, 0.5, d)) * 0.6, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

// Ráfaga de vapor presurizado (escotilla). Toda la simulación vive en el
// vertex shader: trigger() sólo escribe el tiempo de inicio.
export function createSteamBurst(origin, count = 280, seed = 8) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3), vel = new Float32Array(count * 3), life = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Nacen sobre la junta vertical central de la escotilla.
    pos[i * 3] = origin.x + (rnd() - 0.5) * 0.15;
    pos[i * 3 + 1] = origin.y + (rnd() - 0.5) * 2.6;
    pos[i * 3 + 2] = origin.z + 0.1;
    vel[i * 3] = (rnd() - 0.5) * 2.2;
    vel[i * 3 + 1] = (rnd() - 0.3) * 0.6;
    vel[i * 3 + 2] = 0.6 + rnd() * 1.8;
    life[i] = 1.2 + rnd() * 2.2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
  g.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  const uStart = { value: -100 };
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uPixelScale: globalUniforms.uPixelScale, uStart },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uStart; uniform float uPixelScale;
      attribute vec3 aVel; attribute float aLife; varying float vA;
      void main() {
        float age = uTime - uStart;
        float t = age / aLife;
        vec3 p = position + aVel * age * (1.0 - 0.3 * min(age, 2.5)) + vec3(0.0, 0.12 * age * age, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float alive = step(0.0, t) * step(t, 1.0);
        gl_PointSize = alive * min(96.0, (0.1 + 0.7 * t) * uPixelScale / max(0.3, -mv.z));
        vA = alive * pow(max(1.0 - t, 0.0), 2.0) * 0.16;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(0.75, 0.78, 0.82) * vA * (1.0 - smoothstep(0.0, 0.5, d)), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  return { points, trigger: () => { uStart.value = globalUniforms.uTime.value; } };
}

// =============================================================================
// CONSTANTES DE ESCENA Y UTILIDADES DE GEOMETRÍA (las usa level.js)
// =============================================================================
export const MARS_POSITION = new THREE.Vector3(-430, 90, -270);
export const MARS_RADIUS = 165;
export const SUN_DIRECTION = new THREE.Vector3(0.75, 0.35, 0.55).normalize(); // hacia el Sol
// La luz rojiza viaja desde Marte hacia la nave: sombras coherentes con su posición.
export const MARS_LIGHT_DIR = new THREE.Vector3(0, 1, -40).sub(MARS_POSITION).normalize();

// Caja con UVs en escala de mundo: 1 repetición cada `texScale` metros por cara.
// Orden de caras de BoxGeometry: +x, -x, +y, -y, +z, -z (4 vértices por cara).
// Las UV se proyectan desde la posición en MUNDO (ox, oy, oz = centro de la
// caja): segmentos contiguos de un muro comparten coordenadas y la textura
// continúa sin cortes ni estiramientos, sea cual sea el tamaño de la pieza.
export function worldBox(w, h, d, texScale = 2, ox = 0, oy = 0, oz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv, p = g.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const x = p.getX(i) + ox, y = p.getY(i) + oy, z = p.getZ(i) + oz;
    let u, v;
    switch (i >> 2) {
      case 0: u = -z; v = y; break;   // +X
      case 1: u = z; v = y; break;    // -X
      case 2: u = x; v = -z; break;   // +Y
      case 3: u = x; v = z; break;    // -Y
      case 4: u = x; v = y; break;    // +Z
      default: u = -x; v = y;         // -Z
    }
    uv.setXY(i, u / texScale, v / texScale);
  }
  return g;
}

export function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

export function pbr(set, extra = {}) {
  return new THREE.MeshStandardMaterial({
    map: set.map, normalMap: set.normalMap,
    roughnessMap: set.ormMap, metalnessMap: set.ormMap, aoMap: set.ormMap,
    roughness: 1, metalness: 1, envMapIntensity: 0.35, ...extra,
  });
}

// Anillo pulsante que señala objetos recogibles.
export function createMarkerMaterial(color = 0xffb347) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor * (0.35 + 0.65 * pow(max(0.5 + 0.5 * sin(uTime * 4.0), 0.0), 2.0)) * 1.5, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// Llama de propulsor: gradiente núcleo azulado → cola naranja con parpadeo.
export function createFlameMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: globalUniforms.uTime, uPower: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.xy *= 1.0 + sin(uTime * 47.0 + position.z * 9.0) * 0.06;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uPower; varying vec2 vUv;
      void main() {
        float t = 1.0 - vUv.y;
        vec3 col = mix(vec3(1.0, 0.42, 0.12), vec3(0.65, 0.85, 1.0), pow(max(t, 0.0), 4.0));
        float flick = 0.8 + 0.2 * sin(uTime * 53.0 + vUv.x * 25.0);
        gl_FragColor = vec4(col * pow(max(t, 0.0), 1.5) * flick * uPower * 3.5, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// Rótulo pintado sobre el casco (fondo transparente).
export function createDecalTexture(title, sub) {
  const c = newCanvas(1024, 256), x = c.getContext('2d');
  x.fillStyle = 'rgba(220,212,196,0.92)';
  x.font = 'bold 150px Consolas, "Courier New", monospace';
  x.textBaseline = 'top'; x.fillText(title, 20, 10);
  x.font = 'bold 34px Consolas, "Courier New", monospace'; x.fillText(sub, 26, 186);
  x.fillStyle = 'rgba(200,60,30,0.9)'; x.fillRect(20, 168, 980, 8);
  // Desgaste: arañazos que borran pintura.
  const rnd = mulberry32(77);
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 900; i++) {
    x.globalAlpha = rnd() * 0.7;
    x.fillRect(rnd() * 1024, rnd() * 256, 1 + rnd() * 14, 1 + rnd() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function generateTextureLibrary() {
  return {
    wall: generatePanelSet({ seed: 1, base: [0.3, 0.31, 0.29], rust: 0.65, grime: 0.75 }),
    ceil: generatePanelSet({ seed: 2, base: [0.2, 0.2, 0.21], rust: 0.35, grime: 0.8, cellX: 256, cellY: 128 }),
    floor: generateFloorSet(11),
    hull: generatePanelSet({ seed: 4, base: [0.46, 0.48, 0.5], rust: 0.22, grime: 0.42, cellX: 128, cellY: 256, vents: true, normalStrength: 3 }),
    capsule: generatePanelSet({ seed: 6, size: 256, base: [0.72, 0.7, 0.66], rust: 0.15, grime: 0.35, cellX: 64, cellY: 64, vents: false, normalStrength: 2.5 }),
    hazard: generateHazardSet(5),
    solar: generateSolarTexture(9),
  };
}
