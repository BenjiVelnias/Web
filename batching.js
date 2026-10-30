// =============================================================================
// batching.js
// Fusión de geometría estática: las mallas inmóviles del casco que comparten
// material se combinan en una sola malla por (material, sombras, atributos).
// Pasa de cientos de llamadas de dibujo a unas decenas en la pasada principal
// y en las de sombras (el cuello de botella de CPU con ANGLE/D3D11).
// Criterio conservador: sólo hijos directos del grupo de la nave, material
// estándar opaco compartido, y nada que el juego mueva o referencie después
// (puertas, recogibles, objetos expuestos en el objeto `ship`).
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Recorre el objeto `ship` y reúne todos los Object3D que el juego conoce.
function referencedObjects(ship) {
  const out = new Set(), seen = new Set();
  const visit = (v, depth) => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 4) return;
    seen.add(v);
    if (v.isObject3D) { out.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (v.isMaterial || v.isTexture || v.isBufferGeometry || v.isVector3 || v.isColor) return;
    for (const k of Object.keys(v)) if (k !== 'group' && k !== 'exterior') visit(v[k], depth + 1);
  };
  visit(ship, 0);
  return out;
}

export function mergeStatic(ship) {
  const group = ship.group, keep = referencedObjects(ship);
  for (const d of Object.values(ship.doors)) for (const p of d.parts) keep.add(p.mesh);
  const buckets = new Map();
  for (const o of group.children) {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || keep.has(o) || o.children.length || !o.visible) continue;
    const m = o.material;
    if (!m || Array.isArray(m) || !m.isMeshStandardMaterial || m.transparent || m.colorWrite === false || m.stencilWrite) continue;
    const g = o.geometry, attrs = Object.keys(g.attributes).sort();
    const sig = attrs.map((a) => a + g.attributes[a].itemSize).join() + (g.index ? '|i' : '|n') + (g.morphAttributes.position ? '|m' : '');
    const key = `${m.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}|${sig}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(o);
  }
  let before = 0, after = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const geos = list.map((o) => {
      o.updateMatrix();
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrix);
      return g;
    });
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const src = list[0];
    const mesh = new THREE.Mesh(merged, src.material);
    mesh.castShadow = src.castShadow;
    mesh.receiveShadow = src.receiveShadow;
    mesh.renderOrder = src.renderOrder;
    mesh.name = 'static-batch';
    for (const o of list) group.remove(o);
    group.add(mesh);
    before += list.length;
    after++;
  }
  return { before, after };
}
