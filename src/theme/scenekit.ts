// Общее для сцен: окружение кадра, сигнал монитора, шум, цвета, зоны окна.

export interface Env {
  t: number; dt: number; w: number; h: number;
  mx: number; my: number; mouse: boolean;
  /** Последний щелчок внутри холста: где, сколько секунд назад, его номер. */
  click: { x: number; y: number; age: number; id: number } | null;
  /** След курсора за ~1 с: x, y, возраст (с). */
  trail: [number, number, number][];
  alarm: boolean; small: boolean; accent: string;
  /** Трафик 0…1 (логарифм скорости), задержка, мс. */
  load: number; ms: number | null;
}
export interface Scene {
  fps: number;
  /** Доля разрешения (мягкие сцены рисуются мельче). */
  scale: number;
  /** Насколько приглушить центр окна, где текст (0…1). */
  protect: number;
  init(w: number, h: number, small: boolean): any;
  draw(ctx: CanvasRenderingContext2D, s: any, e: Env): void;
  /** Отклик на курсор и щелчок — поверх, центр окна его не приглушает. */
  fx?(ctx: CanvasRenderingContext2D, s: any, e: Env): void;
}

// ─── Сигнал от монитора: трафик и задержка ───────────────────────

export const sig = { load: 0, ms: null as number | null, rate: 0, bytes: 0, at: 0 };
/** Трафик (байт/с) и задержка — сцены отвечают на них (пакеты, помехи, цифры). */
export function feedScene(rx: number, tx: number, ms: number | null) {
  const now = performance.now();
  // Сколько прошло за сеанс окна — «монетки» Питомца, «шаги» Виджетов.
  if (sig.at) sig.bytes += sig.rate * Math.min(10, (now - sig.at) / 1000);
  sig.at = now;
  sig.rate = rx + tx;
  sig.load = Math.max(0, Math.min(1, Math.log10(1 + (rx + tx) / 1024) / 4));
  sig.ms = ms;
}
/** Состояние связи окна: online, slow, down, engine_off, starting… */
export const health = () => document.body.dataset.health ?? "online";

// ─── Утилиты ─────────────────────────────────────────────────────

