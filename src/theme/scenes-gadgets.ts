// Гаджеты: Питомец (LCD), Виджеты (светлые), Сфера (стена обложек под
// «рыбьим глазом») и Паутина (паучки ловят пакеты трафика).

import { TAU, clamp, rng, hash2, rgba, newClick, sideZone, pixText, sig, health, look, sprite, particles, notchBox, type Scene } from "./scenekit";


// ─── Питомец: LCD-питомец, его сытость — это связь ────────────────

const GHOST = [
  "......XXXXXX......",
  "....XXooooooXX....",
  "...XoooooooooooX..",
  "..Xoo........ooX..",
  "..Xo..........oX..",
  ".Xo............oX.",
  ".Xo............oX.",
  ".Xo............oX.",
  ".Xo............oX.",
  "XXXX..........XXXX",
  "Xooo..........oooX",
  "XXXX..........XXXX",
  "...X..........X...",
  "...X..........X...",
  "...Xo........oX...",
];
const SKIRT = [["..XX.X..XX..X.XX..", "..X.XoX.XX.XoX.X..", "...X...X..X...X..."], [".XX..X.XX.X..XX.X.", ".X.XoX.X..X.XoX.X.", "..X...X....X...X.."]];
const FOOD: string[][] = [
  ["...X....", "..XX.X..", ".XXXXXX.", "XXoXXXXX", "XXXXXXXX", "XXXXXXXX", ".XXXXXX.", "..X..X.."],
  ["..XXXX..", ".XooooX.", "XooooooX", "XooooooX", ".XooooX.", ".XooooX.", ".XooooX.", ".XXXXXX."],
  ["..XXXX..", ".XooooX.", "XXXXXXXX", "XoXoXoXX", "XXXXXXXX", "XooooooX", ".XXXXXX.", "........"],
  ["........", "...XXX..", "..XoooX.", ".XXXXXXX", ".XoooooX", ".XXXXXXX", ".XoooooX", ".XXXXXXX"],
  ["...XX...", "..XooX..", ".XooooX.", ".XXXXXX.", "..XXXX..", "..XXXX..", "...XX...", "...XX..."],
  ["....XXX.", "...XoooX", "..XooooX", ".XooooX.", "XXoooX..", "XX.XX...", ".X......", "X.X....."],
];
const HEART = [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."];
const FACE: Record<string, string[]> = {
  ok: ["XX....XX", "XX....XX", "........", "...XX..."],
  joy: [".X....X.", "X.X..X.X", "........", "..XXXX.."],
  slow: ["........", "XX....XX", "........", "..XXXX.."],
  down: ["X.X..X.X", ".X....X.", "X.X..X.X", "..XXXX.."],
  sleep: ["........", "XX....XX", "........", "...XX..."],
  eat: ["XX....XX", "XX....XX", "...XX...", "..X..X.."],
};

const pet: Scene = {
  fps: 12, scale: 1, protect: 0.08,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 80, 80) : sideZone({ w, h });
    return { z, small, r: rng(503), x: 0.5, tx: 0.5, hop: -9, eat: -9, food: [] as any[], hearts: [] as any[], t0: -1, joy: -9 };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, z = s.z, INK = "#2e3529", MID = "#6f7a66", PALE = "#bcc6af";
    if (s.t0 < 0) s.t0 = t;
    const hl = health(), mood = hl === "down" ? "down" : hl === "engine_off" || hl === "starting" ? "sleep" : hl === "slow" ? "slow" : "ok";
    const link = mood === "ok" ? 1 : mood === "slow" ? 0.5 : mood === "down" ? 0.08 : 0.3;
    const ping = sig.ms == null ? 0.4 : clamp(1 - sig.ms / 900, 0.05, 1);
    const stats: [string, number][] = [["PING", ping], ["SPEED", sig.load], ["LINK", link], ["UPTIME", clamp((t - s.t0) / 600, 0.05, 1)], ["FOOD", clamp(1 - (t - s.eat) / 90, 0.05, 1)], ["HAPPY", clamp((ping + link + sig.load * 0.5) / 2.3 + (t - s.joy < 8 ? 0.3 : 0), 0.05, 1)]];
    const P = s.small ? 2 : clamp(Math.floor(z.w / 64), 3, 5);
    // Экран с сеткой.
    const scrW = s.small ? z.w : z.w, scrH = s.small ? z.h : Math.min(z.h * 0.52, z.w * 1.05);
    const sx = z.x, sy = s.small ? z.y : z.y + 76;
    ctx.fillStyle = "#b2bca6"; ctx.strokeStyle = "#8f9a83"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(sx, sy, scrW, scrH, 14); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.roundRect(sx + 6, sy + 6, scrW - 12, scrH - 12, 10); ctx.clip();
    ctx.strokeStyle = "rgba(120,132,108,.25)"; ctx.lineWidth = 1;
    ctx.beginPath(); for (let x = sx + 6; x < sx + scrW; x += 6) { ctx.moveTo(x, sy); ctx.lineTo(x, sy + scrH); } for (let y = sy + 6; y < sy + scrH; y += 6) { ctx.moveTo(sx, y); ctx.lineTo(sx + scrW, y); } ctx.stroke();
    // Питомец бродит, смотрит на курсор, прыгает, ест.
    if (Math.abs(s.x - s.tx) < 0.01 && s.r() < 0.02) s.tx = 0.25 + s.r() * 0.5;
    s.x += clamp(s.tx - s.x, -0.08 * dt, 0.08 * dt);
    const GW = 18 * P, gx = sx + (scrW - GW) * s.x, base = sy + scrH * 0.62 - 9 * P;
    const near = e.mouse && Math.abs(e.mx - (gx + GW / 2)) < GW && Math.abs(e.my - (base + 8 * P)) < GW;
    if (near && t - s.hop > 1) s.hop = t;
    const hu = t - s.hop < 0.5 ? Math.sin(((t - s.hop) / 0.5) * Math.PI) : 0;
    const frame = Math.floor(t * 2) % 2, gy = base - frame * P - hu * P * 5 - (mood === "ok" && Math.floor(t / 4) % 3 === 0 ? Math.abs(Math.sin(t * 6)) * P * 2 : 0);
    sprite(ctx, GHOST, gx, gy, P, INK, MID);
    sprite(ctx, SKIRT[frame], gx, gy + 15 * P, P, INK, MID);
    const eating = t - s.eat < 1.6 && t - s.eat > 0;
    const face = FACE[eating ? (Math.floor(t * 6) % 2 ? "eat" : "ok") : t - s.joy < 1.5 || hu > 0 ? "joy" : mood];
    const [lx] = look(e, gx + GW / 2, gy + 6 * P, 200);
    sprite(ctx, face, gx + 5 * P + Math.round(lx) * P, gy + 6 * P, P, INK);
    if (mood === "sleep") pixText(ctx, Math.floor(t * 1.5) % 2 ? "z" : "Z", gx + GW, gy - P * 2 - (t % 2) * P * 3, 8, INK, P / 2.5);
    // Еда падает сверху экрана.
    s.food = s.food.filter((f: any) => {
      f.y += 120 * dt;
      const fy = sy + 10 + f.y, ty = gy + 6 * P;
      if (fy >= ty) { s.eat = t; s.joy = t; s.hearts.push({ x: gx + GW / 2, y: gy, t, life: 1.2 }); return false; }
      sprite(ctx, FOOD[f.k], gx + GW / 2 - 4 * P * 0.7, fy, P * 0.7, INK, MID);
      return true;
    });
    s.hearts = particles(s.hearts, t, (q: any, a) => { if (Math.floor(a * 8) % 2) sprite(ctx, HEART, q.x - 3 * P * 0.6 + (1 - a) * 10, q.y - (1 - a) * P * 8, P * 0.6, INK); });
    ctx.restore();
    const clk = newClick(s, e) ? e.click! : null;
    if (clk && clk.x > sx && clk.x < sx + scrW && clk.y > sy && clk.y < sy + scrH) s.food.push({ y: 0, k: (s.r() * FOOD.length) | 0 });
    if (s.small) return;
    // Шкалы сверху: подпись пиксельным шрифтом и полоска.
    const colW = (z.w - 8) / 3;
    stats.forEach(([n, v], i) => {
      const x = z.x + (i % 3) * colW, y = z.y + Math.floor(i / 3) * 32;
      pixText(ctx, n, x, y, 8, INK, 1.25);
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(x, y + 14, colW - 10, 9, 4.5); ctx.stroke();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(x + 2, y + 16, Math.max(5, (colW - 14) * v), 5, 2.5); ctx.fill();
    });
    // Монетки = мегабайты за сеанс.
    const mb = Math.floor(sig.bytes / 1e6);
    pixText(ctx, String(mb), z.x + z.w - 80, sy - 14, 8, INK, 2);
    for (let i = 0; i < 3; i++) { ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(z.x + z.w - 12, sy - 4 - i * 4, 8, 3, 0, 0, TAU); ctx.fillStyle = PALE; ctx.fill(); ctx.stroke(); }
    // Имя и лоток с едой: щелчок по еде — кормить.
    const ny = sy + scrH + 10;
    ctx.font = "bold 8px Consolas, monospace";
    const nm = "Bitty", nw = (Math.ceil(ctx.measureText(nm).width) + 2) * 3.2;
    pixText(ctx, nm, z.x + (z.w - nw) / 2, ny, 8, INK, 3.2);
    const ty = ny + 44, tw = z.w, cell = tw / 6;
    ctx.strokeStyle = "#8f9a83"; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(z.x, ty, tw, cell * 0.8, 12); ctx.stroke();
    FOOD.forEach((f, i) => {
      const fx = z.x + i * cell + cell / 2 - 4 * P * 0.8, fy = ty + cell * 0.4 - 4 * P * 0.8;
      const over = e.mouse && Math.abs(e.mx - (fx + 4 * P * 0.8)) < cell / 2 && Math.abs(e.my - (fy + 4 * P * 0.8)) < cell * 0.4;
      sprite(ctx, f, fx, fy - (over ? 3 : 0), P * 0.8, INK, MID);
      if (clk && Math.abs(clk.x - (fx + 4 * P * 0.8)) < cell / 2 && Math.abs(clk.y - (fy + 4 * P * 0.8)) < cell * 0.4) s.food.push({ y: 0, k: i });
    });
  },
  fx(ctx, s, e) {
    if (s.small) return;
    ctx.fillStyle = "#2e3529";
    for (let i = 0; i < e.trail.length; i += 3) { const [x, y, a] = e.trail[i], k = 1 - a / 1.2; if (k <= 0) continue; ctx.globalAlpha = k * 0.5; ctx.fillRect(Math.round(x / 6) * 6, Math.round(y / 6) * 6, 5, 5); }
    ctx.globalAlpha = 1;
  },
};

