// Котики: Рамен, Дерзкий, Фокус, MEH, Коробка, Формулы, Overthinking.

import { TAU, clamp, rng, hash2, fbm, rgba, newClick, sideZone, sig, health, look, handLine, pawPrint, particles, notchBox, type Scene } from "./scenekit";

const isDown = () => { const h = health(); return h === "down" || h === "engine_off"; };

// ─── Рамен: печатный постер — кот ест лапшу, стол с закусками ─────

function paperGrain(w: number, h: number, base: string, seed: number) {
  const c = document.createElement("canvas"); c.width = Math.ceil(w); c.height = Math.ceil(h);
  const g = c.getContext("2d")!, r = rng(seed);
  g.fillStyle = base; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < (c.width * c.height) / 5; i++) { g.fillStyle = `rgba(90,60,30,${(r() * 0.09).toFixed(3)})`; g.fillRect(r() * c.width, r() * c.height, 1, 1); }
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(120,80,40,${(r() * 0.05).toFixed(3)})`; g.beginPath(); g.arc(r() * c.width, r() * c.height, 4 + r() * 20, 0, TAU); g.fill(); }
  return c;
}

const ramen: Scene = {
  fps: 20, scale: 1, protect: 0.15,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 62, 100) : sideZone({ w, h });
    const pw = z.w, ph = Math.min(z.h, pw * 1.62);
    const r = rng(241);
    return { z, small, pw, ph, paper: paperGrain(pw, ph, "#efe1c4", 243), r, steam: [] as any[], slurp: -9, pop: -9, paw: 6, eaten: [false, false, false], noodles: [] as any[], wisps: Array.from({ length: small ? 0 : 6 }, () => ({ x: r() * w, ph: r() * TAU })) };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e, z = s.z, pw = s.pw, ph = s.ph, k = pw / 276;
    const px0 = z.x, py0 = s.small ? z.y : z.y + 2;
    const X = (u: number) => px0 + u * pw, Y = (v: number) => py0 + v * ph;
    if (!s.small) {
      // Окно: тёплый пар снизу и красная печать в углу.
      for (const q of s.wisps) { ctx.strokeStyle = "rgba(239,225,196,.05)"; ctx.lineWidth = 2; ctx.beginPath(); for (let i = 0; i <= 20; i++) { const y = h - i * 12, x = q.x + Math.sin(i * 0.5 + t * 0.8 + q.ph) * 14; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
      ctx.save(); ctx.translate(w - 62, h - 66); ctx.rotate(-0.06);
      ctx.fillStyle = "rgba(200,40,30,.8)"; ctx.fillRect(0, 0, 40, 40);
      ctx.fillStyle = "#efe1c4"; ctx.font = "bold 13px 'Yu Gothic', 'MS Gothic'"; ctx.textBaseline = "top"; ctx.fillText("ワイ", 6, 4); ctx.fillText("ピー", 6, 20);
      ctx.restore();
    }
    if (!s.small && z.h - ph > 120) {
      const my = py0 + ph + 14, mh = Math.min(z.h - ph - 18, 170);
      ctx.drawImage(s.paper, 0, 0, pw, mh, px0, my, pw, mh);
      ctx.fillStyle = "#c8442d"; ctx.fillRect(px0, my, pw, 24);
      ctx.fillStyle = "#efe1c4"; ctx.font = `700 13px "Yu Gothic", "Segoe UI", sans-serif`; ctx.textBaseline = "middle";
      ctx.fillText("お品書き · меню", px0 + 10, my + 12);
      const kb = sig.rate / 1024, down = isDown();
      const items: [string, string][] = [["醤油ラーメン · шоё", down ? "нет" : `${sig.ms ?? "…"} мс`], ["餃子 · гёдза", kb > 1024 ? `${(kb / 1024).toFixed(1)} МБ/с` : `${kb.toFixed(0)} КБ/с`], ["卵 · тамаго", down ? "—" : "✓"], ["お茶 · чай", "бесплатно"]];
      ctx.font = `600 12px "Yu Gothic UI", "Segoe UI", sans-serif`;
      items.forEach(([n, v], i) => {
        const y = my + 40 + i * 24;
        if (y > my + mh - 10) return;
        ctx.fillStyle = "#2a1d12"; ctx.fillText(n, px0 + 10, y);
        const vw = ctx.measureText(v).width; ctx.fillStyle = "#c8442d"; ctx.fillText(v, px0 + pw - 10 - vw, y);
        ctx.fillStyle = "rgba(42,29,18,.35)"; const nw = ctx.measureText(n).width;
        for (let x = px0 + 16 + nw; x < px0 + pw - 16 - vw; x += 5) ctx.fillRect(x, y + 3, 1.5, 1.5);
      });
      ctx.fillStyle = "rgba(42,29,18,.5)"; ctx.font = `italic 400 10.5px "Segoe UI", sans-serif`;
      if (my + 40 + 4 * 24 < my + mh) ctx.fillText("цены — по пингу, без чаевых", px0 + 10, my + 40 + 4 * 24);
    }
    ctx.drawImage(s.paper, px0, py0, pw, ph);
    ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, pw, ph); ctx.clip();
    const RED = "#d94f2b", INK = "#141114";
    // Надпись, солнце с чёрными лучами, красная вывеска справа.
    ctx.fillStyle = RED; ctx.textBaseline = "top"; ctx.font = `900 ${pw * 0.2}px "Yu Gothic", "MS Gothic", sans-serif`;
    ctx.fillText("ラー", X(0.03), Y(0.015)); ctx.fillText("メン", X(0.03), Y(0.15));
    const sx = X(0.7), sy = Y(0.08), sr = pw * 0.07;
    ctx.strokeStyle = INK; ctx.lineWidth = 1.4 * k;
    for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU + t * 0.08; ctx.beginPath(); ctx.moveTo(sx + Math.cos(a) * sr * 1.35, sy + Math.sin(a) * sr * 1.35); ctx.lineTo(sx + Math.cos(a) * sr * 1.85, sy + Math.sin(a) * sr * 1.85); ctx.stroke(); }
    ctx.fillStyle = "#ec7b3c"; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill();
    ctx.fillStyle = "#c8442d"; ctx.fillRect(X(0.88), Y(0.02), pw * 0.12, ph * 0.26);
    ctx.strokeStyle = "#efe1c4"; ctx.lineWidth = 1; ctx.strokeRect(X(0.895), Y(0.03), pw * 0.09, ph * 0.24);
    ctx.fillStyle = "#efe1c4"; ctx.font = `700 ${pw * 0.06}px "Yu Gothic", "MS Gothic", sans-serif`;
    ["麺", "屋", "猫"].forEach((c, i) => ctx.fillText(c, X(0.91), Y(0.045) + i * pw * 0.075));
    // Стол: бирюзовая скатерть.
    ctx.fillStyle = "#8fb3a4"; ctx.fillRect(X(0), Y(0.76), pw, ph * 0.24);
    ctx.strokeStyle = "rgba(40,70,60,.25)"; ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) { ctx.beginPath(); ctx.moveTo(X(i * 0.16 - 0.1), Y(1)); ctx.lineTo(X(i * 0.16 + 0.1), Y(0.76)); ctx.stroke(); }
    // Кот: тело, голова, уши; глаза следят за курсором; румянец, усы.
    const hx = X(0.58), hy = Y(0.38), hr = pw * 0.15;
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.ellipse(hx + pw * 0.02, Y(0.66), pw * 0.3, ph * 0.22, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hx, hy, hr * 1.12, hr, 0, 0, TAU); ctx.fill();
    const twitch = hash2(Math.floor(t * 0.5), 1) < 0.2 ? Math.sin(t * 30) * 0.05 : 0;
    for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(hx + d * hr * 0.98, hy - hr * 0.2); ctx.lineTo(hx + d * hr * (0.82 + (d > 0 ? twitch : 0)), hy - hr * 1.32); ctx.lineTo(hx + d * hr * 0.2, hy - hr * 0.86); ctx.fill(); }
    const [lx, ly] = look(e, hx, hy, 220, [-0.6, 0.5]);
    for (const d of [-1, 1]) {
      const ex = hx + d * hr * 0.45, ey = hy - hr * 0.08, er = hr * 0.27;
      ctx.fillStyle = "#f6ecd8"; ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.fill();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(ex + lx * er * 0.35, ey + ly * er * 0.35, er * 0.62, 0, TAU); ctx.fill();
      ctx.fillStyle = "#e35d4f"; ctx.beginPath(); ctx.ellipse(hx + d * hr * 0.72, hy + hr * 0.4, hr * 0.15, hr * 0.09, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(246,236,216,.6)"; ctx.lineWidth = 0.8;
      for (const a of [-0.12, 0.05]) { ctx.beginPath(); ctx.moveTo(hx + d * hr * 0.8, hy + hr * 0.25); ctx.lineTo(hx + d * hr * 1.45, hy + hr * (0.18 + a * 2)); ctx.stroke(); }
    }
    // Миска: красный край, бульон, яйца, нарутомаки, чашу, зелень; волна по боку.
    const bx = X(0.44), by = Y(0.64), bw = pw * 0.33, bh = ph * 0.035;
    ctx.fillStyle = "#f3e7d0"; ctx.beginPath(); ctx.moveTo(bx - bw, by); ctx.bezierCurveTo(bx - bw, by + ph * 0.16, bx + bw, by + ph * 0.16, bx + bw, by); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#3b6aa0"; ctx.lineWidth = 1.3 * k;
    ctx.beginPath(); for (let i = 0; i < 10; i++) { const x = bx - bw * 0.85 + i * bw * 0.19; ctx.moveTo(x, by + ph * 0.045); ctx.quadraticCurveTo(x + bw * 0.05, by + ph * 0.025, x + bw * 0.1, by + ph * 0.045); } ctx.stroke();
    ctx.fillStyle = "#c8442d"; ctx.fillRect(bx - bw * 0.5, by + ph * 0.105, bw, ph * 0.012);
    ctx.fillStyle = "#c8442d"; ctx.beginPath(); ctx.ellipse(bx, by, bw * 1.02, bh * 1.25, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#e8b878"; ctx.beginPath(); ctx.ellipse(bx, by, bw * 0.92, bh, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(255,240,210,.8)"; ctx.lineWidth = 0.9;
    for (let i = 0; i < 14; i++) { ctx.beginPath(); ctx.ellipse(bx + (hash2(i, 3) - 0.5) * bw * 1.2, by + (hash2(i, 4) - 0.5) * bh, bw * 0.2, bh * 0.4, 0, 0, Math.PI); ctx.stroke(); }
    ctx.fillStyle = "#4f8a3b"; for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse(bx - bw * 0.65 + i * bw * 0.08, by + bh * 0.2, bw * 0.08, bh * 0.35, 0.5, 0, TAU); ctx.fill(); }
    ctx.fillStyle = "#b9785a"; ctx.beginPath(); ctx.ellipse(bx + bw * 0.55, by - bh * 0.1, bw * 0.2, bh * 0.55, 0.2, 0, TAU); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(bx + bw * 0.15, by + bh * 0.1, bh * 0.75, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#e86f9a"; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let a = 0; a < 9; a += 0.3) ctx.lineTo(bx + bw * 0.15 + Math.cos(a) * a * bh * 0.07, by + bh * 0.1 + Math.sin(a) * a * bh * 0.07); ctx.stroke();
    const eggs = [[-0.35, -0.1], [0.62, 0.35]];
    eggs.forEach(([u, v], i) => { if (s.eaten[i]) return; const x = bx + u * bw, y = by + v * bh; ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(x, y, bw * 0.17, bh * 0.6, 0, 0, TAU); ctx.fill(); ctx.fillStyle = "#f29a1c"; ctx.beginPath(); ctx.arc(x, y, bh * 0.38, 0, TAU); ctx.fill(); });
    // Лапа с палочками, лапша тянется ко рту; щелчок — «ズズッ».
    const sl = t - s.slurp < 0.8 ? Math.sin(((t - s.slurp) / 0.8) * Math.PI) : 0;
    const lift = (Math.sin(t * 1.3) * 0.5 + 0.5) * ph * 0.02 + sl * ph * 0.06;
    const tipX = hx - hr * 0.55, tipY = hy + hr * 0.75 - lift;
    ctx.strokeStyle = "#ead3a3"; ctx.lineWidth = 1.5 * k;
    for (let i = 0; i < 7; i++) { const x = bx - bw * 0.2 + i * bw * 0.05; ctx.beginPath(); ctx.moveTo(x, by); ctx.bezierCurveTo(x - bw * 0.05, by - ph * 0.05, tipX - bw * 0.06 + i * bw * 0.02, tipY + ph * 0.06, tipX - bw * 0.04 + i * bw * 0.015, tipY); ctx.stroke(); }
    ctx.strokeStyle = "#d9893b"; ctx.lineWidth = 3 * k; ctx.lineCap = "round";
    for (const d of [0, 1]) { ctx.beginPath(); ctx.moveTo(X(0.06), Y(0.34) - lift * 0.3 + d * 5 * k); ctx.lineTo(tipX + bw * 0.04, tipY - 2 * k + d * 3 * k); ctx.stroke(); }
    ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(X(0.3), Y(0.4) - lift * 0.4, pw * 0.065, pw * 0.055, -0.4, 0, TAU); ctx.fill();
    // Банка слева, бутылка справа, закуски на столе: зелень и гёдза.
    ctx.fillStyle = "#3c3f3a"; ctx.beginPath(); ctx.roundRect(X(0.02), Y(0.55), pw * 0.13, ph * 0.21, 4 * k); ctx.fill();
    ctx.fillStyle = "#8a4b33"; ctx.beginPath(); ctx.roundRect(X(0.025), Y(0.53), pw * 0.12, ph * 0.03, 3 * k); ctx.fill();
    ctx.fillStyle = "rgba(239,225,196,.4)"; for (let i = 0; i < 12; i++) ctx.fillRect(X(0.03 + hash2(i, 9) * 0.1), Y(0.6 + hash2(i, 8) * 0.14), 2, 1);
    ctx.fillStyle = "#c79a68"; ctx.beginPath(); ctx.roundRect(X(0.86), Y(0.5), pw * 0.12, ph * 0.27, 5 * k); ctx.fill();
    ctx.fillStyle = "#a3291c"; ctx.fillRect(X(0.86), Y(0.6), pw * 0.12, ph * 0.08);
    ctx.fillStyle = "#efe1c4"; ctx.fillRect(X(0.875), Y(0.62), pw * 0.09, ph * 0.04);
    ctx.fillStyle = "#8a5a3c"; ctx.beginPath(); ctx.ellipse(X(0.17), Y(0.92), pw * 0.15, ph * 0.05, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#5f9a46"; for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.ellipse(X(0.09 + i * 0.025), Y(0.9 + hash2(i, 2) * 0.02), pw * 0.025, ph * 0.012, i, 0, TAU); ctx.fill(); }
    ctx.fillStyle = "#d8c7a6"; ctx.beginPath(); ctx.ellipse(X(0.72), Y(0.93), pw * 0.22, ph * 0.055, 0, 0, TAU); ctx.fill();
    [0.62, 0.72, 0.82].forEach((u, i) => { if (s.eaten[2] && i === 1) return; ctx.fillStyle = "#e9c48e"; ctx.beginPath(); ctx.ellipse(X(u), Y(0.925), pw * 0.05, ph * 0.022, 0.2, Math.PI, 0); ctx.fill(); ctx.strokeStyle = "#b07a3a"; ctx.lineWidth = 1; ctx.stroke(); });
    // Вторая кошачья лапа иногда тянется за яйцом.
    s.paw -= dt;
    if (s.paw < -3) s.paw = 8 + s.r() * 8;
    const pu = s.paw < 0 ? Math.sin((-s.paw / 3) * Math.PI) : 0;
    if (pu > 0) {
      ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(X(1.05 - pu * 0.25), Y(0.6), pw * 0.12, pw * 0.05, -0.2, 0, TAU); ctx.fill();
      if (pu > 0.95 && !s.eaten[1]) s.eaten[1] = true;
    }
    if (s.eaten.every(Boolean) || (s.eaten[1] && s.paw > 7)) s.eaten = [false, false, false];
    // Пар над миской тянется к курсору.
    if (s.r() < 0.3 && s.steam.length < 26) s.steam.push({ x: bx + (s.r() - 0.5) * bw, y: by - bh, t, ph: s.r() * TAU });
    s.steam = s.steam.filter((q: any) => t - q.t < 2.4);
    for (const q of s.steam) {
      const a = (t - q.t) / 2.4;
      q.y -= ph * 0.05 * dt; q.x += (Math.sin(t * 2 + q.ph) * 6 + (e.mouse ? clamp((e.mx - q.x) * 0.05, -8, 8) : 0)) * dt;
      ctx.strokeStyle = rgba(255, 255, 255, 0.55 * (1 - a)); ctx.lineWidth = 1.4 * k;
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.bezierCurveTo(q.x + 6 * k, q.y - 5 * k, q.x - 6 * k, q.y - 10 * k, q.x, q.y - 16 * k); ctx.stroke();
    }
    const clk = newClick(s, e) ? e.click! : null;
    if (clk) {
      if (Math.abs(clk.x - X(0.72)) < pw * 0.2 && Math.abs(clk.y - Y(0.93)) < ph * 0.06) s.eaten[2] = true;
      else s.slurp = t;
      s.pop = t;
    }
    if (t - s.pop < 0.9 && !s.small) {
      const a = 1 - (t - s.pop) / 0.9;
      ctx.fillStyle = rgba(217, 79, 43, a); ctx.font = `900 ${pw * 0.08}px "Yu Gothic", sans-serif`;
      ctx.fillText(s.eaten[2] ? "パクッ" : "ズズッ", X(0.3), Y(0.24) - (1 - a) * 12);
    }
    ctx.restore();
  },
  fx(ctx, s, e) {
    if (s.small) return;
    // След курсора — лапша: волнистые бежевые нити.
    const tr = e.trail;
    if (tr.length < 3) return;
    ctx.lineCap = "round";
    for (let j = 0; j < 3; j++) {
      ctx.strokeStyle = rgba(234, 211, 163, 0.5 - j * 0.12); ctx.lineWidth = 1.6;
      ctx.beginPath();
      tr.forEach(([x, y, a], i) => { const k = 1 - a; const yy = y + Math.sin(i * 0.6 + j * 2 + e.t * 3) * 4 * k + (j - 1) * 3; i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); });
      ctx.stroke();
    }
  },
};

// ─── Дерзкий: облака, кот снизу смотрит вверх, лапа «стоп» ─────────

function sassyClouds(w: number, h: number) {
  const cw = Math.ceil(w / 3), ch = Math.ceil(h / 3), c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const g = c.getContext("2d")!, img = g.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = fbm(x * 0.03, y * 0.045, 5), q = v > 0.64 ? 1 : v > 0.55 ? 0.78 : v > 0.47 ? 0.56 : v > 0.4 ? 0.4 : 0.28, i = (y * cw + x) * 4;
    img.data[i] = 150 * q + 40; img.data[i + 1] = 160 * q + 45; img.data[i + 2] = 190 * q + 55; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
/** Слово кистью: штрихи с рваными краями и потёками; буква «I» — отпечаток лапы. */
function brushWord(ctx: CanvasRenderingContext2D, word: string, x: number, y: number, fs: number, t: number, seed: number) {
  ctx.font = `italic 900 ${fs}px Impact, "Segoe UI Black", sans-serif`; ctx.textBaseline = "top";
  let cx = x;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i], cw = ctx.measureText(ch).width;
    if (ch === "I") { ctx.fillStyle = "#0b0b0e"; ctx.beginPath(); ctx.arc(cx + fs * 0.22, y + fs * 0.55, fs * 0.28, 0, TAU); ctx.fill(); ctx.fillStyle = "#f0a6b8"; pawPrint(ctx, cx + fs * 0.22, y + fs * 0.56, fs * 0.2); cx += fs * 0.5; continue; }
    ctx.fillStyle = "#0b0b0e";
    ctx.save(); ctx.translate(cx, y + Math.sin(i + seed) * 2); ctx.rotate(-0.05 + (hash2(i, seed) - 0.5) * 0.06); ctx.fillText(ch, 0, 0); ctx.restore();
    // Рваные щетинки по краям буквы и потёк вниз.
    for (let j = 0; j < 3; j++) { const bx = cx + hash2(i * 7 + j, seed) * cw; ctx.fillRect(bx, y - 2 - hash2(j, i + seed) * 5, 1.4, 4); }
    if (hash2(i, seed + 5) < 0.6) { const dx = cx + cw * (0.3 + hash2(i, seed + 9) * 0.4), len = fs * (0.2 + hash2(seed, i) * 0.5) + Math.sin(t * 0.8 + i) * 2; ctx.fillRect(dx, y + fs * 0.9, 2, len); ctx.beginPath(); ctx.arc(dx + 1, y + fs * 0.9 + len, 2.2, 0, TAU); ctx.fill(); }
    cx += cw + 1;
  }
}

const sassy: Scene = {
  fps: 20, scale: 1, protect: 0.25,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 70, 90) : sideZone({ w, h });
    return { z, small, clouds: sassyClouds(w, h), r: rng(251), paws: [] as any[], wave: -9, blink: 3, rib: 0 };
  },
  draw(ctx, s, e) {
    const { t, w, h } = e, z = s.z;
    const off = (t * 4) % w;
    ctx.globalAlpha = s.small ? 0.55 : 0.32;
    ctx.drawImage(s.clouds, -off, 0, w, h); ctx.drawImage(s.clouds, w - off, 0, w, h);
    ctx.globalAlpha = 1;
    if (!s.small) {
      // В колонке облака ярче, надпись кистью.
      ctx.save(); ctx.beginPath(); ctx.roundRect(z.x, z.y, z.w, z.h, 16); ctx.clip();
      ctx.globalAlpha = 0.95; ctx.drawImage(s.clouds, z.x - off * 0.5, z.y - 20, w * 1.1, h * 1.1); ctx.drawImage(s.clouds, z.x - off * 0.5 + w * 1.1, z.y - 20, w * 1.1, h * 1.1); ctx.globalAlpha = 1;
      const fs = clamp(z.w / 5.4, 28, 48);
      brushWord(ctx, "WHAT", z.x + 14, z.y + 18, fs, t, 1);
      brushWord(ctx, "THE", z.x + 30, z.y + 18 + fs * 1.05, fs, t, 2);
      brushWord(ctx, "PING?!", z.x + 10, z.y + 18 + fs * 2.1, fs, t, 3);
    }
    const box = s.small ? z : { x: z.x, y: z.y + z.h * 0.42, w: z.w, h: z.h * 0.58 };
    if (!s.small) {
      // Второй кот выглядывает справа, смотрит свысока; его хвост — лента кистью вверх.
      const qs = clamp(z.w / 140, 1.2, 1.9), qx = z.x + z.w + 2, qy = z.y + z.h * 0.47;
      const fs = clamp(z.w / 5.4, 28, 48), top = z.y + 18 + fs * 3.3;
      ctx.strokeStyle = "#0b0b0e"; ctx.lineCap = "round";
      let px = qx - 8 * qs, py = qy - 20 * qs;
      for (let i = 1; i <= 28; i++) {
        const u = i / 28, x = qx - 8 * qs - u * z.w * 0.42 + Math.sin(u * 7 + t * 1.1) * 16 * (0.4 + u), y = qy - 20 * qs - u * (qy - 20 * qs - top);
        ctx.lineWidth = 16 * (1 - u) + 2; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke(); px = x; py = y;
      }
      ctx.save(); ctx.translate(qx, qy); ctx.scale(qs, qs);
      ctx.fillStyle = "#0b0b0e";
      ctx.beginPath(); ctx.moveTo(8, -36); ctx.quadraticCurveTo(-46, -18, -42, 18); ctx.lineTo(-28, 32); ctx.lineTo(8, 50); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-36, -8); ctx.lineTo(-33, -42); ctx.lineTo(-18, -24); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-16, -28); ctx.lineTo(-6, -50); ctx.lineTo(2, -30); ctx.fill();
      ctx.fillStyle = "#4a3a36"; ctx.beginPath(); ctx.moveTo(-33, -14); ctx.lineTo(-31, -36); ctx.lineTo(-22, -24); ctx.fill();
      const lid = Math.sin(t * 0.5) > 0.9 ? 0.2 : 1;
      ctx.fillStyle = "#c9a227"; ctx.beginPath(); ctx.ellipse(-26, 0, 5, 2.6 * lid, -0.15, 0, TAU); ctx.fill();
      ctx.fillStyle = "#050506"; ctx.fillRect(-27, -2.2 * lid, 2, 4.4 * lid);
      ctx.strokeStyle = "rgba(170,190,235,.4)"; ctx.lineWidth = 0.6;
      for (const a of [-0.05, 0.08]) { ctx.beginPath(); ctx.moveTo(-36, 12); ctx.lineTo(-60, 10 + a * 60); ctx.stroke(); }
      ctx.restore();
    }
    // Главный кот снизу: голова запрокинута, глаза к курсору, язык, белое пятно, лапа «стоп».
    const R = s.small ? box.w * 0.45 : Math.min(box.w * 0.4, box.h * 0.36);
    const cx = box.x + box.w * 0.44, cy = box.y + box.h - R * 1.25;
    const BLK = "#0c0c10", RIM = "rgba(170,190,235,.38)";
    ctx.fillStyle = BLK;
    ctx.beginPath(); ctx.ellipse(cx + R * 0.1, cy + R * 1.5, R * 1.45, R * 1.1, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.12, R * 0.92, -0.12, 0, TAU); ctx.fill();
    for (const [ex0, ey0, tx, ty] of [[-0.95, -0.15, -1.05, -1.15], [0.55, -0.72, 0.95, -1.35]]) {
      ctx.fillStyle = BLK; ctx.beginPath(); ctx.moveTo(cx + ex0 * R, cy + ey0 * R); ctx.lineTo(cx + tx * R, cy + ty * R); ctx.lineTo(cx + (ex0 + tx) * 0.5 * R + R * 0.45, cy + ey0 * R - R * 0.2); ctx.fill();
      ctx.fillStyle = "#4a3a36"; ctx.beginPath(); ctx.moveTo(cx + ex0 * R * 0.95, cy + ey0 * R - R * 0.05); ctx.lineTo(cx + tx * R * 0.92, cy + ty * R * 0.85); ctx.lineTo(cx + (ex0 + tx) * 0.5 * R + R * 0.3, cy + ey0 * R - R * 0.2); ctx.fill();
    }
    // Шерсть: короткие штрихи по контуру, холодный отсвет неба сверху.
    ctx.lineWidth = 1;
    for (let a = -Math.PI; a < 0; a += 0.07) {
      const x = cx + Math.cos(a) * R * 1.12, y = cy + Math.sin(a) * R * 0.92, n = hash2(Math.floor(a * 100), 7);
      ctx.strokeStyle = RIM; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * (2 + n * 4), y + Math.sin(a) * (2 + n * 4)); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(60,64,80,.55)";
    for (let i = 0; i < 26; i++) { const x = cx + (hash2(i, 1) - 0.5) * R * 1.8, y = cy + (hash2(i, 2) - 0.2) * R * 0.9; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 2, y + 4); ctx.stroke(); }
    if (t > s.blink) s.blink = t + 2.5 + s.r() * 4;
    const [lx, ly] = look(e, cx, cy - R, 260, [0.2, -0.9]);
    for (const [u, v] of [[-0.48, -0.3], [0.38, -0.46]]) {
      const ex = cx + u * R, ey = cy + v * R, er = R * 0.24;
      if (s.blink - t < 0.12) { ctx.strokeStyle = "#d6d36a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ex - er, ey); ctx.lineTo(ex + er, ey); ctx.stroke(); continue; }
      const g = ctx.createRadialGradient(ex, ey, er * 0.2, ex, ey, er);
      g.addColorStop(0, "#f0ec9a"); g.addColorStop(1, "#b9b04a");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.fill();
      ctx.strokeStyle = "#1a1a10"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = "#050506"; ctx.beginPath(); ctx.arc(ex + lx * er * 0.35, ey + ly * er * 0.35, er * 0.55, 0, TAU); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(ex + lx * er * 0.35 - er * 0.2, ey + ly * er * 0.35 - er * 0.22, er * 0.14, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = "#26262c"; ctx.beginPath(); ctx.moveTo(cx - R * 0.08, cy - R * 0.12); ctx.lineTo(cx + R * 0.1, cy - R * 0.16); ctx.lineTo(cx + R * 0.02, cy - R * 0.02); ctx.fill();
    const wig = Math.sin(t * 5) * R * 0.03;
    ctx.fillStyle = "#e88aa0"; ctx.beginPath(); ctx.ellipse(cx + wig, cy + R * 0.3, R * 0.17, R * 0.2, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#b85a72"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cx + wig, cy + R * 0.16); ctx.lineTo(cx + wig, cy + R * 0.38); ctx.stroke();
    ctx.strokeStyle = "rgba(240,240,250,.75)"; ctx.lineWidth = 0.8;
    for (const d of [-1, 1]) for (const a of [-0.1, 0.06, 0.2]) { ctx.beginPath(); ctx.moveTo(cx + d * R * 0.25, cy + R * 0.05); ctx.quadraticCurveTo(cx + d * R * 0.8, cy + R * (a - 0.05), cx + d * R * 1.3, cy + R * (a + 0.08)); ctx.stroke(); }
    ctx.fillStyle = "#f2f2f2"; ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU, rr = i % 2 ? R * 0.1 : R * 0.26; ctx.lineTo(cx + R * 0.05 + Math.cos(a) * rr, cy + R * 1.35 + Math.sin(a) * rr * 1.2); }
    ctx.fill();
    // Лапа «стоп»: подушечки к зрителю, щелчок — машет.
    const wv = t - s.wave < 1 ? Math.sin((t - s.wave) * 14) * 0.25 : Math.sin(t * 0.8) * 0.04;
    ctx.save(); ctx.translate(cx + R * 1.05, cy + R * 1.4); ctx.rotate(0.15 + wv);
    ctx.fillStyle = BLK; ctx.beginPath(); ctx.roundRect(-R * 0.22, -R * 1.2, R * 0.44, R * 1.3, R * 0.2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -R * 1.25, R * 0.33, R * 0.3, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#f0a6b8"; pawPrint(ctx, 0, -R * 1.25, R * 0.26);
    ctx.restore();
    if (newClick(s, e)) { s.wave = t; s.paws.push({ x: e.click!.x, y: e.click!.y, t, life: 3, a: (s.r() - 0.5) * 0.8 }); }
  },
  fx(ctx, s, e) {
    s.paws = particles(s.paws, e.t, (q: any, a) => {
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.a); ctx.globalAlpha = Math.min(1, a * 2);
      ctx.fillStyle = "#f0a6b8"; pawPrint(ctx, 0, 0, 11); ctx.restore();
    });
    if (s.small) return;
    // Лапки за курсором — по шагу, левая-правая.
    for (let i = 6; i < e.trail.length; i += 8) {
      const [x, y, a] = e.trail[i], [px, py] = e.trail[i - 6], k = 1 - a / 1.2;
      if (k <= 0) continue;
      const ang = Math.atan2(y - py, x - px) + Math.PI / 2, side = (i / 8) % 2 ? 6 : -6;
      ctx.save(); ctx.translate(x + Math.cos(ang - Math.PI / 2) * 0 + Math.cos(ang) * side, y + Math.sin(ang) * side); ctx.rotate(ang);
      ctx.globalAlpha = k * 0.6; ctx.fillStyle = "#0b0b0e"; pawPrint(ctx, 0, 0, 6); ctx.restore();
    }
    ctx.globalAlpha = 1;
  },
};

// ─── Фокус: бордо, свет сверху, помодоро, план; кот выглядывает ────

const PLAN: [string, () => boolean][] = [["connect.", () => !isDown()], ["no distractions.", () => true], ["ship it.", () => false]];

const focus: Scene = {
  fps: 24, scale: 1, protect: 0.1,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 80, 50) : sideZone({ w, h });
    const r = rng(257);
    const grain = document.createElement("canvas"); grain.width = 128; grain.height = 128;
    const g = grain.getContext("2d")!;
    for (let i = 0; i < 2600; i++) { g.fillStyle = r() < 0.5 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.12)"; g.fillRect(r() * 128, r() * 128, 1, 1); }
    return { z, small, r, grain, rise: 0.4, idle: 0, lx: -1, ly: -1, blink: -1, nextBlink: 2, calm: 1, t0: 0, motes: Array.from({ length: small ? 0 : 26 }, () => ({ x: r(), y: r(), v: 0.004 + r() * 0.01, ph: r() * TAU })) };
  },
  draw(ctx, s, e) {
    const { t, dt, w, h } = e, z = s.z;
    const moved = e.mouse && Math.hypot(e.mx - s.lx, e.my - s.ly) > 6;
    const speed = e.mouse ? Math.hypot(e.mx - s.lx, e.my - s.ly) / Math.max(dt, 0.016) : 0;
    s.lx = e.mx; s.ly = e.my;
    s.idle = moved ? 0 : s.idle + dt;
    // Сосредоточенность: падает от резких движений мыши, восстанавливается в тишине.
    s.calm = clamp(s.calm + (speed > 900 ? -dt * 2.5 : dt * 0.35), 0, 1);
    if (!s.small) {
      // Свет сверху и пылинки в нём; зерно плёнки.
      const lx = z.x + z.w / 2;
      const g = ctx.createRadialGradient(lx, z.y - 40, 10, lx, z.y + z.h * 0.3, z.h * 0.7);
      g.addColorStop(0, "rgba(255,190,150,.14)"); g.addColorStop(1, "rgba(255,190,150,0)");
      ctx.fillStyle = g; ctx.fillRect(z.x - 40, z.y - 60, z.w + 80, z.h + 60);
      for (const m of s.motes) {
        m.y -= m.v * dt; if (m.y < 0) m.y = 1;
        const x = z.x + m.x * z.w + Math.sin(t * 0.5 + m.ph) * 10, y = z.y + m.y * z.h * 0.8;
        ctx.fillStyle = rgba(255, 220, 190, 0.25 + 0.25 * Math.sin(t + m.ph)); ctx.fillRect(x, y, 1.5, 1.5);
      }
      ctx.globalAlpha = 0.6; ctx.fillStyle = ctx.createPattern(s.grain, "repeat")!;
      ctx.save(); ctx.translate((t * 37) % 128, (t * 53) % 128); ctx.fillRect(-128, -128, w + 256, h + 256); ctx.restore(); ctx.globalAlpha = 1;
      const blur = (1 - s.calm) * 6;
      ctx.filter = blur > 0.3 ? `blur(${blur.toFixed(1)}px)` : "none";
      const fs = clamp(z.w / 5.6, 30, 44);
      ctx.textBaseline = "top"; ctx.fillStyle = "#e9c8a8";
      ctx.font = `400 ${fs}px "Palatino Linotype", Georgia, serif`;
      ctx.fillText("FOCUS.", z.x + 8, z.y + z.h * 0.1);
      ctx.font = `italic ${fs * 0.36}px "Palatino Linotype", Georgia, serif`; ctx.fillStyle = "rgba(233,200,168,.75)";
      ctx.fillText("follow the plan, not the mood.", z.x + 10, z.y + z.h * 0.1 + fs * 1.15);
      ctx.filter = "none";
      // Помодоро: 25 минут работы, 5 — отдых; тонкое кольцо.
      const cyc = (t % 1800) / 60, work = cyc < 25, left = work ? 25 - cyc : 30 - cyc, frac = work ? cyc / 25 : (cyc - 25) / 5;
      const rx = z.x + z.w / 2, ry = z.y + z.h * 0.1 + fs * 2.9, rr = Math.min(z.w * 0.28, 58);
      ctx.strokeStyle = "rgba(233,200,168,.15)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(rx, ry, rr, 0, TAU); ctx.stroke();
      ctx.strokeStyle = "#e9c8a8"; ctx.beginPath(); ctx.arc(rx, ry, rr, -Math.PI / 2, -Math.PI / 2 + frac * TAU); ctx.stroke();
      const hx = rx + Math.cos(-Math.PI / 2 + frac * TAU) * rr, hy = ry + Math.sin(-Math.PI / 2 + frac * TAU) * rr;
      ctx.fillStyle = "#f3dcc4"; ctx.beginPath(); ctx.arc(hx, hy, 3, 0, TAU); ctx.fill();
      ctx.textAlign = "center"; ctx.fillStyle = "#f3dcc4"; ctx.font = `400 ${rr * 0.42}px "Palatino Linotype", Georgia, serif`;
      const mm = Math.floor(left), ss = Math.floor((left - mm) * 60);
      ctx.fillText(`${mm}:${String(ss).padStart(2, "0")}`, rx, ry - rr * 0.26);
      ctx.font = `italic ${rr * 0.2}px "Palatino Linotype", Georgia, serif`; ctx.fillStyle = "rgba(233,200,168,.6)";
      ctx.fillText(work ? "deep work" : "breathe", rx, ry + rr * 0.24); ctx.textAlign = "left";
      // План: строки зачёркиваются по делу.
      let py = ry + rr + 26;
      ctx.font = `italic ${Math.max(13, fs * 0.38)}px "Palatino Linotype", Georgia, serif`;
      PLAN.forEach(([txt, done], i) => {
        const ok = done(), lbl = `${["i", "ii", "iii"][i]}.  ${txt}`;
        ctx.fillStyle = ok ? "rgba(233,200,168,.45)" : "#e9c8a8"; ctx.fillText(lbl, z.x + 14, py);
        if (ok) ctx.fillRect(z.x + 14, py + fs * 0.22, ctx.measureText(lbl).width, 1);
        py += fs * 0.6;
      });
      // Шкала сосредоточенности.
      ctx.fillStyle = "rgba(233,200,168,.15)"; ctx.fillRect(z.x + 14, py + 6, z.w - 28, 2);
      ctx.fillStyle = "#e9c8a8"; ctx.fillRect(z.x + 14, py + 6, (z.w - 28) * s.calm, 2);
      ctx.font = `italic 11px "Palatino Linotype", Georgia, serif`; ctx.fillStyle = "rgba(233,200,168,.5)";
      ctx.fillText(s.calm > 0.8 ? "in the zone" : s.calm > 0.4 ? "drifting…" : "distracted", z.x + 14, py + 12);
    }
    // Кот прячется, когда курсор мечется, и выглядывает в тишине.
    const cx = s.small ? z.x + z.w / 2 : z.x + z.w / 2, R = s.small ? Math.min(z.h * 0.55, 30) : Math.min(z.w * 0.42, 90);
    const bottom = s.small ? z.y + z.h + 4 : h;
    const near = e.mouse && Math.hypot(e.mx - cx, e.my - bottom) < R * 2.4 && moved;
    const want = newClick(s, e) ? -0.3 : near || s.calm < 0.4 ? 0.12 : s.idle > 1.2 ? 1 : 0.55;
    s.rise += (want - s.rise) * (want < s.rise ? 0.25 : 0.03);
    const top = bottom - R * 0.95 * Math.max(0, s.rise);
    ctx.fillStyle = "#050102";
    ctx.beginPath(); ctx.ellipse(cx, top + R * 0.9, R, R * 0.9, 0, Math.PI, 0); ctx.lineTo(cx + R, bottom); ctx.lineTo(cx - R, bottom); ctx.closePath(); ctx.fill();
    for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + d * R * 0.97, top + R * 0.72); ctx.quadraticCurveTo(cx + d * R * 0.92, top + R * 0.1, cx + d * R * 0.76, top - R * 0.18); ctx.lineTo(cx + d * R * 0.3, top + R * 0.25); ctx.fill(); }
    ctx.strokeStyle = "rgba(5,1,2,.9)"; ctx.lineWidth = 1;
    for (let a = Math.PI; a < TAU; a += 0.05) { const x = cx + Math.cos(a) * R, y = top + R * 0.9 + Math.sin(a) * R * 0.9, n = 2 + hash2(Math.floor(a * 60), 3) * 4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * n, y + Math.sin(a) * n); ctx.stroke(); }
    ctx.strokeStyle = "rgba(120,40,40,.35)";
    for (let a = Math.PI * 1.15; a < Math.PI * 1.85; a += 0.09) { const x = cx + Math.cos(a) * R * 0.99, y = top + R * 0.9 + Math.sin(a) * R * 0.89; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 3, y + Math.sin(a) * 3); ctx.stroke(); }
    if (t > s.nextBlink) { s.blink = t; s.nextBlink = t + 2.5 + s.r() * 4; }
    const open = t - s.blink < 0.15 ? 0.1 : 1;
    const [lx, ly] = look(e, cx, top, 300, [0, -0.3]);
    for (const d of [-1, 1]) {
      const ex = cx + d * R * 0.4, ey = top + R * 0.64, er = R * 0.2;
      ctx.save(); ctx.translate(ex, ey); ctx.scale(1, open);
      ctx.strokeStyle = "rgba(233,200,168,.9)"; ctx.lineWidth = Math.max(1.2, R * 0.03); ctx.beginPath(); ctx.arc(0, 0, er, 0.15 * Math.PI, 0.85 * Math.PI + Math.PI); ctx.stroke();
      ctx.fillStyle = "#020001"; ctx.beginPath(); ctx.arc(lx * er * 0.3, ly * er * 0.3, er * 0.86, 0, TAU); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(lx * er * 0.3 + er * 0.22, ly * er * 0.3 - er * 0.32, er * 0.16, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(lx * er * 0.3 - er * 0.3, ly * er * 0.3 - er * 0.2, er * 0.06, 0, TAU); ctx.fill();
      ctx.restore();
    }
  },
};

// ─── MEH: кремовый призрак держит чёрного кота и кружку ─────────────

const meh: Scene = {
  fps: 24, scale: 1, protect: 0.1,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 64, 92) : sideZone({ w, h });
    const r = rng(449);
    return { z, small, r, blink: 2, cblink: 3, wave: -9, says: [] as any[], wisps: [] as any[], specks: Array.from({ length: 70 }, () => [r(), r(), r()]), stars: Array.from({ length: small ? 0 : 30 }, () => [r() * w, r() * h, r()]) };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, z = s.z, CR = "#efe6b8", K = "#050505";
    for (const [x, y, p] of s.stars) { ctx.fillStyle = rgba(239, 230, 184, 0.15 + 0.2 * Math.sin(t + p * 9)); ctx.fillRect(x, y, 1.4, 1.4); }
    const gw = s.small ? z.w * 0.8 : Math.min(z.w * 0.74, z.h * 0.45), gh = gw * 1.32;
    const bob = Math.sin(t * 1.4) * gw * 0.03;
    const gx = s.small ? z.x + z.w * 0.55 : z.x + z.w * 0.56, gy = (s.small ? z.y + z.h - gh * 0.95 : z.y + z.h - gh - gw * 0.3) + bob;
    const X = (u: number) => gx + (u - 0.5) * gw, Y = (v: number) => gy + v * gh;
    // Тело призрака: купол, волнистый низ; зерно.
    ctx.fillStyle = CR;
    ctx.beginPath(); ctx.moveTo(X(0), Y(0.92));
    ctx.lineTo(X(0), Y(0.36)); ctx.bezierCurveTo(X(0), Y(-0.04), X(1), Y(-0.04), X(1), Y(0.36)); ctx.lineTo(X(1), Y(0.95));
    for (let i = 1; i <= 4; i++) { const u = 1 - i * 0.25; ctx.quadraticCurveTo(X(u + 0.125), Y(1.02 + Math.sin(t * 3 + i) * 0.02), X(u), Y(0.94 + (i % 2) * 0.03)); }
    ctx.closePath(); ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = "rgba(90,80,40,.35)";
    for (const [u, v, q] of s.specks) ctx.fillRect(X(u), Y(v), q > 0.7 ? 2 : 1.2, q > 0.5 ? 2.5 : 1.2);
    ctx.restore();
    // Глаза «meh»: полузакрытые, ленивый взгляд к курсору; нос-галочка.
    if (t > s.blink) s.blink = t + 3 + s.r() * 4;
    const [lx] = look(e, X(0.5), Y(0.25), 400);
    const lid = s.blink - t < 0.2 ? 0.15 : 1;
    for (const u of [0.3, 0.7]) {
      const ex = X(u) + lx * gw * 0.02, ey = Y(0.24), ew = gw * 0.14;
      ctx.fillStyle = K; ctx.beginPath(); ctx.moveTo(ex - ew, ey); ctx.lineTo(ex + ew, ey); ctx.quadraticCurveTo(ex + ew * 0.8, ey + ew * 0.7 * lid, ex, ey + ew * 0.62 * lid); ctx.quadraticCurveTo(ex - ew * 0.8, ey + ew * 0.7 * lid, ex - ew, ey); ctx.fill();
    }
    ctx.strokeStyle = K; ctx.lineWidth = Math.max(1.5, gw * 0.025); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(X(0.46), Y(0.33)); ctx.lineTo(X(0.5), Y(0.3)); ctx.lineTo(X(0.54), Y(0.33)); ctx.stroke();
    // Кружка «MEH» с паром в левой руке.
    const mx = X(-0.22), my = Y(0.48), mw = gw * 0.26, mh = gw * 0.26;
    ctx.fillStyle = K; ctx.strokeStyle = CR; ctx.lineWidth = Math.max(1.2, gw * 0.018);
    ctx.beginPath(); ctx.roundRect(mx - mw / 2, my - mh / 2, mw, mh, 3); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(mx + mw / 2, my, mh * 0.24, -1.3, 1.3); ctx.stroke();
    ctx.fillStyle = CR; ctx.font = `700 ${mw * 0.3}px "Segoe UI", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("MEH", mx, my + 1); ctx.textAlign = "left";
    ctx.beginPath(); ctx.arc(mx - mw * 0.45, my, gw * 0.08, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(mx - mw * 0.2, my); ctx.lineTo(X(0.02), Y(0.45)); ctx.lineTo(X(0.02), Y(0.6)); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = CR; ctx.lineWidth = Math.max(1.2, gw * 0.015);
    ctx.beginPath();
    for (let i = 0; i <= 30; i++) { const u = i / 30, a = u * 9 + t * 2, rr = gw * 0.05 * (1 - u * 0.5); const x = mx + Math.cos(a) * rr + Math.sin(u * 4 + t) * gw * 0.02, y = my - mh * 0.65 - u * gw * 0.35; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    // Чёрный кот на руках: глаза-кольца следят за курсором, лапа машет.
    const cx = X(0.48), cy = Y(0.52), cr = gw * 0.2;
    const near = e.mouse && Math.hypot(e.mx - cx, e.my - cy) < 120;
    ctx.fillStyle = K; ctx.strokeStyle = CR; ctx.lineWidth = Math.max(1.2, gw * 0.014);
    ctx.beginPath(); ctx.roundRect(cx - cr * 0.62, cy + cr * 0.5, cr * 1.24, cr * 2.1, cr * 0.5); ctx.fill(); ctx.stroke();
    for (const d of [-0.32, 0.32]) { ctx.beginPath(); ctx.roundRect(cx + d * cr - cr * 0.2, cy + cr * 2.3, cr * 0.4, cr * 0.8, cr * 0.2); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.ellipse(cx, cy, cr, cr * 0.86, 0, 0, TAU); ctx.fill(); ctx.stroke();
    for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + d * cr * 0.9, cy - cr * 0.3); ctx.lineTo(cx + d * cr * 0.85, cy - cr * 1.25); ctx.lineTo(cx + d * cr * 0.25, cy - cr * 0.82); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = K; ctx.beginPath(); ctx.ellipse(cx, cy, cr * 0.95, cr * 0.8, 0, 0, TAU); ctx.fill();
    if (t > s.cblink) s.cblink = t + 2 + s.r() * 3;
    const [clx, cly] = look(e, cx, cy, 200);
    for (const d of [-1, 1]) {
      const ex = cx + d * cr * 0.42, ey = cy - cr * 0.05, er = cr * 0.27;
      if (s.cblink - t < 0.12) { ctx.beginPath(); ctx.moveTo(ex - er, ey); ctx.lineTo(ex + er, ey); ctx.stroke(); continue; }
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.stroke();
      ctx.fillStyle = CR; ctx.beginPath(); ctx.arc(ex + clx * er * 0.35, ey + cly * er * 0.35, er * 0.42, 0, TAU); ctx.fill();
      ctx.fillStyle = K; ctx.beginPath(); ctx.arc(ex + clx * er * 0.35, ey + cly * er * 0.35, er * 0.2, 0, TAU); ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(cx - cr * 0.1, cy + cr * 0.35); ctx.lineTo(cx, cy + cr * 0.27); ctx.lineTo(cx + cr * 0.1, cy + cr * 0.35); ctx.stroke();
    const wv = t - s.wave < 1 ? Math.sin((t - s.wave) * 14) * 0.3 : near ? Math.sin(t * 8) * 0.2 : 0;
    ctx.save(); ctx.translate(cx - cr * 0.85, cy + cr * 0.7); ctx.rotate(-0.5 + wv);
    ctx.fillStyle = K; ctx.beginPath(); ctx.roundRect(-cr * 0.18, -cr * 0.9, cr * 0.36, cr * 0.95, cr * 0.18); ctx.fill(); ctx.stroke();
    ctx.fillStyle = CR; for (const [u, v] of [[-0.08, -0.78], [0.08, -0.78], [0, -0.66]]) { ctx.beginPath(); ctx.arc(u * cr, v * cr, cr * 0.04, 0, TAU); ctx.fill(); }
    ctx.restore();
    // Рука призрака обнимает кота.
    ctx.fillStyle = CR; ctx.beginPath(); ctx.moveTo(X(1), Y(0.6)); ctx.quadraticCurveTo(X(0.6), Y(0.62), X(0.3), Y(0.82)); ctx.lineTo(X(0.36), Y(0.9)); ctx.quadraticCurveTo(X(0.66), Y(0.74), X(1), Y(0.74)); ctx.fill();
    ctx.fillStyle = "rgba(90,80,40,.45)"; for (const [u, v] of [[0.5, 0.75], [0.62, 0.7], [0.74, 0.69]]) { ctx.beginPath(); ctx.arc(X(u), Y(v), 1.5, 0, TAU); ctx.fill(); }
    // Следы движения сзади.
    ctx.fillStyle = CR;
    for (let i = 0; i < 6; i++) { const u = (t * 0.6 + i / 6) % 1; ctx.globalAlpha = 1 - u; ctx.beginPath(); ctx.ellipse(X(1.12 + u * 0.12), Y(0.62 + i * 0.07), 1.6, 3.5, 0, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
    if (newClick(s, e)) { s.wave = t; s.says.push({ x: X(0.5), y: Y(-0.08), txt: s.r() < 0.5 ? "meh." : "mrrp?", t, life: 1.6 }); }
    if (!s.small) {
      ctx.fillStyle = CR; ctx.textBaseline = "top";
      ctx.font = `400 ${clamp(z.w / 4.2, 34, 60)}px "Ink Free", "Segoe Print", cursive`; ctx.fillText("meh.", z.x + 6, z.y + 14);
      ctx.font = `400 15px "Ink Free", "Segoe Print", cursive`; ctx.fillStyle = "rgba(239,230,184,.6)";
      ctx.fillText(isDown() ? "даже интернет устал" : health() === "slow" ? "ну… грузится" : "кофе есть, кот есть", z.x + 8, z.y + 14 + clamp(z.w / 4.2, 34, 60) * 1.15);
    }
    s.says = particles(s.says, t, (q: any, a) => { ctx.globalAlpha = a; ctx.fillStyle = CR; ctx.font = `italic 600 ${s.small ? 10 : 18}px "Ink Free", "Segoe Print", cursive`; ctx.textAlign = "center"; ctx.fillText(q.txt, q.x, q.y - (1 - a) * 16); ctx.textAlign = "left"; });
    ctx.globalAlpha = 1;
    void dt;
  },
  fx(ctx, s, e) {
    if (s.small) return;
    for (let i = 0; i < e.trail.length; i += 2) {
      const [x, y, a] = e.trail[i], k = 1 - a / 1.2;
      if (k <= 0) continue;
      ctx.fillStyle = rgba(239, 230, 184, k * 0.12); ctx.beginPath(); ctx.arc(x + Math.sin(a * 9 + i) * 6 * (1 - k), y - (1 - k) * 18, 3 + 8 * (1 - k), 0, TAU); ctx.fill();
    }
  },
};

// ─── Коробка: открытая пачка, полная котов (светлая) ──────────────

const KITTY: [string, string, string][] = [["#9ca3af", "#f3f4f6", "grey"], ["#c9a66b", "#e8d4ad", "tabby"], ["#f5f5f4", "#e7c9a9", "white"], ["#f5f5f4", "#d08a4a", "calico"], ["#8b8f94", "#c4c7cb", "silver"], ["#efe5d2", "#6b5444", "siam"]];

function kitty(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: [string, string, string], awake: number, lookX: number, rot: number) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = c[0]; ctx.strokeStyle = "#1f1f1f"; ctx.lineWidth = Math.max(1, r * 0.08);
  for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(d * r * 0.85, -r * 0.2); ctx.lineTo(d * r * 0.78, -r * 1.05); ctx.lineTo(d * r * 0.2, -r * 0.7); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.82, 0, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = c[1];
  if (c[2] === "tabby" || c[2] === "silver") { ctx.strokeStyle = c[1]; ctx.lineWidth = r * 0.12; for (const u of [-0.3, 0, 0.3]) { ctx.beginPath(); ctx.moveTo(u * r, -r * 0.78); ctx.lineTo(u * r * 0.8, -r * 0.45); ctx.stroke(); } }
  else if (c[2] === "siam") { ctx.beginPath(); ctx.ellipse(0, r * 0.15, r * 0.55, r * 0.45, 0, 0, TAU); ctx.fill(); }
  else { ctx.beginPath(); ctx.ellipse(r * 0.35, -r * 0.35, r * 0.4, r * 0.32, 0.4, 0, TAU); ctx.fill(); }
  ctx.strokeStyle = "#1f1f1f"; ctx.fillStyle = "#1f1f1f"; ctx.lineWidth = Math.max(1, r * 0.08);
  for (const d of [-1, 1]) {
    const ex = d * r * 0.38 + lookX * r * 0.08, ey = 0;
    if (awake > 0.5) { ctx.beginPath(); ctx.arc(ex, ey, r * 0.1, 0, TAU); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(ex, ey - r * 0.05, r * 0.14, 0.2, Math.PI - 0.2); ctx.stroke(); }
  }
  ctx.beginPath(); ctx.moveTo(-r * 0.1, r * 0.25); ctx.quadraticCurveTo(0, r * 0.35, 0, r * 0.25); ctx.quadraticCurveTo(0, r * 0.35, r * 0.1, r * 0.25); ctx.stroke();
  ctx.restore();
}

const catbox: Scene = {
  fps: 24, scale: 1, protect: 0.08,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 70, 96) : sideZone({ w, h });
    const r = rng(461);
    return { z, small, r, peek: Array.from({ length: 6 }, () => ({ up: 0, next: r() * 6 })), jump: -9, jc: 0, says: [] as any[], prints: [] as any[], blink: 2 };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, z = s.z, INK = "#1f1f1f";
    const B = s.small ? z.w * 0.6 : Math.min(z.w * 0.64, z.h * 0.36);
    const fx = z.x + (z.w - B * 1.45) / 2, fy = s.small ? z.y + z.h - B * 1.5 : z.y + (z.h - B * 1.5) / 2 + B * 0.25;
    // Изометрия: лицевая грань (B × 1.5B), боковая уходит вправо-вверх.
    const dx = B * 0.45, dy = -B * 0.25, fw = B, fh = B * 1.5;
    ctx.lineJoin = "round"; ctx.lineWidth = Math.max(1.2, B / 70); ctx.strokeStyle = INK;
    // Крышка откинута назад.
    ctx.fillStyle = "#e5e5e5";
    ctx.beginPath(); ctx.moveTo(fx + dx, fy + dy); ctx.lineTo(fx + dx + fw, fy + dy); ctx.lineTo(fx + dx + fw + B * 0.08, fy + dy - B * 0.42); ctx.lineTo(fx + dx + B * 0.08, fy + dy - B * 0.42); ctx.closePath(); ctx.fill(); ctx.stroke();
    // Чёрный кот за крышкой — только уши.
    ctx.fillStyle = INK; for (const u of [0.4, 0.75]) { ctx.beginPath(); ctx.moveTo(fx + dx + fw * u - B * 0.08, fy + dy - B * 0.3); ctx.lineTo(fx + dx + fw * u, fy + dy - B * 0.5); ctx.lineTo(fx + dx + fw * u + B * 0.08, fy + dy - B * 0.3); ctx.fill(); ctx.fillStyle = "#f4a3a3"; ctx.beginPath(); ctx.moveTo(fx + dx + fw * u - B * 0.04, fy + dy - B * 0.32); ctx.lineTo(fx + dx + fw * u, fy + dy - B * 0.44); ctx.lineTo(fx + dx + fw * u + B * 0.04, fy + dy - B * 0.32); ctx.fill(); ctx.fillStyle = INK; }
    // Задняя стенка открытого верха.
    ctx.fillStyle = "#f3f3f3"; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + dx, fy + dy); ctx.lineTo(fx + dx + fw, fy + dy); ctx.lineTo(fx + fw, fy); ctx.closePath(); ctx.fill(); ctx.stroke();
    // Коты в коробке: просыпаются от трафика, выглядывают по очереди.
    const awakeN = Math.round(1 + sig.load * 5);
    const slots = [[0.18, 0.05], [0.42, -0.02], [0.68, 0.02], [0.3, 0.12], [0.58, 0.14], [0.85, 0.1]];
    const [lx] = look(e, fx + fw / 2, fy, 300);
    slots.forEach(([u, v], i) => {
      const p = s.peek[i];
      p.next -= dt;
      if (p.next < 0) { p.next = 3 + s.r() * 6; p.t = t; }
      const up = p.t && t - p.t < 1.4 ? Math.sin(((t - p.t) / 1.4) * Math.PI) : 0;
      const hov = e.mouse && Math.hypot(e.mx - (fx + fw * u + dx * 0.4), e.my - fy) < B * 0.25 ? 1 : 0;
      const breath = Math.sin(t * 2 + i) * B * 0.008;
      kitty(ctx, fx + fw * u + dx * 0.4, fy - B * (0.06 + up * 0.18 + hov * 0.12) + v * B + breath, B * 0.17, KITTY[i], i < awakeN || hov ? 1 : 0, lx, (hash2(i, 3) - 0.5) * 0.5);
    });
    // Лапа тянется наружу, хвост свисает через край.
    const st = (Math.sin(t * 0.7) * 0.5 + 0.5) * B * 0.12;
    ctx.fillStyle = "#c9a66b"; ctx.beginPath(); ctx.roundRect(fx - B * 0.32 - st, fy - B * 0.02, B * 0.42 + st, B * 0.08, B * 0.04); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#f5f5f4"; ctx.beginPath(); ctx.ellipse(fx - B * 0.32 - st, fy + B * 0.02, B * 0.06, B * 0.05, 0, 0, TAU); ctx.fill(); ctx.stroke();
    // Боковая грань серая со штрихами, лицевая белая с чёрным котом.
    ctx.fillStyle = "#cfcfcf"; ctx.beginPath(); ctx.moveTo(fx + fw, fy); ctx.lineTo(fx + fw + dx, fy + dy); ctx.lineTo(fx + fw + dx, fy + dy + fh); ctx.lineTo(fx + fw, fy + fh); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "rgba(31,31,31,.5)"; ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) { const yy = fy + fh * 0.32 + i * B * 0.04; ctx.beginPath(); ctx.moveTo(fx + fw + dx * 0.25, yy); ctx.lineTo(fx + fw + dx * 0.7, yy + dy * 0.45); ctx.stroke(); }
    for (let i = 0; i < 5; i++) { const yy = fy + fh * 0.8 + i * B * 0.035; ctx.beginPath(); ctx.moveTo(fx + fw + dx * 0.3, yy); ctx.lineTo(fx + fw + dx * 0.65, yy + dy * 0.35); ctx.stroke(); }
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.2, B / 70);
    ctx.fillStyle = "#fafafa"; ctx.fillRect(fx, fy, fw, fh); ctx.strokeRect(fx, fy, fw, fh);
    ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(fx + fw * 0.12, fy + fh); ctx.lineTo(fx + fw * 0.1, fy + fh * 0.3); ctx.quadraticCurveTo(fx + fw * 0.45, fy + fh * 0.05, fx + fw * 0.82, fy + fh * 0.18); ctx.lineTo(fx + fw * 0.9, fy + fh * 0.7); ctx.lineTo(fx + fw * 0.85, fy + fh); ctx.closePath(); ctx.fill();
    if (t > s.blink) s.blink = t + 2.5 + s.r() * 3.5;
    const [ex, ey] = look(e, fx + fw * 0.5, fy + fh * 0.3, 260);
    for (const [u, v] of [[0.3, 0.27], [0.62, 0.35]]) {
      const cx = fx + fw * u, cy = fy + fh * v, er = B * 0.075;
      if (s.blink - t < 0.12) { ctx.strokeStyle = "#d9d36a"; ctx.beginPath(); ctx.moveTo(cx - er, cy); ctx.lineTo(cx + er, cy); ctx.stroke(); ctx.strokeStyle = INK; continue; }
      ctx.fillStyle = "#d9d36a"; ctx.beginPath(); ctx.arc(cx, cy, er, 0, TAU); ctx.fill();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(cx + ex * er * 0.35, cy + ey * er * 0.3, er * 0.25, er * 0.75, 0, 0, TAU); ctx.fill();
    }
    ctx.strokeStyle = "#f3f3f3"; ctx.lineWidth = 1;
    for (const d of [-1, 1]) for (const a of [-0.03, 0.02]) { ctx.beginPath(); ctx.moveTo(fx + fw * (0.47 + d * 0.12), fy + fh * (0.42 + a)); ctx.lineTo(fx + fw * (0.47 + d * 0.3), fy + fh * (0.4 + a * 2)); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(fx + fw * 0.44, fy + fh * 0.4); ctx.lineTo(fx + fw * 0.47, fy + fh * 0.44); ctx.lineTo(fx + fw * 0.5, fy + fh * 0.4); ctx.moveTo(fx + fw * 0.47, fy + fh * 0.44); ctx.lineTo(fx + fw * 0.47, fy + fh * 0.47); ctx.stroke();
    // Щелчок: кот выпрыгивает по дуге и ныряет обратно.
    const clk = newClick(s, e);
    if (clk) { s.jump = t; s.jc = (s.r() * 6) | 0; s.says.push({ x: e.click!.x, y: e.click!.y, t, life: 1.2 }); }
    const ju = (t - s.jump) / 1.1;
    if (ju >= 0 && ju < 1) kitty(ctx, fx + fw * 0.5 + Math.sin(ju * Math.PI) * B * 0.6, fy - Math.sin(ju * Math.PI) * B * 0.9, B * 0.16, KITTY[s.jc], 1, 0, ju * TAU);
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t } = e;
    for (let i = 6; i < e.trail.length; i += 9) {
      const [x, y, a] = e.trail[i], [px, py] = e.trail[i - 6], k = 1 - a / 1.2;
      if (k <= 0) continue;
      const ang = Math.atan2(y - py, x - px) + Math.PI / 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.globalAlpha = k * 0.35; ctx.fillStyle = "#1f1f1f"; pawPrint(ctx, (i / 9) % 2 ? 5 : -5, 0, 5); ctx.restore();
    }
    s.says = particles(s.says, t, (q: any, a) => { ctx.globalAlpha = a; ctx.fillStyle = "#1f1f1f"; ctx.font = "italic 700 16px 'Segoe Print', 'Ink Free', cursive"; ctx.fillText("mew!", q.x + 8, q.y - 14 - (1 - a) * 18); });
    ctx.globalAlpha = 1;
  },
};

