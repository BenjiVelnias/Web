// =============================================================================
// engine.js
// Motor: renderer WebGL 2 (three.js), bucle semi-fijo, cámara en primera
// persona con inercia/head-bobbing, pool de luces dinámicas (número de luces
// constante → sin recompilar shaders, coste acotado), sombras PCF suaves,
// espacio multicapa (nebulosa, estrellas a dos radios, escombros, Marte HD) y
// postproceso (MSAA + bloom + aberración + viñeta + grano + tinte de alerta).
// =============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  globalUniforms, hash1, MARS_LIGHT_DIR, SUN_DIRECTION, MARS_POSITION, MARS_RADIUS,
  createMarsMaterial, createAtmosphereMaterial, createStarfield, createNebula, createDebrisField,
} from './procedural-assets.js';

// Clamp de radiancia en TODOS los materiales de three (Standard, Basic, Points…):
// la suma de luces nunca supera 8 antes del tone mapping (sin quemado blanco).
THREE.ShaderChunk.opaque_fragment = 'outgoingLight = min( outgoingLight, vec3( 8.0 ) );\n' + THREE.ShaderChunk.opaque_fragment;

// Profundidad logarítmica para los ShaderMaterial propios: si no escriben la
// misma profundidad que los materiales de three, la oclusión entre ambos se
// rompe (p. ej. efectos visibles a través de paredes).
const LD_VERT_PARS = `#ifdef USE_LOGDEPTHBUF
varying float vFragDepth;
varying float vIsPerspective;
#endif
`;
const LD_VERT = `
#ifdef USE_LOGDEPTHBUF
vFragDepth = 1.0 + gl_Position.w;
vIsPerspective = float(projectionMatrix[2][3] == -1.0);
#endif
`;
const LD_FRAG_PARS = `#ifdef USE_LOGDEPTHBUF
uniform float logDepthBufFC;
varying float vFragDepth;
varying float vIsPerspective;
#endif
`;
const LD_FRAG = `
#ifdef USE_LOGDEPTHBUF
gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(vFragDepth) * logDepthBufFC * 0.5;
#endif
`;
export function patchLogDepth(m) {
  if (!m || !m.isShaderMaterial || m.isRawShaderMaterial || m.userData.logDepth) return;
  const vs = m.vertexShader, fs = m.fragmentShader;
  const vEnd = vs.lastIndexOf('}');
  const fMain = fs.search(/void\s+main\s*\(\s*\)\s*\{/);
  if (vEnd < 0 || fMain < 0) return;
  const brace = fs.indexOf('{', fMain) + 1;
  m.vertexShader = LD_VERT_PARS + vs.slice(0, vEnd) + LD_VERT + vs.slice(vEnd);
  m.fragmentShader = LD_FRAG_PARS + fs.slice(0, brace) + LD_FRAG + fs.slice(brace);
  m.userData.logDepth = true;
  m.needsUpdate = true;
}

const STEP = 1 / 60;
const MAX_SUBSTEPS = 4;
const POOL_SIZE = 6;      // luces puntuales reales en escena
const POOL_FADE = 3.0;    // metros de fundido antes de ceder una luz del pool

// -----------------------------------------------------------------------------
// Rig de cámara en primera persona.
// position = ojos sin perturbar; bob, respiración y temblor sólo afectan a la
// cámara, así la colisión trabaja con una posición estable.
// -----------------------------------------------------------------------------
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.position = new THREE.Vector3(0, 1.65, 0);
    this.yaw = 0; this.pitch = 0;
    this.targetYaw = 0; this.targetPitch = 0;
    this.lookDamping = 20;
    this.moveFactor = 0;
    this.strafe = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.roll = 0;
    this.shake = 0;
    this.onStep = null;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._safe = new THREE.Vector3(0, 1.65, 0);
    this.tremor = 0; // 0..1: pulso alto / fatiga
  }

  snapLook(yaw, pitch = 0) {
    this.yaw = this.targetYaw = yaw;
    this.pitch = this.targetPitch = pitch;
  }

  addShake(amount) { this.shake = Math.min(1, this.shake + amount); }

  update(dt, time) {
    // Blindaje: un NaN en la posición o la mirada dejaría la pantalla en negro.
    const p = this.position;
    if (Number.isFinite(p.x + p.y + p.z)) this._safe.copy(p); else p.copy(this._safe);
    if (!Number.isFinite(this.targetYaw + this.targetPitch + this.yaw + this.pitch)) {
      this.yaw = this.targetYaw = 0;
      this.pitch = this.targetPitch = 0;
    }
    const k = 1 - Math.exp(-this.lookDamping * dt);
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;

    this.bobAmount += (Math.min(this.moveFactor, 1.6) - this.bobAmount) * (1 - Math.exp(-8 * dt));
    const prevHalf = Math.floor(this.bobPhase / Math.PI);
    this.bobPhase += dt * 8.5 * Math.min(this.moveFactor, 1.6);
    if (Math.floor(this.bobPhase / Math.PI) !== prevHalf && this.bobAmount > 0.25 && this.onStep) this.onStep(this.bobAmount);

    const a = this.bobAmount;
    const bobY = (Math.abs(Math.sin(this.bobPhase)) - 0.5) * 0.06 * a;
    const bobX = Math.cos(this.bobPhase) * 0.035 * a;
    const breath = Math.sin(time * 1.25) * 0.008;
    const rollTarget = -this.strafe * 0.025 + Math.cos(this.bobPhase) * 0.007 * a;
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-6 * dt));

    this.shake *= Math.exp(-3.5 * dt);
    const s = this.shake * this.shake;
    const tr = Math.min(1, Math.max(0, this.tremor || 0));
    const sx = (hash1(time * 61.3) - 0.5) * 0.08 * s + Math.sin(time * 7.3) * Math.sin(time * 2.9) * 0.0035 * tr;
    const sy = (hash1(time * 47.9 + 3.1) - 0.5) * 0.08 * s + Math.sin(time * 9.1 + 1.2) * 0.003 * tr + Math.sin(time * 1.4) * 0.006 * tr;

    this._euler.set(this.pitch + sy * 0.5 + Math.sin(time * 0.9) * 0.002, this.yaw + sx * 0.5, this.roll);
    this.camera.quaternion.setFromEuler(this._euler);
    const cy = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    this.camera.position.set(
      this.position.x + bobX * cy + sx,
      this.position.y + bobY + breath + sy,
      this.position.z - bobX * sn,
    );
  }
}

