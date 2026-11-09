// Темы-сцены: живой фон окна и выреза на canvas. Каждая сцена — своя картинка
// и движение; реагирует на курсор, щелчок, трафик и задержку (feedScene), при
// обрыве — тревожные цвета. У каждой свой темп кадров, стоп при скрытом окне;
// анимация выключена — один неподвижный кадр. «Призма» — CSS-грани (theme.ts).
// В окне элементы сцен стоят там, где пусто: под навигацией, по краям, в углах;
// центр под текстом приглушается.

import {
  sig, newClick, TAU, clamp, lerp, easeIO, rng, hash2, noise, fbm, rgba, hex, glow, smoothPath, smoothPts, splitPoly, scanlines, area, sideZone, pixText, rgbText,
  type Env, type Scene, type RGB, type Poly,
} from "./scenekit";
export { feedScene } from "./scenekit";
import { CATS } from "./scenes-cats";
import { COFFEE } from "./scenes-coffee";
import { MEMES } from "./scenes-memes";
import { GADGETS } from "./scenes-gadgets";

export type SceneId =
  | "auto" | "light" | "sepia" | "dark" | "black"
  | "cat" | "ramen" | "sassy" | "focus" | "meh" | "catbox" | "formula" | "overthink"
  | "blob" | "emc2" | "element"
  | "offline" | "deadline" | "cad" | "alive" | "nope"
  | "prism" | "plexus" | "web" | "dispersion" | "rift" | "beam" | "runes"
  | "ascii" | "editor" | "hud" | "glitch" | "nosignal" | "techmark" | "cracked" | "shards" | "hello"
  | "holo" | "anime" | "spectrum" | "poster" | "bloom" | "chill" | "sphere" | "widgets"
  | "retro" | "bekind" | "hex" | "pet";

/** Где меню: слева списком, сверху строкой, доком снизу, узкой полосой значков. */
export type NavLayout = "side" | "top" | "dock" | "rail";
export type SceneGroup = "plain" | "cats" | "coffee" | "memes" | "main" | "tech" | "art" | "retro";
/** `light` — светлая тема: тёмный текст на светлом фоне. */
export interface SceneMeta { id: SceneId; name: string; sub: string; accent: string; bg: string; group: SceneGroup; nav: NavLayout; side?: number; light?: boolean }

export const GROUPS: [SceneGroup, string][] = [["plain", "Простые"], ["cats", "Котики"], ["coffee", "Кофе"], ["memes", "Мемы и мысли"], ["main", "Свет и пространство"], ["tech", "Код и техно"], ["art", "Арт и аниме"], ["retro", "Ретро и пиксели"]];

export const SCENES: SceneMeta[] = [
  // Простые: ровный фон без сцены, привычное меню слева (theme.ts — PLAIN).
  { id: "auto", name: "Как в Windows", sub: "светлая или тёмная — как в системе", accent: "#3b82f6", bg: "#1c1d21", group: "plain", nav: "side" },
  { id: "light", name: "Светлая", sub: "белая, без анимации", accent: "#2563eb", bg: "#f4f5f7", group: "plain", nav: "side", light: true },
  { id: "sepia", name: "Тёплая", sub: "бежевая, мягче для глаз", accent: "#b45309", bg: "#f3ebdd", group: "plain", nav: "side", light: true },
  { id: "dark", name: "Тёмная", sub: "тёмно-серая, без анимации", accent: "#4f8cff", bg: "#1c1d21", group: "plain", nav: "side" },
  { id: "black", name: "Чёрная", sub: "чистый чёрный — для OLED", accent: "#4f8cff", bg: "#000000", group: "plain", nav: "side" },
  { id: "cat", name: "Кот", sub: "мелом, с нимбом — наш маскот", accent: "#e9e7ff", bg: "#050507", group: "cats", nav: "top" },
  { id: "ramen", name: "Рамен", sub: "постер: кот ест лапшу, закуски", accent: "#e4572e", bg: "#14111a", group: "cats", nav: "top", side: 300 },
  { id: "sassy", name: "Дерзкий", sub: "облака, кот и WHAT THE PING", accent: "#d9e36a", bg: "#0b0e16", group: "cats", nav: "dock", side: 250 },
  { id: "focus", name: "Фокус", sub: "помодоро, план, кот в тишине", accent: "#e9c8a8", bg: "#240306", group: "cats", nav: "dock", side: 250 },
  { id: "meh", name: "MEH", sub: "призрак с котом и кружкой", accent: "#efe6b8", bg: "#050505", group: "cats", nav: "dock", side: 250 },
  { id: "catbox", name: "Коробка", sub: "коробка, полная котов", accent: "#2b2b2b", bg: "#fafafa", group: "cats", nav: "dock", side: 270, light: true },
  { id: "formula", name: "Формулы", sub: "кот-каракуля на доске", accent: "#ececec", bg: "#1b1c1c", group: "cats", nav: "top", side: 290 },
  { id: "overthink", name: "Overthinking", sub: "кот лежит, думает и хочет есть", accent: "#f2f2f2", bg: "#000000", group: "cats", nav: "dock", side: 280 },
  { id: "blob", name: "Утро", sub: "блоб пьёт кофе", accent: "#f2f2f2", bg: "#28282c", group: "coffee", nav: "dock", side: 250 },
  { id: "emc2", name: "E=MC²", sub: "энергия = молоко × кофе²", accent: "#f0f0f0", bg: "#050505", group: "coffee", nav: "side" },
  { id: "element", name: "Элемент", sub: "CoFFeE — главный элемент", accent: "#cfcfcf", bg: "#0e0e0f", group: "coffee", nav: "side" },
  { id: "offline", name: "Офлайн", sub: "пиксельные динозавры болтают", accent: "#f2f2f2", bg: "#1c1c1e", group: "memes", nav: "top", side: 300 },
  { id: "deadline", name: "Дедлайн", sub: "полоска дня, жнец и TODO", accent: "#e11d2a", bg: "#000000", group: "memes", nav: "top", side: 290 },
  { id: "cad", name: "Ctrl+Alt+Del", sub: "негатив летит в корзину", accent: "#f5f5f5", bg: "#000000", group: "memes", nav: "side" },
  { id: "alive", name: "while(alive)", sub: "цикл жизни стоит без связи", accent: "#22c55e", bg: "#000000", group: "memes", nav: "side" },
  { id: "nope", name: "N*PE", sub: "манга и пиксельные буквы", accent: "#111111", bg: "#ffffff", group: "memes", nav: "dock", side: 270, light: true },
  { id: "prism", name: "Призма", sub: "грани и свет у курсора", accent: "#9b6bff", bg: "#06070b", group: "main", nav: "side" },
  { id: "plexus", name: "Сеть", sub: "узлы в объёме, пакеты по трафику", accent: "#e5e7eb", bg: "#07080a", group: "main", nav: "rail" },
  { id: "web", name: "Паутина", sub: "паучки ловят пакеты-мушки", accent: "#f4f4f5", bg: "#050506", group: "main", nav: "rail" },
  { id: "dispersion", name: "Дисперсия", sub: "чёрный камень, радужный луч", accent: "#38bdf8", bg: "#060608", group: "main", nav: "rail" },
  { id: "rift", name: "Разлом", sub: "трещина в космос, лучи, обломки", accent: "#fde68a", bg: "#030305", group: "main", nav: "rail" },
  { id: "beam", name: "Луч", sub: "свет из поднятой руки", accent: "#dbe4ff", bg: "#07090a", group: "main", nav: "dock" },
  { id: "runes", name: "Руны", sub: "светящиеся узоры, дух-вихрь", accent: "#67e8f9", bg: "#0a0f1e", group: "main", nav: "side" },
  { id: "ascii", name: "Код", sub: "поток символов, слова проявляются", accent: "#d4d4d8", bg: "#070708", group: "tech", nav: "dock" },
  { id: "editor", name: "Редактор", sub: "код печатается с подсветкой", accent: "#ffb340", bg: "#0b0b0c", group: "tech", nav: "top" },
  { id: "hello", name: "Hello world", sub: "привет на всех языках", accent: "#22c55e", bg: "#0b0b0c", group: "tech", nav: "top", side: 300 },
  { id: "hud", name: "Кибер-HUD", sub: "пиксельные панели, глобусы", accent: "#22d3ee", bg: "#050608", group: "tech", nav: "top" },
  { id: "glitch", name: "Сбой", sub: "помехи от курсора и задержки", accent: "#ef4444", bg: "#070707", group: "tech", nav: "top" },
  { id: "nosignal", name: "Нет сигнала", sub: "вертикальные помехи, ERR_", accent: "#e5e7eb", bg: "#050505", group: "tech", nav: "top" },
  { id: "techmark", name: "Маркировка", sub: "XX, мишени, штрихкоды", accent: "#f9a8d4", bg: "#050505", group: "tech", nav: "top" },
  { id: "cracked", name: "Разбитый экран", sub: "трещины от щелчка", accent: "#60a5fa", bg: "#04050a", group: "tech", nav: "rail" },
  { id: "shards", name: "Осколки", sub: "квадрат разлетается", accent: "#c084fc", bg: "#0c0a24", group: "tech", nav: "dock" },
  { id: "holo", name: "Голограмма", sub: "стеклянная бабочка в полёте", accent: "#e879f9", bg: "#07040d", group: "art", nav: "dock" },
  { id: "anime", name: "Взгляд", sub: "манга-панели, глаза следят", accent: "#ff2d7a", bg: "#050b07", group: "art", nav: "dock" },
  { id: "spectrum", name: "Спектр", sub: "цветной ASCII-силуэт", accent: "#f472b6", bg: "#050508", group: "art", nav: "side" },
  { id: "poster", name: "Постер", sub: "Who am I? — размытый силуэт", accent: "#e11d48", bg: "#050505", group: "art", nav: "side" },
  { id: "bloom", name: "Цветение", sub: "цветы и треснувшая маска", accent: "#4ade80", bg: "#020604", group: "art", nav: "side" },
  { id: "chill", name: "Чилл", sub: "закат, холмы WPX, очки", accent: "#ff7eb6", bg: "#0c0714", group: "art", nav: "dock" },
  { id: "sphere", name: "Сфера", sub: "стена обложек под линзой", accent: "#60a5fa", bg: "#03050a", group: "art", nav: "top" },
  { id: "widgets", name: "Виджеты", sub: "часы, календарь, листья", accent: "#2b302d", bg: "#e4e4e1", group: "art", nav: "top", side: 300, light: true },
  { id: "retro", name: "Ретро-ПК", sub: "BIOS, каркас, синтвейв-пол", accent: "#ff3b3b", bg: "#02021a", group: "retro", nav: "top" },
  { id: "bekind", name: "Будь добр", sub: "пиксельная ночь и планета", accent: "#7cc4ff", bg: "#03040c", group: "retro", nav: "dock" },
  { id: "hex", name: "Соты", sub: "плитки переворачиваются", accent: "#e5e5e5", bg: "#0a0a0a", group: "retro", nav: "rail" },
  { id: "pet", name: "Питомец", sub: "LCD-питомец, сытость — это связь", accent: "#2e3529", bg: "#a9b39d", group: "retro", nav: "top", side: 300, light: true },
];

// ─── Сеть: узлы на волне в объёме, пакеты бегут по трафику ────────

const plexus: Scene = {
  fps: 30, scale: 1, protect: 0.28,
  init(w, h, small) {
    const r = rng(7);
    const n = small ? 28 : clamp(Math.round((w * h) / 8000), 50, 150);
    return {
      r,
      pts: Array.from({ length: n }, () => ({ u: r() * 1.3 - 0.15, v: r() * 1.3 - 0.15, ph: r() * TAU, x: 0, y: 0, d: 1, fl: 0 })),
      silk: Array.from({ length: small ? 50 : 520 }, () => ({ k: r(), o: (r() - 0.5) * (0.3 + r()), sp: 0.004 + r() * 0.01, a: r() })),
      packets: Array.from({ length: 18 }, () => ({ a: (r() * n) | 0, b: -1, p: 1, sp: 0.6 + r() * 0.8 })),
      dust: Array.from({ length: small ? 12 : 110 }, () => ({ x: r() * w, y: r() * h, v: 3 + r() * 8, a: r() })),
    };
  },
  draw(ctx, s, e) {
    const { w, h, t, dt } = e;
    const yaw = Math.sin(t * 0.06) * 0.45, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const line: RGB = e.alarm ? [255, 95, 105] : [236, 238, 245];
    const acc: RGB = e.alarm ? [255, 80, 90] : hex(e.accent);
    const pts = s.pts;
    for (const p of pts) {
      const X = (p.u - 0.5) * w * 1.15, Y = (p.v - 0.5) * h * 1.15;
      const Z = Math.sin(p.u * 5 + t * 0.45 + p.ph * 0.3) * 90 + Math.cos(p.v * 4 - t * 0.35) * 70;
      const x3 = X * cy + Z * sy, z3 = -X * sy + Z * cy;
      const f = 900 / (900 + z3);
      p.x = w / 2 + x3 * f; p.y = h / 2 + Y * f; p.d = clamp((f - 0.82) / 0.36, 0.15, 1);
      if (e.mouse) {
        const dx = e.mx - p.x, dy = e.my - p.y, d = Math.hypot(dx, dy);
        if (d < 190 && d > 1) { const k = ((190 - d) / 190) * 0.2; p.x += dx * k; p.y += dy * k; }
      }
      p.fl = Math.max(0, p.fl - dt * 1.4);
    }
    ctx.globalCompositeOperation = "lighter";
    // Шёлковая лента частиц — течёт быстрее при трафике.
    for (const q of s.silk) {
      q.k += q.sp * dt * (1 + e.load * 4);
      if (q.k > 1) q.k -= 1;
      const x = (q.k * 1.3 - 0.15) * w, y = h * (0.22 + 0.58 * q.k) + Math.sin(q.k * 7 + t * 0.35) * h * 0.07 + q.o * h * 0.1;
      ctx.fillStyle = rgba(line[0], line[1], line[2], 0.08 + 0.32 * Math.abs(Math.sin(t * 0.9 + q.a * 9)));
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    const link = e.small ? 70 : 170;
    ctx.lineWidth = 0.7;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 > link * link) continue;
        const al = (1 - Math.sqrt(d2) / link) * 0.5 * Math.min(a.d, b.d);
        const fl = Math.max(a.fl, b.fl);
        ctx.strokeStyle = fl > 0.05 ? rgba(lerp(line[0], acc[0], fl), lerp(line[1], acc[1], fl), lerp(line[2], acc[2], fl), al + fl * 0.4) : rgba(line[0], line[1], line[2], al);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      if (e.mouse) {
        const d = Math.hypot(a.x - e.mx, a.y - e.my);
        if (d < 210) { ctx.strokeStyle = rgba(acc[0], acc[1], acc[2], (1 - d / 210) * 0.4); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(e.mx, e.my); ctx.stroke(); }
      }
    }
    for (const p of pts) {
      ctx.fillStyle = rgba(line[0], line[1], line[2], 0.3 + 0.65 * p.d);
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.7 + p.d * 1.9, 0, TAU); ctx.fill();
      if (p.fl > 0.02) {
        ctx.strokeStyle = rgba(acc[0], acc[1], acc[2], p.fl * 0.8); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 4 + (1 - p.fl) * 22, 0, TAU); ctx.stroke();
      }
    }
    // Пакеты: чем больше трафик, тем их больше и они быстрее. Обрыв — стоят.
    const active = e.small ? 2 : 3 + Math.round(e.load * 13);
    for (let i = 0; i < active; i++) {
      const k = s.packets[i];
      if (k.p >= 1) {
        const a = pts[k.b >= 0 ? k.b : k.a];
        const near: [number, number][] = [];
        pts.forEach((q: any, j: number) => { const d = Math.hypot(q.x - a.x, q.y - a.y); if (q !== a && d < link) near.push([j, d]); });
        if (k.b >= 0) { k.a = k.b; pts[k.b].fl = 1; }
        if (!near.length) { k.a = (s.r() * pts.length) | 0; k.b = -1; continue; }
        near.sort((x, y) => x[1] - y[1]);
        k.b = near[(s.r() * Math.min(3, near.length)) | 0][0];
        k.p = 0;
      }
      if (!e.alarm) k.p = Math.min(1, k.p + dt * k.sp * (0.6 + e.load * 1.8));
      const a = pts[k.a], b = pts[k.b] ?? a;
      glow(ctx, a.x + (b.x - a.x) * k.p, a.y + (b.y - a.y) * k.p, 8, acc, 0.95);
    }
    for (const d of s.dust) {
      d.y -= d.v * dt; if (d.y < -4) { d.y = h + 4; d.x = s.r() * w; }
      ctx.fillStyle = rgba(255, 255, 255, 0.06 + 0.16 * Math.abs(Math.sin(t * 0.8 + d.a * 9)));
      ctx.fillRect(d.x, d.y, 1.2, 1.2);
    }
    ctx.globalCompositeOperation = "source-over";
  },
};

// ─── Код: поток символов, слова проявляются, линза у курсора ──────

const RAMP = " .,:;-~=+*cvxzoaw#%&@";
const WORDS = ["WPX", "TUNNEL", "NO_LOGS", "REALITY", "HY2", "AWG", "PRIVATE", "ONLINE", "KILL_SWITCH", "0x7F00", "ENCRYPTED"];
const codeLines = (ms: number | null) => [
  "> wpx --status", `  rtt ${ms ?? "—"} ms`, "  tunnel   up", "  dns      remote", "  leaks    0",
  "> probe --all", "  vless    ok", "  hy2      ok", "  awg      ok", "> route", "  PC>TUN>SG>FI", "> guard --kill-switch on", "  ok",
];
const ascii: Scene = {
  fps: 12, scale: 1, protect: 0.45,
  init(w, h, small) {
    return { cw: small ? 6 : 9, ch: small ? 9 : 15, r: rng(41), small, dec: [] as any[], next: 0, typed: 0, w, h };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    const { cw, ch } = s;
    const fs = s.small ? 8 : 12;
    ctx.font = `${fs}px "Cascadia Mono", Consolas, monospace`;
    ctx.textBaseline = "top";
    const cols = Math.ceil(w / cw), rows = Math.ceil(h / ch);
    // Сбои строк — чаще при большой задержке и обрыве.
    const rate = 0.05 + (e.ms && e.ms > 900 ? 0.06 : 0) + (e.alarm ? 0.15 : 0);
    const glitchRows = new Set<number>();
    for (let y = 0; y < rows; y++) if (hash2(y, Math.floor(t * 3)) < rate) glitchRows.add(y);
    const near: [string, number, number, number][] = [];
    const buckets: (string | number)[][] = [[], [], [], [], [], []];
    for (let y = 0; y < rows; y++) {
      const gl = glitchRows.has(y);
      const shift = gl ? ((hash2(y, 99 + Math.floor(t * 3)) - 0.5) * 60) | 0 : 0;
      for (let x = 0; x < cols; x++) {
        const px = x * cw, py = y * ch;
        const band = Math.exp(-Math.pow((py - (h * 1.25 - px * 0.5 + Math.sin(px * 0.006 + t * 0.35) * h * 0.1)) / (h * 0.17), 2));
        let v = band * 0.8 + fbm(x * 0.08, y * 0.12 + t * 0.12, 2) * 0.4 - 0.45 + e.load * 0.12;
        // Курсор — перекрестие из символов: строка и колонка вспыхивают.
        let lens = 0;
        if (e.mouse) {
          const ax = Math.abs(px - e.mx), ay = Math.abs(py - e.my), reach = Math.max(0, 1 - Math.hypot(ax, ay) / 460);
          lens = Math.max(ax < cw ? 1 - ax / cw : 0, ay < ch * 0.7 ? 1 - ay / (ch * 0.7) : 0) * reach;
          v += lens * 0.9;
        }
        if (v < 0.04) continue;
        v = Math.min(1, v);
        const c = lens > 0.3 ? RAMP[(hash2(x * 7 + ((t * 10) | 0), y) * RAMP.length) | 0] : RAMP[Math.min(RAMP.length - 1, (v * RAMP.length) | 0)];
        if (c === " ") continue;
        if (lens > 0.5) { near.push([c, px + shift, py, lens]); continue; }
        if (gl) { ctx.fillStyle = e.alarm ? `hsla(355,90%,60%,${v.toFixed(2)})` : `hsla(${((x * 3 + t * 60) % 360).toFixed(0)},85%,65%,${(v * 0.9).toFixed(2)})`; ctx.fillText(c, px + shift, py); }
        else buckets[Math.min(5, (v * 6) | 0)].push(c, px + shift, py);
      }
    }
    buckets.forEach((b, i) => {
      if (!b.length) return;
      const v = (i + 0.5) / 6;
      ctx.fillStyle = e.alarm ? rgba(255, 120, 130, v * 0.6) : rgba(235, 235, 240, v * 0.55);
      for (let j = 0; j < b.length; j += 3) ctx.fillText(b[j] as string, b[j + 1] as number, b[j + 2] as number);
    });
    // Линза: символы у курсора крупнее и ярче.
    ctx.font = `bold ${fs + 5}px "Cascadia Mono", Consolas, monospace`;
    for (const [c, x, y, k] of near) { ctx.fillStyle = rgba(255, 255, 255, 0.5 + k * 0.5); ctx.fillText(c, x, y); }
    // Проявление слов: шум собирается в слово, держится, рассыпается.
    if (t > s.next && !s.small) {
      s.next = t + 0.9 + s.r() * 1.2;
      const word = s.r() < 0.25 && e.ms ? `${e.ms}ms` : WORDS[(s.r() * WORDS.length) | 0];
      s.dec.push({ x: (6 + s.r() * (cols - 20)) | 0, y: (3 + s.r() * (rows - 6)) | 0, word, t0: t });
    }
    ctx.font = `bold ${fs + 2}px "Cascadia Mono", Consolas, monospace`;
    s.dec = s.dec.filter((d: any) => t - d.t0 < 3.2);
    for (const d of s.dec) {
      const age = t - d.t0, a = age < 2.6 ? 1 : 1 - (age - 2.6) / 0.6;
      [...d.word].forEach((chr: string, i: number) => {
        const done = age > 0.25 + i * 0.07;
        const c = done && age < 2.6 ? chr : RAMP[(hash2(i, (t * 20) | 0) * RAMP.length) | 0];
        ctx.fillStyle = done ? rgba(255, 255, 255, a) : rgba(160, 255, 200, a * 0.7);
        ctx.fillText(c, d.x * cw + i * (cw + 2), d.y * ch);
      });
    }
    if (!s.small) {
      // Колонка терминала под навигацией: строки печатаются, мигает курсор.
      const z = sideZone(e);
      const lines = codeLines(e.ms);
      s.typed += e.dt * 22;
      const total = lines.reduce((a, l) => a + l.length + 4, 0);
      if (s.typed > total + 60) s.typed = 0;
      ctx.font = `11px "Cascadia Mono", Consolas, monospace`;
      let left = s.typed, y = z.y + 14;
      for (const l of lines) {
        if (left <= 0) break;
        const shown = l.slice(0, Math.max(0, Math.floor(left)));
        ctx.fillStyle = l.startsWith(">") ? rgba(255, 255, 255, 0.55) : rgba(200, 255, 220, 0.35);
        ctx.fillText(shown, z.x + 4, y);
        if (left < l.length && Math.sin(t * 8) > 0) ctx.fillRect(z.x + 4 + ctx.measureText(shown).width + 1, y, 6, 12);
        left -= l.length + 4; y += 17;
        if (y > z.y + z.h - 10) break;
      }
    }
  },
};

// ─── Спектр: цветной ASCII-силуэт профиля, рассыпается назад ──────

