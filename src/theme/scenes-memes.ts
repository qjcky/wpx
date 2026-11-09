// Темы-мемы: Офлайн, Дедлайн, Ctrl+Alt+Del, while(alive), N*PE, Hello world.
// Каждая привязана к связи: динозавры говорят «офлайн», когда её нет; жнец
// идёт по полоске дня; негатив летит в корзину; цикл жизни стоит, пока нет сети.

import { TAU, clamp, rng, hash2, rgba, newClick, sideZone, pixText, sig, health, look, sprite, particles, notchBox, type Scene } from "./scenekit";

const isDown = () => { const h = health(); return h === "down" || h === "engine_off"; };
const pad5 = (n: number) => String(Math.max(0, Math.min(99999, Math.round(n)))).padStart(5, "0");

// ─── Офлайн: пиксельные динозавры болтают ────────────────────────

const DINO = [
  "..........XXXXXXX.",
  ".........XXXXXXXXX",
  ".........XX..XXXXX",
  ".........XX..XXXXX",
  ".........XXXXXXXXX",
  ".........XXXXXXXXX",
  ".......X.XXXXX....",
  "......X.XXXXXXXX..",
  "X.....X.XXXXX.....",
  "XX.....XXXXXXXXX..",
  "XXX..XXXXXXXXX.X..",
  "XXXXXXXXXXXXXX....",
  ".XXXXXXXXXXXXX....",
  "..XXXXXXXXXXX.....",
  "...XXXXXXXXX......",
  "....XXX..XX.......",
  "....XX....X.......",
  "....XXX...XX......",
];
const CACTUS = ["...XX...", "..XXXX..", "..XXXX.X", "X.XXXX.X", "X.XXXX.X", "XXXXXXXX", ".XXXXXX.", "..XXXX..", "..XXXX..", "..XXXX..", "..XXXX.."];
const CLOUD = [".....XXXXX......", "....X.....XX....", "..XX........X...", ".X...........XX.", "XXXXXXXXXXXXXXXX"];

/** Пузырь реплики в пиксельной рамке, хвостик к говорящему. */
function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, k: number, tailLeft: boolean, col: string, bg: string) {
  ctx.font = "bold 8px Consolas, monospace";
  const tw = (Math.ceil(ctx.measureText(text).width) + 2) * k, bw = tw + 6 * k, bh = 10.4 * k + 6 * k, b = Math.max(2, k);
  if (!tailLeft) x -= bw;
  ctx.fillStyle = bg; ctx.fillRect(x, y, bw, bh);
  ctx.fillStyle = col;
  ctx.fillRect(x + b, y, bw - 2 * b, b); ctx.fillRect(x + b, y + bh - b, bw - 2 * b, b);
  ctx.fillRect(x, y + b, b, bh - 2 * b); ctx.fillRect(x + bw - b, y + b, b, bh - 2 * b);
  const tx = tailLeft ? x - b * 2 : x + bw;
  ctx.fillRect(tx, y + bh * 0.55, b * 2, b); ctx.fillRect(tailLeft ? tx - b : tx + b * 2, y + bh * 0.55 + b, b, b);
  pixText(ctx, text, x + 3 * k, y + 3.2 * k, 8, col, k);
}

const offline: Scene = {
  fps: 20, scale: 1, protect: 0.15,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 96, 74) : sideZone({ w, h });
    const px = small ? Math.max(1, Math.floor(z.w / 46)) : clamp(Math.floor(z.w / 62), 2, 5);
    const r = rng(311);
    const clouds = Array.from({ length: small ? 0 : 6 }, (_, i) => ({ x: r() * w, y: 70 + r() * h * 0.22, v: 4 + r() * 7, big: i < 2 }));
    return { z, px, small, r, clouds, peb: Array.from({ length: 30 }, () => [r(), r()]), d: [{ y: 0, v: 0 }, { y: 0, v: 0 }], best: 1e9, loud: -9, blink: [0, 0], parts: [] as any[], pops: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt, w } = e;
    const { z, px } = s;
    const W = "#f2f2f2", BG = "#1c1c1e", down = isDown(), slow = health() === "slow";
    if (!s.small) for (const c of s.clouds) {
      c.x -= c.v * dt; if (c.x < -90) c.x = w + 20;
      ctx.globalAlpha = c.big ? 0.55 : 0.16;
      sprite(ctx, CLOUD, c.x, c.y, c.big ? Math.max(2, px * 0.7) : 2, W);
    }
    ctx.globalAlpha = 1;
    const DW = 18 * px, DH = 18 * px;
    const gy = s.small ? z.y + z.h - 4 : z.y + Math.min(z.h * 0.42, 70 + DH + 140);
    ctx.fillStyle = W; ctx.fillRect(z.x, gy, z.w, Math.max(1, Math.round(px * 0.5)));
    for (const [u, v] of s.peb) ctx.fillRect(Math.round(z.x + u * z.w), Math.round(gy + 3 + v * px * 3), Math.max(1, Math.round(px * (v > 0.7 ? 1 : 0.5))), Math.max(1, Math.round(px * 0.5)));
    // Кактус между ними.
    sprite(ctx, CACTUS, z.x + z.w * 0.4 - 4 * px, gy - 11 * px, px, W);
    const xs = [z.x + 2, z.x + z.w - 2 - DW];
    const clk = newClick(s, e);
    if (clk) s.loud = t;
    s.d.forEach((d: any, i: number) => {
      const near = e.mouse && Math.abs(e.mx - (xs[i] + DW / 2)) < DW * 0.9 && Math.abs(e.my - (gy - DH / 2)) < DH * 1.3;
      if ((near || clk) && d.y === 0 && d.v === 0) d.v = -px * 55;
      d.v += px * 190 * dt; d.y += d.v * dt;
      if (d.y > 0) { d.y = 0; d.v = 0; }
      const bob = d.y === 0 ? (Math.floor(t * 1.6 + i * 0.5) % 2) * Math.max(1, Math.round(px * 0.5)) : 0;
      const x = xs[i], y = gy - DH + d.y + bob, flip = i === 1;
      sprite(ctx, DINO, x, y, px, W, W, flip);
      // Глаз: дырка 2×2 и зрачок к курсору; без связи — крестик.
      const ex = x + (flip ? 5 : 11) * px, ey = y + 2 * px;
      if (t > s.blink[i]) s.blink[i] = t + 2.5 + s.r() * 4;
      if (s.blink[i] - t < 0.12) return;
      ctx.fillStyle = BG; ctx.fillRect(ex, ey, 2 * px, 2 * px);
      ctx.fillStyle = W;
      if (down) { ctx.fillRect(ex, ey, px, px); ctx.fillRect(ex + px, ey + px, px, px); return; }
      const [lx, ly] = look(e, ex + px, ey + px, 160, [flip ? -1 : 1, 0]);
      ctx.fillRect(ex + (lx > 0.25 ? px : lx < -0.25 ? 0 : flip ? 0 : px), ey + (ly > 0.35 ? px : 0), px, px);
    });
    if (s.small) return;
    // Реплики: «RAWL?» — «RAWL!»; без связи — о пинге.
    const k = px >= 4 ? 2 : 1.5, ph = Math.floor(t / 2.4) % 4, loud = t - s.loud < 1.6;
    const say = down ? ["PING?", "...."] : slow ? ["RAWL?", "rawl.."] : loud ? ["RAWL!!", "RAWL!!"] : ["RAWL?", "RAWL!"];
    if (loud || ph < 3) bubble(ctx, xs[0] + DW + 2, gy - DH - 20, say[0], k, true, W, BG);
    if (loud || ph === 1 || ph === 2) bubble(ctx, xs[1] - 2, gy - DH + 14, say[1], k, false, W, BG);
    // Счёт как в игре: лучший пинг и текущий.
    if (sig.ms != null && sig.ms < s.best) s.best = sig.ms;
    const score = `HI ${pad5(s.best < 1e9 ? s.best : 0)}  ${pad5(sig.ms ?? 0)}`;
    ctx.font = "bold 8px Consolas, monospace";
    pixText(ctx, score, z.x + z.w - (Math.ceil(ctx.measureText(score).width) + 2) * 1.5, z.y + 4, 8, "rgba(242,242,242,.7)", 1.5);
    const fs = clamp(z.w / 10.5, 15, 28);
    ctx.fillStyle = W; ctx.textBaseline = "top";
    ctx.font = `600 ${fs}px Bahnschrift, "Segoe UI", sans-serif`;
    ctx.fillText(down ? "You are offline." : slow ? "Almost offline." : "You are online.", z.x, gy + fs * 1.3);
    ctx.font = `400 ${fs * 0.72}px Bahnschrift, "Segoe UI", sans-serif`;
    ctx.fillText(down ? "Try talk to people." : slow ? "Talk to people meanwhile." : "Still, talk to people.", z.x, gy + fs * 2.55);
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t, dt } = e;
    ctx.fillStyle = "#f2f2f2";
    for (let i = 0; i < e.trail.length; i += 3) {
      const [x, y, a] = e.trail[i], k = 1 - a / 1.2;
      if (k <= 0) continue;
      ctx.globalAlpha = k * 0.55; const q = Math.max(1, Math.round(4 * k));
      ctx.fillRect(Math.round(x / 4) * 4, Math.round(y / 4) * 4, q, q);
    }
    if (newClick(s, e, "_fx")) {
      for (let i = 0; i < 12; i++) { const a = s.r() * TAU, v = 60 + s.r() * 140; s.parts.push({ x: e.click!.x, y: e.click!.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80, t, life: 0.9 }); }
      s.pops.push({ x: e.click!.x, y: e.click!.y, t, life: 1.1 });
    }
    s.parts = particles(s.parts, t, (p: any, a) => { p.vy += 320 * dt; p.x += p.vx * dt; p.y += p.vy * dt; ctx.globalAlpha = a; ctx.fillRect(Math.round(p.x / 3) * 3, Math.round(p.y / 3) * 3, 3, 3); });
    s.pops = particles(s.pops, t, (p: any, a) => { ctx.globalAlpha = a; pixText(ctx, "RAWL!", p.x + 10, p.y - 26 - (1 - a) * 16, 8, "#f2f2f2", 2); });
    ctx.globalAlpha = 1;
  },
};

