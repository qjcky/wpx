// Сетевой маршрут: крупные пиктограммы узлов, под ними — перекрученная лента
// из светящихся нитей с огоньками в перехватах и импульсами от ПК к интернету.
// Смена маршрута — лента заново прорастает от ПК; за обрывом лента гаснет.
// Все точки профиля — кружками под узлом (заполненный — в работе).
// Лента — canvas (≤30 кадров/с, стоп при скрытом окне), узлы и подписи — HTML.

import type { Leg, Snapshot } from "../core/types";
import { ICON } from "../core/icons";
import { alpha, css } from "../core/charts";
import { esc } from "../core/ui";

export const PROTO: Record<string, string> = {
  vless: "VLESS", hysteria2: "Hysteria2", wireguard: "AmneziaWG", trojan: "Trojan", ss: "Shadowsocks", http: "HTTP", socks5: "SOCKS5",
};
/** Коротко — для тесных мест (строки путей, капсула выреза). */
export const SHORT: Record<string, string> = { vless: "VLESS", hysteria2: "Hy2", wireguard: "AWG", trojan: "Trojan", ss: "SS", http: "HTTP", socks5: "SOCKS" };

/** Система этого ПК — подпись под узлом «ПК». */
const OS = navigator.userAgent.includes("Linux") ? "Linux" : "Windows";

type Flow = "live" | "slow" | "idle" | "broken";
interface Pt { cls: string; title: string }
interface RNode { key: string; icon: "pc" | "lock" | "pin" | "globe"; label: string; meta: string; metaCls: string; cls: string; title: string; pts?: Pt[] }
interface Model { nodes: RNode[]; segs: Flow[] }

/** Прокси-профиль: точки HTTP и SOCKS5 одного сервера. */
export const isProxy = (s: Snapshot) => s.legs.length > 0 && s.legs.every((l) => l.name === "HTTP" || l.name === "SOCKS5");

/** «Сингапур → Хельсинки · Hysteria2» → «Хельсинки»; «Сингапур · Hysteria2» → «Сингапур». */
export function placeOf(l: Leg) {
  const head = l.label.split(" · ")[0];
  return head.split(" → ").pop() || head;
}

const legCls = (l?: Leg) => (!l || !l.at ? "off" : l.result.ok ? "ok" : "bad");
const legMs = (l?: Leg) => (!l || !l.at ? "проверяем…" : l.result.ok ? `${l.result.ready_ms} мс` : "нет ответа");

function model(s: Snapshot): Model {
  const engine = s.engine.running;
  const tunnelOk = s.health === "online" || s.health === "slow";
  const flow: Flow = s.health === "slow" ? "slow" : "live";
  const proxy = isProxy(s) || !s.legs.length;
  const exits = s.legs.filter((l) => l.role === "exit");
  const entries = s.legs.filter((l) => l.role === "entry");
  const exit = exits.find((l) => l.active) ?? exits[0];
  const entry = entries.find((l) => l.active) ?? entries[0];
  const anyOk = s.legs.some((l) => l.result.ok);
  const known = s.legs.some((l) => l.at);
  // Каскад своих серверов: точка «Сингапур → Хельсинки · Hysteria2» — вход «Сингапур».
  const head = exit?.label.split(" · ")[0] ?? "";
  const via = !proxy && !entries.length && head.includes(" → ") ? head.split(" → ")[0] : null;
  // Виноват туннель, только если точки при этом отвечают напрямую.
  const tunCls = !engine ? "bad" : tunnelOk ? "ok" : s.health === "starting" ? "" : known && !anyOk ? "ok" : "bad";
  const step = (l?: Leg): Flow => (!l || !l.at ? "idle" : !l.result.ok ? "broken" : tunnelOk ? flow : "idle");
  const pts = (ls: Leg[]) => (ls.length > 1 ? ls.map((l) => ({ cls: `${legCls(l)}${l.active ? " on" : ""}`, title: `${l.label} · ${legMs(l)}` })) : undefined);
  const metaCls = (l?: Leg) => (!l || !l.at ? "" : l.result.ok ? "ok" : "bad");
  const legTitle = (l?: Leg) => (l ? `${l.label} · ${l.server}:${l.port}${l.result.err ? ` · ${l.result.err}` : ""}` : "");

  const nodes: RNode[] = [
    { key: "pc", icon: "pc", label: "ПК", meta: OS, metaCls: "", cls: "ok", title: "этот компьютер" },
    {
      key: "tun", icon: "lock", label: proxy ? "Туннель" : "VPN-туннель", meta: !engine ? "остановлен" : PROTO[(entry ?? exit)?.kind ?? ""] ?? "mihomo",
      metaCls: engine ? "" : "bad", cls: `tun ${tunCls}`, title: engine ? `TUN ${s.tun_device} · mihomo · ${s.engine.mem_mb} МБ` : "движок не запущен",
    },
  ];
  const segs: Flow[] = [!engine ? "broken" : tunnelOk ? flow : tunCls === "bad" ? "broken" : "idle"];
  if (entry) {
    const mc = metaCls(entry);
    nodes.push({ key: `in:${placeOf(entry)}`, icon: "pin", label: placeOf(entry), meta: `вход · ${legMs(entry)}`, metaCls: mc === "ok" ? "" : mc, cls: legCls(entry), title: legTitle(entry), pts: pts(entries) });
    segs.push(step(entry));
  } else if (via) {
    nodes.push({ key: `in:${via}`, icon: "pin", label: via, meta: "вход", metaCls: "", cls: legCls(exit), title: `вход каскада: ${via}` });
    segs.push(step(exit));
  }
  nodes.push({
    key: `out:${proxy ? s.server : exit ? placeOf(exit) : ""}`, icon: "pin", label: proxy ? (s.profile ?? (s.server || "Прокси")) : exit ? placeOf(exit) : "Выход",
    meta: legMs(exit), metaCls: metaCls(exit), cls: proxy ? (!known ? "" : anyOk ? "ok" : "bad") : legCls(exit),
    title: proxy ? `${s.server}${exit ? `:${exit.port}` : ""}` : legTitle(exit), pts: pts(exits),
  });
  segs.push(entry?.at && !entry.result.ok ? "idle" : step(exit));
  nodes.push({ key: "net", icon: "globe", label: "Интернет", meta: "", metaCls: "", cls: tunnelOk ? "ok" : "", title: s.ip ? `сайты видят ${s.ip}` : "" });
  segs.push(tunnelOk ? flow : s.health === "down" && anyOk ? "broken" : "idle");
  return { nodes, segs };
}

// ─── Лента ───────────────────────────────────────────────────────

const H = 150, RY = 64, AMP = 12, STRANDS = 6, M = 74;
let wrap: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let cur: Model | null = null;
let raf = 0, lastFrame = 0, grownAt = 0;
let structSig = "", textSig = "";