const PROFILE = [[0.30, 0.10], [0.50, 0.02], [0.70, 0.12], [0.77, 0.27], [0.76, 0.34], [0.87, 0.45], [0.78, 0.50], [0.80, 0.54], [0.77, 0.57], [0.79, 0.60], [0.73, 0.68], [0.61, 0.74], [0.59, 0.86], [0.72, 1.0], [0.96, 1.18], [1.0, 1.4], [0.0, 1.4], [0.04, 1.16], [0.28, 0.98], [0.30, 0.80], [0.18, 0.58], [0.19, 0.27]];
const SPEC = ["#22d3ee", "#3b82f6", "#a855f7", "#e879f9", "#fb7185", "#fb923c", "#facc15", "#f8fafc"];
const GLYPHS = "[]{}()|=:-_/\\1lI!;#<>";
const spectrum: Scene = {
  fps: 20, scale: 1, protect: 0.12,
  init(w, h, small) {
    const z = sideZone({ w, h });
    const bh = small ? Math.min(h * 1.25, 120) : Math.min(1.4 * (z.w + 24), h - z.y + 20), bw = bh / 1.4;
    const ox = small ? w - bw * 0.95 - 4 : z.x - 6 + (z.w + 12 - bw) / 2, oy = h - bh;
    const path = smoothPath(PROFILE, bw, bh / 1.4, ox, oy);
    const cw = small ? 4 : 7, ch = small ? 5 : 10;
    const m = document.createElement("canvas").getContext("2d")!;
    const rows: { y: number; xs: number[] }[] = [];
    for (let y = Math.max(0, oy); y < h; y += ch) {
      const xs: number[] = [];
      for (let x = ox - 10; x < w; x += cw) if (m.isPointInPath(path, x + cw / 2, y + ch / 2)) xs.push(x);
      if (xs.length) rows.push({ y, xs });
    }
    return { rows, cw, ch, parts: [] as any[], r: rng(29), oy, bh, small, k: Math.min(1, bw / 470) };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e;
    ctx.font = `${s.small ? 5 : 10}px "Cascadia Mono", Consolas, monospace`;
    ctx.textBaseline = "top";
    const pal = e.alarm ? ["#ef4444", "#f87171", "#ffffff"] : SPEC;
    s.rows.forEach((row: any, i: number) => {
      const shoulders = row.y > s.oy + s.bh * 0.72;
      const ci = Math.floor(i / 3 + t * 0.6) % pal.length;
      const dx = Math.sin(i * 0.7 + t * 1.3) * 3 + (hash2(i, Math.floor(t * 4)) > 0.93 ? (hash2(i, 5) - 0.5) * 34 : 0);
      const minX = row.xs[0];
      const crumble = (30 + fbm(i * 0.1, t * 0.3, 2) * 90 + e.load * 40) * s.k;
      for (const x of row.xs) {
        const back = x - minX < crumble;
        if (back && hash2(x, i + Math.floor(t * 6)) > 0.45) {
          if (s.r() < 0.012 && s.parts.length < 500) s.parts.push({ x, y: row.y, vx: -40 - s.r() * 70, vy: (s.r() - 0.5) * 12, life: 1, c: pal[(ci + 2) % pal.length] });
          continue;
        }
        const px = x + dx, py = row.y;
        if (e.mouse) {
          const ddx = px - e.mx, ddy = py - e.my, d = Math.hypot(ddx, ddy);
          if (d < 70) {
            if (s.r() < 0.05 && s.parts.length < 500) s.parts.push({ x: px, y: py, vx: (ddx / d) * 80, vy: (ddy / d) * 80, life: 1, c: pal[ci] });
            continue;
          }
        }
        if (shoulders) {
          ctx.fillStyle = rgba(240, 236, 255, 0.18 + hash2(x, i) * 0.35);
          ctx.fillRect(px, py + 2, s.cw + 1, s.ch * 0.6);
        } else {
          ctx.fillStyle = hash2(x, i) > 0.82 ? "#ffffff" : pal[(ci + ((hash2(x >> 4, i) * 2) | 0)) % pal.length];
          ctx.fillText(GLYPHS[(hash2(x, i + Math.floor(t * 2)) * GLYPHS.length) | 0], px, py);
        }
      }
    });
    ctx.globalCompositeOperation = "lighter";
    s.parts = s.parts.filter((p: any) => (p.life -= dt * 0.6) > 0);
    for (const p of s.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      ctx.fillStyle = p.c; ctx.globalAlpha = p.life * 0.9;
      ctx.fillRect(p.x, p.y, s.small ? 2 : 4, s.small ? 1 : 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (!s.small) {
      // Потоки цветных символов у правого края — быстрее при трафике.
      ctx.font = `11px "Cascadia Mono", Consolas, monospace`;
      for (let c = 0; c < 4; c++) {
        const x = w - 16 - c * 15, sp = 40 + c * 17 + e.load * 80;
        for (let k = 0; k < 18; k++) {
          const y = ((t * sp + k * 24 + c * 57) % (h + 40)) - 20;
          ctx.fillStyle = SPEC[(c * 2 + k) % SPEC.length];
          ctx.globalAlpha = 0.15 + 0.45 * (k / 18);
          ctx.fillText(GLYPHS[(hash2(c * 31 + k, Math.floor(t * 3)) * GLYPHS.length) | 0], x, y);
        }
      }
      ctx.globalAlpha = 1;
    }
  },
};

// ─── Сбой: помехи от курсора, задержки и обрыва ──────────────────

const glitch: Scene = {
  fps: 30, scale: 1, protect: 0.32,
  init(_w, _h, small) {
    return { r: rng(53), blocks: [] as any[], tears: [] as any[], next: 0, small, lx: -1, ly: -1, lastMs: 0 };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    ctx.fillStyle = "rgba(255,255,255,.018)";
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    const moved = e.mouse && Math.hypot(e.mx - s.lx, e.my - s.ly) > 30;
    s.lx = e.mx; s.ly = e.my;
    // Всплеск задержки — всплеск помех.
    const spike = e.ms !== null && s.lastMs && e.ms > s.lastMs * 1.6 && e.ms > 600;
    if (e.ms !== null) s.lastMs = e.ms;
    const busy = 1 + (e.ms && e.ms > 1000 ? 1.5 : 0) + e.load * 1.2;
    if (t > s.next || moved || spike || (e.alarm && s.r() < 0.4)) {
      if (t > s.next) s.next = t + (1.2 + s.r() * 3) / busy;
      const n = s.small ? 3 : moved ? 2 : 6 + ((s.r() * 8) | 0);
      for (let i = 0; i < n; i++) {
        const at = moved && i < 2;
        const bx = at ? e.mx + (s.r() - 0.5) * 120 : s.r() * w, by = at ? e.my + (s.r() - 0.5) * 60 : s.r() * h;
        // Мозаика: блок из мелких квадратов, как «рассыпанное» лицо.
        const mosaic = !s.small && s.r() < 0.35;
        s.blocks.push({ x: bx, y: by, w: 10 + s.r() * (s.small ? 40 : 240), h: 2 + s.r() * (s.small ? 6 : mosaic ? 60 : 24), red: s.r() < 0.6, life: 0.12 + s.r() * 0.4, born: t, mosaic });
      }
      if (!s.small && s.r() < 0.5) s.tears.push({ x: s.r() * w, c: s.r() < 0.5 ? "rgba(255,38,48,.55)" : "rgba(32,227,208,.45)", born: t, life: 0.08 + s.r() * 0.2 });
    }
    s.blocks = s.blocks.filter((b: any) => t - b.born < b.life);
    s.tears = s.tears.filter((b: any) => t - b.born < b.life);
    for (const v of s.tears) { ctx.fillStyle = v.c; ctx.fillRect(v.x, 0, 1.5, h); }
    for (const b of s.blocks) {
      if (s.r() < 0.22) continue;
      const off = (s.r() - 0.5) * 14;
      if (b.mosaic) {
        for (let y = 0; y < b.h; y += 8) for (let x = 0; x < b.w; x += 8) {
          const q = hash2((b.x + x) | 0, (b.y + y) | 0);
          if (q < 0.45) continue;
          ctx.fillStyle = q > 0.8 ? (b.red ? "rgba(255,38,48,.7)" : "rgba(32,227,208,.6)") : `rgba(255,255,255,${(q * 0.18).toFixed(2)})`;
          ctx.fillRect(b.x + x + off, b.y + y, 7, 7);
        }
        continue;
      }
      ctx.fillStyle = b.red ? "rgba(255,38,48,.55)" : "rgba(32,227,208,.45)";
      ctx.fillRect(b.x + off, b.y, b.w, b.h);
      ctx.fillStyle = b.red ? "rgba(32,227,208,.25)" : "rgba(255,38,48,.25)";
      ctx.fillRect(b.x - off * 1.5, b.y + 2, b.w * 0.7, b.h * 0.6);
    }
    if (s.small) return;
    ctx.font = "10px Cascadia Mono, Consolas, monospace";
    ctx.textBaseline = "top";
    const label = (x: number, y: number, lines: string[]) => {
      const j = hash2((x + y) | 0, (t * 6) | 0) > 0.94 ? (hash2(3, (t * 6) | 0) - 0.5) * 10 : 0;
      ctx.fillStyle = "rgba(255,255,255,.55)";
      lines.forEach((l, i) => ctx.fillText(l, x + j, y + i * 13));
      ctx.fillStyle = "rgba(255,38,48,.9)"; ctx.fillRect(x, y + lines.length * 13 + 4, 14, 2);
    };
    const z = sideZone(e);
    label(26, z.y + 10, ["NO LOGS", "JUST A TUNNEL"]);
    label(26, z.y + 70, ["NOT A PROXY", "NOT A SERVICE", "YOUR OWN SERVER"]);
    const n = Math.floor(t * 7);
    for (let i = 0; i < 4; i++) {
      const s3 = String((n * (i + 3) * 37) % 1000).padStart(3, "0").split("").join("   ");
      ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fillText(s3, 30, z.y + 150 + i * 20);
      ctx.fillStyle = "rgba(255,38,48,.6)"; ctx.fillRect(26, z.y + 156 + i * 20, 64, 1);
    }
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fillText(e.ms ? `RTT ${e.ms} MS — THE LESS THEY SEE, THE MORE YOU ARE` : "THE LESS THEY SEE — THE MORE YOU ARE", w * 0.5 - 150, 17);
    ctx.fillStyle = "rgba(255,38,48,.85)";
    ctx.fillRect(w - 10, h * 0.55, 3, 60); ctx.fillRect(w - 10, h * 0.55 + 70, 3, 8);
  },
};

// ─── Постер: «Who am I?», размытый силуэт с красной кромкой ────────

const BUST = [[0.5, 0.04], [0.66, 0.12], [0.69, 0.3], [0.62, 0.46], [0.6, 0.56], [0.85, 0.66], [0.98, 0.8], [1.0, 1.0], [0.0, 1.0], [0.02, 0.8], [0.15, 0.66], [0.4, 0.56], [0.38, 0.46], [0.31, 0.3], [0.34, 0.12]];
const poster: Scene = {
  fps: 20, scale: 1, protect: 0.2,
  init(w, h, small) {
    const r = rng(71);
    const z = sideZone({ w, h });
    const bh = small ? Math.min(h * 1.1, 96) : Math.min(270, z.h), bw = bh * 0.82;
    const ox = small ? w - bw * 0.85 : z.x + (z.w - bw) / 2 + 10, oy = h - bh;
    const path = smoothPath(BUST, bw, bh, ox, oy);
    const m = document.createElement("canvas").getContext("2d")!;
    const spans: { y: number; x0: number; x1: number }[] = [];
    for (let y = oy; y < h; y += small ? 2 : 3) {
      let x0 = -1, x1 = -1;
      for (let x = ox; x < ox + bw; x += 3) if (m.isPointInPath(path, x, y)) { if (x0 < 0) x0 = x; x1 = x; }
      if (x0 >= 0) spans.push({ y, x0, x1 });
    }
    const streaks = Array.from({ length: small ? 6 : 40 }, () => ({ x: r() * w, w: 1 + r() * 3, a: 0.02 + r() * 0.06, v: (r() - 0.5) * 6 }));
    const hair = Array.from({ length: small ? 10 : 70 }, () => [ox + bw * (0.3 + r() * 0.4), oy + bh * (0.02 + r() * 0.12), (r() - 0.5) * 40, -10 - r() * 30]);
    return { path, spans, streaks, hair, r, ox, oy, bw, bh, small };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    for (const v of s.streaks) {
      v.x += v.v * e.dt; if (v.x < 0) v.x += w; if (v.x > w) v.x -= w;
      ctx.fillStyle = `rgba(255,255,255,${v.a.toFixed(3)})`; ctx.fillRect(v.x, 0, v.w, h);
    }
    // Силуэт из горизонтальных мазков; лицо — белая смазанная полоса.
    const faceY0 = s.oy + s.bh * 0.2, faceY1 = s.oy + s.bh * 0.36;
    const near = e.mouse ? clamp(1 - Math.hypot(e.mx - (s.ox + s.bw / 2), e.my - (s.oy + s.bh * 0.3)) / 300, 0, 1) : 0;
    for (const sp of s.spans) {
      const face = sp.y > faceY0 && sp.y < faceY1;
      const jit = hash2(sp.y | 0, Math.floor(t * 8)) > 0.9 - near * 0.3 ? (hash2(sp.y | 0, 3) - 0.5) * (30 + near * 60) : 0;
      const k = hash2(sp.y | 0, Math.floor(t * 3));
      if (face) {
        const len = (sp.x1 - sp.x0) * (0.7 + k * 0.6);
        ctx.fillStyle = `rgba(245,245,245,${(0.35 + k * 0.4).toFixed(2)})`;
        ctx.fillRect(sp.x0 + jit - 10, sp.y, len + 20, s.small ? 1.5 : 2);
      } else {
        ctx.fillStyle = `rgba(${e.alarm ? "120,30,30" : "38,38,40"},${(0.6 + k * 0.4).toFixed(2)})`;
        ctx.fillRect(sp.x0 + jit, sp.y, sp.x1 - sp.x0, s.small ? 1.5 : 2.4);
        if (k > 0.75) { ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(sp.x0 + jit + (sp.x1 - sp.x0) * k * 0.6, sp.y, 20 + k * 40, 1); }
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [x, y, dx, dy] of s.hair) { ctx.moveTo(x, y); ctx.quadraticCurveTo(x + dx * 0.5, y + dy, x + dx, y + dy * 0.6 + Math.sin(t + x) * 2); }
    ctx.stroke();
    // Красная кромка контура.
    ctx.save();
    ctx.strokeStyle = e.alarm ? "rgba(255,40,60,.95)" : `rgba(225,29,72,${(0.55 + 0.2 * Math.sin(t * 2)).toFixed(2)})`;
    ctx.lineWidth = s.small ? 1 : 2;
    ctx.shadowColor = "#e11d48"; ctx.shadowBlur = s.small ? 3 : 10;
    ctx.setLineDash([30, 12, 6, 18]);
    ctx.lineDashOffset = -t * 20;
    ctx.stroke(s.path);
    ctx.restore();
    if (s.small) return;
    const z = sideZone(e);
    const g = hash2(1, Math.floor(t * 5)) > 0.9 ? 4 : 0;
    ctx.textBaseline = "alphabetic";
    ctx.font = `900 50px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "rgba(240,240,240,.92)";
    ctx.fillText("Who", 22 + g, z.y + 56);
    ctx.fillText("am", 22, z.y + 104);
    ctx.fillStyle = "#e11d48";
    ctx.fillText("I?", 22 - g, z.y + 152);
    ctx.font = "9px Cascadia Mono, Consolas, monospace";
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ["NO FACE", "JUST A", "TUNNEL"].forEach((l, i) => ctx.fillText(l, 124, z.y + 24 + i * 12));
    ctx.fillStyle = "#e11d48"; ctx.fillRect(124, z.y + 64, 12, 2);
    const n = Math.floor(t * 3);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fillText(String((n * (i + 7) * 53) % 1000).padStart(3, "0").split("").join("  "), w - 120, h - 92 + i * 16);
      ctx.fillStyle = "rgba(225,29,72,.7)"; ctx.fillRect(w - 124, h - 95 + i * 16, 54, 1);
    }
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.fillText("UNKNOWN", w - 150, h - 30);
    ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(w - 84, h - 38); ctx.lineTo(w - 72, h - 26); ctx.moveTo(w - 72, h - 38); ctx.lineTo(w - 84, h - 26); ctx.stroke();
    ctx.fillStyle = "#e11d48"; ctx.fillRect(w - 10, h * 0.5, 3, 50); ctx.fillRect(w - 10, h * 0.5 + 58, 3, 8);
    ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1;
    ctx.textBaseline = "top";
  },
};

// ─── Голограмма: стеклянная бабочка в полёте ───────────────────────
// Крылья из светящегося стекла с горячими бликами и строчными полосами; кадр
// переключается между розовым и синим «прочтением». Летит за курсором, за ней — шлейф искр.

const FORE = [[0, -4], [6, -40], [28, -80], [62, -104], [100, -108], [116, -92], [110, -64], [88, -40], [60, -22], [28, -8], [6, 0]];
const HIND = [[2, 4], [30, 4], [62, 14], [84, 38], [86, 64], [70, 86], [44, 94], [24, 82], [10, 56], [2, 26]];
const holo: Scene = {
  fps: 30, scale: 1, protect: 0.15,
  init(w, h, small) {
    const r = rng(11);
    const Z = small ? 160 : 460;
    const off = document.createElement("canvas");
    off.width = off.height = Z;
    // Свечение — уменьшенные копии кадра, растянутые обратно (дешевле фильтра blur).
    const b1 = document.createElement("canvas"), b2 = document.createElement("canvas");
    b1.width = b1.height = Math.round(Z / 12); b2.width = b2.height = Math.round(Z / 4);
    return {
      r, mode: 0, next: 0, off, o: off.getContext("2d")!, b1, b2,
      fore: smoothPts(FORE, 3), hind: smoothPts(HIND, 3),
      px: w * 0.6, py: h * 0.5, vx: 40, vy: 0, head: 0,
      dust: Array.from({ length: small ? 12 : 110 }, () => ({ x: r() * w, y: r() * h, a: r() })),
      sparks: [] as any[], small,
    };
  },
  draw(ctx, s, e) {
    const { w, h, t, dt } = e;
    if (t > s.next) { s.mode = s.mode ? 0 : 1; s.next = t + (s.mode ? 0.35 + s.r() * 0.5 : 1.6 + s.r() * 2.4); }
    const blue = s.mode === 1;
    const pal: string[] = e.alarm ? ["#ff2448", "#ff6b81"] : blue ? ["#1d4ed8", "#22d3ee"] : ["#ff1fae", "#ff7ad6"];
    const c1 = hex(pal[0]), c2 = hex(pal[1]);
    for (const d of s.dust) {
      ctx.fillStyle = rgba(225, 205, 255, 0.05 + 0.14 * Math.abs(Math.sin(t * 0.6 + d.a * 7)));
      ctx.fillRect(d.x, d.y, 1.3, 1.3);
    }
    // Полёт: по кривой Лиссажу, рядом с курсором — кружит возле него.
    let tx = w * (0.5 + 0.4 * Math.sin(t * 0.09)), ty = h * (0.5 + 0.36 * Math.sin(t * 0.13 + 1));
    if (s.small) { tx = w * (0.62 + 0.3 * Math.sin(t * 0.4)); ty = h * (0.5 + 0.25 * Math.sin(t * 0.7)); }
    if (e.mouse) { tx = e.mx + Math.cos(t * 0.6) * 90; ty = e.my + Math.sin(t * 0.8) * 55; }
    s.vx += ((tx - s.px) * 0.7 - s.vx * 0.9) * dt;
    s.vy += ((ty - s.py) * 0.7 - s.vy * 0.9) * dt;
    s.px += s.vx * dt; s.py += s.vy * dt;
    const sp = Math.hypot(s.vx, s.vy);
    const want = Math.atan2(s.vy, s.vx) + Math.PI / 2;
    let dh = want - s.head; while (dh > Math.PI) dh -= TAU; while (dh < -Math.PI) dh += TAU;
    s.head += dh * clamp(dt * 3, 0, 1);
    // Взмахи: чаще при быстром полёте; медленно — планирует.
    const glide = sp < 45 ? 0.3 : 1;
    s.ph = (s.ph ?? 0) + dt * (3.2 + Math.min(2.5, sp / 80));
    const flap = 0.5 + 0.5 * Math.sin(s.ph);
    const ang = 0.12 + 1.2 * flap * glide;
    const pitch = 0.95 + 0.2 * Math.sin(t * 0.5);
    const depth = 0.8 + 0.3 * Math.sin(t * 0.37);
    const O = s.off as HTMLCanvasElement, o = s.o as CanvasRenderingContext2D, Z = O.width;
    const S = (s.small ? h / 300 : clamp(h / 640, 0.85, 1.35)) * depth * (Z / 460);
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, Z, Z);
    const cp = Math.cos(pitch), spn = Math.sin(pitch);
    const proj = (x: number, y: number, side: number): [number, number] => {
      const X = side * x * Math.cos(ang), Zz = x * Math.sin(ang);
      const Y2 = y * cp - Zz * spn, Z2 = y * spn + Zz * cp;
      const f = 600 / (600 - Z2);
      return [X * f * S, Y2 * f * S];
    };
    o.translate(Z / 2, Z / 2);
    o.rotate(s.head);
    const tips: number[][] = [];
    const face = 0.55 + 0.45 * Math.cos(ang);
    for (const side of [-1, 1]) {
      for (const [shape, al] of [[s.fore, 0.62], [s.hind, 0.5]] as const) {
        const P = shape.map(([x, y]: number[]) => proj(x, y, side));
        const path = new Path2D();
        P.forEach(([x, y]: number[], i: number) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
        path.closePath();
        const g = o.createLinearGradient(0, -110 * S, side * 100 * S, 90 * S);
        g.addColorStop(0, rgba(c1[0], c1[1], c1[2], al * face));
        g.addColorStop(0.55, rgba(c2[0], c2[1], c2[2], al * 0.85 * face));
        g.addColorStop(1, rgba(255, 255, 255, al * face));
        o.fillStyle = g; o.fill(path);
        o.save(); o.clip(path);
        // Строчные полосы по стеклу.
        o.rotate(-s.head);
        for (let y = -Z / 2; y < Z / 2; y += 3) {
          const hv = hash2(y + side * 300, (t * 24) | 0);
          if (hv > 0.6) { o.fillStyle = `rgba(255,255,255,${(0.08 + hv * 0.3).toFixed(2)})`; o.fillRect(-Z / 2, y, Z, hv > 0.94 ? 2 : 1); }
        }
        o.rotate(s.head);
        // Горячий блик у основания крыла.
        const [bx, by] = proj(18, shape === s.fore ? -16 : 18, side);
        const hg = o.createRadialGradient(bx, by, 0, bx, by, 60 * S);
        hg.addColorStop(0, `rgba(255,255,255,${(0.9 * face).toFixed(2)})`); hg.addColorStop(1, "rgba(255,255,255,0)");
        o.fillStyle = hg; o.fillRect(-Z / 2, -Z / 2, Z, Z);
        o.restore();
        o.strokeStyle = "rgba(255,255,255,.95)"; o.lineWidth = s.small ? 0.8 : 1.6; o.stroke(path);
        // Прожилки.
        o.strokeStyle = "rgba(255,255,255,.45)"; o.lineWidth = s.small ? 0.5 : 0.9;
        o.beginPath();
        const vein = (pts: number[][]) => pts.forEach(([x, y], i) => { const [px, py] = proj(x, y, side); if (i) o.lineTo(px, py); else o.moveTo(px, py); });
        if (shape === s.fore) { vein([[2, -2], [40, -50], [98, -104]]); vein([[2, -2], [56, -30], [110, -66]]); }
        else { vein([[2, 4], [44, 30], [80, 60]]); vein([[2, 4], [28, 50], [40, 90]]); }
        o.stroke();
        tips.push(shape === s.fore ? P[12] : P[18]);
      }
    }
    o.fillStyle = "#fff";
    o.beginPath(); o.ellipse(0, 6 * S, 3.2 * S, 28 * S, 0, 0, TAU); o.fill();
    o.strokeStyle = "rgba(255,255,255,.8)"; o.lineWidth = 1;
    o.beginPath(); o.moveTo(-1.5 * S, -20 * S); o.quadraticCurveTo(-14 * S, -46 * S, -20 * S, -50 * S); o.moveTo(1.5 * S, -20 * S); o.quadraticCurveTo(14 * S, -46 * S, 20 * S, -50 * S); o.stroke();
    o.setTransform(1, 0, 0, 1, 0, 0);
    // На экран: два слоя свечения + чёткая копия; иногда срезы сдвигаются.
    const X0 = s.px - Z / 2, Y0 = s.py - Z / 2;
    const b1 = s.b1 as HTMLCanvasElement, b2 = s.b2 as HTMLCanvasElement;
    const g1 = b1.getContext("2d")!, g2 = b2.getContext("2d")!;
    g1.clearRect(0, 0, b1.width, b1.height); g1.drawImage(O, 0, 0, b1.width, b1.height);
    g2.clearRect(0, 0, b2.width, b2.height); g2.drawImage(O, 0, 0, b2.width, b2.height);
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.9; ctx.drawImage(b1, X0 - Z * 0.1, Y0 - Z * 0.1, Z * 1.2, Z * 1.2);
    ctx.globalAlpha = 0.7; ctx.drawImage(b2, X0, Y0, Z, Z);
    ctx.globalAlpha = 1; ctx.drawImage(O, X0, Y0);
    if (s.r() < 0.35) {
      const sy = s.r() * Z, sh = 4 + s.r() * 16, dx = (s.r() - 0.5) * (s.small ? 6 : 30);
      ctx.globalAlpha = 0.8; ctx.drawImage(O, 0, sy, Z, sh, X0 + dx, Y0 + sy, Z, sh); ctx.globalAlpha = 1;
    }
    glow(ctx, s.px, s.py, 70 * S, c2, 0.4);
    // Шлейф искр от кончиков крыльев.
    const rot = (x: number, y: number) => [s.px + x * Math.cos(s.head) - y * Math.sin(s.head), s.py + x * Math.sin(s.head) + y * Math.cos(s.head)];
    const wt = tips.map(([x, y]) => rot(x, y));
    if (s.sparks.length < 260) for (const [x, y] of wt) if (s.r() < (s.small ? 0.15 : 0.7)) s.sparks.push({ x, y, vx: -s.vx * 0.15 + (s.r() - 0.5) * 40, vy: -s.vy * 0.15 + 10 + s.r() * 25, life: 1 });
    s.sparks = s.sparks.filter((p: any) => (p.life -= dt * 0.8) > 0);
    for (const p of s.sparks) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      glow(ctx, p.x, p.y, (s.small ? 1.5 : 3) + p.life * 3, c2, p.life * 0.9);
    }
    ctx.globalCompositeOperation = "source-over";
    if (blue && !s.small) {
      ctx.font = "10px Cascadia Mono, Consolas, monospace";
      ctx.textBaseline = "alphabetic";
      ctx.lineWidth = 1;
      wt.forEach(([x, y], i) => {
        ctx.fillStyle = "rgba(255,255,255,.92)";
        ctx.fillText(`x: ${x | 0}  y: ${y | 0}`, x + 6, y - 4);
        ctx.strokeStyle = "rgba(255,50,50,.85)";
        ctx.strokeRect(x - 18 - i * 4, y - 14, 40 + i * 10, 28 + i * 6);
      });
      ctx.strokeStyle = "rgba(255,50,50,.8)";
      ctx.strokeRect(s.px - 90 * S, s.py - 110 * S, 180 * S, 210 * S);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(200,255,225,.6)";
      ctx.beginPath(); ctx.arc(s.px + 20 * S, s.py - 30 * S, 130 * S, -2.7, -0.3); ctx.stroke();
      ctx.beginPath(); wt.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y] of wt) { ctx.fillStyle = "#86efac"; ctx.fillRect(x - 2, y - 2, 4, 4); }
    }
  },
};

// ─── Дисперсия: чёрный камень, радужные лучи, трещины ────────────

const dispersion: Scene = {
  fps: 30, scale: 0.6, protect: 0.4,
  init(w, h, small) {
    const r = rng(31);
    const scratch = Array.from({ length: small ? 6 : 70 }, () => {
      const x = r() * w * 1.2 - w * 0.1, y = r() * h * 1.2 - h * 0.1, len = 30 + r() * (small ? 40 : 260), a = -0.6 + (r() - 0.5) * 0.25;
      return [x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, r()];
    });
    const cracks = Array.from({ length: small ? 1 : 5 }, () => {
      let x = r() * w, y = r() * h;
      const pts: [number, number][] = [[x, y]];
      for (let i = 0; i < 14; i++) { x += 18 + r() * 36; y -= 10 + r() * 26; y += (r() - 0.5) * 14; pts.push([x, y]); }
      return pts;
    });
    return { scratch, cracks, hx: w * 0.3, hy: h * 0.7 };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    const tx = e.mouse ? e.mx : w * 0.1 + Math.sin(t * 0.2) * w * 0.05, ty = e.mouse ? e.my : h * 0.78 + Math.cos(t * 0.17) * h * 0.06;
    s.hx += (tx - s.hx) * 0.04; s.hy += (ty - s.hy) * 0.04;
    ctx.globalCompositeOperation = "lighter";
    const ang = -0.62;
    for (const [off, wid, a] of [[0, 0.8, 0.3], [-0.22, 0.5, 0.15], [0.3, 0.35, 0.11]] as const) {
      ctx.save();
      ctx.translate(s.hx + Math.cos(ang + 1.57) * off * h, s.hy + Math.sin(ang + 1.57) * off * h);
      ctx.rotate(ang);
      const bw = h * 0.22 * wid;
      const g = ctx.createLinearGradient(0, -bw, 0, bw);
      const al = e.alarm ? [0, 0, 0.5, 0.5, 0.3, 0, 0] : [0.0, 0.7, 0.9, 0.8, 0.7, 0.8, 0];
      const cols = e.alarm ? ["#ff2a2a", "#ff2a2a", "#ff4040", "#ff6060", "#ff3030", "#ff2a2a", "#ff2a2a"] : ["#ff3b30", "#ff3b30", "#ff9f0a", "#ffd60a", "#34c759", "#0a84ff", "#5e5ce6"];
      cols.forEach((c, i) => g.addColorStop(i / (cols.length - 1), rgba(...hex(c), al[i] * a)));
      ctx.fillStyle = g;
      ctx.fillRect(-w * 1.2, -bw, w * 2.4, bw * 2);
      ctx.restore();
    }
    const hot = ctx.createRadialGradient(s.hx, s.hy, 0, s.hx, s.hy, h * 0.18);
    hot.addColorStop(0, rgba(255, 250, 230, e.alarm ? 0.4 : 0.85)); hot.addColorStop(0.25, rgba(255, 200, 120, 0.35)); hot.addColorStop(1, rgba(255, 140, 60, 0));
    ctx.fillStyle = hot; ctx.beginPath(); ctx.arc(s.hx, s.hy, h * 0.18, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 0.7;
    for (const [x1, y1, x2, y2, k] of s.scratch) {
      const d = Math.hypot((x1 + x2) / 2 - s.hx, (y1 + y2) / 2 - s.hy);
      ctx.strokeStyle = rgba(255, 255, 255, 0.04 + Math.max(0, 1 - d / (h * 0.5)) * 0.22 * k);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    for (const c of s.cracks) {
      ctx.strokeStyle = rgba(255, 245, 220, 0.18); ctx.lineWidth = 1.1;
      ctx.beginPath(); c.forEach(([x, y]: number[], i: number) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    }
  },
};

// ─── Руны: светящиеся полосы узоров, энергия бежит, дух-вихрь ──────

function runeBand(H: number, bw: number, seed: number) {
  const r = rng(seed);
  const pad = 16;
  const c = document.createElement("canvas");
  c.width = bw + pad * 2; c.height = Math.max(1, H);
  const g = c.getContext("2d")!;
  g.translate(pad, 0);
  g.strokeStyle = "#a5f3fc"; g.fillStyle = "#a5f3fc";
  g.lineWidth = 2.4; g.lineJoin = "miter"; g.lineCap = "square";
  g.shadowColor = "#22d3ee"; g.shadowBlur = 12;
  g.strokeRect(1, 0, bw - 2, H);
  const cell = bw * 1.15;
  for (let y = 4, i = 0; y < H; y += cell, i++) {
    const cx = bw / 2, cy = y + cell / 2, s = bw * 0.36;
    const k = (r() * 5) | 0;
    g.beginPath();
    if (k === 0) for (let q = 0; q < 3; q++) { const o = q * s * 0.45; g.moveTo(cx - s, cy - s * 0.6 + o); g.lineTo(cx, cy + o - s * 0.1); g.lineTo(cx + s, cy - s * 0.6 + o); }
    else if (k === 1) { g.moveTo(cx, cy - s); g.lineTo(cx + s, cy); g.lineTo(cx, cy + s); g.lineTo(cx - s, cy); g.closePath(); g.moveTo(cx, cy - s * 0.45); g.lineTo(cx + s * 0.45, cy); g.lineTo(cx, cy + s * 0.45); g.lineTo(cx - s * 0.45, cy); g.closePath(); }
    else if (k === 2) { const a = s; g.moveTo(cx - a, cy + a); g.lineTo(cx - a, cy - a); g.lineTo(cx + a, cy - a); g.lineTo(cx + a, cy + a * 0.5); g.lineTo(cx - a * 0.4, cy + a * 0.5); g.lineTo(cx - a * 0.4, cy - a * 0.3); g.lineTo(cx + a * 0.4, cy - a * 0.3); }
    else if (k === 3) { g.arc(cx, cy, s * 0.9, 0, TAU); g.moveTo(cx - s * 0.9, cy); g.lineTo(cx + s * 0.9, cy); g.moveTo(cx, cy - s * 0.9); g.lineTo(cx, cy + s * 0.9); }
    else { g.moveTo(cx - s, cy - s); g.lineTo(cx + s, cy + s); g.moveTo(cx + s, cy - s); g.lineTo(cx - s, cy + s); g.moveTo(cx, cy - s * 0.4); g.lineTo(cx + s * 0.4, cy); g.lineTo(cx, cy + s * 0.4); g.lineTo(cx - s * 0.4, cy); g.closePath(); }
    g.stroke();
    if (i % 3 === 1) { g.fillRect(cx - 2, y + 2, 4, 4); }
  }
  return c;
}
const SPIRIT = [
  [[0.1, 0.95], [0.3, 0.7], [0.05, 0.5], [0.4, 0.32], [0.75, 0.42], [0.6, 0.62], [0.35, 0.55]],
  [[0.55, 0.98], [0.75, 0.8], [0.6, 0.66], [0.9, 0.5], [0.8, 0.28], [0.95, 0.12]],
];
const runes: Scene = {
  fps: 24, scale: 1, protect: 0.3,
  init(w, h, small) {
    const r = rng(83);
    const z = sideZone({ w, h });
    const bands = small
      ? [{ x: w - 34, y: 0, img: runeBand(h, 18, 3), ph: 0 }, { x: w - 62, y: 0, img: runeBand(h, 12, 9), ph: 1.7 }]
      : [{ x: 18, y: z.y - 6, img: runeBand(h - z.y - 60, 34, 3), ph: 0 }, { x: w - 52, y: 0, img: runeBand(h, 26, 9), ph: 2.1 }];
    return {
      r, bands, small, z,
      parts: [] as any[],
      petals: Array.from({ length: small ? 6 : 26 }, () => ({ x: r(), y: r(), s: 2 + r() * 4, ph: r() * TAU })),
    };
  },
  draw(ctx, s, e) {
    const { w, h, t, dt } = e;
    for (const b of s.bands) {
      const img = b.img as HTMLCanvasElement;
      const near = e.mouse && Math.abs(e.mx - (b.x + 16)) < 120 ? 0.35 : 0;
      ctx.globalAlpha = e.alarm ? 0.3 : 0.45 + near;
      ctx.drawImage(img, b.x - 16, b.y);
      // Волна энергии снизу вверх — быстрее при трафике.
      ctx.globalCompositeOperation = "lighter";
      const H = img.height, y0 = H - ((t * 110 * (1 + e.load) + b.ph * 200) % (H + 240)) + 120;
      for (let k = -5; k <= 5; k++) {
        const sy = y0 + k * 16;
        if (sy < 0 || sy + 16 > H) continue;
        ctx.globalAlpha = (1 - Math.abs(k) / 6) * (e.alarm ? 0.3 : 0.9);
        ctx.drawImage(img, 0, sy, img.width, 16, b.x - 16, b.y + sy, img.width, 16);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      if (s.r() < (s.small ? 0.2 : 0.6) && s.parts.length < 160) s.parts.push({ x: b.x + s.r() * (img.width - 32), y: b.y + s.r() * H, vy: -12 - s.r() * 24, vx: (s.r() - 0.5) * 8, life: 1, sz: 1 + s.r() * 2.2 });
    }
    ctx.globalCompositeOperation = "lighter";
    const cc: RGB = e.alarm ? [255, 90, 110] : [103, 232, 249];
    s.parts = s.parts.filter((p: any) => (p.life -= dt * 0.45) > 0);
    for (const p of s.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      ctx.fillStyle = rgba(cc[0], cc[1], cc[2], p.life * 0.9);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(0.785); ctx.fillRect(-p.sz / 2, -p.sz / 2, p.sz, p.sz); ctx.restore();
    }
    // Дух-вихрь: кисть рисует S-кривые, держит и гаснет.
    if (!s.small) {
      const z = s.z;
      const zones = [{ x: 60, y: z.y + 10, w: 150, h: z.h - 20 }, { x: w - 230, y: 30, w: 170, h: 200 }];
      SPIRIT.forEach((sp, i) => {
        const zn = zones[i];
        const cyc = (t * 0.22 + i * 0.5) % 1;
        const prog = clamp(cyc / 0.45, 0, 1), fade = cyc > 0.8 ? 1 - (cyc - 0.8) / 0.2 : 1;
        const path = smoothPath(sp, zn.w, zn.h, zn.x, zn.y);
        ctx.save();
        ctx.setLineDash([prog * 1400, 3000]);
        for (const [lw, a] of [[14, 0.08], [6, 0.25], [2.2, 0.9]] as const) {
          ctx.lineWidth = lw; ctx.lineCap = "round";
          ctx.strokeStyle = rgba(cc[0], cc[1], cc[2], a * fade);
          ctx.stroke(path);
        }
        ctx.restore();
      });
    }
    for (const p of s.petals) {
      const x = p.x * w, y = p.y * h, a = 0.25 + 0.5 * Math.abs(Math.sin(t * 0.8 + p.ph));
      ctx.fillStyle = rgba(cc[0], cc[1], cc[2], a * 0.6);
      for (let k = 0; k < 4; k++) { const an = k * 1.571 + t * 0.3; ctx.beginPath(); ctx.ellipse(x + Math.cos(an) * p.s, y + Math.sin(an) * p.s, p.s * 0.9, p.s * 0.45, an, 0, TAU); ctx.fill(); }
    }
    ctx.globalCompositeOperation = "source-over";
  },
};

// ─── Соты: шестигранники приподнимаются у курсора, переворачиваются ─

const hexgrid: Scene = {
  fps: 24, scale: 1, protect: 0.35,
  init(w, h, small) {
    const r = rng(97);
    const R = small ? 11 : 32, dx = Math.sqrt(3) * R, dy = 1.5 * R;
    const tiles: any[] = [];
    for (let row = -1; row * dy < h + R; row++) for (let col = -1; col * dx < w + R; col++) {
      const x = col * dx + (row % 2 ? dx / 2 : 0), y = row * dy;
      const fx = x / w;
      const p = small ? (fx - 0.68) * 3 : 1 - Math.hypot((1 - fx) * w, h - y) / (Math.min(w, h) * 0.62);
      if (p + (noise(x * 0.01, y * 0.01) - 0.5) * 0.9 < 0.25) continue;
      const cracks: number[][] = [];
      for (let k = 0; k < 2; k++) { const a = r() * TAU, l = R * (0.4 + r() * 0.6); cracks.push([x + Math.cos(a) * R * 0.2, y + Math.sin(a) * R * 0.2, x + Math.cos(a + 0.4) * l, y + Math.sin(a + 0.4) * l]); }
      tiles.push({ x, y, light: r() < 0.16, cracks, flip: -1, lift: 0, flipped: false });
    }
    const ink = Array.from({ length: small ? 20 : 170 }, () => {
      const tt = tiles[(r() * tiles.length) | 0] ?? { x: w, y: h };
      return { x: tt.x - r() * R * 4, y: tt.y + (r() - 0.5) * R * 3, r: Math.pow(r(), 3) * (small ? 3 : 9) + 0.6, a: 0.15 + r() * 0.4 };
    });
    const crack: number[][][] = [];
    for (let k = 0; k < (small ? 2 : 9); k++) {
      let x = r() * w * 0.5, y = r() * h;
      const pts = [[x, y]];
      for (let i = 0; i < 10; i++) { x += (r() - 0.3) * 50; y += (r() - 0.5) * 50; pts.push([x, y]); }
      crack.push(pts);
    }
    return { tiles, ink, crack, R, r, next: 0, burst: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt } = e;
    const R = s.R;
    ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 0.8;
    for (const c of s.crack) { ctx.beginPath(); c.forEach(([x, y]: number[], i: number) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
    for (const d of s.ink) { ctx.fillStyle = `rgba(210,210,210,${d.a.toFixed(2)})`; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill(); }
    if (t > s.next) { s.next = t + 0.5 + s.r() * 0.8 - e.load * 0.3; const tl = s.tiles[(s.r() * s.tiles.length) | 0]; if (tl && tl.flip < 0) tl.flip = 0; }
    const hexPath = (x: number, y: number, rr: number, sx = 1) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const px = x + Math.cos(a) * rr * sx, py = y + Math.sin(a) * rr; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
      ctx.closePath();
    };
    for (const tl of s.tiles) {
      const over = e.mouse && Math.hypot(tl.x - e.mx, tl.y - e.my) < R;
      if (over && !tl.hov && tl.flip < 0) tl.flip = 0;
      tl.hov = over;
      tl.lift += ((over ? 1 : 0) - tl.lift) * 0.2;
      let sx = 1;
      if (tl.flip >= 0) {
        tl.flip += dt / 0.6; sx = Math.abs(Math.cos(tl.flip * Math.PI));
        if (tl.flip > 0.5 && !tl.flipped) { tl.light = !tl.light; tl.flipped = true; }
        if (tl.flip >= 1) { tl.flip = -1; tl.flipped = false; }
      }
      const L = tl.lift * 5, x = tl.x - L, y = tl.y - L, rr = R - 2.5;
      hexPath(tl.x + 3, tl.y + 4, rr, sx); ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fill();
      hexPath(x, y, rr, sx);
      const g = ctx.createLinearGradient(x - R, y - R, x + R, y + R);
      const alarm = e.alarm && hash2(tl.x | 0, tl.y | 0) > 0.7;
      if (tl.light) { g.addColorStop(0, "#f4f4f4"); g.addColorStop(1, alarm ? "#a33" : "#9a9a9a"); }
      else { g.addColorStop(0, alarm ? "#4a1515" : `rgb(${44 + L * 4},${44 + L * 4},${46 + L * 4})`); g.addColorStop(1, "#0c0c0c"); }
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = tl.light ? "rgba(255,255,255,.9)" : `rgba(255,255,255,${(0.18 + tl.lift * 0.5).toFixed(2)})`;
      ctx.stroke();
      ctx.save(); ctx.clip();
      ctx.strokeStyle = tl.light ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.22)"; ctx.lineWidth = 0.7;
      ctx.beginPath(); for (const [a, b, c, d] of tl.cracks) { ctx.moveTo(a - L, b - L); ctx.lineTo(c - L, d - L); } ctx.stroke();
      ctx.restore();
    }
    // Щелчок — брызги туши разлетаются и оседают.
    if (newClick(s, e) && s.burst.length < 300) for (let i = 0; i < 40; i++) { const a = s.r() * TAU, v = 60 + s.r() * 320; s.burst.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.pow(s.r(), 2) * 6 + 0.8, life: 1 }); }
    s.burst = s.burst.filter((b: any) => (b.life -= dt * 0.18) > 0);
    for (const b of s.burst) { b.vx *= 0.9; b.vy *= 0.9; b.x += b.vx * dt; b.y += b.vy * dt; ctx.fillStyle = `rgba(225,225,225,${(b.life * 0.6).toFixed(2)})`; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill(); }
  },
};

// ─── Цветение: светящиеся цветы раскрываются, треснувшая маска ─────

const bloom: Scene = {
  fps: 24, scale: 1, protect: 0.3,
  init(w, h, small) {
    const r = rng(101);
    const z = sideZone({ w, h });
    const spots = small
      ? [[w - 40, h * 0.6, 22], [w - 110, h * 0.85, 16], [w - 180, h * 0.45, 12], [w * 0.5, h * 0.95, 12]]
      : [[60, h - 70, 40], [150, h - 150, 30], [40, z.y + 210, 24], [176, z.y + 120, 20], [w - 80, h - 80, 46], [w - 200, h - 46, 28], [w - 46, h - 210, 26], [w - 60, 120, 22]];
    const flowers = spots.map(([x, y, s]) => ({ x, y, s, n: r() < 0.5 ? 5 : 6, ph: r() * TAU, rot: r() * TAU }));
    const vines = flowers.map((f) => ({ x0: f.x + (r() - 0.5) * 60, y0: h + 10, c1: [f.x + (r() - 0.5) * 120, h - (h - f.y) * 0.3], c2: [f.x + (r() - 0.5) * 80, f.y + 40], f, leaves: [0.35, 0.6, 0.8].map((k) => ({ k, side: r() < 0.5 ? -1 : 1, s: 8 + r() * 10 })) }));
    const motes = Array.from({ length: small ? 18 : 140 }, () => ({ x: r() * w, y: r() * h, v: 6 + r() * 16, a: r(), s: r() < 0.15 ? 3 : 1.2 }));
    const crack: number[][][] = [];
    for (let k = 0; k < 6; k++) {
      let x = (r() - 0.5) * 40, y = -60 + r() * 40;
      const pts = [[x, y]];
      for (let i = 0; i < 6; i++) { x += (r() - 0.5) * 22; y += 12 + r() * 14; pts.push([x, y]); }
      crack.push(pts);
    }
    return { flowers, vines, motes, crack, z, small, r };
  },
  draw(ctx, s, e) {
    const { w, h, t, dt } = e;
    const green: RGB = e.alarm ? [255, 90, 100] : [74, 222, 128], cyan: RGB = e.alarm ? [255, 140, 150] : [56, 189, 248];
    // Маска под навигацией: фарфор с трещинами, свет сквозь трещины.
    if (!s.small) {
      const mx = 104, my = s.z.y + s.z.h - 150;
      ctx.save(); ctx.translate(mx, my); ctx.rotate(-0.2 + Math.sin(t * 0.3) * 0.03);
      const face = new Path2D();
      face.moveTo(0, -78); face.bezierCurveTo(46, -78, 58, -30, 52, 6); face.bezierCurveTo(46, 50, 22, 78, 0, 80); face.bezierCurveTo(-22, 78, -46, 50, -52, 6); face.bezierCurveTo(-58, -30, -46, -78, 0, -78);
      const g = ctx.createLinearGradient(-50, -80, 50, 80);
      g.addColorStop(0, "#dfe7df"); g.addColorStop(0.55, "#8e9c90"); g.addColorStop(1, "#2f3a31");
      ctx.fillStyle = g; ctx.globalAlpha = 0.85; ctx.fill(face); ctx.globalAlpha = 1;
      const sh = ctx.createRadialGradient(-12, -20, 10, 0, 0, 80);
      sh.addColorStop(0, "rgba(255,255,255,.25)"); sh.addColorStop(1, "rgba(0,0,0,.45)");
      ctx.fillStyle = sh; ctx.fill(face);
      ctx.fillStyle = "#020402";
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * 20, -14, 13, 6, sx * 0.15, 0, TAU); ctx.fill(); }
      ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.quadraticCurveTo(4, 14, -2, 26); ctx.stroke();
      ctx.strokeStyle = "rgba(20,30,20,.6)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-12, 42); ctx.quadraticCurveTo(0, 38, 12, 42); ctx.moveTo(-10, 44); ctx.quadraticCurveTo(0, 50, 10, 44); ctx.stroke();
      ctx.globalCompositeOperation = "lighter";
      const pulse = 0.6 + 0.4 * Math.sin(t * 1.5);
      for (const [lw, a] of [[5, 0.15], [1.2, 0.9]] as const) {
        ctx.lineWidth = lw; ctx.strokeStyle = rgba(green[0], green[1], green[2], a * pulse);
        for (const c of s.crack) { ctx.beginPath(); c.forEach(([x, y]: number[], i: number) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.restore();
      // Подпись — разреженный серифный шрифт, как на постере.
      ctx.textBaseline = "top";
      ctx.font = `400 26px Georgia, Cambria, serif`;
      const tg = ctx.createLinearGradient(24, 0, 200, 0);
      tg.addColorStop(0, "#bef264"); tg.addColorStop(1, "#7dd3fc");
      ctx.fillStyle = tg;
      "W P X".split("").forEach((c, i) => ctx.fillText(c, 26 + i * 18, s.z.y + 8));
      ctx.font = `9px Georgia, Cambria, serif`;
      ctx.fillStyle = "rgba(214,200,140,.75)";
      ctx.fillText("“EVERYONE WANTS PRIVACY,", 26, s.z.y + 48);
      ctx.fillText(" PREFERABLY FROM SOMEONE ELSE.”", 26, s.z.y + 62);
    }
    for (const v of s.vines) {
      const f = v.f;
      ctx.strokeStyle = "rgba(34,120,70,.75)"; ctx.lineWidth = s.small ? 1 : 2.2;
      ctx.beginPath(); ctx.moveTo(v.x0, v.y0); ctx.bezierCurveTo(v.c1[0], v.c1[1], v.c2[0], v.c2[1], f.x, f.y); ctx.stroke();
      for (const l of v.leaves) {
        const k = l.k, mt = 1 - k;
        const x = mt ** 3 * v.x0 + 3 * mt * mt * k * v.c1[0] + 3 * mt * k * k * v.c2[0] + k ** 3 * f.x;
        const y = mt ** 3 * v.y0 + 3 * mt * mt * k * v.c1[1] + 3 * mt * k * k * v.c2[1] + k ** 3 * f.y;
        ctx.save(); ctx.translate(x, y); ctx.rotate(l.side * 0.9 + Math.sin(t + k * 5) * 0.12);
        const ls = l.s * (s.small ? 0.45 : 1);
        const lg = ctx.createLinearGradient(0, 0, l.side * ls * 2, 0);
        lg.addColorStop(0, "rgba(22,101,52,.95)"); lg.addColorStop(1, "rgba(74,222,128,.75)");
        ctx.fillStyle = lg;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(l.side * ls, -ls * 0.6, l.side * ls * 2, 0); ctx.quadraticCurveTo(l.side * ls, ls * 0.6, 0, 0); ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = "lighter";
    for (const f of s.flowers) {
      const open = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.35 + f.ph)) + (e.mouse && Math.hypot(e.mx - f.x, e.my - f.y) < 140 ? 0.25 : 0);
      const size = f.s * (s.small ? 0.5 : 1);
      glow(ctx, f.x, f.y, size * 2.2, green, 0.35, 0.3);
      ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot + Math.sin(t * 0.5 + f.ph) * 0.08); ctx.scale(1, 0.72);
      for (let i = 0; i < f.n; i++) {
        ctx.save(); ctx.rotate((i / f.n) * TAU);
        const L = size * open, W = size * 0.42;
        const pg = ctx.createRadialGradient(0, 0, 0, 0, 0, L);
        pg.addColorStop(0, "rgba(255,255,255,.95)"); pg.addColorStop(0.3, rgba(187, 247, 208, 0.8)); pg.addColorStop(0.7, rgba(green[0], green[1], green[2], 0.6)); pg.addColorStop(1, rgba(cyan[0], cyan[1], cyan[2], 0.35));
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(L * 0.3, -W, L * 0.9, -W * 0.6, L, 0); ctx.bezierCurveTo(L * 0.9, W * 0.6, L * 0.3, W, 0, 0); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      glow(ctx, f.x, f.y, size * 0.45, [255, 255, 255], 0.9);
    }
    for (const m of s.motes) {
      m.y -= m.v * dt * (1 + e.load); m.x += Math.sin(t + m.a * 9) * 6 * dt;
      if (m.y < -4) { m.y = h + 4; m.x = s.r() * w; }
      const a = 0.2 + 0.6 * Math.abs(Math.sin(t * 1.3 + m.a * 11));
      if (m.s > 2) { ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(t + m.a * 6); ctx.fillStyle = rgba(green[0], green[1], green[2], a * 0.7); ctx.fillRect(-m.s / 2, -m.s, m.s, m.s * 2); ctx.restore(); }
      else { ctx.fillStyle = rgba(green[0], green[1], green[2], a); ctx.fillRect(m.x, m.y, m.s, m.s); }
    }
    ctx.globalCompositeOperation = "source-over";
  },
};

// ─── Кибер-HUD: пиксельные панели, глобусы, загрузка, предупреждения ─

const hud: Scene = {
  fps: 24, scale: 1, protect: 0.3,
  init(w, h, small) {
    const r = rng(113);
    const grain = document.createElement("canvas");
    grain.width = grain.height = 128;
    const g = grain.getContext("2d")!, img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = r() < 0.5 ? 14 : 0; }
    g.putImageData(img, 0, 0);
    const scratches = Array.from({ length: small ? 3 : 24 }, () => [r() * w, r() * h, (r() - 0.5) * 40, (r() - 0.5) * 60]);
    return { grain, scratches, small, z: sideZone({ w, h }), r };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    const C = e.alarm ? "#ff4d5e" : "#22d3ee", Cr: RGB = hex(C);
    const pat = ctx.createPattern(s.grain, "repeat");
    if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, w, h); }
    ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 0.8;
    ctx.beginPath(); for (const [x, y, dx, dy] of s.scratches) { ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); } ctx.stroke();
    const bevel = (x: number, y: number, ww: number, hh: number, c = 10) => {
      ctx.beginPath(); ctx.moveTo(x + c, y); ctx.lineTo(x + ww, y); ctx.lineTo(x + ww, y + hh - c); ctx.lineTo(x + ww - c, y + hh); ctx.lineTo(x, y + hh); ctx.lineTo(x, y + c); ctx.closePath();
    };
    const neon = (fn: () => void, lw = 2) => {
      ctx.strokeStyle = rgba(Cr[0], Cr[1], Cr[2], 0.18); ctx.lineWidth = lw * 4; fn(); ctx.stroke();
      ctx.strokeStyle = C; ctx.lineWidth = lw; fn(); ctx.stroke();
    };
    const globe = (cx: number, cy: number, R: number, ph: number) => {
      neon(() => { ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); }, 1.6);
      ctx.strokeStyle = C; ctx.lineWidth = 1.4;
      for (let k = 0; k < 4; k++) { const a = ((ph + k / 4) % 1) * Math.PI; const rx = Math.abs(Math.cos(a)) * R; ctx.beginPath(); ctx.ellipse(cx, cy, rx, R, 0, 0, TAU); ctx.stroke(); }
      for (const yy of [-0.5, 0, 0.5]) { const ry = yy * R, rx = Math.sqrt(R * R - ry * ry); ctx.beginPath(); ctx.moveTo(cx - rx, cy + ry); ctx.lineTo(cx + rx, cy + ry); ctx.stroke(); }
    };
    if (s.small) {
      const gy = h > 80 ? h - 26 : h * 0.5, gr = h > 80 ? 11 : 14;
      for (let i = 0; i < 3; i++) globe(w - 30 - i * (gr * 2 + 10), gy, gr, t * 0.2 + i * 0.15);
      const pw = 120, filled = Math.floor(((t * 4) % 20));
      for (let i = 0; i < 20; i++) if (i < filled) { ctx.fillStyle = C; ctx.fillRect(w - 160 + i * (pw / 20), h - 14, pw / 20 - 2, 6); }
      return;
    }
    const z = s.z;
    // Панель «SECURE LINK».
    const px = z.x, py = z.y, pw = z.w;
    neon(() => bevel(px, py, pw, 118));
    ctx.fillStyle = C; ctx.fillRect(px + 74, py + 6, pw - 80, 18);
    pixText(ctx, e.alarm ? "LINK LOST" : "SECURE LINK", px + 84, py + 9, 7, "#001018");
    ctx.fillStyle = C;
    ctx.beginPath(); ctx.moveTo(px + 30, py + 10); ctx.lineTo(px + 48, py + 40); ctx.lineTo(px + 12, py + 40); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#001018"; ctx.fillRect(px + 28, py + 20, 4, 11); ctx.fillRect(px + 28, py + 34, 4, 3);
    ctx.font = "9px Segoe UI, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.textBaseline = "top";
    ["What is this tunnel about? We do not", "know. Do we want to leak? Probably", "not. Then what do we do? Encrypt", "it in the best possible way."].forEach((l, i) => ctx.fillText(l, px + 12, py + 50 + i * 12));
    for (let i = 0; i < 3; i++) globe(px + 34 + i * 62, py + 156, 24, t * 0.15 + i * 0.12);
    // Загрузка: заполняется по трафику, при обрыве — ERROR.
    const by = py + 196;
    neon(() => { ctx.beginPath(); ctx.rect(px, by, pw, 22); }, 1.6);
    const segs = 18, fill = e.alarm ? Math.floor(((t * 3) % 2)) * segs : Math.floor((((t * (0.5 + e.load * 2)) % 1.4) / 1.4) * segs);
    for (let i = 0; i < fill; i++) { ctx.fillStyle = rgba(Cr[0], Cr[1], Cr[2], 0.85); ctx.fillRect(px + 4 + i * ((pw - 70) / segs), by + 4, (pw - 70) / segs - 3, 14); }
    pixText(ctx, e.alarm ? "ERROR" : "LOADING...", px + pw - 62, by + 6, 6, "#ffffff");
    // Предупреждающие полосы — бегут.
    ctx.save(); ctx.beginPath(); ctx.rect(px, by + 30, pw, 16); ctx.clip();
    ctx.fillStyle = rgba(Cr[0], Cr[1], Cr[2], 0.85);
    const off = (t * 30) % 16;
    for (let x = -20; x < pw + 20; x += 16) { ctx.beginPath(); ctx.moveTo(px + x + off, by + 46); ctx.lineTo(px + x + 8 + off, by + 30); ctx.lineTo(px + x + 14 + off, by + 30); ctx.lineTo(px + x + 6 + off, by + 46); ctx.fill(); }
    ctx.restore();
    // WARNING / задержка.
    const wy = by + 58;
    if (wy + 40 < z.y + z.h + 40) {
      ctx.save(); bevel(px, wy, pw, 40, 8); ctx.clip();
      ctx.fillStyle = rgba(Cr[0], Cr[1], Cr[2], 0.85); ctx.fillRect(px, wy, pw, 40);
      ctx.strokeStyle = "rgba(0,16,24,.55)"; ctx.lineWidth = 6;
      for (let x = -40; x < pw + 40; x += 18) { ctx.beginPath(); ctx.moveTo(px + x, wy + 40); ctx.lineTo(px + x + 40, wy); ctx.stroke(); }
      ctx.restore();
      if (Math.sin(t * 5) > -0.3) {
        ctx.fillStyle = rgba(Cr[0], Cr[1], Cr[2], 1); ctx.fillRect(px + 22, wy + 9, pw - 44, 22);
        pixText(ctx, e.alarm ? "NO SIGNAL" : e.ms ? `RTT ${e.ms}MS` : "WARNING", px + 30, wy + 12, 8, "#001018");
      }
    }
    ctx.fillStyle = rgba(Cr[0], Cr[1], Cr[2], 0.7);
    for (let y = 0; y < h; y += 14) ctx.fillRect(w - 12, y + ((t * 20) % 14), 4, 7);
    pixText(ctx, "ERROR 404", w - 130, h - 30, 7, rgba(Cr[0], Cr[1], Cr[2], 0.6));
  },
};

// ─── Осколки: фиолетовый квадрат разлетается и собирается ────────

function shatter(side: number, r: () => number, n: number) {
  let polys: Poly[] = [[[-side / 2, -side / 2], [side / 2, -side / 2], [side / 2, side / 2], [-side / 2, side / 2]]];
  while (polys.length < n) {
    polys.sort((a, b) => area(b) - area(a));
    const p = polys.shift()!;
    const a = r() * Math.PI;
    const cx = p.reduce((s, q) => s + q[0], 0) / p.length, cy = p.reduce((s, q) => s + q[1], 0) / p.length;
    const [u, v] = splitPoly(p, cx + (r() - 0.5) * 8, cy + (r() - 0.5) * 8, Math.cos(a), Math.sin(a));
    polys.push(u, v);
  }
  return polys.filter((p) => p.length >= 3).map((p) => {
    const cx = p.reduce((s, q) => s + q[0], 0) / p.length, cy = p.reduce((s, q) => s + q[1], 0) / p.length;
    const d = Math.hypot(cx, cy) || 1;
    return { p: p.map(([x, y]) => [x - cx, y - cy]), cx, cy, dx: cx / d, dy: cy / d, sp: 0.6 + r() * 0.9, rot: (r() - 0.5) * 3, tone: r() };
  });
}
const shards: Scene = {
  fps: 30, scale: 1, protect: 0.28,
  init(w, h, small) {
    const r = rng(127);
    const z = sideZone({ w, h });
    const items: any[] = small
      ? [{ x: w - Math.min(h * 0.6, 64) * 0.8, y: h > 80 ? h - 40 : h * 0.5, side: Math.min(h * 0.6, 64), ph: 0 }]
      : [{ x: z.x + z.w / 2, y: z.y + Math.min(z.h, 330) / 2 + 20, side: 140, ph: 0 }];
    for (const it of items) {
      it.shards = shatter(it.side, r, small ? 10 : 22);
      it.circuit = Array.from({ length: small ? 4 : 12 }, () => { const x = (r() - 0.5) * it.side * 0.8, y = (r() - 0.5) * it.side * 0.8; return [x, y, x + (r() - 0.5) * it.side * 0.5, y + (r() - 0.5) * it.side * 0.5]; });
      it.kick = -10;
    }
    const rain = Array.from({ length: small ? 6 : 40 }, () => ({ x: r() * w, y: r() * h, v: 30 + r() * 80, l: 20 + r() * 80 }));
    const bits = Array.from({ length: small ? 6 : 30 }, () => ({ x: r() * w, y: r() * h, s: 4 + r() * 14, ph: r() * TAU, fill: r() < 0.4 }));
    return { items, rain, bits, r, small };
  },
  draw(ctx, s, e) {
    const { w, h, t, dt } = e;
    const P: RGB = e.alarm ? [255, 90, 110] : [192, 132, 252], Cy: RGB = [45, 212, 191];
    ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(Cy[0], Cy[1], Cy[2], 0.25);
    ctx.beginPath();
    for (const d of s.rain) {
      d.y += d.v * dt * (1 + e.load * 2); if (d.y - d.l > h) { d.y = -10; d.x = s.r() * w; }
      ctx.moveTo(d.x, d.y - d.l); ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const b of s.bits) {
      const a = 0.2 + 0.4 * Math.abs(Math.sin(t * 0.7 + b.ph));
      if (b.fill) { ctx.fillStyle = rgba(P[0], P[1], P[2], a * 0.6); ctx.fillRect(b.x, b.y, b.s, b.s); }
      else { ctx.strokeStyle = rgba(Cy[0], Cy[1], Cy[2], a); ctx.strokeRect(b.x, b.y, b.s, b.s); }
    }
    const clk = newClick(s, e) ? e.click : null;
    for (const it of s.items) {
      // Цикл: собран → разлёт → парит → сборка. Щелчок рядом — разлёт сразу.
      if (clk && Math.hypot(clk.x - it.x, clk.y - it.y) < it.side * 3) it.kick = t;
      const L = 7, c = ((t / L + it.ph) % 1) * L;
      let k = c < 3 ? 0 : c < 4.4 ? easeIO((c - 3) / 1.4) : c < 5.6 ? 1 : 1 - easeIO((c - 5.6) / 1.4);
      const ka = t - it.kick;
      if (ka < 2.4) k = Math.max(k, ka < 0.5 ? easeIO(ka / 0.5) : 1 - easeIO(clamp((ka - 1.2) / 1.2, 0, 1)));
      if (e.alarm) k = Math.max(k, 0.25 + 0.1 * Math.sin(t * 9));
      ctx.save(); ctx.translate(it.x, it.y);
      for (const sh of it.shards) {
        let push = 0;
        if (e.mouse) { const d = Math.hypot(e.mx - (it.x + sh.cx), e.my - (it.y + sh.cy)); push = clamp(1 - d / 140, 0, 1) * 0.12; }
        const kk = Math.max(k, push);
        const dist = kk * it.side * 0.9 * sh.sp;
        ctx.save(); ctx.translate(sh.cx + sh.dx * dist, sh.cy + sh.dy * dist); ctx.rotate(sh.rot * kk);
        const path = new Path2D();
        sh.p.forEach(([x, y]: number[], i: number) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
        path.closePath();
        ctx.fillStyle = rgba(P[0] + sh.tone * 30, P[1] + sh.tone * 20, P[2], 0.85 - kk * 0.25);
        ctx.fill(path);
        ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 0.8; ctx.stroke(path);
        ctx.save(); ctx.clip(path); ctx.translate(-sh.cx, -sh.cy);
        ctx.strokeStyle = rgba(Cy[0], Cy[1], Cy[2], 0.8); ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of it.circuit) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y2); ctx.rect(x2 - 2, y2 - 2, 4, 4); }
        ctx.stroke();
        ctx.restore();
        ctx.restore();
      }
      ctx.restore();
      if (k < 0.05) { ctx.globalCompositeOperation = "lighter"; glow(ctx, it.x, it.y, it.side * 0.7, P, 0.25, 0.1); ctx.globalCompositeOperation = "source-over"; }
    }
  },
};

// ─── Ретро-ПК: красный каркас компьютера вращается, PRESS ANY KEY ───

const PC = (() => {
  const v: number[][] = [], ed: number[][] = [];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const b = v.length;
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) v.push([x, y, z]);
    for (const [a, c] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) ed.push([b + a, b + c]);
  };
  const quad = (pts: number[][]) => { const b = v.length; pts.forEach((p) => v.push(p)); for (let i = 0; i < pts.length; i++) ed.push([b + i, b + ((i + 1) % pts.length)]); };
  // Системный блок, монитор на нём, клавиатура спереди.
  box(-1, 0, -0.6, 1, 0.34, 0.4);
  quad([[0.3, 0.1, 0.4], [0.8, 0.1, 0.4], [0.8, 0.17, 0.4], [0.3, 0.17, 0.4]]);
  quad([[-0.85, 0.1, 0.4], [-0.6, 0.1, 0.4], [-0.6, 0.22, 0.4], [-0.85, 0.22, 0.4]]);
  box(-0.75, 0.34, -0.55, 0.75, 1.4, 0.3);
  quad([[-0.62, 0.48, 0.3], [0.62, 0.48, 0.3], [0.62, 1.27, 0.3], [-0.62, 1.27, 0.3]]);
  const screen = v.length;
  quad([[-0.52, 0.56, 0.3], [0.52, 0.56, 0.3], [0.52, 1.19, 0.3], [-0.52, 1.19, 0.3]]);
  box(-1, 0, 0.55, 1, 0.1, 1.05);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) { const x = -0.92 + c * 0.155, z = 0.62 + r * 0.13; quad([[x, 0.1, z], [x + 0.12, 0.1, z], [x + 0.12, 0.1, z + 0.1], [x, 0.1, z + 0.1]]); }
  quad([[-0.5, 0.1, 0.94], [0.5, 0.1, 0.94], [0.5, 0.1, 1.0], [-0.5, 0.1, 1.0]]);
  return { v: v.map(([x, y, z]) => [x, y - 0.6, z - 0.2]), ed, screen: [screen, screen + 1, screen + 2, screen + 3] };
})();
const retro: Scene = {
  fps: 20, scale: 1, protect: 0.3,
  init(w, h, small) {
    return { z: sideZone({ w, h }), small, typed: 0 };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    const R = e.alarm ? "#ff6b6b" : "#ff2a2a";
    const flick = 0.85 + 0.15 * Math.sin(t * 50) * Math.sin(t * 7);
    const cx = s.small ? (h > 80 ? w - 56 : w - h * 0.9) : s.z.x + s.z.w / 2, cy = s.small ? (h > 80 ? h - 44 : h * 0.52) : s.z.y + 240, S = s.small ? Math.min(h * 0.3, 22) : 62;
    const yaw = -0.6 + Math.sin(t * 0.35) * 0.55 + (e.mouse ? (e.mx / w - 0.5) * 0.8 : 0), pitch = 0.35 + Math.sin(t * 0.23) * 0.08;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const pr = PC.v.map(([x, y, z]) => {
      const x1 = x * cyw - z * syw, z1 = x * syw + z * cyw;
      const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const f = 4 / (4 + z2);
      return [cx + x1 * S * f, cy - y1 * S * f];
    });
    ctx.globalCompositeOperation = "lighter";
    for (const [lw, a] of [[5, 0.12], [1.3, 0.95]] as const) {
      ctx.strokeStyle = R; ctx.globalAlpha = a * flick; ctx.lineWidth = s.small ? lw * 0.6 : lw;
      ctx.beginPath();
      for (const [i, j] of PC.ed) { ctx.moveTo(pr[i][0], pr[i][1]); ctx.lineTo(pr[j][0], pr[j][1]); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // На экране модели — строки и мигающий курсор.
    const [a0, a1, , a3] = PC.screen.map((i) => pr[i]);
    const at = (u: number, q: number) => [a0[0] + (a1[0] - a0[0]) * u + (a3[0] - a0[0]) * q, a0[1] + (a1[1] - a0[1]) * u + (a3[1] - a0[1]) * q];
    ctx.strokeStyle = R; ctx.lineWidth = 1; ctx.globalAlpha = 0.7 * flick;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) { const len = 0.3 + hash2(k, Math.floor(t)) * 0.5; const [x1, y1] = at(0.1, 0.8 - k * 0.15), [x2, y2] = at(0.1 + len, 0.8 - k * 0.15); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    ctx.stroke();
    if (Math.sin(t * 4) > 0) { const [x, y] = at(0.1, 0.2); ctx.fillStyle = R; ctx.fillRect(x, y - 5, 5, 7); }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (!s.small) {
      const x = s.z.x + 4, y = s.z.y + 340;
      ctx.textBaseline = "top";
      ctx.globalAlpha = flick;
      ctx.font = "bold 17px Consolas, monospace"; ctx.fillStyle = R;
      ctx.fillText("WPX-70", x, y);
      ctx.fillStyle = "#000"; ctx.fillRect(x + 84, y - 3, 100, 24);
      ctx.font = "15px MS Gothic, Yu Gothic, sans-serif"; ctx.fillStyle = R;
      ctx.fillText("コンピュータ", x + 90, y);
      const lines = ["TUNNEL & LINK", `  PROTO  ${e.alarm ? "----" : "ACTIVE"}`, `  RTT    ${e.ms ?? "--"} ms`, `  LOAD   ${(e.load * 100).toFixed(0)}%`, "MEMORY", "  KEYS   256K bytes", "  LOGS   0 bytes"];
      s.typed = (s.typed + e.dt * 30) % 260;
      let left = s.typed;
      ctx.font = "10px Consolas, monospace";
      lines.forEach((l, i) => { if (left > 0) ctx.fillText(l.slice(0, Math.floor(left)), x + 6, y + 30 + i * 13); left -= l.length + 3; });
      if (Math.sin(t * 3) > 0) { ctx.font = "bold 10px Consolas, monospace"; ctx.fillText("PRESS ANY KEY", x + 6, y + 30 + lines.length * 13 + 10); }
      ctx.globalAlpha = 1;
    }
    // Развёртка кинескопа.
    if (!s.small) {
      const z = s.z;
      // BIOS: строки печатаются и держатся, цикл — 30 с.
      const boot = ["WPX-70 BIOS v1.07", "(C) 1987 WPX SYSTEMS", "", "MEMORY TEST  640K OK", "TUNNEL ....... OK", "DNS ...... REMOTE", "LEAKS ........ 0", "BOOT WPX.SYS", `RTT ${e.ms ?? "--"} MS`, "A:\\> _"];
      const shown = Math.floor((t % 30) * 2.2);
      ctx.font = "10px Consolas, monospace"; ctx.textBaseline = "top"; ctx.fillStyle = R;
      boot.slice(0, shown).forEach((l, i) => ctx.fillText(l, z.x + 4, z.y + 8 + i * 13));
      // Синтвейв-пол: солнце в полосках на горизонте, сетка бежит к зрителю.
      const hz = h - 150, vx = z.x + z.w / 2;
      const sun = ctx.createLinearGradient(0, hz - 60, 0, hz);
      sun.addColorStop(0, "#ffb340"); sun.addColorStop(1, "#ff2a6a");
      ctx.save(); ctx.beginPath(); ctx.rect(z.x - 16, hz - 70, z.w + 24, 70); ctx.clip();
      ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(vx, hz, 54, Math.PI, 0); ctx.fill();
      ctx.fillStyle = "#02021a"; for (let k = 0; k < 5; k++) ctx.fillRect(vx - 60, hz - 8 - k * 9, 120, 2 + k * 0.6);
      ctx.restore();
      ctx.strokeStyle = "rgba(255,42,42,.55)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = -8; k <= 8; k++) { ctx.moveTo(vx + k * 6, hz); ctx.lineTo(vx + k * 46, h); }
      for (let k = 0; k < 8; k++) { const f = ((k + (t * 0.6) % 1) / 8) ** 2, y = hz + f * (h - hz); ctx.moveTo(z.x - 16, y); ctx.lineTo(z.x + z.w + 8, y); }
      ctx.stroke();
      ctx.fillStyle = "rgba(255,42,42,.9)"; ctx.fillRect(z.x - 16, hz, z.w + 24, 1);
    }
    // На экране модели — график задержки.
    if (!s.hist) s.hist = [] as number[];
    if (!s.histT || t - s.histT > 0.5) { s.histT = t; s.hist.push(e.ms ?? 0); if (s.hist.length > 24) s.hist.shift(); }
    {
      const [b0, b1, , b3] = PC.screen.map((i) => pr[i]);
      const at2 = (u: number, q: number) => [b0[0] + (b1[0] - b0[0]) * u + (b3[0] - b0[0]) * q, b0[1] + (b1[1] - b0[1]) * u + (b3[1] - b0[1]) * q];
      const mx2 = Math.max(400, ...s.hist);
      ctx.strokeStyle = R; ctx.lineWidth = 1.2; ctx.beginPath();
      s.hist.forEach((v: number, i: number) => { const [x, y] = at2(0.1 + (i / 23) * 0.8, 0.15 + (v / mx2) * 0.7); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
    scanlines(ctx, w, h, 0.28);
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,10,.55)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  },
};

// ─── Редактор: код печатается с подсветкой, светится как на ЭЛТ ────

const SRC = (ms: number | null) => [
  "// Tunnel simulation", "// main.cpp — wpx", '#include "tunnel.h" // for privacy', "",
  "int main()", "{", "    // Beginning of new session", "    Tunnel* t = new Tunnel(REALITY);", "",
  "    // loop while is alive", "    while (!t->blocked())", "    {", "        t->keep_alive();",
  `        // rtt: ${ms ?? "—"} ms`, "        if (t->rtt() < slow && t->leaks() == 0)", "        {",
  "            me->all_is_OK = true;", "        }", "        else", "        {", "            t->switch_to(reserve);", "        }",
  "    }", "    delete t; // no logs left", "}",
];
const KW = /^(int|while|if|else|delete|new|return|true|false)$/;
function tokens(line: string): [string, string][] {
  if (/^\s*\/\//.test(line)) return [[line, "c"]];
  if (line.startsWith("#")) { const [a, b] = line.split("//"); return b === undefined ? [[a, "p"]] : [[a, "p"], ["//" + b, "c"]]; }
  const out: [string, string][] = [];
  const re = /(\/\/.*$)|("[^"]*")|(\b[A-Z][A-Za-z_]*\b\*?)|(\w+(?=\())|(\b\w+\b)|([{}()])|(\S)|(\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const s = m[0];
    out.push([s, m[1] ? "c" : m[2] ? "s" : m[3] ? "t" : m[4] ? "f" : m[5] ? (KW.test(s) ? "k" : /^(me|t)$/.test(s) ? "v" : "n") : m[6] ? "b" : m[7] ? "o" : " "]);
  }
  return out;
}
const SYN: Record<string, string> = { k: "#ff5a4f", t: "#ffb340", f: "#ffd76a", c: "#8a8a8a", p: "#4ade80", s: "#f0abfc", v: "#fde68a", n: "#e5e5e5", b: "#2dd4bf", o: "#2dd4bf", " ": "#fff" };
const editor: Scene = {
  fps: 20, scale: 1, protect: 0.3,
  init(_w, _h, small) { return { typed: 0, small }; },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    const src = SRC(e.ms);
    const total = src.reduce((a, l) => a + l.length + 2, 0);
    s.typed += e.dt * (26 + e.load * 40);
    if (s.typed > total + 120) s.typed = 0;
    const draw = (x0: number, y0: number, fs: number, lh: number, alpha: number, maxY: number) => {
      ctx.font = `${fs}px "Cascadia Code", "Cascadia Mono", Consolas, monospace`;
      ctx.textBaseline = "top";
      const cw = ctx.measureText("M").width;
      let left = s.typed, y = y0;
      for (const line of src) {
        if (left <= 0 || y > maxY) break;
        let x = x0, n = Math.floor(left);
        for (const [tok, k] of tokens(line)) {
          if (n <= 0) break;
          const part = tok.slice(0, n);
          ctx.fillStyle = e.alarm && k !== "c" ? "#ff5a5a" : SYN[k];
          ctx.globalAlpha = alpha * (k === "c" ? 0.75 : 1);
          ctx.fillText(part, x, y);
          x += part.length * cw; n -= tok.length;
        }
        if (left < line.length && Math.sin(t * 7) > 0) { ctx.globalAlpha = alpha; ctx.fillStyle = "#fff"; ctx.fillRect(x + 1, y, cw * 0.9, fs + 1); }
        left -= line.length + 2; y += lh;
      }
      ctx.globalAlpha = 1;
    };
    if (s.small) { draw(w * 0.42, 8, 5, 7, 0.55, h); return; }
    const z = sideZone(e);
    ctx.save();
    ctx.shadowColor = "rgba(255,170,80,.6)"; ctx.shadowBlur = 6;
    draw(z.x + 2, z.y + 6, 8.2, 12.4, 0.95, z.y + z.h);
    ctx.restore();
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    draw(w * 0.56, 40, 13, 21, 0.13, h);
    ctx.restore();
    // Миникарта: строки кода цветными штрихами, рамка «экрана» ползёт за печатью.
    const mx = w - 74;
    let shown = s.typed, typedLine = 0;
    src.forEach((line, i) => {
      let x = mx;
      for (const [tok, k] of tokens(line)) {
        if (k === " ") { x += tok.length * 1.3; continue; }
        ctx.fillStyle = SYN[k]; ctx.globalAlpha = shown > 0 ? 0.55 : 0.12;
        ctx.fillRect(x, 64 + i * 4, tok.length * 1.3, 2);
        x += tok.length * 1.3;
      }
      if (shown > 0) typedLine = i;
      shown -= line.length + 2;
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,179,64,.5)"; ctx.lineWidth = 1;
    ctx.strokeRect(mx - 4, 60 + Math.max(0, typedLine - 6) * 4, 62, 30);
    const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.45)");
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  },
};

// ─── Нет сигнала: вертикальные помехи, ERR_NAME_NOT_RESOLVED ────────

const FILE_ICON = ["0011111110", "0010000011", "0010000001", "0010010101", "0010000001", "0010011001", "0010100101", "0010000001", "0011111111"];
const nosignal: Scene = {
  fps: 24, scale: 1, protect: 0.25,
  init(w, h, small) {
    const r = rng(139);
    const cols = Array.from({ length: small ? 14 : 110 }, () => {
      const k = r();
      return { x: r() * w, w: r() < 0.85 ? 1 : 2 + r() * 10, c: k < 0.75 ? [200, 200, 200] : k < 0.88 ? [255, 50, 60] : [40, 220, 220], a: 0.04 + r() * (k < 0.75 ? 0.12 : 0.5), y: r() * h, l: 30 + r() * h * 0.6, v: (r() - 0.5) * 30 };
    });
    const dots = document.createElement("canvas");
    dots.width = 2; dots.height = 3;
    const d = dots.getContext("2d")!; d.fillStyle = "rgba(255,255,255,.18)"; d.fillRect(0, 0, 1, 1);
    return { cols, dots, small, z: sideZone({ w, h }), r };
  },
  draw(ctx, s, e) {
    const { h, t, dt } = e;
    const pat = s.pat ?? (s.pat = ctx.createPattern(s.dots, "repeat"));
    for (const c of s.cols) {
      c.y += c.v * dt * (1 + e.load * 2); if (c.y > h) c.y = -c.l; if (c.y < -c.l) c.y = h;
      const fl = hash2(c.x | 0, Math.floor(t * 12)) > 0.08 ? 1 : 0.2;
      if (c.w > 3 && pat) { ctx.fillStyle = pat; ctx.globalAlpha = c.a * 3 * fl; ctx.fillRect(c.x, 0, c.w, h); ctx.globalAlpha = 1; continue; }
      ctx.fillStyle = rgba(c.c[0], c.c[1], c.c[2], c.a * fl * (e.alarm ? 1.6 : 1));
      ctx.fillRect(c.x, c.y, c.w, c.l);
    }
    // Курсор рвёт сигнал: возле него вспыхивают цветные полосы.
    if (e.mouse && s.r() < 0.5) {
      const x = e.mx + (s.r() - 0.5) * 80;
      ctx.fillStyle = s.r() < 0.5 ? "rgba(255,50,60,.5)" : "rgba(40,220,220,.5)";
      ctx.fillRect(x, 0, 1 + s.r() * 2, h);
    }
    if (s.small) return;
    const z = s.z, x0 = 26, y0 = z.y + 30, px = 6;
    const off = 1.5 + (hash2(2, Math.floor(t * 8)) > 0.85 ? 4 : 0);
    for (const [dx, col] of [[-off, "rgba(255,40,60,.8)"], [off, "rgba(40,230,230,.8)"], [0, "#fff"]] as const) {
      ctx.fillStyle = col;
      FILE_ICON.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === "1") ctx.fillRect(x0 + x * px + dx, y0 + y * px, px, px); }));
    }
    ctx.font = "600 15px Segoe UI, sans-serif"; ctx.textBaseline = "top";
    rgbText(ctx, "This wallpaper", x0, y0 + 74, off * 0.7);
    rgbText(ctx, "is not available", x0, y0 + 94, off * 0.7);
    ctx.font = "10px Segoe UI, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.fillText(e.alarm ? "ERR_CONNECTION_RESET" : "ERR_NAME_NOT_RESOLVED", x0, y0 + 122);
  },
};

