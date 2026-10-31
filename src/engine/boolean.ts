import type { Point } from './viewport';

/**
 * Operaciones entre regiones (soldar, recortar, intersectar, contorno).
 *
 * Método: "arreglo de segmentos".
 *  1. Se juntan los bordes de todas las regiones y se cortan donde se cruzan
 *     (con una malla para no comparar todos contra todos). Las coordenadas se
 *     redondean a 1 micra: así los puntos casi iguales se vuelven iguales y los
 *     bordes compartidos o superpuestos no dan problemas.
 *  2. De cada trocito se cuenta, de forma exacta, cuántas vueltas da cada región
 *     a su izquierda y a su derecha: si un lado queda dentro del resultado y el
 *     otro fuera, ese trocito es borde del resultado.
 *  3. Los trocitos que quedan se enlazan en anillos cerrados.
 *
 * Es simple y robusto con bordes que se tocan, se superponen o se cruzan; la
 * precisión (1 micra) sobra para imprimir.
 */

export type Ring = Point[];

/**
 * Región: anillos con su regla de relleno. Par-impar, distinto de cero, o
 * "positiva" (solo cuenta lo que gira en un sentido; la usa el contorno).
 */
export interface Region {
  rings: Ring[];
  rule: 'evenodd' | 'nonzero' | 'positive';
}

/** Decide si un punto está en el resultado, a partir de si está dentro de cada región (perezoso: solo calcula lo que pregunta). */
export type Predicate = (inside: (region: number) => boolean) => boolean;

export const UNION: Predicate = (inside) => inside(0) || inside(1);
export const INTERSECTION: Predicate = (inside) => inside(0) && inside(1);
export const DIFFERENCE: Predicate = (inside) => inside(0) && !inside(1);

const GRID = 1e-3; // 1 micra

interface Seg {
  region: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Puntos de corte a lo largo del segmento (parámetro t y punto entero). */
  cuts: Array<{ t: number; x: number; y: number }>;
}

/**
 * Calcula el resultado de una operación. Devuelve anillos con la regla
 * par-impar (los huecos son anillos dentro de otros).
 */
export function booleanOp(regions: Region[], predicate: Predicate): Ring[] {
  // ---- 1. Bordes en enteros (micras), relativos a la esquina de todo ----
  let minX = Infinity;
  let minY = Infinity;
  for (const r of regions) for (const ring of r.rings) for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
  }
  if (!Number.isFinite(minX)) return [];
  const toInt = (v: number, o: number) => Math.round((v - o) / GRID);
  const segs: Seg[] = [];
  regions.forEach((r, region) => {
    for (const ring of r.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const s = { region, ax: toInt(a.x, minX), ay: toInt(a.y, minY), bx: toInt(b.x, minX), by: toInt(b.y, minY), cuts: [] };
        if (s.ax !== s.bx || s.ay !== s.by) segs.push(s);
      }
    }
  });
  if (segs.length === 0) return [];

  // ---- 2. Cruces, con una malla ----
  findIntersections(segs);

  // ---- 3. Trocitos únicos (con cuánto aporta cada región al cruzarlos) ----
  const byKey = new Map<string, Piece>();
  for (const s of segs) {
    const pts = [{ t: 0, x: s.ax, y: s.ay }, ...s.cuts, { t: 1, x: s.bx, y: s.by }].sort((p, q) => p.t - q.t);
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      if (p.x === q.x && p.y === q.y) continue;
      // Sentido canónico: del punto menor al mayor. El borde original suma +1 si va igual, −1 si va al revés.
      const forward = p.x < q.x || (p.x === q.x && p.y < q.y);
      const key = forward ? `${p.x},${p.y},${q.x},${q.y}` : `${q.x},${q.y},${p.x},${p.y}`;
      let piece = byKey.get(key);
      if (!piece) {
        piece = forward ? { ax: p.x, ay: p.y, bx: q.x, by: q.y, contrib: [] } : { ax: q.x, ay: q.y, bx: p.x, by: p.y, contrib: [] };
        byKey.set(key, piece);
      }
      const c = piece.contrib.find((x) => x.region === s.region);
      if (c) {
        c.w += forward ? 1 : -1;
        c.n += 1;
      } else piece.contrib.push({ region: s.region, w: forward ? 1 : -1, n: 1 });
    }
  }
  const pieces = [...byKey.values()];

  // ---- 4. Clasificar cada trocito de forma exacta ----
  // Se cuentan las vueltas con un rayo desde el punto medio del trocito sobre los
  // demás trocitos (enteros: sin márgenes ni errores de redondeo).
  const index = new RayIndex(pieces);
  const rules = regions.map((r) => r.rule);
  const kept: Array<[number, number, number, number]> = [];
  for (const piece of pieces) {
    const side = index.sides(piece, regions.length);
    const decide = (w: Int32Array, n: Int32Array) =>
      predicate((r) => {
        const rule = rules[r];
        if (rule === undefined) return false;
        return rule === 'evenodd' ? (n[r]! & 1) === 1 : rule === 'nonzero' ? w[r] !== 0 : w[r]! > 0;
      });
    const left = decide(side.leftW, side.leftN);
    const right = decide(side.rightW, side.rightN);
    if (left === right) continue;
    kept.push(left ? [piece.ax, piece.ay, piece.bx, piece.by] : [piece.bx, piece.by, piece.ax, piece.ay]);
  }

  // ---- 5. Enlazar en anillos ----
  return linkRings(kept).map((ring) => ring.map(([x, y]) => ({ x: x * GRID + minX, y: y * GRID + minY })));
}