const motionOn = () => {
  const m = document.documentElement.dataset.motion;
  return m === "on" || (m !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
};
const xsOf = (w: number, n: number) => Array.from({ length: n }, (_, i) => M + (i * (w - 2 * M)) / Math.max(1, n - 1));
const segOf = (x: number, xs: number[]) => {
  let i = 0;
  while (i < xs.length - 2 && x > xs[i + 1]) i++;
  return i;
};

/** Высота нити j в точке x: перекрут ленты — перехват посередине между узлами. */
function strandY(x: number, xs: number[], j: number, t: number) {
  const i = segOf(x, xs);
  const u = (x - xs[i]) / Math.max(1, xs[i + 1] - xs[i]);
  const twist = Math.cos(Math.PI * (i + u));
  const turn = Math.cos(t * 0.55 + (j * Math.PI) / (STRANDS - 1));
  // Лёгкая живая волна поверх перекрута — нити не идут идеально ровно.
  const ripple = 1.6 * Math.sin(x / 38 + t * 0.9 + j * 1.3) * Math.abs(twist);
  return RY + AMP * twist * turn + ripple;
}
const centerY = (x: number, xs: number[], t: number) => (strandY(x, xs, 2, t) + strandY(x, xs, 3, t)) / 2;

function segColor(f: Flow, i: number, c: Record<string, string>) {
  if (f === "broken") return c.bad;
  if (f === "idle") return c.idle;
  if (f === "slow") return i === 0 ? c.state : c.warn;
  return i === 0 ? c.state : c.accent;
}

/** Смешать два цвета (#rrggbb или rgb()) — нити ленты светлее, чем огоньки. */
function mix(a: string, b: string, k: number) {
  const rgb = (c: string) => {
    c = c.trim();
    if (c.startsWith("#")) { const n = parseInt(c.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    return (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
  };
  const [x, y] = [rgb(a), rgb(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(", ")})`;
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, k: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, alpha("#ffffff", 0.95 * k));
  g.addColorStop(0.18, alpha(col, 0.9 * k));
  g.addColorStop(0.5, alpha(col, 0.25 * k));
  g.addColorStop(1, alpha(col, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

function draw(now: number) {
  if (!canvas || !cur) return;
  const w = canvas.clientWidth;
  if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, H);
  const motion = motionOn();
  const t = motion ? now / 1000 : 1.1;
  const { nodes, segs } = cur;
  const xs = xsOf(w, nodes.length);
  const c = { accent: css("--accent"), ice: css("--ice"), state: css("--state"), warn: css("--warn"), bad: css("--bad"), idle: css("--idle") };
  // Прорастание от ПК после смены маршрута.
  const grow = motion ? Math.min(1, (now - grownAt) / 1100) : 1;
  const x0 = xs[0] - 40, x1 = xs[xs.length - 1] + 40;
  const reach = x0 + (1 - (1 - grow) ** 3) * (x1 - x0);
  // У каждой темы свой маршрут; лента — у «Призмы» и мягких тем.
  const scene = document.documentElement.dataset.scene ?? "prism";
  const st = STYLE_OF[scene];
  if (st) { drawStyled(st, ctx, { xs, segs, c, t, now, motion, grow, x0, x1, reach, marks: true }); return; }
  const rainbow = scene === "spectrum";

  ctx.globalCompositeOperation = "lighter";
  // Сегменты: перекрученная лента из нитей; передние нити ярче задних.
  segs.forEach((f, i) => {
    const a = i === 0 ? x0 : xs[i], b = i === segs.length - 1 ? x1 : xs[i + 1];
    if (a >= reach) return;
    const end = Math.min(b, reach);
    const col = mix(segColor(f, i, c), c.ice, 0.4);
    const dim = f === "idle" ? 0.35 : f === "broken" ? 0.55 : 1;
    const next = segs[i + 1] && (f === "live" || f === "slow") ? mix(segColor(segs[i + 1], i + 1, c), c.ice, 0.4) : col;
    const grad = ctx.createLinearGradient(a, 0, b, 0);
    grad.addColorStop(0, i === 0 ? alpha(c.ice, 0) : col);
    grad.addColorStop(i === 0 ? 0.35 : 0.5, col);
    grad.addColorStop(1, i === segs.length - 1 ? alpha(c.ice, 0) : next);
    for (let j = 0; j < STRANDS; j++) {
      const depth = (Math.sin(t * 0.55 + (j * Math.PI) / (STRANDS - 1)) + 1) / 2;
      ctx.beginPath();
      ctx.moveTo(a, strandY(a, xs, j, t));
      for (let x = a + 3; x < end; x += 3) ctx.lineTo(x, strandY(x, xs, j, t));
      ctx.lineTo(end, strandY(end, xs, j, t));
      ctx.strokeStyle = rainbow ? alpha(SPEC[j % SPEC.length], 1) : grad;
      ctx.globalAlpha = dim * (0.1 + 0.16 * depth);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = dim * (0.26 + 0.5 * depth);
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;

  // Огоньки в перехватах ленты между узлами.
  for (let i = 0; i < xs.length - 1; i++) {
    const f = segs[i], mx = (xs[i] + xs[i + 1]) / 2;
    if (f === "idle" || mx > reach) continue;
    const k = motion ? 0.8 + 0.2 * Math.sin(t * 2.2 + i) : 1;
    glow(ctx, mx, centerY(mx, xs, t), f === "broken" ? 11 : 13, segColor(f, i, c), k);
  }

  // Световые импульсы: от ПК вперёд по живым звеньям, до первого обрыва.
  let live = 0;
  while (live < segs.length && (segs[live] === "live" || segs[live] === "slow")) live++;
  if (motion && grow >= 1 && live > 0) {
    const from = x0 + 24, to = live >= segs.length ? x1 - 16 : xs[live];
    const span = to - from + 140;
    const speed = segs.includes("slow") ? 90 : 190;
    for (let k = 0; k < 2; k++) {
      const hx = from - 70 + ((((now / 1000) * speed) / span + k / 2) % 1) * span;
      if (hx < from || hx > to) continue;
      const fade = Math.min(1, (hx - from) / 60, (to - hx) / 60);
      const col = segColor(segs[segOf(hx, xs)] ?? "live", segOf(hx, xs), c);
      // Хвост — по средней линии ленты, гаснет назад.
      for (let d = 3; d < 72; d += 3) {
        const x = hx - d;
        if (x < from) break;
        ctx.fillStyle = alpha(col, (1 - d / 72) * 0.55 * fade);
        ctx.beginPath(); ctx.arc(x, centerY(x, xs, t), 1.7 * (1 - d / 100), 0, Math.PI * 2); ctx.fill();
      }
      glow(ctx, hx, centerY(hx, xs, t), 9, col, fade);
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

// ─── Маршрут в стиле темы ────────────────────────────────────────
// Общая схема: звенья, огоньки между узлами, импульсы от ПК. Тема решает, как
// они выглядят: пиксели, руны, соты, лоза с цветами, дорожка платы, трещина…

const SPEC = ["#22d3ee", "#3b82f6", "#a855f7", "#e879f9", "#fb7185", "#fb923c"];
interface Head { x: number; col: string; fade: number }
interface RC { ctx: CanvasRenderingContext2D; xs: number[]; t: number; heads: Head[] }
interface RStyle {
  /** Средняя линия — по ней бегут импульсы. */
  y(x: number, xs: number[], t: number): number;
  seg(R: RC, a: number, b: number, col: string, dim: number, f: Flow): void;
  mid(R: RC, x: number, y: number, col: string, k: number, f: Flow): void;
  head(R: RC, x: number, y: number, col: string, fade: number): void;
  /** Хвост импульса точками по линии. */
  tail?: boolean;
}
interface Frame { xs: number[]; segs: Flow[]; c: Record<string, string>; t: number; now: number; motion: boolean; grow: number; x0: number; x1: number; reach: number; marks?: boolean }

const h1 = (n: number) => {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 2654435761);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Насколько точку x освещает пробегающий импульс (0…1). */
const lit = (R: RC, x: number) => R.heads.reduce((m, h) => Math.max(m, h.fade * clamp01(1 - Math.abs(x - h.x) / 64)), 0);
const lighten = (c: string, k: number) => mix(c, "#ffffff", k);
function poly(ctx: CanvasRenderingContext2D, a: number, b: number, y: (x: number) => number, step = 3) {
  ctx.beginPath(); ctx.moveTo(a, y(a));
  for (let x = a + step; x < b; x += step) ctx.lineTo(x, y(x));
  ctx.lineTo(b, y(b));
}
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y); ctx.quadraticCurveTo(x, y, x, y - r); ctx.fill();
}
function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; if (i) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  ctx.closePath();
}
const spanU = (x: number, xs: number[]) => { const i = segOf(x, xs); return { i, u: (x - xs[i]) / Math.max(1, xs[i + 1] - xs[i]) }; };
const inside = (x: number, xs: number[]) => x >= xs[0] && x <= xs[xs.length - 1];

/** Сеть: узлы-точки, связанные треугольниками; огонёк — кольцо. */
const mesh: RStyle = {
  y: () => RY,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    const pts: [number, number][] = [];
    for (let x = Math.ceil(a / 20) * 20; x <= b; x += 20) pts.push([x, RY + (h1(x) - 0.5) * 28 + Math.sin(t * 0.9 + x * 0.05) * 3]);
    ctx.lineWidth = 0.7;
    pts.forEach((p, i) => [pts[i + 1], pts[i + 2]].forEach((q) => {
      if (!q) return;
      ctx.strokeStyle = alpha(col, (0.16 + 0.5 * lit(R, p[0])) * dim);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
    }));
    for (const [x, y] of pts) { ctx.fillStyle = alpha(lighten(col, 0.5), (0.45 + 0.55 * lit(R, x)) * dim); ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 7); ctx.fill(); }
  },
  mid(R, x, y, col, k) {
    R.ctx.strokeStyle = alpha(col, 0.8 * k); R.ctx.lineWidth = 1.2;
    R.ctx.beginPath(); R.ctx.arc(x, y, 6, 0, 7); R.ctx.stroke();
    glow(R.ctx, x, y, 9, col, k * 0.8);
  },
  head(R, x, y, col, fade) {
    glow(R.ctx, x, y, 9, col, fade);
    const p = (R.t * 2) % 1;
    R.ctx.strokeStyle = alpha(col, (1 - p) * 0.7 * fade); R.ctx.lineWidth = 1;
    R.ctx.beginPath(); R.ctx.arc(x, y, 4 + p * 14, 0, 7); R.ctx.stroke();
  },
};

/** Паутина: три провисающие нити, на них капли росы. */
const sag = (x: number, xs: number[], t: number, amp: number, off: number) => {
  if (!inside(x, xs)) return RY - 6 + off;
  const { i, u } = spanU(x, xs);
  return RY - 6 + off + 4 * u * (1 - u) * (amp + 2 * Math.sin(t * 1.1 + i));
};
const silk: RStyle = {
  y: (x, xs, t) => sag(x, xs, t, 14, 0),
  seg(R, a, b, col, dim) {
    const { ctx, xs, t } = R;
    for (const [amp, off, al] of [[8, -3, 0.3], [14, 0, 0.55], [20, 3, 0.25]] as const) {
      ctx.strokeStyle = alpha(lighten(col, 0.55), al * dim); ctx.lineWidth = 0.7;
      poly(ctx, a, b, (x) => sag(x, xs, t, amp, off), 4); ctx.stroke();
    }
    for (let x = Math.ceil(a / 31) * 31; x < b; x += 31) {
      if (h1(x) < 0.45) continue;
      const y = sag(x, xs, t, 14, 0) + 1.5, L = lit(R, x);
      ctx.fillStyle = alpha("#ffffff", (0.55 + 0.45 * L) * dim);
      ctx.beginPath(); ctx.arc(x, y, 1.4 + L * 1.2, 0, 7); ctx.fill();
    }
  },
  mid(R, x, y, col, k) { glow(R.ctx, x, y + 2, 10, col, k * 0.8); R.ctx.fillStyle = alpha("#ffffff", k); R.ctx.beginPath(); R.ctx.arc(x, y + 2, 2.6, 0, 7); R.ctx.fill(); },
  head(R, x, y, col, fade) { glow(R.ctx, x, y + 1.5, 7, col, fade); },
};

/** Код: поток символов; в «Редакторе» — с подсветкой синтаксиса. */
const TOKS: [string, string][] = [["t", "#fde68a"], ["->", "#2dd4bf"], ["send", "#ffd76a"], ["(", "#2dd4bf"], ["pkt", "#e5e5e5"], [")", "#2dd4bf"], [";", "#8a8a8a"], [" ", "#000000"], ["if", "#ff5a4f"], [" ok ", "#e5e5e5"], ["{", "#2dd4bf"], ["}", "#2dd4bf"], [" ", "#000000"]];
const TOK_CH = TOKS.flatMap(([s, c]) => [...s].map((ch) => [ch, c] as [string, string]));
const code = (editor: boolean): RStyle => ({
  y: () => RY,
  tail: false,
  seg(R, a, b, col, dim, f) {
    const { ctx, t } = R;
    ctx.font = "11px 'Cascadia Mono', Consolas, monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    const step = 8, speed = f === "live" ? 42 : f === "slow" ? 14 : 0;
    for (let x = Math.ceil(a / step) * step; x < b; x += step) {
      const n = Math.floor((x - t * speed) / step), L = lit(R, x);
      if (editor) {
        const [ch, c] = TOK_CH[((n % TOK_CH.length) + TOK_CH.length) % TOK_CH.length];
        if (ch === " ") continue;
        ctx.fillStyle = alpha(f === "broken" ? col : c, (0.4 + 0.6 * L) * dim);
        ctx.fillText(ch, x, RY);
      } else {
        ctx.fillStyle = alpha(L > 0.35 ? "#ffffff" : col, (0.3 + 0.7 * L) * dim);
        ctx.fillText(h1(n) < 0.62 ? "·" : h1(n * 7) < 0.5 ? "0" : "1", x, RY);
      }
    }
    ctx.textAlign = "left";
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    ctx.font = "bold 13px 'Cascadia Mono', Consolas, monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.fillStyle = alpha(col, k); ctx.fillText(editor ? "{ }" : "[ ]", x, y); ctx.textAlign = "left";
  },
  head(R, x, y, col, fade) {
    R.ctx.fillStyle = alpha("#ffffff", 0.9 * fade); R.ctx.fillRect(x - 3, y - 7, 7, 14);
    glow(R.ctx, x, y, 11, col, 0.5 * fade);
  },
});

/** Ретро: пиксельные блоки. */
const retroStyle: RStyle = {
  y: () => RY,
  tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    for (let x = Math.ceil(a / 6) * 6; x < b; x += 6) {
      const L = lit(R, x), up = Math.floor(x / 6) % 8 < 4 ? 0 : 2;
      ctx.fillStyle = alpha(L > 0.4 ? lighten(col, 0.4) : col, (0.4 + 0.6 * L) * dim);
      ctx.fillRect(x, RY - 2 - up, 4, 4);
      if (Math.floor(x / 6) % 2 === 0) { ctx.fillStyle = alpha(col, 0.25 * dim); ctx.fillRect(x, RY + 6, 4, 1); }
    }
  },
  mid(R, x, y, col, k) {
    const { ctx, t } = R;
    ctx.strokeStyle = alpha(col, k); ctx.lineWidth = 2; ctx.strokeRect(x - 6, y - 7, 12, 12);
    if (Math.sin(t * 6) > 0) { ctx.fillStyle = alpha(col, k); ctx.fillRect(x - 2, y - 3, 4, 4); }
  },
  head(R, x, y, col, fade) {
    const { ctx } = R;
    for (let k = 0; k < 3; k++) { ctx.fillStyle = alpha(k ? col : "#ffffff", fade * (1 - k * 0.3)); ctx.fillRect(x - k * 8 - 4, y - 4, 7, 7); }
  },
};

/** Сбой: красный и бирюзовый разнесены, разрывы прыгают. «Постер» — пунктир и кресты. */
const glitchStyle = (poster: boolean): RStyle => ({
  y: () => RY,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    if (poster) {
      ctx.setLineDash([10, 6]); ctx.lineDashOffset = -t * 20;
      ctx.strokeStyle = alpha("#ffffff", 0.6 * dim); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(a, RY); ctx.lineTo(b, RY); ctx.stroke();
      ctx.setLineDash([]);
      for (let x = Math.ceil(a / 46) * 46; x < b; x += 46) { ctx.fillStyle = alpha(col, 0.9 * dim); ctx.fillRect(x, RY + 6, 12, 2); }
      return;
    }
    for (const [dx, c, al] of [[-2, "#ff2630", 0.55], [2, "#20e3d0", 0.5], [0, lighten(col, 0.5), 0.8]] as const) {
      ctx.strokeStyle = alpha(c, al * dim); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(a + dx, RY); ctx.lineTo(b + dx, RY); ctx.stroke();
    }
    const fr = Math.floor(t * 8);
    for (let x = Math.floor(a / 28) * 28; x < b; x += 28) {
      const q = h1(x * 13 + fr);
      if (q < 0.78) continue;
      ctx.fillStyle = q > 0.9 ? alpha("#ff2630", 0.7 * dim) : alpha("#20e3d0", 0.6 * dim);
      ctx.fillRect(Math.max(a, x), RY + (q - 0.89) * 60 - 1.5, 14 + q * 16, 3);
    }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    if (poster) { ctx.fillStyle = alpha(col, k); ctx.fillRect(x - 7, y - 1.5, 14, 3); ctx.fillRect(x - 1.5, y - 7, 3, 14); return; }
    ctx.fillStyle = alpha("#ff2630", 0.8 * k); ctx.fillRect(x - 7, y - 4, 12, 7);
    ctx.fillStyle = alpha("#20e3d0", 0.8 * k); ctx.fillRect(x - 3, y - 3, 12, 7);
    ctx.fillStyle = alpha("#ffffff", k); ctx.fillRect(x - 5, y - 3, 10, 6);
  },
  head(R, x, y, col, fade) {
    const { ctx } = R;
    if (poster) { ctx.fillStyle = alpha(col, fade); ctx.fillRect(x - 10, y - 2, 20, 4); glow(ctx, x, y, 8, col, 0.5 * fade); return; }
    ctx.fillStyle = alpha("#ff2630", fade); ctx.fillRect(x - 9, y - 2, 14, 4);
    ctx.fillStyle = alpha("#20e3d0", fade); ctx.fillRect(x - 5, y - 2, 14, 4);
    ctx.fillStyle = alpha("#ffffff", fade); ctx.fillRect(x - 7, y - 2, 14, 4);
  },
});

/** HUD: сегменты загрузки загораются под импульсом. */
const pixelBar: RStyle = {
  y: () => RY,
  tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    ctx.fillStyle = alpha(col, 0.22 * dim); ctx.fillRect(a, RY - 8, b - a, 1); ctx.fillRect(a, RY + 7, b - a, 1);
    for (let x = Math.ceil(a / 12) * 12; x + 9 < b; x += 12) {
      const L = lit(R, x);
      ctx.fillStyle = alpha(col, (0.14 + 0.86 * L) * dim); ctx.fillRect(x, RY - 4, 9, 8);
      ctx.strokeStyle = alpha(col, 0.45 * dim); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, RY - 3.5, 8, 7);
    }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    ctx.fillStyle = alpha(col, k);
    ctx.beginPath(); ctx.moveTo(x - 6, y - 7); ctx.lineTo(x + 2, y - 7); ctx.lineTo(x + 8, y); ctx.lineTo(x + 2, y + 7); ctx.lineTo(x - 6, y + 7); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
  },
  head() { /* сегменты сами загораются */ },
};

/** Руны: цепочка ромбов на волне, энергия бежит. */
const runeY = (x: number, t: number) => RY + Math.sin(x / 30 + t * 0.6) * 3;
const runeStyle: RStyle = {
  y: (x, _xs, t) => runeY(x, t),
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.strokeStyle = alpha(col, 0.25 * dim); ctx.lineWidth = 1;
    poly(ctx, a, b, (x) => runeY(x, t)); ctx.stroke();
    for (let x = Math.ceil(a / 13) * 13; x < b; x += 13) {
      const y = runeY(x, t), L = lit(R, x), s = 3 + L * 1.6;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = alpha(lighten(col, 0.3), (0.45 + 0.55 * L) * dim); ctx.lineWidth = 1.2; ctx.strokeRect(-s, -s, s * 2, s * 2);
      if (Math.floor(x / 13) % 3 === 0 || L > 0.4) { ctx.fillStyle = alpha(col, (0.35 + 0.6 * L) * dim); ctx.fillRect(-s / 2, -s / 2, s, s); }
      ctx.restore();
    }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    glow(ctx, x, y, 14, col, 0.6 * k);
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = alpha("#ffffff", k); ctx.lineWidth = 1.4; ctx.strokeRect(-6, -6, 12, 12);
    ctx.fillStyle = alpha(col, k); ctx.fillRect(-2.5, -2.5, 5, 5);
    ctx.restore();
  },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 10, col, fade); },
};

/** Соты: цепочка шестигранников, под импульсом заливаются. */
const hexStyle: RStyle = {
  y: () => RY,
  tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    for (let x = Math.ceil(a / 15) * 15; x < b; x += 15) {
      const L = lit(R, x), y = RY + (Math.floor(x / 15) % 2 ? 3 : -3);
      hexPath(ctx, x, y, 6.5);
      if (L > 0.15) { ctx.fillStyle = alpha("#f4f4f4", L * 0.85 * dim); ctx.fill(); }
      ctx.strokeStyle = alpha(lighten(col, 0.4), (0.3 + 0.5 * L) * dim); ctx.lineWidth = 1; ctx.stroke();
    }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    hexPath(ctx, x, y, 9); ctx.fillStyle = alpha(col, 0.85 * k); ctx.fill();
    ctx.strokeStyle = alpha("#ffffff", k); ctx.lineWidth = 1.2; ctx.stroke();
  },
  head() { /* соты сами заливаются */ },
};

/** Цветение: лоза с листьями, в перехватах — светящиеся цветы. */
const vineY = (x: number, t: number) => RY + Math.sin(x / 26 + t * 0.5) * 6;
const vine: RStyle = {
  y: (x, _xs, t) => vineY(x, t),
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.strokeStyle = alpha(mix(col, "#14532d", 0.35), 0.85 * dim); ctx.lineWidth = 2;
    poly(ctx, a, b, (x) => vineY(x, t)); ctx.stroke();
    for (let x = Math.ceil(a / 26) * 26; x < b; x += 26) {
      const y = vineY(x, t), side = Math.floor(x / 26) % 2 ? 1 : -1, L = lit(R, x);
      ctx.save(); ctx.translate(x, y); ctx.rotate(side * 0.9 + Math.sin(t + x) * 0.1);
      ctx.fillStyle = alpha(lighten(col, L * 0.5), (0.5 + 0.4 * L) * dim);
      ctx.beginPath(); ctx.ellipse(0, side * -6, 2.6, 6, 0, 0, 7); ctx.fill();
      ctx.restore();
    }
  },
  mid(R, x, y, col, k) {
    const { ctx, t } = R;
    glow(ctx, x, y, 16, col, 0.55 * k);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + t * 0.2;
      ctx.fillStyle = alpha(lighten(col, 0.35), 0.85 * k);
      ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * 5, y + Math.sin(a) * 5, 4.5, 2.4, a, 0, 7); ctx.fill();
    }
    ctx.fillStyle = alpha("#ffffff", k); ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill();
  },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 8, col, fade); },
};

/** Осколки: дорожка печатной платы с переходами и чипами. */
const circuitY = (x: number, xs: number[]) => {
  if (!inside(x, xs)) return RY - 6;
  const { u } = spanU(x, xs);
  const k = u < 0.3 ? 0 : u < 0.4 ? (u - 0.3) / 0.1 : u < 0.7 ? 1 : u < 0.8 ? 1 - (u - 0.7) / 0.1 : 0;
  return RY - 6 + k * 12;
};
const circuit: RStyle = {
  y: (x, xs) => circuitY(x, xs),
  seg(R, a, b, col, dim) {
    const { ctx, xs } = R;
    ctx.strokeStyle = alpha(col, 0.8 * dim); ctx.lineWidth = 1.6;
    poly(ctx, a, b, (x) => circuitY(x, xs), 2); ctx.stroke();
    ctx.strokeStyle = alpha("#2dd4bf", 0.3 * dim); ctx.lineWidth = 1;
    poly(ctx, a, b, (x) => circuitY(x, xs) + 5, 2); ctx.stroke();
    for (let i = 0; i < xs.length - 1; i++) for (const u of [0.3, 0.4, 0.7, 0.8]) {
      const x = xs[i] + (xs[i + 1] - xs[i]) * u;
      if (x < a || x > b) continue;
      ctx.strokeStyle = alpha("#2dd4bf", 0.85 * dim); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, circuitY(x, xs), 2.6, 0, 7); ctx.stroke();
    }
  },
  mid(R, x, _y, col, k) {
    const { ctx } = R, y = circuitY(x, R.xs);
    ctx.fillStyle = alpha(col, 0.85 * k); ctx.fillRect(x - 7, y - 7, 14, 14);
    ctx.strokeStyle = alpha("#2dd4bf", k); ctx.lineWidth = 1;
    ctx.beginPath(); for (const d of [-4, 0, 4]) { ctx.moveTo(x + d, y - 7); ctx.lineTo(x + d, y - 10); ctx.moveTo(x + d, y + 7); ctx.lineTo(x + d, y + 10); } ctx.stroke();
  },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 8, col, fade); R.ctx.fillStyle = alpha("#ffffff", fade); R.ctx.fillRect(x - 2, y - 2, 4, 4); },
};

/** Разбитый экран: трещина с ответвлениями, импульс — вспышка. */
const jag = (i: number) => (h1(i * 31) - 0.5) * 9;
const crackY = (x: number) => { const i = Math.floor(x / 9), f = x / 9 - i; return RY + jag(i) + (jag(i + 1) - jag(i)) * f; };
const crackStyle: RStyle = {
  y: crackY,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    ctx.strokeStyle = alpha(lighten(col, 0.6), 0.85 * dim); ctx.lineWidth = 1;
    poly(ctx, a, b, crackY, 9); ctx.stroke();
    ctx.lineWidth = 0.7;
    for (let i = Math.ceil(a / 9); i * 9 < b; i++) {
      if (h1(i * 5) < 0.78) continue;
      const x = i * 9, y = crackY(x), up = h1(i) < 0.5 ? -1 : 1, l = 6 + h1(i * 9) * 10;
      ctx.strokeStyle = alpha(lighten(col, 0.6), 0.5 * dim);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l * 0.5, y + up * l); ctx.stroke();
    }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    ctx.strokeStyle = alpha("#ffffff", 0.8 * k); ctx.lineWidth = 0.8;
    ctx.beginPath(); for (let i = 0; i < 7; i++) { const a = i * 0.9 + 0.3, l = 5 + (i % 3) * 3; ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); } ctx.stroke();
    glow(ctx, x, y, 9, col, k * 0.8);
  },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 11, col, fade); },
};

/** Взгляд: тонкая линия, мерцающие звёздочки, сердце в перехватах. */
const sparkle: RStyle = {
  y: () => RY,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.strokeStyle = alpha(col, 0.55 * dim); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a, RY); ctx.lineTo(b, RY); ctx.stroke();
    for (let x = Math.ceil(a / 23) * 23; x < b; x += 23) {
      const q = h1(x), tw = Math.abs(Math.sin(t * 1.6 + q * 9)), L = lit(R, x);
      ctx.fillStyle = alpha(L > 0.3 ? "#ffffff" : lighten(col, 0.3), Math.min(1, (0.3 + 0.6 * tw + L * 0.4) * dim));
      star(ctx, x, RY + (q - 0.5) * 22, 1.5 + tw * 2.5 + L * 2);
    }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R, s = 7;
    glow(ctx, x, y, 12, col, 0.6 * k);
    ctx.fillStyle = alpha(col, k);
    ctx.beginPath(); ctx.moveTo(x, y + s * 0.7);
    ctx.bezierCurveTo(x - s * 1.3, y - s * 0.2, x - s * 0.55, y - s * 1.2, x, y - s * 0.35);
    ctx.bezierCurveTo(x + s * 0.55, y - s * 1.2, x + s * 1.3, y - s * 0.2, x, y + s * 0.7);
    ctx.fill();
  },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 9, col, 0.7 * fade); R.ctx.fillStyle = alpha("#ffffff", fade); star(R.ctx, x, y, 7); },
};

/** Кот: меловая двойная линия с дрожью, в перехватах — звёздочки. */
const chalk: RStyle = {
  y: () => RY,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R, fr = Math.floor(t * 6);
    for (let k = 0; k < 2; k++) {
      ctx.strokeStyle = alpha(lighten(col, 0.6), (k ? 0.35 : 0.8) * dim); ctx.lineWidth = k ? 0.7 : 1.3;
      poly(ctx, a, b, (x) => RY + k * 2.5 + (h1(Math.floor(x / 7) * 13 + k * 7 + fr) - 0.5) * 1.6, 7); ctx.stroke();
    }
    for (let x = Math.ceil(a / 37) * 37; x < b; x += 37) { ctx.fillStyle = alpha("#ffffff", (0.3 + 0.5 * lit(R, x)) * dim); star(ctx, x, RY - 9 + h1(x) * 18, 1.5 + lit(R, x) * 2.5); }
  },
  mid(R, x, y, col, k) { R.ctx.fillStyle = alpha(lighten(col, 0.7), k); star(R.ctx, x, y, 7); glow(R.ctx, x, y, 12, col, 0.4 * k); },
  head(R, x, y, _col, fade) { R.ctx.fillStyle = alpha("#ffffff", fade); star(R.ctx, x, y, 5); },
};

/** Маркировка: пунктир, мишени [+] в перехватах, импульс — крестик X. */
const marks: RStyle = {
  y: () => RY,
  tail: false,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.setLineDash([6, 4]); ctx.lineDashOffset = -t * 24;
    ctx.strokeStyle = alpha("#f5f5f5", 0.7 * dim); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(a, RY); ctx.lineTo(b, RY); ctx.stroke(); ctx.setLineDash([]);
    for (let x = Math.ceil(a / 18) * 18; x < b; x += 18) { const L = lit(R, x); if (L > 0.2) { ctx.fillStyle = alpha(col, L * dim); ctx.fillRect(x - 3, RY + 5, 6, 6); } }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    ctx.strokeStyle = alpha("#f5f5f5", k); ctx.lineWidth = 1.2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.beginPath(); ctx.moveTo(x + sx * 9, y + sy * 5); ctx.lineTo(x + sx * 9, y + sy * 9); ctx.lineTo(x + sx * 5, y + sy * 9); ctx.stroke(); }
    ctx.fillStyle = alpha(col, k); ctx.fillRect(x - 3.5, y - 0.75, 7, 1.5); ctx.fillRect(x - 0.75, y - 3.5, 1.5, 7);
  },
  head(R, x, y, col, fade) {
    const { ctx } = R;
    ctx.strokeStyle = alpha(col, fade); ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
  },
};

/** Луч: тонкая яркая нить, в перехватах — блик с анаморфной полосой. */
const flare: RStyle = {
  y: () => RY,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    for (const [lw, al] of [[6, 0.08], [1.2, 0.85]] as const) { ctx.strokeStyle = alpha(lighten(col, 0.6), al * dim); ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(a, RY); ctx.lineTo(b, RY); ctx.stroke(); }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    const g = ctx.createLinearGradient(x - 60, 0, x + 60, 0);
    g.addColorStop(0, alpha(col, 0)); g.addColorStop(0.5, alpha("#ffffff", 0.7 * k)); g.addColorStop(1, alpha(col, 0));
    ctx.fillStyle = g; ctx.fillRect(x - 60, y - 1, 120, 2);
    glow(ctx, x, y, 14, col, k);
    ctx.strokeStyle = alpha("#ffffff", 0.6 * k); ctx.lineWidth = 0.8; ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + R.t * 0.2; ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 12, y + Math.sin(a) * 12); }
    ctx.stroke();
  },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 10, col, fade); R.ctx.fillStyle = alpha("#ffffff", 0.4 * fade); R.ctx.fillRect(x - 24, y - 0.5, 48, 1); },
};

/** Сфера: цепочка карточек, под импульсом — переворачиваются цветом. */
const cards: RStyle = {
  y: () => RY,
  tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    ctx.strokeStyle = alpha(col, 0.3 * dim); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a, RY); ctx.lineTo(b, RY); ctx.stroke();
    for (let x = Math.ceil(a / 22) * 22; x < b; x += 22) {
      const L = lit(R, x), sx = 0.3 + 0.7 * Math.abs(Math.cos(L * Math.PI));
      ctx.fillStyle = L > 0.5 ? alpha(col, 0.9 * dim) : alpha("#1e3a8a", 0.8 * dim);
      ctx.beginPath(); ctx.roundRect(x - 6 * sx, RY - 8, 12 * sx, 16, 3); ctx.fill();
      ctx.strokeStyle = alpha("#93c5fd", 0.5 * dim); ctx.stroke();
    }
  },
  mid(R, x, y, col, k) { const { ctx } = R; ctx.fillStyle = alpha(col, k); ctx.beginPath(); ctx.roundRect(x - 9, y - 12, 18, 24, 4); ctx.fill(); ctx.strokeStyle = alpha("#ffffff", k); ctx.stroke(); },
  head() { /* карточки переворачиваются сами */ },
};

/** Рамен: три волнистые лапшины, в перехватах — яйцо. */
const noodle: RStyle = {
  y: (x, _xs, t) => RY + Math.sin(x / 11 + t * 2) * 3,
  seg(R, a, b, _col, dim) {
    const { ctx, t } = R;
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = alpha("#efe0c2", (0.45 + k * 0.15) * dim); ctx.lineWidth = 1.6;
      poly(ctx, a, b, (x) => RY + (k - 1) * 3 + Math.sin(x / (9 + k * 2) + t * 2 + k) * 3, 2); ctx.stroke();
    }
  },
  mid(R, x, y, _col, k) {
    const { ctx } = R;
    ctx.fillStyle = alpha("#ffffff", k); ctx.beginPath(); ctx.ellipse(x, y, 9, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = alpha("#f29a1c", k); ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill();
  },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 8, col, fade); },
};

/** Дерзкий: по линии шагают отпечатки лап. */
function paw(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath(); ctx.ellipse(x, y + s * 0.3, s * 0.55, s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
  for (const [dx, dy] of [[-0.55, -0.35], [-0.2, -0.7], [0.2, -0.7], [0.55, -0.35]]) { ctx.beginPath(); ctx.ellipse(x + dx * s, y + dy * s, s * 0.17, s * 0.22, 0, 0, Math.PI * 2); ctx.fill(); }
}
const paws: RStyle = {
  y: () => RY,
  tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    for (let x = Math.ceil(a / 20) * 20, i = 0; x < b; x += 20, i++) {
      const L = lit(R, x), up = Math.floor(x / 20) % 2 ? -4 : 4;
      ctx.fillStyle = alpha(L > 0.3 ? "#f0a6b8" : col, (0.3 + 0.7 * L) * dim);
      paw(ctx, x, RY + up, 5);
      void i;
    }
  },
  mid(R, x, y, _col, k) { R.ctx.fillStyle = alpha("#f0a6b8", k); paw(R.ctx, x, y, 9); },
  head() { /* лапы загораются под импульсом */ },
};

/** Номер узла по его x (метки рисуются точно под иконками). */
const nodeI = (R: RC, x: number) => Math.max(0, R.xs.findIndex((v) => Math.abs(v - x) < 0.5));
function pix(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, p: number) {
  rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch === "X") ctx.fillRect(Math.round(x + i * p), Math.round(y + j * p), p, p); }));
}
function label(ctx: CanvasRenderingContext2D, txt: string, x: number, y: number, font: string, col: string) {
  ctx.fillStyle = col; ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(txt, x, y); ctx.textAlign = "left";
}

/** Офлайн: пиксельная земля с камушками, у узлов — кактусы, импульс — прыгающий блок. */
const ground: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    ctx.fillStyle = alpha("#f2f2f2", 0.75 * dim); ctx.fillRect(a, RY, b - a, 2);
    for (let x = Math.ceil(a / 7) * 7; x < b; x += 7) { const n = h1(x); if (n < 0.45) { ctx.fillStyle = alpha(lit(R, x) > 0.3 ? col : "#f2f2f2", 0.6 * dim); ctx.fillRect(x, RY + 4 + n * 8, n < 0.15 ? 3 : 2, 2); } }
  },
  mid(R, x, y, _col, k) { R.ctx.fillStyle = alpha("#f2f2f2", k); pix(R.ctx, ["..X..", "X.X.X", "XXXXX", "..X..", "..X.."], x - 5, y - 10, 2); },
  head(R, x, y, col, fade) { R.ctx.fillStyle = alpha(col, fade); const j = Math.abs(Math.sin(x / 30)) * 10; R.ctx.fillRect(Math.round(x) - 4, y - 9 - j, 8, 8); },
};

/** Утро: линия от руки, у узлов — чашки, импульс — кофейное зерно. */
const doodle: RStyle = {
  y: (x, _xs, t) => RY + Math.sin(x / 40 + t * 0.6) * 1.5,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.lineCap = "round"; ctx.strokeStyle = alpha("#f2f2f2", 0.8 * dim); ctx.lineWidth = 2.4;
    poly(ctx, a, b, (x) => RY + Math.sin(x / 40 + t * 0.6) * 1.5, 4); ctx.stroke();
    for (let x = Math.ceil(a / 30) * 30; x < b; x += 30) { const L = lit(R, x); if (L > 0.2) { ctx.fillStyle = alpha(col, L * dim); ctx.beginPath(); ctx.arc(x, RY + 8, 2, 0, 7); ctx.fill(); } }
  },
  mid(R, x, y, _col, k) {
    const { ctx } = R;
    ctx.strokeStyle = alpha("#f2f2f2", k); ctx.fillStyle = alpha("#5b3a32", k); ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.roundRect(x - 6, y - 6, 12, 11, [1, 1, 4, 4]); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + 7, y - 1, 3, -1.5, 1.5); ctx.stroke();
  },
  head(R, x, y, _col, fade) {
    const { ctx } = R;
    ctx.save(); ctx.translate(x, y); ctx.rotate(x / 20);
    ctx.fillStyle = alpha("#8b5a3c", fade); ctx.beginPath(); ctx.ellipse(0, 0, 5, 3.5, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = alpha("#f2f2f2", fade); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-4, 0); ctx.bezierCurveTo(-1, -2, 1, 2, 4, 0); ctx.stroke();
    ctx.restore();
  },
};

/** E=MC²: цепочка «=» мелом, у узлов — «²», импульс — буква E. */
const equals: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    for (let x = Math.ceil(a / 12) * 12; x < b - 6; x += 12) {
      const L = lit(R, x);
      ctx.fillStyle = alpha(L > 0.2 ? col : "#f0f0f0", (0.5 + 0.5 * L) * dim);
      ctx.fillRect(x, RY - 3 + (h1(x) - 0.5), 8, 1.8); ctx.fillRect(x, RY + 2 + (h1(x + 1) - 0.5), 8, 1.8);
    }
  },
  mid(R, x, y, _col, k) { label(R.ctx, "²", x, y - 2, "700 16px 'Segoe Print', 'Ink Free', cursive", alpha("#f0f0f0", k)); },
  head(R, x, y, col, fade) { label(R.ctx, "E", x, y, "700 15px 'Segoe Print', 'Ink Free', cursive", alpha(col, fade)); },
};

/** Элемент: у узлов — плитки таблицы, по линии бегут электроны. */
const ELEMS = ["Pc", "Vp", "Sg", "Fi", "In", "Rt", "Gw"];
const atoms: RStyle = {
  y: () => RY,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.strokeStyle = alpha("#cfcfcf", 0.45 * dim); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a, RY); ctx.lineTo(b, RY); ctx.stroke();
    for (let x = Math.ceil(a / 26) * 26; x < b; x += 26) { const ph = t * 3 + x; ctx.fillStyle = alpha(lit(R, x) > 0.2 ? col : "#e5e5e5", 0.7 * dim); ctx.beginPath(); ctx.arc(x + Math.cos(ph) * 6, RY + Math.sin(ph) * 2.5, 1.6, 0, 7); ctx.fill(); }
  },
  mid(R, x, y, col, k) {
    const { ctx } = R;
    ctx.fillStyle = alpha("#121214", 0.9 * k); ctx.strokeStyle = alpha(col, k); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.roundRect(x - 10, y - 10, 20, 20, 3); ctx.fill(); ctx.stroke();
    label(ctx, ELEMS[nodeI(R, x) % ELEMS.length], x, y + 1, "600 9px Bahnschrift, 'Segoe UI', sans-serif", alpha("#e5e5e5", k));
  },
  head(R, x, y, col, fade) { const { ctx, t } = R; ctx.strokeStyle = alpha(col, 0.5 * fade); ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(x, y, 8, 3, t * 2, 0, 7); ctx.stroke(); ctx.fillStyle = alpha("#ffffff", fade); ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill(); },
};

/** MEH: кремовая волна-эктоплазма, у узлов — маленькие призраки. */
const ectoY = (x: number, t: number) => RY + Math.sin(x / 18 + t * 1.5) * 2.5;
const ecto: RStyle = {
  y: (x, _xs, t) => ectoY(x, t),
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.lineCap = "round";
    for (const [lw, al] of [[7, 0.12], [2, 0.75]] as const) { ctx.strokeStyle = alpha("#efe6b8", al * dim); ctx.lineWidth = lw; poly(ctx, a, b, (x) => ectoY(x, t), 3); ctx.stroke(); }
    for (let x = Math.ceil(a / 24) * 24; x < b; x += 24) { const L = lit(R, x); if (L > 0.2) { ctx.fillStyle = alpha(col, L * dim); ctx.beginPath(); ctx.arc(x, ectoY(x, t), 2.5, 0, 7); ctx.fill(); } }
  },
  mid(R, x, y, _col, k) {
    const { ctx, t } = R, b = Math.sin(t * 2 + x) * 1.5;
    ctx.fillStyle = alpha("#efe6b8", k);
    ctx.beginPath(); ctx.moveTo(x - 7, y + 7 + b); ctx.lineTo(x - 7, y - 2 + b); ctx.arc(x, y - 2 + b, 7, Math.PI, 0); ctx.lineTo(x + 7, y + 7 + b);
    for (let i = 1; i <= 3; i++) ctx.lineTo(x + 7 - i * 4.7, y + (i % 2 ? 4 : 7) + b);
    ctx.fill();
    ctx.fillStyle = alpha("#050505", k); ctx.fillRect(x - 4, y - 2 + b, 3, 1.5); ctx.fillRect(x + 1, y - 2 + b, 3, 1.5);
  },
  head(R, x, y, _col, fade) { const { ctx, t } = R; ctx.strokeStyle = alpha("#efe6b8", fade); ctx.lineWidth = 1.2; ctx.beginPath(); for (let i = 0; i <= 12; i++) { const a = i * 0.8 + t * 4; ctx.lineTo(x + Math.cos(a) * (1 + i * 0.4), y - i * 0.9 + Math.sin(a) * (1 + i * 0.4)); } ctx.stroke(); },
};

/** Коробка (светлая): нитка пряжи, у узлов — клубки, импульс катится клубком. */
const yarn: RStyle = {
  y: (x, _xs, t) => RY + Math.sin(x / 14 + t) * 2,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.strokeStyle = alpha("#3a3a3a", 0.75 * dim); ctx.lineWidth = 1.6;
    poly(ctx, a, b, (x) => RY + Math.sin(x / 14 + t) * 2, 3); ctx.stroke();
    ctx.strokeStyle = alpha(col, 0.4 * dim); ctx.lineWidth = 1; poly(ctx, a, b, (x) => RY + Math.sin(x / 9 + t * 1.3) * 3, 3); ctx.stroke();
  },
  mid(R, x, y, _col, k) {
    const { ctx } = R;
    ctx.fillStyle = alpha("#e9a8b8", k); ctx.strokeStyle = alpha("#3a3a3a", k); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - 3, y + 1, 6, -1, 1); ctx.moveTo(x + 6, y - 4); ctx.quadraticCurveTo(x, y, x + 2, y + 7); ctx.stroke();
  },
  head(R, x, y, _col, fade) {
    const { ctx } = R;
    ctx.save(); ctx.translate(x, y); ctx.rotate(x / 6);
    ctx.fillStyle = alpha("#9ec5e8", fade); ctx.strokeStyle = alpha("#3a3a3a", fade); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.moveTo(-3, -4); ctx.lineTo(3, 4); ctx.stroke();
    ctx.restore();
  },
};

/** Формулы: синусоида мелом, у узлов — «∫», импульс — точка мела. */
const sine: RStyle = {
  y: (x) => RY + Math.sin(x / 9) * 4,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    ctx.strokeStyle = alpha("#ececec", 0.7 * dim); ctx.lineWidth = 1.5; ctx.setLineDash([9, 2, 4, 2]);
    poly(ctx, a, b, (x) => RY + Math.sin(x / 9) * 4, 2); ctx.stroke(); ctx.setLineDash([]);
    for (let x = Math.ceil(a / 40) * 40; x < b; x += 40) { const L = lit(R, x); if (L > 0.2) { ctx.fillStyle = alpha(col, L * dim); ctx.font = "italic 10px 'Segoe Print', cursive"; ctx.fillText("dx", x, RY + 16); } }
  },
  mid(R, x, y, _col, k) { label(R.ctx, "∫", x, y, "italic 20px 'Segoe Print', 'Ink Free', cursive", alpha("#ececec", k)); },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 7, col, fade); },
};

/** Overthinking: цепочка пузырьков мыслей, у узлов — облачко с «?». */
const bubbles: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.lineWidth = 1.1;
    for (let x = Math.ceil(a / 14) * 14; x < b; x += 14) { const r = 1.5 + Math.abs(Math.sin(x / 30 + t * 1.5)) * 2.2, L = lit(R, x); ctx.strokeStyle = alpha(L > 0.2 ? col : "#f2f2f2", (0.55 + 0.45 * L) * dim); ctx.beginPath(); ctx.arc(x, RY, r + L * 2, 0, 7); ctx.stroke(); }
  },
  mid(R, x, y, _col, k) {
    const { ctx } = R;
    ctx.fillStyle = alpha("#000000", k); ctx.strokeStyle = alpha("#f2f2f2", k); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.ellipse(x, y, 11, 8, 0, 0, 7); ctx.fill(); ctx.stroke();
    label(ctx, "?", x, y + 1, "400 12px 'Ink Free', cursive", alpha("#f2f2f2", k));
  },
  head(R, x, y, col, fade) { label(R.ctx, "?", x, y - 8, "400 14px 'Ink Free', cursive", alpha(col, fade)); },
};

/** Дедлайн: полоса — красная до импульса, белая после; у узлов — песочные часы. */
const progress: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, _col, dim) {
    const { ctx } = R, hx = R.heads.length ? Math.max(...R.heads.map((h) => h.x)) : -1;
    ctx.fillStyle = alpha("#f4f4f5", 0.85 * dim); ctx.fillRect(a, RY - 2.5, b - a, 5);
    if (hx > a) { ctx.fillStyle = alpha("#e11d2a", dim); ctx.fillRect(a, RY - 2.5, Math.min(b, hx) - a, 5); }
  },
  mid(R, x, y, _col, k) {
    const { ctx, t } = R, f = (t * 0.3 + x / 100) % 1;
    ctx.strokeStyle = alpha("#f4f4f5", k); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(x - 5, y - 9); ctx.lineTo(x + 5, y - 9); ctx.lineTo(x - 5, y + 9); ctx.lineTo(x + 5, y + 9); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = alpha("#e11d2a", k);
    ctx.beginPath(); ctx.moveTo(x - 4 * (1 - f), y - 8 + 7 * f); ctx.lineTo(x + 4 * (1 - f), y - 8 + 7 * f); ctx.lineTo(x, y); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 4 * f, y + 8 - 6 * f); ctx.lineTo(x + 4 * f, y + 8 - 6 * f); ctx.lineTo(x + 4, y + 8); ctx.lineTo(x - 4, y + 8); ctx.fill();
  },
  head(R, x, y, _col, fade) { const { ctx } = R; ctx.strokeStyle = alpha("#e11d2a", fade); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x + 6, y - 14); ctx.quadraticCurveTo(x + 14, y - 16, x + 16, y - 9); ctx.stroke(); },
};

/** Ctrl+Alt+Del: у узлов — клавиши, импульс — курсор-блок, стирающий линию. */
const KEYS = ["Ctrl", "Alt", "Del", "Esc", "Tab", "Fn", "Win"];
const keycaps: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, col, dim) {
    const { ctx } = R;
    ctx.strokeStyle = alpha("#f5f5f5", 0.65 * dim); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(a, RY); ctx.lineTo(b, RY); ctx.stroke();
    for (const h of R.heads) if (h.x > a && h.x < b) { ctx.fillStyle = "#000"; ctx.fillRect(h.x - 30, RY - 2, 24, 4); ctx.fillStyle = alpha(col, 0.5 * dim); ctx.fillRect(h.x - 30, RY - 0.5, 24, 1); }
  },
  mid(R, x, y, _col, k) {
    const { ctx } = R;
    ctx.fillStyle = alpha("#1a1a1a", k); ctx.strokeStyle = alpha("#f5f5f5", k); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.roundRect(x - 13, y - 9, 26, 18, 4); ctx.fill(); ctx.stroke();
    label(ctx, KEYS[nodeI(R, x) % KEYS.length], x, y + 0.5, "600 8.5px 'Segoe UI', sans-serif", alpha("#f5f5f5", k));
  },
  head(R, x, y, col, fade) { R.ctx.fillStyle = alpha(col, fade * (Math.floor(R.t * 4) % 2 ? 1 : 0.5)); R.ctx.fillRect(x - 3, y - 8, 7, 16); },
};

/** while(alive): стрелки «→», у узлов — «()», импульс — «;». */
const arrows: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, col, dim) {
    const { ctx, t } = R;
    ctx.font = "600 11px Consolas, monospace"; ctx.textBaseline = "middle";
    const off = (t * 20) % 16;
    for (let x = Math.ceil(a / 16) * 16 + off; x < b - 6; x += 16) { const L = lit(R, x); ctx.fillStyle = alpha(L > 0.2 ? "#f472b6" : col, (0.45 + 0.55 * L) * dim); ctx.fillText("→", x, RY); }
  },
  mid(R, x, y, _col, k) { const { ctx } = R; ctx.fillStyle = alpha("#000000", k); ctx.fillRect(x - 12, y - 9, 24, 18); label(ctx, "()", x, y, "600 14px 'Segoe UI', sans-serif", alpha("#f5f5f5", k)); },
  head(R, x, y, col, fade) { label(R.ctx, ";", x, y, "700 16px Consolas, monospace", alpha(col, fade)); },
};

/** N*PE (светлая): чёрная пиксельная линия, у узлов — «*». */
const inkPix: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, _col, dim) {
    const { ctx } = R;
    for (let x = Math.ceil(a / 6) * 6; x < b; x += 6) { const L = lit(R, x); ctx.fillStyle = alpha("#0a0a0a", (0.55 + 0.45 * L) * dim); ctx.fillRect(x, RY - 2 - (L > 0.4 ? 3 : 0), 4, 4); }
  },
  mid(R, x, y, _col, k) { R.ctx.fillStyle = alpha("#0a0a0a", k); pix(R.ctx, ["X...X", ".X.X.", "XXXXX", ".X.X.", "X...X"], x - 7, y - 7, 3); },
  head(R, x, y, _col, fade) { R.ctx.fillStyle = alpha("#0a0a0a", fade); R.ctx.fillRect(Math.round(x / 6) * 6 - 4, y - 10, 8, 8); },
};

/** Hello world: по линии бегут буквы «hello world» разными цветами. */
const HW_COL = ["#22c55e", "#60a5fa", "#facc15", "#f472b6", "#fb923c", "#c084fc"];
const helloLine: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, _col, dim) {
    const { ctx } = R, msg = "hello world ";
    ctx.font = "600 11px Consolas, monospace"; ctx.textBaseline = "middle";
    for (let i = Math.ceil(a / 8); i * 8 < b; i++) { const x = i * 8, L = lit(R, x); ctx.fillStyle = alpha(HW_COL[i % HW_COL.length], (0.35 + 0.65 * L) * dim); ctx.fillText(msg[i % msg.length], x, RY - L * 4); }
  },
  mid(R, x, y, _col, k) { const { ctx } = R; ctx.fillStyle = alpha("#0b0b0c", k); ctx.fillRect(x - 11, y - 9, 22, 18); label(ctx, "{}", x, y, "700 14px Consolas, monospace", alpha(HW_COL[nodeI(R, x) % HW_COL.length], k)); },
  head() { /* буквы подпрыгивают сами */ },
};

/** Питомец (светлая LCD): точки-пиксели, у узлов — сердечки, импульс — еда. */
const lcd: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, _col, dim) {
    const { ctx } = R;
    for (let x = Math.ceil(a / 6) * 6; x < b; x += 6) { const L = lit(R, x); ctx.fillStyle = alpha("#2e3529", (0.35 + 0.65 * L) * dim); ctx.fillRect(x, RY - 2, 4, 4); }
  },
  mid(R, x, y, _col, k) { R.ctx.fillStyle = alpha("#2e3529", k); pix(R.ctx, [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."], x - 7, y - 6, 2); },
  head(R, x, y, _col, fade) { R.ctx.fillStyle = alpha("#2e3529", fade); pix(R.ctx, ["..XX..", ".XXXX.", "XXXXXX", "XXXXXX", ".XXXX."], x - 6, y - 12, 2); },
};

/** Виджеты (светлая): тёмная скруглённая шкала, у узлов — плитки, импульс — лист. */
const slider: RStyle = {
  y: () => RY, tail: false,
  seg(R, a, b, _col, dim) {
    const { ctx } = R, hx = R.heads.length ? Math.max(...R.heads.map((h) => h.x)) : -1;
    ctx.strokeStyle = alpha("#2b302d", 0.8 * dim); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.roundRect(a, RY - 4, b - a, 8, 4); ctx.stroke();
    if (hx > a) { ctx.fillStyle = alpha("#2b302d", 0.85 * dim); ctx.beginPath(); ctx.roundRect(a + 1.5, RY - 2.5, Math.max(4, Math.min(b, hx) - a - 3), 5, 2.5); ctx.fill(); }
  },
  mid(R, x, y, _col, k) {
    const { ctx } = R;
    ctx.fillStyle = alpha("#2b302d", 0.35 * k); ctx.beginPath(); ctx.roundRect(x - 8, y - 7, 18, 18, 5); ctx.fill();
    ctx.fillStyle = alpha("#f3f3f0", k); ctx.strokeStyle = alpha("#2b302d", k); ctx.lineWidth = 1.3; ctx.beginPath(); ctx.roundRect(x - 10, y - 9, 18, 18, 5); ctx.fill(); ctx.stroke();
  },
  head(R, x, y, _col, fade) { const { ctx } = R; ctx.save(); ctx.translate(x, y - 12); ctx.rotate(Math.sin(R.t * 3) * 0.5); ctx.fillStyle = alpha("#4a504b", fade); ctx.beginPath(); ctx.moveTo(-6, 0); ctx.quadraticCurveTo(0, -4, 6, 0); ctx.quadraticCurveTo(0, 4, -6, 0); ctx.fill(); ctx.restore(); },
};

const STYLE_OF: Record<string, RStyle | undefined> = {
  plexus: mesh, web: silk, ascii: code(false), editor: code(true), retro: retroStyle, glitch: glitchStyle(false), nosignal: glitchStyle(false),
  poster: glitchStyle(true), hud: pixelBar, runes: runeStyle, hex: hexStyle, bloom: vine, shards: circuit, cracked: crackStyle, anime: sparkle,
  cat: chalk, techmark: marks, bekind: retroStyle, beam: flare, sphere: cards, ramen: noodle, sassy: paws, focus: sparkle,
  offline: ground, blob: doodle, emc2: equals, element: atoms, meh: ecto, catbox: yarn, formula: sine, overthink: bubbles,
  deadline: progress, cad: keycaps, alive: arrows, nope: inkPix, hello: helloLine, pet: lcd, widgets: slider,
};

/** Лента для мини-маршрута (вырез): несколько перекрученных нитей. */
const strands: RStyle = {
  y: (x, xs, t) => centerY(x, xs, t),
  seg(R, a, b, col, dim) {
    const { ctx, xs, t } = R;
    const rainbow = document.documentElement.dataset.scene === "spectrum";
    for (let j = 0; j < STRANDS; j++) {
      const depth = (Math.sin(t * 0.55 + (j * Math.PI) / (STRANDS - 1)) + 1) / 2;
      ctx.strokeStyle = alpha(rainbow ? SPEC[j % SPEC.length] : lighten(col, 0.35), dim * (0.3 + 0.55 * depth));
      ctx.lineWidth = 1;
      poly(ctx, a, b, (x) => strandY(x, xs, j, t)); ctx.stroke();
    }
  },
  mid(R, x, y, col, k) { glow(R.ctx, x, y, 12, col, k); },
  head(R, x, y, col, fade) { glow(R.ctx, x, y, 9, col, fade); },
};

/**
 * Мини-маршрут в стиле темы (вырез сверху): та же отрисовка, что у большого,
 * уменьшенная. Линия — на высоте `lineY`; рисуется, только пока панель открыта.
 */
export function mountStrip(canvas: HTMLCanvasElement, lineY: number, k: number) {
  let xs: number[] = [], segs: Flow[] = [], raf = 0, last = 0, on = false;
  const frame = (now: number) => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || xs.length < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, dpr * (lineY - RY * k));
    const motion = motionOn(), t = motion ? now / 1000 : 1.1;
    const X = xs.map((x) => x / k);
    const c = { accent: css("--accent"), ice: css("--ice"), state: css("--state"), warn: css("--warn"), bad: css("--bad"), idle: css("--idle") };
    const st = STYLE_OF[document.documentElement.dataset.scene ?? "prism"] ?? strands;
    drawStyled(st, ctx, { xs: X, segs, c, t, now, motion, grow: 1, x0: X[0] - 10, x1: X[X.length - 1] + 10, reach: 1e9 });
  };
  const loop = (now: number) => {
    raf = 0;
    if (!on || !canvas.isConnected || document.visibilityState !== "visible") return;
    if (now - last >= 33) { last = now; frame(now); }
    if (motionOn()) raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (on && !raf) raf = requestAnimationFrame(loop); };
  document.addEventListener("visibilitychange", kick);
  return {
    set(nx: number[], ns: Flow[]) { xs = nx; segs = ns; last = 0; kick(); },
    active(v: boolean) { on = v; kick(); },
  };
}
export type { Flow };

function drawStyled(st: RStyle, ctx: CanvasRenderingContext2D, F: Frame) {
  const { xs, segs, c, t, now, motion, grow, x0, x1, reach } = F;
  // Импульсы считаются заранее: темы подсвечивают ими свои звенья.
  const heads: Head[] = [];
  let live = 0;
  while (live < segs.length && (segs[live] === "live" || segs[live] === "slow")) live++;
  if (motion && grow >= 1 && live > 0) {
    const from = x0 + 24, to = live >= segs.length ? x1 - 16 : xs[live];
    const span = to - from + 140, speed = segs.includes("slow") ? 90 : 190;
    for (let k = 0; k < 2; k++) {
      const hx = from - 70 + ((((now / 1000) * speed) / span + k / 2) % 1) * span;
      if (hx < from || hx > to) continue;
      heads.push({ x: hx, col: segColor(segs[segOf(hx, xs)] ?? "live", segOf(hx, xs), c), fade: Math.min(1, (hx - from) / 60, (to - hx) / 60) });
    }
  }
  const R: RC = { ctx, xs, t, heads };
  ctx.globalCompositeOperation = "lighter";
  segs.forEach((f, i) => {
    const a = i === 0 ? x0 : xs[i], b = i === segs.length - 1 ? x1 : xs[i + 1];
    if (a >= reach) return;
    st.seg(R, a, Math.min(b, reach), segColor(f, i, c), f === "idle" ? 0.35 : f === "broken" ? 0.55 : 1, f);
  });
  // Метки — точно под иконками узлов; в вырезе иконки сами стоят на линии — там без меток.
  if (F.marks) for (let i = 0; i < xs.length; i++) {
    const si = Math.max(0, Math.min(segs.length - 1, i - 1)), f = segs[si], x = xs[i];
    if (f === "idle" || x > reach) continue;
    st.mid(R, x, st.y(x, xs, t), segColor(f, si, c), motion ? 0.8 + 0.2 * Math.sin(t * 2.2 + i) : 1, f);
  }
  for (const h of heads) {
    if (st.tail !== false) for (let d = 3; d < 60; d += 3) {
      ctx.fillStyle = alpha(h.col, (1 - d / 60) * 0.5 * h.fade);
      ctx.beginPath(); ctx.arc(h.x - d, st.y(h.x - d, xs, t), 1.6 * (1 - d / 90), 0, 7); ctx.fill();
    }
    st.head(R, h.x, st.y(h.x, xs, t), h.col, h.fade);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}


function loop(now: number) {
  raf = 0;
  if (!canvas || !cur || !canvas.clientWidth || document.visibilityState !== "visible") return;
  if (now - lastFrame >= 33) { lastFrame = now; draw(now); }
  if (motionOn()) raf = requestAnimationFrame(loop);
}
const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

function placeNodes() {
  if (!wrap || !cur) return;
  const w = wrap.clientWidth;
  if (!w) return;
  const xs = xsOf(w, cur.nodes.length);
  wrap.querySelectorAll<HTMLElement>(".rn2").forEach((d, i) => { d.style.left = `${(xs[i] ?? 0).toFixed(1)}px`; });
}

let wired = false;

export function renderRoute(el: HTMLElement, s: Snapshot) {
  wrap = el;
  canvas = el.querySelector("canvas");
  const m = model(s);
  if (!wired) {
    wired = true;
    document.addEventListener("visibilitychange", kick);
    new ResizeObserver(() => { lastFrame = 0; placeNodes(); kick(); }).observe(el);
  }
  const box = el.querySelector<HTMLElement>(".rt-nodes")!;
  // Маршрут сменился (каскад, другая точка, вход) — прорастить заново.
  const sSig = m.nodes.map((n) => n.key).join("|");
  if (sSig !== structSig) {
    structSig = sSig;
    textSig = "";
    grownAt = performance.now();
    box.innerHTML = m.nodes.map((_, i) => `<div class="rn2" style="animation-delay:${(i * 0.17).toFixed(2)}s"></div>`).join("");
  }
  cur = m;
  const tSig = JSON.stringify(m.nodes);
  if (tSig !== textSig) {
    textSig = tSig;
    m.nodes.forEach((n, i) => {
      const d = box.children[i] as HTMLElement;
      d.classList.remove("ok", "bad", "off", "tun");
      d.classList.add(...n.cls.split(" ").filter(Boolean));
      d.title = n.title;
      d.innerHTML = `<span class="ico">${ICON[n.icon]}</span><b>${esc(n.label)}</b>${n.meta ? `<small class="${n.metaCls}">${esc(n.meta)}</small>` : ""}${
        n.pts ? `<span class="pts">${n.pts.map((p) => `<i class="${p.cls}" title="${esc(p.title)}"></i>`).join("")}</span>` : ""}`;
    });
    placeNodes();
  }
  lastFrame = 0;
  kick();
}