// ─── Разбитый экран: трещины от удара, полосы матрицы ─────────────

function impact(x: number, y: number, r: () => number, R: number) {
  const rays: number[][][] = [];
  const n = 12 + ((r() * 6) | 0);
  for (let i = 0; i < n; i++) {
    let a = (i / n) * TAU + (r() - 0.5) * 0.3, px = x, py = y;
    const pts = [[px, py]];
    const L = R * (0.4 + r() * 0.8);
    for (let d = 0; d < L; d += 14 + r() * 20) { a += (r() - 0.5) * 0.25; px += Math.cos(a) * 18; py += Math.sin(a) * 18; pts.push([px, py]); }
    rays.push(pts);
  }
  const rings = [0.12, 0.25, 0.42].map((k) => k * R);
  return { x, y, rays, rings, born: -10 };
}
const cracked: Scene = {
  fps: 24, scale: 1, protect: 0.35,
  init(w, h, small) {
    const r = rng(151);
    const main = impact(small ? w * 0.9 : w * 0.95, small ? h * 0.22 : h * 0.9, r, small ? Math.min(h * 1.2, 160) : h * 0.9);
    const lines = Array.from({ length: small ? 20 : 160 }, () => ({ y: r() * h * 0.75, x0: r() * w * 0.4, x1: w * (0.5 + r() * 0.5), c: ["#ff3b3b", "#22c55e", "#3b82f6", "#22d3ee", "#e879f9", "#f8fafc", "#facc15"][(r() * 7) | 0], a: 0.2 + r() * 0.5, h: r() < 0.8 ? 1 : 2 }));
    const bars = Array.from({ length: small ? 10 : 70 }, () => ({ x: w * (0.55 + r() * 0.45), y0: h * (0.55 + r() * 0.2), c: ["#3b82f6", "#e879f9", "#22d3ee", "#f8fafc"][(r() * 4) | 0], a: 0.15 + r() * 0.5 }));
    return { impacts: [main], lines, bars, r, small };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    if (newClick(s, e)) { const im = impact(e.click!.x, e.click!.y, s.r, s.small ? h : h * 0.45); im.born = t; s.impacts.push(im); if (s.impacts.length > 5) s.impacts.splice(1, 1); }
    // Полосы матрицы: мерцают и сдвигаются, при обрыве — краснеют.
    const jit = hash2(1, Math.floor(t * 6)) > 0.85 ? (hash2(2, Math.floor(t * 6)) - 0.5) * 20 : 0;
    for (const l of s.lines) {
      if (hash2(l.y | 0, Math.floor(t * 10)) < 0.1) continue;
      ctx.fillStyle = e.alarm && l.c !== "#f8fafc" ? "#ff3b3b" : l.c; ctx.globalAlpha = l.a * 0.6;
      ctx.fillRect(l.x0 + jit, l.y, l.x1 - l.x0, l.h);
    }
    for (const b of s.bars) {
      ctx.fillStyle = b.c; ctx.globalAlpha = b.a * (0.6 + 0.4 * Math.sin(t * 3 + b.x));
      ctx.fillRect(b.x, b.y0, 1, h - b.y0);
    }
    const bleed = ctx.createLinearGradient(0, h * 0.65, 0, h);
    bleed.addColorStop(0, "rgba(200,220,255,0)"); bleed.addColorStop(1, "rgba(160,190,255,.18)");
    ctx.globalAlpha = 1; ctx.fillStyle = bleed; ctx.fillRect(w * 0.35, h * 0.65, w * 0.65, h * 0.35);
    // Трещины: от новых ударов растут за 0.4 с.
    for (const im of s.impacts) {
      const grow = clamp((t - im.born) / 0.4, 0, 1);
      ctx.strokeStyle = "rgba(235,240,255,.75)"; ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (const ray of im.rays) { const n = Math.max(2, Math.floor(ray.length * grow)); ray.slice(0, n).forEach(([x, y]: number[], i: number) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); }
      ctx.stroke();
      ctx.strokeStyle = "rgba(235,240,255,.35)"; ctx.lineWidth = 0.7;
      for (const R of im.rings) {
        ctx.beginPath();
        for (let a = 0; a < TAU; a += 0.35) {
          const rr = R * grow * (0.85 + hash2((a * 10) | 0, R | 0) * 0.3);
          if (hash2((a * 7) | 0, (R * 3) | 0) > 0.35) { ctx.moveTo(im.x + Math.cos(a) * rr, im.y + Math.sin(a) * rr); ctx.lineTo(im.x + Math.cos(a + 0.3) * rr, im.y + Math.sin(a + 0.3) * rr); }
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "lighter";
      glow(ctx, im.x, im.y, 18, [200, 220, 255], 0.8);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
  },
};

// ─── Взгляд: розовая рамка, глаза следят за курсором, моргают ──────

const anime: Scene = {
  fps: 24, scale: 1, protect: 0.25,
  init(w, h, small) {
    const z = sideZone({ w, h });
    const fw = Math.min(w * 0.28, h * 1.7), fh = fw * 0.38;
    const fr = small ? { x: w - fw - 8, y: h > 80 ? h - fh - 18 : (h - fh) / 2, w: fw, h: fh } : { x: z.x + 2, y: z.y + 30, w: 192, h: 98 };
    return { fr, small, blink: -1, nextBlink: 2, r: rng(173) };
  },
  draw(ctx, s, e) {
    const { w, h, t } = e;
    const PINK = e.alarm ? "#ff3b3b" : "#ff1f73", LIGHT = e.alarm ? "#ff9a9a" : "#ff7aa6";
    scanlines(ctx, w, h, 0.25);
    const f = s.fr;
    if (t > s.nextBlink) { s.blink = t; s.nextBlink = t + 2.5 + s.r() * 3; }
    const bk = t - s.blink < 0.18 ? 1 - Math.abs((t - s.blink) / 0.09 - 1) : 0;
    ctx.save();
    ctx.beginPath(); ctx.rect(f.x + 6, f.y + 6, f.w - 12, f.h - 12); ctx.clip();
    ctx.fillStyle = PINK; ctx.fillRect(f.x, f.y, f.w, f.h);
    // Тень волос.
    ctx.fillStyle = "#14060b";
    ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x + f.w * 0.55, f.y); ctx.quadraticCurveTo(f.x + f.w * 0.3, f.y + f.h * 0.3, f.x, f.y + f.h * 0.75); ctx.closePath(); ctx.fill();
    const eye = (cx: number, cy: number, sw: number, sh: number) => {
      const lookX = e.mouse ? clamp((e.mx - cx) / 300, -1, 1) : Math.sin(t * 0.4) * 0.6;
      const lookY = e.mouse ? clamp((e.my - cy) / 300, -1, 1) : Math.cos(t * 0.3) * 0.3;
      const open = 1 - bk;
      ctx.save();
      const shape = new Path2D();
      shape.moveTo(cx - sw, cy); shape.quadraticCurveTo(cx - sw * 0.2, cy - sh * 1.4 * open, cx + sw, cy - sh * 0.3 * open);
      shape.quadraticCurveTo(cx + sw * 0.1, cy + sh * 0.9 * open, cx - sw, cy);
      ctx.fillStyle = LIGHT; ctx.fill(shape);
      ctx.clip(shape);
      const ix = cx + lookX * sw * 0.35, iy = cy - sh * 0.15 + lookY * sh * 0.25, ir = sh * 0.95;
      const ig = ctx.createRadialGradient(ix, iy - ir * 0.3, 0, ix, iy, ir);
      ig.addColorStop(0, "#3b0a1c"); ig.addColorStop(0.7, "#14030a"); ig.addColorStop(1, "#000");
      ctx.fillStyle = ig; ctx.beginPath(); ctx.arc(ix, iy, ir, 0, TAU); ctx.fill();
      ctx.strokeStyle = PINK; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(ix, iy, ir * 0.72, 0.3, 2.6); ctx.stroke();
      ctx.fillStyle = "#fff0f6";
      ctx.beginPath(); ctx.arc(ix - ir * 0.35, iy - ir * 0.35, ir * 0.22, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(ix + ir * 0.3, iy + ir * 0.25, ir * 0.1, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "#0b0207"; ctx.lineWidth = s.small ? 1.6 : 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(cx - sw * 1.05, cy + 1); ctx.quadraticCurveTo(cx - sw * 0.2, cy - sh * 1.45 * open, cx + sw * 1.05, cy - sh * 0.3 * open); ctx.stroke();
      ctx.lineWidth = s.small ? 0.8 : 1.4;
      for (let k = 0; k < 5; k++) { const u = 0.4 + k * 0.15; const lx = cx - sw + u * sw * 2, ly = cy - sh * (1.2 - u * 0.6) * open; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + sw * 0.12, ly - sh * 0.35); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(cx - sw * 0.6, cy + sh * 0.5 * open); ctx.quadraticCurveTo(cx + sw * 0.2, cy + sh * 0.75 * open, cx + sw * 0.8, cy + sh * 0.1); ctx.stroke();
    };
    eye(f.x + f.w * 0.3, f.y + f.h * 0.55, f.w * 0.17, f.h * 0.2);
    eye(f.x + f.w * 0.76, f.y + f.h * 0.62, f.w * 0.13, f.h * 0.16);
    ctx.strokeStyle = "#0b0207"; ctx.lineWidth = 1.2;
    for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.moveTo(f.x + f.w * (0.45 + k * 0.08), f.y); ctx.quadraticCurveTo(f.x + f.w * (0.5 + k * 0.08), f.y + f.h * 0.3, f.x + f.w * (0.42 + k * 0.1), f.y + f.h * (0.5 + k * 0.05)); ctx.stroke(); }
    ctx.fillStyle = "rgba(0,0,0,.18)";
    for (let y = f.y; y < f.y + f.h; y += 2) ctx.fillRect(f.x, y, f.w, 1);
    ctx.restore();
    ctx.strokeStyle = PINK; ctx.lineWidth = s.small ? 1 : 1.6;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    if (!s.small) {
      ctx.fillStyle = PINK; ctx.textBaseline = "top";
      ctx.font = "16px Yu Gothic, MS Gothic, sans-serif";
      ctx.fillRect(f.x + 40, f.y + f.h + 22, 8, 1.5);
      ctx.fillText("綺麗な", f.x + 70, f.y + f.h + 13);
      // Вертикальная строка у правого края: знаки по очереди вспыхивают.
      const col = "綺麗な世界を見ている";
      ctx.font = "15px Yu Gothic, MS Gothic, sans-serif";
      [...col].forEach((c, i) => {
        const hi = Math.floor(t * 4) % (col.length + 4) === i;
        ctx.fillStyle = hi ? "#ffd1e2" : "rgba(255,45,122,.3)";
        ctx.fillText(c, w - 30, 80 + i * 22);
      });
      // «Запись» над рамкой: мигающая точка и счётчик.
      if (Math.sin(t * 3) > 0) { ctx.beginPath(); ctx.arc(f.x + 6, f.y - 11, 3.5, 0, TAU); ctx.fill(); }
      ctx.font = "10px Consolas, monospace"; ctx.fillStyle = "rgba(255,209,226,.8)";
      const sec = Math.floor(t);
      ctx.fillText(`REC ${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`, f.x + 14, f.y - 16);
      ctx.fillText(e.ms ? `${e.ms} ms` : "— ms", f.x + f.w - 44, f.y - 16);
      // Панель 2: линии скорости сходятся к центру, «ドキドキ» бьётся как сердце.
      const p2 = { x: f.x, y: f.y + f.h + 52, w: f.w, h: 118 };
      ctx.save(); ctx.beginPath(); ctx.rect(p2.x, p2.y, p2.w, p2.h); ctx.clip();
      ctx.fillStyle = "#0a1a10"; ctx.fillRect(p2.x, p2.y, p2.w, p2.h);
      const pcx = p2.x + p2.w / 2, pcy = p2.y + p2.h / 2;
      ctx.strokeStyle = "rgba(255,45,122,.55)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 48; k++) { const a = (k / 48) * TAU + hash2(k, Math.floor(t * 8)) * 0.05, r0 = 26 + hash2(k, 3) * 20; ctx.moveTo(pcx + Math.cos(a) * r0, pcy + Math.sin(a) * r0); ctx.lineTo(pcx + Math.cos(a) * 200, pcy + Math.sin(a) * 200); }
      ctx.stroke();
      const beat = 1 + 0.12 * Math.max(0, Math.sin(t * 7.5)) * (Math.floor(t * 1.2) % 2 ? 1 : 0.4);
      ctx.save(); ctx.translate(pcx, pcy); ctx.scale(beat, beat); ctx.rotate(-0.08);
      ctx.font = "900 26px Yu Gothic, MS Gothic, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 4; ctx.strokeStyle = "#050b07"; ctx.strokeText("ドキドキ", 0, 0); ctx.fillStyle = "#ff7aa6"; ctx.fillText("ドキドキ", 0, 0);
      ctx.restore(); ctx.restore();
      ctx.strokeStyle = PINK; ctx.lineWidth = 1.6; ctx.strokeRect(p2.x, p2.y, p2.w, p2.h);
      // Панель 3: растровая точка градиентом, сердечки поднимаются.
      const p3 = { x: f.x, y: p2.y + p2.h + 16, w: f.w, h: 110 };
      if (p3.y + p3.h < h - 70) {
        ctx.save(); ctx.beginPath(); ctx.rect(p3.x, p3.y, p3.w, p3.h); ctx.clip();
        for (let yy = 0; yy < p3.h; yy += 7) for (let xx = 0; xx < p3.w; xx += 7) {
          const k = 1 - yy / p3.h, r0 = 3.2 * k * (0.6 + 0.4 * Math.sin(t * 1.5 + xx * 0.05));
          if (r0 < 0.3) continue;
          ctx.fillStyle = "rgba(255,45,122,.7)"; ctx.beginPath(); ctx.arc(p3.x + xx + (yy % 14 ? 3.5 : 0), p3.y + yy, r0, 0, TAU); ctx.fill();
        }
        for (let k = 0; k < 5; k++) { const yy = p3.y + p3.h - ((t * 20 + k * 30) % (p3.h + 20)), xx = p3.x + 20 + k * 36; ctx.fillStyle = "#ffd1e2"; heart(ctx, xx, yy, 5); }
        ctx.restore();
        ctx.strokeStyle = PINK; ctx.lineWidth = 1.6; ctx.strokeRect(p3.x, p3.y, p3.w, p3.h);
      }
      // Уголки видоискателя вокруг рамки.
      ctx.strokeStyle = PINK; ctx.lineWidth = 1.5;
      for (const [cx, cy, sx, sy] of [[f.x - 6, f.y - 6, 1, 1], [f.x + f.w + 6, f.y - 6, -1, 1], [f.x - 6, f.y + f.h + 6, 1, -1], [f.x + f.w + 6, f.y + f.h + 6, -1, -1]]) {
        ctx.beginPath(); ctx.moveTo(cx, cy + sy * 10); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * 10, cy); ctx.stroke();
      }
      // Лепестки-искры, редкие и медленные.
      ctx.globalCompositeOperation = "lighter";
      for (let k = 0; k < 14; k++) {
        const x = (hash2(k, 1) * w + t * 8 * (1 + hash2(k, 2))) % w, y = (hash2(k, 3) * h + t * 14) % h;
        const a = 0.3 + 0.5 * Math.abs(Math.sin(t + k));
        ctx.fillStyle = rgba(255, 90, 150, a * 0.6);
        ctx.save(); ctx.translate(x, y); ctx.rotate(t + k); ctx.fillRect(-2, -1, 4, 2); ctx.restore();
      }
      ctx.globalCompositeOperation = "source-over";
    }
  },
};

// ─── Разлом: трещина в космос, контуры вокруг ────────────────────

const rift: Scene = {
  fps: 20, scale: 1, protect: 0.3,
  init(w, h, small) {
    const r = rng(163);
    const g = small ? 8 : 14, cols = Math.ceil(w / g) + 1, rows = Math.ceil(h / g) + 1;
    const val: number[] = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) val.push(fbm(x * g * 0.005, y * g * 0.005, 3));
    const segs: number[] = [];
    for (let lv = 0.36; lv < 0.66; lv += 0.045) for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
      const a = val[y * cols + x], b = val[y * cols + x + 1], c = val[(y + 1) * cols + x + 1], d = val[(y + 1) * cols + x];
      const P: number[][] = [];
      const edge = (v1: number, v2: number, x1: number, y1: number, x2: number, y2: number) => { if ((v1 < lv) !== (v2 < lv)) { const k = (lv - v1) / (v2 - v1); P.push([(x1 + (x2 - x1) * k) * g, (y1 + (y2 - y1) * k) * g]); } };
      edge(a, b, x, y, x + 1, y); edge(b, c, x + 1, y, x + 1, y + 1); edge(c, d, x + 1, y + 1, x, y + 1); edge(d, a, x, y + 1, x, y);
      if (P.length >= 2) segs.push(P[0][0], P[0][1], P[1][0], P[1][1]);
      if (P.length === 4) segs.push(P[2][0], P[2][1], P[3][0], P[3][1]);
    }
    const crack: { x: number; y: number; wd: number }[] = [];
    let x = small ? w * 0.97 : w * 0.995, y = -10;
    const ex = small ? w * 0.82 : w * 0.86;
    while (y < h + 20) { crack.push({ x, y, wd: (small ? 3 : 6) + r() * (small ? 6 : 16) }); y += 14 + r() * 18; x += (ex - x) * 0.06 + (r() - 0.5) * 24; }
    const stars = Array.from({ length: small ? 30 : 220 }, () => ({ i: (r() * (crack.length - 1)) | 0, u: r() - 0.5, f: r(), a: r() }));
    const frags = Array.from({ length: small ? 4 : 14 }, () => {
      const p = crack[(r() * crack.length) | 0], n = 4 + ((r() * 3) | 0), sz = (small ? 2 : 5) + r() * (small ? 4 : 12);
      return { x: p.x + (r() - 0.5) * 140, y: p.y, rot: r() * TAU, vr: (r() - 0.5) * 0.4, vy: (r() - 0.5) * 6, pts: Array.from({ length: n }, (_, i) => { const a = (i / n) * TAU, rr = sz * (0.6 + r() * 0.5); return [Math.cos(a) * rr, Math.sin(a) * rr]; }) };
    });
    return { segs: new Float32Array(segs), crack, stars, sparks: [] as any[], r, small, frags };
  },
  draw(ctx, s, e) {
    const { t, dt } = e;
    if (!s.lines || s.linesAlarm !== e.alarm) {
      const k = Math.min(window.devicePixelRatio || 1, 2);
      const c = s.lines ?? document.createElement("canvas");
      c.width = Math.ceil(e.w * k); c.height = Math.ceil(e.h * k);
      const g = c.getContext("2d")!;
      g.scale(k, k);
      g.strokeStyle = e.alarm ? "rgba(255,120,120,.08)" : "rgba(255,255,255,.075)"; g.lineWidth = 0.8;
      g.beginPath();
      const S = s.segs;
      for (let i = 0; i < S.length; i += 4) { g.moveTo(S[i], S[i + 1]); g.lineTo(S[i + 2], S[i + 3]); }
      g.stroke();
      s.lines = c; s.linesAlarm = e.alarm;
    }
    ctx.drawImage(s.lines, 0, 0, e.w, e.h);
    const L = s.crack;
    const left: number[][] = [], right: number[][] = [];
    const breathe = 1 + 0.15 * Math.sin(t * 1.2) + e.load * 0.3 + (e.click && e.click.age < 1 ? (1 - e.click.age) * 0.6 : 0);
    for (const p of L) { left.push([p.x - (p.wd * breathe) / 2, p.y]); right.push([p.x + (p.wd * breathe) / 2, p.y]); }
    const path = new Path2D();
    [...left, ...right.reverse()].forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();
    // Свет из трещины падает косыми лучами влево.
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < L.length; i += 3) {
      const p = L[i], len = (s.small ? 60 : 240) + hash2(i, 7) * (s.small ? 60 : 260), a = (0.03 + 0.03 * Math.sin(t * 0.7 + i)) * (e.alarm ? 0.5 : 1);
      const g = ctx.createLinearGradient(p.x, p.y, p.x - len, p.y + len * 0.25);
      g.addColorStop(0, e.alarm ? rgba(255, 90, 100, a) : rgba(255, 236, 190, a)); g.addColorStop(1, "rgba(255,236,190,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x - len, p.y + len * 0.25 - 26); ctx.lineTo(p.x - len, p.y + len * 0.25 + 26); ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.save(); ctx.clip(path);
    const neb = ctx.createLinearGradient(L[0].x, 0, L[L.length - 1].x, e.h);
    neb.addColorStop(0, "#0b0420"); neb.addColorStop(0.5, e.alarm ? "#3a0610" : "#1a0b3a"); neb.addColorStop(1, "#04020c");
    ctx.fillStyle = neb; ctx.fillRect(0, 0, e.w, e.h);
    for (const st of s.stars) {
      const p = L[st.i];
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * (1 + st.f * 2) + st.a * 9));
      ctx.fillStyle = `rgba(255,255,255,${tw.toFixed(2)})`;
      ctx.fillRect(p.x + st.u * p.wd, p.y + ((st.f * 24 + t * 4) % 24), st.f > 0.92 ? 2 : 1, st.f > 0.92 ? 2 : 1);
    }
    ctx.restore();
    let md = 1e9;
    if (e.mouse) for (const p of L) md = Math.min(md, Math.hypot(p.x - e.mx, p.y - e.my));
    const near = clamp(1 - md / 220, 0, 1);
    const c: RGB = e.alarm ? [255, 90, 100] : [255, 236, 190];
    ctx.globalCompositeOperation = "lighter";
    for (const [lw, a] of [[16, 0.06], [5, 0.22], [1.6, 0.9]] as const) { ctx.lineWidth = lw; ctx.strokeStyle = rgba(c[0], c[1], c[2], a * (0.75 + near * 0.6)); ctx.stroke(path); }
    if (s.r() < 0.5 + near && s.sparks.length < 160) { const p = L[(s.r() * L.length) | 0]; s.sparks.push({ x: p.x + ((s.r() < 0.5 ? -1 : 1) * p.wd) / 2, y: p.y, vx: (s.r() - 0.5) * 40, vy: (s.r() - 0.5) * 40, life: 1 }); }
    s.sparks = s.sparks.filter((p: any) => (p.life -= dt * 0.6) > 0);
    for (const p of s.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; glow(ctx, p.x, p.y, 4, c, p.life * 0.8); }
    ctx.globalCompositeOperation = "source-over";
    // Обломки парят у трещины, бок к свету — золотой.
    for (const f of s.frags) {
      f.rot += f.vr * dt; f.y += Math.sin(t * 0.5 + f.x) * 0.15 + f.vy * dt * 0.1;
      if (e.mouse) { const dx = f.x - e.mx, dy = f.y - e.my, d = Math.hypot(dx, dy); if (d < 120 && d > 1) { f.x += (dx / d) * 0.8; f.y += (dy / d) * 0.8; } }
      ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
      ctx.fillStyle = "#0c0a10"; ctx.beginPath(); f.pts.forEach(([x, y]: number[], i: number) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = rgba(c[0], c[1], c[2], 0.55); ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.globalCompositeOperation = "source-over";
  },
};

// ─── Курсор и щелчок по темам ────────────────────────────────────
// Вместо круга света у каждой темы свой отклик: прицел, пиксельный след,
// руны, пыльца, паутинки, микротрещины… Щелчок (и по вкладке) — свой всплеск.

type Fx = (ctx: CanvasRenderingContext2D, s: any, e: Env) => void;
const fxs = (s: any) => (s.__fx ??= { parts: [] as any[], marks: [] as any[], next: 0 });
function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, l: number) {
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(x + sx * r, y + sy * (r - l)); ctx.lineTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * (r - l), y + sy * r);
  }
  ctx.stroke();
}
function heart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath(); ctx.moveTo(x, y + s * 0.7);
  ctx.bezierCurveTo(x - s * 1.3, y - s * 0.2, x - s * 0.55, y - s * 1.2, x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.55, y - s * 1.2, x + s * 1.3, y - s * 0.2, x, y + s * 0.7);
  ctx.fill();
}
function star4(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y); ctx.quadraticCurveTo(x, y, x, y - r); ctx.fill();
}
/** Частицы: двигаются, гаснут; `draw` рисует каждую. */
function stepParts(F: any, e: Env, decay: number, g: number, draw: (p: any) => void) {
  F.parts = F.parts.filter((p: any) => (p.life -= e.dt * decay) > 0);
  for (const p of F.parts) { p.vy += g * e.dt; p.x += p.vx * e.dt; p.y += p.vy * e.dt; draw(p); }
}
/** Двигался ли курсор за последний кадр (по следу). */
const moving = (e: Env) => e.mouse && e.trail.length > 1 && e.trail[e.trail.length - 1][2] < 0.05;

