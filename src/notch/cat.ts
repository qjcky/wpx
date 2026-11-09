// Маскот wpx — чёрный пиксельный кот. В вырезе он вместо кружка состояния:
// контур и глаза — цвета состояния, а по позе видно, что со связью.
//   online      — глаза открыты, хвост покачивается, иногда моргает;
//   slow        — сонные полуприкрытые глаза, хвост вяло дёргается;
//   down        — глаза-крестики, уши прижаты, хвост трубой, вздрагивает;
//   engine_off  — спит: «— —», над головой всплывают «z»;
//   starting    — глаза бегают туда-сюда: проверяем.
// Рисуется по клеткам на canvas (8 кадров/с, стоп при скрытом окне).

import type { Health } from "../core/types";

export type Mood = "ok" | "slow" | "down" | "sleep" | "look";
export const moodOf = (h: Health): Mood =>
  h === "online" ? "ok" : h === "slow" ? "slow" : h === "down" ? "down" : h === "engine_off" ? "sleep" : "look";

const W = 28, H = 13;
type Row = [number, number, number]; // строка, от, до

// Лежащий кот, голова справа: заполненные клетки тела.
const BODY: Row[] = [[4, 11, 22], [5, 9, 22], [6, 7, 22], [7, 6, 22], [8, 6, 22], [9, 6, 22], [10, 6, 22], [11, 7, 21]];
const EARS: Record<"up" | "flat", Row[]> = {
  up: [[1, 13, 13], [1, 21, 21], [2, 13, 14], [2, 20, 21], [3, 12, 15], [3, 19, 22]],
  flat: [[3, 11, 15], [3, 19, 23]],
};
// Кончик хвоста: опущен, полуподнят, поднят.
const TAIL: Row[][] = [
  [[9, 1, 5], [10, 1, 5]],
  [[7, 2, 3], [8, 2, 4], [9, 2, 5], [10, 3, 5]],
  [[5, 3, 4], [6, 2, 4], [7, 2, 4], [8, 3, 5], [9, 4, 5], [10, 4, 5]],
];
const Z = ["####", "..#.", ".#..", "####"];

type Cell = "b" | "o" | "e" | "i" | "z";

function sprite(mood: Mood, t: number, blink: boolean): Map<number, Cell> {
  const m = new Map<number, Cell>();
  const key = (x: number, y: number) => y * W + x;
  const fill = (rows: Row[]) => { for (const [y, a, b] of rows) for (let x = a; x <= b; x++) m.set(key(x, y), "b"); };
  fill(BODY);
  fill(mood === "down" ? EARS.flat : EARS.up);
  const tail = mood === "ok" ? [0, 1, 2, 1][Math.floor(t * 1.6) % 4]
    : mood === "slow" ? (t % 3.2 < 0.5 ? 1 : 0)
    : mood === "down" ? 2
    : mood === "look" ? [0, 1][Math.floor(t * 2) % 2] : 0;
  fill(TAIL[tail]);
  // Контур — клетки вокруг тела (по восьми соседям).
  const body = [...m.keys()];
  for (const k of body) {
    const x = k % W, y = (k / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!m.has(key(nx, ny))) m.set(key(nx, ny), "o");
    }
  }
  if (mood !== "down") { m.set(key(13, 3), "i"); m.set(key(14, 3), "i"); m.set(key(13, 2), "i"); m.set(key(20, 3), "i"); m.set(key(21, 3), "i"); m.set(key(21, 2), "i"); }
  const put = (cells: [number, number][]) => { for (const [x, y] of cells) m.set(key(x, y), "e"); };
  if (mood === "down") {
    // Глаза-крестики.
    for (const cx of [14, 20]) put([[cx - 1, 6], [cx + 1, 6], [cx, 7], [cx - 1, 8], [cx + 1, 8]]);
  } else if (mood === "sleep" || mood === "slow" || blink) {
    // Закрытые (спит, моргнул) или сонные — полоски; сонные чуть выше и короче.
    const w = mood === "slow" && !blink ? 2 : 3;
    put(Array.from({ length: w }, (_, i) => [16 - w + i, 8] as [number, number]));
    put(Array.from({ length: w }, (_, i) => [19 + i, 8] as [number, number]));
    if (mood === "slow" && !blink) put([[15, 7], [19, 7]]);
  } else {
    const off = mood === "look" ? [0, -1, -1, 0, 1, 1][Math.floor(t * 2.5) % 6] : 0;
    put([[14 + off, 7], [15 + off, 7], [14 + off, 8], [15 + off, 8], [19 + off, 7], [20 + off, 7], [19 + off, 8], [20 + off, 8]]);
  }
  if (mood === "sleep") {
    // «z» всплывает над головой и гаснет.
    const p = (t * 0.5) % 1, ox = 24, oy = Math.round(3 - p * 3);
    if (p < 0.85) Z.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#" && oy + y >= 0 && ox + x < W) m.set(key(ox + x, oy + y), "z"); }));
  }
  return m;
}