// -----------------------------------------------------------------------------
// Postproceso final (lineal HDR, antes del tone mapping).
// -----------------------------------------------------------------------------
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.0016 },
    uVignette: { value: 1.15 },
    uGrain: { value: 0.06 },
    uScan: { value: 0.03 },
    uAlert: { value: 0 },
    uImpact: { value: 0 },
    uDamage: { value: 0 },
    uVhs: { value: 0.35 },
    uTint: { value: new THREE.Color(1.0, 0.97, 0.94) },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uAberration, uVignette, uGrain, uScan, uAlert, uImpact, uDamage, uVhs;
    uniform vec3 uTint; uniform vec2 uResolution; varying vec2 vUv;
    float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      // Visor del casco: ligera curvatura de barril en los bordes.
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      c *= 1.0 + r2 * 0.035;
      // Impacto: compresión anamórfica horizontal y salto de línea VHS.
      float imp = uImpact;
      c.x *= 1.0 - imp * 0.05 * (1.0 - 4.0 * c.y * c.y);
      c.y *= 1.0 + imp * 0.018;
      float line = floor((c.y + 0.5) * uResolution.y / 3.0);
      float tick = floor(uTime * 24.0);
      float jit = (rnd(vec2(line, tick)) - 0.5) * imp * 0.014;
      // Banda de tracking que recorre la imagen (muy tenue salvo en impactos).
      float bandY = fract(uTime * 0.06) - 0.5;
      float band = exp(-pow((c.y - bandY) * 40.0, 2.0));
      jit += band * imp * 0.01 * (rnd(vec2(tick, line * 0.1)) - 0.3);
      vec2 uv = c + 0.5 + vec2(jit, 0.0);
      vec2 off = c * (uAberration + uAlert * 0.0015 + imp * 0.006) * (1.0 + r2 * 4.0);
      vec3 col = vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
      // Destello anamórfico: estela horizontal de las zonas brillantes al recibir un golpe.
      if (imp > 0.02) {
        vec3 st = vec3(0.0);
        for (int i = 1; i <= 4; i++) {
          float o = float(i) * 0.012;
          st += max(texture2D(tDiffuse, uv + vec2(o, 0.0)).rgb - 1.0, 0.0) + max(texture2D(tDiffuse, uv - vec2(o, 0.0)).rgb - 1.0, 0.0);
        }
        col += st * vec3(0.35, 0.55, 1.0) * imp * 0.25;
      }
      // Sangrado de croma VHS (desplaza el rojo una fracción de píxel).
      col.r = mix(col.r, texture2D(tDiffuse, uv + vec2(2.0 / uResolution.x, 0.0)).r, 0.25 * uVhs);
      col += band * 0.02 * uVhs;
      col *= uTint;
      // Daño: viñeta roja que late.
      col = mix(col, col * 0.4 + vec3(0.35, 0.0, 0.0), uDamage * smoothstep(0.04, 0.35, r2));
      // Alerta: sangrado rojo pulsante desde los bordes.
      float pulse = 0.5 + 0.5 * sin(uTime * 5.0);
      col = mix(col, col * vec3(1.3, 0.62, 0.58) + vec3(0.09, 0.0, 0.0) * pulse * smoothstep(0.08, 0.35, r2), uAlert);
      col *= pow(max(clamp(1.0 - r2 * uVignette * 1.3, 0.0, 1.0), 0.0), 1.6);
      col *= 1.0 - uScan * (0.5 + 0.5 * sin(vUv.y * uResolution.y * 1.5));
      float n = rnd(vUv * uResolution + fract(uTime * 7.13) * 100.0) - 0.5;
      col *= 1.0 + n * uGrain * 2.0;
      col += n * 0.003;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
      // Última pasada (a pantalla): tone mapping ACES y conversión a sRGB aquí
      // mismo, sin una pasada de salida aparte.
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

