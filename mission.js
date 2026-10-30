// =============================================================================
// mission.js
// Lógica de misión: interactuables (recogibles, terminales y bitácoras),
// animación de puertas, dos minijuegos de intrusión (sincronización para
// cerraduras simples; descifrado lógico XOR para compuertas avanzadas),
// alerta de contención, puntos de control y extracción.
//
// Flujo:
//   Intro → la compuerta de descompresión se abre.
//   Oficina C-2 bloqueada → piratear (sincronización) → tarjeta B-3 + célula.
//   Cuarentena del Nodo D → hay que anularla desde el PUENTE DE MANDO:
//     Sala de servidores → redirigir energía auxiliar → se abre el puente.
//     Escalera → Puente → consola de mando (XOR) → cuarentena anulada.
//   Laboratorio B-3 → tarjeta → maletín ADN → ALERTA:
//     · sirenas, drones y torretas activos, compuertas BD-1/cuarentena/
//       descompresión selladas.
//   Cuarentena (XOR) → BD-1 (XOR) → célula en la descompresión → cápsula.
// =============================================================================
import { LEVEL } from './level.js';
import { LOGS } from './logs.js';
import { XorPuzzle } from './decrypt.js';
import { Save } from './save.js';

const RED = 0xff1a0a, GREEN = 0x20ff50;
const CHECKPOINT_DOORS = ['d0', 'bd1', 'qs', 'bridge'];

export class Mission {
  constructor(engine, ship, synth, hud) {
    this.engine = engine;
    this.ship = ship;
    this.synth = synth;
    this.hud = hud;
    this.player = null;
    this.enemies = null;
    this.music = null;
    this.sound = null;
    this.state = 'intro';
    this.hack = null;
    this.reading = null;
    this.objective = '';
    this.flags = { deniedLab: false, cellInstalled: false, qsHint: false, auxPower: false, labSeen: false };
    this._d0Timer = -1;
    this._ck = { name: '', t: -99 };
    this.doorList = Object.values(ship.doors);
    // Cada terminal recuerda su último texto (para restaurar puntos de control).
    for (const t of Object.values(ship.terminals)) {
      const draw = t.draw;
      t.draw = (a, b, c) => { t.last = [a, b, c]; draw(a, b, c); };
    }
    this.interactables = [];
    this._build();
    for (const a of ship.animators) engine.add(a);
    engine.add((dt, t) => this.update(dt, t));
  }

  setPlayer(p) { this.player = p; }
  attach({ enemies, music, sound }) { this.enemies = enemies; this.music = music; this.sound = sound; }
  _obj(text) { this.objective = text; this.hud.setObjective(text); }

