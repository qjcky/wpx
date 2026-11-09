// Кофейные темы: Утро (блоб с чашкой), E=MC² (мелом), Элемент (CoFFeE).

import { TAU, clamp, rng, rgba, newClick, sideZone, sig, health, look, particles, notchBox, type Scene } from "./scenekit";

// ─── Утро: белый контур-блоб пьёт кофе ───────────────────────────

/** Кофейное зерно контуром. */
function bean(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.7, 0, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-r * 0.8, 0); ctx.bezierCurveTo(-r * 0.3, -r * 0.35, r * 0.3, r * 0.35, r * 0.8, 0); ctx.stroke();
  ctx.restore();
}

const blob: Scene = {
  fps: 30, scale: 1, protect: 0.12,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 80, 96) : sideZone({ w, h });
    const r = rng(401);
    return { z, small, r, level: 1, sip: -9, pour: -9, blink: 2, beans: Array.from({ length: small ? 0 : 8 }, () => ({ x: r() * w, y: r() * h, v: 5 + r() * 8, a: r() * TAU, va: (r() - 0.5) * 0.4, s: 6 + r() * 6 })), line: [] as any[], hearts: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e, z = s.z, Wc = "#f2f2f2";
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (!s.small) {
      ctx.strokeStyle = "rgba(242,242,242,.14)"; ctx.lineWidth = 1.4;
      for (const b of s.beans) { b.y -= b.v * dt; b.a += b.va * dt; if (b.y < -20) { b.y = h + 20; b.x = s.r() * w; } bean(ctx, b.x, b.y, b.s, b.a); }
    }
    if (!s.small) {
      // Сверху — надпись маркером и каракуля-солнце.
      const sx = z.x + z.w - 34, sy = z.y + 40, rr = 14;
      ctx.strokeStyle = Wc; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(sx, sy, rr, 0, TAU); ctx.stroke();
      for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + t * 0.3; ctx.beginPath(); ctx.moveTo(sx + Math.cos(a) * rr * 1.4, sy + Math.sin(a) * rr * 1.4); ctx.lineTo(sx + Math.cos(a) * rr * 1.9, sy + Math.sin(a) * rr * 1.9); ctx.stroke(); }
      ctx.fillStyle = Wc; ctx.textBaseline = "top"; ctx.font = `700 ${clamp(z.w / 8, 20, 32)}px "Segoe Print", "Ink Free", cursive`;
      ctx.fillText("coffee", z.x + 6, z.y + 18); ctx.fillText("first.", z.x + 6, z.y + 18 + clamp(z.w / 8, 20, 32) * 1.25);
      ctx.font = `400 13px "Segoe Print", "Ink Free", cursive`; ctx.fillStyle = "rgba(242,242,242,.6)";
      ctx.fillText(s.level <= 0.01 ? "кружка пуста — щёлкни" : "щёлкни — глоток", z.x + 8, z.y + 22 + clamp(z.w / 8, 20, 32) * 2.6);
    }
    // Рамка блоба: низ уходит за край колонки.
    const bw = s.small ? z.w : Math.min(z.w * 0.98, z.h * 0.62), bh = bw * 1.25;
    const bx = z.x + (z.w - bw) / 2, by = (s.small ? z.y + z.h : z.y + z.h + 10) - bh;
    const br = 1 + Math.sin(t * 1.3) * 0.008;
    const X = (u: number) => bx + u * bw, Y = (v: number) => by + bh - (1 - v) * bh * br;
    const lw = Math.max(2, bw / 46);
    ctx.strokeStyle = Wc; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(X(0.06), Y(1.02));
    ctx.bezierCurveTo(X(0.02), Y(0.6), X(0.1), Y(0.08), X(0.5), Y(0.03));
    ctx.bezierCurveTo(X(0.82), Y(0.0), X(1.0), Y(0.2), X(0.98), Y(0.36));
    ctx.bezierCurveTo(X(0.97), Y(0.44), X(0.9), Y(0.45), X(0.86), Y(0.45)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0.36), Y(0.465)); ctx.lineTo(X(0.86), Y(0.455)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0.8), Y(0.47)); ctx.bezierCurveTo(X(0.81), Y(0.62), X(0.81), Y(0.85), X(0.83), Y(1.02)); ctx.stroke();
    // Глаза-точки смотрят на курсор, моргают; при глотке — довольные дуги.
    const sipU = t - s.sip, sipping = sipU >= 0 && sipU < 1.6;
    const lift = sipping ? Math.sin(Math.min(1, sipU / 1.6) * Math.PI) : 0;
    if (t > s.blink) s.blink = t + 2.5 + s.r() * 4;
    const [lx, ly] = look(e, X(0.6), Y(0.28), 300, [0, 0]);
    const sad = s.level <= 0.01;
    for (const ex of [0.46, 0.82]) {
      const cx = X(ex) + lx * bw * 0.02, cy = Y(sad ? 0.31 : 0.285) + ly * bw * 0.015;
      if (sipping && lift > 0.3) { ctx.beginPath(); ctx.arc(cx, cy + lw, lw * 1.4, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
      else if (s.blink - t < 0.12) { ctx.beginPath(); ctx.moveTo(cx - lw, cy); ctx.lineTo(cx + lw, cy); ctx.stroke(); }
      else { ctx.fillStyle = Wc; ctx.beginPath(); ctx.arc(cx, cy, lw * 0.95, 0, TAU); ctx.fill(); }
    }
    // Чашка: подносится ко рту при глотке; пар тянется к курсору.
    const cupX = X(0.47) + lift * bw * 0.12, cupY = Y(0.66) - lift * bh * 0.14, cw = bw * 0.26, ch = bw * 0.2, rot = -lift * 0.35;
    ctx.save(); ctx.translate(cupX, cupY); ctx.rotate(rot);
    ctx.fillStyle = "#5b3a32";
    ctx.beginPath(); ctx.moveTo(-cw / 2, -ch / 2); ctx.lineTo(cw / 2, -ch / 2); ctx.lineTo(cw / 2, ch * 0.2); ctx.quadraticCurveTo(cw / 2, ch / 2, cw * 0.3, ch / 2); ctx.lineTo(-cw * 0.3, ch / 2); ctx.quadraticCurveTo(-cw / 2, ch / 2, -cw / 2, ch * 0.2); ctx.closePath();
    const lvl = s.level, pourU = t - s.pour;
    if (pourU < 1) s.level = Math.min(1, pourU);
    ctx.save(); ctx.clip(); ctx.fillRect(-cw, ch / 2 - ch * lvl, cw * 2, ch * lvl); ctx.restore();
    ctx.lineWidth = lw * 0.85; ctx.stroke();
    ctx.beginPath(); ctx.arc(-cw / 2 - cw * 0.12, -ch * 0.02, cw * 0.15, Math.PI * 0.5, Math.PI * 1.5); ctx.stroke();
    ctx.restore();
    // Рука держит ручку.
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(X(0.22), Y(1.0)); ctx.bezierCurveTo(X(0.17), Y(0.86), X(0.18), Y(0.74), cupX - cw * 0.66, cupY + ch * 0.05);
    ctx.bezierCurveTo(cupX - cw * 0.5, cupY - ch * 0.2, cupX - cw * 0.85, cupY - ch * 0.25, cupX - cw * 0.75, cupY + ch * 0.2); ctx.stroke();
    if (pourU >= 0 && pourU < 1) { ctx.lineWidth = lw * 0.7; ctx.strokeStyle = "#8b5a4a"; ctx.beginPath(); ctx.moveTo(cupX, cupY - bh * 0.4); ctx.lineTo(cupX, cupY - ch * 0.4); ctx.stroke(); ctx.strokeStyle = Wc; }
    if (lvl > 0.05 && !sipping) {
      const pull = e.mouse ? clamp((e.mx - cupX) / 300, -1, 1) : 0;
      ctx.lineWidth = lw * 0.55; ctx.strokeStyle = rgba(242, 242, 242, 0.85);
      for (const [d, ph] of [[-0.08, 0], [0.06, 1.7]]) {
        const sx = cupX + d * bw, sy = cupY - ch * 0.75;
        ctx.beginPath();
        for (let i = 0; i <= 12; i++) { const u = i / 12, x = sx + Math.sin(u * 7 + t * 3 + ph) * bw * 0.025 + pull * u * bw * 0.06, y = sy - u * bw * 0.16; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
      }
    }
    if (newClick(s, e)) {
      if (s.level <= 0.01) s.pour = t;
      else if (!sipping) { s.sip = t; setTimeout(() => { s.level = Math.max(0, s.level - 0.34); }, 700); }
    }
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t } = e;
    // След маркером: гладкая линия за курсором, тоньше к хвосту.
    const tr = e.trail;
    ctx.lineCap = "round"; ctx.strokeStyle = "#f2f2f2";
    for (let i = 1; i < tr.length; i++) {
      const k = 1 - tr[i][2] / 1.0; if (k <= 0) continue;
      ctx.globalAlpha = k * 0.8; ctx.lineWidth = 3 * k;
      ctx.beginPath(); ctx.moveTo(tr[i - 1][0], tr[i - 1][1]); ctx.lineTo(tr[i][0], tr[i][1]); ctx.stroke();
    }
    if (newClick(s, e, "_fx")) s.hearts.push({ x: e.click!.x, y: e.click!.y, t, life: 1 });
    s.hearts = particles(s.hearts, t, (q: any, a) => {
      const u = 1 - a, r = 8 + u * 10;
      ctx.globalAlpha = a; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(q.x, q.y - u * 20 + r * 0.9);
      ctx.bezierCurveTo(q.x - r * 1.4, q.y - u * 20, q.x - r * 0.6, q.y - u * 20 - r * 1.1, q.x, q.y - u * 20 - r * 0.25);
      ctx.bezierCurveTo(q.x + r * 0.6, q.y - u * 20 - r * 1.1, q.x + r * 1.4, q.y - u * 20, q.x, q.y - u * 20 + r * 0.9); ctx.stroke();
    });
    ctx.globalAlpha = 1;
  },
};