const SanitizeShader = {
  uniforms: { tDiffuse: { value: null }, uDiag: { value: 0 } },
  vertexShader: FinalShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uDiag; varying vec2 vUv;
    // NaN/Inf por bits (exponente todo a 1): el compilador no puede eliminarlo,
    // a diferencia de la función estándar, que ANGLE/D3D optimiza con matemática rápida.
    bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // Diagnóstico (F8): los píxeles inválidos se marcan en magenta en vez de negro.
      if (bad(c.r) || bad(c.g) || bad(c.b)) c = vec3(40.0, 0.0, 40.0) * uDiag;
      // Rodilla suave: por encima de 3 el brillo se comprime hacia 6 en lugar de
      // quemarse a blanco (linterna a quemarropa, reflejos especulares).
      float m = max(max(c.r, c.g), c.b);
      if (m > 3.0) { float k = 3.0 + (m - 3.0) / (1.0 + (m - 3.0) / 3.0); c *= k / m; }
      gl_FragColor = vec4(c, 1.0);
    }`,
};

// -----------------------------------------------------------------------------
// Motor
// -----------------------------------------------------------------------------
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true }));
    if (!r.capabilities.isWebGL2) throw new Error('Se requiere WebGL 2.0');
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    // Errores de compilación de shaders: se registran y se avisa sin colgar el bucle.
    this.shaderErrors = 0;
    r.debug.onShaderError = (gl, program, vs, fs) => {
      this.shaderErrors++;
      console.error('Shader error', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs));
      if (this.onShaderError) this.onShaderError();
    };
    r.shadowMap.enabled = true;
    // PCF clásico admite `shadow.radius`: penumbra filtrada sin dientes de sierra.
    r.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x010103);
    this.scene.fog = new THREE.FogExp2(0x0a0302, 0.004);
    this.fogTarget = 0.004;

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 4000);
    this.scene.add(this.camera);
    this.rig = new CameraRig(this.camera);
    // Escena de primer plano (brazo y objeto en mano): se dibuja tras la escena
    // principal con el z-buffer limpio, así nunca atraviesa las paredes.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.01, 10);
    this.cameraMode = 'cinematic';

    this.updatables = [];
    this.lateUpdatables = []; // tras mover la cámara (efectos anclados a la vista)
    this.flickers = [];
    this.shaftMaterials = [];
    this.time = 0;
    this.paused = false;
    this.storm = 1;
    this.marsBase = 5.5;
    this.hemiBase = 0.8;
    this.lightGain = 2.4; // ganancia global de las luces lógicas del interior
    this.alert = 0;
    this.alertTarget = 0;
    this.impactV = 0;
    this.damageV = 0;
    this.contextLost = false;
    // Pérdida del contexto WebGL: se pausa el bucle y se avisa; al restaurarse
    // three.js recrea los recursos y el juego continúa.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      if (this.onContextChange) this.onContextChange(true);
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._last = performance.now();
      if (this.onContextChange) this.onContextChange(false);
    }, false);

    this._buildEnvironment();
    this._buildSpace();
    this._buildLights();
    this._buildPost();

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();
    this._frame = this._frame.bind(this);
  }

  // Entorno para reflejos PBR: sólo gradientes suaves (sin franjas emisivas de
  // bordes duros, que se reflejaban como rectángulos planos en el metal).
  _buildEnvironment() {
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(
      new THREE.SphereGeometry(10, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: /* glsl */ `varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          varying vec3 vP;
          void main() {
            float h = vP.y * 0.5 + 0.5;
            vec3 c = mix(vec3(0.012, 0.007, 0.006), vec3(0.11, 0.06, 0.045), smoothstep(0.2, 1.0, h));
            c += vec3(0.3, 0.1, 0.05) * pow(max(-vP.x, 0.0), 2.0) * 0.35;
            c += vec3(0.25, 0.22, 0.2) * pow(max(vP.y, 0.0), 6.0) * 0.6;
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    ));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(env, 0.04).texture;
    this.viewScene.environment = this.scene.environment;
    pmrem.dispose();
  }

  // Espacio multicapa: nebulosa y estrellas lejanas siguen a la cámara
  // (infinito); estrellas medias y escombros están fijos → paralaje real.
  _buildSpace() {
    this.nebula = createNebula(1900);
    this.starsFar = createStarfield(3200, 1750, 42, 1.0);
    this.starsMid = createStarfield(900, 650, 7, 1.4);
    this.debris = createDebrisField(700, new THREE.Vector3(0, 0, -20), 160);
    this.scene.add(this.nebula, this.starsFar, this.starsMid, this.debris);

    const marsMat = createMarsMaterial(SUN_DIRECTION);
    this.mars = new THREE.Mesh(new THREE.SphereGeometry(MARS_RADIUS, 128, 96), marsMat);
    this.mars.position.copy(MARS_POSITION);
    this.mars.rotation.set(0.25, 2.2, 0.44);
    // El shader ilumina en espacio objeto: rotamos el sol al espacio local.
    marsMat.uniforms.uSunObj.value.copy(SUN_DIRECTION).applyQuaternion(this.mars.quaternion.clone().invert());
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(MARS_RADIUS * 1.045, 96, 64), createAtmosphereMaterial(SUN_DIRECTION));
    atmo.position.copy(MARS_POSITION);
    this.scene.add(this.mars, atmo);

    // Fobos: icosaedro deformado con ruido (suma de senos) → roca irregular.
    const pg = new THREE.IcosahedronGeometry(9, 5), pp = pg.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < pp.count; i++) {
      v.fromBufferAttribute(pp, i).normalize();
      const n = Math.sin(v.x * 5.1 + 1.3) * Math.sin(v.y * 4.3) * Math.sin(v.z * 6.7 + 0.5) * 0.12
        + Math.sin(v.x * 13.0) * Math.sin(v.z * 11.0 + v.y * 9.0) * 0.04 - Math.max(0, Math.sin(v.x * 3 + v.y * 7)) * 0.05;
      v.multiplyScalar(9 * (1 + n)).multiply(new THREE.Vector3(1.25, 0.9, 1.0));
      pp.setXYZ(i, v.x, v.y, v.z);
    }
    pg.computeVertexNormals();
    this.phobos = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ color: 0x5a4a40, roughness: 0.95, metalness: 0.0 }));
    this.phobos.position.set(-215, 34, -40);
    this.phobos.rotation.set(0.4, 1.2, 0.2);
    this.scene.add(this.phobos);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x6a2a1c, 0x1c100b, this.hemiBase);
    this.scene.add(this.hemi);

    // Resplandor de Marte: única luz con sombras de los muros; entra por los
    // ventanales y la brecha del techo.
    const ml = (this.marsLight = new THREE.DirectionalLight(0xff6a3a, this.marsBase));
    // El frustum de sombra cubre TODA la nave: fuera de él una luz direccional
    // ilumina sin sombra y el resplandor se colaría en las salas interiores.
    ml.target.position.set(-1, 1, -38);
    ml.position.copy(ml.target.position).addScaledVector(MARS_LIGHT_DIR, -70);
    ml.castShadow = true;
    ml.shadow.mapSize.set(2048, 2048);
    const sc = ml.shadow.camera;
    sc.left = -52; sc.right = 52; sc.top = 52; sc.bottom = -52; sc.near = 5; sc.far = 150;
    ml.shadow.bias = -0.0006;
    ml.shadow.normalBias = 0.06;
    ml.shadow.radius = 2.5;
    this.scene.add(ml, ml.target);

    this.sunLight = new THREE.DirectionalLight(0xfff0dd, 0);
    this.sunLight.position.copy(SUN_DIRECTION).multiplyScalar(100);
    this.scene.add(this.sunLight);

    // Pool de luces puntuales: cada frame se asignan a las fuentes lógicas
    // más cercanas a la cámara, con fundido para evitar saltos.
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      this.scene.add(l);
      this.pool.push(l);
    }
    this._candIdx = new Int32Array(POOL_SIZE + 1);
    this._candD = new Float32Array(POOL_SIZE + 1);
  }

  _buildPost() {
    const r = this.renderer;
    // stencilBuffer: los ventanales marcan el stencil por donde se ve el exterior.
    // MSAA sólo donde hace falta: la escena se dibuja en renderTarget2 (el
    // readBuffer inicial) con 4 muestras; las pasadas de postproceso escriben en
    // destinos sin MSAA (dos intercambios por fotograma: el reparto es estable).
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, stencilBuffer: true });
    this.composer = new EffectComposer(r, rt);
    this.composer.renderTarget2.samples = 4;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const vp = new RenderPass(this.viewScene, this.viewCamera);
    vp.clear = false;
    vp.clearDepth = true;
    this.composer.addPass(vp);
    // Saneado previo al bloom: un solo píxel NaN/Inf o un brillo especular
    // extremo se convertiría en un bloque cuadrado al difuminarse por mips.
    this.sanitize = new ShaderPass(SanitizeShader);
    this.composer.addPass(this.sanitize);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.35, 0.9);
    this.composer.addPass(this.bloom);
    this.finalPass = new ShaderPass(FinalShader);
    this.composer.addPass(this.finalPass);
    this.post = this.finalPass.uniforms;
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = this.renderer.getPixelRatio();
    this.camera.aspect = this.viewCamera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(Math.floor((w * pr) / 2), Math.floor((h * pr) / 2));
    this.post.uResolution.value.set(w * pr, h * pr);
    globalUniforms.uPixelScale.value = (h * pr * 0.5) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
  }

  // Parchea la profundidad logarítmica en todos los ShaderMaterial de ambas escenas.
  patchShaders() {
    const visit = (o) => {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) patchLogDepth(m);
    };
    this.scene.traverse(visit);
    this.viewScene.traverse(visit);
  }

  add(fn) { this.updatables.push(fn); }
  addLate(fn) { this.lateUpdatables.push(fn); }
  remove(fn) {
    const i = this.updatables.indexOf(fn);
    if (i >= 0) this.updatables.splice(i, 1);
  }
  // Fuente lógica: { pos?, color?, base, distance?, mat?, baseE, mode, speed, seed, power }
  registerFlickers(list) {
    for (const f of list) { f.value = 0; this.flickers.push(f); }
  }
  registerShaft(mat) { this.shaftMaterials.push({ mat, base: mat.uniforms.uIntensity.value }); }
  setAlert(on) { this.alertTarget = on ? 1 : 0; }
  // Diagnóstico gráfico: marca NaN/Inf en magenta y devuelve el nombre de la GPU.
  toggleDiagnostics() {
    const u = this.sanitize.uniforms.uDiag;
    u.value = u.value > 0 ? 0 : 1;
    const gl = this.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return { on: u.value > 0, gpu, stencil: gl.getParameter(gl.STENCIL_BITS), shaderErrors: this.shaderErrors };
  }
  // La luz de Marte es fija respecto a la nave: su mapa de sombras (todo el
  // casco) se calcula una vez en lugar de en cada fotograma.
  freezeStaticShadows() {
    this.marsLight.shadow.autoUpdate = false;
    this.marsLight.shadow.needsUpdate = true;
  }
  // Golpe (distorsión anamórfica) y destello de daño en el visor.
  impact(k) { this.impactV = Math.min(1, this.impactV + k); }
  hurt(k) { this.damageV = Math.min(1, this.damageV + k); }

  start() {
    this._last = performance.now();
    requestAnimationFrame(this._frame);
  }

  _frame(now) {
    requestAnimationFrame(this._frame);
    if (this.contextLost) return;
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    if (!this.paused) {
      const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / STEP - 0.01)));
      const h = dt / n;
      for (let i = 0; i < n; i++) this._update(h);
    }
    this.post.uTime.value = this.time;
    if (!this._camOk()) return;
    this.composer.render();
  }

  // Cámara con transformaciones finitas; si no, se restaura la última válida
  // (un solo NaN en una matriz dejaría toda la imagen en negro).
  _camOk() {
    const c = this.camera, e = c.matrixWorld.elements;
    let ok = Number.isFinite(c.position.x + c.position.y + c.position.z + c.quaternion.x + c.quaternion.y + c.quaternion.z + c.quaternion.w);
    for (let i = 0; ok && i < 16; i++) ok = Number.isFinite(e[i]);
    if (ok) { if (!this._camSafe) this._camSafe = { p: c.position.clone(), q: c.quaternion.clone() }; this._camSafe.p.copy(c.position); this._camSafe.q.copy(c.quaternion); return true; }
    if (this._camSafe) { c.position.copy(this._camSafe.p); c.quaternion.copy(this._camSafe.q); c.updateMatrixWorld(true); return true; }
    return false;
  }

  _update(dt) {
    this.time += dt;
    const t = this.time;
    globalUniforms.uTime.value = t;
    for (let i = 0; i < this.updatables.length; i++) this.updatables[i](dt, t);
    if (this.cameraMode === 'rig') this.rig.update(dt, t);
    for (let i = 0; i < this.lateUpdatables.length; i++) this.lateUpdatables[i](dt, t);
    const cp = this.camera.position;
    this.nebula.position.copy(cp);
    this.starsFar.position.copy(cp);
    const fog = this.scene.fog;
    fog.density += (this.fogTarget - fog.density) * (1 - Math.exp(-2 * dt));
    this.alert += (this.alertTarget - this.alert) * (1 - Math.exp(-3 * dt));
    this.post.uAlert.value = this.alert;
    globalUniforms.uAlert.value = this.alert;
    this.impactV *= Math.exp(-4 * dt);
    this.damageV *= Math.exp(-2.2 * dt);
    this.post.uImpact.value = this.impactV;
    this.post.uDamage.value = this.damageV;
    this.post.uVhs.value = 0.35 + this.alert * 0.4;
    this._updateLights(t);
    this._updatePool();
  }

  _updateLights(t) {
    const storm = (this.storm = 0.78 + 0.12 * Math.sin(t * 0.23) + 0.1 * Math.sin(t * 0.71 + 1.3) * Math.sin(t * 0.17));
    this.hemi.intensity = this.hemiBase * (0.85 + 0.15 * storm) * (1 - this.alert * 0.3);
    this.marsLight.intensity = this.marsBase * storm;
    for (let i = 0; i < this.shaftMaterials.length; i++) {
      const s = this.shaftMaterials[i];
      s.mat.uniforms.uIntensity.value = s.base * storm;
    }
    for (let i = 0; i < this.flickers.length; i++) {
      const f = this.flickers[i];
      let k;
      switch (f.mode) {
        case 'steady': k = 0.96 + 0.04 * Math.sin(t * 3.1 + f.seed); break;
        case 'flicker': {
          const h = hash1(Math.floor(t * 9 * f.speed) + f.seed);
          k = h > 0.9 ? 0.25 : 0.88 + 0.12 * Math.sin(t * 37 + f.seed) * Math.sin(t * 13.7);
          break;
        }
        case 'broken': {
          const burst = hash1(Math.floor(t * 0.8) + f.seed) > 0.55;
          k = burst && hash1(Math.floor(t * 16) + f.seed * 3) > 0.45 ? 1 : 0.03;
          break;
        }
        case 'pulse': { const s = 0.5 + 0.5 * Math.sin(t * f.speed + f.seed); k = s * s; break; }
        case 'blink': k = ((t * f.speed + f.seed) % 1) < 0.1 ? 1 : 0; break;
        case 'mars': k = storm; break;
        // Baliza giratoria: barrido periódico con desfase por posición.
        case 'alarm': { const s = Math.max(0, Math.sin(t * 4.2 + f.seed)); k = 0.12 + 0.88 * s * s * s; break; }
        default: k = 0;
      }
      k *= f.power;
      f.value = f.base * k;
      if (f.mat) f.mat.emissiveIntensity = f.baseE * k;
    }
  }

  // Selecciona las POOL_SIZE fuentes encendidas más cercanas (inserción en
  // arrays fijos) y funde la última según la distancia a la siguiente candidata.
  _updatePool() {
    const cam = this.camera.position, F = this.flickers;
    const idx = this._candIdx, dist = this._candD;
    let n = 0;
    for (let i = 0; i < F.length; i++) {
      const f = F[i];
      if (!f.pos || f.base <= 0 || f.power <= 0) continue;
      // Las luces de otra cubierta (más de 2,6 m de desnivel) quedan tras el
      // forjado: se penalizan para no gastar luces reales del pool en ellas.
      let d = f.pos.distanceToSquared(cam);
      const dy = Math.abs(f.pos.y - cam.y);
      if (dy > 2.6) { const pd = Math.sqrt(d) + (dy - 2.6) * 6; d = pd * pd; }
      const full = n === POOL_SIZE + 1;
      if (full && d >= dist[POOL_SIZE]) continue;
      let j = full ? POOL_SIZE : n;
      while (j > 0 && dist[j - 1] > d) { dist[j] = dist[j - 1]; idx[j] = idx[j - 1]; j--; }
      dist[j] = d; idx[j] = i;
      if (n < POOL_SIZE + 1) n++;
    }
    const edge = n > POOL_SIZE ? Math.sqrt(dist[POOL_SIZE]) : Infinity;
    for (let k = 0; k < POOL_SIZE; k++) {
      const l = this.pool[k];
      if (k >= n) { l.intensity = 0; continue; }
      const f = F[idx[k]];
      l.position.copy(f.pos);
      l.color.copy(f.color);
      l.distance = f.distance;
      const fade = edge === Infinity ? 1 : Math.min(1, Math.max(0, (edge - Math.sqrt(dist[k])) / POOL_FADE));
      l.intensity = f.value * fade * this.lightGain;
    }
  }
}