interface Piece {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Por región: suma de sentidos (w) y cuántos bordes originales lo cubren (n). */
  contrib: Array<{ region: number; w: number; n: number }>;
}

/**
 * Cuenta vueltas con rayos sobre los trocitos. Rayo hacia +x desde el punto medio
 * (o hacia +y si el trocito es horizontal), con la regla del medio abierto en
 * los vértices. Todo en el doble de las coordenadas enteras: el punto medio
 * también es entero.
 */
class RayIndex {
  private readonly rows = new Map<number, Piece[]>();
  private readonly cols = new Map<number, Piece[]>();
  private readonly size: number;

  constructor(pieces: Piece[]) {
    // Celdas de unas pocas veces el trocito típico.
    const avg = pieces.reduce((t, p) => t + Math.abs(p.bx - p.ax) + Math.abs(p.by - p.ay), 0) / Math.max(1, pieces.length);
    this.size = Math.max(2, Math.round(avg * 4));
    for (const p of pieces) {
      for (let r = this.cell(Math.min(p.ay, p.by) * 2); r <= this.cell(Math.max(p.ay, p.by) * 2); r++) push(this.rows, r, p);
      for (let c = this.cell(Math.min(p.ax, p.bx) * 2); c <= this.cell(Math.max(p.ax, p.bx) * 2); c++) push(this.cols, c, p);
    }
  }

  private cell(v2: number): number {
    return Math.floor(v2 / (this.size * 2));
  }

  /** Vueltas (w) y cruces (n) por región a la izquierda y a la derecha del trocito (en su sentido canónico). */
  sides(piece: Piece, regionCount: number): { leftW: Int32Array; leftN: Int32Array; rightW: Int32Array; rightN: Int32Array } {
    const mx = piece.ax + piece.bx; // doble del punto medio
    const my = piece.ay + piece.by;
    const w = new Int32Array(regionCount);
    const n = new Int32Array(regionCount);
    const horizontal = piece.ay === piece.by;
    if (!horizontal) {
      // Rayo hacia +x: cruza los trocitos cuyo rango en y (medio abierto) contiene my.
      for (const q of this.rows.get(this.cell(my)) ?? []) {
        if (q === piece) continue;
        const y0 = q.ay * 2;
        const y1 = q.by * 2;
        if (y0 > my === y1 > my) continue;
        // x del trocito a la altura my, comparado con mx sin dividir.
        const num = (my - y0) * (q.bx - q.ax) * 2 + q.ax * 2 * (y1 - y0);
        const den = y1 - y0;
        if ((den > 0 ? num > mx * den : num < mx * den)) {
          const up = q.by > q.ay ? 1 : -1;
          for (const c of q.contrib) {
            w[c.region]! += c.w * up;
            n[c.region]! += c.n;
          }
        }
      }
    } else {
      // Trocito horizontal: rayo hacia +y. Cuenta +1 lo que va hacia −x (mismo sentido que el rayo +x).
      for (const q of this.cols.get(this.cell(mx)) ?? []) {
        if (q === piece) continue;
        const x0 = q.ax * 2;
        const x1 = q.bx * 2;
        if (x0 > mx === x1 > mx) continue;
        const num = (mx - x0) * (q.by - q.ay) * 2 + q.ay * 2 * (x1 - x0);
        const den = x1 - x0;
        if ((den > 0 ? num > my * den : num < my * den)) {
          const dir = q.bx < q.ax ? 1 : -1;
          for (const c of q.contrib) {
            w[c.region]! += c.w * dir;
            n[c.region]! += c.n;
          }
        }
      }
    }
    // Del lado del rayo (+x o +y) al otro lado del trocito: cambia en lo que aporta el propio trocito.
    const other = new Int32Array(w);
    const otherN = new Int32Array(n);
    const factor = horizontal ? (piece.bx > piece.ax ? -1 : 1) : piece.by > piece.ay ? 1 : -1;
    for (const c of piece.contrib) {
      other[c.region]! += c.w * factor;
      otherN[c.region]! += c.n;
    }
    // ¿El lado del rayo es la izquierda del trocito (normal (−dy, dx))?
    const rayIsLeft = horizontal ? piece.bx > piece.ax : piece.by < piece.ay;
    return rayIsLeft ? { leftW: w, leftN: n, rightW: other, rightN: otherN } : { leftW: other, leftN: otherN, rightW: w, rightN: n };
  }
}