// ─── Формулы: доска, исписанная мелом, кот-каракуля ───────────────

const FORM = ["x³ = ½∫ x/dz³", "n = η(μ, ν)", "sin α / tg α = cos x", "m = lim Σ ρ(s,n)", "(x² − y² − z²) a²z", "∭[z − (z−3)]³", "√(1 + x³/3 + y³/5)", "z = √(R² − (2πνL)²)", "0 ≤ φ ≤ π", "Δx = 0A", "J = 4,5 A", "μ = 1/√(A − B²)", "cos x³", "y′ = −a³/x", "S = 10,8 mm²", "ν = 0,38 м/с", "g = −2πDg", "ω/x = iωT(ωt − ex)", "d² − k²λ²", "330,086 / 1,450"];

function board(w: number, h: number, seed: number) {
  const c = document.createElement("canvas"); c.width = Math.ceil(w); c.height = Math.ceil(h);
  const g = c.getContext("2d")!, r = rng(seed);
  g.strokeStyle = "#ececec"; g.fillStyle = "#ececec"; g.lineWidth = 1.3; g.lineCap = "round";
  for (let i = 0; i < Math.floor((w * h) / 9000); i++) {
    g.font = `italic ${13 + r() * 9}px "Segoe Print", "Ink Free", cursive`;
    g.globalAlpha = 0.5 + r() * 0.5;
    g.fillText(FORM[(r() * FORM.length) | 0], r() * w - 40, 20 + r() * h);
  }
  g.globalAlpha = 0.8;
  for (let i = 0; i < Math.floor((w * h) / 70000); i++) {
    const x = r() * w, y = r() * h, s = 40 + r() * 60, kind = (r() * 5) | 0;
    g.beginPath();
    if (kind === 0) { g.ellipse(x, y + s, s * 0.6, s * 0.15, 0, 0, TAU); g.moveTo(x - s * 0.6, y + s); g.lineTo(x, y - s * 0.4); g.lineTo(x + s * 0.6, y + s); }
    else if (kind === 1) { g.arc(x, y, s * 0.6, 0, TAU); for (const k of [0.3, 0.7]) g.ellipse(x, y, s * 0.6, s * 0.6 * k, 0, 0, TAU); g.ellipse(x, y, s * 0.2, s * 0.6, 0, 0, TAU); }
    else if (kind === 2) { g.moveTo(x - s, y); g.lineTo(x + s, y); g.moveTo(x - s * 0.8, y + s * 0.4); g.lineTo(x - s * 0.8, y - s * 0.6); for (let j = 0; j <= 40; j++) { const u = j / 40; g.lineTo(x - s * 0.8 + u * s * 1.7, y - Math.sin(u * 9) * s * 0.35 * (1 - u * 0.4)); } }
    else if (kind === 3) { g.moveTo(x, y); for (let j = 0; j <= 60; j++) { const u = j / 60; g.lineTo(x + u * s * 1.2 + Math.cos(u * 30) * 8, y + Math.sin(u * 30) * 10); } }
    else { g.ellipse(x, y, s * 0.8, s * 0.45, 0, 0, TAU); g.moveTo(x + s * 0.3, y); g.arc(x, y, s * 0.3, 0, TAU); g.moveTo(x, y); g.lineTo(x + s * 0.3, y - s * 0.1); g.fillText("R", x + s * 0.32, y - s * 0.05); g.fillText("O", x - 6, y + 4); }
    g.stroke();
  }
  return c;
}
const SCRIB = [[0.2, 1.0], [0.24, 0.62], [0.12, 0.6], [0.24, 0.52], [0.2, 0.36], [0.3, 0.32], [0.24, 0.0], [0.42, 0.22], [0.58, 0.22], [0.76, 0.0], [0.72, 0.32], [0.82, 0.36], [0.76, 0.52], [0.9, 0.58], [0.76, 0.64], [0.8, 1.0]];

