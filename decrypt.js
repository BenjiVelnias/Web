// =============================================================================
// decrypt.js
// Descifrado lógico XOR para compuertas de seguridad avanzada.
// El registro de 8 bits debe igualar al objetivo combinando claves con XOR
// (teclas 1-4; cada clave es su propia inversa: pulsarla otra vez la deshace).
// Cada ronda tiene tiempo límite; agotarlo cuesta un acierto y baraja el
// problema. La solución existe siempre: objetivo = registro ⊕ (subconjunto).
// =============================================================================

export class XorPuzzle {
  constructor(rounds, time) {
    this.rounds = rounds;
    this.time = time;
    this.done = 0;
    this.keys = [0, 0, 0, 0];
    this.used = [false, false, false, false];
    this.reg = 0;
    this.target = 0;
    this.left = time;
    this.version = 0; // cambia cuando el HUD debe redibujar los bits
    this.shuffle();
  }

  shuffle() {
    const rnd = () => 1 + Math.floor(Math.random() * 255);
    for (let i = 0; i < 4; i++) {
      let k;
      do { k = rnd(); } while (this.keys.indexOf(k) !== -1 && this.keys.indexOf(k) < i);
      this.keys[i] = k;
      this.used[i] = false;
    }
    this.reg = Math.floor(Math.random() * 256);
    // Subconjunto de 2 o 3 claves (más claves en rondas avanzadas).
    const n = this.done >= 2 ? 3 : 2, pick = [0, 1, 2, 3].sort(() => Math.random() - 0.5).slice(0, n);
    let t = this.reg;
    for (const i of pick) t ^= this.keys[i];
    if (t === this.reg) t ^= this.keys[pick[0]];
    this.target = t;
    this.left = Math.max(5, this.time - this.done * 1.2);
    this.version++;
  }

  // Devuelve 'ok' si la ronda se resolvió, 'done' si se completó el descifrado.
  toggle(i) {
    if (i < 0 || i > 3) return null;
    this.reg ^= this.keys[i];
    this.used[i] = !this.used[i];
    this.version++;
    if (this.reg !== this.target) return null;
    this.done++;
    if (this.done >= this.rounds) return 'done';
    this.shuffle();
    return 'ok';
  }

  // Devuelve 'timeout' cuando se agota el tiempo de la ronda.
  update(dt) {
    this.left -= dt;
    if (this.left > 0) return null;
    this.done = Math.max(0, this.done - 1);
    this.shuffle();
    return 'timeout';
  }
}