// ─── E=MC²: энергия = молоко × кофе², мелом ──────────────────────

const CHALK_F = ["∫ coffee dt", "Δsleep < 0", "ping → 0", "√(latte)", "π ≈ 3.14", "1 + 1 = 10", "∞ cups", "dE/dt > 0", "c = const", "x² + ☕²", "λ = 1/ping", "Σ beans"];

/** Надпись мелом: белое по чёрному с выщербинами (готовится один раз). */
function chalkText(lines: [string, string, number][], wdt: number, hgt: number, seed: number) {
  const c = document.createElement("canvas");
  c.width = Math.ceil(wdt); c.height = Math.ceil(hgt);
  const g = c.getContext("2d")!, r = rng(seed);
  g.textBaseline = "top"; g.fillStyle = "#f0f0f0";
  for (const [txt, font, y] of lines) { g.font = font; g.fillText(txt, (wdt - g.measureText(txt).width) / 2, y); }
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < (wdt * hgt) / 9; i++) { g.fillStyle = `rgba(0,0,0,${(0.3 + r() * 0.7).toFixed(2)})`; g.fillRect(r() * wdt, r() * hgt, 1 + r() * 2, 1); }
  return c;
}

const emc2: Scene = {
  fps: 24, scale: 1, protect: 0.1,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 110, 90) : sideZone({ w, h });
    const fs = s0(z.w);
    const text = chalkText([
      ["E=MC", `700 ${fs}px "Segoe Print", "Ink Free", cursive`, 0],
      ["(ENERGY = MILK × COFFEE²)", `700 ${fs * 0.19}px "Ink Free", "Segoe Print", cursive`, fs * 1.45],
    ], z.w, fs * 1.8, 409);
    const r = rng(419);
    return { z, small, fs, text, r, dust: [] as any[], notes: [] as any[], ripple: -9, faint: Array.from({ length: small ? 0 : 7 }, (_, i) => ({ txt: CHALK_F[i], x: r() * w, y: r() * h, a: (r() - 0.5) * 0.3 })) };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, z = s.z, fs = s.fs;
    if (!s.small) {
      ctx.font = `400 16px "Ink Free", "Segoe Print", cursive`; ctx.fillStyle = "rgba(240,240,240,.06)";
      for (const f of s.faint) { ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.a); ctx.fillText(f.txt, 0, 0); ctx.restore(); }
    }
    const y0 = s.small ? z.y : z.y + 6;
    ctx.drawImage(s.text, z.x, y0);
    // Степень «²» покачивается отдельно.
    ctx.font = `700 ${fs * 0.42}px "Segoe Print", "Ink Free", cursive`; ctx.fillStyle = "#f0f0f0"; ctx.textBaseline = "top";
    const ew = (() => { ctx.save(); ctx.font = `700 ${fs}px "Segoe Print", "Ink Free", cursive`; const m = ctx.measureText("E=MC").width; ctx.restore(); return m; })();
    ctx.fillText("2", z.x + (z.w + ew) / 2 + 2, y0 + Math.sin(t * 2) * 2);
    // Чашка: фарфор со штриховкой, кофе, пар; щелчок — круги по кофе.
    const cx = z.x + z.w / 2, cy = y0 + fs * 2.4 + (s.small ? 0 : 20), R = Math.min(z.w * 0.3, fs * 1.1);
    const hover = e.mouse && Math.hypot(e.mx - cx, e.my - cy) < R * 1.4;
    ctx.fillStyle = "#ececec"; ctx.strokeStyle = "#cfcfcf"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.bezierCurveTo(cx - R, cy + R * 0.95, cx - R * 0.45, cy + R * 1.05, cx, cy + R * 1.05);
    ctx.bezierCurveTo(cx + R * 0.45, cy + R * 1.05, cx + R, cy + R * 0.95, cx + R, cy); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(60,60,60,.35)"; ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) { const x = cx + R * 0.25 + i * R * 0.07; ctx.beginPath(); ctx.moveTo(x, cy + R * 0.15); ctx.lineTo(x - R * 0.05, cy + R * 0.85 - i * R * 0.05); ctx.stroke(); }
    ctx.strokeStyle = "rgba(60,60,60,.6)"; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(cx + R * 0.45, cy + R * 0.55); ctx.lineTo(cx + R * 0.62, cy + R * 0.5); ctx.moveTo(cx + R * 0.44, cy + R * 0.66); ctx.lineTo(cx + R * 0.6, cy + R * 0.61);
    ctx.moveTo(cx + R * 0.5, cy + R * 0.45); ctx.lineTo(cx + R * 0.48, cy + R * 0.72); ctx.moveTo(cx + R * 0.57, cy + R * 0.43); ctx.lineTo(cx + R * 0.55, cy + R * 0.7); ctx.stroke();
    ctx.strokeStyle = "#ececec"; ctx.lineWidth = R * 0.12;
    ctx.beginPath(); ctx.ellipse(cx + R * 1.08, cy + R * 0.35, R * 0.22, R * 0.28, 0, -1.7, 1.7); ctx.stroke();
    ctx.fillStyle = "#f5f5f5"; ctx.beginPath(); ctx.ellipse(cx, cy, R, R * 0.24, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#6b4226"; ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.02, R * 0.9, R * 0.18, 0, 0, TAU); ctx.fill();
    const ru = t - s.ripple;
    if (ru < 1.2) { ctx.strokeStyle = rgba(230, 200, 170, 1 - ru / 1.2); ctx.lineWidth = 1; for (const k of [0.3, 0.6]) { ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.02, R * 0.9 * ((ru * 0.8 + k) % 1), R * 0.18 * ((ru * 0.8 + k) % 1), 0, 0, TAU); ctx.stroke(); } }
    ctx.strokeStyle = "rgba(240,240,240,.55)"; ctx.lineWidth = 1.6; ctx.lineCap = "round";
    for (const [d, ph] of [[-0.3, 0], [0, 2], [0.3, 4]]) {
      const n = hover ? 1.4 : 1;
      ctx.beginPath();
      for (let i = 0; i <= 14; i++) { const u = i / 14, x = cx + d * R + Math.sin(u * 6 + t * 2.5 + ph) * R * 0.08, y = cy - R * 0.25 - u * R * 0.9 * n; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    }
    const clk = newClick(s, e) ? e.click! : null;
    if (clk && Math.hypot(clk.x - cx, clk.y - cy) < R * 1.4) s.ripple = t;
    else if (clk && !s.small) s.notes.push({ x: clk.x, y: clk.y, txt: CHALK_F[(s.r() * CHALK_F.length) | 0], t, life: 3.4 });
    if (s.small) return;
    // Скорость света — это пинг.
    ctx.font = `400 ${Math.max(13, fs * 0.3)}px "Ink Free", "Segoe Print", cursive`; ctx.fillStyle = "rgba(240,240,240,.7)";
    const ms = sig.ms, line = health() === "down" ? "c = 0  (нет связи)" : `c = ${ms ?? "…"} ms`;
    ctx.fillText(line, cx - ctx.measureText(line).width / 2, cy + R * 1.25);
    void dt;
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t, dt } = e;
    for (let i = 0; i < e.trail.length; i += 2) { const [x, y, a] = e.trail[i]; if (a < 0.06 && s.r() < 0.6) s.dust.push({ x, y, vy: 10 + s.r() * 30, t, life: 0.9 }); }
    s.dust = particles(s.dust, t, (q: any, a) => { q.y += q.vy * dt; ctx.fillStyle = rgba(230, 230, 230, a * 0.7); ctx.fillRect(q.x, q.y, 1.6, 1.6); });
    // Формула пишется мелом слева направо и стирается.
    s.notes = particles(s.notes, t, (q: any, a) => {
      ctx.font = `400 20px "Ink Free", "Segoe Print", cursive`; ctx.textBaseline = "middle";
      const tw = ctx.measureText(q.txt).width, u = Math.min(1, (t - q.t) / 0.7);
      ctx.save(); ctx.beginPath(); ctx.rect(q.x, q.y - 20, tw * u + 2, 40); ctx.clip();
      ctx.fillStyle = rgba(240, 240, 240, Math.min(1, a * 2)); ctx.fillText(q.txt, q.x, q.y); ctx.restore();
    });
  },
};
/** Кегль «E=MC» по ширине колонки. */
const s0 = (w: number) => clamp(w / 4.1, 28, 64);