// ─── Дедлайн: полоска дня, жнец идёт к программисту ───────────────

/** Жнец (смотрит вправо) с косой; ноги на (x, y), рост ~64k. */
function reaper(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, t: number, eyes: number) {
  const P = (u: number, v: number) => [x + u * k, y + v * k] as const;
  const sway = Math.sin(t * 2.2) * 1.5;
  ctx.fillStyle = "#e11d2a";
  ctx.beginPath();
  ctx.moveTo(...P(-15 + sway, 0));
  ctx.lineTo(...P(-11, -26)); ctx.lineTo(...P(-10, -44)); ctx.quadraticCurveTo(...P(-8, -62), ...P(3, -63));
  ctx.quadraticCurveTo(...P(14, -61), ...P(15, -50)); ctx.lineTo(...P(11, -48)); ctx.lineTo(...P(13, -40));
  ctx.lineTo(...P(18, -36)); ctx.lineTo(...P(16, -31)); ctx.lineTo(...P(10, -30)); ctx.lineTo(...P(11, -14));
  ctx.lineTo(...P(14 + sway, 0));
  for (let i = 1; i < 6; i++) ctx.lineTo(...P(14 + sway - i * 5.8, (i % 2 ? -2.5 : 0) + Math.sin(t * 3 + i) * 0.8));
  ctx.closePath(); ctx.fill();
  // Лицо под капюшоном — тень; глаза загораются, когда курсор рядом.
  ctx.fillStyle = "#000"; ctx.beginPath(); ctx.ellipse(...P(9, -51), 4 * k, 6 * k, 0.3, 0, TAU); ctx.fill();
  if (eyes > 0.05) { ctx.fillStyle = rgba(255, 255, 255, eyes); ctx.fillRect(...P(9.5, -53), 1.6 * k, 1.6 * k); ctx.fillRect(...P(12, -52.5), 1.4 * k, 1.4 * k); }
  // Коса: древко и лезвие.
  ctx.strokeStyle = "#e11d2a"; ctx.lineWidth = 2.2 * k; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(...P(-4, -8)); ctx.lineTo(...P(25, -76)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(...P(25, -76)); ctx.quadraticCurveTo(...P(46, -80), ...P(52, -58)); ctx.quadraticCurveTo(...P(42, -72), ...P(24, -70)); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#e11d2a"; ctx.beginPath(); ctx.arc(...P(17, -34), 2.6 * k, 0, TAU); ctx.fill();
}

/** Программист за ноутбуком, голова горит; ноги стула на (x, y). */
function worker(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, t: number, rush: number) {
  const P = (u: number, v: number) => [x + u * k, y + v * k] as const;
  ctx.strokeStyle = "#f4f4f5"; ctx.lineCap = "round"; ctx.lineJoin = "round";
  // Стул и стол.
  ctx.lineWidth = 2 * k;
  ctx.beginPath(); ctx.moveTo(...P(-22, 0)); ctx.lineTo(...P(-20, -16)); ctx.lineTo(...P(-8, -16)); ctx.lineTo(...P(-6, 0));
  ctx.moveTo(...P(-22, -16)); ctx.lineTo(...P(-25, -34)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(...P(2, -26)); ctx.lineTo(...P(34, -26)); ctx.moveTo(...P(30, -26)); ctx.lineTo(...P(30, 0)); ctx.stroke();
  // Ноутбук: экран мерцает от набора.
  ctx.lineWidth = 1.8 * k;
  ctx.beginPath(); ctx.moveTo(...P(6, -27)); ctx.lineTo(...P(20, -27)); ctx.lineTo(...P(24, -44)); ctx.stroke();
  ctx.fillStyle = rgba(244, 244, 245, 0.15 + 0.25 * Math.abs(Math.sin(t * (6 + rush * 20))));
  ctx.beginPath(); ctx.moveTo(...P(20, -28)); ctx.lineTo(...P(23.5, -43)); ctx.lineTo(...P(25, -42)); ctx.lineTo(...P(21.5, -28)); ctx.fill();
  // Тело: сутулится к экрану, руки стучат.
  const tap = Math.sin(t * (9 + rush * 25)) * 1.5;
  ctx.lineWidth = 3.2 * k;
  ctx.beginPath(); ctx.moveTo(...P(-14, -17)); ctx.lineTo(...P(-6, -38));
  ctx.moveTo(...P(-14, -17)); ctx.lineTo(...P(2, -17)); ctx.lineTo(...P(2, 0));
  ctx.moveTo(...P(-7, -35)); ctx.lineTo(...P(4, -31 + tap)); ctx.lineTo(...P(12, -29));
  ctx.stroke();
  // Голова красная, над ней пламя.
  ctx.fillStyle = "#e11d2a"; ctx.beginPath(); ctx.arc(...P(-3, -45), 6 * k, 0, TAU); ctx.fill();
  ctx.fillStyle = "#f4f4f5"; ctx.beginPath(); ctx.arc(...P(-0.5, -43.5), 2.4 * k, -0.6, 2.2); ctx.fill();
  const fl = 1 + rush * 0.8;
  for (let i = 0; i < 3; i++) {
    const fx = -8 + i * 5, hgt = (10 + 6 * Math.sin(t * 11 + i * 2) + hash2(Math.floor(t * 12), i) * 4) * fl;
    ctx.fillStyle = i === 1 ? "#f4f4f5" : "#fca5a5";
    ctx.beginPath(); ctx.moveTo(...P(fx - 3, -49)); ctx.quadraticCurveTo(...P(fx - 3, -49 - hgt * 0.6), ...P(fx + Math.sin(t * 7 + i) * 2, -49 - hgt));
    ctx.quadraticCurveTo(...P(fx + 4, -49 - hgt * 0.5), ...P(fx + 3, -49)); ctx.fill();
  }
}

const TASKS: [string, () => boolean][] = [
  ["поднять туннель", () => !isDown()],
  ["пинг меньше 300 мс", () => sig.ms != null && sig.ms < 300],
  ["не трогать прод", () => true],
  ["сдать проект", () => false],
];

const deadline: Scene = {
  fps: 24, scale: 1, protect: 0.12,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 170, h > 80 ? 70 : 30) : sideZone({ w, h });
    return { z, small, r: rng(331), push: 0, embers: [] as any[], pops: [] as any[], fxe: [] as any[], slash: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, z = s.z;
    const RED = "#e11d2a", W = "#f4f4f5";
    const now = new Date(), day = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    const k = s.small ? clamp(z.h / 80, 0.35, 0.8) : clamp(Math.min(z.w / 230, z.h / 560), 0.75, 1.35);
    s.push *= Math.pow(0.5, dt / 2.5);
    const p = clamp(day - s.push, 0, 1);
    const x0 = z.x + 4, x1 = z.x + z.w - 4, by = s.small ? z.y + z.h - 8 : z.y + Math.max(330 * k, z.h * 0.6), bh = Math.max(3, 9 * k);
    const room = 66 * k, xp = x0 + (x1 - x0 - room) * p;
    const blinkBad = isDown() && Math.floor(t * 2) % 2 === 0;
    ctx.fillStyle = blinkBad ? "#7f1d1d" : RED; ctx.beginPath(); ctx.roundRect(x0, by, Math.max(bh, xp - x0), bh, [bh / 2, 0, 0, bh / 2]); ctx.fill();
    ctx.fillStyle = W; ctx.beginPath(); ctx.roundRect(xp, by, x1 - xp, bh, [0, bh / 2, bh / 2, 0]); ctx.fill();
    const wx = x1 - 30 * k, near = e.mouse && Math.hypot(e.mx - wx, e.my - (by - 30 * k)) < 70;
    const rush = clamp((near ? 0.7 : 0) + Math.max(0, p - 0.75) * 2, 0, 1);
    if (!s.small || z.h > 40) {
      reaper(ctx, xp - 4 * k, by, k, t, e.mouse && Math.hypot(e.mx - xp, e.my - (by - 45 * k)) < 90 ? 1 : 0);
      worker(ctx, wx, by, k, t, rush);
    }
    // Искры от горящей головы.
    if (s.r() < 0.3 + rush * 0.5) s.embers.push({ x: wx - 3 * k, y: by - 55 * k, vx: (s.r() - 0.5) * 20, vy: -20 - s.r() * 30, t, life: 1.2 });
    s.embers = particles(s.embers, t, (q: any, a) => { q.x += q.vx * dt; q.y += q.vy * dt; ctx.fillStyle = rgba(255, 120 + 80 * a, 60, a); ctx.fillRect(q.x, q.y, 2, 2); });
    if (newClick(s, e)) { s.push = Math.min(0.08, s.push + 0.021); s.pops.push({ x: wx, y: by - 70 * k, t, life: 1.4 }); }
    s.pops = particles(s.pops, t, (q: any, a) => { ctx.fillStyle = rgba(244, 244, 245, a); ctx.font = `700 ${13 * k}px "Segoe UI", sans-serif`; ctx.fillText("+30 мин", q.x - 20, q.y - (1 - a) * 20); });
    if (s.small) return;
    // Часы: деления, время у жнеца, «DEADLine», обратный отсчёт.
    ctx.fillStyle = "rgba(244,244,245,.35)";
    for (let i = 0; i <= 24; i++) { const x = x0 + ((x1 - x0 - room) * i) / 24; ctx.fillRect(x, by + bh + 3, 1, i % 6 ? 3 : 6); }
    ctx.textBaseline = "top";
    const hh = String(now.getHours()).padStart(2, "0"), mm = String(now.getMinutes()).padStart(2, "0");
    ctx.font = `600 ${11 * k}px Consolas, monospace`; ctx.fillStyle = RED; ctx.fillText(`${hh}:${mm}`, xp - 14 * k, by + bh + 10);
    ctx.font = `700 ${22 * k}px "Segoe UI", sans-serif`;
    const lw = ctx.measureText("DEADLine").width, lx = z.x + (z.w - lw) / 2, ly = by + bh + 28 * k;
    ctx.fillStyle = RED; ctx.fillText("DEAD", lx, ly);
    ctx.fillStyle = W; ctx.fillText("Line", lx + ctx.measureText("DEAD").width, ly);
    const left = Math.max(0, 86400 * (1 - day));
    const cd = [left / 3600, (left / 60) % 60, left % 60].map((v) => String(Math.floor(v)).padStart(2, "0")).join(":");
    ctx.font = `400 ${12 * k}px Consolas, monospace`; ctx.fillStyle = "rgba(244,244,245,.55)";
    // Крупный отсчёт над полосой.
    ctx.font = `400 ${12 * k}px "Segoe UI", sans-serif`; const lab = "до полуночи"; ctx.fillText(lab, z.x + (z.w - ctx.measureText(lab).width) / 2, by - 150 * k);
    ctx.font = `700 ${40 * k}px Consolas, monospace`; ctx.fillStyle = left < 3600 && Math.floor(t * 2) % 2 ? W : RED;
    ctx.fillText(cd, z.x + (z.w - ctx.measureText(cd).width) / 2, by - 132 * k);
    // Неделя: прошедшие дни зачёркнуты, сегодня — красный.
    const wd = (now.getDay() + 6) % 7, cell = (z.w - 8) / 7, wy = ly + 46 * k;
    ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].forEach((d, i) => {
      const x = z.x + 4 + i * cell;
      ctx.strokeStyle = i === wd ? RED : "rgba(244,244,245,.35)"; ctx.lineWidth = 1.2; ctx.strokeRect(x + 2, wy, cell - 4, cell - 4);
      if (i === wd) { ctx.fillStyle = RED; ctx.fillRect(x + 2, wy, (cell - 4) * day, cell - 4); }
      ctx.fillStyle = i < wd ? "rgba(244,244,245,.35)" : W; ctx.font = `600 ${10 * k}px "Segoe UI", sans-serif`;
      ctx.fillText(d, x + (cell - ctx.measureText(d).width) / 2, wy + (cell - 4) / 2 - 6 * k);
      if (i < wd) { ctx.strokeStyle = "rgba(244,244,245,.5)"; ctx.beginPath(); ctx.moveTo(x + 4, wy + 2); ctx.lineTo(x + cell - 4, wy + cell - 6); ctx.stroke(); }
    });
    // Список дел над полоской: отмечается по состоянию связи.
    let ty = z.y + 8;
    ctx.font = `600 ${12 * k}px "Segoe UI", sans-serif`; ctx.fillStyle = "rgba(244,244,245,.5)"; ctx.fillText("TODO", z.x + 2, ty); ty += 22 * k;
    for (const [name, done] of TASKS) {
      const ok = done();
      ctx.strokeStyle = ok ? W : RED; ctx.lineWidth = 1.4; ctx.strokeRect(z.x + 3, ty + 2, 11 * k, 11 * k);
      if (ok) { ctx.beginPath(); ctx.moveTo(z.x + 5, ty + 8 * k); ctx.lineTo(z.x + 3 + 5 * k, ty + 11 * k); ctx.lineTo(z.x + 3 + 11 * k, ty); ctx.stroke(); }
      else if (Math.floor(t * 1.5) % 2) { ctx.fillStyle = RED; ctx.fillText("!", z.x + 6.5 * k, ty); }
      ctx.font = `400 ${13 * k}px "Segoe UI", sans-serif`; ctx.fillStyle = ok ? "rgba(244,244,245,.45)" : W;
      ctx.fillText(name, z.x + 22 * k, ty);
      if (ok) { ctx.fillRect(z.x + 22 * k, ty + 8 * k, ctx.measureText(name).width, 1); }
      ctx.font = `600 ${12 * k}px "Segoe UI", sans-serif`;
      ty += 22 * k;
    }
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t, dt } = e;
    for (let i = 0; i < e.trail.length; i += 4) { const [x, y, a] = e.trail[i]; if (a < 0.1 && s.r() < 0.5) s.fxe.push({ x, y, vx: (s.r() - 0.5) * 16, vy: -15 - s.r() * 25, t, life: 0.9 }); }
    s.fxe = particles(s.fxe, t, (q: any, a) => { q.x += q.vx * dt; q.y += q.vy * dt; ctx.fillStyle = rgba(255, 80 + 120 * a, 40, a * 0.9); ctx.fillRect(q.x, q.y, 2, 2); });
    if (newClick(s, e, "_fx")) s.slash.push({ x: e.click!.x, y: e.click!.y, t, life: 0.45 });
    s.slash = particles(s.slash, t, (q: any, a) => {
      const u = 1 - a;
      ctx.strokeStyle = rgba(225, 29, 42, a); ctx.lineWidth = 3 * a + 1;
      ctx.beginPath(); ctx.arc(q.x - 10, q.y + 10, 34, -2.4 + u * 1.6, -1.2 + u * 1.6); ctx.stroke();
    });
  },
};