const FX: Partial<Record<SceneId, Fx>> = {
  // Сеть: щелчок — вспышка соседних узлов и пакеты от точки.
  plexus(_ctx, s, e) {
    const F = fxs(s);
    if (newClick(F, e)) for (const p of s.pts) if (Math.hypot(p.x - e.click!.x, p.y - e.click!.y) < 180) p.fl = 1;
  },
  // Код: координаты курсора, щелчок — брызги символов.
  ascii(ctx, s, e) {
    const F = fxs(s);
    ctx.font = `${e.small ? 8 : 11}px "Cascadia Mono", Consolas, monospace`; ctx.textBaseline = "top";
    if (e.mouse && !e.small) { ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillText(`[${(e.mx / 9) | 0}:${(e.my / 15) | 0}]`, e.mx + 12, e.my + 10); }
    if (newClick(F, e)) for (let i = 0; i < 36; i++) { const a = s.r() * TAU, v = 60 + s.r() * 220; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 }); }
    stepParts(F, e, 1.3, 0, (p) => { ctx.fillStyle = rgba(200, 255, 220, p.life); ctx.fillText(RAMP[(hash2(p.x | 0, (e.t * 12) | 0) * (RAMP.length - 1) + 1) | 0], p.x, p.y); });
  },
  // Спектр: за курсором осыпаются цветные символы.
  spectrum(ctx, s, e) {
    const F = fxs(s);
    if (moving(e) && F.parts.length < 300) for (let i = 0; i < 2; i++) F.parts.push({ x: e.mx + (s.r() - 0.5) * 10, y: e.my, vx: (s.r() - 0.5) * 30, vy: 10 + s.r() * 30, life: 1, c: SPEC[(s.r() * SPEC.length) | 0], g: GLYPHS[(s.r() * GLYPHS.length) | 0] });
    if (newClick(F, e)) for (let i = 0; i < 40; i++) { const a = s.r() * TAU, v = 80 + s.r() * 240; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, c: SPEC[i % SPEC.length], g: GLYPHS[i % GLYPHS.length] }); }
    ctx.font = `${e.small ? 7 : 11}px "Cascadia Mono", Consolas, monospace`; ctx.textBaseline = "top";
    stepParts(F, e, 0.9, 60, (p) => { ctx.globalAlpha = p.life; ctx.fillStyle = p.c; ctx.fillText(p.g, p.x, p.y); });
    ctx.globalAlpha = 1;
  },
  // Сбой: щелчок рвёт кадр на всю ширину.
  glitch(_ctx, s, e) {
    const F = fxs(s);
    if (newClick(F, e)) for (let i = 0; i < 14; i++) s.blocks.push({ x: s.r() * e.w * 0.3, y: e.click!.y + (s.r() - 0.5) * 90, w: e.w * (0.3 + s.r() * 0.7), h: 2 + s.r() * 12, red: s.r() < 0.5, life: 0.2 + s.r() * 0.3, born: e.t, mosaic: s.r() < 0.3 });
  },
  // Постер: метка совмещения у курсора, щелчок — красная полоса.
  poster(ctx, s, e) {
    const F = fxs(s);
    if (e.mouse && !e.small) {
      ctx.strokeStyle = "rgba(225,29,72,.85)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(e.mx - 16, e.my); ctx.lineTo(e.mx - 6, e.my); ctx.moveTo(e.mx + 6, e.my); ctx.lineTo(e.mx + 16, e.my); ctx.moveTo(e.mx, e.my - 16); ctx.lineTo(e.mx, e.my - 6); ctx.moveTo(e.mx, e.my + 6); ctx.lineTo(e.mx, e.my + 16); ctx.stroke();
      ctx.font = "9px Cascadia Mono, Consolas, monospace"; ctx.fillStyle = "rgba(255,255,255,.6)"; ctx.textBaseline = "top";
      ctx.fillText("ID: UNKNOWN", e.mx + 12, e.my + 10);
    }
    if (newClick(F, e)) F.bar = { y: e.click!.y, t: e.t };
    if (F.bar && e.t - F.bar.t < 0.5) { const k = (e.t - F.bar.t) / 0.5; ctx.fillStyle = rgba(225, 29, 72, 0.7 * (1 - k)); ctx.fillRect(0, F.bar.y - 2, e.w * easeIO(Math.min(1, k * 2)), 4); }
  },
  // Голограмма: щелчок — стайка маленьких бабочек разлетается.
  holo(ctx, s, e) {
    const F = fxs(s);
    if (newClick(F, e)) for (let i = 0; i < (e.small ? 5 : 14); i++) { const a = s.r() * TAU, v = 60 + s.r() * 200; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 1, ph: s.r() * TAU, sz: (e.small ? 3 : 6) + s.r() * 5, blue: s.r() < 0.5 }); }
    ctx.globalCompositeOperation = "lighter";
    stepParts(F, e, 0.55, -20, (p) => {
      p.vx *= 0.985; p.vy *= 0.985;
      const flap = Math.abs(Math.sin(e.t * 16 + p.ph)), c: RGB = p.blue ? [34, 211, 238] : [255, 122, 214];
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(p.vy, p.vx) + Math.PI / 2);
      ctx.fillStyle = rgba(c[0], c[1], c[2], p.life * 0.85);
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(side * p.sz * 0.55 * flap, -p.sz * 0.2, p.sz * 0.6 * flap + 0.5, p.sz * 0.75, side * 0.5, 0, TAU); ctx.fill(); }
      ctx.restore();
      glow(ctx, p.x, p.y, p.sz * 1.6, c, p.life * 0.5);
    });
    ctx.globalCompositeOperation = "source-over";
  },
  // Дисперсия: щелчок — радужные лучи из точки.
  dispersion(ctx, s, e) {
    const F = fxs(s);
    if (newClick(F, e)) F.burst = { x: e.click!.x, y: e.click!.y, t: e.t };
    if (!F.burst || e.t - F.burst.t > 0.8) return;
    const k = (e.t - F.burst.t) / 0.8, cols = ["#ff3b30", "#ff9f0a", "#ffd60a", "#34c759", "#0a84ff", "#5e5ce6"];
    ctx.globalCompositeOperation = "lighter"; ctx.lineWidth = 2;
    cols.forEach((c, i) => {
      const a = -0.62 + (i - 2.5) * 0.06, r0 = 10 + k * 40, r1 = 40 + k * 260;
      ctx.strokeStyle = rgba(...hex(c), (1 - k) * 0.9);
      ctx.beginPath(); ctx.moveTo(F.burst.x + Math.cos(a) * r0, F.burst.y + Math.sin(a) * r0); ctx.lineTo(F.burst.x + Math.cos(a) * r1, F.burst.y + Math.sin(a) * r1); ctx.stroke();
    });
    ctx.globalCompositeOperation = "source-over";
  },
  // Руны: за курсором остаются гаснущие знаки, щелчок — рунный круг.
  runes(ctx, s, e) {
    const F = fxs(s);
    const cc: RGB = e.alarm ? [255, 90, 110] : [103, 232, 249];
    if (moving(e) && e.t > F.next) { F.next = e.t + 0.06; F.marks.push({ x: e.mx, y: e.my, t: e.t, k: (s.r() * 4) | 0, rot: s.r() * TAU }); }
    F.marks = F.marks.filter((m: any) => e.t - m.t < 1.1);
    ctx.globalCompositeOperation = "lighter"; ctx.lineWidth = 1.2;
    for (const m of F.marks) {
      const a = 1 - (e.t - m.t) / 1.1, r = e.small ? 3 : 5;
      ctx.strokeStyle = rgba(cc[0], cc[1], cc[2], a);
      ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.rot);
      ctx.beginPath();
      if (m.k === 0) { ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath(); }
      else if (m.k === 1) { ctx.moveTo(-r, -r); ctx.lineTo(0, r); ctx.lineTo(r, -r); }
      else if (m.k === 2) { ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.moveTo(-r, -r * 0.3); ctx.lineTo(r, r * 0.3); }
      else { ctx.arc(0, 0, r * 0.7, 0, TAU); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); }
      ctx.stroke(); ctx.restore();
    }
    if (newClick(F, e)) F.circle = { x: e.click!.x, y: e.click!.y, t: e.t };
    if (F.circle && e.t - F.circle.t < 1.4) {
      const age = e.t - F.circle.t, p = Math.min(1, age / 0.45), a = age < 1 ? 1 : 1 - (age - 1) / 0.4, R = e.small ? 14 : 38;
      const { x, y } = F.circle;
      ctx.strokeStyle = rgba(cc[0], cc[1], cc[2], a); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + TAU * p); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, R * 0.72, Math.PI / 2, Math.PI / 2 - TAU * p, true); ctx.stroke();
      for (let i = 0; i < 8; i++) if (i / 8 < p) { const an = (i / 8) * TAU + age; ctx.save(); ctx.translate(x + Math.cos(an) * R * 0.86, y + Math.sin(an) * R * 0.86); ctx.rotate(an); ctx.strokeRect(-2.5, -2.5, 5, 5); ctx.restore(); }
      ctx.save(); ctx.translate(x, y); ctx.rotate(age * 1.5); ctx.strokeRect(-R * 0.35, -R * 0.35, R * 0.7, R * 0.7); ctx.restore();
      glow(ctx, x, y, R * 1.4, cc, 0.35 * a, 0.2);
    }
    ctx.globalCompositeOperation = "source-over";
  },
  // Цветение: за курсором — пыльца, щелчок — лепестки.
  bloom(ctx, s, e) {
    const F = fxs(s);
    const green: RGB = e.alarm ? [255, 90, 100] : [190, 242, 100];
    if (moving(e) && F.parts.length < 260) F.parts.push({ x: e.mx, y: e.my, vx: (s.r() - 0.5) * 20, vy: -8 - s.r() * 18, life: 1, pet: false, rot: 0 });
    if (newClick(F, e)) for (let i = 0; i < 18; i++) { const a = (i / 18) * TAU, v = 70 + s.r() * 120; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, pet: true, rot: a }); }
    ctx.globalCompositeOperation = "lighter";
    stepParts(F, e, 0.7, 14, (p) => {
      if (p.pet) {
        p.vx *= 0.96; p.vy *= 0.96; p.rot += e.dt * 3;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = rgba(187, 247, 208, p.life * 0.8); ctx.beginPath(); ctx.ellipse(0, 0, e.small ? 3 : 6, e.small ? 1.5 : 2.6, 0, 0, TAU); ctx.fill();
        ctx.restore();
      } else { ctx.fillStyle = rgba(green[0], green[1], green[2], p.life * 0.9); ctx.fillRect(p.x, p.y, 1.6, 1.6); }
    });
    ctx.globalCompositeOperation = "source-over";
  },
  // HUD: прицел с координатами, щелчок — захват цели.
  hud(ctx, s, e) {
    const F = fxs(s);
    const C = e.alarm ? "#ff4d5e" : "#22d3ee";
    ctx.strokeStyle = C; ctx.lineWidth = 1;
    if (e.mouse) {
      ctx.globalAlpha = 0.16;
      ctx.beginPath(); ctx.moveTo(0, (e.my | 0) + 0.5); ctx.lineTo(e.w, (e.my | 0) + 0.5); ctx.moveTo((e.mx | 0) + 0.5, 0); ctx.lineTo((e.mx | 0) + 0.5, e.h); ctx.stroke();
      ctx.globalAlpha = 0.9;
      brackets(ctx, e.mx, e.my, (e.small ? 7 : 14) + Math.sin(e.t * 6) * 1.5, e.small ? 3 : 6);
      if (!e.small) pixText(ctx, `X${String(e.mx | 0).padStart(4, "0")} Y${String(e.my | 0).padStart(4, "0")}`, e.mx + 20, e.my + 18, 6, C, 1.5);
      ctx.globalAlpha = 1;
    }
    if (newClick(F, e)) F.lock = { x: e.click!.x, y: e.click!.y, t: e.t };
    if (F.lock && e.t - F.lock.t < 0.8) {
      const k = (e.t - F.lock.t) / 0.8;
      ctx.globalAlpha = 1 - k * k; ctx.lineWidth = 1.5;
      brackets(ctx, F.lock.x, F.lock.y, 70 * (1 - easeIO(Math.min(1, k * 1.6))) + 12, 10);
      if (!e.small && k > 0.4) pixText(ctx, "LOCK", F.lock.x + 18, F.lock.y - 26, 6, C, 2);
      ctx.globalAlpha = 1;
    }
  },
  // Осколки: за курсором сыплются пиксели, щелчок — треугольные осколки.
  shards(ctx, s, e) {
    const F = fxs(s);
    if (moving(e) && F.parts.length < 260) F.parts.push({ x: e.mx, y: e.my, vx: (s.r() - 0.5) * 40, vy: s.r() * 20, life: 1, tri: false, rot: 0, sz: 2 + s.r() * 3, teal: s.r() < 0.4 });
    if (newClick(F, e)) for (let i = 0; i < 20; i++) { const a = s.r() * TAU, v = 100 + s.r() * 260; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, tri: true, rot: s.r() * TAU, sz: 5 + s.r() * 10, teal: s.r() < 0.3 }); }
    stepParts(F, e, 0.8, 180, (p) => {
      ctx.fillStyle = p.teal ? rgba(45, 212, 191, p.life) : rgba(192, 132, 252, p.life);
      if (!p.tri) { ctx.fillRect(p.x, p.y, p.sz, p.sz); return; }
      p.rot += e.dt * 6;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.beginPath(); ctx.moveTo(0, -p.sz); ctx.lineTo(p.sz * 0.8, p.sz * 0.6); ctx.lineTo(-p.sz * 0.7, p.sz * 0.4); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  },
  // Ретро: пиксельный след по сетке, щелчок — пиксельный взрыв.
  retro(ctx, s, e) {
    const F = fxs(s), g = e.small ? 3 : 6;
    for (const [x, y, a] of e.trail) {
      if (a > 0.5) continue;
      ctx.fillStyle = rgba(255, 59, 59, (1 - a / 0.5) * 0.8);
      ctx.fillRect(Math.floor(x / g) * g, Math.floor(y / g) * g, g - 1, g - 1);
    }
    if (newClick(F, e)) for (let i = 0; i < 28; i++) { const a = (i / 28) * TAU, v = 90 + (i % 3) * 60; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 }); }
    stepParts(F, e, 1.4, 0, (p) => { ctx.fillStyle = rgba(255, 59, 59, p.life); ctx.fillRect(Math.floor(p.x / g) * g, Math.floor(p.y / g) * g, g - 1, g - 1); });
  },
  // Редактор: подсветка строки под курсором, номер строки; щелчок — выделение слова.
  editor(ctx, s, e) {
    const F = fxs(s);
    if (e.mouse && !e.small) {
      const ln = Math.max(0, Math.floor((e.my - 40) / 21)), y = 40 + ln * 21;
      ctx.fillStyle = "rgba(255,179,64,.07)"; ctx.fillRect(0, y - 2, e.w, 21);
      ctx.fillStyle = "rgba(255,179,64,.85)"; ctx.fillRect(0, y - 2, 2, 21);
      ctx.font = `11px "Cascadia Mono", Consolas, monospace`; ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(255,255,255,.45)"; ctx.fillText(String(ln + 1).padStart(3, " "), e.w * 0.56 - 34, y + 1);
      if (Math.sin(e.t * 7) > 0) { ctx.fillStyle = "#ffb340"; ctx.fillRect(e.mx, y, 2, 17); }
    }
    if (newClick(F, e)) F.sel = { x: e.click!.x, y: e.click!.y, t: e.t };
    if (F.sel && e.t - F.sel.t < 1.2 && !e.small) {
      const a = 1 - (e.t - F.sel.t) / 1.2, ln = Math.floor((F.sel.y - 40) / 21);
      ctx.strokeStyle = rgba(255, 179, 64, a); ctx.lineWidth = 1;
      ctx.strokeRect(F.sel.x - 34, 40 + ln * 21 - 2, 68, 20);
      ctx.fillStyle = rgba(255, 179, 64, a); ctx.font = `10px "Cascadia Mono", Consolas, monospace`;
      ctx.fillText(`Ln ${ln + 1}, Col ${Math.max(1, ((F.sel.x - e.w * 0.56) / 7.8) | 0)}`, F.sel.x - 34, 40 + ln * 21 + 20);
    }
  },
  // Нет сигнала: щелчок — блок белого шума.
  nosignal(ctx, s, e) {
    const F = fxs(s);
    if (newClick(F, e)) F.burst = { x: e.click!.x, y: e.click!.y, t: e.t };
    if (!F.burst || e.t - F.burst.t > 0.45) return;
    const a = 1 - (e.t - F.burst.t) / 0.45, W = e.small ? 60 : 220, H = e.small ? 20 : 70, c = 4;
    for (let y = -H / 2; y < H / 2; y += c) for (let x = -W / 2; x < W / 2; x += c) {
      const q = hash2((x + F.burst.x) | 0, ((y + F.burst.y) | 0) + ((e.t * 30) | 0));
      if (q < 0.5) continue;
      ctx.fillStyle = q > 0.97 ? rgba(255, 40, 60, a) : q > 0.94 ? rgba(40, 230, 230, a) : rgba(255, 255, 255, a * (q - 0.5));
      ctx.fillRect(F.burst.x + x, F.burst.y + y, c, c);
    }
  },
  // Разбитый экран: курсор оставляет микротрещины.
  cracked(ctx, s, e) {
    const F = fxs(s);
    if (e.mouse && (F.lx === undefined || Math.hypot(e.mx - F.lx, e.my - F.ly) > 34)) {
      F.lx = e.mx; F.ly = e.my;
      const pts: number[][] = [[e.mx, e.my]];
      let a = s.r() * TAU, x = e.mx, y = e.my;
      for (let i = 0; i < 4; i++) { a += (s.r() - 0.5) * 1.2; x += Math.cos(a) * (6 + s.r() * 10); y += Math.sin(a) * (6 + s.r() * 10); pts.push([x, y]); }
      F.marks.push({ pts, t: e.t });
    }
    F.marks = F.marks.filter((m: any) => e.t - m.t < 2.2);
    ctx.lineWidth = 0.8;
    for (const m of F.marks) {
      ctx.strokeStyle = rgba(225, 235, 255, 0.7 * (1 - (e.t - m.t) / 2.2));
      ctx.beginPath(); m.pts.forEach(([x, y]: number[], i: number) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    }
  },
  // Взгляд: за курсором — звёздочки, щелчок — сердечки.
  anime(ctx, s, e) {
    const F = fxs(s);
    if (moving(e) && F.parts.length < 200 && s.r() < 0.6) F.parts.push({ x: e.mx + (s.r() - 0.5) * 12, y: e.my + (s.r() - 0.5) * 12, vx: 0, vy: 6, life: 1, h: false, sz: 2 + s.r() * 4 });
    if (newClick(F, e)) F.impact = { x: e.click!.x, y: e.click!.y, t: e.t };
    if (F.impact && e.t - F.impact.t < 0.35) {
      // Манга-удар: линии сходятся к точке щелчка.
      const k = (e.t - F.impact.t) / 0.35;
      ctx.strokeStyle = rgba(255, 45, 122, 0.8 * (1 - k)); ctx.lineWidth = 1.2; ctx.beginPath();
      for (let i = 0; i < 36; i++) { const a = (i / 36) * TAU + hash2(i, 9) * 0.1, r0 = 30 + k * 30 + hash2(i, 4) * 20; ctx.moveTo(F.impact.x + Math.cos(a) * r0, F.impact.y + Math.sin(a) * r0); ctx.lineTo(F.impact.x + Math.cos(a) * (r0 + 60 + hash2(i, 2) * 80), F.impact.y + Math.sin(a) * (r0 + 60 + hash2(i, 2) * 80)); }
      ctx.stroke();
    }
    if (F.impact && F.impact.t === e.t) { s.blink = e.t; for (let i = 0; i < 8; i++) F.parts.push({ x: e.click!.x + (s.r() - 0.5) * 30, y: e.click!.y, vx: (s.r() - 0.5) * 50, vy: -60 - s.r() * 80, life: 1, h: true, sz: (e.small ? 3 : 6) + s.r() * 5 }); }
    ctx.globalCompositeOperation = "lighter";
    stepParts(F, e, 0.8, 0, (p) => {
      ctx.fillStyle = p.h ? rgba(255, 45, 122, p.life) : rgba(255, 200, 225, p.life * Math.abs(Math.sin(e.t * 8 + p.x)));
      if (p.h) heart(ctx, p.x, p.y, p.sz); else star4(ctx, p.x, p.y, p.sz);
    });
    ctx.globalCompositeOperation = "source-over";
  },
  // Кот: меловая пыль осыпается за курсором, щелчок — искры и нимб крутится.
  cat(ctx, s, e) {
    const F = fxs(s);
    if (moving(e) && F.parts.length < 220) for (let i = 0; i < 2; i++) F.parts.push({ x: e.mx + (s.r() - 0.5) * 6, y: e.my + (s.r() - 0.5) * 6, vx: (s.r() - 0.5) * 12, vy: 4 + s.r() * 10, life: 1, st: false });
    if (newClick(F, e)) { s.spin = e.t; for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU, v = 40 + s.r() * 90; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, st: true }); } }
    stepParts(F, e, 0.9, 14, (p) => {
      ctx.fillStyle = rgba(255, 255, 255, p.life * (p.st ? 0.95 : 0.6));
      if (p.st) star4(ctx, p.x, p.y, 2 + p.life * 4); else ctx.fillRect(p.x, p.y, 1.3, 1.3);
    });
  },
  // Маркировка: мишень прыгает по сетке за курсором, щелчок — штамп «_Bnn;».
  techmark(ctx, s, e) {
    const F = fxs(s);
    if (e.mouse) {
      const g = 24, sx = Math.round(e.mx / g) * g, sy = Math.round(e.my / g) * g;
      F.tx = F.tx === undefined ? sx : F.tx + (sx - F.tx) * 0.5; F.ty = F.ty === undefined ? sy : F.ty + (sy - F.ty) * 0.5;
      ctx.strokeStyle = "rgba(245,245,245,.9)"; ctx.lineWidth = 1.2; brackets(ctx, F.tx, F.ty, 11, 5);
      ctx.beginPath(); ctx.moveTo(F.tx - 4, F.ty); ctx.lineTo(F.tx + 4, F.ty); ctx.moveTo(F.tx, F.ty - 4); ctx.lineTo(F.tx, F.ty + 4); ctx.stroke();
      if (!e.small) { ctx.font = "9px Cascadia Mono, Consolas, monospace"; ctx.fillStyle = "rgba(249,168,212,.9)"; ctx.textBaseline = "top"; ctx.fillText(`${sx / g | 0}:${sy / g | 0}`, F.tx + 15, F.ty + 8); }
    }
    if (newClick(F, e)) s.stamps.push({ x: e.click!.x, y: e.click!.y, t: e.t, n: s.n++ });
  },
  // Луч: «призраки» линзы на оси от вспышки через курсор; щелчок — всплеск по лучу.
  beam(ctx, s, e) {
    const F = fxs(s);
    if (newClick(F, e)) s.surge = e.t;
    if (!e.mouse) return;
    const dx = e.mx - s.bx, dy = e.my - s.hy;
    ctx.globalCompositeOperation = "lighter";
    [[0.35, 10, "rgba(140,180,255,.16)"], [0.7, 18, "rgba(255,170,120,.12)"], [1.25, 7, "rgba(170,255,210,.18)"], [1.7, 26, "rgba(160,140,255,.08)"]].forEach(([k, r, c]) => {
      const x = s.bx + dx * (k as number), y = s.hy + dy * (k as number);
      ctx.fillStyle = c as string; ctx.beginPath();
      for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; if (i) ctx.lineTo(x + Math.cos(a) * (r as number), y + Math.sin(a) * (r as number)); else ctx.moveTo(x + Math.cos(a) * (r as number), y + Math.sin(a) * (r as number)); }
      ctx.closePath(); ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
  },
  // Разлом: курсор рождает кольца-изолинии, щелчок — звёздная пыль из трещины.
  rift(ctx, s, e) {
    const F = fxs(s);
    if (e.mouse && e.t > F.next) { F.next = e.t + 0.35; F.marks.push({ x: e.mx, y: e.my, t: e.t, seed: s.r() * 100 }); }
    F.marks = F.marks.filter((m: any) => e.t - m.t < 1.6);
    ctx.lineWidth = 0.9;
    for (const m of F.marks) {
      const k = (e.t - m.t) / 1.6, R = 6 + k * (e.small ? 30 : 90);
      ctx.strokeStyle = e.alarm ? rgba(255, 120, 120, 0.5 * (1 - k)) : rgba(255, 236, 190, 0.5 * (1 - k));
      ctx.beginPath();
      for (let i = 0; i <= 36; i++) { const a = (i / 36) * TAU, rr = R * (1 + (noise(Math.cos(a) * 1.5 + m.seed, Math.sin(a) * 1.5) - 0.5) * 0.5); if (i) ctx.lineTo(m.x + Math.cos(a) * rr, m.y + Math.sin(a) * rr); else ctx.moveTo(m.x + Math.cos(a) * rr, m.y + Math.sin(a) * rr); }
      ctx.stroke();
    }
    if (newClick(F, e)) for (let i = 0; i < 30; i++) { const a = s.r() * TAU, v = 30 + s.r() * 160; F.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 }); }
    ctx.globalCompositeOperation = "lighter";
    stepParts(F, e, 0.7, 0, (p) => { p.vx *= 0.97; p.vy *= 0.97; ctx.fillStyle = rgba(255, 250, 235, p.life); ctx.fillRect(p.x, p.y, 1.6, 1.6); });
    ctx.globalCompositeOperation = "source-over";
  },
};

