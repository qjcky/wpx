import { SCENES, type SceneId } from "./scenes";

// Оформление: акцент (материал и выбор), тон фона, яркость граней, цвет графика
// задержки. Хранится в localStorage — общее для окна и выреза; цвета состояний
// (мятный, янтарный, розовый) не меняются. Все цвета палитры — одной светлоты
// и насыщенности, поэтому сочетаются при любом выборе.

export interface Theme {
  accent: string;
  base: BaseId;
  prism: "bright" | "soft" | "off";
  pulse: "cyan" | "accent" | "state";
  /** Анимация: всегда, как в системе (в RDP Windows просит её выключить) или выключить. */
  motion: "on" | "system" | "off";
  /** Тема-сцена: живой фон окна и выреза (scenes.ts). */
  scene: SceneId;
}

export type BaseId = "noir" | "graphite" | "midnight" | "plum";

export const ACCENTS: [string, string][] = [
  ["Аметист", "#9b6bff"],
  ["Лаванда", "#a78bfa"],
  ["Индиго", "#818cf8"],
  ["Небо", "#7dd3fc"],
  ["Мята", "#5eead4"],
  ["Роза", "#f472b6"],
  ["Платина", "#e2e8f0"],
];

/** Тон фона: окно, поверхности, наведение. Линии — полупрозрачные, общие. */
export const BASES: Record<BaseId, { name: string; bg: string; surface: string; raised: string; hover: string }> = {
  noir: { name: "Noir", bg: "#06070b", surface: "#0c0e15", raised: "#131621", hover: "#1a1e2c" },
  graphite: { name: "Графит", bg: "#09090b", surface: "#111113", raised: "#18181b", hover: "#222226" },
  midnight: { name: "Полночь", bg: "#040714", surface: "#0a0f20", raised: "#10172d", hover: "#18203b" },
  plum: { name: "Слива", bg: "#09060d", surface: "#110c17", raised: "#181120", hover: "#21182c" },
};

/** Простые темы: ровные поверхности без отсвета акцента (светлые — белые карточки). */
const PLAIN: Partial<Record<SceneId, { surface: string; raised: string; hover: string }>> = {
  light: { surface: "#ffffff", raised: "#eceef1", hover: "#e2e5e9" },
  sepia: { surface: "#fbf6ee", raised: "#ece2d2", hover: "#e3d7c4" },
  dark: { surface: "#24262b", raised: "#2c2f35", hover: "#363940" },
  black: { surface: "#0c0c0d", raised: "#151517", hover: "#1e1e21" },
};

/** «Как в Windows» — светлая или тёмная по системе; остальные — как есть. */
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
export const resolveScene = (id: SceneId): SceneId => (id === "auto" ? (systemDark() ? "dark" : "light") : id);

export const PULSES: [Theme["pulse"], string][] = [["accent", "как акцент"], ["cyan", "голубой"], ["state", "цвет состояния"]];
export const MOTIONS: [Theme["motion"], string][] = [["on", "всегда"], ["system", "как в системе"], ["off", "выключить"]];

const DEFAULT: Theme = { accent: "#e9e7ff", base: "noir", prism: "bright", pulse: "accent", motion: "on", scene: "cat" };
const KEY = "wpx.theme";
const ICE = "#e0e7ff";

