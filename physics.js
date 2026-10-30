// =============================================================================
// physics.js
// Mundo físico ligero y exacto:
//  · Colisionadores AABB y cilindros verticales con RANGO VERTICAL (minY/maxY):
//    los muros de un piso no bloquean a quien camina en otro.
//  · Resolución CÍRCULO-contra-AABB por punto más cercano (no un cuadrado):
//    el jugador se desliza por esquinas sin "muros invisibles".
//  · Superficies transitables (suelos y rampas de escalera) con materiales
//    acústicos ('solid' / 'hollow'), techos por nivel y paredes curvas (arcos).
//  · Prueba de segmento 3D (slabs) para línea de visión, oclusión acústica y
//    proyectiles. Todo sin asignaciones en el bucle.
// =============================================================================
import * as THREE from 'three';
import { ceilingAt as deckCeiling } from './level.js';

export const STEP = 0.42;       // altura máxima de escalón que se sube andando
export const BODY_LO = 0.28;    // franja vertical del cuerpo sobre los pies
export const BODY_HI = 1.75;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class PhysicsWorld {
  constructor(colliders) {
    this.colliders = colliders;
    this.surfaces = [];
    this.arcs = [];
    this.ceilings = [];
    this.hitN = new THREE.Vector3();
    this.lastMat = 'solid';
  }

  // { minX, maxX, minZ, maxZ, y, mat } o rampa { ..., axis: 'x'|'z', a0, a1, y0, y1 }
  addSurface(s) { this.surfaces.push(s); return s; }
  // Pared curva: el cuerpo queda dentro del semicírculo { cx, cz, R, zMin, yMin, yMax }.
  addArc(a) { this.arcs.push(a); return a; }
  // Techo de un nivel superior { minX, maxX, minZ, maxZ, floorY, y }.
  addCeiling(c) { this.ceilings.push(c); return c; }

  surfaceHeight(s, x, z) {
    if (!s.axis) return s.y;
    const a = s.axis === 'z' ? z : x;
    return s.y0 + (s.y1 - s.y0) * clamp((a - s.a0) / (s.a1 - s.a0), 0, 1);
  }

  // Suelo bajo los pies: la superficie más alta que no supere pies + escalón.
  groundAt(x, z, feetY) {
    let best = -Infinity, mat = 'solid';
    const S = this.surfaces;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      const h = this.surfaceHeight(s, x, z);
      if (h <= feetY + STEP && h > best) { best = h; mat = s.mat || 'solid'; }
    }
    this.lastMat = mat;
    return best;
  }

  ceilingAt(x, y, z) {
    const C = this.ceilings;
    for (let i = 0; i < C.length; i++) {
      const c = C[i];
      if (y >= c.floorY - 0.1 && x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) return c.y;
    }
    return deckCeiling(x, z);
  }

  overlapsY(c, y0, y1) { return (c.maxY ?? 3.5) > y0 && (c.minY ?? -1) < y1; }

  // Círculo de radio r en la franja [y0, y1]. Devuelve true si hubo contacto.
  resolveCircle(p, y0, y1, r) {
    if (!Number.isFinite(p.x + p.z)) return false;
    let hit = false;
    const cols = this.colliders;
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (!c.active || !this.overlapsY(c, y0, y1)) continue;
        if (c.r) {
          const dx = p.x - c.cx, dz = p.z - c.cz, d = Math.hypot(dx, dz), min = c.r + r;
          if (d < min && d > 1e-6) { p.x = c.cx + (dx / d) * min; p.z = c.cz + (dz / d) * min; hit = true; }
          continue;
        }
        if (p.x + r <= c.minX || p.x - r >= c.maxX || p.z + r <= c.minZ || p.z - r >= c.maxZ) continue;
        const qx = clamp(p.x, c.minX, c.maxX), qz = clamp(p.z, c.minZ, c.maxZ);
        const dx = p.x - qx, dz = p.z - qz, d2 = dx * dx + dz * dz;
        if (d2 > 1e-10) {
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          p.x = qx + (dx / d) * r; p.z = qz + (dz / d) * r;
        } else {
          // Centro dentro de la caja: sale por el eje de menor penetración.
          const l = p.x - c.minX, rr = c.maxX - p.x, b = p.z - c.minZ, f = c.maxZ - p.z;
          const m = Math.min(l, rr, b, f);
          if (m === l) p.x = c.minX - r; else if (m === rr) p.x = c.maxX + r; else if (m === b) p.z = c.minZ - r; else p.z = c.maxZ + r;
        }
        hit = true;
      }
      for (let i = 0; i < this.arcs.length; i++) {
        const a = this.arcs[i];
        if (y1 <= a.yMin || y0 >= a.yMax || p.z <= a.zMin) continue;
        const dx = p.x - a.cx, dz = p.z - a.cz, d = Math.hypot(dx, dz), lim = a.R - r;
        if (d > lim) { p.x = a.cx + (dx / d) * lim; p.z = a.cz + (dz / d) * lim; hit = true; }
      }
    }
    return hit;
  }

  // Punto fuera de un arco (cristal curvo): devuelve el arco o null.
  outsideArc(x, y, z) {
    for (let i = 0; i < this.arcs.length; i++) {
      const a = this.arcs[i];
      if (y > a.yMin && y < a.yMax && z > a.zMin && Math.hypot(x - a.cx, z - a.cz) > a.R) return a;
    }
    return null;
  }

  // Primer impacto del segmento a→b contra los colisionadores activos.
  // Devuelve t ∈ [0, 1] (1 = libre) y deja la normal en this.hitN.
  segment(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    let best = 1;
    const n = this.hitN.set(0, 0, 0), cols = this.colliders;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c.active) continue;
      const lo = c.minY ?? -1, hi = c.maxY ?? 3.5;
      if (c.r) {
        const fx = ax - c.cx, fz = az - c.cz, A = dx * dx + dz * dz;
        if (A < 1e-12) continue;
        const B = 2 * (fx * dx + fz * dz), Cq = fx * fx + fz * fz - c.r * c.r, disc = B * B - 4 * A * Cq;
        if (disc < 0) continue;
        const t = (-B - Math.sqrt(disc)) / (2 * A);
        if (t < 0 || t >= best) continue;
        const y = ay + dy * t;
        if (y < lo || y > hi) continue;
        best = t;
        n.set(fx + dx * t, 0, fz + dz * t).normalize();
        continue;
      }
      let t0 = 0, t1 = best, axis = -1, sgn = 0, miss = false;
      for (let k = 0; k < 3 && !miss; k++) {
        const a = k === 0 ? ax : k === 1 ? ay : az, d = k === 0 ? dx : k === 1 ? dy : dz;
        const mn = k === 0 ? c.minX : k === 1 ? lo : c.minZ, mx = k === 0 ? c.maxX : k === 1 ? hi : c.maxZ;
        if (Math.abs(d) < 1e-9) { if (a < mn || a > mx) miss = true; continue; }
        let ta = (mn - a) / d, tb = (mx - a) / d;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) { t0 = ta; axis = k; sgn = d > 0 ? -1 : 1; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) miss = true;
      }
      if (miss || axis < 0 || t0 <= 0 || t0 >= best) continue;
      best = t0;
      n.set(axis === 0 ? sgn : 0, axis === 1 ? sgn : 0, axis === 2 ? sgn : 0);
    }
    return best;
  }

  // ¿Hay visión/audición directa entre dos puntos?
  clear(ax, ay, az, bx, by, bz) { return this.segment(ax, ay, az, bx, by, bz) >= 0.999; }
}
