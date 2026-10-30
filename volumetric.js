// =============================================================================
// volumetric.js
// Haz volumétrico de la linterna por raymarching (16 muestras con jitter):
// en cada muestra del rayo de vista se evalúa el cono del foco, la atenuación
// cuadrática, la densidad de polvo (ruido animado) y la VISIBILIDAD contra el
// mapa de sombras del propio foco. Así el haz se corta exactamente donde lo
// interrumpe una pared o un mueble, sin necesitar el buffer de profundidad.
// La luz nace a centímetros de la cámara, por lo que lo que la cámara no ve
// detrás de una pared tampoco lo ilumina el foco.
// =============================================================================
import * as THREE from 'three';
import { globalUniforms } from './procedural-assets.js';

function noiseTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  // Ruido de valor con retícula periódica P (la textura se repite sin costuras).
  const h = (x, y, P) => {
    const s = Math.sin((x % P) * 127.1 + (y % P) * 311.7 + P * 17.3) * 43758.5453;
    return s - Math.floor(s);
  };
  const vn = (x, y, P) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (h(ix, iy, P) * (1 - u) + h(ix + 1, iy, P) * u) * (1 - v) + (h(ix, iy + 1, P) * (1 - u) + h(ix + 1, iy + 1, P) * u) * v;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // fBm periódico de 3 octavas (retículas de 4, 8 y 16 celdas).
      let n = 0, a = 0.5, f = 4 / size;
      for (let o = 0; o < 3; o++) {
        n += a * vn(x * f, y * f, size * f);
        a *= 0.5; f *= 2;
      }
      const v = Math.max(0, Math.min(255, Math.round(n / 0.875 * 255)));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class FlashlightVolume {
  constructor(spot, scene) {
    this.spot = spot;
    const range = 13, angle = spot.angle;
    const geo = new THREE.ConeGeometry(Math.tan(angle) * range * 1.05, range, 32, 1, false);
    geo.translate(0, -range / 2, 0);
    geo.rotateX(-Math.PI / 2); // vértice en el origen, abre hacia -Z
    this.uniforms = {
      uTime: globalUniforms.uTime,
      uLightPos: { value: new THREE.Vector3() },
      uLightDir: { value: new THREE.Vector3(0, 0, -1) },
      uCosOuter: { value: Math.cos(angle) },
      uCosInner: { value: Math.cos(angle * (1 - spot.penumbra * 0.85)) },
      uIntensity: { value: 0 },
      uRange: { value: range },
      uShadow: { value: null },
      uShadowMatrix: { value: spot.shadow.matrix },
      uNoise: { value: noiseTexture() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform float uTime, uCosOuter, uCosInner, uIntensity, uRange;
        uniform vec3 uLightPos, uLightDir;
        uniform sampler2D uShadow, uNoise;
        uniform mat4 uShadowMatrix;
        varying vec3 vWorld;
        float lit(vec3 p) {
          vec4 sc = uShadowMatrix * vec4(p, 1.0);
          sc.xyz /= sc.w;
          if (sc.w <= 0.0 || sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0) return 0.0;
          return step(sc.z - 0.0015, unpackRGBAToDepth(texture2D(uShadow, sc.xy)));
        }
        void main() {
          vec3 ro = cameraPosition, rd = vWorld - ro;
          float tMax = min(length(rd), uRange);
          rd = normalize(rd);
          float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime * 13.7) * 43758.5453);
          float dt = tMax / 16.0, acc = 0.0;
          for (int i = 0; i < 16; i++) {
            vec3 p = ro + rd * ((float(i) + jitter) * dt);
            vec3 L = p - uLightPos;
            float d = length(L);
            float cone = smoothstep(uCosOuter, uCosInner, dot(L / max(d, 1e-3), uLightDir));
            if (cone <= 0.0) continue;
            float n = texture2D(uNoise, p.xz * 0.21 + vec2(uTime * 0.011, 0.0)).r * texture2D(uNoise, p.xy * 0.27 - vec2(0.0, uTime * 0.008)).r;
            float dens = 0.3 + 2.2 * n * n;
            acc += cone * dens * lit(p) / (1.0 + d * d * 0.3);
          }
          // Brillo acotado: el haz nunca satura el bloom.
          vec3 col = vec3(1.0, 0.93, 0.8) * min(acc * dt * uIntensity, 0.35);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._t = new THREE.Vector3();
  }

  // level: intensidad física de la linterna (0..~40).
  update(level) {
    const s = this.spot, u = this.uniforms, on = level > 0.05 && !!s.shadow.map;
    this.mesh.visible = on;
    globalUniforms.uFlash.value = Math.min(1, level / 20);
    s.getWorldPosition(u.uLightPos.value);
    s.target.getWorldPosition(this._t);
    u.uLightDir.value.subVectors(this._t, u.uLightPos.value).normalize();
    globalUniforms.uFlashPos.value.copy(u.uLightPos.value);
    globalUniforms.uFlashDir.value.copy(u.uLightDir.value);
    if (!on) return;
    u.uShadow.value = s.shadow.map.texture;
    u.uIntensity.value = level * 0.0016;
    this.mesh.position.copy(u.uLightPos.value);
    this._t.copy(u.uLightPos.value).sub(u.uLightDir.value);
    this.mesh.lookAt(this._t);
  }
}