  // ---------------------------------------------------------------------------
  // Interactuables: { pos, range, active(), prompt() → [texto, aviso], use() }
  _build() {
    const S = this.ship, D = S.doors, Tm = S.terminals, inv = () => this.player.inventory;
    const add = (o) => this.interactables.push({ range: 2.0, ...o });
    for (const p of S.pickups) {
      add({ pos: p.position, range: 2.4, active: () => !p.taken, prompt: () => [`[E] RECOGER ${p.name}`, false], use: () => this._pickup(p) });
    }
    for (const l of S.logTerms) {
      const log = LOGS[l.id];
      if (!log) continue;
      add({ pos: l.pos, active: () => !this.hack && !this.reading, prompt: () => [`[E] LEER // ${log.title}`, false], use: () => this.readLog(l.id) });
    }
    add({
      pos: Tm.t0.pos,
      active: () => D.office.target === 0 && !this.hack,
      prompt: () => ['[E] PIRATEAR CERRADURA // SEGURIDAD C-2', false],
      use: () => this.beginHack(Tm.t0, 'NODO C-2 // CERRADURA', 3, 0.9, () => {
        Tm.t0.draw('SEGURIDAD C-2', 'ANULADA', '#5aff8a');
        this.openDoor(D.office);
        this.hud.toast('CERRADURA ANULADA — OFICINA DE SEGURIDAD');
      }),
    });
    add({
      pos: Tm.keypad.pos,
      active: () => D.lab.target === 0,
      prompt: () => (inv().has('tarjeta') ? ['[E] DESLIZAR TARJETA DE ACCESO B-3', false] : ['ACCESO DENEGADO // SE REQUIERE TARJETA B-3', true]),
      use: () => {
        if (inv().has('tarjeta')) {
          Tm.keypad.draw('LAB B-3', 'ACCESO OK', '#5aff8a');
          this.openDoor(D.lab);
          this.synth.unlock();
          this.hud.toast('ACCESO CONCEDIDO — LABORATORIO B-3');
          this._obj('Recupere el maletín ADN de la cámara de contención');
        } else {
          this.synth.denied();
          this.hud.toast('ACCESO DENEGADO', 'warn');
          if (!this.flags.deniedLab) {
            this.flags.deniedLab = true;
            this._obj('Busque una tarjeta B-3 en la Oficina de Seguridad C-2');
          }
        }
      },
    });
    // Cuarentena: aviso en el lado del Nodo D.
    add({
      pos: Tm.qsInfo.pos,
      active: () => D.qs.target === 0 && this.state !== 'alert',
      prompt: () => ['CUARENTENA ACTIVA // ANÚLELA DESDE EL PUENTE DE MANDO', true],
      use: () => {
        this.synth.denied();
        if (!this.flags.qsHint) {
          this.flags.qsHint = true;
          this._obj(this.flags.auxPower
            ? 'Suba al Puente de Mando (escalera del pasillo principal) y anule la cuarentena'
            : 'Desvíe energía auxiliar al Puente de Mando desde la Sala de Servidores (ala oeste)');
        }
      },
    });
    // Sala de servidores: energía auxiliar → puente.
    add({
      pos: Tm.tsr.pos,
      active: () => !this.flags.auxPower && !this.hack,
      prompt: () => ['[E] PIRATEAR NÚCLEO // DESVIAR ENERGÍA AL PUENTE', false],
      use: () => this.beginHack(Tm.tsr, 'NÚCLEO DE DATOS // ENERGÍA AUXILIAR', 3, 1.0, () => {
        this.flags.auxPower = true;
        Tm.tsr.draw('ENERGÍA AUX.', '→ PUENTE', '#5aff8a');
        Tm.bridgePower.draw('PUENTE', 'ENERGÍA OK', '#5aff8a');
        this.openDoor(D.bridge);
        this.synth.powerUp();
        this.hud.toast('ENERGÍA AUXILIAR DESVIADA — PUENTE DE MANDO EN LÍNEA');
        if (D.qs.target === 0) this._obj('Suba al Puente de Mando (escalera del pasillo principal) y anule la cuarentena');
      }),
    });
    add({
      pos: Tm.bridgePower.pos,
      active: () => D.bridge.target === 0,
      prompt: () => ['PUENTE SIN ENERGÍA // DESVÍELA DESDE LA SALA DE SERVIDORES', true],
      use: () => this.synth.denied(),
    });
    // Consola de mando del puente: descifrado XOR → anula la cuarentena.
    add({
      pos: Tm.bridgeCmd.pos,
      active: () => D.qs.target === 0 && this.state !== 'alert' && !this.hack,
      prompt: () => ['[E] DESCIFRAR CÓDIGO DE MANDO // CUARENTENA', false],
      use: () => this.beginXor(Tm.bridgeCmd, 'MANDO // CÓDIGO DE CUARENTENA', 3, 13, () => {
        Tm.bridgeCmd.draw('MANDO', 'CUARENTENA OFF', '#5aff8a');
        Tm.qsInfo.draw('CUARENTENA', 'ANULADA', '#5aff8a');
        Tm.t2.draw('CUARENTENA', 'ABIERTA', '#5aff8a');
        this.openDoor(D.qs);
        this.hud.toast('CUARENTENA ANULADA — ACCESO AL LABORATORIO B-3');
        this._obj(inv().has('tarjeta') ? 'Abra el Laboratorio B-3 con la tarjeta de acceso' : 'Busque una tarjeta B-3 en la Oficina de Seguridad C-2');
      }),
    });
    // Alerta: compuertas avanzadas con descifrado XOR.
    add({
      pos: Tm.t2.pos,
      active: () => this.state === 'alert' && D.qs.target === 0 && !this.hack,
      prompt: () => ['[E] DESCIFRAR COMPUERTA DE CUARENTENA', false],
      use: () => this.beginXor(Tm.t2, 'CUARENTENA // ANULACIÓN MANUAL', 3, 11, () => {
        Tm.t2.draw('CUARENTENA', 'FORZADA', '#5aff8a');
        this.openDoor(D.qs);
        this._obj('Fuerce la compuerta blindada BD-1 del pasillo principal');
      }),
    });
    add({
      pos: Tm.t1.pos,
      active: () => this.state === 'alert' && D.bd1.target === 0 && !this.hack,
      prompt: () => ['[E] DESCIFRAR COMPUERTA BLINDADA BD-1', false],
      use: () => this.beginXor(Tm.t1, 'BD-1 // ANULACIÓN DE EMERGENCIA', 4, 11, () => {
        Tm.t1.draw('COMPUERTA BD-1', 'FORZADA', '#5aff8a');
        this.openDoor(D.bd1);
        this._obj(inv().has('celula')
          ? 'Restaure la energía de la compuerta de descompresión'
          : 'Consiga una célula de energía (Oficina C-2) para la compuerta de descompresión');
      }),
    });
    add({
      pos: Tm.power.pos,
      active: () => this.state === 'alert' && !this.flags.cellInstalled,
      prompt: () => (inv().has('celula') ? ['[E] INSERTAR CÉLULA DE ENERGÍA', false] : ['SIN ENERGÍA // SE REQUIERE CÉLULA DE ENERGÍA', true]),
      use: () => {
        if (!inv().has('celula')) { this.synth.denied(); return; }
        inv().remove('celula');
        this.flags.cellInstalled = true;
        Tm.power.draw('DESCOMPRESIÓN', 'RECARGANDO', '#ffb347');
        this.synth.powerUp();
        this.hud.toast('CÉLULA INSERTADA — RESTABLECIENDO ENERGÍA');
        this._d0Timer = 1.6;
      },
    });
  }