// ─── Виджеты: часы, календарь, шкалы месяца и года, листья ─────────

const SEG: Record<string, number[]> = { "0": [1, 1, 1, 1, 1, 1, 0], "1": [0, 1, 1, 0, 0, 0, 0], "2": [1, 1, 0, 1, 1, 0, 1], "3": [1, 1, 1, 1, 0, 0, 1], "4": [0, 1, 1, 0, 0, 1, 1], "5": [1, 0, 1, 1, 0, 1, 1], "6": [1, 0, 1, 1, 1, 1, 1], "7": [1, 1, 1, 0, 0, 0, 0], "8": [1, 1, 1, 1, 1, 1, 1], "9": [1, 1, 1, 1, 0, 1, 1] };
/** Цифры семисегментником (часы, дата). */
function seg7(ctx: CanvasRenderingContext2D, txt: string, x: number, y: number, w: number, h: number, col: string) {
  const th = Math.max(2, w * 0.18);
  ctx.fillStyle = col;
  for (const ch of txt) {
    if (ch === ":") { ctx.fillRect(x + w * 0.15, y + h * 0.28, th, th); ctx.fillRect(x + w * 0.15, y + h * 0.66, th, th); x += w * 0.5; continue; }
    const on = SEG[ch];
    if (on) {
      const H = (yy: number) => { ctx.beginPath(); ctx.moveTo(x + th * 0.6, yy); ctx.lineTo(x + w - th * 0.6, yy); ctx.lineTo(x + w - th * 1.1, yy + th * 0.5); ctx.lineTo(x + w - th * 0.6, yy + th); ctx.lineTo(x + th * 0.6, yy + th); ctx.lineTo(x + th * 1.1, yy + th * 0.5); ctx.closePath(); ctx.fill(); };
      const V = (xx: number, yy: number) => ctx.fillRect(xx, yy + th * 0.7, th, h / 2 - th * 1.2);
      if (on[0]) ctx.fillRect(x + th * 0.6, y, w - th * 1.2, th);
      if (on[1]) V(x + w - th, y);
      if (on[2]) V(x + w - th, y + h / 2 - th * 0.2);
      if (on[3]) ctx.fillRect(x + th * 0.6, y + h - th, w - th * 1.2, th);
      if (on[4]) V(x, y + h / 2 - th * 0.2);
      if (on[5]) V(x, y);
      if (on[6]) H(y + h / 2 - th / 2);
    }
    x += w + th * 1.2;
  }
}
function widgetBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, dark: boolean, lift: number) {
  ctx.fillStyle = "rgba(43,48,45,.35)"; ctx.beginPath(); ctx.roundRect(x + 3 - lift, y + 4 - lift, w, h, 16); ctx.fill();
  ctx.fillStyle = dark ? "#2b302d" : "#f3f3f0"; ctx.strokeStyle = "#2b302d"; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.roundRect(x - lift, y - lift * 1.5, w, h, 16); ctx.fill(); ctx.stroke();
}
function ship(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, col: string) {
  ctx.strokeStyle = col; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(x - 18 * k, y); ctx.lineTo(x + 18 * k, y); ctx.lineTo(x + 12 * k, y + 8 * k); ctx.lineTo(x - 14 * k, y + 8 * k); ctx.closePath();
  ctx.moveTo(x, y); ctx.lineTo(x, y - 26 * k); ctx.moveTo(x, y - 24 * k); ctx.quadraticCurveTo(x + 14 * k, y - 16 * k, x + 2 * k, y - 4 * k);
  ctx.moveTo(x - 2 * k, y - 20 * k); ctx.lineTo(x - 13 * k, y - 4 * k); ctx.lineTo(x - 2 * k, y - 4 * k);
  for (let i = 0; i < 3; i++) { ctx.moveTo(x - 24 * k, y + (12 + i * 5) * k); ctx.quadraticCurveTo(x - 12 * k, y + (9 + i * 5) * k, x, y + (12 + i * 5) * k); ctx.quadraticCurveTo(x + 12 * k, y + (15 + i * 5) * k, x + 24 * k, y + (12 + i * 5) * k); }
  ctx.stroke();
}
function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, a: number, col: string) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(-s, 0); ctx.quadraticCurveTo(0, -s * 0.6, s, 0); ctx.quadraticCurveTo(0, s * 0.6, -s, 0); ctx.fill();
  ctx.strokeStyle = "rgba(240,240,236,.5)"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(-s * 0.8, 0); ctx.lineTo(s * 0.8, 0); ctx.stroke();
  ctx.restore();
}
/** Странник в шляпе и плаще (ноги на x, y). */
function wanderer(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, t: number) {
  const INK = "#2b302d", fl = Math.sin(t * 1.8) * 6 * k;
  ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
  ctx.fillStyle = "#f3f3f0";
  ctx.beginPath(); ctx.moveTo(x - 10 * k, y - 86 * k); ctx.quadraticCurveTo(x + 40 * k + fl, y - 70 * k, x + 58 * k + fl, y - 28 * k); ctx.quadraticCurveTo(x + 40 * k, y - 34 * k + fl * 0.3, x + 30 * k, y - 18 * k); ctx.quadraticCurveTo(x + 10 * k, y - 40 * k, x - 4 * k, y - 50 * k); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath(); ctx.moveTo(x - 14 * k, y - 84 * k); ctx.lineTo(x + 12 * k, y - 84 * k); ctx.lineTo(x + 10 * k, y - 34 * k); ctx.lineTo(x - 12 * k, y - 34 * k); ctx.closePath(); ctx.fill();
  ctx.fillRect(x - 10 * k, y - 34 * k, 7 * k, 34 * k); ctx.fillRect(x + 2 * k, y - 34 * k, 7 * k, 32 * k);
  ctx.fillRect(x - 12 * k, y - 4 * k, 10 * k, 4 * k); ctx.fillRect(x + 1 * k, y - 4 * k, 11 * k, 4 * k);
  ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 20 * k, y - 20 * k); ctx.lineTo(x + 6 * k, y - 50 * k); ctx.stroke();
  ctx.fillStyle = "#f3f3f0"; ctx.beginPath(); ctx.arc(x, y - 92 * k, 9 * k, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(x, y - 98 * k, 26 * k, 6 * k, -0.08, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x, y - 104 * k, 12 * k, 8 * k, 0, Math.PI, 0); ctx.fill();
  ctx.fillStyle = "#e8b878"; ctx.beginPath(); ctx.ellipse(x + 2 * k, y - 112 * k, 6 * k, 4 * k, 0, 0, TAU); ctx.fill(); ctx.stroke();
}