const formula: Scene = {
  fps: 20, scale: 1, protect: 0.22,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 70, 96) : sideZone({ w, h });
    return { z, small, bd: small ? null : board(w, h, 467), r: rng(479), chalk: [] as any[], marks: [] as any[], wide: -9 };
  },
  draw(ctx, s, e) {
    const { t } = e, z = s.z;
    if (s.bd) {
      ctx.globalAlpha = 0.17; ctx.drawImage(s.bd, 0, 0);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, z.x + z.w + 10, e.h); ctx.clip(); ctx.globalAlpha = 0.22; ctx.drawImage(s.bd, 0, 0); ctx.restore();
      ctx.globalAlpha = 1;
    }
    // Кот: чёрный силуэт с «кипящим» белым контуром каракулями.
    const cw = s.small ? z.w : Math.min(z.w * 0.82, z.h * 0.5), ch = cw * 1.25;
    const cx0 = z.x + (z.w - cw) / 2, cy0 = (s.small ? z.y + z.h : z.y + z.h + 8) - ch;
    const pts = SCRIB.map(([u, v]) => [cx0 + u * cw, cy0 + v * ch]);
    ctx.fillStyle = "#050505"; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill();
    const seed = Math.floor(t * 8);
    ctx.strokeStyle = "rgba(240,240,240,.85)"; ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let p = 0; p < 4; p++) {
      ctx.lineWidth = p ? 0.8 : 1.6;
      const dense: number[][] = [];
      for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < 5; j++) { const u = j / 5; dense.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u]); }
      handLine(ctx, dense, 5 + p * 2, seed * 13 + p * 101); ctx.stroke();
    }
    // Пушистые пучки на щеках.
    for (const [u, v, d] of [[0.12, 0.6, -1], [0.9, 0.58, 1]]) for (let i = 0; i < 5; i++) {
      const x = cx0 + u * cw, y = cy0 + v * ch + (i - 2) * 4;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + d * (10 + hash2(i + seed, 3) * 14), y + (hash2(i, seed) - 0.5) * 10); ctx.stroke();
    }
    // Глаза: левый круглый, правый — с бровью «подозреваю»; щелчок — оба круглые.
    const wide = t - s.wide < 1.4;
    const [lx, ly] = look(e, cx0 + cw * 0.5, cy0 + ch * 0.45, 260);
    for (const [u, sus] of [[0.36, false], [0.64, true]] as const) {
      const ex = cx0 + cw * u, ey = cy0 + ch * 0.46, er = cw * 0.1;
      ctx.fillStyle = "#f5f5f5"; ctx.beginPath(); ctx.ellipse(ex, ey, er, er * 1.15, 0, 0, TAU); ctx.fill();
      if (sus && !wide) { ctx.fillStyle = "#050505"; ctx.beginPath(); ctx.moveTo(ex - er * 1.2, ey - er * 1.3); ctx.lineTo(ex + er * 1.2, ey - er * 0.9); ctx.lineTo(ex + er * 1.2, ey - er * 1.6); ctx.lineTo(ex - er * 1.2, ey - er * 1.6); ctx.fill(); ctx.strokeStyle = "#f5f5f5"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ex - er * 1.1, ey - er * 1.25); ctx.lineTo(ex + er * 1.1, ey - er * 0.88); ctx.stroke(); }
      ctx.fillStyle = "#050505"; ctx.beginPath(); ctx.ellipse(ex + lx * er * 0.35, ey + ly * er * 0.35, er * (wide ? 0.3 : 0.42), er * (wide ? 0.4 : 0.62), 0, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = "#e5e5e5"; ctx.fillRect(cx0 + cw * 0.48, cy0 + ch * 0.6, cw * 0.05, 2);
    const clk = newClick(s, e) ? e.click! : null;
    if (clk) { s.wide = t; s.marks.push({ x: clk.x, y: clk.y, kind: (s.r() * 4) | 0, t, life: 3 }); }
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t } = e;
    // Мел за курсором: ломкая линия с крошками.
    const tr = e.trail;
    ctx.strokeStyle = "rgba(236,236,236,.7)"; ctx.lineWidth = 2; ctx.lineCap = "round";
    for (let i = 1; i < tr.length; i++) { if (tr[i][2] > 0.8 || hash2(i, Math.floor(tr[i][0])) < 0.15) continue; ctx.globalAlpha = 1 - tr[i][2] / 0.8; ctx.beginPath(); ctx.moveTo(tr[i - 1][0], tr[i - 1][1]); ctx.lineTo(tr[i][0], tr[i][1]); ctx.stroke(); }
    // Щелчок: чертёж мелом — окружность с радиусом, вектор, треугольник, интеграл.
    s.marks = particles(s.marks, t, (q: any, a) => {
      const u = Math.min(1, (t - q.t) / 0.6);
      ctx.globalAlpha = Math.min(1, a * 2); ctx.strokeStyle = "#ececec"; ctx.fillStyle = "#ececec"; ctx.lineWidth = 1.8;
      ctx.font = "italic 16px 'Segoe Print', 'Ink Free', cursive";
      ctx.beginPath();
      if (q.kind === 0) { ctx.arc(q.x, q.y, 26, 0, TAU * u); if (u > 0.9) { ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + 26, q.y); ctx.fillText("R", q.x + 8, q.y - 4); } }
      else if (q.kind === 1) { ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + 50 * u, q.y - 30 * u); if (u > 0.9) { ctx.lineTo(q.x + 40, q.y - 30); ctx.moveTo(q.x + 50, q.y - 30); ctx.lineTo(q.x + 44, q.y - 20); ctx.fillText("F", q.x + 20, q.y - 26); } }
      else if (q.kind === 2) { const P = [[q.x, q.y + 20], [q.x + 50, q.y + 20], [q.x + 10, q.y - 25], [q.x, q.y + 20]]; const n = Math.ceil(u * 3); ctx.moveTo(P[0][0], P[0][1]); for (let i = 1; i <= n; i++) ctx.lineTo(P[i][0], P[i][1]); }
      else { ctx.font = "italic 30px 'Segoe Print', 'Ink Free', cursive"; ctx.fillText("∫", q.x, q.y + 10); if (u > 0.5) { ctx.font = "italic 16px 'Segoe Print', 'Ink Free', cursive"; ctx.fillText("ping dt", q.x + 14, q.y + 6); } }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  },
};