// ─── Ctrl+Alt+Del: негатив летит в корзину ───────────────────────

const NEG = ["lag", "timeout", "packet loss", "jitter", "503", "ERR", "blocked", "throttle", "DPI", "403", "drop", "NaN ms", "retry…", "no route", "overthinking", "doubt"];

function gear(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, a: number) {
  ctx.beginPath();
  for (let i = 0; i < 32; i++) {
    const ang = a + (i / 32) * TAU, tooth = Math.floor((i + 1) / 2) % 2 === 0;
    const r = tooth ? R : R * 0.76;
    ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
  }
  ctx.closePath(); ctx.fill();
  ctx.save(); ctx.globalCompositeOperation = "destination-out"; ctx.beginPath(); ctx.arc(x, y, R * 0.32, 0, TAU); ctx.fill(); ctx.restore();
}
const HEAD = [[-0.9, 1], [-1, 0.05], [-0.72, -0.78], [0, -1.05], [0.68, -0.8], [0.95, -0.22], [1.18, 0.16], [0.92, 0.27], [0.9, 0.6], [0.5, 0.68], [0.42, 1]];
const BOLT = [[0.12, -0.72], [-0.36, 0.06], [-0.02, 0.06], [-0.16, 0.62], [0.4, -0.16], [0.06, -0.16], [0.26, -0.72]];