const widgets: Scene = {
  fps: 20, scale: 1, protect: 0.1,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 120, h > 80 ? 46 : 30) : sideZone({ w, h });
    const r = rng(521);
    return { z, small, r, leaves: Array.from({ length: small ? 0 : 16 }, () => ({ x: r() * w, y: r() * h, vx: 0, vy: 0, a: r() * TAU, s: 5 + r() * 6, dark: r() < 0.6 })), press: -9, pi: -1, wind: false, burst: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e, z = s.z, INK = "#2b302d", PAPER = "#f3f3f0";
    const now = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    if (s.small) { seg7(ctx, `${pad(now.getHours())}:${pad(now.getMinutes())}`, z.x, z.y + 4, z.h * 0.32, z.h * 0.6, INK); return; }
    // Листья по всему окну: ветер от курсора.
    for (const q of s.leaves) {
      q.vy += (18 - q.vy) * dt * 0.5; q.vx += ((s.wind ? 40 : 8) + Math.sin(t + q.a) * 10 - q.vx) * dt * 0.5;
      if (e.mouse) { const dx = q.x - e.mx, dy = q.y - e.my, d = Math.hypot(dx, dy); if (d < 90 && d > 1) { q.vx += (dx / d) * 300 * dt; q.vy += (dy / d) * 300 * dt; } }
      q.x += q.vx * dt; q.y += q.vy * dt; q.a += (q.vx * 0.01 + 0.5) * dt;
      if (q.y > h + 20 || q.x > w + 30) { q.y = -10; q.x = s.r() * w * 0.8; q.vx = 0; q.vy = 0; }
      leaf(ctx, q.x, q.y, q.s, q.a, q.dark ? "#4a504b" : "#9aa09b");
    }
    const clk = newClick(s, e) ? e.click! : null;
    const tiles: { x: number; y: number; w: number; h: number; id: number }[] = [];
    let y = z.y + 2;
    const W = z.w - 6;
    const tileAt = (x: number, yy: number, ww: number, hh: number, id: number, dark: boolean) => {
      const over = e.mouse && e.mx > x && e.mx < x + ww && e.my > yy && e.my < yy + hh;
      const pressed = s.pi === id && t - s.press < 0.2;
      if (clk && clk.x > x && clk.x < x + ww && clk.y > yy && clk.y < yy + hh) { s.pi = id; s.press = t; if (id === 3) s.wind = !s.wind; }
      const lift = pressed ? -2 : over ? 2 : 0;
      widgetBox(ctx, x, yy, ww, hh, dark, lift);
      tiles.push({ x, y: yy, w: ww, h: hh, id });
      return lift;
    };
    // Календарь со статусом связи.
    const l0 = tileAt(z.x, y, W, 96, 0, false), ox = z.x - l0, oy = y - l0 * 1.5;
    ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(ox + 10, oy + 8, W - 20, 16, 8); ctx.fill();
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    ctx.font = "600 8.5px 'Segoe UI', sans-serif"; ctx.textBaseline = "middle";
    days.forEach((d, i) => { ctx.fillStyle = i === now.getDay() ? "#f3f3f0" : "rgba(243,243,240,.55)"; ctx.fillText(d, ox + 16 + i * ((W - 32) / 7), oy + 16.5); });
    ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(ox + 10, oy + 30, 44, 42, 9); ctx.fill();
    seg7(ctx, pad(now.getDate()), ox + 15, oy + 37, 13, 28, PAPER);
    ctx.fillStyle = INK; ctx.textBaseline = "top"; ctx.font = "500 11px 'Segoe UI', sans-serif";
    ctx.fillText(`${pad(now.getMonth() + 1)}/${pad(now.getDate())}  ${now.toLocaleDateString("en-US", { weekday: "long" })}`, ox + 62, oy + 31);
    const hl = health();
    ctx.font = "800 22px 'Segoe UI', sans-serif";
    ctx.fillText(hl === "down" || hl === "engine_off" ? "OFFLINE" : hl === "slow" ? "SLOW" : "ONLINE", ox + 62, oy + 46);
    ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(ox + 10, oy + 76, W - 20, 14, 7); ctx.fill();
    ctx.font = "600 9px 'Segoe UI', sans-serif"; ctx.textBaseline = "middle";
    for (let i = -3; i <= 3; i++) { const d = new Date(now.getTime() + i * 864e5); ctx.fillStyle = i ? "rgba(243,243,240,.6)" : PAPER; ctx.fillText(pad(d.getDate()), ox + 18 + (i + 3) * ((W - 36) / 7), oy + 83); }
    y += 106;
    // Часы и кнопка «▷» (ветер).
    const cwid = W - 70, l1 = tileAt(z.x, y, cwid, 58, 1, false);
    seg7(ctx, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, z.x + 12 - l1, y + 12 - l1 * 1.5, 18, 34, INK);
    ctx.fillStyle = INK; ctx.font = "600 9px 'Segoe UI', sans-serif"; ctx.textBaseline = "top"; ctx.fillText("TIME", z.x + cwid - 36 - l1, y + 8 - l1 * 1.5);
    const l3 = tileAt(z.x + cwid + 10, y, 60, 58, 3, s.wind);
    ctx.strokeStyle = s.wind ? PAPER : INK; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(z.x + cwid + 32 - l3, y + 16 - l3 * 1.5); ctx.lineTo(z.x + cwid + 46 - l3, y + 29 - l3 * 1.5); ctx.lineTo(z.x + cwid + 32 - l3, y + 42 - l3 * 1.5); ctx.stroke();
    y += 68;
    // Ночь: пинг; день: трафик; эквалайзер; «шаги» — мегабайты.
    const tw = (W - 30) / 4;
    const l4 = tileAt(z.x, y, tw, 110, 4, true);
    ctx.fillStyle = PAPER; ctx.font = "400 10px 'Segoe Print', 'Segoe UI', sans-serif"; ctx.fillText("Ping", z.x + 8 - l4, y + 8 - l4 * 1.5);
    ctx.fillText(`${sig.ms ?? "—"}ms`, z.x + 8 - l4, y + 20 - l4 * 1.5);
    ctx.fillStyle = "#e5e5e0"; ctx.beginPath(); ctx.arc(z.x + tw - 12 - l4, y + 16 - l4 * 1.5, 8, 0, TAU); ctx.fill();
    for (let i = 0; i < 5; i++) { ctx.fillRect(z.x + 6 + hash2(i, 4) * (tw - 12) - l4, y + 36 + hash2(i, 5) * 20 - l4 * 1.5, 1.5, 1.5); }
    ship(ctx, z.x + tw / 2 - l4, y + 78 - l4 * 1.5 + Math.sin(t * 1.5) * 1.5, tw / 70, PAPER);
    const l5 = tileAt(z.x + tw + 10, y, tw, 110, 5, false);
    ctx.fillStyle = INK; ctx.fillText("Today", z.x + tw + 18 - l5, y + 8 - l5 * 1.5); ctx.fillText(`${(sig.bytes / 1e9).toFixed(2)}GB`, z.x + tw + 18 - l5, y + 20 - l5 * 1.5);
    ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(z.x + 2 * tw - 4 - l5, y + 18 - l5 * 1.5, 7, 0, TAU); ctx.stroke();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + t * 0.3; ctx.beginPath(); ctx.moveTo(z.x + 2 * tw - 4 - l5 + Math.cos(a) * 9, y + 18 - l5 * 1.5 + Math.sin(a) * 9); ctx.lineTo(z.x + 2 * tw - 4 - l5 + Math.cos(a) * 12, y + 18 - l5 * 1.5 + Math.sin(a) * 12); ctx.stroke(); }
    ship(ctx, z.x + tw * 1.5 + 10 - l5, y + 78 - l5 * 1.5 + Math.sin(t * 1.5 + 1) * 1.5, tw / 70, INK);
    const ex = z.x + 2 * tw + 20, l6 = tileAt(ex, y, tw * 2 + 10, 50, 6, false);
    for (let i = 0; i < 3; i++) {
      const hgt = 14 + 18 * Math.abs(Math.sin(t * (2 + i) + i)) * (0.3 + sig.load);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.4; ctx.fillStyle = i === 1 ? INK : PAPER;
      ctx.beginPath(); ctx.roundRect(ex + 24 + i * 22 - l6, y + 42 - hgt - l6 * 1.5, 16, hgt, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = i === 1 ? PAPER : INK; ctx.beginPath(); ctx.arc(ex + 32 + i * 22 - l6, y + 42 - hgt * 0.4 - l6 * 1.5, 3, 0, TAU); ctx.fill();
    }
    const l7 = tileAt(ex, y + 60, tw * 2 + 10, 50, 7, true);
    ctx.fillStyle = PAPER; ctx.font = "500 9.5px 'Segoe UI', sans-serif"; ctx.fillText("Today MB ↓", ex + tw - l7, y + 66 - l7 * 1.5);
    ctx.font = "700 18px 'Segoe UI', sans-serif"; ctx.fillText(String(Math.floor(sig.bytes / 1e6)), ex + tw - l7, y + 80 - l7 * 1.5);
    ctx.strokeStyle = PAPER; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(ex + 16 - l7, y + 74 - l7 * 1.5); ctx.lineTo(ex + 16 - l7, y + 96 - l7 * 1.5); ctx.moveTo(ex + 9 - l7, y + 89 - l7 * 1.5); ctx.lineTo(ex + 16 - l7, y + 96 - l7 * 1.5); ctx.lineTo(ex + 23 - l7, y + 89 - l7 * 1.5); ctx.stroke();
    y += 120;
    // До пятницы: цифры в тёмных квадратах.
    const l8 = tileAt(z.x, y, W, 50, 8, false);
    const toFri = (5 - now.getDay() + 7) % 7;
    ctx.fillStyle = INK; ctx.font = "500 12px 'Segoe UI', sans-serif"; ctx.textBaseline = "middle";
    ctx.fillText("Left", z.x + 12 - l8, y + 25 - l8 * 1.5); ctx.fillStyle = "#3b5b8a"; ctx.font = "600 14px 'Segoe UI', sans-serif"; ctx.fillText("Friday", z.x + 42 - l8, y + 25 - l8 * 1.5);
    ctx.fillStyle = INK; ctx.font = "500 12px 'Segoe UI', sans-serif"; ctx.fillText("still", z.x + 92 - l8, y + 25 - l8 * 1.5);
    const dd = String(toFri).padStart(3, "0");
    [...dd].forEach((c, i) => { ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(z.x + W - 112 + i * 30 - l8, y + 10 - l8 * 1.5, 26, 30, 7); ctx.fill(); ctx.fillStyle = PAPER; ctx.font = "700 15px 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.fillText(c, z.x + W - 99 + i * 30 - l8, y + 25.5 - l8 * 1.5); ctx.textAlign = "left"; });
    ctx.fillStyle = INK; ctx.font = "500 11px 'Segoe UI', sans-serif"; ctx.fillText("D", z.x + W - 18 - l8, y + 32 - l8 * 1.5);
    y += 62;
    // Шкалы месяца и года.
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), mLeft = dim - now.getDate();
    const yStart = new Date(now.getFullYear(), 0, 1).getTime(), yLen = new Date(now.getFullYear() + 1, 0, 1).getTime() - yStart, yLeft = Math.ceil((yStart + yLen - now.getTime()) / 864e5);
    for (const [frac, label] of [[1 - mLeft / dim, `This month left ${pad(mLeft)} days`], [(now.getTime() - yStart) / yLen, `This year left ${yLeft} days`]] as const) {
      ctx.strokeStyle = INK; ctx.lineWidth = 1.6; ctx.fillStyle = PAPER; ctx.beginPath(); ctx.roundRect(z.x, y, W * 0.72, 16, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(z.x + 2, y + 2, Math.max(12, (W * 0.72 - 4) * frac), 12, 6); ctx.fill();
      ctx.font = "500 12px 'Segoe Print', 'Segoe UI', sans-serif"; ctx.textBaseline = "top"; ctx.fillText(label, z.x + 2, y + 20);
      y += 44;
    }
    // Странник внизу колонки, если есть место.
    const room = z.y + z.h - y;
    if (room > 90) wanderer(ctx, z.x + W * 0.7, z.y + z.h - 4, clamp(room / 130, 0.6, 1.1), t);
    if (clk && !tiles.some((q) => clk.x > q.x && clk.x < q.x + q.w && clk.y > q.y && clk.y < q.y + q.h)) for (let i = 0; i < 10; i++) s.burst.push({ x: clk.x, y: clk.y, vx: (s.r() - 0.5) * 220, vy: -60 - s.r() * 140, a: s.r() * TAU, t, life: 1.6, dark: s.r() < 0.5 });
    void l5; void l6; void l7;
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t, dt } = e;
    s.burst = particles(s.burst, t, (q: any, a) => { q.vy += 160 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.a += 4 * dt; ctx.globalAlpha = a; leaf(ctx, q.x, q.y, 6, q.a, q.dark ? "#4a504b" : "#9aa09b"); });
    // Ветер за курсором: тонкие штрихи.
    const tr = e.trail;
    ctx.strokeStyle = "#2b302d"; ctx.lineWidth = 1; ctx.lineCap = "round";
    for (let i = 8; i < tr.length; i += 10) { const k = 1 - tr[i][2] / 1.2; if (k <= 0) continue; ctx.globalAlpha = k * 0.4; ctx.beginPath(); ctx.moveTo(tr[i - 8][0], tr[i - 8][1] + 6); ctx.quadraticCurveTo(tr[i - 4][0], tr[i - 4][1] - 4, tr[i][0], tr[i][1] + 6); ctx.stroke(); }
    ctx.globalAlpha = 1;
  },
};

