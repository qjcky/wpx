// Перетаскивание в окно wpx и на вырез: ярлык игры, exe, папка, ярлык Steam
// или Epic — и ссылка из браузера. Ловит сама страница; полные пути файлов
// отдаёт WebView2: файлы уходят в chrome.webview.postMessageWithAdditionalObjects,
// Rust (dropfiles.rs) возвращает пути событием `wpx-drop`. У «файла» ссылки из
// браузера пути на диске нет — тогда в дело идёт сама ссылка.
// В Linux файлы с путями отдаёт Tauri (onDragDropEvent), ссылки — страница.

import type { Api } from "./api";
import type { Dropped } from "./types";

/** Что отпустили: пути файлов, ссылка (из браузера) и сами файлы — у
 *  «файла» ссылки из браузера пути нет, но есть содержимое. */
export interface Got { paths: string[]; url: string | null; files: File[] }

interface Hooks {
  /** Над окном тащат файл или ссылку. */
  enter(): void;
  /** Курсор над точкой окна (CSS-пиксели). */
  over(x: number, y: number): void;
  /** Ушли из окна, не отпустив. */
  leave(): void;
  /** Отпустили в точке окна. */
  drop(got: Promise<Got>, x: number, y: number): void;
}

/** Файлы, ссылка или текст (выделенный адрес); своё — то, что тащат внутри окна, — нет. */
let inside = false;
const ours = (dt: DataTransfer | null) => !inside && !!dt && [...dt.types].some((t) => t === "Files" || t === "text/uri-list" || t === "text/plain");

/** Адрес сайта из текста: ссылка или домен (youtube.com). */
function urlOf(text: string): string | null {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]\S*)?$/i.test(t)) return `https://${t}`;
  return null;
}

export function initDrop(h: Hooks) {
  let depth = 0;
  document.addEventListener("dragstart", () => { inside = true; });
  document.addEventListener("dragend", () => { inside = false; });
  let waiting: ((paths: string[]) => void) | null = null;
  const tauri = "__TAURI_INTERNALS__" in window;
  // Linux: файлы с путями — от Tauri. `native` — идёт такое перетаскивание,
  // `nativeAt` — когда его отпустили (тот же бросок может прийти и странице).
  const linux = tauri && navigator.userAgent.includes("Linux");
  let native = false, nativeAt = 0;
  if (tauri && !linux) {
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string[]>("wpx-drop", (e) => { waiting?.(e.payload); waiting = null; }));
  }
  if (linux) {
    const css = (p: { x: number; y: number }): [number, number] => [p.x / (window.devicePixelRatio || 1), p.y / (window.devicePixelRatio || 1)];
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter") {
        // Без путей (ссылка из браузера) — это дело страницы.
        if (!p.paths.length || inside) return;
        native = true;
        h.enter();
        h.over(...css(p.position));
      } else if (p.type === "over") {
        if (native) h.over(...css(p.position));
      } else if (p.type === "drop") {
        if (!native) return;
        native = false;
        depth = 0;
        if (!p.paths.length) { h.leave(); return; }
        nativeAt = Date.now();
        h.drop(Promise.resolve({ paths: p.paths, url: null, files: [] }), ...css(p.position));
      } else if (native) {
        native = false;
        depth = 0;
        h.leave();
      }
    })).catch(() => { /* без путей — только ссылки */ });
  }
  document.addEventListener("dragenter", (e) => {
    if (!ours(e.dataTransfer)) return;
    e.preventDefault();
    if (native) return;
    if (depth++ === 0) h.enter();
  });
  document.addEventListener("dragover", (e) => {
    if (!ours(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
    h.over(e.clientX, e.clientY);
  });
  document.addEventListener("dragleave", (e) => {
    if (!ours(e.dataTransfer) || native) return;
    if (--depth <= 0) { depth = 0; h.leave(); }
  });
  document.addEventListener("drop", (e) => {
    if (!ours(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    // Linux: этот бросок уже разобрал Tauri (или вот-вот разберёт).
    if (native || Date.now() - nativeAt < 400) return;
    const dt = e.dataTransfer!;
    const url = dt.getData("text/uri-list").split(/\r?\n/).map((l) => l.trim()).find((l) => /^https?:\/\//i.test(l)) ?? urlOf(dt.getData("text/plain"));
    const files = dt.files;
    const list = [...files];
    const names = list.map((f) => f.name);
    const wv = (window as unknown as { chrome?: { webview?: { postMessageWithAdditionalObjects?: (m: string, o: FileList) => void } } }).chrome?.webview;
    const got: Promise<Got> = files.length && wv?.postMessageWithAdditionalObjects
      ? new Promise((done) => {
        const t = window.setTimeout(() => { waiting = null; done({ paths: names, url, files: list }); }, 2000);
        waiting = (paths) => { clearTimeout(t); done({ paths: paths.length ? paths : names, url, files: list }); };
        wv.postMessageWithAdditionalObjects!("wpx-drop", files);
      })
      // Без WebView2 (демо в браузере) путей нет — только имена.
      : Promise.resolve({ paths: names, url, files: list });
    h.drop(got, e.clientX, e.clientY);
  });
}

/** Разобрать отпущенное: файл с путём на диске — ярлык, exe или папка;
 *  иначе ссылка — сайт (из самой ссылки или из содержимого «файла» ссылки). */
export async function resolveDrop(api: Api, got: Got): Promise<Dropped | string> {
  // Windows (C:\…, \\сервер\…) или Linux (/home/…).
  const disk = got.paths.filter((p) => /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(p));
  let err = "";
  if (disk.length) {
    const d = await api.dropInspect(disk[0]).catch((e) => String(e).replace(/^Error:\s*/, ""));
    if (typeof d !== "string") return d;
    err = d;
  }
  let url = got.url;
  for (const f of got.files) {
    if (url) break;
    if (f.size > 64_000) continue;
    const t = await f.text().catch(() => "");
    url = /^URL=(https?:\/\/\S+)/im.exec(t)?.[1] ?? urlOf(t);
  }
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (host) return { name: host, site: host, from: "url" };
    } catch { /* не ссылка */ }
  }
  return err || "перетащите ярлык игры, exe, папку или ссылку на сайт";
}
