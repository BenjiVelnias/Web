// =============================================================================
// save.js
// Puntos de control persistentes en localStorage (inventario, progreso, puertas,
// enemigos, posición). Tolerante a almacenamiento bloqueado o datos corruptos.
// sessionStorage marca la continuación automática tras morir (recarga limpia).
// =============================================================================
const KEY = 'odisea-ix/checkpoint/v1', AUTO = 'odisea-ix/continue';

export const Save = {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && d.v === 1 && Number.isFinite(d.seed) ? d : null;
    } catch { return null; }
  },
  write(data) {
    try { localStorage.setItem(KEY, JSON.stringify({ ...data, v: 1, time: Date.now() })); return true; } catch { return false; }
  },
  clear() { try { localStorage.removeItem(KEY); } catch { /* sin almacenamiento */ } },
  requestAutoContinue() { try { sessionStorage.setItem(AUTO, '1'); } catch { /* sin almacenamiento */ } },
  takeAutoContinue() {
    try {
      const v = sessionStorage.getItem(AUTO) === '1';
      sessionStorage.removeItem(AUTO);
      return v;
    } catch { return false; }
  },
};
