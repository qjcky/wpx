/// <reference types="vite/client" />
// Язык интерфейса. Исходный — русский; любой другой — файл `locales/<код>.json`
// (`name`, `exact` — точные строки, `patterns` — шаблоны с `{}`): положите
// файл рядом — язык появится в настройках сам, движок о языках не знает.
// Перевод — живого DOM: новые узлы и изменения текста ловит MutationObserver
// (экраны, панели, окна, ход операций). Холсты переводят строки через `tr()`.
// Трею и уведомлениям словарь передаётся в бэкенд (`backendLocale`).

export interface Locale {
  /** Название языка на нём самом: «English», «Deutsch». */
  name: string;
  exact: Record<string, string>;
  /** `{}` — подстановка по порядку; в переводе можно `{1}`, `{2}`. */
  patterns: [string, string][];
}

const FILES = import.meta.glob<{ default: Locale }>("../locales/*.json", { eager: true });
const LOCALES: Record<string, Locale> = Object.fromEntries(
  Object.entries(FILES).map(([path, m]) => [path.replace(/^.*\/([\w-]+)\.json$/, "$1"), m.default]),
);
/** Языки для выбора: код и название. */
export const LANGS: [string, string][] = [["ru", "Русский"], ...Object.entries(LOCALES).map(([k, l]) => [k, l.name] as [string, string])];

const KEY = "wpx.lang";

/** Выбранный язык; без выбора — язык системы, если для него есть файл, иначе русский/английский. */
export function lang(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "ru" || (v && v in LOCALES)) return v;
  } catch { /* приватный режим */ }
  const sys = navigator.language.toLowerCase().split("-")[0];
  return sys === "ru" ? "ru" : sys in LOCALES ? sys : "en" in LOCALES ? "en" : "ru";
}

export function setLang(code: string) {
  try { localStorage.setItem(KEY, code); } catch { /* приватный режим — только на сеанс */ }
}

const L: Locale | undefined = LOCALES[lang()];
const CYR = /[А-Яа-яЁё]/;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let compiled: { re: RegExp; out: string }[] | null = null;
function patterns() {
  // Длинные шаблоны проверяются раньше — они точнее коротких вроде «{} мс».
  compiled ??= (L?.patterns ?? [])
    .map(([k, out]) => ({ re: new RegExp(`^${k.split("{}").map(reEsc).join("(.+?)")}$`, "s"), out, len: k.length }))
    .sort((a, b) => b.len - a.len)
    .map(({ re, out }) => ({ re, out }));
  return compiled;
}

const cache = new Map<string, string>();
function translate(t: string, depth: number): string {
  const hit = cache.get(t);
  if (hit !== undefined) return hit;
  let out = L!.exact[t];
  if (out === undefined && depth < 4) {
    for (const p of patterns()) {
      const m = p.re.exec(t);
      if (!m) continue;
      // Подстановка тоже переводится («в Docker» внутри длинной фразы).
      const g = m.slice(1).map((x) => (CYR.test(x) ? keepSpace(x, translate(x.trim(), depth + 1)) : x));
      let k = 0;
      out = p.out.replace(/\{(\d*)\}/g, (_, n: string) => (n ? g[Number(n) - 1] : g[k++]) ?? "");
      break;
    }
  }
  // Не нашлось целиком — строка из частей через « · » (сводки, состояние сервера).
  if (out === undefined && depth < 6 && t.includes(" · ")) out = t.split(" · ").map((x) => (CYR.test(x) ? translate(x.trim(), depth + 1) : x)).join(" · ");
  out ??= t;
  if (cache.size > 5000) cache.clear();
  cache.set(t, out);
  return out;
}
function keepSpace(src: string, out: string) {
  return src.match(/^\s*/)![0] + out + src.match(/\s*$/)![0];
}

/** Строка на языке интерфейса (холсты и код, который пишет текст сам). */
export function tr(s: string): string {
  if (!L || !CYR.test(s)) return s;
  const t = s.trim();
  return t ? keepSpace(s, translate(t, 0)) : s;
}

const ATTRS = ["title", "placeholder", "aria-label"];
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);

function text(n: Text) {
  const p = n.parentElement;
  if (!p || SKIP.has(p.tagName) || p.isContentEditable || p.closest("[data-no-tr]")) return;
  const v = n.data;
  if (!CYR.test(v)) return;
  const o = tr(v);
  if (o !== v) n.data = o;
}
function attrs(e: Element) {
  for (const a of ATTRS) {
    const v = e.getAttribute(a);
    if (v && CYR.test(v)) { const o = tr(v); if (o !== v) e.setAttribute(a, o); }
  }
  if (e instanceof HTMLInputElement && (e.type === "button" || e.type === "submit") && CYR.test(e.value)) e.value = tr(e.value);
}
function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return text(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root instanceof Element) attrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) text(n as Text);
    else attrs(n as Element);
  }
}

/** Включить перевод страницы (окно и вырез). На русском только помечает язык. */
export function initI18n() {
  document.documentElement.lang = lang();
  // Язык сменили в другом окне (настройки в окне — вырез подхватывает).
  window.addEventListener("storage", (e) => { if (e.key === KEY) location.reload(); });
  if (!L) return;
  document.title = tr(document.title);
  // Подписи, заданные в стилях (content), — через CSS-переменные.
  document.documentElement.style.setProperty("--t-now", JSON.stringify(tr(" · сейчас")));
  // Холсты (сцены, графики, маршрут) пишут текст сами — переводим на лету.
  const P = CanvasRenderingContext2D.prototype as unknown as Record<string, (t: string, ...a: unknown[]) => unknown>;
  for (const k of ["fillText", "strokeText", "measureText"]) {
    const orig = P[k];
    P[k] = function (this: unknown, t: string, ...a: unknown[]) { return orig.call(this, typeof t === "string" && CYR.test(t) ? tr(t) : t, ...a); };
  }
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") text(m.target as Text);
      else if (m.type === "attributes") attrs(m.target as Element);
      else m.addedNodes.forEach(walk);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Язык и словарь — бэкенду: подписи трея и уведомления Windows. */
export function backendLocale(): { lang: string; dict: Locale | null } {
  return { lang: lang(), dict: L ?? null };
}