  // ---------------------------------------------------------------------------
  begin() {
    this.state = 'explore';
    this.openDoor(this.ship.doors.d0);
    this._obj('Recupere el maletín ADN del Laboratorio B-3');
  }

  setDoorStatus(d, hex) { for (const m of d.statusMats) m.emissive.setHex(hex); }
  openDoor(d) { d.target = 1; this.setDoorStatus(d, GREEN); this.synth.doorOpen(); }
  closeDoor(d) { d.target = 0; this.setDoorStatus(d, RED); }
  _snapDoor(d, v) {
    d.target = d.progress = v;
    const e = v * v * (3 - 2 * v);
    for (const p of d.parts) p.mesh.position.lerpVectors(p.closed, p.open, e);
    d.collider.active = v < 0.7;
    this.setDoorStatus(d, v > 0.5 ? GREEN : RED);
  }

  _pickup(p, quiet = false) {
    const inv = this.player.inventory;
    if (!quiet && !inv.add({ id: p.id, name: p.name })) {
      this.synth.denied();
      this.hud.toast('INVENTARIO LLENO', 'warn');
      return;
    }
    p.taken = true;
    p.mesh.visible = false;
    p.ring.visible = false;
    if (quiet) return;
    this.synth.pickup();
    this.hud.toast(`${p.name} AÑADIDO AL INVENTARIO`);
    if (p.id === 'linterna') {
      this.hud.toast('[F] ALTERNAR LINTERNA');
      this.player.setFlashlight(true);
    } else if (p.id === 'tarjeta') {
      if (this.ship.doors.lab.target === 0 && this.ship.doors.qs.target === 1) this._obj('Abra el Laboratorio B-3 con la tarjeta de acceso');
    } else if (p.id === 'celula' && this.state === 'alert' && this.ship.doors.bd1.target === 1) {
      this._obj('Restaure la energía de la compuerta de descompresión');
    } else if (p.id === 'maletin') {
      this.startAlert();
    } else if (p.id === 'plasma') {
      this.hud.toast('RIFLE DE PLASMA HX-9 — [CLIC] DISPARAR');
    }
  }