// ─── Кот (основная тема): чёрный кот мелом, нимб, звёзды ──────────
// Силуэт с меловым контуром и шерстью рисуется один раз в отдельный холст;
// живые — хвост, глаза (смотрят на курсор, по ним видно состояние связи),
// нимб, звёзды и меловая пыль.

const CAT_PTS = [[0.30, 0.02], [0.40, 0.15], [0.52, 0.13], [0.66, 0.0], [0.71, 0.2], [0.77, 0.31], [0.72, 0.43], [0.66, 0.49], [0.75, 0.63], [0.83, 0.86], [0.87, 1.05], [0.84, 1.22], [0.74, 1.34], [0.5, 1.38], [0.28, 1.36], [0.18, 1.26], [0.16, 1.08], [0.2, 0.86], [0.28, 0.63], [0.3, 0.51], [0.22, 0.43], [0.19, 0.31], [0.24, 0.17]];
function chalkCat(S: number, seed: number) {
  const r = rng(seed), pad = Math.ceil(S * 0.25);
  const c = document.createElement("canvas");
  c.width = Math.ceil(S * 1.1) + pad * 2; c.height = Math.ceil(S * 1.42) + pad * 2;
  const g = c.getContext("2d")!;
  const path = smoothPath(CAT_PTS, S, S, pad, pad);
  g.fillStyle = "#040405"; g.fill(path);
  // Меловая штриховка внутри: короткие дуги, у краёв светлее.
  g.save(); g.clip(path);
  g.lineCap = "round";
  for (let i = 0; i < S * S / 26; i++) {
    const x = pad + r() * S * 1.1, y = pad + r() * S * 1.42, l = 3 + r() * 9, a = r() * TAU;
    g.strokeStyle = `rgba(255,255,255,${(0.025 + r() * 0.05).toFixed(3)})`; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a + 1) * l * 0.5, y + Math.sin(a + 1) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.restore();
  // Контур: три дрожащих прохода мелом.
  const pts = smoothPts(CAT_PTS, 6).map(([x, y]) => [pad + x * S, pad + y * S]);
  for (let pass = 0; pass < 3; pass++) {
    g.strokeStyle = `rgba(255,255,255,${pass ? 0.35 : 0.75})`; g.lineWidth = pass ? 0.8 : 1.3;
    g.beginPath();
    pts.forEach(([x, y], i) => { const jx = x + (r() - 0.5) * 1.6, jy = y + (r() - 0.5) * 1.6; if (i) g.lineTo(jx, jy); else g.moveTo(jx, jy); });
    g.closePath(); g.stroke();
  }
  // Шерсть: короткие штрихи наружу по контуру.
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    let nx = y2 - y, ny = -(x2 - x);
    const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    if (g.isPointInPath(path, x + nx * 3, y + ny * 3)) { nx = -nx; ny = -ny; }
    for (let k = 0; k < 2; k++) {
      if (r() < 0.35) continue;
      const len = 2 + r() * 6, a = Math.atan2(ny, nx) + (r() - 0.5) * 0.9;
      g.strokeStyle = `rgba(255,255,255,${(0.4 + r() * 0.4).toFixed(2)})`; g.lineWidth = 0.7;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
    }
  }
  // Усы.
  g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 0.9;
  for (const [sx, sy, dir] of [[0.22, 0.4, -1], [0.75, 0.37, 1]] as const) for (let k = 0; k < 3; k++) {
    const x = pad + sx * S, y = pad + sy * S + k * 3;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + dir * S * 0.08, y + (k - 1) * 2, x + dir * S * 0.17, y + (k - 1) * 5); g.stroke();
  }
  return { c, pad };
}
const catScene: Scene = {
  fps: 24, scale: 1, protect: 0.2,
  init(w, h, small) {
    const r = rng(191);
    const z = sideZone({ w, h });
    const S = small ? Math.min(h * 0.42, 70) : Math.max(90, Math.min(z.w * 0.86, (z.h - 140) / 1.7));
    const ox = small ? w - S * 1.25 : z.x + (z.w - S * 1.1) / 2 - 6, oy = small ? h - S * 1.3 : z.y + z.h - S * 1.42;
    return {
      r, z, S, ox, oy, small, body: chalkCat(S, 5), blinkAt: 2, blink: -1, spin: -9,
      stars: Array.from({ length: small ? 30 : 150 }, () => ({ x: r() * w, y: r() * h, s: r(), ph: r() * TAU })),
      bubbles: [] as any[], nextBubble: 0,
      constel: Array.from({ length: 5 }, (_, i) => [z.x + 20 + r() * (z.w - 40), z.y + 90 + i * 26 + r() * 16]),
    };
  },
  draw(ctx, s, e) {
    const { t, dt } = e;
    const mood = e.alarm ? (document.body.dataset.health === "engine_off" ? "sleep" : "down") : document.body.dataset.health === "slow" ? "slow" : document.body.dataset.health === "starting" ? "look" : "ok";
    // Звёзды и меловые искры.
    for (const st of s.stars) {
      const a = 0.15 + 0.6 * Math.abs(Math.sin(t * (0.4 + st.s) + st.ph));
      ctx.fillStyle = rgba(255, 255, 255, a);
      if (st.s > 0.9) star4(ctx, st.x, st.y, 2 + st.s * 2);
      else ctx.fillRect(st.x, st.y, 1.2, 1.2);
    }
    const S = s.S, ox = s.ox, oy = s.oy;
    if (!s.small) {
      // Созвездие и подпись мелом над котом.
      ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 0.8; ctx.setLineDash([3, 4]);
      ctx.beginPath(); s.constel.forEach(([x, y]: number[], i: number) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.setLineDash([]);
      for (const [x, y] of s.constel) { ctx.fillStyle = "rgba(255,255,255,.8)"; star4(ctx, x, y, 2.6 + Math.sin(t * 2 + x) * 0.8); }
      ctx.font = `22px "Ink Free", "Segoe Print", cursive`; ctx.textBaseline = "top"; ctx.fillStyle = "rgba(255,255,255,.82)";
      ctx.fillText("stay curious.", s.z.x + 6, s.z.y + 14);
      ctx.font = `13px "Ink Free", "Segoe Print", cursive`; ctx.fillStyle = "rgba(255,255,255,.45)";
      ctx.fillText(e.ms ? `${e.ms} ms · не найдут` : "тихо и незаметно", s.z.x + 8, s.z.y + 44);
    }
    // Хвост: качается, у основания под телом.
    const sway = Math.sin(t * 0.9) * 0.25 + (mood === "down" ? 0.5 : 0) + (mood === "sleep" ? -0.3 : 0);
    const bx = ox + s.body.pad + S * 0.7, by = oy + s.body.pad + S * 1.3;
    const tx = bx + S * 0.34 * Math.cos(sway - 0.2), ty = by - S * 0.24 - Math.sin(sway) * S * 0.12;
    const tail = new Path2D();
    tail.moveTo(bx, by); tail.bezierCurveTo(bx + S * 0.28, by + S * 0.08, bx + S * 0.38, by - S * 0.02, tx, ty);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = S * 0.12 + 2.4; ctx.stroke(tail);
    ctx.strokeStyle = "#040405"; ctx.lineWidth = S * 0.12; ctx.stroke(tail);
    ctx.drawImage(s.body.c, ox, oy);
    // Глаза: светящиеся щёлки, смотрят на курсор; по ним видно связь.
    const P = (u: number, v: number) => [ox + s.body.pad + u * S, oy + s.body.pad + v * S];
    if (t > s.blinkAt) { s.blink = t; s.blinkAt = t + 3 + s.r() * 4; }
    const bk = t - s.blink < 0.16 ? 0.15 : 1;
    const look = e.mouse ? clamp((e.mx - P(0.5, 0.3)[0]) / 400, -1, 1) * 2 : mood === "look" ? Math.sin(t * 3) * 2 : 0;
    const lookY = e.mouse ? clamp((e.my - P(0.5, 0.3)[1]) / 400, -1, 1) * 1.2 : 0;
    const st = hex(getComputedStyle(document.body).getPropertyValue("--state") || "#ffffff");
    const eyeC = mood === "ok" ? "#ffffff" : rgba(st[0], st[1], st[2], 1);
    ctx.save();
    ctx.shadowColor = eyeC; ctx.shadowBlur = 10; ctx.fillStyle = eyeC; ctx.strokeStyle = eyeC; ctx.lineWidth = 1.6;
    for (const [u, v, dir] of [[0.39, 0.31, 1], [0.6, 0.3, -1]] as const) {
      const [x, y] = P(u, v), ew = S * 0.075, eh = S * 0.03;
      if (mood === "down") {
        ctx.beginPath(); ctx.moveTo(x - ew * 0.7, y - eh * 1.4); ctx.lineTo(x + ew * 0.7, y + eh * 1.4); ctx.moveTo(x + ew * 0.7, y - eh * 1.4); ctx.lineTo(x - ew * 0.7, y + eh * 1.4); ctx.stroke();
      } else if (mood === "sleep") {
        ctx.beginPath(); ctx.arc(x, y - eh, ew * 0.8, 0.2, Math.PI - 0.2); ctx.stroke();
      } else {
        const k = (mood === "slow" ? 0.5 : 1) * bk;
        ctx.beginPath();
        ctx.moveTo(x - ew + look, y + dir * eh * 0.3 * k + lookY);
        ctx.lineTo(x + ew + look, y - dir * eh * 0.9 * k + lookY);
        ctx.lineTo(x + ew * 0.9 + look, y + eh * 1.1 * k + lookY);
        ctx.lineTo(x - ew * 0.9 + look, y + eh * 1.3 * k + lookY);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
    // Нимб: меловое кольцо, покачивается; щелчок — раскручивается.
    const [hx, hy0] = P(0.48, -0.14);
    const hy = hy0 + Math.sin(t * 1.3) * 3;
    const spin = t - s.spin < 1 ? easeIO(t - s.spin) * TAU : 0;
    ctx.save(); ctx.translate(hx, hy); ctx.rotate(Math.sin(t * 0.5) * 0.12);
    ctx.shadowColor = "#fff"; ctx.shadowBlur = 8;
    for (let k = 0; k < 2; k++) {
      ctx.strokeStyle = `rgba(255,255,255,${k ? 0.45 : 0.9})`; ctx.lineWidth = k ? 0.8 : 1.6;
      ctx.setLineDash([S * 0.5, S * 0.06, S * 0.2, S * 0.05]); ctx.lineDashOffset = -t * 12 - spin * 40 + k * 7;
      ctx.beginPath(); ctx.ellipse(0, k * 1.5, S * 0.27, S * 0.065 * Math.abs(Math.cos(spin)) + 1, 0, 0, TAU); ctx.stroke();
    }
    ctx.restore(); ctx.setLineDash([]);
    // Пузырьки-закорючки «o°» у головы; во сне — «z».
    if (t > s.nextBubble) {
      s.nextBubble = t + (mood === "sleep" ? 0.9 : 1.6);
      const [bx2, by2] = P(s.r() < 0.5 ? 0.12 : 0.86, 0.22);
      s.bubbles.push({ x: bx2, y: by2, t, z: mood === "sleep" });
    }
    s.bubbles = s.bubbles.filter((b: any) => t - b.t < 2.4);
    ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 0.9;
    ctx.font = `${Math.round(S * 0.12)}px "Ink Free", cursive`;
    for (const b of s.bubbles) {
      const k = (t - b.t) / 2.4, y = b.y - k * S * 0.3;
      ctx.globalAlpha = 1 - k;
      if (b.z) ctx.fillText("z", b.x + Math.sin(k * 6) * 4, y);
      else { ctx.beginPath(); ctx.arc(b.x, y, 2.2, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(b.x + 5, y - 4, 1.2, 0, TAU); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    void dt;
  },
};

// ─── Маркировка: технические знаки, XX, скобки-мишени, штрихкоды ────

const techmark: Scene = {
  fps: 20, scale: 1, protect: 0.25,
  init(w, h, small) {
    const r = rng(211);
    return { r, z: sideZone({ w, h }), small, stamps: [] as any[], snap: [w / 2, h / 2], n: 42,
      bars: Array.from({ length: 48 }, () => 1 + ((r() * 3) | 0)) };
  },
  draw(ctx, s, e) {
    const { t, w, h } = e;
    const W = "rgba(245,245,245,.92)";
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#f472b6"); grad.addColorStop(0.5, "#22d3ee"); grad.addColorStop(1, "#f472b6");
    // Градиентная линия у правого края, по ней бежит свет.
    ctx.fillStyle = grad; ctx.fillRect(w - (s.small ? 4 : 7), 0, 2, h);
    const py = ((t * 160) % (h + 120)) - 60;
    ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fillRect(w - (s.small ? 5 : 8), py, 4, 40);
    const X = (x: number, y: number, sz: number, dashed: boolean) => {
      ctx.save(); ctx.translate(x, y);
      if (dashed) { ctx.setLineDash([3, 3]); ctx.lineDashOffset = -t * 10; ctx.strokeStyle = W; ctx.lineWidth = 1; }
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        ctx.save(); ctx.rotate(a);
        if (dashed) ctx.strokeRect(-sz * 0.12, -sz * 0.5, sz * 0.24, sz);
        else { ctx.fillStyle = W; ctx.fillRect(-sz * 0.12, -sz * 0.5, sz * 0.24, sz); }
        ctx.restore();
      }
      ctx.restore();
    };
    const target = (x: number, y: number, r: number, a = 1) => {
      ctx.strokeStyle = rgba(245, 245, 245, a); ctx.lineWidth = 1.2; brackets(ctx, x, y, r, r * 0.45);
      ctx.beginPath(); ctx.moveTo(x - r * 0.35, y); ctx.lineTo(x + r * 0.35, y); ctx.moveTo(x, y - r * 0.35); ctx.lineTo(x, y + r * 0.35); ctx.stroke();
    };
    if (s.small) {
      const xs = Math.min(h * 0.5, 28), yy = h > 80 ? h - 22 : h / 2;
      X(w - 30, yy, xs, false); X(w - 30 - xs * 1.1, yy, xs, true);
      for (let i = 0; i < 20; i++) { ctx.fillStyle = W; ctx.fillRect(w - 110 - xs + i * 3, yy - xs * 0.35, s.bars[i], xs * 0.7); }
      return;
    }
    const z = s.z;
    ctx.font = "10px Cascadia Mono, Consolas, monospace"; ctx.textBaseline = "top"; ctx.fillStyle = W;
    ctx.fillText("_B42;", z.x + 4, z.y + 6);
    target(z.x + 18, z.y + 32, 10);
    // Большие XX и их пунктирные тени-цепочки.
    X(z.x + 70, z.y + 80, 62, false); X(z.x + 140, z.y + 80, 62, false);
    for (let i = 0; i < 4; i++) X(z.x + 70 + (i % 2) * 22, z.y + 140 + i * 38, 46, true);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if ((i + j + Math.floor(t * 2)) % 2 === 0) { ctx.fillStyle = W; ctx.fillRect(z.x + 150 + i * 12, z.y + 150 + j * 12, 10, 10); }
    // Пунктирная дуга вращается.
    ctx.save(); ctx.setLineDash([10, 6]); ctx.lineDashOffset = t * 30; ctx.strokeStyle = W; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(z.x + 150, z.y + 300, 36, -1.2 + t * 0.4, 3.6 + t * 0.4); ctx.stroke(); ctx.restore();
    // Сетка мишеней, одна мигает.
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) target(z.x + 26 + i * 40, z.y + 270 + j * 40, 14, (Math.floor(t * 3) % 6) === i * 3 + j ? 1 : 0.5);
    // Штрихкод: полосы, по трафику — шире.
    let bx = z.x + 8;
    const by = z.y + z.h - 120;
    s.bars.forEach((b: number, i: number) => { if (i % 2 === 0) { ctx.fillStyle = W; ctx.fillRect(bx, by, b + (hash2(i, Math.floor(t * 4)) < e.load ? 1 : 0), 60); } bx += b + 1; });
    ctx.fillStyle = "rgba(245,245,245,.6)"; ctx.fillText("HANDLE_WITH_CARE;", z.x + 8, by + 68);
    ctx.fillText(e.ms ? `RTT_${e.ms};` : "RTT_—;", z.x + 8, by + 82);
    // Пастельные полосы как на листе.
    for (let i = 0; i < 3; i++) {
      const g = ctx.createLinearGradient(0, h - 90, 0, h - 20);
      g.addColorStop(0, "#f9a8d4"); g.addColorStop(1, "#67e8f9");
      ctx.fillStyle = g; ctx.save(); ctx.translate(z.x + z.w - 50 + i * 12, h - 20); ctx.rotate(0.12); ctx.fillRect(0, -70, 6, 70); ctx.restore();
    }
    // Штамп-метки от щелчков.
    s.stamps = s.stamps.filter((m: any) => t - m.t < 4);
    for (const m of s.stamps) {
      const a = Math.min(1, (4 - (t - m.t)) / 0.6);
      ctx.globalAlpha = a; X(m.x, m.y, 26, (t - m.t) > 0.25);
      ctx.fillStyle = W; ctx.fillText(`_B${m.n};`, m.x + 16, m.y + 14);
      ctx.globalAlpha = 1;
    }
  },
};

// ─── Будь добр: пиксельная ночь, край планеты, поле, фигурка ───────

const bekind: Scene = {
  fps: 12, scale: 1, protect: 0.25,
  init(w, h, small) {
    const r = rng(223);
    const px = small ? 2 : 4, W = Math.ceil(w / px), H = Math.ceil(h / px);
    const buf = document.createElement("canvas"); buf.width = W; buf.height = H;
    const TW = W * 2, tex = new Float32Array(TW * H), grass = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < TW; x++) tex[y * TW + x] = fbm(x * 0.06, y * 0.06, 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grass[y * W + x] = fbm(x * 0.25, y * 0.5, 2);
    const stars = Array.from({ length: small ? 25 : 110 }, () => ({ x: (r() * W) | 0, y: (r() * H * 0.75) | 0, ph: r() * TAU, b: r() < 0.15 }));
    return { px, W, H, buf, b: buf.getContext("2d")!, img: buf.getContext("2d")!.createImageData(W, H), TW, tex, grass, stars, small, z: sideZone({ w, h }), shoot: null as any };
  },
  draw(ctx, s, e) {
    const { t } = e;
    const { W, H, TW, tex, grass, img } = s;
    const d = img.data as Uint8ClampedArray;
    const cx = W * 1.16, cy = H * 0.26, R = H * 0.95, horizon = Math.floor(H * 0.88);
    const rot = Math.floor(t * 3);
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const mx = e.mouse ? e.mx / s.px : -99, my = e.mouse ? e.my / s.px : -99;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, th = bayer[(y & 3) * 4 + (x & 3)] / 16;
      let r = 2, g = 3, b = 10 + y * 0.08;
      if (y >= horizon) {
        // Поле: травяной шум, ветер бежит волной, под фигуркой — светлее.
        const gv = grass[y * W + x] + 0.18 * Math.sin((x - t * 9) * 0.08 + y * 0.3) + Math.max(0, 1 - Math.hypot(x - W * 0.52, (y - horizon) * 2.4) / 50) * 0.5
          + (Math.hypot(x - mx, y - my) < 10 ? 0.3 : 0);
        const q = gv + (th - 0.5) * 0.25;
        if (q > 0.85) { r = 170; g = 230; b = 90; } else if (q > 0.65) { r = 70; g = 160; b = 50; } else if (q > 0.45) { r = 30; g = 100; b = 30; } else { r = 12; g = 50; b = 18; }
        const fog = Math.max(0, 1 - (y - horizon) / 8);
        r += fog * 20; g += fog * 30; b += fog * 40;
      } else {
        const dx = x - cx, dy = y - cy, dd = Math.hypot(dx, dy) / R;
        if (dd < 1) {
          // Планета: облака текстурой, край светится голубым.
          const u = ((x + rot) % TW + TW) % TW, v = tex[y * TW + u];
          const limb = Math.max(0, (dd - 0.82) / 0.18), shade = Math.min(1, (x - (cx - R)) / (R * 0.35));
          const q = v + (th - 0.5) * 0.18;
          if (q > 0.64) { r = 210; g = 228; b = 255; } else if (q > 0.52) { r = 110; g = 160; b = 230; } else if (q > 0.42) { r = 40; g = 95; b = 200; } else { r = 18; g = 50; b = 140; }
          const k = (0.35 + 0.65 * shade) * 0.62;
          r = r * k + limb * 140; g = g * k + limb * 170; b = b * k + limb * 200;
        } else if (dd < 1.12) {
          const a = (1.12 - dd) / 0.12, q = a + (th - 0.5) * 0.3;
          if (q > 0.5) { r = 40 + a * 60; g = 90 + a * 90; b = 200 + a * 55; }
        }
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
    for (const st of s.stars) {
      if (Math.hypot(st.x - cx, st.y - cy) < R * 1.1) continue;
      const a = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.8 + st.ph)), i = (st.y * W + st.x) * 4;
      const c = st.b ? [120, 170, 255] : [255, 255, 255];
      d[i] = c[0] * a; d[i + 1] = c[1] * a; d[i + 2] = c[2] * a;
    }
    // Фигурка в поле и светлячок-курсор.
    const fx = Math.floor(W * 0.52), fy = horizon - 1;
    for (let k = 0; k < 3; k++) { const i = ((fy - k) * W + fx) * 4; d[i] = d[i + 1] = d[i + 2] = 10; }
    if (e.mouse) for (const [ox, oy, a] of [[0, 0, 1], [1, 0, 0.5], [-1, 0, 0.5], [0, 1, 0.5], [0, -1, 0.5]] as const) {
      const xx = Math.floor(mx) + ox, yy = Math.floor(my) + oy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const i = (yy * W + xx) * 4; d[i] = 255 * a + d[i] * (1 - a); d[i + 1] = 250 * a + d[i + 1] * (1 - a); d[i + 2] = 140 * a + d[i + 2] * (1 - a);
    }
    s.b.putImageData(img, 0, 0);
    // Падающая звезда от щелчка.
    if (newClick(s, e)) s.shoot = { x: e.click!.x / s.px, y: e.click!.y / s.px, t };
    if (s.shoot && t - s.shoot.t < 0.9) {
      const k = (t - s.shoot.t) / 0.9;
      for (let j = 0; j < 14; j++) {
        const x = Math.floor(s.shoot.x - k * 70 + j * 1.2), y = Math.floor(s.shoot.y + k * 40 - j * 0.7);
        s.b.fillStyle = `rgba(255,255,255,${((1 - j / 14) * (1 - k)).toFixed(2)})`; s.b.fillRect(x, y, 1, 1);
      }
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s.buf, 0, 0, W * s.px, H * s.px);
    ctx.imageSmoothingEnabled = true;
    if (!s.small) {
      const z = s.z;
      pixText(ctx, "BE", z.x + 6, z.y + 20, 9, "#ffffff", 4);
      pixText(ctx, "KIND", z.x + 6, z.y + 66, 9, "#ffffff", 4);
      ctx.font = "11px Segoe UI, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.textBaseline = "top";
      ["Мы не знаем, что у другого", "на душе и в канале.", "", "Где другие резки —", "будь светом."].forEach((l, i) => ctx.fillText(l, z.x + 8, z.y + 124 + i * 15));
    }
  },
};

// ─── Луч: белый луч из поднятой руки, развевающаяся ткань, блики ────

const beam: Scene = {
  fps: 24, scale: 1, protect: 0.2,
  init(w, h, small) {
    const r = rng(229), z = sideZone({ w, h });
    const bx = small ? w - 46 : z.x + z.w * 0.62, hy = small ? h * 0.5 : Math.max(z.y + 120, h * 0.42);
    return { r, z, small, bx, hy, surge: -9,
      motes: Array.from({ length: small ? 14 : 90 }, () => ({ x: (r() - 0.5) * 60, y: r() * h, v: 4 + r() * 10, a: r() })),
      cloth: Array.from({ length: small ? 4 : 9 }, (_, i) => ({ k: i, ph: r() * TAU, w: 0.6 + r() * 2.2, a: 0.1 + r() * 0.3 })) };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e;
    const bx = s.bx, hy = s.hy, pulse = 1 + 0.25 * Math.sin(t * 2) + e.load * 0.6;
    ctx.globalCompositeOperation = "lighter";
    // Анаморфный блик через всё окно.
    const an = ctx.createLinearGradient(0, 0, w, 0);
    an.addColorStop(0, "rgba(120,140,255,0)"); an.addColorStop(clamp(bx / w, 0, 1), "rgba(220,230,255,.35)"); an.addColorStop(1, "rgba(255,120,80,0)");
    ctx.fillStyle = an; ctx.fillRect(0, hy - 1.5, w, 3);
    ctx.fillStyle = "rgba(180,190,255,.05)"; ctx.fillRect(0, hy - 10, w, 20);
    // Луч вверх: ядро + ореол; по нему бегут всплески (щелчок, трафик).
    for (const [wd, a] of [[28, 0.05], [10, 0.16], [3.2, 0.95]] as const) {
      const g = ctx.createLinearGradient(0, 0, 0, hy);
      g.addColorStop(0, rgba(255, 255, 255, a * 0.6)); g.addColorStop(1, rgba(255, 255, 255, a));
      ctx.fillStyle = g; ctx.fillRect(bx - (wd * pulse) / 2, 0, wd * pulse, hy);
    }
    const sk = t - s.surge;
    if (sk < 1.2) { const y = hy - sk * hy * 1.1; glow(ctx, bx, y, 30, [220, 230, 255], 1 - sk / 1.2); }
    // Звезда-вспышка в руке.
    glow(ctx, bx, hy, 70 * pulse, [200, 215, 255], 0.55, 1);
    ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + t * 0.05, l = (i % 2 ? 26 : 60) * pulse; ctx.moveTo(bx, hy); ctx.lineTo(bx + Math.cos(a) * l, hy + Math.sin(a) * l * 0.6); }
    ctx.stroke();
    // Пылинки в свете луча.
    for (const m of s.motes) {
      m.y -= m.v * dt; if (m.y < 0) m.y = h;
      const near = Math.max(0, 1 - Math.abs(m.x) / 40);
      ctx.fillStyle = rgba(230, 235, 255, (0.15 + near * 0.6) * (0.5 + 0.5 * Math.sin(t + m.a * 9)));
      ctx.fillRect(bx + m.x, m.y, 1.4, 1.4);
    }
    // Рука и ткань: ленты света струятся вниз-влево.
    const sh = s.small ? 0.35 : 1;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(235,240,255,.75)"; ctx.lineWidth = 3 * sh;
    ctx.beginPath(); ctx.moveTo(bx, hy + 4); ctx.quadraticCurveTo(bx - 6 * sh, hy + 50 * sh, bx - 16 * sh, hy + 92 * sh); ctx.stroke();
    for (const c of s.cloth) {
      const x0 = bx - 18 * sh + c.k * 3 * sh, y0 = hy + 96 * sh;
      const ex = (s.small ? bx - 90 : s.z.x - 10) + Math.sin(t * 0.7 + c.ph) * 20 * sh, ey = h + 10;
      ctx.strokeStyle = rgba(225, 232, 255, c.a); ctx.lineWidth = c.w * sh;
      ctx.beginPath(); ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0 + 30 * sh + Math.sin(t * 0.9 + c.ph) * 18 * sh, y0 + (ey - y0) * 0.3, ex + 60 * sh + Math.cos(t * 0.6 + c.ph) * 26 * sh, y0 + (ey - y0) * 0.7, ex, ey);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  },
};

// ─── Чилл: закат, холмы с буквами WPX, пальмы, очки с отражением ────

const chill: Scene = {
  fps: 20, scale: 1, protect: 0.25,
  init(w, h, small) {
    const r = rng(239), z = sideZone({ w, h });
    const hills = [0, 1].map((k) => Array.from({ length: 24 }, (_, i) => [i / 23, 0.78 + k * 0.06 + (fbm(i * 0.4 + k * 9, 1, 2) - 0.5) * 0.12]));
    return { r, z, small, hills, flash: -9,
      clouds: Array.from({ length: small ? 3 : 7 }, () => ({ x: r() * w, y: 20 + r() * h * 0.16, s: 0.6 + r() * 0.9, v: 3 + r() * 6 })) };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e;
    // Закатное небо сверху, ниже уходит в ночь.
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.75);
    sky.addColorStop(0, "rgba(124,196,255,.22)"); sky.addColorStop(0.35, "rgba(255,126,182,.18)"); sky.addColorStop(1, "rgba(12,7,20,0)");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    // Мультяшные облака: два тона, плывут.
    for (const c of s.clouds) {
      c.x += c.v * dt; if (c.x > w + 120) c.x = -120;
      for (const [dx, dy, rr, col] of [[0, 0, 22, "rgba(255,214,232,.16)"], [20, -8, 18, "rgba(255,236,245,.2)"], [-22, 4, 15, "rgba(255,214,232,.16)"], [8, 6, 20, "rgba(200,170,220,.14)"]] as const) {
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x + dx * c.s, c.y + dy * c.s, rr * c.s, 0, TAU); ctx.fill();
      }
    }
    // Холмы и буквы на склоне.
    s.hills.forEach((pts: number[][], k: number) => {
      ctx.fillStyle = k ? "#1a0f2a" : "#2a1740";
      ctx.beginPath(); ctx.moveTo(0, h);
      for (const [u, v] of pts) ctx.lineTo(u * w, v * h - (s.small ? h * 0.3 : 0));
      ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    });
    const sx = w * 0.72, sy = h * (s.small ? 0.5 : 0.8), L = s.small ? 9 : 22;
    ctx.font = `900 ${L}px "Segoe UI Black", Impact, sans-serif`; ctx.textBaseline = "alphabetic";
    "W P X".split(" ").forEach((ch, i) => {
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.save(); ctx.translate(sx + i * L * 1.1, sy - i * L * 0.12); ctx.transform(1, -0.05, 0, 1, 0, 0); ctx.fillText(ch, 0, 0); ctx.restore();
    });
    if (s.small) return;
    // Пальмы у левого края.
    for (const [px, ph, sc] of [[30, 0, 1], [150, 1.7, 0.75]] as const) {
      const base = h, top = h - 230 * sc, sway = Math.sin(t * 0.8 + ph) * 8;
      ctx.strokeStyle = "#140a20"; ctx.lineWidth = 7 * sc; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(px, base); ctx.quadraticCurveTo(px + 20 * sc, (base + top) / 2, px + sway, top); ctx.stroke();
      ctx.fillStyle = "#140a20";
      for (let k = 0; k < 7; k++) {
        const a = -Math.PI / 2 + (k - 3) * 0.55 + Math.sin(t + k + ph) * 0.06;
        ctx.save(); ctx.translate(px + sway, top); ctx.rotate(a);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(40 * sc, -14 * sc, 80 * sc, 12 * sc); ctx.quadraticCurveTo(40 * sc, -2 * sc, 0, 4 * sc); ctx.fill();
        ctx.restore();
      }
    }
    // Очки: мультяшная заливка, в линзах — небо и блик от курсора.
    const z = s.z, gx = z.x + z.w / 2, gy = z.y + 110 + Math.sin(t * 1.1) * 4;
    const lens = (cx: number) => { const p = new Path2D(); p.moveTo(cx - 40, gy - 18); p.lineTo(cx + 40, gy - 18); p.quadraticCurveTo(cx + 42, gy + 26, cx, gy + 26); p.quadraticCurveTo(cx - 42, gy + 26, cx - 40, gy - 18); return p; };
    ctx.strokeStyle = "#0b0612"; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(gx - 6, gy - 14); ctx.quadraticCurveTo(gx, gy - 20, gx + 6, gy - 14); ctx.stroke();
    for (const cx of [gx - 46, gx + 46]) {
      const p = lens(cx);
      ctx.save(); ctx.clip(p);
      const lg = ctx.createLinearGradient(0, gy - 18, 0, gy + 26);
      lg.addColorStop(0, "#7cc4ff"); lg.addColorStop(0.5, "#ff7eb6"); lg.addColorStop(0.75, "#2a1740"); lg.addColorStop(1, "#140a20");
      ctx.fillStyle = lg; ctx.fillRect(cx - 50, gy - 20, 100, 50);
      const gl = e.mouse ? clamp((gx - e.mx) / 30, -30, 30) : Math.sin(t * 0.7) * 20;
      ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.save(); ctx.translate(cx + gl, gy); ctx.rotate(-0.6); ctx.fillRect(-4, -40, 8, 80); ctx.fillRect(8, -40, 3, 80); ctx.restore();
      ctx.restore();
      ctx.strokeStyle = "#0b0612"; ctx.lineWidth = 5; ctx.stroke(p);
    }
    ctx.font = `italic 700 15px "Segoe UI", sans-serif`; ctx.fillStyle = "rgba(255,214,232,.85)"; ctx.textBaseline = "top";
    ctx.fillText("stay cool.", z.x + 10, gy + 50);
    ctx.font = "11px Segoe UI, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.fillText(e.ms ? `пинг ${e.ms} мс — расслабься` : "всё под контролем", z.x + 10, gy + 72);
    // Щелчок — вспышка камеры.
    if (newClick(s, e)) s.flash = t;
    const fk = t - s.flash;
    if (fk < 0.35) { ctx.fillStyle = rgba(255, 255, 255, 0.35 * (1 - fk / 0.35)); ctx.fillRect(0, 0, w, h); glow(ctx, e.click?.x ?? gx, e.click?.y ?? gy, 80, [255, 255, 255], 1 - fk / 0.35); }
  },
};

