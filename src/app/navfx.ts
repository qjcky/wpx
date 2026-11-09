// Смена раздела в стиле темы: подпись вкладки и заголовок страницы
// «собираются» из символов темы (код — из 0 и 1, HUD — из катаканы, ретро —
// из блоков, руны — из рун…), в «Редакторе» — печатаются с кареткой.
// Сама страница появляется CSS-анимацией темы (themes.css), а сцена отвечает
// на щелчок своим всплеском (scenes.ts → FX).

const SETS: Record<string, string> = {
  ascii: "01#%&*+=<>/", hud: "ｱｲｳｴｵｶｷｸｹｺｻｼ01", retro: "▓▒░█▄▀", glitch: "█▓▒░#@", nosignal: "▒░·:/",
  runes: "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᛁᛃ", anime: "アイウエオカキクケコ", spectrum: "[]{}|/\\=", shards: "◆◇▲△◢◣",
  hex: "⬡⬢◇", poster: "?!#", plexus: "·•∙", rift: "✦✧·", bloom: "❀✿·", cracked: "╱╲╳",
  offline: "▀▄█░", nope: "▀▄█▌", pet: "▪▫■", hello: "<>{}();", alive: "();{}", deadline: "█▓░",
  cad: "⌫␡▮", emc2: "²=×E", element: "CoFeEs", formula: "∫∑√π∂", overthink: "?…", meh: "·°", blob: "~≈", widgets: "•◦",
};

const running = new WeakMap<Text, number>();
/** Исходный текст узла, пока идёт анимация (повторный щелчок не портит подпись). */
const source = new WeakMap<Text, string>();

function texts(el: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if ((n as Text).data.trim()) out.push(n as Text);
  return out;
}

/** Текст проявляется слева направо, ещё не готовое — случайные символы набора. */
function decode(el: Element, set: string, dur: number) {
  for (const node of texts(el)) {
    const orig = source.get(node) ?? node.data, t0 = performance.now();
    source.set(node, orig);
    const prev = running.get(node);
    if (prev) cancelAnimationFrame(prev);
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      if (k >= 1) { node.data = orig; running.delete(node); source.delete(node); return; }
      const done = Math.floor(k * orig.length);
      node.data = [...orig].map((c, i) => (i < done || c === " " ? c : set[(Math.random() * set.length) | 0])).join("");
      running.set(node, requestAnimationFrame(tick));
    };
    running.set(node, requestAnimationFrame(tick));
  }
}

/** Текст печатается с кареткой (Редактор). */
function typeIn(el: Element, dur: number) {
  for (const node of texts(el)) {
    const orig = source.get(node) ?? node.data, t0 = performance.now();
    source.set(node, orig);
    const prev = running.get(node);
    if (prev) cancelAnimationFrame(prev);
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      if (k >= 1) { node.data = orig; running.delete(node); source.delete(node); return; }
      node.data = orig.slice(0, Math.max(1, Math.floor(k * orig.length))) + "▍";
      running.set(node, requestAnimationFrame(tick));
    };
    running.set(node, requestAnimationFrame(tick));
  }
}

const motionOn = () => {
  const m = document.documentElement.dataset.motion;
  return m === "on" || (m !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
};

/** Вызвать после переключения на вкладку `btn`. */
export function navFx(btn: HTMLElement) {
  if (!motionOn()) return;
  const sc = document.documentElement.dataset.scene ?? "prism";
  const head = document.querySelector(".page:not([hidden]) h1");
  if (sc === "editor") {
    typeIn(btn, 260);
    if (head) typeIn(head, 420);
    return;
  }
  const set = SETS[sc];
  if (!set) return;
  decode(btn, set, 340);
  if (head) decode(head, set, 520);
}