  // ------------------------------------------------------------- Bitácoras
  readLog(id) {
    this.reading = id;
    this.player.setBusy(true);
    this.hud.showLog(LOGS[id]);
    this.synth.blip();
  }
  closeLog() {
    if (!this.reading) return;
    this.reading = null;
    this.hud.showLog(null);
    this.player.setBusy(false);
    this.synth.click();
  }

  // ------------------------------------------------------------- Alerta
  startAlert(quiet = false) {
    const S = this.ship;
    this.state = 'alert';
    S.state.alert = true;
    this.engine.setAlert(true);
    this.synth.startAlarm();
    if (!quiet) this.synth.slam();
    for (const f of S.lights) {
      if (!f.alarm) continue;
      f.mode = 'alarm';
      f.base = Math.max(f.base, 5);
      f.power = 1;
      if (f.color) f.color.setHex(RED);
      if (f.mat) f.mat.emissive.setHex(RED);
    }
    for (const b of S.beacons) b.f.base = b.alertBase;
    S.chamber.ringMat.emissive.setHex(RED);
    this.closeDoor(S.doors.bd1);
    this.closeDoor(S.doors.d0);
    this.closeDoor(S.doors.qs);
    S.terminals.t1.draw('COMPUERTA BD-1', 'SELLADA', '#ff5a3a');
    S.terminals.t2.draw('CUARENTENA', 'SELLADA', '#ff5a3a');
    S.terminals.qsInfo.draw('CUARENTENA', 'SELLADA', '#ff5a3a');
    S.terminals.power.draw('DESCOMPRESIÓN', 'SIN ENERGÍA', '#ff5a3a');
    this.hud.setAlert(true);
    if (this.enemies) this.enemies.onAlert();
    if (this.sound) this.sound.setKindActivity('siren', 1);
    if (quiet) return;
    this._obj('ALERTA DE CONTENCIÓN — Fuerce la cuarentena y regrese a la cápsula');
    this.hud.toast('PROTOCOLO DE CONTENCIÓN ACTIVADO', 'warn');
    this.hud.toast('SISTEMAS DE DEFENSA EN LÍNEA', 'warn');
    this.player.rig.addShake(0.7);
    this.engine.impact(0.6);
  }

  // ------------------------------------------------------------- Intrusión
  // Sincronización: un cursor barre la barra; hay que fijarlo dentro de la
  // ventana verde `rounds` veces. Cada acierto estrecha la ventana.
  beginHack(term, title, rounds, speed, onDone) {
    this.hack = { type: 'timing', term, title, rounds, done: 0, speed, phase: Math.random(), cursor: 0, center: 0.5, width: 0.22, onDone };
    this._newWindow();
    this.player.setBusy(true);
    this.hud.showHack(true, title);
    term.draw(title.split(' ')[0], 'PIRATEANDO…', '#ffb347');
    this.synth.hackStart();
  }

  // Descifrado XOR (compuertas avanzadas).
  beginXor(term, title, rounds, time, onDone) {
    this.hack = { type: 'xor', term, title, onDone, puzzle: new XorPuzzle(rounds, time), shown: -1 };
    this.player.setBusy(true);
    this.hud.showXor(true, title);
    term.draw(title.split(' ')[0], 'DESCIFRANDO…', '#ffb347');
    this.synth.hackStart();
  }