const IMPL: Partial<Record<SceneId, Scene>> = {
  plexus, ascii, spectrum, glitch, poster, holo, dispersion, runes, hex: hexgrid, bloom, hud, shards, retro, editor, nosignal, cracked, anime, rift,
  cat: catScene, techmark, bekind, beam, chill,
  ...CATS, ...COFFEE, ...MEMES, ...GADGETS,
};

// ─── Монтирование на canvas ───────────────────────────────────────

const pointer = { x: -1, y: -1, in: false, cx: -1e4, cy: -1e4, ct: -1e9, trail: [] as [number, number, number][] };
let pointerWired = false;
function wirePointer() {
  if (pointerWired) return;
  pointerWired = true;
  document.addEventListener("pointermove", (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.in = true;
    pointer.trail.push([e.clientX, e.clientY, performance.now()]);
    if (pointer.trail.length > 90) pointer.trail.splice(0, pointer.trail.length - 90);
  }, { passive: true });
  document.addEventListener("pointerdown", (e) => { pointer.cx = e.clientX; pointer.cy = e.clientY; pointer.ct = performance.now(); }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { pointer.in = false; });
  window.addEventListener("blur", () => { pointer.in = false; });
}

export interface Mounted { set(id: SceneId): void; stop(): void; still(t: number): void }