const cad: Scene = {
  fps: 30, scale: 1, protect: 0.12,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 120, 40) : sideZone({ w, h });
    return { z, small, r: rng(347), words: [] as any[], next: 0.5, lid: 0, lidT: -9, keys: [] as any[], bits: [] as any[], spin: 0, zap: 0 };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e, z = s.z, W = "#f5f5f5";
    const k = s.small ? 0.55 : clamp(z.w / 196, 0.85, 1.3);
    // Значки: шестерёнка (крутится от трафика), голова с молнией, корзина.
    const ix = s.small ? z.x + 10 : z.x + 16 * k, rows = s.small ? [z.y + z.h / 2, z.y + z.h / 2, z.y + z.h / 2] : [0, 1, 2].map((i) => z.y + (78 + i * 62) * k);
    const cols = s.small ? [ix, ix + 34, ix + 68] : [ix, ix, ix];
    s.spin += dt * (0.35 + sig.load * 3);
    ctx.fillStyle = W;
    gear(ctx, cols[0], rows[0], 15 * k, s.spin);
    const hx = cols[1], hy = rows[1], HR = 15 * k;
    ctx.beginPath(); HEAD.forEach(([u, v], i) => (i ? ctx.lineTo(hx + u * HR, hy + v * HR) : ctx.moveTo(hx + u * HR, hy + v * HR))); ctx.closePath(); ctx.fill();
    const nearHead = e.mouse && Math.hypot(e.mx - hx, e.my - hy) < 80;
    s.zap = Math.max(0, s.zap - dt * 2);
    if (nearHead || s.r() < 0.01) s.zap = 1;
    ctx.fillStyle = s.zap > 0.3 && Math.floor(t * 20) % 2 ? "#facc15" : "#000";
    ctx.beginPath(); BOLT.forEach(([u, v], i) => (i ? ctx.lineTo(hx + u * HR, hy + v * HR) : ctx.moveTo(hx + u * HR, hy + v * HR))); ctx.closePath(); ctx.fill();
    // Корзина: крышка открывается, когда в неё что-то летит.
    const tx = cols[2], ty = rows[2], TR = 13 * k;
    const nearBin = e.mouse && Math.hypot(e.mx - tx, e.my - ty) < 60;
    s.lid += ((t - s.lidT < 0.45 ? 1 : nearBin ? 0.5 : 0) - s.lid) * 0.3;
    ctx.fillStyle = W;
    ctx.beginPath(); ctx.moveTo(tx - TR * 0.8, ty - TR * 0.55); ctx.lineTo(tx + TR * 0.8, ty - TR * 0.55); ctx.lineTo(tx + TR * 0.65, ty + TR); ctx.lineTo(tx - TR * 0.65, ty + TR); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#000"; for (const u of [-0.35, 0, 0.35]) ctx.fillRect(tx + u * TR - TR * 0.07, ty - TR * 0.3, TR * 0.14, TR * 1.05);
    ctx.save(); ctx.translate(tx - TR * 0.95, ty - TR * 0.7); ctx.rotate(-s.lid * 0.9);
    ctx.fillStyle = W; ctx.fillRect(0, -TR * 0.18, TR * 1.9, TR * 0.22); ctx.fillRect(TR * 0.7, -TR * 0.38, TR * 0.5, TR * 0.22);
    ctx.restore();
    // Негатив: слова прилетают справа, у колонки сворачивают в корзину.
    s.next -= dt * (isDown() ? 3 : health() === "slow" ? 1.8 : 1);
    if (s.next <= 0 && s.words.length < 14) { s.next = 2.2; s.words.push({ txt: NEG[(s.r() * NEG.length) | 0], x: w + 10, y: 70 + s.r() * (h - 140), v: 22 + s.r() * 26, sc: 1 }); }
    const clk = newClick(s, e) ? e.click! : null;
    let hit = false;
    ctx.textBaseline = "middle";
    s.words = s.words.filter((q: any) => {
      ctx.font = `700 ${s.small ? 9 : 12}px "Segoe UI", sans-serif`;
      const tw = ctx.measureText(q.txt).width;
      const over = e.mouse && e.mx > q.x - 6 && e.mx < q.x + tw + 6 && Math.abs(e.my - q.y) < 12;
      if (clk && clk.x > q.x - 6 && clk.x < q.x + tw + 6 && Math.abs(clk.y - q.y) < 12) {
        hit = true;
        for (let i = 0; i < 16; i++) s.bits.push({ x: q.x + s.r() * tw, y: q.y + (s.r() - 0.5) * 8, vy: 20 + s.r() * 60, t, life: 0.8 });
        s.keys.push({ x: clk.x, y: clk.y, txt: "Del", t, life: 0.9 });
        return false;
      }
      const toBin = q.x < z.x + z.w + 140;
      if (toBin) { q.x += (tx - q.x) * 2 * dt; q.y += (ty - q.y) * 2 * dt; q.sc = clamp(Math.hypot(tx - q.x, ty - q.y) / 120, 0.15, 1); }
      else q.x -= q.v * dt * (over ? 0.2 : 1);
      if (Math.hypot(tx - q.x, ty - q.y) < 10) { s.lidT = t; return false; }
      ctx.save(); ctx.translate(q.x, q.y); ctx.scale(q.sc, q.sc);
      if (over) { ctx.fillStyle = W; ctx.fillRect(-4, -9, tw + 8, 18); ctx.fillStyle = "#000"; }
      else ctx.fillStyle = rgba(245, 245, 245, 0.55);
      ctx.fillText(q.txt, 0, 0); ctx.restore();
      return q.x > -100;
    });
    if (clk && !hit) ["Ctrl", "Alt", "Del"].forEach((txt, i) => s.keys.push({ x: clk.x + (i - 1) * 46, y: clk.y, txt, t: t + i * 0.12, life: 0.9 }));
    if (s.small) return;
    ctx.textBaseline = "top";
    ctx.font = `800 ${25 * k}px "Segoe UI", sans-serif`; ctx.fillStyle = W;
    ctx.fillText("ctrl+alt+del", z.x + 2, z.y + 10);
    const TXT = [["CONTROL", "YOURSELF"], ["ALTER YOUR", "THINKING"], ["DELETE", "NEGATIVITY"]];
    ctx.font = `700 ${12.5 * k}px "Segoe UI", sans-serif`;
    (ctx as any).letterSpacing = `${2 * k}px`;
    TXT.forEach(([a, b], i) => { ctx.fillText(a, ix + 30 * k, rows[i] - 15 * k); ctx.fillText(b, ix + 30 * k, rows[i] + 2 * k); });
    (ctx as any).letterSpacing = "0px";
  },
  fx(ctx, s, e) {
    const { t, dt } = e;
    s.bits = particles(s.bits, t, (q: any, a) => { q.y += q.vy * dt; ctx.fillStyle = rgba(245, 245, 245, a); ctx.fillRect(Math.round(q.x), Math.round(q.y), 2, 2); });
    s.keys = particles(s.keys.filter((q: any) => q.t <= t), t, (q: any, a) => {
      const u = 1 - a, press = u < 0.15 ? u / 0.15 : 1;
      ctx.save(); ctx.translate(q.x, q.y - u * 10); ctx.globalAlpha = a;
      ctx.fillStyle = "#1a1a1a"; ctx.strokeStyle = "#f5f5f5"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(-20, -14 + press * 2, 40, 26, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#f5f5f5"; ctx.font = "600 11px 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(q.txt, 0, -1 + press * 2);
      ctx.restore(); ctx.textAlign = "left";
    });
  },
};

// ─── while(alive): цикл жизни, стоит без связи ────────────────────