// ─── Элемент: CoFFeE из таблицы Менделеева, атом-чашка ───────────

const ELEM: [number, string, string, string, string][] = [[27, "Co", "Cobaltum", "58,933", "C₈"], [9, "F", "Fluorum", "18,998", "H₁₀"], [26, "Fe", "Ferrum", "55,845", "N₄"], [99, "E", "Einsteinium", "252,082", "O₂"]];
const POP = ["H", "He", "Li", "Cu", "Ag", "Au", "Zn", "Ne", "Ar", "Kr", "Xe", "Ca", "Mg", "Na"];

function tile(ctx: CanvasRenderingContext2D, x: number, y: number, tw: number, th: number, el: [number, string, string, string, string], flip: number, lit: number, t: number, i: number) {
  const sx = Math.abs(Math.cos(flip * Math.PI)), back = flip > 0.5;
  ctx.save(); ctx.translate(x + tw / 2, y + th / 2); ctx.scale(Math.max(0.02, sx), 1);
  ctx.fillStyle = back ? "#1c1c1f" : "#121214";
  ctx.strokeStyle = rgba(205, 205, 205, 0.55 + 0.45 * lit); ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.roundRect(-tw / 2, -th / 2, tw, th, 5); ctx.fill(); ctx.stroke();
  ctx.textBaseline = "top"; ctx.fillStyle = "#c9c9c9";
  if (back) {
    ctx.font = `700 ${th * 0.36}px "Segoe UI", sans-serif`; ctx.textAlign = "center";
    ctx.fillText(el[4], 0, -th * 0.22); ctx.font = `400 ${th * 0.12}px "Segoe UI", sans-serif`; ctx.fillText("кофеин", 0, th * 0.22);
    ctx.restore(); ctx.textAlign = "left"; return;
  }
  ctx.font = `600 ${th * 0.15}px "Segoe UI", sans-serif`; ctx.fillText(String(el[0]), -tw / 2 + 6, -th / 2 + 5);
  // Символ «металлом»: градиент и бегущий блик.
  const g = ctx.createLinearGradient(-tw / 2, -th * 0.2, tw / 2, th * 0.2);
  const ph = ((t * 0.25 + i * 0.25) % 1.6) - 0.3;
  g.addColorStop(0, "#9a9a9a"); g.addColorStop(clamp(ph - 0.1, 0, 1), "#bdbdbd"); g.addColorStop(clamp(ph, 0, 1), "#ffffff"); g.addColorStop(clamp(ph + 0.1, 0, 1), "#bdbdbd"); g.addColorStop(1, "#8a8a8a");
  ctx.fillStyle = g; ctx.font = `600 ${th * 0.42}px Bahnschrift, "Segoe UI", sans-serif`;
  ctx.fillText(el[1], -tw / 2 + 6, -th * 0.27);
  if (el[1] === "E") { const ew = ctx.measureText("E").width; ctx.font = `600 ${th * 0.16}px Bahnschrift, sans-serif`; ctx.fillText("s", -tw / 2 + 8 + ew, th * 0.0); }
  ctx.fillStyle = "#a3a3a3"; ctx.font = `400 ${th * 0.11}px "Segoe UI", sans-serif`;
  ctx.fillText(el[2], -tw / 2 + 6, th * 0.2); ctx.fillText(el[3], -tw / 2 + 6, th * 0.33);
  ctx.restore();
}