function push(map: Map<number, Piece[]>, key: number, p: Piece): void {
  const list = map.get(key);
  if (list) list.push(p);
  else map.set(key, [p]);
}

function findIntersections(segs: Seg[]): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let total = 0;
  for (const s of segs) {
    minX = Math.min(minX, s.ax, s.bx);
    minY = Math.min(minY, s.ay, s.by);
    maxX = Math.max(maxX, s.ax, s.bx);
    maxY = Math.max(maxY, s.ay, s.by);
    total += Math.abs(s.bx - s.ax) + Math.abs(s.by - s.ay);
  }
  // Celdas del tamaño de unos pocos segmentos promedio.
  const cell = Math.max(1, (total / segs.length) * 2, Math.max(maxX - minX, maxY - minY) / 512);
  const cols = Math.max(1, Math.ceil((maxX - minX + 1) / cell));
  const grid = new Map<number, number[]>();
  segs.forEach((s, i) => {
    const c0 = Math.floor((Math.min(s.ax, s.bx) - minX) / cell);
    const c1 = Math.floor((Math.max(s.ax, s.bx) - minX) / cell);
    const r0 = Math.floor((Math.min(s.ay, s.by) - minY) / cell);
    const r1 = Math.floor((Math.max(s.ay, s.by) - minY) / cell);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
  });
  const tested = new Int32Array(segs.length).fill(-1);
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      const i = list[a]!;
      for (let b = a + 1; b < list.length; b++) {
        const j = list[b]!;
        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        // Cada par se prueba una sola vez aunque compartan varias celdas.
        if (tested[hi] === lo) continue;
        tested[hi] = lo;
        intersect(segs[lo]!, segs[hi]!);
      }
    }
  }
}