/** Новый щелчок для этого состояния (каждый щелчок — один раз). */
export function newClick(s: any, e: Env, k = "_c") {
  if (!e.click || s[k] === e.click.id) return false;
  s[k] = e.click.id;
  return e.click.age < 0.5;
}

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const easeIO = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash2(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, o = 3) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < o; i++) { s += a * noise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s / (1 - 0.5 ** o);
}
export const rgba = (r: number, g: number, b: number, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${clamp(a, 0, 1).toFixed(3)})`;
export function hex(c: string): [number, number, number] {
  const m = c.trim().match(/^#?([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const r = c.match(/[\d.]+/g)?.map(Number) ?? [155, 107, 255];
  return [r[0], r[1], r[2]];
}
export type RGB = readonly [number, number, number];
/** Светящаяся точка (аддитивно). */
export function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: RGB, a: number, core = 1) {
  if (a <= 0.01 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(255, 255, 255, a * core));
  g.addColorStop(0.2, rgba(c[0], c[1], c[2], a * 0.8));
  g.addColorStop(1, rgba(c[0], c[1], c[2], 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}
/** Гладкий замкнутый контур (Катмулл–Ром) по точкам в единичных координатах. */
export function smoothPath(pts: number[][], sx: number, sy: number, ox: number, oy: number) {
  const p = new Path2D(), n = pts.length;
  const P = (i: number) => pts[(i + n) % n];
  p.moveTo(ox + P(0)[0] * sx, oy + P(0)[1] * sy);
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    p.bezierCurveTo(
      ox + (p1[0] + (p2[0] - p0[0]) / 6) * sx, oy + (p1[1] + (p2[1] - p0[1]) / 6) * sy,
      ox + (p2[0] - (p3[0] - p1[0]) / 6) * sx, oy + (p2[1] - (p3[1] - p1[1]) / 6) * sy,
      ox + p2[0] * sx, oy + p2[1] * sy);
  }
  p.closePath();
  return p;
}
/** Точки сглаженного замкнутого контура (для 3D-преобразований). */
export function smoothPts(pts: number[][], k = 4): [number, number][] {
  const out: [number, number][] = [], n = pts.length;
  const P = (i: number) => pts[(i + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}
export type Poly = [number, number][];
export function splitPoly(p: Poly, x0: number, y0: number, nx: number, ny: number): [Poly, Poly] {
  const a: Poly = [], b: Poly = [];
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    const d1 = (x1 - x0) * nx + (y1 - y0) * ny, d2 = (x2 - x0) * nx + (y2 - y0) * ny;
    (d1 >= 0 ? a : b).push([x1, y1]);
    if ((d1 >= 0) !== (d2 >= 0)) {
      const k = d1 / (d1 - d2);
      const q: [number, number] = [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k];
      a.push(q); b.push(q);
    }
  }
  return [a, b];
}
export let scanPat: HTMLCanvasElement | null = null;
/** Строки развёртки одним узором (дешевле сотен fillRect). */
export function scanlines(ctx: CanvasRenderingContext2D, w: number, h: number, a: number) {
  if (!scanPat) { scanPat = document.createElement("canvas"); scanPat.width = 1; scanPat.height = 3; const g = scanPat.getContext("2d")!; g.fillStyle = "#000"; g.fillRect(0, 0, 1, 1); }
  const pat = ctx.createPattern(scanPat, "repeat");
  if (!pat) return;
  ctx.globalAlpha = a; ctx.fillStyle = pat; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1;
}
export const area = (p: Poly) => Math.abs(p.reduce((s, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
/** Пустая зона окна под навигацией (x, y, ширина, высота). */
export function sideZone(e: { w: number; h: number }) {
  const nav = document.documentElement.dataset.nav ?? "side";
  const sw = Number(document.documentElement.dataset.sidew) || 220;
  // Меню сверху или доком — вся левая колонка свободна.
  if (nav === "top" || nav === "dock") return { x: 16, y: 62, w: sw - 24, h: Math.max(120, e.h - 62 - 18) };
  const y = Math.min(380, e.h * 0.47);
  return { x: 16, y, w: sw - 24, h: Math.max(120, e.h - y - 66) };
}
/** Пиксельный текст: рисуется мелко и растягивается без сглаживания. */
export const pixCache = new Map<string, HTMLCanvasElement>();
export function pixText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string, k = 2) {
  const key = `${text}|${px}|${color}`;
  let c = pixCache.get(key);
  if (!c) {
    c = document.createElement("canvas");
    const m = c.getContext("2d")!;
    m.font = `bold ${px}px Consolas, monospace`;
    c.width = Math.ceil(m.measureText(text).width) + 2; c.height = Math.ceil(px * 1.3);
    m.font = `bold ${px}px Consolas, monospace`;
    m.fillStyle = color; m.textBaseline = "top";
    m.fillText(text, 1, 0);
    if (pixCache.size > 300) pixCache.clear();
    pixCache.set(key, c);
  }
  const sm = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, x, y, c.width * k, c.height * k);
  ctx.imageSmoothingEnabled = sm;
  return c.width * k;
}
/** Текст с разносом каналов (красный/бирюзовый). */
export function rgbText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, off: number, a = 1) {
  ctx.fillStyle = rgba(255, 40, 60, 0.75 * a); ctx.fillText(text, x - off, y);
  ctx.fillStyle = rgba(40, 230, 230, 0.75 * a); ctx.fillText(text, x + off, y);
  ctx.fillStyle = rgba(255, 255, 255, a); ctx.fillText(text, x, y);
}

/** Куда смотрят глаза: смещение зрачка к курсору (−1…1 по осям), без курсора — `idle`. */
export function look(e: Env, x: number, y: number, reach = 260, idle: [number, number] = [0, 0]): [number, number] {
  if (!e.mouse) return idle;
  const dx = e.mx - x, dy = e.my - y, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / reach);
  return [(dx / d) * k, (dy / d) * k];
}
/** Пиксельный спрайт из строк: «X» — цвет `c`, «o» — цвет `c2`, остальное пусто. */
export function sprite(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, px: number, c: string, c2 = c, flip = false) {
  const W = rows[0].length;
  for (let j = 0; j < rows.length; j++) for (let i = 0; i < W; i++) {
    const ch = rows[j][flip ? W - 1 - i : i];
    if (ch !== "X" && ch !== "o") continue;
    ctx.fillStyle = ch === "X" ? c : c2;
    ctx.fillRect(Math.round(x + i * px), Math.round(y + j * px), Math.ceil(px), Math.ceil(px));
  }
}
/** Линия «от руки»: ломаная с дрожью, `seed` меняется — линия «кипит». */
export function handLine(ctx: CanvasRenderingContext2D, pts: number[][], jit: number, seed: number) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const jx = (hash2(i * 7 + seed, 3) - 0.5) * jit, jy = (hash2(i * 13 + seed, 5) - 0.5) * jit;
    if (i) ctx.lineTo(x + jx, y + jy); else ctx.moveTo(x + jx, y + jy);
  });
}
/** Отпечаток лапки. */
export function pawPrint(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath(); ctx.ellipse(x, y + s * 0.3, s * 0.55, s * 0.45, 0, 0, TAU); ctx.fill();
  for (const [dx, dy] of [[-0.55, -0.35], [-0.2, -0.7], [0.2, -0.7], [0.55, -0.35]]) { ctx.beginPath(); ctx.ellipse(x + dx * s, y + dy * s, s * 0.17, s * 0.22, 0, 0, TAU); ctx.fill(); }
}
/** Частицы: шаг, затухание, отрисовка; возвращает живые. */
export function particles<P extends { t: number; life: number }>(list: P[], t: number, draw: (p: P, a: number) => void) {
  const out = list.filter((p) => t - p.t < p.life);
  for (const p of out) draw(p, 1 - (t - p.t) / p.life);
  return out;
}
/** Мини-зона выреза: справа снизу у открытой панели, справа — у закрытой. */
export function notchBox(w: number, h: number, bw = 64, bh = 104) {
  // Открытая панель: только нижний правый угол — под подписями маршрута.
  if (h > 80) { const k = Math.min(1, 62 / bh); return { x: w - bw * k - 8, y: h - bh * k - 8, w: bw * k, h: bh * k }; }
  return { x: w - bw * 0.9, y: 2, w: bw * 0.85, h: h - 4 };
}