// ─── Сфера: стена обложек под «рыбьим глазом» ─────────────────────

const ALB_T = ["夜明け", "ルート", "回線", "Value", "最強", "トンネル", "Blue Hour", "ノイズ", "Signal", "逆さま", "未読", "深海", "Static", "ping", "迷子", "月曜日", "Neon", "雨音", "404", "ハロー", "WANTED", "青", "Echo", "幻"];
const ALB_A = ["wpx", "NEKO", "Ao", "SG-01", "Hy2", "Reality", "Mirai", "Kuro"];
/** Обложка: портрет, крупный шрифт, плакат «WANTED», растр или набросок. */
function albumArt(i: number) {
  const W = 110, H = 150, A = 108, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!, r = rng(700 + i * 31);
  const kind = i % 6, title = ALB_T[i % ALB_T.length];
  const blues = [["#0b2a5b", "#3b82f6"], ["#123d6b", "#7dd3fc"], ["#1e1b4b", "#60a5fa"], ["#0f3b57", "#22d3ee"]][(r() * 4) | 0];
  g.fillStyle = "#16263f"; g.beginPath(); g.roundRect(0, 0, W, H, 8); g.fill();
  g.save(); g.beginPath(); g.roundRect(1, 1, W - 2, A, 7); g.clip();
  if (kind === 0 || kind === 3) {
    const gr = g.createLinearGradient(0, 0, W, A); gr.addColorStop(0, blues[1]); gr.addColorStop(1, blues[0]); g.fillStyle = gr; g.fillRect(0, 0, W, A);
    // Портрет: волосы, лицо, глаза, наушники.
    g.fillStyle = kind ? "#0b1020" : "#1f3b8a"; g.beginPath(); g.ellipse(W * 0.5, A * 0.55, W * 0.36, A * 0.48, 0, 0, TAU); g.fill();
    g.fillStyle = "#f1e7e1"; g.beginPath(); g.ellipse(W * 0.5, A * 0.6, W * 0.2, A * 0.25, 0, 0, TAU); g.fill();
    g.fillStyle = kind ? "#0b1020" : "#1f3b8a"; g.beginPath(); g.moveTo(W * 0.25, A * 0.45); for (let k = 0; k < 7; k++) g.lineTo(W * (0.3 + k * 0.07), A * (k % 2 ? 0.6 : 0.42)); g.lineTo(W * 0.78, A * 0.3); g.lineTo(W * 0.2, A * 0.3); g.fill();
    for (const d of [-1, 1]) { g.fillStyle = "#14295e"; g.beginPath(); g.ellipse(W * 0.5 + d * W * 0.08, A * 0.63, W * 0.04, A * 0.05, 0, 0, TAU); g.fill(); g.fillStyle = "#fff"; g.fillRect(W * 0.5 + d * W * 0.08 - 2, A * 0.6, 2, 2); }
    if (kind === 3) { g.strokeStyle = "#f59e0b"; g.lineWidth = 5; g.beginPath(); g.arc(W * 0.5, A * 0.55, W * 0.3, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); g.fillStyle = "#f59e0b"; g.fillRect(W * 0.18, A * 0.5, 8, 16); g.fillRect(W * 0.75, A * 0.5, 8, 16); }
    g.fillStyle = "rgba(255,255,255,.85)"; g.font = "italic 600 16px Georgia, serif"; g.fillText(title.length < 7 ? title : "", W * 0.55, A * 0.25);
  } else if (kind === 1) {
    g.fillStyle = r() < 0.5 ? "#c81e3a" : blues[0]; g.fillRect(0, 0, W, A);
    g.fillStyle = "#f8f1e7"; g.font = `900 ${title.length > 3 ? 22 : 34}px "Yu Gothic", Georgia, serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(title, W / 2, A * 0.48); g.font = "italic 400 13px Georgia, serif"; g.fillText(ALB_A[i % ALB_A.length], W / 2, A * 0.72);
  } else if (kind === 2) {
    g.fillStyle = "#efe4cf"; g.fillRect(0, 0, W, A);
    g.fillStyle = "#2a1f18"; g.font = "900 19px Georgia, serif"; g.textAlign = "center"; g.textBaseline = "top"; g.fillText("WANTED", W / 2, 6);
    g.fillStyle = "#c2412d"; g.fillRect(W * 0.18, 30, W * 0.64, A * 0.42);
    g.fillStyle = "#fde8e0"; g.beginPath(); g.ellipse(W / 2, 30 + A * 0.24, W * 0.14, A * 0.14, 0, 0, TAU); g.fill();
    g.fillStyle = "#2a1f18"; g.font = "900 18px 'Yu Gothic', serif"; g.fillText(title.length < 4 ? title : "逆光", W / 2, A * 0.76);
  } else if (kind === 4) {
    g.fillStyle = blues[0]; g.fillRect(0, 0, W, A);
    for (let y = 0; y < A; y += 6) for (let x = 0; x < W; x += 6) { const d = Math.hypot(x - W * 0.6, y - A * 0.4) / 60; g.fillStyle = blues[1]; g.beginPath(); g.arc(x, y, Math.max(0, 2.6 - d * 2.2), 0, TAU); g.fill(); }
    g.fillStyle = "#0b1020"; g.beginPath(); g.moveTo(W * 0.1, A); g.quadraticCurveTo(W * 0.3, A * 0.3, W * 0.55, A * 0.45); g.lineTo(W * 0.62, A); g.fill();
    g.fillStyle = "#fff"; g.font = "700 15px 'Yu Gothic', sans-serif"; g.fillText(title, 8, 18);
  } else {
    g.fillStyle = "#f1f5f9"; g.fillRect(0, 0, W, A);
    g.strokeStyle = blues[1]; g.lineWidth = 2;
    for (let k = 0; k < 9; k++) { g.beginPath(); g.moveTo(r() * W, r() * A); g.bezierCurveTo(r() * W, r() * A, r() * W, r() * A, r() * W, r() * A); g.stroke(); }
    g.fillStyle = "#1e293b"; g.font = "700 20px 'Yu Gothic', sans-serif"; g.fillText(title, 8, A - 12);
  }
  g.restore();
  // Подпись как в плеере: название, исполнитель, полоска.
  g.fillStyle = "#e2e8f0"; g.font = "600 11px 'Yu Gothic UI', 'Segoe UI', sans-serif"; g.textBaseline = "top"; g.fillText(title, 8, A + 7);
  g.fillStyle = "rgba(226,232,240,.5)"; g.font = "400 9px 'Segoe UI', sans-serif"; g.fillText(ALB_A[(i * 3) % ALB_A.length], 8, A + 22);
  g.fillStyle = "rgba(226,232,240,.25)"; g.fillRect(8, H - 8, W - 16, 2); g.fillStyle = "#93c5fd"; g.fillRect(8, H - 8, (W - 16) * r(), 2);
  return c;
}

const sphere: Scene = {
  fps: 24, scale: 1, protect: 0.78,
  init(w, h, small) {
    const box = small ? notchBox(w, h, 86, 86) : { x: 0, y: 0, w, h };
    const arts = Array.from({ length: 24 }, (_, i) => albumArt(i));
    return { box, small, arts, ox: 0, oy: 0, play: -1, playT: -9, r: rng(733), eq: Array.from({ length: 5 }, () => Math.random()) };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, b = s.box;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, R = s.small ? Math.min(b.w, b.h) / 2 : Math.hypot(b.w, b.h) * 0.46;
    const CW = s.small ? 26 : 110, CH = s.small ? 35 : 150, G = s.small ? 4 : 14, SW = CW + G, SH = CH + G;
    // Стена дрейфует; курсор поворачивает «шар».
    const wantX = t * 9 + (e.mouse ? (e.mx - cx) * 0.5 : 0), wantY = t * 4 + (e.mouse ? (e.my - cy) * 0.35 : 0);
    s.ox += (wantX - s.ox) * Math.min(1, dt * 3); s.oy += (wantY - s.oy) * Math.min(1, dt * 3);
    if (s.small) { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip(); }
    const span = R * 1.05, i0 = Math.floor((s.ox - span) / SW), i1 = Math.ceil((s.ox + span) / SW), j0 = Math.floor((s.oy - span) / SH), j1 = Math.ceil((s.oy + span) / SH);
    const clk = newClick(s, e) ? e.click! : null;
    let hover = -1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // Плоская точка → «рыбий глаз»: f(r) = 2r − r², центр крупнее, края сжаты.
      const fx = i * SW - s.ox + (j % 2 ? SW * 0.5 : 0), fy = j * SH - s.oy;
      const d = Math.hypot(fx, fy) / span;
      if (d >= 0.98) continue;
      const f = 2 * d - d * d, sr = Math.max(0.05, 2 - 2 * d), st = d > 1e-3 ? f / d : 2;
      const mx = cx + (d > 1e-3 ? (fx / (d * span)) * f * R : 0), my = cy + (d > 1e-3 ? (fy / (d * span)) * f * R : 0);
      const th = Math.atan2(fy, fx), c = Math.cos(th), sn = Math.sin(th), k = R / span * 0.5;
      const a = (sr * c * c + st * sn * sn) * k, bb = (sr - st) * c * sn * k, dd = (sr * sn * sn + st * c * c) * k;
      const id = ((i * 7 + j * 13) % 24 + 24) % 24, key = i * 1000 + j;
      const over = !s.small && e.mouse && Math.abs(e.mx - mx) < CW * a * 0.5 && Math.abs(e.my - my) < CH * dd * 0.5;
      if (over) hover = key;
      if (clk && Math.abs(clk.x - mx) < CW * a * 0.5 && Math.abs(clk.y - my) < CH * dd * 0.5) { s.play = key; s.playT = t; s.title = ALB_T[id % ALB_T.length]; s.artist = ALB_A[(id * 3) % ALB_A.length]; }
      const up = over ? 1.08 : 1, playing = s.play === key;
      ctx.save();
      ctx.translate(mx, my); ctx.transform(a * up, bb * up, bb * up, dd * up, 0, 0);
      ctx.globalAlpha = clamp(1.25 - d * 1.1, 0, 1);
      ctx.drawImage(s.arts[id], -CW / 2, -CH / 2, CW, CH);
      if (over || playing) {
        ctx.strokeStyle = playing ? "#93c5fd" : "#fff"; ctx.lineWidth = 2 / Math.max(0.3, a); ctx.beginPath(); ctx.roundRect(-CW / 2, -CH / 2, CW, CH, 8); ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.arc(0, -CH * 0.14, 18, 0, TAU); ctx.fill();
        ctx.fillStyle = "#fff";
        if (playing) for (let q = 0; q < 4; q++) { const hh = 6 + 12 * Math.abs(Math.sin(t * (5 + q) + q)); ctx.fillRect(-10 + q * 6, -CH * 0.14 + 8 - hh, 4, hh); }
        else { ctx.beginPath(); ctx.moveTo(-6, -CH * 0.14 - 9); ctx.lineTo(10, -CH * 0.14); ctx.lineTo(-6, -CH * 0.14 + 9); ctx.fill(); }
      }
      ctx.restore();
    }
    void hover;
    // Под содержимым окна обложки тише — текст читается; колонка и края — ярко.
    ctx.globalAlpha = 1;
    if (!s.small) {
      const sw = Number(document.documentElement.dataset.sidew) || 220, x0 = sw + 6;
      const g = ctx.createLinearGradient(x0, 0, x0 + 80, 0);
      g.addColorStop(0, "rgba(3,5,10,0)"); g.addColorStop(1, "rgba(3,5,10,.5)");
      ctx.fillStyle = g; ctx.fillRect(x0, 0, b.w - x0, b.h);
    }
    // Иллюминатор: тёмная виньетка по краю линзы.
    const vg = ctx.createRadialGradient(cx, cy, R * 0.72, cx, cy, R * 1.0);
    vg.addColorStop(0, "rgba(3,5,10,0)"); vg.addColorStop(1, "rgba(3,5,10,1)");
    ctx.fillStyle = vg; ctx.fillRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
    if (s.small) { ctx.restore(); ctx.strokeStyle = "rgba(147,197,253,.3)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke(); }
  },
  fx(ctx, s, e) {
    if (s.small || s.play === -1) return;
    // «Сейчас играет» внизу слева.
    const t = e.t, x = 16, y = e.h - 64, w = 230;
    ctx.fillStyle = "rgba(10,16,32,.86)"; ctx.strokeStyle = "rgba(147,197,253,.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, 48, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#93c5fd"; for (let q = 0; q < 4; q++) { const hh = 4 + 12 * Math.abs(Math.sin(t * (4 + q) + q)); ctx.fillRect(x + 14 + q * 5, y + 32 - hh, 3, hh); }
    ctx.fillStyle = "#e2e8f0"; ctx.font = "600 12px 'Yu Gothic UI', 'Segoe UI', sans-serif"; ctx.textBaseline = "top"; ctx.fillText(`♪ ${s.title}`, x + 42, y + 9);
    ctx.fillStyle = "rgba(226,232,240,.55)"; ctx.font = "400 10.5px 'Segoe UI', sans-serif"; ctx.fillText(s.artist, x + 42, y + 26);
    const u = ((t - s.playT) / 30) % 1;
    ctx.fillStyle = "rgba(226,232,240,.2)"; ctx.fillRect(x + 42, y + 40, w - 56, 2); ctx.fillStyle = "#93c5fd"; ctx.fillRect(x + 42, y + 40, (w - 56) * u, 2);
  },
};

// ─── Паутина: круговые сети, паучки, трафик — мушки-пакеты ─────────

function orb(cx: number, cy: number, R: number, a0: number, a1: number, spokes: number, rings: number) {
  const sp = Array.from({ length: spokes }, (_, i) => a0 + ((a1 - a0) * i) / (spokes - 1));
  const pts: any[][] = [];
  for (let k = 1; k <= rings; k++) pts.push(sp.map((a) => ({ a, r: (R * k) / rings * (0.92 + 0.08 * Math.sin(a * 7 + k)), ox: 0, oy: 0, vx: 0, vy: 0 })));
  return { cx, cy, R, a0, a1, sp, pts };
}
const nodeXY = (W: any, p: any) => [W.cx + Math.cos(p.a) * p.r + p.ox, W.cy + Math.sin(p.a) * p.r + p.oy];

/** Милый паучок: круглое тельце, большие глаза, лапки согнуты. */
function spider(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, t: number, walk: number, lk: [number, number], wave: number, bow: boolean) {
  ctx.strokeStyle = "#e9e9ee"; ctx.lineWidth = Math.max(1, s * 0.16); ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const d of [-1, 1]) for (let l = 0; l < 4; l++) {
    const a = (l - 1.5) * 0.42, wig = Math.sin(t * 10 + l * 1.7 + (d > 0 ? 1 : 0)) * 0.25 * walk + (wave && d > 0 && l === 0 ? Math.sin(t * 12) * 0.6 : 0);
    const kx = x + d * s * 1.3, ky = y + (a + wig) * s * 1.4 - s * 0.6;
    ctx.beginPath(); ctx.moveTo(x + d * s * 0.6, y + a * s * 0.6); ctx.lineTo(kx, ky); ctx.lineTo(x + d * s * 2.0, y + (a + wig) * s * 2.0 + s * 0.6); ctx.stroke();
  }
  ctx.fillStyle = "#26262c"; ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.fill(); ctx.stroke();
  for (const d of [-1, 1]) {
    const ex = x + d * s * 0.38, ey = y - s * 0.12;
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(ex, ey, s * 0.34, 0, TAU); ctx.fill();
    ctx.fillStyle = "#0a0a0c"; ctx.beginPath(); ctx.arc(ex + lk[0] * s * 0.12, ey + lk[1] * s * 0.12, s * 0.19, 0, TAU); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(ex + lk[0] * s * 0.12 - s * 0.07, ey + lk[1] * s * 0.12 - s * 0.08, s * 0.06, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = "rgba(255,150,170,.55)"; for (const d of [-1, 1]) { ctx.beginPath(); ctx.ellipse(x + d * s * 0.62, y + s * 0.3, s * 0.15, s * 0.08, 0, 0, TAU); ctx.fill(); }
  ctx.strokeStyle = "#e9e9ee"; ctx.lineWidth = Math.max(0.8, s * 0.1); ctx.beginPath(); ctx.arc(x, y + s * 0.3, s * 0.18, 0.3, Math.PI - 0.3); ctx.stroke();
  if (bow) { ctx.fillStyle = "#f472b6"; ctx.beginPath(); ctx.moveTo(x + s * 0.3, y - s * 0.95); ctx.lineTo(x + s * 0.75, y - s * 1.25); ctx.lineTo(x + s * 0.75, y - s * 0.7); ctx.closePath(); ctx.moveTo(x + s * 0.3, y - s * 0.95); ctx.lineTo(x - s * 0.15, y - s * 1.25); ctx.lineTo(x - s * 0.15, y - s * 0.7); ctx.fill(); }
}

const web: Scene = {
  fps: 30, scale: 1, protect: 0.2,
  init(w, h, small) {
    const webs = small ? [orb(w, 0, h * 1.4, Math.PI / 2, Math.PI, 9, 6)] : [orb(w, 0, Math.min(w, h) * 0.55, Math.PI / 2, Math.PI, 13, 12), orb(0, h, Math.min(w, h) * 0.38, -Math.PI / 2, 0, 10, 9)];
    const r = rng(263);
    const W0 = webs[0], start = nodeXY(W0, W0.pts[5][6]);
    return { webs, small, r, hang: { y: small ? h * 0.4 : h * 0.3, v: 0 }, walker: { x: start[0], y: start[1], tx: start[0], ty: start[1], wait: 1, prey: null as any }, sitter: webs[1] ? nodeXY(webs[1], webs[1].pts[2][5]) : [0, 0], bugs: [] as any[], drops: [] as any[], next: 1 };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e;
    const c: [number, number, number] = e.alarm ? [255, 120, 130] : [235, 235, 240];
    for (const W of s.webs) {
      for (const ring of W.pts) for (const p of ring) {
        const [x, y] = nodeXY(W, p);
        let fx = -p.ox * 0.08, fy = -p.oy * 0.08 + Math.sin(t * 1.2 + p.a * 3) * 0.02;
        if (e.mouse) { const dx = e.mx - x, dy = e.my - y, d = Math.hypot(dx, dy); if (d < 70 && d > 1) { fx += dx * 0.02; fy += dy * 0.02; } }
        if (e.click && e.click.age < 0.4) { const dx = x - e.click.x, dy = y - e.click.y, d = Math.hypot(dx, dy) || 1; if (d < 160) { fx += (dx / d) * 1.5; fy += (dy / d) * 1.5; } }
        p.vx = (p.vx + fx) * 0.9; p.vy = (p.vy + fy) * 0.9; p.ox += p.vx; p.oy += p.vy;
      }
      ctx.strokeStyle = rgba(c[0], c[1], c[2], 0.45); ctx.lineWidth = 0.8;
      ctx.beginPath();
      W.sp.forEach((_: number, i: number) => { ctx.moveTo(W.cx, W.cy); for (const ring of W.pts) { const [x, y] = nodeXY(W, ring[i]); ctx.lineTo(x, y); } });
      ctx.stroke();
      ctx.lineWidth = 0.6;
      W.pts.forEach((ring: any[], k: number) => {
        ctx.strokeStyle = rgba(c[0], c[1], c[2], 0.25 + 0.3 * (k / W.pts.length));
        ctx.beginPath();
        ring.forEach((p, i) => { const [x, y] = nodeXY(W, p); if (!i) { ctx.moveTo(x, y); return; } const [px, py] = nodeXY(W, ring[i - 1]); ctx.quadraticCurveTo((x + px) / 2 + (W.cx - (x + px) / 2) * 0.06, (y + py) / 2 + (W.cy - (y + py) / 2) * 0.06 + 2, x, y); });
        ctx.stroke();
        ring.forEach((p, i) => { if ((i + k) % 3) return; const [x, y] = nodeXY(W, p); const tw = Math.abs(Math.sin(t * 1.5 + i + k)); ctx.fillStyle = rgba(255, 255, 255, 0.4 + tw * 0.6); ctx.beginPath(); ctx.arc(x, y + 1, 1 + tw, 0, TAU); ctx.fill(); });
      });
    }
    // Мушки-пакеты: летят по трафику; попадают в сеть — застревают.
    s.next -= dt * (0.4 + sig.load * 3);
    if (!s.small && s.next <= 0 && s.bugs.length < 14) {
      s.next = 1;
      const fromLeft = s.r() < 0.5;
      s.bugs.push({ x: fromLeft ? -10 : w + 10, y: 80 + s.r() * (h - 160), vx: (fromLeft ? 1 : -1) * (50 + s.r() * 50), ph: s.r() * TAU, stuck: null, wrap: 0, t });
    }
    s.bugs = s.bugs.filter((b: any) => {
      if (!b.stuck) {
        b.x += b.vx * dt; b.y += Math.sin(t * 6 + b.ph) * 30 * dt;
        for (const W of s.webs) {
          const dx = b.x - W.cx, dy = b.y - W.cy, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
          if (d < W.R * 0.9 && d > W.R * 0.15 && a >= Math.min(W.a0, W.a1) && a <= Math.max(W.a0, W.a1)) {
            let best: any = null, bd = 1e9;
            for (const ring of W.pts) for (const p of ring) { const [x, y] = nodeXY(W, p); const q = Math.hypot(x - b.x, y - b.y); if (q < bd) { bd = q; best = p; } }
            b.stuck = { W, p: best }; best.vx += (s.r() - 0.5) * 6; best.vy += (s.r() - 0.5) * 6; b.st = t;
            break;
          }
        }
        if (b.x < -30 || b.x > w + 30) return false;
      } else { const [x, y] = nodeXY(b.stuck.W, b.stuck.p); b.x = x; b.y = y; }
      if (b.wrap >= 1 && t - b.st > 25) return false;
      if (b.wrap >= 1) { ctx.fillStyle = "rgba(240,240,245,.85)"; ctx.beginPath(); ctx.ellipse(b.x, b.y + 3, 3, 5, 0.3, 0, TAU); ctx.fill(); ctx.strokeStyle = "rgba(120,120,130,.8)"; ctx.lineWidth = 0.6; for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(b.x - 3, b.y + 3 + k * 2); ctx.lineTo(b.x + 3, b.y + 2 + k * 2); ctx.stroke(); } }
      else {
        const fl = Math.abs(Math.sin(t * (b.stuck ? 30 : 40) + b.ph));
        ctx.fillStyle = "rgba(147,197,253,.35)"; ctx.beginPath(); ctx.arc(b.x, b.y, 7, 0, TAU); ctx.fill();
        ctx.fillStyle = "#e0f2fe"; ctx.beginPath(); ctx.arc(b.x, b.y, 2.2, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba(255, 255, 255, 0.5); for (const d of [-1, 1]) { ctx.beginPath(); ctx.ellipse(b.x + d * 3, b.y - 2, 3, 1.4 + fl, d * 0.5, 0, TAU); ctx.fill(); }
      }
      return true;
    });
    // Ходок по большой сети: бежит к пойманной мушке и заворачивает её.
    const W0 = s.webs[0], wk = s.walker;
    if (!s.small) {
      if (!wk.prey) { const prey = s.bugs.find((b: any) => b.stuck && b.stuck.W === W0 && b.wrap < 1); if (prey) wk.prey = prey; }
      if (wk.prey) { wk.tx = wk.prey.x; wk.ty = wk.prey.y; }
      const dx = wk.tx - wk.x, dy = wk.ty - wk.y, d = Math.hypot(dx, dy), sp = wk.prey ? 120 : 45;
      let walking = 0;
      if (d > 2) { wk.x += (dx / d) * Math.min(d, sp * dt); wk.y += (dy / d) * Math.min(d, sp * dt); walking = 1; }
      else if (wk.prey) { wk.prey.wrap += dt / 1.2; if (wk.prey.wrap >= 1) wk.prey = null; }
      else { wk.wait -= dt; if (wk.wait <= 0) { wk.wait = 1 + s.r() * 3; const ring = W0.pts[2 + ((s.r() * (W0.pts.length - 3)) | 0)], p = ring[(s.r() * ring.length) | 0]; [wk.tx, wk.ty] = nodeXY(W0, p); } }
      const wave = e.mouse && Math.hypot(e.mx - wk.x, e.my - wk.y) < 90 ? 1 : 0;
      spider(ctx, wk.x, wk.y, 10, t, walking, look(e, wk.x, wk.y, 200), wave, false);
      if (s.webs[1]) { const [sx, sy] = nodeXY(s.webs[1], s.webs[1].pts[2][5]); spider(ctx, sx, sy, 9, t, 0, look(e, sx, sy, 200), e.mouse && Math.hypot(e.mx - sx, e.my - sy) < 100 ? 1 : 0, true); }
    }
    // Паучок на нити: у курсора поднимается.
    const hx = s.small ? w - 30 : w - Math.min(w, h) * 0.22;
    const near = e.mouse && Math.abs(e.mx - hx) < 120 && e.my > s.hang.y - 60 && e.my < s.hang.y + 140;
    const target = near ? h * 0.08 : (s.small ? h * 0.55 : h * 0.34) + Math.sin(t * 0.3) * 30;
    s.hang.v += (target - s.hang.y) * (near ? 0.08 : 0.01); s.hang.v *= 0.85; s.hang.y += s.hang.v * dt * 30;
    const sy = s.hang.y, sw = Math.sin(t * 0.9) * 4;
    ctx.strokeStyle = rgba(c[0], c[1], c[2], 0.6); ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx + sw, sy - 8); ctx.stroke();
    spider(ctx, hx + sw, sy, s.small ? 4 : 10, t, Math.abs(s.hang.v) > 1 ? 1 : 0, look(e, hx + sw, sy, 200), 0, false);
    // Щелчок: паучок спускается к месту щелчка, машет и уезжает наверх.
    if (newClick(s, e) && !s.small) s.drops.push({ x: e.click!.x, y: e.click!.y, t, life: 3.2 });
    s.drops = particles(s.drops, t, (q: any, a) => {
      const u = 1 - a, k = u < 0.3 ? u / 0.3 : u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3, y = q.y * (1 - (1 - k) * (1 - k)) - 10;
      ctx.strokeStyle = rgba(c[0], c[1], c[2], 0.6); ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(q.x, 0); ctx.lineTo(q.x, y - 8); ctx.stroke();
      spider(ctx, q.x, y, 7, t, 0, [0, 0.6], u > 0.3 && u < 0.7 ? 1 : 0, true);
      if (u > 0.32 && u < 0.68) { ctx.fillStyle = "#e9e9ee"; ctx.font = "600 12px 'Segoe UI', sans-serif"; ctx.fillText("hi!", q.x + 14, y - 10); }
    });
  },
};

export const GADGETS = { pet, widgets, sphere, web };