function intersect(s: Seg, o: Seg): void {
  // Descarte rápido por cajas
  if (Math.max(s.ax, s.bx) < Math.min(o.ax, o.bx) || Math.max(o.ax, o.bx) < Math.min(s.ax, s.bx)) return;
  if (Math.max(s.ay, s.by) < Math.min(o.ay, o.by) || Math.max(o.ay, o.by) < Math.min(s.ay, s.by)) return;
  const rx = s.bx - s.ax;
  const ry = s.by - s.ay;
  const qx = o.bx - o.ax;
  const qy = o.by - o.ay;
  const den = rx * qy - ry * qx;
  const wx = o.ax - s.ax;
  const wy = o.ay - s.ay;
  if (den !== 0) {
    const t = (wx * qy - wy * qx) / den;
    const u = (wx * ry - wy * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return;
    const x = Math.round(s.ax + t * rx);
    const y = Math.round(s.ay + t * ry);
    if (t > 0 && t < 1) s.cuts.push({ t, x, y });
    if (u > 0 && u < 1) o.cuts.push({ t: u, x, y });
    return;
  }
  // Paralelos: solo importa si están sobre la misma recta (se superponen).
  if (wx * ry - wy * rx !== 0) return;
  const rr = rx * rx + ry * ry;
  const qq = qx * qx + qy * qy;
  // Extremos de cada uno que caen dentro del otro → cortes.
  for (const [px, py] of [[o.ax, o.ay], [o.bx, o.by]] as const) {
    const t = ((px - s.ax) * rx + (py - s.ay) * ry) / rr;
    if (t > 0 && t < 1) s.cuts.push({ t, x: px, y: py });
  }
  for (const [px, py] of [[s.ax, s.ay], [s.bx, s.by]] as const) {
    const t = ((px - o.ax) * qx + (py - o.ay) * qy) / qq;
    if (t > 0 && t < 1) o.cuts.push({ t, x: px, y: py });
  }
}

/** Une los bordes orientados en anillos. En un vértice con varias salidas, toma el giro más cerrado. */
function linkRings(edges: Array<[number, number, number, number]>): Array<Array<[number, number]>> {
  const out = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const k = `${e[0]},${e[1]}`;
    const list = out.get(k);
    if (list) list.push(i);
    else out.set(k, [i]);
  });
  const used = new Uint8Array(edges.length);
  const rings: Array<Array<[number, number]>> = [];
  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const ring: Array<[number, number]> = [];
    let current = start;
    for (let guard = 0; guard <= edges.length; guard++) {
      used[current] = 1;
      const [ax, ay, bx, by] = edges[current]!;
      ring.push([ax, ay]);
      const candidates = (out.get(`${bx},${by}`) ?? []).filter((i) => !used[i]);
      if (candidates.length === 0) break;
      // Ángulo de giro respecto de la dirección actual; se elige el más a la derecha.
      const dirIn = Math.atan2(by - ay, bx - ax);
      let best = candidates[0]!;
      let bestTurn = Infinity;
      for (const i of candidates) {
        const e = edges[i]!;
        let turn = Math.atan2(e[3] - e[1], e[2] - e[0]) - dirIn;
        while (turn <= -Math.PI) turn += Math.PI * 2;
        while (turn > Math.PI) turn -= Math.PI * 2;
        if (turn < bestTurn) {
          bestTurn = turn;
          best = i;
        }
      }
      current = best;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings.filter((r) => Math.abs(signedArea(r)) > 1); // > 1 micra² (restos del redondeo)
}

function signedArea(ring: Array<[number, number]> | Point[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const [px, py] = Array.isArray(p) ? p : [p.x, p.y];
    const [qx, qy] = Array.isArray(q) ? q : [q.x, q.y];
    a += px * qy - qx * py;
  }
  return a / 2;
}

export const ringArea = (ring: Ring) => signedArea(ring);

// ---- Contorno (desplazar el borde) ----

/**
 * Contorno exterior (la región engordada) o interior (adelgazada), con
 * esquinas redondas. Técnica estándar (la de Clipper):
 *  1. Se limpia la región: anillos sin cruces, con el relleno siempre a la izquierda.
 *  2. Cada borde se desplaza `distance` hacia afuera (o adentro); en las esquinas
 *     que se abren se pone un arco, en las que se cierran se pasa por el vértice.
 *  3. Se resuelven los cruces quedándose con lo que gira en sentido positivo.
 */
export function offsetRegion(region: Region, distance: number, direction: 'outside' | 'inside', simplifyTolerance = 0.01): Ring[] {
  const d = Math.abs(distance);
  const clean = booleanOp([region], (inside) => inside(0)).map((r) => simplifyRing(r, simplifyTolerance));
  if (direction === 'outside') return grow(clean, d);
  // Interior: se engorda el "espacio de alrededor" (un marco menos la figura) y se le
  // resta a la figura. Así un contorno más grueso que la figura no deja nada.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of clean) for (const p of r) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return [];
  const m = d * 2 + 1;
  const frame: Ring = [{ x: minX - m, y: minY - m }, { x: maxX + m, y: minY - m }, { x: maxX + m, y: maxY + m }, { x: minX - m, y: maxY + m }];
  const outside = booleanOp([{ rings: [frame, ...clean], rule: 'evenodd' }], (inside) => inside(0));
  return booleanOp([{ rings: clean, rule: 'evenodd' }, { rings: grow(outside, d), rule: 'evenodd' }], DIFFERENCE);
}

/** Engorda anillos limpios (relleno a la izquierda) `d` mm hacia afuera. */
function grow(clean: Ring[], d: number): Ring[] {
  const raw = rawOffset(clean, d);
  if (raw.length === 0) return [];
  return resolveOffset(raw, clean, d);
}

