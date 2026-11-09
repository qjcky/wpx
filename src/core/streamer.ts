// Режим стримера: на экране не видно IP-адресов, ссылок подключения, ключей,
// UUID и QR-кодов — в текстах, подсказках, на холстах и в полях. Меняет только
// показ, не данные; окно и вырез переключаются вместе.

const KEY = "wpx.streamer";

export function streamerOn(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function setStreamer(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* приватный режим — только на сеанс */ }
}

const DOTS = "••••••";
/** Что прятать: ссылки подключения, UUID, IPv4, IPv6, длинные ключи. */
const HIDE: [RegExp, string][] = [
  [/\b(?:vless|vmess|trojan|ssr?|hysteria2?|hy2|tuic|wireguard|awg|tg|ssh):\/\/\S+/gi, DOTS],
  [/\bhttps?:\/\/t\.me\/proxy\S*/gi, DOTS],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, DOTS],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "•••.•••.•••.•••"],
  // IPv6: от трёх групп через «:», с буквой a–f или «::» (время 12:30:45 — не адрес).
  [/(?<![\w:.])(?=[0-9a-f:]*(?:[a-f]|::))(?:[0-9a-f]{1,4}:|:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, "••••:••••"],
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, DOTS],
];
const DIGIT_OR_LINK = /\d|:\/\/|[A-Za-z0-9+/_-]{32}/;

export function mask(s: string): string {
  if (!DIGIT_OR_LINK.test(s)) return s;
  let o = s;
  for (const [re, to] of HIDE) o = o.replace(re, to);
  return o;
}

const ATTRS = ["title", "placeholder", "aria-label"];
const SKIP = new Set(["SCRIPT", "STYLE"]);

function text(n: Text) {
  const p = n.parentElement;
  if (!p || SKIP.has(p.tagName)) return;
  const o = mask(n.data);
  if (o !== n.data) n.data = o;
}
function attrs(e: Element) {
  for (const a of ATTRS) {
    const v = e.getAttribute(a);
    if (v) { const o = mask(v); if (o !== v) e.setAttribute(a, o); }
  }
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

/** Включить режим стримера на странице, если он выбран (после initI18n). */
export function initStreamer() {
  // Переключили в другом окне (настройки — в окне, вырез подхватывает).
  window.addEventListener("storage", (e) => { if (e.key === KEY) location.reload(); });
  if (!streamerOn()) return;
  document.documentElement.classList.add("streamer");
  document.title = mask(document.title);
  const P = CanvasRenderingContext2D.prototype as unknown as Record<string, (t: string, ...a: unknown[]) => unknown>;
  for (const k of ["fillText", "strokeText", "measureText"]) {
    const orig = P[k];
    P[k] = function (this: unknown, t: string, ...a: unknown[]) { return orig.call(this, typeof t === "string" ? mask(t) : t, ...a); };
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