const element: Scene = {
  fps: 30, scale: 1, protect: 0.1,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 110, 60) : sideZone({ w, h });
    return { z, small, r: rng(431), flips: [-9, -9, -9, -9], pops: [] as any[], orb: 0 };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, z = s.z;
    const k = s.small ? 0.5 : Math.min(1, z.h / 400, z.w / 196);
    // Атом: круг с чашкой, по орбитам бегут электроны (быстрее от трафика).
    const cx = z.x + z.w / 2, cy = s.small ? z.y + z.h / 2 : z.y + 48 * k, R = 34 * k;
    s.orb += dt * (0.8 + sig.load * 4);
    ctx.strokeStyle = "rgba(205,205,205,.25)"; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.55, R * 0.5, (i * Math.PI) / 3, 0, TAU); ctx.stroke(); }
    for (let i = 0; i < 3; i++) {
      const a = s.orb * (1 + i * 0.3) + i * 2, ang = (i * Math.PI) / 3;
      const ex = Math.cos(a) * R * 1.55, ey = Math.sin(a) * R * 0.5;
      const x = cx + ex * Math.cos(ang) - ey * Math.sin(ang), y = cy + ex * Math.sin(ang) + ey * Math.cos(ang);
      ctx.fillStyle = "#e5e5e5"; ctx.beginPath(); ctx.arc(x, y, 2.4 * Math.max(0.6, k), 0, TAU); ctx.fill();
    }
    ctx.fillStyle = "#0f0f10"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#cfcfcf"; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(cx - R * 0.45, cy - R * 0.3); ctx.lineTo(cx + R * 0.35, cy - R * 0.3); ctx.lineTo(cx + R * 0.3, cy + R * 0.12);
    ctx.quadraticCurveTo(cx + R * 0.25, cy + R * 0.3, cx - R * 0.05, cy + R * 0.3); ctx.quadraticCurveTo(cx - R * 0.35, cy + R * 0.3, cx - R * 0.4, cy + R * 0.12); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R * 0.42, cy - R * 0.08); ctx.lineTo(cx + R * 0.32, cy - R * 0.08); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + R * 0.42, cy - R * 0.05, R * 0.13, -1.4, 1.4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R * 0.55, cy + R * 0.42); ctx.lineTo(cx + R * 0.45, cy + R * 0.42); ctx.stroke();
    if (s.small) return;
    // Плитки 2×2: наведение поднимает, щелчок переворачивает — сзади формула кофеина.
    const gap = 8 * k, tw = (z.w - gap - 4) / 2, th = Math.min(tw * 0.78, 76 * k), ty0 = cy + R * 1.7;
    const clk = newClick(s, e) ? e.click! : null;
    ELEM.forEach((el, i) => {
      const x = z.x + 2 + (i % 2) * (tw + gap), y = ty0 + Math.floor(i / 2) * (th + gap);
      const over = e.mouse && e.mx > x && e.mx < x + tw && e.my > y && e.my < y + th;
      if (clk && clk.x > x && clk.x < x + tw && clk.y > y && clk.y < y + th) s.flips[i] = t;
      const fu = t - s.flips[i], flip = fu < 0.4 ? fu / 0.4 : fu < 4 ? 1 : fu < 4.4 ? 1 - (fu - 4) / 0.4 : 0;
      tile(ctx, x, y - (over ? 3 : 0), tw, th, el, flip, over ? 1 : 0, t, i);
    });
    const ly = ty0 + 2 * (th + gap) + 8;
    ctx.fillStyle = "#a3a3a3"; ctx.font = `600 ${11 * Math.max(0.85, k)}px "Segoe UI", sans-serif`; ctx.textBaseline = "top";
    (ctx as any).letterSpacing = "2px";
    for (const [i, l] of ["THE MOST", "IMPORTANT ELEMENT"].entries()) ctx.fillText(l, z.x + (z.w - ctx.measureText(l).width) / 2, ly + i * 15);
    (ctx as any).letterSpacing = "0px";
    // Пятый элемент — живой: «Pg, Pingium», номер — пинг.
    const py = ly + 40, pw = Math.min(tw, 96), ph = th * 0.8, px = z.x + (z.w - pw) / 2;
    if (py + ph < z.y + z.h) {
      const down = health() === "down";
      ctx.strokeStyle = down ? "rgba(248,113,113,.8)" : "rgba(205,205,205,.4)"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#c9c9c9"; ctx.font = `600 ${ph * 0.15}px "Segoe UI", sans-serif`; ctx.fillText(down ? "0" : String(sig.ms ?? "?"), px + 6, py + 5);
      ctx.font = `600 ${ph * 0.42}px Bahnschrift, "Segoe UI", sans-serif`; ctx.fillText("Pg", px + 6, py + ph * 0.24);
      ctx.fillStyle = "#8a8a8a"; ctx.font = `400 ${ph * 0.12}px "Segoe UI", sans-serif`; ctx.fillText("Pingium", px + 6, py + ph * 0.7);
    }
    if (clk && !s.flips.some((f: number) => f === t)) s.pops.push({ x: clk.x, y: clk.y, s: POP[(s.r() * POP.length) | 0], t, life: 1.3 });
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t } = e;
    if (e.mouse) for (let i = 0; i < 2; i++) {
      const a = t * 5 + i * Math.PI, ex = Math.cos(a) * 14, ey = Math.sin(a) * 5, ang = i ? 0.9 : -0.9;
      ctx.fillStyle = "rgba(229,229,229,.85)"; ctx.beginPath();
      ctx.arc(e.mx + ex * Math.cos(ang) - ey * Math.sin(ang), e.my + ex * Math.sin(ang) + ey * Math.cos(ang), 2, 0, TAU); ctx.fill();
    }
    s.pops = particles(s.pops, t, (q: any, a) => {
      const y = q.y - (1 - a) * 30;
      ctx.globalAlpha = a; ctx.strokeStyle = "#cfcfcf"; ctx.lineWidth = 1.2; ctx.strokeRect(q.x - 15, y - 15, 30, 30);
      ctx.fillStyle = "#e5e5e5"; ctx.font = "600 14px Bahnschrift, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(q.s, q.x, y + 1);
      ctx.textAlign = "left";
    });
    ctx.globalAlpha = 1;
  },
};

export const COFFEE = { blob, emc2, element };