/** Bordes desplazados `d` mm hacia afuera, con arcos en las esquinas que se abren (sin resolver cruces). */
export function rawOffset(clean: Ring[], d: number): Ring[] {
  const sign = 1;
  const STEP = Math.PI / 18; // arcos cada 10°: error < 0.4 % de la distancia
  const raw: Ring[] = [];
  for (const ring of clean) {
    const n = ring.length;
    if (n < 3) continue;
    // Direcciones de cada borde y su normal hacia afuera (el relleno está a la izquierda).
    const dirs = ring.map((a, i) => {
      const b = ring[(i + 1) % n]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    });
    const out: Ring = [];
    for (let i = 0; i < n; i++) {
      const v = ring[i]!;
      const e1 = dirs[(i - 1 + n) % n]!;
      const e2 = dirs[i]!;
      const n1 = { x: e1.y * sign, y: -e1.x * sign };
      const n2 = { x: e2.y * sign, y: -e2.x * sign };
      const p1 = { x: v.x + n1.x * d, y: v.y + n1.y * d };
      const p2 = { x: v.x + n2.x * d, y: v.y + n2.y * d };
      const cos = n1.x * n2.x + n1.y * n2.y;
      if (cos > Math.cos(STEP)) {
        // Giro pequeño (tramo de una curva): un solo punto sobre la bisectriz, sin
        // arcos ni rizos (son la mayoría de los vértices de un texto).
        const bx = n1.x + n2.x;
        const by = n1.y + n2.y;
        const blen = Math.hypot(bx, by) || 1;
        const reach = d / Math.sqrt((1 + cos) / 2);
        out.push({ x: v.x + (bx / blen) * reach, y: v.y + (by / blen) * reach });
      } else if (e2.x * n1.x + e2.y * n1.y < 0) {
        // La esquina se abre hacia el lado del desplazamiento: arco redondo.
        const a1 = Math.atan2(n1.y, n1.x);
        let delta = Math.atan2(n2.y, n2.x) - a1;
        while (delta <= -Math.PI) delta += Math.PI * 2;
        while (delta > Math.PI) delta -= Math.PI * 2;
        const steps = Math.max(1, Math.ceil(Math.abs(delta) / STEP));
        for (let k = 0; k <= steps; k++) {
          const angle = a1 + (delta * k) / steps;
          out.push({ x: v.x + Math.cos(angle) * d, y: v.y + Math.sin(angle) * d });
        }
      } else {
        // La esquina se cierra: pasar por el vértice deja un rizo que la regla positiva descarta.
        out.push(p1, { x: v.x, y: v.y }, p2);
      }
    }
    raw.push(out);
  }
  return raw;
}

function resolveOffset(raw: Ring[], clean: Ring[], d: number): Ring[] {
  // Con el relleno a la izquierda, lo que queda dentro del contorno gira en sentido positivo.
  const result = booleanOp([{ rings: raw, rule: 'positive' }], (inside) => inside(0));
  // Un hueco más chico que el doble de la distancia desaparece; pero al desplazarlo
  // "se da vuelta" y puede dejar un hueco falso. Los huecos verdaderos quedan justo
  // a `d` de la figura original; los falsos, más cerca: se quitan.
  const edges: Array<[Point, Point]> = clean.flatMap((r) => r.map((p, i) => [p, r[(i + 1) % r.length]!] as [Point, Point]));
  const distanceToOriginal = (p: Point) => {
    let best = Infinity;
    for (const [a, b] of edges) best = Math.min(best, segmentDistance(p, a, b));
    return best;
  };
  return result.filter((ring) => {
    const area = ringArea(ring);
    if (Math.abs(area) < 0.05) return false; // motas de menos de 0.05 mm²: invisibles al imprimir
    if (area >= 0) return true; // los anillos exteriores siempre valen
    const step = Math.max(1, Math.floor(ring.length / 12));
    let near = 0;
    let total = 0;
    for (let i = 0; i < ring.length; i += step) {
      total++;
      if (distanceToOriginal(ring[i]!) < d * 0.985 - 0.005) near++;
    }
    return near * 2 < total;
  });
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Quita vértices que casi no cambian la forma (anillo cerrado). */
function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4 || tolerance <= 0) return ring;
  const keep: Ring = [];
  let last = ring[ring.length - 1]!;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    const dx = next.x - last.x;
    const dy = next.y - last.y;
    const len = Math.hypot(dx, dy) || 1;
    const dist = Math.abs((p.x - last.x) * dy - (p.y - last.y) * dx) / len;
    if (dist > tolerance) {
      keep.push(p);
      last = p;
    }
  }
  return keep.length >= 3 ? keep : ring;
}