const STEP = ["eat", "code", "game", "music", "sleep", "repeat"];
function stepIcon(ctx: CanvasRenderingContext2D, i: number, x: number, y: number, q: number, t: number, col: string) {
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1.5, q * 0.1); ctx.lineCap = "round";
  if (i === 0) { // миска и пар
    ctx.beginPath(); ctx.arc(x, y - q * 0.05, q * 0.42, 0.1, Math.PI - 0.1); ctx.closePath(); ctx.stroke();
    for (const d of [-0.18, 0.12]) { ctx.beginPath(); ctx.moveTo(x + d * q, y - q * 0.15); ctx.quadraticCurveTo(x + d * q + Math.sin(t * 4 + d * 9) * q * 0.12, y - q * 0.38, x + d * q, y - q * 0.6); ctx.stroke(); }
  } else if (i === 1) { // </> и курсор
    ctx.font = `700 ${q * 0.7}px Consolas, monospace`; ctx.textBaseline = "middle"; ctx.fillText("</>", x - q * 0.55, y);
    if (Math.floor(t * 2.5) % 2) ctx.fillRect(x + q * 0.55, y - q * 0.28, q * 0.08, q * 0.56);
  } else if (i === 2) { // геймпад
    ctx.beginPath(); ctx.roundRect(x - q * 0.5, y - q * 0.25, q, q * 0.5, q * 0.22); ctx.stroke();
    ctx.fillRect(x - q * 0.34, y - q * 0.03, q * 0.2, q * 0.06); ctx.fillRect(x - q * 0.27, y - q * 0.1, q * 0.06, q * 0.2);
    for (const [u, v, ph] of [[0.25, -0.06, 0], [0.36, 0.06, 1]]) { ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 4 + ph)); ctx.beginPath(); ctx.arc(x + u * q, y + v * q, q * 0.05, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
  } else if (i === 3) { // ноты прыгают
    for (const [d, ph] of [[-0.2, 0], [0.2, 1.4]]) {
      const by = y + q * 0.2 - Math.abs(Math.sin(t * 4 + ph)) * q * 0.15;
      ctx.beginPath(); ctx.ellipse(x + d * q, by, q * 0.11, q * 0.08, -0.4, 0, TAU); ctx.fill();
      ctx.fillRect(x + d * q + q * 0.08, by - q * 0.45, q * 0.05, q * 0.45);
    }
    ctx.fillRect(x - q * 0.07, y - q * 0.27 - Math.abs(Math.sin(t * 4)) * q * 0.15, q * 0.4, q * 0.06);
  } else if (i === 4) { // z Z
    ctx.textBaseline = "middle";
    for (let j = 0; j < 3; j++) { const u = (t * 0.7 + j / 3) % 1; ctx.globalAlpha = Math.sin(u * Math.PI); ctx.font = `700 ${q * (0.3 + u * 0.4)}px "Segoe UI", sans-serif`; ctx.fillText(j % 2 ? "Z" : "z", x - q * 0.3 + u * q * 0.5, y + q * 0.25 - u * q * 0.6); }
    ctx.globalAlpha = 1;
  } else { // круговая стрелка
    const a = t * 3;
    ctx.beginPath(); ctx.arc(x, y, q * 0.32, a, a + 4.8); ctx.stroke();
    const ex = x + Math.cos(a + 4.8) * q * 0.32, ey = y + Math.sin(a + 4.8) * q * 0.32, ta = a + 4.8 + Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(ex + Math.cos(ta) * q * 0.14, ey + Math.sin(ta) * q * 0.14); ctx.lineTo(ex + Math.cos(ta - 2.3) * q * 0.14, ey + Math.sin(ta - 2.3) * q * 0.14); ctx.lineTo(ex + Math.cos(ta + 2.3) * q * 0.14, ey + Math.sin(ta + 2.3) * q * 0.14); ctx.fill();
  }
}

const alive: Scene = {
  fps: 24, scale: 1, protect: 0.12,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 130, h > 80 ? 60 : 30) : sideZone({ w, h });
    return { z, small, r: rng(359), cur: 0, at: 0, n: 1, parts: [] as any[], booms: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t } = e, z = s.z;
    const hl = health(), dead = hl === "down" || hl === "engine_off", slow = hl === "slow";
    const PINK = "#f472b6", GREEN = "#22c55e", WH = "#f5f5f5", AL = dead ? "#ef4444" : slow ? "#fbbf24" : GREEN;
    if (dead) s.cur = 4;
    else if (t - s.at > 2.4) { s.at = t; s.cur = (s.cur + 1) % 6; if (s.cur === 0) s.n++; }
    if (s.small) {
      ctx.font = `600 ${Math.min(13, z.h * 0.3)}px "Segoe UI", sans-serif`; ctx.textBaseline = "top";
      ctx.fillStyle = PINK; ctx.fillText("while", z.x, z.y + 2); let x = z.x + ctx.measureText("while").width;
      ctx.fillStyle = WH; ctx.fillText("(", x, z.y + 2); x += ctx.measureText("(").width;
      ctx.fillStyle = AL; ctx.fillText("alive", x, z.y + 2); x += ctx.measureText("alive").width;
      ctx.fillStyle = WH; ctx.fillText(")", x, z.y + 2);
      if (z.h > 40) { ctx.fillStyle = GREEN; ctx.fillText(`  ${STEP[s.cur]}();`, z.x, z.y + 22); stepIcon(ctx, s.cur, z.x + z.w - 14, z.y + 30, 18, t, GREEN); }
      return;
    }
    const fs = Math.min(26, z.w / 7.2, z.h / 13.5), lh = fs * 1.34, x0 = z.x + 10, y0 = z.y + 4;
    ctx.font = `500 ${fs}px "Segoe UI Variable Display", "Segoe UI", sans-serif`; ctx.textBaseline = "top";
    // Строка под курсором и щелчок по ней — прыжок цикла.
    const li = e.mouse && e.mx > z.x && e.mx < z.x + z.w ? Math.floor((e.my - y0) / lh) : -1;
    if (newClick(s, e) && li >= 2 && li <= 7 && !dead) {
      s.cur = li - 2; s.at = t;
      for (let i = 0; i < 10; i++) s.booms.push({ x: e.click!.x, y: e.click!.y, a: s.r() * TAU, v: 40 + s.r() * 80, t, life: 0.8, c: s.r() < 0.5 ? GREEN : PINK });
    }
    const cl = 2 + s.cur;
    ctx.fillStyle = rgba(34, 197, 94, dead ? 0.05 : 0.1); ctx.fillRect(z.x, y0 + cl * lh - 2, z.w, lh);
    ctx.fillStyle = dead ? "#ef4444" : GREEN; ctx.fillRect(z.x, y0 + cl * lh - 2, 3, lh);
    let x = x0;
    const put = (txt: string, col: string, y: number) => { ctx.fillStyle = col; ctx.fillText(txt, x, y); x += ctx.measureText(txt).width; };
    put("while", PINK, y0); put("(", WH, y0);
    const ax = x; put("alive", AL, y0);
    if (dead) { ctx.fillStyle = "#ef4444"; ctx.fillRect(ax, y0 + fs * 0.62, ctx.measureText("alive").width, Math.max(1.5, fs * 0.07)); }
    put(")", WH, y0);
    x = x0; put("{", WH, y0 + lh);
    STEP.forEach((n, i) => {
      x = x0 + fs * 0.9;
      const y = y0 + (2 + i) * lh;
      put(n, GREEN, y); put("();", WH, y);
      if (li === 2 + i) { ctx.fillStyle = rgba(34, 197, 94, 0.6); ctx.fillRect(x0 + fs * 0.9, y + fs * 1.15, x - x0 - fs * 0.9, 1.5); }
    });
    x = x0; put("}", WH, y0 + 8 * lh);
    stepIcon(ctx, s.cur, z.x + z.w - fs * 0.9, y0 + cl * lh + fs * 0.58, fs * 1.1, t, dead ? "#ef4444" : GREEN);
    ctx.font = `400 ${Math.max(11, fs * 0.5)}px Consolas, monospace`; ctx.fillStyle = "rgba(245,245,245,.4)";
    const note = dead ? "// alive == false: нет связи" : slow ? `// lag: ${sig.ms ?? "?"} ms` : `// iteration ${s.n}`;
    ctx.fillText(note, x0, y0 + 9 * lh + 4);
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t, dt } = e;
    ctx.font = "700 13px Consolas, monospace"; ctx.textBaseline = "middle";
    for (let i = 0; i < e.trail.length; i += 4) { const [x, y, a] = e.trail[i], k = 1 - a / 1.2; if (k <= 0) continue; ctx.fillStyle = rgba(34, 197, 94, k * 0.7); ctx.fillText(i % 8 ? ";" : "()", x, y); }
    s.booms = particles(s.booms, t, (q: any, a) => { const d = (1 - a) * q.v; ctx.fillStyle = q.c; ctx.globalAlpha = a; ctx.fillText(Math.floor(q.a * 3) % 2 ? "{ }" : "();", q.x + Math.cos(q.a) * d, q.y + Math.sin(q.a) * d); });
    ctx.globalAlpha = 1;
    void dt;
  },
};