export function loadTheme(): Theme {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Theme>;
    return {
      accent: /^#[0-9a-f]{6}$/i.test(t.accent ?? "") ? t.accent! : DEFAULT.accent,
      base: t.base && t.base in BASES ? t.base : DEFAULT.base,
      prism: t.prism === "soft" || t.prism === "off" ? t.prism : DEFAULT.prism,
      pulse: t.pulse === "cyan" || t.pulse === "state" ? t.pulse : DEFAULT.pulse,
      motion: t.motion === "system" || t.motion === "off" ? t.motion : DEFAULT.motion,
      scene: SCENES.some((x) => x.id === t.scene) ? t.scene! : DEFAULT.scene,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveTheme(t: Theme) {
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* приватный режим — только на сеанс */ }
}

export const defaultTheme = (): Theme => ({ ...DEFAULT });


const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
function lum(c: number[]) {
  const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Заливка главных кнопок: акцент, притемнённый до контраста 4.5:1 с белым
 * текстом (светлые акценты — платина, мята — иначе нечитаемы).
 */
function deep(accent: string) {
  let c = rgb(accent);
  for (let i = 0; i < 40 && 1.05 / (lum(c) + 0.05) < 4.6; i++) c = c.map((v) => v * 0.94);
  return hex(c);
}

const svgUrl = (s: string) => `url("data:image/svg+xml,${encodeURIComponent(s.replace(/\s+/g, " "))}")`;

/**
 * Грани в левом нижнем углу окна: тёмные плоскости, свет — на рёбрах. Начинаются
 * под навигацией и, гаснув, уходят под содержимое — без края на границе колонки.
 * Рёбра у курсора — prismLeftEdges.
 */
const LEFT_EDGES = "M0 300 L340 45 M30 277.5 L150 340 M0 344 L150 340 M150 340 L340 420";
function prismLeft(a: string, k: number) {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 520 420'>
    <defs>
      <linearGradient id='e1' x1='0' y1='300' x2='400' y2='0' gradientUnits='userSpaceOnUse'><stop stop-color='#fff'/><stop offset='.14' stop-color='${ICE}'/><stop offset='.4' stop-color='${a}'/><stop offset='1' stop-color='${a}' stop-opacity='.1'/></linearGradient>
      <radialGradient id='fan' cx='0' cy='300' r='210' gradientUnits='userSpaceOnUse'><stop stop-color='${ICE}' stop-opacity='${0.5 * k}'/><stop offset='.3' stop-color='${a}' stop-opacity='${0.24 * k}'/><stop offset='1' stop-color='${a}' stop-opacity='0'/></radialGradient>
      <linearGradient id='q1' x1='.1' y1='.2' x2='.6' y2='1'><stop stop-color='${a}' stop-opacity='${0.14 * k}'/><stop offset='.6' stop-color='${a}' stop-opacity='${0.04 * k}'/><stop offset='1' stop-color='${a}' stop-opacity='${0.1 * k}'/></linearGradient>
      <linearGradient id='q2' x1='0' y1='0' x2='1' y2='1'><stop stop-color='${ICE}' stop-opacity='${0.04 * k}'/><stop offset='1' stop-color='${ICE}' stop-opacity='${0.12 * k}'/></linearGradient>
      <radialGradient id='corner' cx='0' cy='420' r='230' gradientUnits='userSpaceOnUse'><stop stop-color='${a}' stop-opacity='${0.42 * k}'/><stop offset='1' stop-color='${a}' stop-opacity='0'/></radialGradient>
      <linearGradient id='fx' x1='0' y1='0' x2='1' y2='0'><stop stop-color='#fff'/><stop offset='.36' stop-color='#fff'/><stop offset='.54' stop-color='#fff' stop-opacity='0'/></linearGradient>
      <mask id='m' maskUnits='userSpaceOnUse' x='0' y='0' width='520' height='420'><rect width='520' height='420' fill='url(#fx)'/></mask>
    </defs>
    <g mask='url(#m)'>
      <path d='M0 300 L400 0 L0 0 Z' fill='url(#fan)'/>
      <path d='M30 277.5 L400 0 L520 0 L520 420 L340 420 L150 340 Z' fill='url(#q1)'/>
      <path d='M0 300 L30 277.5 L150 340 L0 344 Z' fill='url(#q2)'/>
      <path d='M0 344 L150 340 L340 420 L0 420 Z' fill='${a}' fill-opacity='${0.05 * k}'/>
      <rect width='520' height='420' fill='url(#corner)'/>
      <path d='M0 300 L400 0' stroke='url(#e1)' stroke-width='1.2' opacity='${0.95 * k}'/>
      <path d='M30 277.5 L150 340 M0 344 L150 340 M150 340 L340 420' fill='none' stroke='${ICE}' stroke-width='.8' opacity='${0.3 * k}'/>
    </g>
  </svg>`);
}
function prismLeftEdges() {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 520 420'>
    <defs><filter id='b' x='-10%' y='-10%' width='120%' height='120%'><feGaussianBlur stdDeviation='3'/></filter></defs>
    <path d='${LEFT_EDGES}' fill='none' stroke='#fff' stroke-width='9' opacity='.55' filter='url(#b)'/>
    <path d='${LEFT_EDGES}' fill='none' stroke='#fff' stroke-width='1.6'/>
  </svg>`);
}

/**
 * Грани у логотипа: свет состояния преломляется плоскостями с
 * чёткими рёбрами, а не размытым пятном. Это маска (форма и яркость граней),
 * цвет даёт фон с цветом состояния — поэтому грани меняют цвет вместе со связью.
 */
function prismStatus() {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 340 140'>
    <defs>
      <linearGradient id='p1' x1='0' y1='0' x2='.9' y2='.8'><stop stop-color='#fff' stop-opacity='.5'/><stop offset='.55' stop-color='#fff' stop-opacity='.2'/><stop offset='1' stop-color='#fff' stop-opacity='.1'/></linearGradient>
      <linearGradient id='band' x1='0' y1='1' x2='1' y2='0'><stop stop-color='#fff' stop-opacity='0'/><stop offset='.5' stop-color='#fff' stop-opacity='.75'/><stop offset='1' stop-color='#fff' stop-opacity='.15'/></linearGradient>
      <linearGradient id='p2' x1='0' y1='0' x2='1' y2='0'><stop stop-color='#fff' stop-opacity='.16'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>
      <linearGradient id='e1' x1='0' y1='0' x2='0' y2='1'><stop stop-color='#fff'/><stop offset='1' stop-color='#fff' stop-opacity='.5'/></linearGradient>
      <linearGradient id='fade' x1='0' y1='0' x2='0' y2='1'><stop stop-color='#fff'/><stop offset='.75' stop-color='#fff'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>
      <filter id='g' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='4'/></filter>
      <mask id='m' maskUnits='userSpaceOnUse' x='0' y='0' width='340' height='140'><rect width='340' height='140' fill='url(#fade)'/></mask>
    </defs>
    <g mask='url(#m)'>
      <path d='M0 0 H268 L188 88 L0 108 Z' fill='url(#p1)'/>
      <path d='M0 34 L58 0 H104 L0 74 Z' fill='url(#band)'/>
      <path d='M268 0 H340 V30 L202 90 L188 88 Z' fill='url(#p2)'/>
      <path d='M270 0 L188 88' stroke='#fff' stroke-width='7' opacity='.5' filter='url(#g)'/>
      <path d='M270 0 L188 88' stroke='url(#e1)' stroke-width='1.4'/>
      <path d='M188 88 L0 108' stroke='#fff' stroke-width='.9' opacity='.35'/>
    </g>
  </svg>`);
}

/**
 * Кристалл у правого нижнего края окна: под содержимым (рамок у него нет),
 * плоскости с отсветом акцента и тонкие рёбра. Рёбра загораются у курсора —
 * маска prismMainEdges с той же геометрией.
 */
const MAIN_EDGES = "M220 420 L900 120 M560 420 L900 250 M560 420 L780 173 M900 120 L900 420";
function prismMain(a: string, k: number) {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 420'>
    <defs>
      <linearGradient id='e1' x1='220' y1='420' x2='900' y2='120' gradientUnits='userSpaceOnUse'><stop stop-color='${a}' stop-opacity='0'/><stop offset='.45' stop-color='${a}'/><stop offset='.8' stop-color='${ICE}'/><stop offset='1' stop-color='#fff'/></linearGradient>
      <linearGradient id='fan' x1='560' y1='270' x2='520' y2='180' gradientUnits='userSpaceOnUse'><stop stop-color='${ICE}' stop-opacity='${0.16 * k}'/><stop offset='.4' stop-color='${a}' stop-opacity='${0.06 * k}'/><stop offset='1' stop-color='${a}' stop-opacity='0'/></linearGradient>
      <linearGradient id='q1' x1='.4' y1='0' x2='.6' y2='1'><stop stop-color='${a}' stop-opacity='${0.09 * k}'/><stop offset='1' stop-color='${a}' stop-opacity='${0.02 * k}'/></linearGradient>
      <radialGradient id='corner' cx='900' cy='420' r='260' gradientUnits='userSpaceOnUse'><stop stop-color='${a}' stop-opacity='${0.32 * k}'/><stop offset='1' stop-color='${a}' stop-opacity='0'/></radialGradient>
    </defs>
    <path d='M220 420 L900 120 L900 40 L180 420 Z' fill='url(#fan)'/>
    <path d='M220 420 L900 120 L900 250 L560 420 Z' fill='url(#q1)'/>
    <rect width='900' height='420' fill='url(#corner)'/>
    <path d='M220 420 L900 120' stroke='url(#e1)' stroke-width='1' opacity='${0.42 * k}'/>
    <path d='M560 420 L900 250 M560 420 L780 173' fill='none' stroke='${ICE}' stroke-width='.8' opacity='${0.16 * k}'/>
  </svg>`);
}
function prismMainEdges() {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 420'>
    <defs><filter id='b' x='-10%' y='-10%' width='120%' height='120%'><feGaussianBlur stdDeviation='3'/></filter></defs>
    <path d='${MAIN_EDGES}' fill='none' stroke='#fff' stroke-width='9' opacity='.55' filter='url(#b)'/>
    <path d='${MAIN_EDGES}' fill='none' stroke='#fff' stroke-width='1.6'/>
  </svg>`);
}

/** Маска без рёбер: свет курсора нигде не виден (а `none` в mask — «без маски», свет везде). */
const NO_EDGES = "linear-gradient(transparent, transparent)";

/** Поверхности из фона темы-сцены: тот же тон, чуть светлее (у светлых — темнее), с отсветом акцента. */
function sceneBase(bg: string, accent: string, light = false) {
  const [b, a] = [rgb(bg), rgb(accent)];
  const lift = (k: number, ka: number) => hex(b.map((v, i) => v + (255 - v) * k + (a[i] - v) * ka));
  const sink = (k: number) => hex(b.map((v) => v * (1 - k)));
  if (light) return { name: "", bg, surface: sink(0.035), raised: sink(0.065), hover: sink(0.1) };
  return { name: "", bg, surface: lift(0.03, 0.03), raised: lift(0.06, 0.05), hover: lift(0.1, 0.07) };
}

export function applyTheme(t: Theme) {
  const r = document.documentElement.style;
  // «Призма» — тон фона из настроек; у остальных тем своя палитра.
  const sc = SCENES.find((x) => x.id === resolveScene(t.scene));
  const plain = sc && PLAIN[sc.id];
  const b = t.scene === "prism" || !sc ? BASES[t.base] : plain ? { name: "", bg: sc.bg, ...plain } : sceneBase(sc.bg, t.accent, sc.light);
  r.setProperty("--bg", b.bg);
  r.setProperty("--surface", b.surface);
  r.setProperty("--surface-2", b.raised);
  r.setProperty("--surface-3", b.hover);
  r.setProperty("--accent", t.accent);
  r.setProperty("--accent-deep", deep(t.accent));
  r.setProperty("--pulse", t.pulse === "accent" ? t.accent : t.pulse === "state" ? "var(--state)" : "#67e8f9");
  const k = t.scene !== "prism" ? 0 : t.prism === "bright" ? 1 : t.prism === "soft" ? 0.55 : 0;
  r.setProperty("--glow", String(k));
  r.setProperty("--prism-left", k ? prismLeft(t.accent, k) : "none");
  // Превью темы «Призма» в настройках — всегда, при любой выбранной теме.
  r.setProperty("--prism-thumb", prismLeft("#9b6bff", 1));
  r.setProperty("--prism-main", k ? prismMain(t.accent, k) : "none");
  r.setProperty("--prism-left-edges", k ? prismLeftEdges() : NO_EDGES);
  r.setProperty("--prism-status", prismStatus());
  r.setProperty("--prism-main-edges", k ? prismMainEdges() : NO_EDGES);
  document.documentElement.dataset.prism = t.prism;
  document.documentElement.dataset.motion = t.motion;
  // Грани призмы — только у темы «Призма»; у других тем свой фон (scenes.ts).
  document.documentElement.dataset.scene = t.scene;
  // Светлая тема: тёмный текст и линии (themes-2.css, html[data-light]).
  document.documentElement.toggleAttribute("data-light", !!sc?.light);
  // Простая тема: без свечения, граней и сцены (themes-2.css, html[data-plain]).
  document.documentElement.toggleAttribute("data-plain", !!plain);
  // Меню у темы своё: слева, сверху, доком снизу или полосой значков.
  const nav = sc?.nav ?? "side", side = sc?.side ?? (nav === "rail" ? 76 : 220);
  document.documentElement.dataset.nav = nav;
  document.documentElement.dataset.sidew = String(side);
  r.setProperty("--side-w", `${side}px`);
}

/** Применить сохранённое и следить за изменениями из другого окна (виджет). */
export function initTheme(onChange?: () => void) {
  applyTheme(loadTheme());
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    applyTheme(loadTheme());
    onChange?.();
  });
  // «Как в Windows»: система сменила светлую/тёмную — следом.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (loadTheme().scene !== "auto") return;
    applyTheme(loadTheme());
    onChange?.();
  });
}
