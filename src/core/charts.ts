// Рисование на canvas без библиотек: пульс задержки, мини-графики потока, ошибки.

export function css(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

/** Подогнать canvas под CSS-размер с учётом DPI; вернуть контекст и размеры. */
export function fit(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Цвет с прозрачностью: понимает #rrggbb и rgb() (так отдаёт --state). */
export function alpha(c: string, a: number): string {
  c = c.trim();
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 3) h = [...h].map((x) => x + x).join("");
    const n = parseInt(h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return c;
  const [r, g, b] = m[1].split(/[\s,/]+/).filter(Boolean);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface PulseView {
  /** x (px) → индекс ближайшей точки, для подсказки */
  pick(x: number): [number, number | null] | null;
}

// Потолок шкалы с гистерезисом: растёт сразу, сжимается, только когда
// запас стал больше чем вдвое, — график не «дышит» от каждого замера.
let ceilHold = 0;

/**
 * Пульс задержки: тонкая непрерывная линия по реальным замерам, без
 * сглаживания; провал — разрыв и засечка снизу; пики не обрезаются.
 */
export function drawPulse(
  canvas: HTMLCanvasElement,
  pts: [number, number | null][],
  range: number,
  now: number,
  slowMs: number,
  hoverX: number | null,
): PulseView {
  const { ctx, w, h } = fit(canvas);
  const padL = 48, padR = 12, padT = 10, padB = 22;
  const cw = w - padL - padR, ch = h - padT - padB;
  const t0 = now - range;
  const vis = pts.filter(([t]) => t >= t0);
  const vals = vis.map(([, v]) => v).filter((v): v is number => v !== null);
  const want = Math.max(200, (vals.length ? Math.max(...vals) : 300) * 1.12);
  if (want > ceilHold || want < ceilHold * 0.5) ceilHold = want;
  const tick = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].find((s) => s * 4 >= ceilHold) ?? 10000;
  const top = tick * 4;
  const X = (t: number) => padL + ((t - t0) / range) * cw;
  const Y = (v: number) => padT + ch - (v / top) * ch;

  const line = css("--line-2");
  const dim = css("--dim");
  const pulse = css("--pulse");
  const state = css("--state");

  // Сетка и подписи оси: X — время, Y — миллисекунды от нуля.
  ctx.font = `11px ${css("--mono")}`;
  ctx.fillStyle = dim;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = tick * i;
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = alpha(line, i === 0 ? 0.6 : 0.3);
    ctx.setLineDash(i === 0 ? [] : [2, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.textAlign = "right";
    if (i) ctx.fillText(v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0).replace(".", ",")} с` : `${v} мс`, padL - 8, y + 4);
  }
  ctx.setLineDash([]);
  ctx.textAlign = "center";
  const step = range <= 900_000 ? 300_000 : 900_000;
  for (let t = Math.ceil(t0 / step) * step; t <= now; t += step) {
    const d = new Date(t);
    ctx.fillText(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, X(t), h - 5);
  }
  // Порог «медленно»
  if (slowMs < top) {
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = alpha(css("--warn"), 0.45);
    const y = Math.round(Y(slowMs)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.restore();
  }

  // Линия по сегментам: провал (нет ответа) — разрыв, а не ноль.
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const [t, v] of vis) {
    if (v === null) { if (cur.length) segs.push(cur); cur = []; continue; }
    cur.push([X(t), Y(v)]);
  }
  if (cur.length) segs.push(cur);

  const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
  grad.addColorStop(0, alpha(pulse, 0.12));
  grad.addColorStop(1, alpha(pulse, 0));
  for (const s of segs) {
    if (s.length === 1) { ctx.fillStyle = pulse; ctx.fillRect(s[0][0] - 1.5, s[0][1] - 1.5, 3, 3); continue; }
    ctx.beginPath();
    ctx.moveTo(s[0][0], padT + ch);
    ctx.lineTo(s[0][0], s[0][1]);
    monotone(ctx, s);
    ctx.lineTo(s[s.length - 1][0], padT + ch);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    monotone(ctx, s);
    ctx.strokeStyle = pulse;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.shadowColor = alpha(pulse, 0.6);
    ctx.shadowBlur = 7;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  // Провалы — засечки снизу
  ctx.fillStyle = css("--bad");
  for (const [t, v] of vis) if (v === null) ctx.fillRect(X(t) - 1, padT + ch - 9, 2, 9);
  // Текущая точка — цветом состояния, если последний замер свежий и удачный.
  const last = vis[vis.length - 1];
  if (last && last[1] !== null && now - last[0] < 15_000) {
    const x = X(last[0]), y = Y(last[1]);
    ctx.fillStyle = alpha(state, 0.25);
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = state;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
  }

  // Курсор
  const pick = (x: number) => {
    let best: [number, number | null] | null = null, bd = Infinity;
    for (const p of vis) { const d = Math.abs(X(p[0]) - x); if (d < bd) { bd = d; best = p; } }
    return bd < 12 ? best : null;
  };
  if (hoverX !== null) {
    const picked = pick(hoverX);
    if (picked) {
      const x = Math.round(X(picked[0])) + 0.5;
      ctx.strokeStyle = alpha(css("--muted"), 0.4);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
      if (picked[1] !== null) {
        ctx.fillStyle = pulse;
        ctx.beginPath(); ctx.arc(x, Y(picked[1]), 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  return { pick };
}

/**
 * Монотонный кубический сплайн (Фритч–Карлсон): плавно, но между замерами
 * линия не выходит за их значения — ложных пиков и провалов не появляется.
 * Перо уже стоит в первой точке.
 */
function monotone(ctx: CanvasRenderingContext2D, p: [number, number][]) {
  const n = p.length;
  const d: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]));
  for (let i = 0; i < n; i++) {
    if (i === 0) m.push(d[0]);
    else if (i === n - 1) m.push(d[n - 2]);
    else if (d[i - 1] * d[i] <= 0) m.push(0);
    else {
      const h0 = p[i][0] - p[i - 1][0], h1 = p[i + 1][0] - p[i][0];
      m.push((3 * (h0 + h1)) / ((2 * h1 + h0) / d[i - 1] + (h1 + 2 * h0) / d[i]));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const h = (p[i + 1][0] - p[i][0]) / 3;
    ctx.bezierCurveTo(p[i][0] + h, p[i][1] + m[i] * h, p[i + 1][0] - h, p[i + 1][1] - m[i + 1] * h, p[i + 1][0], p[i + 1][1]);
  }
}

/** Мини-график потока: одна серия (1 — приём, 2 — отдача), последние точки. */
export function drawSpark(canvas: HTMLCanvasElement, pts: [number, number, number][], idx: 1 | 2, color: string) {
  const { ctx, w, h } = fit(canvas);
  const tail = pts.slice(-90);
  if (tail.length < 2 || !w) return;
  const max = Math.max(8 * 1024, ...tail.map((p) => p[idx]));
  const t0 = tail[0][0], t1 = tail[tail.length - 1][0];
  const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 2) + 1;
  const Y = (v: number) => h - 3 - (v / max) * (h - 7);
  ctx.beginPath();
  tail.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[idx])) : ctx.moveTo(X(p[0]), Y(p[idx]))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineJoin = "round";
  ctx.shadowColor = alpha(color, 0.5);
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/** Ошибки движка по минутам (3 часа). */
export function drawErrors(canvas: HTMLCanvasElement, mins: [number, number][], now: number) {
  const { ctx, w, h } = fit(canvas);
  const span = 180;
  const start = now - span * 60_000;
  const bw = w / span;
  const map = new Map(mins.map(([m, c]) => [m, c]));
  const max = Math.max(10, ...mins.filter(([m]) => m >= start).map(([, c]) => c));
  ctx.fillStyle = css("--line-2");
  ctx.fillRect(0, h - 1, w, 1);
  const coral = css("--bad");
  for (let i = 0; i < span; i++) {
    const m = Math.floor((start + i * 60_000) / 60_000) * 60_000;
    const c = map.get(m) ?? 0;
    if (!c) continue;
    const bh = Math.max(2, (Math.sqrt(c) / Math.sqrt(max)) * (h - 14));
    ctx.fillStyle = c > max * 0.5 ? coral : alpha(coral, 0.65);
    ctx.fillRect(i * bw, h - 1 - bh, Math.max(1, bw - 0.5), bh);
  }
  ctx.fillStyle = css("--dim");
  ctx.font = `10px ${css("--mono")}`;
  ctx.textAlign = "left";
  ctx.fillText("−3ч", 0, 9);
  ctx.textAlign = "right";
  ctx.fillText(`макс ${max}/мин`, w, 9);
}