// ─── N*PE: манга-девушка в наушниках, пиксельные буквы (светлая) ──

/** Пиксельный шрифт 5×7: буквы крупными блоками с бликом, как в старых играх. */
const GLYPH: Record<string, string[]> = {
  N: ["X...X", "XX..X", "XX..X", "X.X.X", "X..XX", "X..XX", "X...X"],
  P: ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  E: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  L: ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  R: ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  "8": [".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX."],
  "*": [".X.X.", "..X..", ".X.X.", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", "XX...", "XX..."],
  "?": [".XXX.", "X...X", "....X", "..XX.", "..X..", ".....", "..X.."],
};
function bits(text: string): boolean[][] {
  const rows: boolean[][] = Array.from({ length: 7 }, () => []);
  for (const ch of text) { const g = GLYPH[ch] ?? GLYPH["."]; for (let j = 0; j < 7; j++) rows[j].push(...[...g[j]].map((c) => c === "X"), false); }
  return rows;
}
function bigPix(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, B: number, t: number, jump: number) {
  const g = bits(text), W = g[0].length;
  const letterW = 6;
  for (let j = 0; j < g.length; j++) for (let i = 0; i < W; i++) {
    if (!g[j][i]) continue;
    const li = Math.floor(i / letterW), dy = jump > 0 ? -Math.max(0, Math.sin((jump * 6 - li * 0.6))) * B * 1.5 : 0;
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(x + i * B, y + j * B + dy, B + 0.5, B + 0.5);
    // Толще штрих: блок тени справа-снизу; блик — на верхних левых углах.
    if (!g[j][i + 1]) ctx.fillRect(x + (i + 1) * B, y + j * B + dy + B * 0.3, B * 0.45, B * 0.7);
    if (!(g[j - 1]?.[i]) && !(g[j][i - 1])) { ctx.fillStyle = "#fff"; ctx.fillRect(x + i * B + B * 0.18, y + j * B + B * 0.18 + dy, B * 0.32, B * 0.32); }
  }
  void t;
  return W * B;
}
const NOTE = ["..XX", "..XX", "..X.", "..X.", "XXX.", "XXX."];

const nope: Scene = {
  fps: 24, scale: 1, protect: 0.08,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 70, 90) : sideZone({ w, h });
    const r = rng(373);
    return { z, small, r, blink: 2, notes: [] as any[], jump: -9, wag: -9, glint: 3, drift: Array.from({ length: small ? 0 : 9 }, () => ({ x: r() * w, y: r() * h, v: 6 + r() * 8 })), pops: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e, z = s.z;
    if (!s.small) for (const q of s.drift) { q.y -= q.v * dt; if (q.y < -20) { q.y = h + 10; q.x = s.r() * w; } ctx.globalAlpha = 0.1; sprite(ctx, NOTE, q.x, q.y, 3, "#111"); }
    ctx.globalAlpha = 1;
    const B = s.small ? 1.6 : clamp(z.w / 34, 4, 8);
    const S = s.small ? z.w : Math.min(z.w - 16, z.h * 0.5), sx = z.x + (z.w - S) / 2;
    const ty = s.small ? z.y : z.y + 8, sy = s.small ? z.y + 4 : ty + 10 * B;
    const clk = newClick(s, e);
    if (clk) { s.jump = t; s.wag = t; s.pops.push({ x: e.click!.x, y: e.click!.y, t, life: 1 }); }
    const jmp = t - s.jump < 1.2 ? t - s.jump : 0;
    if (!s.small) { const tw = bits("N*PE")[0].length * B; bigPix(ctx, "N*PE", z.x + (z.w - tw) / 2, ty, B, t, jmp); }
    // Серый квадрат-фон и сама девушка (единицы — доля квадрата).
    ctx.fillStyle = "#a6a6a6"; ctx.beginPath(); ctx.moveTo(sx, sy + 2); ctx.lineTo(sx + S - 3, sy); ctx.lineTo(sx + S, sy + S * 0.96); ctx.lineTo(sx + 2, sy + S); ctx.closePath(); ctx.fill();
    const X = (u: number) => sx + u * S, Y = (v: number) => sy + v * S;
    const sway = Math.sin(t * 1.3) * 0.015;
    const K = "#0a0a0a", lw = Math.max(1, S / 140);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    // Хвост и волосы сзади.
    ctx.fillStyle = K;
    ctx.beginPath(); ctx.moveTo(X(0.7), Y(0.18));
    ctx.bezierCurveTo(X(0.95 + sway), Y(0.2), X(1.02 + sway), Y(0.42), X(0.94 + sway * 2), Y(0.56));
    ctx.bezierCurveTo(X(1.0 + sway * 2), Y(0.66), X(0.9 + sway * 2), Y(0.78), X(0.86 + sway * 2), Y(0.74));
    ctx.bezierCurveTo(X(0.84), Y(0.6), X(0.8), Y(0.5), X(0.74), Y(0.4)); ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(0.24), Y(0.62)); ctx.bezierCurveTo(X(0.16), Y(0.3), X(0.3), Y(0.06), X(0.5), Y(0.06));
    ctx.bezierCurveTo(X(0.72), Y(0.06), X(0.82), Y(0.3), X(0.76), Y(0.62)); ctx.closePath(); ctx.fill();
    // Рубашка и шея.
    ctx.fillStyle = "#fff"; ctx.strokeStyle = K; ctx.lineWidth = lw * 1.4;
    ctx.beginPath(); ctx.moveTo(X(0.16), Y(1)); ctx.bezierCurveTo(X(0.18), Y(0.84), X(0.26), Y(0.78), X(0.42), Y(0.74));
    ctx.lineTo(X(0.48), Y(0.79)); ctx.lineTo(X(0.55), Y(0.74)); ctx.bezierCurveTo(X(0.72), Y(0.78), X(0.8), Y(0.84), X(0.84), Y(1)); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0.43), Y(0.63)); ctx.lineTo(X(0.42), Y(0.745)); ctx.moveTo(X(0.54), Y(0.62)); ctx.lineTo(X(0.55), Y(0.745)); ctx.stroke();
    ctx.fillStyle = K; ctx.font = `700 ${S * 0.06}px "Yu Gothic", "MS Gothic", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("回線", X(0.5), Y(0.9)); ctx.font = `600 ${S * 0.028}px "Segoe UI", sans-serif`; ctx.fillText("ON AIR", X(0.5), Y(0.95)); ctx.textAlign = "left";
    // Лицо.
    ctx.fillStyle = "#fff"; ctx.lineWidth = lw * 1.4;
    ctx.beginPath(); ctx.moveTo(X(0.3), Y(0.28)); ctx.bezierCurveTo(X(0.29), Y(0.5), X(0.36), Y(0.62), X(0.48), Y(0.66));
    ctx.bezierCurveTo(X(0.6), Y(0.62), X(0.68), Y(0.5), X(0.67), Y(0.28)); ctx.closePath(); ctx.fill(); ctx.stroke();
    // Ухо с наушником и провода.
    ctx.beginPath(); ctx.arc(X(0.68), Y(0.46), S * 0.035, -1.2, 1.6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#f4f4f4"; ctx.beginPath(); ctx.arc(X(0.695), Y(0.48), S * 0.022, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(X(0.695), Y(0.5)); ctx.bezierCurveTo(X(0.7), Y(0.7), X(0.6 + sway), Y(0.78), X(0.6), Y(1));
    ctx.moveTo(X(0.31), Y(0.5)); ctx.bezierCurveTo(X(0.3), Y(0.7), X(0.4 - sway), Y(0.8), X(0.42), Y(1)); ctx.stroke();
    // Чёлка.
    ctx.fillStyle = K;
    const BANG = [[0.25, 0.42], [0.31, 0.26], [0.34, 0.43], [0.4, 0.27], [0.45, 0.4], [0.5, 0.26], [0.55, 0.38], [0.6, 0.26], [0.64, 0.36], [0.68, 0.27], [0.72, 0.35]];
    ctx.beginPath(); ctx.moveTo(X(BANG[0][0]), Y(BANG[0][1]));
    for (let i = 1; i < BANG.length; i++) { const [u, v] = BANG[i], [pu, pv] = BANG[i - 1]; ctx.quadraticCurveTo(X((u + pu) / 2 + (v > pv ? 0.012 : -0.012)), Y((v + pv) / 2 - 0.03), X(u), Y(v)); }
    ctx.lineTo(X(0.75), Y(0.14)); ctx.quadraticCurveTo(X(0.5), Y(0.0), X(0.26), Y(0.14)); ctx.closePath(); ctx.fill();
    // Глаза: усталые, моргают; ближе курсор — прищур.
    if (t > s.blink) s.blink = t + 2.4 + s.r() * 3.5;
    const shut = s.blink - t < 0.13, near = e.mouse && Math.hypot(e.mx - X(0.48), e.my - Y(0.45)) < S * 0.9;
    const [lx, ly] = look(e, X(0.48), Y(0.46), 300);
    for (const [ex, lid] of [[0.395, 0.45], [0.565, near ? 0.62 : 0.35]] as const) {
      const er = S * 0.04, cx = X(ex), cy = Y(0.465);
      if (shut) { ctx.strokeStyle = K; ctx.lineWidth = lw * 1.6; ctx.beginPath(); ctx.moveTo(cx - er, cy); ctx.quadraticCurveTo(cx, cy + er * 0.5, cx + er, cy); ctx.stroke(); continue; }
      ctx.fillStyle = K; ctx.beginPath(); ctx.ellipse(cx + lx * er * 0.25, cy + ly * er * 0.15, er * 0.75, er, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(cx + lx * er * 0.25 - er * 0.3, cy - er * 0.4, er * 0.22, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + lx * er * 0.25 + er * 0.25, cy + er * 0.3, er * 0.1, 0, TAU); ctx.fill();
      // Веко сверху.
      ctx.fillStyle = "#fff"; ctx.fillRect(cx - er * 1.2, cy - er * 1.3, er * 2.4, er * 2 * lid);
      ctx.strokeStyle = K; ctx.lineWidth = lw * 1.6; ctx.beginPath(); ctx.moveTo(cx - er * 1.1, cy - er * 1.3 + er * 2 * lid); ctx.lineTo(cx + er * 1.1, cy - er * 1.2 + er * 2 * lid); ctx.stroke();
    }
    // Румянец штрихами, рот.
    ctx.lineWidth = lw;
    for (const bx of [0.37, 0.58]) for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(X(bx + i * 0.018), Y(0.535)); ctx.lineTo(X(bx + i * 0.018 + 0.012), Y(0.515)); ctx.stroke(); }
    ctx.lineWidth = lw * 1.3; ctx.beginPath(); ctx.moveTo(X(0.46), Y(0.6)); ctx.quadraticCurveTo(X(0.48), Y(0.595), X(0.5), Y(0.602)); ctx.stroke();
    // Очки и блик по стёклам.
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath(); ctx.roundRect(X(0.33), Y(0.415), S * 0.13, S * 0.1, S * 0.02); ctx.roundRect(X(0.5), Y(0.415), S * 0.13, S * 0.1, S * 0.02);
    ctx.moveTo(X(0.46), Y(0.44)); ctx.lineTo(X(0.5), Y(0.44)); ctx.moveTo(X(0.63), Y(0.43)); ctx.lineTo(X(0.68), Y(0.44)); ctx.stroke();
    if (t > s.glint) s.glint = t + 4 + s.r() * 4;
    const gu = 1 - (s.glint - t) / 0.5;
    if (gu > 0 && gu < 1) {
      ctx.save(); ctx.beginPath(); ctx.rect(X(0.33), Y(0.415), S * 0.13, S * 0.1); ctx.rect(X(0.5), Y(0.415), S * 0.13, S * 0.1); ctx.clip();
      ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.beginPath(); const gx = X(0.3 + gu * 0.4);
      ctx.moveTo(gx, Y(0.4)); ctx.lineTo(gx + S * 0.04, Y(0.4)); ctx.lineTo(gx - S * 0.02, Y(0.53)); ctx.lineTo(gx - S * 0.06, Y(0.53)); ctx.fill(); ctx.restore();
    }
    // Рука: «подожди» — указательный палец; щелчок — машет.
    const wag = t - s.wag < 0.9 ? Math.sin((t - s.wag) * 18) * 0.25 * (1 - (t - s.wag) / 0.9) : 0;
    ctx.save(); ctx.translate(X(0.22), Y(0.78)); ctx.rotate(wag - 0.1);
    ctx.fillStyle = "#fff"; ctx.strokeStyle = K; ctx.lineWidth = lw * 1.3;
    ctx.beginPath(); ctx.roundRect(-S * 0.05, -S * 0.2, S * 0.045, S * 0.16, S * 0.02); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(-S * 0.065, -S * 0.07, S * 0.13, S * 0.1, S * 0.035); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-S * 0.03, S * 0.03); ctx.lineTo(-S * 0.05, S * 0.25); ctx.moveTo(S * 0.05, S * 0.03); ctx.lineTo(S * 0.06, S * 0.25); ctx.stroke();
    ctx.restore();
    // Ноты из наушника.
    if (s.r() < 0.03 && s.notes.length < 6) s.notes.push({ x: X(0.72), y: Y(0.44), t, life: 2.6, ph: s.r() * TAU });
    s.notes = particles(s.notes, t, (q: any, a) => { ctx.globalAlpha = a; sprite(ctx, NOTE, q.x + (1 - a) * S * 0.3 + Math.sin(t * 3 + q.ph) * 4, q.y - (1 - a) * S * 0.35, Math.max(1.5, B * 0.5), K); });
    ctx.globalAlpha = 1;
    if (!s.small) { const tw = bits("L8R")[0].length * B; bigPix(ctx, "L8R", z.x + (z.w - tw) / 2, sy + S + B * 2, B, t, jmp); }
  },
  fx(ctx, s, e) {
    if (s.small) return;
    ctx.fillStyle = "#0a0a0a";
    for (let i = 0; i < e.trail.length; i += 3) { const [x, y, a] = e.trail[i], k = 1 - a / 1.2; if (k <= 0) continue; ctx.globalAlpha = k * 0.5; const q = Math.max(1, Math.round(5 * k)); ctx.fillRect(Math.round(x / 5) * 5, Math.round(y / 5) * 5, q, q); }
    s.pops = particles(s.pops, e.t, (q: any, a) => { ctx.globalAlpha = a; bigPix(ctx, "...", q.x + 10, q.y - 30 - (1 - a) * 10, 3, e.t, 0); });
    ctx.globalAlpha = 1;
  },
};

// ─── Hello world: привет на всех языках ───────────────────────────

const HW: [string, string, string][] = [
  ["public class Main {", "#60a5fa", "java"], ["  System.out.println(\"hello world\");", "#e5e7eb", "java"], ["}", "#60a5fa", "java"],
  ["<?php echo 'hello world' ?>", "#818cf8", "php"], ["fmt.Println(\"hello world\")", "#f5f5f5", "go"],
  ["console.log('hello world');", "#facc15", "js"], ["#include <stdio.h>", "#4ade80", "c"], ["puts(\"hello world\");", "#4ade80", "c"],
  ["SELECT 'hello world';", "#f5f5f5", "sql"], ["echo hello world", "#fb923c", "sh"], ["10 PRINT \"HELLO WORLD\"", "#4ade80", "basic"],
  ["(display \"hello world\")", "#e5e7eb", "scheme"], ["mov ah, 09h", "#9ca3af", "asm"], ["int 21h", "#9ca3af", "asm"],
  ["std::cout << \"hello world\";", "#facc15", "c++"], ["println!(\"hello world\");", "#fb923c", "rust"],
  ["Console.WriteLine(\"hello world\");", "#c084fc", "c#"], ["HAI", "#2dd4bf", "lol"], ["VISIBLE \"HAI WORLD!\"", "#2dd4bf", "lol"], ["KTHXBYE", "#2dd4bf", "lol"],
  ["DISPLAY 'hello world'.", "#60a5fa", "cobol"], ["print(\"hello world\")", "#f87171", "python"], ["++++++++[>++++<-]>.", "#fde047", "bf"], ["say 'hello world'", "#f472b6", "raku"],
  ["puts 'hello world'", "#d4d4d8", "ruby"], ["main = putStrLn \"hello world\"", "#a78bfa", "haskell"],
];
const HUMAN = ["Привет, мир", "Hola, mundo", "Bonjour le monde", "Hallo Welt", "こんにちは世界", "你好，世界", "안녕, 세상", "Ciao mondo", "Olá, mundo", "Merhaba dünya", "Witaj, świecie", "Hej världen"];
const BIN = [..."hello world "].map((c) => c.charCodeAt(0).toString(2).padStart(8, "0")).join(" ") + " ";

const hello: Scene = {
  fps: 20, scale: 1, protect: 0.15,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 150, h > 80 ? 70 : 30) : sideZone({ w, h });
    const r = rng(389);
    // Раскладка: короткие строки встают рядом, длинные — с новой строки; «print» — крупно посередине.
    const m = document.createElement("canvas").getContext("2d")!;
    m.font = "10.5px Consolas, monospace";
    const items: any[] = [], lh = 13.5;
    let x = 0, y = 18, off = 0;
    HW.forEach((it, i) => {
      if (i === 11) { y += lh + 8; items.push({ big: true, txt: "print \"hello world\";", col: "#22c55e", x: 0, y, off, lang: "print" }); off += 21; y += 34; x = 0; }
      const tw = m.measureText(it[0]).width;
      if (x > 0 && x + tw > z.w) { x = 0; y += lh; }
      items.push({ txt: it[0], col: it[1], lang: it[2], x, y, tw, off });
      off += it[0].length; x += tw + 12;
      if (x > z.w * 0.6) { x = 0; y += lh; }
    });
    const qr = Array.from({ length: 21 }, (_, j) => Array.from({ length: 21 }, (_, i) => {
      const fin = (a: number, b: number) => i >= a && i < a + 7 && j >= b && j < b + 7 && (i === a || i === a + 6 || j === b || j === b + 6 || (i > a + 1 && i < a + 5 && j > b + 1 && j < b + 5));
      const inF = (a: number, b: number) => i >= a - 1 && i < a + 8 && j >= b - 1 && j < b + 8;
      return inF(0, 0) || inF(14, 0) || inF(0, 14) ? fin(0, 0) || fin(14, 0) || fin(0, 14) : r() < 0.5;
    }));
    const pal = Array.from({ length: 64 }, () => ["#ef4444", "#22c55e", "#3b82f6", "#facc15", "#e879f9", "#f5f5f5", "#0ea5e9", "#000"][(r() * 8) | 0]);
    return { z, small, r, items, end: y + lh, total: off, reveal: 0, redo: -1, redoAt: 0, redoN: 0, qr, pal, out: [] as any[], log: [] as string[], drift: HUMAN.map((txt, i) => ({ txt, x: r() * w, y: 60 + (i / HUMAN.length) * (h - 120), v: 6 + r() * 10 })), parts: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt, w } = e, z = s.z;
    ctx.textBaseline = "top";
    if (s.small) {
      ctx.font = "9px Consolas, monospace"; ctx.fillStyle = "rgba(34,197,94,.55)";
      const sh = Math.floor(t * 8) % BIN.length; ctx.fillText((BIN + BIN).slice(sh, sh + 30), z.x, z.y);
      ctx.font = `700 ${Math.min(14, z.h * 0.35, z.w / 11.5)}px Consolas, monospace`; ctx.fillStyle = "#22c55e"; ctx.fillText("print \"hello world\";", z.x, z.y + 13);
      return;
    }
    // Приветы людей плывут по окну.
    ctx.font = "600 15px \"Segoe UI\", \"Yu Gothic UI\", sans-serif";
    for (const q of s.drift) { q.x -= q.v * dt; if (q.x < -200) q.x = w + 20; ctx.fillStyle = "rgba(245,245,245,.09)"; ctx.fillText(q.txt, q.x, q.y); }
    // Двоичная строка сверху бежит.
    ctx.save(); ctx.beginPath(); ctx.rect(z.x, z.y, z.w, z.h); ctx.clip();
    ctx.font = "9.5px Consolas, monospace"; ctx.fillStyle = "#22c55e";
    const sh = Math.floor(t * 10) % BIN.length; ctx.fillText((BIN + BIN + BIN).slice(sh, sh + 60), z.x, z.y + 2);
    s.reveal += 110 * dt;
    if (s.reveal > s.total + 40 && t > s.redoAt) { s.redo = (s.r() * s.items.length) | 0; s.redoN = 0; s.redoAt = t + 4 + s.r() * 3; }
    s.redoN += 40 * dt;
    let hover: any = null;
    const clk = newClick(s, e) ? e.click! : null;
    s.items.forEach((it: any, i: number) => {
      const shown = i === s.redo ? Math.floor(s.redoN) : Math.floor(s.reveal - it.off);
      if (shown <= 0) return;
      const txt = it.txt.slice(0, shown), x = z.x + it.x, y = z.y + it.y;
      ctx.font = it.big ? "700 21px Consolas, monospace" : "10.5px Consolas, monospace";
      const tw = it.big ? ctx.measureText(it.txt).width : it.tw, hh = it.big ? 24 : 13;
      const over = e.mouse && e.mx > x - 3 && e.mx < x + tw + 3 && e.my > y - 2 && e.my < y + hh;
      if (over) { hover = it; ctx.fillStyle = "rgba(255,255,255,.08)"; ctx.fillRect(x - 3, y - 2, tw + 6, hh + 2); }
      ctx.fillStyle = it.col; ctx.fillText(txt, x, y);
      if (shown < it.txt.length && Math.floor(t * 4) % 2) ctx.fillRect(x + ctx.measureText(txt).width + 1, y, 6, hh - 2);
      if (clk && clk.x > x - 3 && clk.x < x + tw + 3 && clk.y > y - 2 && clk.y < y + hh) {
        s.out.push({ x: x + tw, y, col: it.col, t, life: 2.2 });
        s.log.push(`$ ${it.lang} → hello world`); if (s.log.length > 3) s.log.shift();
      }
    });
    if (hover) { ctx.fillStyle = hover.col; ctx.font = "10px Consolas, monospace"; ctx.fillText("▶", z.x + hover.x - 12, z.y + hover.y + (hover.big ? 6 : 1)); }
    // QR и цветной квадрат внизу, под ними — консоль.
    const by = z.y + s.end + 10, M = 3;
    ctx.fillStyle = "#f5f5f5"; ctx.fillRect(z.x, by, 21 * M + 6, 21 * M + 6);
    ctx.fillStyle = "#000"; s.qr.forEach((row: boolean[], j: number) => row.forEach((v, i) => { if (v) ctx.fillRect(z.x + 3 + i * M, by + 3 + j * M, M, M); }));
    const px = z.x + 21 * M + 18;
    s.pal.forEach((c: string, i: number) => { const flick = hash2(i, Math.floor(t * 2)) < 0.06; ctx.fillStyle = flick ? "#fff" : c; ctx.fillRect(px + (i % 8) * 6, by + Math.floor(i / 8) * 6, 6, 6); });
    ctx.font = "10px Consolas, monospace"; ctx.fillStyle = "rgba(245,245,245,.55)";
    s.log.forEach((l: string, i: number) => ctx.fillText(l, px + 56, by + 4 + i * 14));
    if (!s.log.length) ctx.fillText("щёлкни строку — запусти", px + 56, by + 4);
    ctx.restore();
    s.out = particles(s.out, t, (q: any, a) => { ctx.globalAlpha = a; ctx.fillStyle = q.col; ctx.font = "700 13px Consolas, monospace"; ctx.fillText("> hello world", q.x + 8 + (1 - a) * 60, q.y - (1 - a) * 18); });
    ctx.globalAlpha = 1;
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t } = e, cols = ["#22c55e", "#60a5fa", "#facc15", "#f472b6", "#fb923c", "#c084fc"];
    ctx.font = "700 12px Consolas, monospace"; ctx.textBaseline = "middle";
    const msg = "hello world ";
    for (let i = 0; i < e.trail.length; i += 3) { const [x, y, a] = e.trail[i], k = 1 - a / 1.2; if (k <= 0) continue; const j = (i / 3) | 0; ctx.fillStyle = cols[j % cols.length]; ctx.globalAlpha = k * 0.8; ctx.fillText(msg[j % msg.length], x, y); }
    if (newClick(s, e, "_fx")) for (let i = 0; i < 12; i++) s.parts.push({ x: e.click!.x, y: e.click!.y, a: (i / 12) * TAU, c: cols[i % cols.length], ch: "{}()<>;"[i % 7], t, life: 0.8 });
    s.parts = particles(s.parts, t, (q: any, a) => { const d = (1 - a) * 70; ctx.globalAlpha = a; ctx.fillStyle = q.c; ctx.fillText(q.ch, q.x + Math.cos(q.a) * d, q.y + Math.sin(q.a) * d); });
    ctx.globalAlpha = 1;
  },
};

export const MEMES = { offline, deadline, cad, alive, nope, hello };