// ─── Overthinking: кот лежит, мысли пузырями, а ещё голодный ───────

const THINK_OK = ["а вдруг упадёт?", "закрыл ли я порт…", "рыбка?", "почему так тихо", "а если пинг…", "…", "еда", "надо было спать"];
const THINK_SLOW = ["{ms} мс?!", "это DPI?", "может, сменить узел", "рыбка?", "всё тормозит"];
const THINK_DOWN = ["всё пропало", "кто выключил интернет", "поговорить с людьми?", "рыбка…"];

const overthink: Scene = {
  fps: 24, scale: 1, protect: 0.1,
  init(w, h, small) {
    const z = small ? notchBox(w, h, 110, 60) : sideZone({ w, h });
    return { z, small, r: rng(487), th: [] as any[], next: 0.5, fish: -9, fed: -99, blink: 2, ear: 0, qs: [] as any[], pops: [] as any[] };
  },
  draw(ctx, s, e) {
    const { t, dt } = e, z = s.z, Wc = "#f2f2f2";
    const cw = s.small ? z.w : Math.min(z.w * 0.94, 300), chh = cw * 0.36;
    const cx0 = z.x + (z.w - cw) / 2, by = s.small ? z.y + z.h - 4 : z.y + z.h * 0.62;
    const X = (u: number) => cx0 + u * cw, Y = (v: number) => by - chh + v * chh;
    const br = Math.sin(t * 1.6) * 0.02;
    ctx.lineWidth = Math.max(1.4, cw / 140); ctx.strokeStyle = Wc; ctx.fillStyle = "#000"; ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Хвост, тело-лепёшка, лапы.
    const flick = Math.sin(t * 0.9) > 0.92 ? Math.sin(t * 20) * 0.03 : 0;
    ctx.beginPath(); ctx.moveTo(X(0.78), Y(0.88)); ctx.quadraticCurveTo(X(0.92), Y(0.95), X(0.98 + flick), Y(0.86)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0.08), Y(0.92));
    ctx.bezierCurveTo(X(0.1), Y(0.3 - br), X(0.35), Y(0.0 - br), X(0.55), Y(0.12 - br));
    ctx.bezierCurveTo(X(0.75), Y(0.2 - br), X(0.88), Y(0.55), X(0.82), Y(0.9));
    ctx.quadraticCurveTo(X(0.45), Y(1.0), X(0.08), Y(0.92)); ctx.fill(); ctx.stroke();
    for (const [u, d] of [[0.02, -1], [0.3, 1]]) { ctx.beginPath(); ctx.ellipse(X(u + 0.06), Y(0.93), cw * 0.06, chh * 0.07, 0, 0, TAU); ctx.fill(); ctx.stroke(); void d; }
    ctx.beginPath(); ctx.ellipse(X(0.86), Y(0.9), cw * 0.07, chh * 0.07, 0.2, 0, TAU); ctx.fill(); ctx.stroke();
    // Голова лежит на лапах, уши подёргиваются.
    const hx = X(0.2), hy = Y(0.62), hr = cw * 0.12;
    if (s.r() < 0.005) s.ear = t;
    const tw = t - s.ear < 0.25 ? Math.sin((t - s.ear) * 50) * 0.08 : 0;
    ctx.beginPath(); ctx.ellipse(hx, hy, hr * 1.15, hr, 0, 0, TAU); ctx.fill(); ctx.stroke();
    for (const [d, a] of [[-1, 0], [1, tw]]) { ctx.beginPath(); ctx.moveTo(hx + d * hr * 0.75, hy - hr * 0.55); ctx.lineTo(hx + d * hr * (0.95 + a), hy - hr * 1.2); ctx.lineTo(hx + d * hr * 0.2, hy - hr * 0.9); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = "#000"; ctx.beginPath(); ctx.ellipse(hx, hy, hr * 1.1, hr * 0.94, 0, 0, TAU); ctx.fill();
    if (t > s.blink) s.blink = t + 2 + s.r() * 4;
    const [lx, ly] = look(e, hx, hy, 250, [0.4, -0.6]);
    ctx.fillStyle = Wc;
    for (const d of [-1, 1]) {
      const ex = hx + d * hr * 0.42 + lx * hr * 0.08, ey = hy + hr * 0.05 + ly * hr * 0.06;
      if (s.blink - t < 0.12) ctx.fillRect(ex - hr * 0.12, ey, hr * 0.24, 1.5);
      else { ctx.beginPath(); ctx.ellipse(ex, ey, hr * 0.12, hr * 0.15, 0, 0, TAU); ctx.fill(); }
    }
    ctx.beginPath(); ctx.moveTo(hx - hr * 0.08, hy - hr * 0.35); ctx.lineTo(hx + hr * 0.08, hy - hr * 0.35); ctx.lineTo(hx, hy - hr * 0.25); ctx.fill();
    ctx.lineWidth = 0.9;
    for (const d of [-1, 1]) for (const a of [-0.1, 0.08]) { ctx.beginPath(); ctx.moveTo(hx + d * hr * 0.7, hy - hr * 0.25 + a * hr); ctx.lineTo(hx + d * hr * 1.6, hy - hr * 0.35 + a * hr * 2); ctx.stroke(); }
    if (s.small) return;
    // Надпись.
    const fed = t - s.fed < 6;
    ctx.fillStyle = Wc; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.font = `400 ${clamp(z.w / 9, 18, 30)}px "Ink Free", "Segoe Print", cursive`;
    (ctx as any).letterSpacing = "2px";
    ctx.fillText("OVERTHINKING", z.x + z.w / 2, by + 16);
    ctx.font = `400 ${clamp(z.w / 15, 12, 18)}px "Ink Free", "Segoe Print", cursive`;
    ctx.fillText(fed ? "AND NOW FED" : "AND ALSO HUNGRY", z.x + z.w / 2, by + 16 + clamp(z.w / 9, 18, 30) * 1.3);
    (ctx as any).letterSpacing = "0px"; ctx.textAlign = "left";
    // Мысли пузырями поднимаются от головы.
    s.next -= dt;
    if (s.next <= 0) {
      s.next = 3.2;
      const hl = health(), pool = fed ? ["мрр", "♥", "ещё бы рыбки"] : hl === "down" || hl === "engine_off" ? THINK_DOWN : hl === "slow" ? THINK_SLOW : THINK_OK;
      s.th.push({ txt: pool[(s.r() * pool.length) | 0].replace("{ms}", String(sig.ms ?? "?")), t, life: 5.5, x: hx + hr * (0.6 + s.r() * 0.6) });
    }
    s.th = particles(s.th, t, (q: any, a) => {
      const u = 1 - a, x = q.x + Math.sin(u * 4) * 10, y = hy - hr * 1.6 - u * z.h * 0.42;
      ctx.globalAlpha = Math.min(1, a * 2.5, u * 8);
      ctx.strokeStyle = Wc; ctx.fillStyle = "#000"; ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(hx + hr * 0.6 + (x - hx - hr * 0.6) * (i + 1) * 0.22, hy - hr * 1.1 - (hy - hr * 1.1 - y) * (i + 1) * 0.22, 2 + i * 1.6, 0, TAU); ctx.fill(); ctx.stroke(); }
      ctx.font = `400 14px "Ink Free", "Segoe Print", cursive`;
      const tw2 = ctx.measureText(q.txt).width + 22, th2 = 30;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) { const a2 = (i / 10) * TAU, rx = tw2 / 2 + Math.sin(i * 1.7) * 3, ry = th2 / 2 + Math.cos(i * 2.1) * 3; ctx.ellipse(x + Math.cos(a2) * rx * 0.75, y + Math.sin(a2) * ry * 0.6, rx * 0.35, ry * 0.5, 0, 0, TAU); }
      ctx.fill();
      ctx.beginPath(); ctx.ellipse(x, y, tw2 / 2, th2 / 2, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = Wc; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(q.txt, x, y + 1); ctx.textAlign = "left";
    });
    ctx.globalAlpha = 1;
    // Щелчок: рыбка падает сверху, кот ест.
    if (newClick(s, e)) { s.fish = t; s.pops.push({ x: e.click!.x, y: e.click!.y, t, life: 1 }); }
    const fu = (t - s.fish) / 1.1;
    if (fu >= 0 && fu < 1) {
      const fx = hx + hr * 1.4, fy = z.y + (hy - z.y) * fu * fu;
      ctx.strokeStyle = Wc; ctx.lineWidth = 1.6; ctx.fillStyle = "#000";
      ctx.save(); ctx.translate(fx, fy); ctx.rotate(Math.sin(t * 12) * 0.3);
      ctx.beginPath(); ctx.ellipse(0, 0, 14, 7, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(22, -7); ctx.lineTo(22, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = Wc; ctx.beginPath(); ctx.arc(-7, -1, 1.5, 0, TAU); ctx.fill();
      ctx.restore();
    } else if (fu >= 1 && fu < 1.2) s.fed = t;
  },
  fx(ctx, s, e) {
    if (s.small) return;
    const { t, dt } = e;
    for (let i = 0; i < e.trail.length; i += 5) { const [x, y, a] = e.trail[i]; if (a < 0.05 && s.r() < 0.4) s.qs.push({ x, y, t, life: 1.2, d: (s.r() - 0.5) * 20 }); }
    s.qs = particles(s.qs, t, (q: any, a) => { q.y -= 25 * dt; q.x += q.d * dt; ctx.globalAlpha = a * 0.7; ctx.fillStyle = "#f2f2f2"; ctx.font = "400 14px 'Ink Free', 'Segoe Print', cursive"; ctx.fillText("?", q.x, q.y); });
    s.pops = particles(s.pops, t, (q: any, a) => { ctx.globalAlpha = a; ctx.strokeStyle = "#f2f2f2"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(q.x + 18, q.y - 22 - (1 - a) * 10, 18, 11, 0, 0, TAU); ctx.stroke(); ctx.fillStyle = "#f2f2f2"; ctx.font = "400 14px 'Ink Free', cursive"; ctx.fillText("…", q.x + 11, q.y - 28 - (1 - a) * 10); });
    ctx.globalAlpha = 1;
  },
};

export const CATS = { ramen, sassy, focus, meh, catbox, formula, overthink };