function rgb(c: string): [number, number, number] {
  c = c.trim();
  if (c.startsWith("#") && c.length >= 7) { const n = parseInt(c.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const v = (c.match(/[\d.]+/g) ?? ["148", "163", "184"]).map(Number);
  return [v[0], v[1], v[2]];
}
const mixW = (c: [number, number, number], k: number) => `rgb(${c.map((v) => Math.round(v + (255 - v) * k)).join(",")})`;

export interface Cat { set(mood: Mood): void }

/** Кот на canvas: `px` — размер клетки в CSS-пикселях. */
export function mountCat(canvas: HTMLCanvasElement, px: number): Cat {
  const ctx = canvas.getContext("2d")!;
  let mood: Mood = "look", raf = 0, last = 0, nextBlink = 2, blinkUntil = 0, shake = 0;
  const t0 = performance.now();
  const motion = () => {
    const m = document.documentElement.dataset.motion;
    return m === "on" || (m !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };
  const size = () => {
    const dpr = window.devicePixelRatio || 1;
    const cell = Math.max(1, Math.round(px * dpr));
    if (canvas.width !== W * cell) { canvas.width = W * cell; canvas.height = H * cell; }
    canvas.style.width = `${(W * cell) / dpr}px`;
    canvas.style.height = `${(H * cell) / dpr}px`;
    return cell;
  };
  const draw = (t: number) => {
    const cell = size();
    if (mood === "ok" && t > nextBlink) { blinkUntil = t + 0.14; nextBlink = t + 2.5 + Math.random() * 3.5; }
    if (mood === "down" && Math.random() < 0.18) shake = shake ? 0 : 1;
    else if (mood !== "down") shake = 0;
    const st = rgb(getComputedStyle(document.body).getPropertyValue("--state") || "#94a3b8");
    const col: Record<Cell, string> = {
      b: "#000", o: mixW(st, mood === "sleep" ? 0.15 : 0.4), e: mood === "sleep" ? "rgba(255,255,255,.6)" : mixW(st, 0.1),
      i: mixW(st, 0.55), z: "rgba(255,255,255,.7)",
    };
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const [k, c] of sprite(mood, t, t < blinkUntil)) {
      ctx.fillStyle = col[c];
      ctx.fillRect(((k % W) + shake) * cell, ((k / W) | 0) * cell, cell, cell);
    }
  };
  const loop = (now: number) => {
    raf = 0;
    if (document.visibilityState !== "visible") return;
    if (now - last >= 120) { last = now; draw(Math.max(0, (now - t0) / 1000)); }
    if (motion()) raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (motion()) { if (!raf) raf = requestAnimationFrame(loop); } else draw(1); };
  document.addEventListener("visibilitychange", kick);
  kick();
  return {
    set(m) { if (m === mood) return; mood = m; last = 0; kick(); draw((performance.now() - t0) / 1000); },
  };
}