  _newWindow() {
    const h = this.hack;
    h.width = Math.max(0.1, 0.26 - h.done * 0.03);
    h.center = h.width / 2 + Math.random() * (1 - h.width);
  }

  _hackDone() {
    const h = this.hack;
    this.hack = null;
    this.hud.showHack(false);
    this.hud.showXor(false);
    this.player.setBusy(false);
    this.synth.hackDone();
    h.onDone();
  }

  _hackFail() {
    this.synth.hackFail();
    this.player.rig.addShake(0.12);
    this.player.startle(4);
  }

  hackInput() {
    const h = this.hack;
    if (!h || h.type !== 'timing') return;
    if (Math.abs(h.cursor - h.center) <= h.width / 2) {
      h.done++;
      this.synth.hackOk();
      if (h.done >= h.rounds) { this._hackDone(); return; }
      h.speed *= 1.07;
      this._newWindow();
    } else {
      h.done = Math.max(0, h.done - 1);
      this.hud.hackFlash();
      this._hackFail();
    }
  }

  hackKey(i) {
    const h = this.hack;
    if (!h || h.type !== 'xor') return;
    const r = h.puzzle.toggle(i);
    this.synth.click();
    if (r === 'done') this._hackDone();
    else if (r === 'ok') this.synth.hackOk();
  }

  cancelHack() {
    const h = this.hack;
    if (!h) return;
    this.hack = null;
    this.hud.showHack(false);
    this.hud.showXor(false);
    this.player.setBusy(false);
    h.term.draw(h.title.split(' ')[0], 'BLOQUEADA', '#ff5a3a');
  }

  // ------------------------------------------------------- Puntos de control
  snapshot() {
    const S = this.ship, inv = this.player.inventory, doors = {}, terms = {};
    for (const [k, d] of Object.entries(S.doors)) doors[k] = d.target;
    for (const [k, t] of Object.entries(S.terminals)) if (t.last) terms[k] = t.last;
    return {
      seed: S.seed, state: this.state, flags: { ...this.flags }, objective: this.objective, doors, terms,
      taken: S.pickups.filter((p) => p.taken).map((p) => p.id),
      inv: inv.slots.map((s) => (s ? { id: s.id, name: s.name } : null)), sel: inv.selected,
      enemies: this.enemies ? this.enemies.snapshot() : null,
      player: this.player.snapshot(),
    };
  }

  checkpoint(label) {
    if (this.state === 'done' || this.player.dead) return;
    if (Save.write(this.snapshot())) {
      this.hud.toast(`PUNTO DE CONTROL — ${label}`, 'save');
      this.synth.suitBeep('save');
    }
  }

  restore(d) {
    const S = this.ship, inv = this.player.inventory;
    Object.assign(this.flags, d.flags || {});
    for (const p of S.pickups) if (d.taken && d.taken.includes(p.id)) this._pickup(p, true);
    if (Array.isArray(d.inv)) { inv.slots = d.inv.slice(0, 5); while (inv.slots.length < 5) inv.slots.push(null); }
    inv.selected = d.sel | 0;
    inv.render();
    if (d.state === 'alert') this.startAlert(true);
    else this.state = 'explore';
    for (const [k, v] of Object.entries(d.doors || {})) if (S.doors[k]) this._snapDoor(S.doors[k], v);
    for (const [k, v] of Object.entries(d.terms || {})) if (S.terminals[k]) S.terminals[k].draw(v[0], v[1], v[2]);
    if (d.enemies && this.enemies) this.enemies.restore(d.enemies);
    if (this.state === 'alert' && this.flags.cellInstalled && S.doors.d0.target === 0) this._d0Timer = 0.5;
    this._obj(d.objective || 'Recupere el maletín ADN del Laboratorio B-3');
    this.player.restore(d.player);
    this._ck.name = 'restore';
    this._ck.t = this.engine.time;
  }