/** Ошибка кадра сцены: в консоль один раз на тему, анимация идёт дальше. */
const failed = new Set<string>();
function drawFailed(id: SceneId, err: unknown) {
  if (failed.has(id)) return;
  failed.add(id);
  console.warn(`scene ${id}: кадр не нарисован`, err);
}

/**
 * Запустить сцену на canvas. `small` — для выреза и превью (мельче детали).
 * `still` — один кадр без анимации (превью в настройках).
 */
export function mountScene(canvas: HTMLCanvasElement, id: SceneId, opt: { small?: boolean; still?: number } = {}): Mounted {
  wirePointer();
  let scene = IMPL[id], cur = id;
  let state: unknown = null, sw = 0, sh = 0, raf = 0, last = 0, lastT = 0, t0 = performance.now(), stopped = false;
  const ctx = canvas.getContext("2d")!;
  const motion = () => {
    const m = document.documentElement.dataset.motion;
    return m === "on" || (m !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };
  const frame = (tsec: number) => {
    if (!scene) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    const r = canvas.getBoundingClientRect();
    const cw = Math.max(1, r.width), ch = Math.max(1, r.height);
    // Холст ещё не разложен (окно настроек открывается) — рисовать нечего.
    if (r.width < 8 || r.height < 8) return;
    const k = Math.min(window.devicePixelRatio || 1, 2) * scene.scale;
    if (canvas.width !== Math.round(cw * k) || canvas.height !== Math.round(ch * k)) { canvas.width = Math.round(cw * k); canvas.height = Math.round(ch * k); }
    if (!state || sw !== cw || sh !== ch) { state = scene.init(cw, ch, !!opt.small); sw = cw; sh = ch; }
    // Сброс состояния: если прошлый кадр упал внутри save/clip, обрезка не
    // останется навсегда (иначе clearRect чистит только её, и старая картинка висит).
    ctx.reset?.();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const health = document.body.dataset.health;
    const dt = clamp(tsec - lastT, 0, 0.1);
    lastT = tsec;
    const live = opt.still === undefined;
    const inside = (x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const age = (performance.now() - pointer.ct) / 1000;
    const env: Env = {
      t: tsec, dt: dt || 1 / scene.fps, w: cw, h: ch, small: !!opt.small,
      mx: pointer.x - r.left, my: pointer.y - r.top,
      mouse: pointer.in && live && inside(pointer.x, pointer.y),
      click: live && age < 3 && inside(pointer.cx, pointer.cy) ? { x: pointer.cx - r.left, y: pointer.cy - r.top, age, id: pointer.ct } : null,
      trail: live && pointer.in ? pointer.trail.filter(([, , pt]) => performance.now() - pt < 1200).map(([x, y, pt]) => [x - r.left, y - r.top, (performance.now() - pt) / 1000] as [number, number, number]) : [],
      alarm: health === "down" || health === "engine_off",
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#9b6bff",
      load: sig.load, ms: sig.ms,
    };
    try { scene.draw(ctx, state, env); } catch (err) { drawFailed(cur, err); }
    ctx.filter = "none"; ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.setLineDash([]); ctx.shadowBlur = 0;
    // Центр окна, где текст, — приглушить.
    if (!opt.small && scene.protect) {
      ctx.globalCompositeOperation = "destination-out";
      const g = ctx.createRadialGradient(cw * 0.58, ch * 0.45, 0, cw * 0.58, ch * 0.45, Math.max(cw, ch) * 0.55);
      g.addColorStop(0, `rgba(0,0,0,${scene.protect})`); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
      ctx.globalCompositeOperation = "source-over";
    }
    // Отклик на курсор и щелчок — поверх, не приглушается.
    try { FX[cur]?.(ctx, state, env); scene.fx?.(ctx, state, env); } catch (err) { drawFailed(cur, err); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  };
  const loop = (now: number) => {
    raf = 0;
    if (stopped || !scene) return;
    if (document.visibilityState === "visible" && canvas.isConnected && canvas.getBoundingClientRect().width > 0) {
      if (now - last >= 1000 / scene.fps - 2) { last = now; frame(Math.max(0, (now - t0) / 1000)); }
    }
    if (motion()) raf = requestAnimationFrame(loop);
    else frame(3);
  };
  const start = () => {
    if (opt.still !== undefined) { lastT = opt.still - 1 / 30; frame(opt.still); return; }
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!stopped) start(); };
  document.addEventListener("visibilitychange", kick);
  const ro = new ResizeObserver(() => { if (stopped) return; last = 0; if (!motion() || opt.still !== undefined) frame(opt.still ?? 3); });
  ro.observe(canvas);
  start();
  return {
    set(next) { scene = IMPL[next]; cur = next; state = null; t0 = performance.now(); lastT = 0; canvas.dataset.scene = next; if (!scene) ctx.clearRect(0, 0, canvas.width, canvas.height); else kick(); },
    // Остановленная сцена не держит ни кадров, ни слушателей (превью в настройках).
    stop() { stopped = true; cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", kick); ro.disconnect(); },
    still(t) { if (stopped) return; lastT = t - 1 / 30; frame(t); },
  };
}