  _checkpoints(t) {
    const p = this.player, e = p.rig.position, D = this.ship.doors;
    for (const name of CHECKPOINT_DOORS) {
      const d = D[name];
      if (!d || d.progress < 0.99) continue;
      const c = d.collider, cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
      if (Math.abs(e.x - cx) > Math.max(1.0, (c.maxX - c.minX) / 2) || Math.abs(e.z - cz) > Math.max(1.0, (c.maxZ - c.minZ) / 2)) continue;
      if (Math.abs(p.feetY - (c.minY ?? 0)) > 1.0) continue;
      if (this._ck.name === name && t - this._ck.t < 25) continue;
      this._ck.name = name; this._ck.t = t;
      this.checkpoint({ d0: 'DESCOMPRESIÓN', bd1: 'COMPUERTA BD-1', qs: 'CUARENTENA B-3', bridge: 'PUENTE DE MANDO' }[name]);
    }
  }

  // ---------------------------------------------------------------------------
  update(dt, t) {
    // Puertas: interpolación con smoothstep; el colisionador se libera al 70 %.
    for (let i = 0; i < this.doorList.length; i++) {
      const d = this.doorList[i];
      if (d.progress === d.target) continue;
      const s = dt * d.speed;
      d.progress = d.target > d.progress ? Math.min(d.target, d.progress + s) : Math.max(d.target, d.progress - s);
      const e = d.progress * d.progress * (3 - 2 * d.progress);
      for (let k = 0; k < d.parts.length; k++) d.parts[k].mesh.position.lerpVectors(d.parts[k].closed, d.parts[k].open, e);
      d.collider.active = d.progress < 0.7;
    }

    const pl = this.player, map = this.ship.hubMap;
    if (pl && map) map.dot.position.set(pl.rig.position.x * map.scale, 0.03, (pl.rig.position.z - map.cz) * map.scale);

    const h = this.hack;
    if (h && h.type === 'timing') {
      h.phase += dt * h.speed * 0.4;
      const f = h.phase - Math.floor(h.phase);
      h.cursor = Math.abs(f * 2 - 1);
      this.hud.setHack(h.cursor, h.center, h.width, h.done, h.rounds);
    } else if (h) {
      const P = h.puzzle;
      if (P.update(dt) === 'timeout') { this.hud.hackFlash(true); this._hackFail(); }
      if (P.version !== h.shown) { h.shown = P.version; this.hud.setXor(P); }
      this.hud.setXorTime(Math.max(0, P.left) / P.time);
    }

    if (!pl || this.state === 'intro' || this.state === 'done') return;
    if (!this.flags.labSeen && pl.rig.position.z < LEVEL.lab.z0 - 0.6) {
      this.flags.labSeen = true;
      if (this.music) this.music.discover();
      this.hud.toast('LABORATORIO B-3 — PROYECTO HELIX-ARES');
    }
    if (pl.moveEnabled && !pl.dead) this._checkpoints(t);

    if (this.state === 'alert') {
      for (const b of this.ship.beacons) {
        b.spin.rotation.y += dt * 4.2;
        const u = b.beamMat.uniforms.uPower;
        u.value = Math.min(1, u.value + dt);
      }
      if (this._d0Timer > 0) {
        this._d0Timer -= dt;
        if (this._d0Timer <= 0) {
          this.ship.terminals.power.draw('DESCOMPRESIÓN', 'EN LÍNEA', '#5aff8a');
          this.openDoor(this.ship.doors.d0);
          this._obj('Embarque en la cápsula — Esclusa 2');
        }
      }
      if (pl.inventory.has('maletin') && pl.rig.position.z > LEVEL.hatchZ + 0.7) this._finish();
    }
  }

  _finish() {
    this.state = 'done';
    this.synth.stopAlarm();
    if (this.sound) this.sound.setKindActivity('siren', 0);
    this.synth.dock();
    this.player.finish();
    this.hud.setAlert(false);
    this.hud.showEnd();
    Save.clear();
  }
}
