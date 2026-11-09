// Вырез у края экрана (`?view=widget`). В покое — чёрная капсула: кот-огонёк
// состояния, задержка, протокол в работе. Навёл — капсула разворачивается в
// панель: «Связь» (задержка, маршрут, график, трафик), дальше — быстрые действия
// («Профили», «Правила», «Игра», «Проверки»). Ушёл курсор — сворачивается.
// События связи (обрыв, восстановление, резерв, замедление) — «живая активность»:
// капсула на несколько секунд вытягивается с сообщением. Вырез встаёт к любому
// краю или углу экрана; на него можно перетащить игру, exe, папку или ссылку.
// Окно прозрачное, постоянного размера; форма сообщается в Rust
// (api.widgetShape) — там окно принимает мышь, вокруг клики идут насквозь.

import type { Api } from "../core/api";
import type { Health, Leg, MonitorInfo, NetSettings, NotchAnchor, ProfilesState, ProfileView, RunningApp, Snapshot } from "../core/types";
import { alpha, css, fit } from "../core/charts";
import { ICON, TYPE_ICON } from "../core/icons";
import { isProxy, mountStrip, placeOf, PROTO, SHORT, type Flow } from "../app/route";
import { esc, NOTCH_AT } from "../core/ui";
import { initSpotlight } from "../core/fx";
import { feedScene, mountScene } from "../theme/scenes";
import { mountCat, moodOf } from "./cat";
import { initTheme, loadTheme } from "../theme/theme";
import { candidates, domainOf, filter, KIND_ICON, learnedLabel, presetsOf, ruleFor, targetOf, targets as ruleTargets, upsert, widen, type Cand } from "../app/rulepick";
import { addDropped, all as allGames, gameMode, icon as gameIcon, KEY as GAMES_KEY, mineFirst, select as selectGame, selected as selectedGame } from "../app/games";
import { initDrop, resolveDrop, type Got } from "../core/drop";

type Mode = "closed" | "open" | "act";
/** Вид места: у верхнего или нижнего края, у бокового, в углу. */
type Kind = "edge" | "side" | "corner";
const kindOf = (a: NotchAnchor): Kind => (a === "top" || a === "bottom" ? "edge" : a === "left" || a === "right" ? "side" : "corner");
/** Тело выреза (без «ушек») — как в CSS: в покое полоска, вертикальная
 *  капсула или квадратик; активность — полоска или карточка; панель — одна. */
const BODY: Record<Kind, Record<Mode, [number, number]>> = {
  edge: { closed: [212, 36], act: [380, 40], open: [468, 204] },
  side: { closed: [64, 144], act: [300, 60], open: [468, 204] },
  corner: { closed: [84, 80], act: [300, 60], open: [468, 204] },
};

const STATE: Record<Health, string> = {
  starting: "Проверяем",
  online: "Подключено",
  slow: "Связь замедлена",
  down: "Нет связи",
  engine_off: "Движок остановлен",
};

/** Вкладки: первая — сведения, дальше — быстрые действия. */
const TABS: [keyof typeof ICON, string][] = [["pulse", "Связь"], ["shield", "Профили"], ["fork", "Правила"], ["game", "Игра"], ["check", "Проверки"]];
const PAGES = TABS.length;

function rate(bps: number) {
  if (bps < 1024) return `${bps} Б/с`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} КБ/с`;
  return `${(bps / 1024 ** 2).toFixed(1)} МБ/с`;
}
function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
}
const ms = (l?: Leg) => (!l || !l.at ? "…" : l.result.ok ? `${l.result.ready_ms} мс` : "нет");
const profKind = (p: ProfileView) => (p.route.length ? "маршрут" : p.cascade ? "каскад" : p.endpoints.length ? "VPN" : "прокси");
const iconOf = (p: ProfileView) => TYPE_ICON[p.route.length ? "route" : p.cascade ? "cascade" : p.endpoints.length ? "vpn" : "proxy"];
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export async function runWidget(api: Api) {
  const q = new URLSearchParams(location.search);
  const tauri = "__TAURI_INTERNALS__" in window;
  document.title = "wpx · вырез";
  document.documentElement.classList.add("notch-mode");
  document.body.className = `widget-mode${q.has("demo") ? " notch-demo" : ""}`;
  document.body.innerHTML = `
    <div class="nt" data-mode="closed" data-at="top" data-kind="edge" data-hide="1">
      <span class="ear a"></span><span class="ear b"></span>
      <div class="nt-body">
        <canvas class="nt-scene" aria-hidden="true"></canvas>
        <div class="nt-facets" aria-hidden="true"></div>
        <div class="nt-closed">
          <canvas class="cat" aria-hidden="true"></canvas><b class="nt-ms">—</b><span class="nt-proto" title="Протокол в работе"></span>
        </div>
        <div class="nt-act"><span class="act-ico"></span><span class="act-txt"><b></b><small></small></span><span class="act-val"></span></div>
        <div class="nt-open">
          <div class="nt-head" title="Потяните, чтобы переставить вырез">
            <canvas class="cat sm" aria-hidden="true"></canvas><b class="nh-state">…</b><span class="nh-prof"></span><span class="nh-msg"></span>
            <span class="nh-btns">
              <button id="ntPlace" title="Где вырез" aria-label="Где вырез"><svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="10.5" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 3h4" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button>
              <button id="ntPin" title="Поверх всех окон" aria-label="Поверх всех окон"><svg viewBox="0 0 16 16"><path d="M6 2.5h4l-.5 4 2 2v1H8.6V14L8 14.6 7.4 14V9.5H4.5v-1l2-2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>
              <button id="ntMain" title="Открыть wpx" aria-label="Открыть wpx"><svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3L7.5 8.5M12 10v3H3V4h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <button id="ntClose" title="Убрать вырез" aria-label="Убрать вырез"><svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
            </span>
          </div>
          <div class="nt-pages">
            <section class="pg pg-link" style="--i:0">
              <div class="pl-top">
                <div class="lat"><small>Задержка</small><b class="big">—</b><span class="pill"></span></div>
                <div class="mroute"><canvas class="mr-canvas" aria-hidden="true"></canvas><div class="mr-nodes"></div></div>
              </div>
              <div class="pl-foot">
                <canvas class="spark" title="Задержка за 5 минут"></canvas>
                <div class="pstats"><span><span class="dn" title="Загрузка"><i>↓</i><b class="rx">—</b></span><span class="up" title="Отдача"><i>↑</i><b class="tx">—</b></span></span><small class="pnote"></small></div>
              </div>
            </section>
            <section class="pg pg-profiles" style="--i:1"><ul class="plist prof"></ul></section>
            <section class="pg pg-rules" style="--i:2">
              <div class="radd"><label class="rq">${ICON.search}<input class="rsite" placeholder="приложение или сайт" spellcheck="false" autocomplete="off"></label><button class="rapply" disabled>Применить</button></div>
              <ul class="plist rules"></ul>
              <div class="rto" hidden><div class="rto-head"><button class="rto-back" aria-label="Назад">‹</button><span class="rto-name"></span></div><div class="rto-list"></div></div>
            </section>
            <section class="pg pg-game" style="--i:3"></section>
            <section class="pg pg-check" style="--i:4">
              <div class="ck" id="ckSpeed"><span class="ck-ico">${ICON.bolt}</span><span class="ck-t"><b>Скорость</b><small>~30 с, до ~30 МБ трафика</small></span><button class="qa" id="qaSpeed">Запустить</button></div>
              <div class="ck" id="ckLeaks"><span class="ck-ico">${ICON.shieldOk}</span><span class="ck-t"><b>Утечки</b><small>IP, мимо туннеля, IPv6, DNS, WebRTC</small></span><button class="qa" id="qaLeaks">Проверить</button></div>
            </section>
          </div>
          <nav class="nt-tabs">${TABS.map(([ic, n], i) => `<button data-p="${i}" title="${n}" aria-label="${n}">${ICON[ic]}<span>${n}</span></button>`).join("")}</nav>
          <div class="nt-place" hidden>
            <div class="pl-screen">${NOTCH_AT.map(([a, n]) => `<button class="pa" data-a="${a}" title="${n}" aria-label="${n}"></button>`).join("")}</div>
            <div class="pl-side"><b>Где вырез</b><small>Нажмите место на экране — или потяните вырез за верхнюю строку и отпустите у любого края.</small><div class="pl-mons"></div><button class="qa" id="plDone">Готово</button></div>
          </div>
          <div class="nt-drop" hidden>
            <div class="dz" data-z="game">${ICON.game}<b>В игровой режим</b><small class="dz-sub">ярлык, exe или папка игры</small></div>
            <div class="dz" data-z="rule">${ICON.fork}<b>В правила</b><small class="dz-sub">программа, ярлык или ссылка на сайт</small></div>
          </div>
        </div>
      </div>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
  const nt = $(".nt");
  // Рёбра граней в панели загораются у курсора — как в окне wpx.
  initSpotlight();
  // Тема окна — и в капсуле: та же сцена, мельче; меняется вместе с окном.
  const sc = mountScene($<HTMLCanvasElement>(".nt-scene"), loadTheme().scene, { small: true });
  initTheme(() => sc.set(loadTheme().scene));
  // Маршрут в панели — линия в стиле темы (как в окне, только меньше).
  const strip = mountStrip($<HTMLCanvasElement>(".mr-canvas"), 16, 0.55);
  let routeSegs: Flow[] = [], routeHtml = "";
  // Кот-маскот вместо кружка состояния: по позе видно, что со связью.
  const cats = [mountCat($<HTMLCanvasElement>(".nt-closed .cat"), 2), mountCat($<HTMLCanvasElement>(".nt-head .cat"), 1)];
  let mode: Mode = "closed";
  let at: NotchAnchor = "top";
  let page = Number(q.get("page") ?? 0) || 0;
  let snap: Snapshot | null = null;
  let lat: [number, number | null][] = [];
  let actTimer = 0, closeTimer = 0, openTimer = 0, shapeTimer = 0, msgTimer = 0;
  let profs: ProfilesState | null = null;
  let net: NetSettings | null = null;
  let info: Awaited<ReturnType<Api["engineInfo"]>> | null = null;
  let cands: Cand[] = [];
  let pickedC: Cand | null = null;
  let busy = false;
  /** Изменения правил до «Применить»: «вид:значение» → кандидат и цель ("" — убрать). */
  const pending = new Map<string, { c: Cand; t: string }>();

  /** Форма для мыши: тело и «ушки» — по бокам у верхнего и нижнего края,
   *  сверху и снизу у боковых, по одному с каждой стороны в углу. */
  const shapeOf = (m: Mode): [number, number] => {
    const k = kindOf(at);
    const [w, h] = BODY[k][m];
    return k === "edge" ? [w + 24, h + 2] : k === "side" ? [w + 2, h + 24] : [w + 12, h + 12];
  };

  const setMode = (m: Mode) => {
    if (m === mode) return;
    const b = BODY[kindOf(at)];
    const grow = b[m][0] * b[m][1] > b[mode][0] * b[mode][1];
    mode = m;
    clearTimeout(shapeTimer);
    // Форма меняется только в CSS — окно стоит на месте. Растём — область
    // мыши сразу шире; сжимаемся — уже после анимации.
    nt.dataset.mode = m;
    strip.active(m === "open");
    if (m !== "open") { placeShow(false); dropShow(false); }
    if (m === "open") renderOpen();
    if (grow) api.widgetShape(...shapeOf(m));
    else shapeTimer = window.setTimeout(() => api.widgetShape(...shapeOf(mode)), 480);
  };

  // Наведение: открыть с короткой задержкой, уход — закрыть.
  const enter = () => {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = window.setTimeout(() => { clearTimeout(actTimer); setMode("open"); }, 110);
  };
  const leave = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => setMode("closed"), 260);
  };
  nt.addEventListener("mouseenter", enter);
  nt.addEventListener("mouseleave", leave);
  $(".nt-closed").addEventListener("click", () => api.showMain());
  $("#ntMain").addEventListener("click", () => api.showMain());
  $("#ntClose").addEventListener("click", () => api.widgetClose());

  // ─── Где вырез: уехать в край, переехать, выехать из нового края ───
  const hideToEdge = () => {
    clearTimeout(openTimer);
    clearTimeout(actTimer);
    setMode("closed");
    nt.dataset.hide = "1";
  };
  const arrive = (a: NotchAnchor) => {
    nt.classList.add("snap");
    at = a;
    nt.dataset.at = a;
    nt.dataset.kind = kindOf(a);
    delete nt.dataset.float;
    nt.dataset.hide = "1";
    void nt.offsetWidth;
    nt.classList.remove("snap");
    // Таймер, а не кадр анимации: у фонового окна кадры могут не приходить.
    window.setTimeout(() => { delete nt.dataset.hide; }, 30);
    api.widgetShape(...shapeOf(mode));
  };
  let mons: MonitorInfo[] = [];
  const placeShow = (on: boolean) => {
    $(".nt-place").hidden = !on;
    nt.classList.toggle("placing", on);
    if (on) void renderPlace();
  };
  const renderPlace = async () => {
    document.querySelectorAll<HTMLElement>(".pa").forEach((b) => b.classList.toggle("on", b.dataset.a === at));
    mons = await api.widgetMonitors().catch(() => []);
    $(".pl-mons").innerHTML = mons.length > 1
      ? `<span>Экран</span>${mons.map((m, i) => `<button class="pm${m.current ? " on" : ""}" data-m="${i}" title="${esc(m.label)}">${i + 1}</button>`).join("")}` : "";
  };
  const moveTo = (a: NotchAnchor) => {
    if (a === at) return;
    void api.widgetSetAnchor(a);
    // В браузере (демо) событий от Rust нет — играем переезд сами.
    if (!tauri) { hideToEdge(); window.setTimeout(() => arrive(a), 300); }
  };
  $("#ntPlace").addEventListener("click", () => placeShow($(".nt-place").hidden));
  $("#plDone").addEventListener("click", () => placeShow(false));
  $(".pl-screen").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".pa");
    if (b) moveTo(b.dataset.a as NotchAnchor);
  });
  $(".pl-mons").addEventListener("click", (e) => {
    const m = mons[Number((e.target as HTMLElement).closest<HTMLElement>(".pm")?.dataset.m)];
    if (m && !m.current) void api.widgetSetMonitor(m.primary ? null : m.name);
  });
  // Перетаскивание за шапку: окно едет за курсором, по отпусканию Rust
  // ставит его к ближайшему краю или углу (события notch-leave → notch-anchor).
  let press: [number, number] | null = null;
  $(".nt-head").addEventListener("mousedown", (e) => {
    if (e.button === 0 && !(e.target as HTMLElement).closest("button")) press = [e.screenX, e.screenY];
  });
  window.addEventListener("mousemove", (e) => {
    if (!press) return;
    if (!(e.buttons & 1)) { press = null; return; }
    if (Math.hypot(e.screenX - press[0], e.screenY - press[1]) < 5) return;
    press = null;
    clearTimeout(closeTimer);
    placeShow(false);
    nt.dataset.float = "1";
    void api.widgetDrag().catch(() => { /* останется, где был */ }).finally(() => { delete nt.dataset.float; });
  });
  window.addEventListener("mouseup", () => { press = null; if (!tauri) delete nt.dataset.float; });

  // ─── Вкладки ───
  const go = (d: number) => { page = (page + d + PAGES) % PAGES; renderPage(); };
  $(".nt-pages").addEventListener("wheel", (e) => { e.preventDefault(); go(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  document.querySelectorAll<HTMLElement>(".nt-tabs button").forEach((b) => b.addEventListener("click", () => { page = Number(b.dataset.p); renderPage(); }));

  const renderPage = () => {
    $(".nt-pages").style.setProperty("--pg", String(page));
    document.querySelectorAll(".nt-tabs button").forEach((d, i) => d.classList.toggle("on", i === page));
    if (page === 0) drawSpark();
    if (page === 1) void loadProfiles();
    if (page === 2) void loadRules();
    if (page === 3) void loadGame();
  };

  // ─── Живая активность ───
  const activity = (kind: "ok" | "bad" | "warn" | "info", title: string, sub: string, val = "") => {
    $(".nt-act").className = `nt-act ${kind}`;
    $(".act-ico").innerHTML = kind === "ok" ? ICON.check : kind === "info" ? ICON.cycle : ICON.alert;
    $(".act-txt b").textContent = title;
    $(".act-txt small").textContent = sub;
    $(".act-val").textContent = val;
    if (mode === "open") { note(kind, title); return; } // панель открыта — строкой в шапке
    setMode("act");
    clearTimeout(actTimer);
    actTimer = window.setTimeout(() => { if (mode === "act") setMode("closed"); }, 4800);
  };

  const events = (prev: Snapshot, s: Snapshot) => {
    const exit = (x: Snapshot) => x.legs.find((l) => l.active && l.role === "exit");
    if (prev.health !== s.health) {
      if (s.health === "down") return activity("bad", "Нет связи", s.cause ?? "туннель не пропускает трафик");
      if (s.health === "engine_off") return activity("bad", "Движок остановлен", "трафик не идёт");
      if (s.health === "slow") return activity("warn", "Связь замедлена", `выше ${s.slow_ms} мс или потери`, s.last_ms ? `${s.last_ms} мс` : "");
      if (s.health === "online" && (prev.health === "down" || prev.health === "engine_off" || prev.health === "slow"))
        return activity("ok", "Связь восстановлена", prev.health === "slow" ? "задержка в норме" : `простой ${dur(s.t - prev.health_since)}`, s.last_ms ? `${s.last_ms} мс` : "");
    }
    if (!prev.on_reserve && s.on_reserve && s.reserve) return activity("warn", `Резерв «${s.reserve[1]}»`, "VPN не отвечает — вернусь сам");
    if (prev.on_reserve && !s.on_reserve) return activity("ok", "Снова через VPN", s.profile ?? "", s.last_ms ? `${s.last_ms} мс` : "");
    const a = exit(prev), b = exit(s);
    if (a && b && a.name !== b.name && prev.profile === s.profile)
      return activity("info", `Теперь через ${PROTO[b.kind] ?? b.kind}`, placeOf(b), ms(b));
    const ev = s.events[0];
    if (ev && ev.kind === "slowdown" && ev.t !== prev.events[0]?.t) return activity("warn", "Похоже на замедление", ev.text.replace(/^Загрузка по рабочему пути\s*/, ""));
  };

  // ─── Отрисовка ───
  const renderClosed = (s: Snapshot) => {
    const bad = s.health === "down" || s.health === "engine_off";
    // Число и «мс» — отдельно: в вертикальной капсуле «мс» встаёт под числом.
    $(".nt-ms").innerHTML = bad ? (s.health === "down" ? "нет связи" : "стоп") : s.last_ms !== null ? `${s.last_ms}<small>мс</small>` : "…";
    // Справа — чем идёт трафик: протокол точки в работе или резерв.
    const exit = s.legs.find((l) => l.active && l.role === "exit") ?? s.legs.find((l) => l.active);
    const pr = $(".nt-proto");
    pr.textContent = bad ? "" : s.on_reserve && s.reserve ? "резерв" : exit ? SHORT[exit.kind] ?? exit.kind : "";
    pr.classList.toggle("rsv", !!(s.on_reserve && s.reserve));
  };

  const route = (s: Snapshot) => {
    const proxy = isProxy(s) || !s.legs.length;
    const exits = s.legs.filter((l) => l.role === "exit"), entries = s.legs.filter((l) => l.role === "entry");
    const exit = exits.find((l) => l.active) ?? exits[0], entry = entries.find((l) => l.active) ?? entries[0];
    const head = exit?.label.split(" · ")[0] ?? "";
    const via = entry ? placeOf(entry) : !proxy && head.includes(" → ") ? head.split(" → ")[0] : null;
    const ok = s.health === "online" || s.health === "slow";
    const nodes: [keyof typeof ICON, string, string, string][] = [
      ["pc", "ПК", "", "ok"],
      ["lock", proxy ? "Туннель" : "VPN", PROTO[(entry ?? exit)?.kind ?? ""] ?? "", `tun ${s.engine.running ? (ok ? "ok" : "bad") : "bad"}`],
      ...(via ? [["pin", via, "вход", ""] as [keyof typeof ICON, string, string, string]] : []),
      ["pin", proxy ? (s.profile ?? s.server) : exit ? placeOf(exit) : "Выход", ms(exit), exit?.at && !exit.result.ok ? "bad" : "ms"],
      ["globe", "Интернет", "", ok ? "ok" : ""],
    ];
    // Звенья для линии в стиле темы: живые до первого сбоя, дальше — тишина.
    const bad = nodes.findIndex(([, , , c]) => c.split(" ").includes("bad"));
    const flow: Flow = s.health === "slow" ? "slow" : "live";
    routeSegs = nodes.slice(1).map((_, i): Flow => ok ? flow : bad < 0 ? (i === nodes.length - 2 ? "broken" : "live") : i + 1 < bad ? "live" : i + 1 === bad ? "broken" : "idle");
    return nodes.map(([ic, l, m, c]) =>
      `<span class="mr ${c}">${ICON[ic]}<b>${esc(l)}</b>${m ? `<small>${esc(m)}</small>` : ""}</span>`).join("");
  };

  const renderOpen = () => {
    const s = snap;
    if (!s || mode !== "open") return;
    $(".nh-state").textContent = s.on_reserve && s.reserve ? `Резерв «${s.reserve[1]}»` : STATE[s.health];
    $(".nh-prof").textContent = s.profile ? `· ${s.profile}` : "";
    const bad = s.health === "down" || s.health === "engine_off";
    $(".pg-link .big").innerHTML = bad || s.last_ms === null ? "—" : `${s.last_ms}<small>мс</small>`;
    $(".pg-link .pill").textContent = { starting: "проверяем", online: "стабильно", slow: "медленно", down: "нет ответа", engine_off: "движок стоит" }[s.health];
    const html = route(s);
    if (html !== routeHtml) { routeHtml = html; $(".mr-nodes").innerHTML = html; }
    // Центры значков — точки линии.
    const box = $(".mroute").getBoundingClientRect();
    strip.set([...document.querySelectorAll<HTMLElement>(".mr-nodes .mr svg")].map((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2 - box.left; }), routeSegs);
    $(".rx").textContent = s.traffic.found ? rate(s.traffic.rx_bps) : "—";
    $(".tx").textContent = s.traffic.found ? rate(s.traffic.tx_bps) : "—";
    const vis = lat.filter(([t]) => t >= Date.now() - 300_000);
    const okv = vis.filter(([, v]) => v !== null).map(([, v]) => v as number).sort((a, b) => a - b);
    const loss = vis.length ? ((vis.length - okv.length) / vis.length) * 100 : 0;
    $(".pnote").textContent = okv.length ? `медиана ${okv[Math.floor(okv.length / 2)]} мс · потери ${loss.toFixed(loss && loss < 10 ? 1 : 0)}%` : "замеров пока нет";
    if (page === 0) drawSpark();
  };

  const drawSpark = () => {
    const cv = $<HTMLCanvasElement>(".spark");
    const { ctx, w, h } = fit(cv);
    if (!w) return;
    const t0 = Date.now() - 300_000;
    const pts = lat.filter(([t]) => t >= t0);
    const vals = pts.map(([, v]) => v).filter((v): v is number => v !== null);
    // Запас сверху: линия — в середине поля, пики видны целиком.
    const max = Math.max(300, ...vals) * 1.5;
    const X = (t: number) => ((t - t0) / 300_000) * w;
    const Y = (v: number) => h - 3 - (v / max) * (h - 8);
    const col = css("--pulse");
    ctx.fillStyle = css("--bad");
    for (const [t, v] of pts) if (v === null) ctx.fillRect(X(t) - 1, h - 6, 2, 6);
    ctx.beginPath();
    let on = false;
    for (const [t, v] of pts) {
      if (v === null) { on = false; continue; }
      if (!on) { ctx.moveTo(X(t), Y(v)); on = true; } else ctx.lineTo(X(t), Y(v));
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = alpha(col, 0.7);
    ctx.shadowBlur = 6;
    ctx.stroke();
  };

  // ─── Строка сообщения в шапке (панель открыта) ───
  const note = (kind: string, text: string) => {
    const m = $(".nh-msg");
    m.className = `nh-msg ${kind}`;
    m.textContent = text;
    $(".nh-prof").hidden = true;
    clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { m.textContent = ""; $(".nh-prof").hidden = false; }, 6000);
  };
  /** Итог долгой операции: в шапке, если панель открыта, иначе — живой активностью. */
  const result = (ok: boolean, title: string, sub: string) => (mode === "open" ? note(ok ? "ok" : "bad", title) : activity(ok ? "ok" : "bad", title, sub));

  // ─── Профили: переключить рабочий ───
  const loadProfiles = async () => {
    try { profs = await api.profiles(); } catch { /* движок недоступен */ }
    renderProfiles();
  };
  const renderProfiles = () => {
    const box = $(".plist.prof");
    if (!profs) { box.innerHTML = `<li class="more"><span>загружаю…</span></li>`; return; }
    const list = [...profs.profiles].sort((a, b) => Number(b.active) - Number(a.active));
    const shown = list.length > 4 ? 3 : 4;
    box.innerHTML = list.slice(0, shown).map((p) => `<li class="${p.active ? "on" : ""}">
        <span class="pk">${iconOf(p)}</span><span>${esc(p.name)} <small>${profKind(p)}</small></span>
        ${p.active ? "<b>в работе</b>" : `<button class="qa" data-use="${esc(p.id)}" ${busy ? "disabled" : ""}>Включить</button>`}</li>`).join("")
      + (list.length > shown ? `<li class="more"><span>и ещё ${list.length - shown} — в окне wpx</span></li>` : "")
      || `<li class="more"><span>профилей нет — добавьте в wpx</span></li>`;
  };
  $(".plist.prof").addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-use]");
    const p = b && profs?.profiles.find((x) => x.id === b.dataset.use);
    if (!p || busy) return;
    busy = true;
    b.textContent = "переключаю…";
    note("info", `Переключаю на «${p.name}» — подтвердите права администратора`);
    try {
      const r = await api.profileActivate(p.id);
      result(r.ok, r.ok ? `Работаем через «${p.name}»` : "Не переключилось — всё как было", r.ok ? profKind(p) : r.message.slice(0, 90));
    } catch (err) { result(false, "Не переключилось", String(err).slice(0, 90)); }
    busy = false;
    await loadProfiles();
  });

  // ─── Правила: поиск → «куда» (rulepick.ts); изменения копятся до «Применить» ───
  const keyOf = (c: { kind: string; value: string }) => `${c.kind}:${c.kind === "app" ? c.value.toLowerCase() : c.value}`;
  const loadRules = async () => {
    try {
      const [inf, list, ps] = await Promise.all([api.engineInfo(), api.conns(), profs ? Promise.resolve(profs) : api.profiles()]);
      info = inf;
      net = inf.net;
      profs = ps;
      cands = candidates(list.conns, presetsOf(inf.presets, inf.net), inf.net.rules);
    } catch { /* движок недоступен */ }
    renderRules();
  };
  const curTarget = (c: Cand) => pending.get(keyOf(c))?.t ?? ruleFor(net?.rules ?? [], c)?.target ?? "";
  const shortT = (v: string) => {
    if (!v) return "—";
    const t = targetOf(ruleTargets(profs, info), v);
    return !t ? v : t.cls === "main" ? "рабочий" : t.cls === "exit" ? `IP ${t.sub.split(" · ")[0]}` : t.label;
  };
  const renderRules = () => {
    const q = $<HTMLInputElement>(".rsite").value;
    const box = $(".plist.rules");
    const to = $(".rto");
    box.hidden = !!pickedC;
    to.hidden = !pickedC;
    if (pickedC) {
      const cur = curTarget(pickedC);
      $(".rto-name").innerHTML = `${KIND_ICON[pickedC.kind]}<b>${esc(pickedC.label)}</b><small>куда?</small>`;
      $(".rto-list").innerHTML = ruleTargets(profs, info).filter((t) => t.cls !== "exit").map((t) =>
        `<button class="rto-t ${t.cls}${t.v === cur ? " cur" : ""}" data-t="${esc(t.v)}" title="${esc(t.sub)}">${esc(t.cls === "main" ? "Рабочий" : t.label)}</button>`).join("")
        + (cur ? `<button class="rto-t none" data-t="">Убрать</button>` : "");
    } else {
      // Без поиска — сначала то, что меняли, потом приложения и сайты в сети.
      const list = filter(cands, q).filter((c) => q.trim() || c.kind !== "preset" || ruleFor(net?.rules ?? [], c));
      const changed = [...pending.values()].map((x) => x.c);
      const rows = [...changed, ...list.filter((l) => !pending.has(keyOf(l)))].slice(0, 30);
      box.innerHTML = rows.length ? rows.map((c) => {
        const t = curTarget(c), ch = pending.has(keyOf(c));
        // Правила нет — показываем, куда оно идёт сейчас (как «всё остальное»), бледно.
        const cls = t ? targetOf(ruleTargets(profs, info), t)?.cls ?? "" : "dflt";
        const label = t ? shortT(t) : net?.mode === "strict" ? "рабочий" : "напрямую";
        return `<li class="rc${ch ? " ch" : ""}" data-k="${c.kind}" data-v="${esc(c.value)}" title="${esc(c.value)}${t ? "" : " — правила нет, идёт как всё остальное"}"><span class="pk ${c.kind}">${KIND_ICON[c.kind]}</span>
          <span>${esc(c.label)}${c.fresh ? ` <small>${c.kind === "app" ? "приложение" : "сайт"}</small>` : ""}</span><b class="tp ${cls}">${esc(label)}</b></li>`;
      }).join("") : `<li class="more"><span>${net ? "введите имя программы или сайт — или перетащите ярлык на вырез" : "загружаю…"}</span></li>`;
    }
    const n = pending.size;
    const ap = $<HTMLButtonElement>(".rapply");
    ap.disabled = busy || !n;
    ap.textContent = n ? `Применить · ${n}` : "Применить";
  };
  $(".rsite").addEventListener("input", () => { pickedC = null; renderRules(); });
  $(".rsite").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $(".plist.rules").querySelector<HTMLElement>(".rc")?.click(); });
  // Колесо над списком — прокрутка списка, а не листание страниц.
  $(".plist.rules").addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  $(".rto-list").addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  $(".plist.rules").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".rc");
    if (!li) return;
    const all = [...[...pending.values()].map((x) => x.c), ...filter(cands, $<HTMLInputElement>(".rsite").value)];
    pickedC = all.find((c) => c.kind === li.dataset.k && c.value === li.dataset.v) ?? null;
    renderRules();
  });
  $(".rto-back").addEventListener("click", () => { pickedC = null; renderRules(); });
  $(".rto-list").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".rto-t");
    if (!b || !pickedC) return;
    const t = b.dataset.t ?? "";
    const orig = ruleFor(net?.rules ?? [], pickedC)?.target ?? "";
    if (t === orig) pending.delete(keyOf(pickedC)); else pending.set(keyOf(pickedC), { c: pickedC, t });
    pickedC = null;
    $<HTMLInputElement>(".rsite").value = "";
    renderRules();
  });
  $(".rapply").addEventListener("click", async () => {
    if (busy || !pending.size) return;
    busy = true;
    renderRules();
    note("info", "Применяю правила — подтвердите права администратора");
    const names = [...pending.values()].map((x) => x.c.label).join(", ");
    try {
      // Поверх свежих настроек: на вкладке «Правила» могли что-то поменять.
      const inf = await api.engineInfo();
      const fresh = inf.net;
      let rules = [...fresh.rules];
      for (const { c, t } of pending.values()) {
        const w = widen(presetsOf(inf.presets, fresh), c.kind, c.value);
        rules = upsert(rules, w.kind, w.value, t);
      }
      await api.netSave({ ...fresh, rules });
      pending.clear();
      const r = await api.engineApplyNet();
      result(r.ok, r.ok ? "Правила применены" : "Сохранено, движок не перезапущен", r.ok ? names : r.message.slice(0, 90));
    } catch (err) { result(false, "Не получилось", String(err).slice(0, 90)); }
    busy = false;
    await loadRules();
  });

  // ─── Игра: игровой режим в один клик ───
  let gsel: string | null = null;
  let runList: RunningApp[] | null = null;
  const loadGame = async () => {
    try {
      const [inf, ps] = await Promise.all([api.engineInfo(), profs ? Promise.resolve(profs) : api.profiles()]);
      info = inf;
      net = inf.net;
      profs = ps;
    } catch { /* движок недоступен */ }
    gsel = selectedGame(net?.game);
    renderGame();
  };
  const renderGame = () => {
    const gm = net?.game;
    const g = allGames().find((x) => x.id === gsel);
    const on = !!gm?.on && gm.game === gsel;
    const path = !gm?.target || gm.target === "main" ? "рабочий профиль" : profs?.profiles.find((p) => `profile:${p.id}` === gm.target)?.name ?? "профиль удалён";
    const head = g
      ? `<div class="gq-main${on ? " on" : ""}">${gameIcon(g)}<span class="gq-t"><b>${esc(g.name)}</b><small>${on ? `включён → ${esc(path)}` : esc(g.dir || g.apps.join(", "))}</small></span>
          <button class="qa gq-go" ${busy ? "disabled" : ""}>${on ? "Выключить" : "Включить"}</button></div>`
      : `<div class="gq-main empty"><span class="gm-ico">${ICON.game}</span><span class="gq-t"><b>Игра не выбрана</b><small>перетащите ярлык игры на вырез — или найдите запущенную</small></span></div>`;
    const rest = runList
      ? `<div class="gq-run">${runList.length
        ? runList.map((a, i) => `<button class="gq-r" data-r="${i}" title="${esc(a.dir)}"><b>${esc(a.name)}</b><small>${a.mem_mb} МБ</small></button>`).join("")
        : `<span class="gq-hint">похожих на игру программ нет — запустите игру</span>`}</div>`
      : `<div class="gq-list">${mineFirst().filter((x) => x.id !== gsel).slice(0, 3).map((x) =>
        `<button class="gq-c" data-g="${esc(x.id)}" title="${esc(x.name)}">${gameIcon(x)}<span>${esc(x.name)}</span></button>`).join("")}<button class="gq-c find">${ICON.search}<span>Найти запущенную</span></button></div>`;
    const hint = gm?.on && gm.game !== gsel ? `сейчас включён «${esc(gm.name)}»` : g ? "вход в игру — тем же путём; состав — во вкладке «Игры» в окне wpx" : "";
    $(".pg-game").innerHTML = head + rest + `<small class="gq-hint">${hint}</small>`;
  };
  const toggleGame = async () => {
    const g = allGames().find((x) => x.id === gsel);
    if (!g || busy) return;
    if (!g.apps.length && !g.dir) { note("bad", "У игры нет exe и папки — поправьте во вкладке «Игры»"); return; }
    busy = true;
    renderGame();
    try {
      const fresh = (await api.engineInfo()).net;
      const off = !!fresh.game?.on && fresh.game.game === g.id;
      // Вход тем же путём — по умолчанию; если игру уже настраивали — как было.
      fresh.game = off ? { ...fresh.game, on: false } : gameMode(g, fresh.game?.game ? fresh.game.login : true, fresh.game?.target || "main", fresh.game?.game ? fresh.game.udp_only : true);
      await api.netSave(fresh);
      note("info", off ? "Выключаю игровой режим — подтвердите права администратора" : `Включаю «${g.name}» — подтвердите права администратора`);
      const r = await api.engineApplyNet();
      result(r.ok, r.ok ? (off ? "Игровой режим выключен" : `Игровой режим: «${g.name}»`) : "Сохранено, движок не перезапущен",
        r.ok ? (off ? "игра — по общим правилам" : "игра и вход — выбранным путём") : r.message.slice(0, 90));
    } catch (err) { result(false, "Не получилось", String(err).slice(0, 90)); }
    busy = false;
    await loadGame();
  };
  $(".pg-game").addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".gq-go")) return void toggleGame();
    const c = t.closest<HTMLElement>(".gq-c");
    if (c?.classList.contains("find")) {
      c.querySelector("span")!.textContent = "ищу…";
      runList = await api.gamesRunning().catch(() => []);
      return renderGame();
    }
    if (c) { gsel = c.dataset.g!; selectGame(gsel); return renderGame(); }
    const r = t.closest<HTMLElement>(".gq-r");
    if (r && runList) {
      const a = runList[Number(r.dataset.r)];
      runList = null;
      const g = await addDropped(api, { name: a.name.replace(/\.exe$/i, ""), exe: a.path, dir: a.dir, icon: a.path, from: "run" });
      if (g) { gsel = g.id; note("ok", `«${g.name}» — можно включать`); }
      renderGame();
    }
  });
  $(".pg-game").addEventListener("wheel", (e) => { if ((e.target as HTMLElement).closest(".gq-run")) e.stopPropagation(); }, { passive: true });
  // Игру выбрали в окне wpx — показать и здесь.
  window.addEventListener("storage", (e) => { if (e.key === GAMES_KEY && page === 3) void loadGame(); });

  // ─── Перетащили файл или ссылку на вырез: «в игровой режим» или «в правила» ───
  let drag = false;
  const dropShow = (on: boolean) => {
    $(".nt-drop").hidden = !on;
    nt.classList.toggle("dropping", on);
    if (!on) document.querySelectorAll(".dz").forEach((z) => z.classList.remove("hot"));
  };
  const dropEnter = () => {
    drag = true;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    clearTimeout(actTimer);
    placeShow(false);
    setMode("open");
    dropShow(true);
  };
  const zoneAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(".dz") ?? null;
  const dropOver = (x: number, y: number) => {
    const z = zoneAt(x, y);
    document.querySelectorAll(".dz").forEach((d) => d.classList.toggle("hot", d === z));
  };
  const dropLeave = () => { drag = false; dropShow(false); };
  const dropDone = async (got: Promise<Got>, x: number, y: number) => {
    const z = zoneAt(x, y)?.dataset.z;
    dropLeave();
    if (!z) { note("warn", "Отпустите над «В игровой режим» или «В правила»"); return; }
    note("info", "разбираю…");
    const d = await resolveDrop(api, await got);
    if (typeof d === "string") { note("bad", d.slice(0, 90)); return; }
    if (z === "game") {
      const g = d.site ? null : await addDropped(api, d);
      if (!g) { note("bad", d.site ? "Это ссылка на сайт — её в правила" : "Не похоже на игру"); return; }
      gsel = g.id;
      page = 3;
      renderPage();
      note("ok", `«${g.name}» — в игровом режиме, осталось включить`);
    } else {
      const v = d.site ? domainOf(d.site) ?? d.site : d.exe ? baseName(d.exe) : "";
      if (!v) { note("bad", "Нет программы — перетащите exe или ярлык программы"); return; }
      pickedC = { kind: d.site ? "site" : "app", value: v, label: v, bytes: 0, fresh: true };
      $<HTMLInputElement>(".rsite").value = "";
      page = 2;
      renderPage();
      note("info", `${v} — куда направить?`);
    }
  };

  // ─── Проверки: скорость, утечки ───
  const check = (id: string, text: string, cls = "") => { const s = $(`#${id} small`); s.textContent = text; s.className = cls; };
  $("#qaSpeed").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    $<HTMLButtonElement>("#qaSpeed").disabled = true;
    check("ckSpeed", "идёт тест, ~30 с…");
    try {
      const r = await api.speedTest();
      if (r.error) check("ckSpeed", `не получилось: ${r.error}`, "bad");
      else {
        const t = `↓ ${r.down_mbps ?? "—"} Мбит/с · ↑ ${r.up_mbps ?? "—"} · отклик ${r.ping_ms ?? "—"} мс`;
        check("ckSpeed", t, "ok");
        if (mode !== "open") result(true, "Тест скорости", t);
      }
    } catch (err) { check("ckSpeed", String(err).slice(0, 80), "bad"); }
    $<HTMLButtonElement>("#qaSpeed").disabled = false;
    busy = false;
  });
  $("#qaLeaks").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    $<HTMLButtonElement>("#qaLeaks").disabled = true;
    check("ckLeaks", "проверяю…");
    try {
      const r = await api.leakCheck();
      const title = r.verdict === "ok" ? "Утечек нет" : r.verdict === "leak" ? "Есть утечка" : "Проверить не удалось";
      check("ckLeaks", `${title} · ${r.summary}`, r.verdict === "ok" ? "ok" : r.verdict === "leak" ? "bad" : "warn");
      if (mode !== "open") result(r.verdict === "ok", title, r.summary);
    } catch (err) { check("ckLeaks", String(err).slice(0, 80), "bad"); }
    $<HTMLButtonElement>("#qaLeaks").disabled = false;
    busy = false;
  });

  // ─── Булавка: поверх всех окон ───
  let pinned = true;
  const setPin = (on: boolean) => { pinned = on; $("#ntPin").classList.toggle("on", on); $("#ntPin").title = on ? "Поверх всех окон — включено" : "Поверх всех окон — выключено"; };
  try {
    const ws = await api.widgetState();
    setPin(ws.pinned);
    at = ws.anchor ?? "top";
  } catch { /* по умолчанию поверх, сверху */ }
  nt.dataset.at = at;
  nt.dataset.kind = kindOf(at);
  $("#ntPin").addEventListener("click", async () => {
    try { setPin(await api.widgetPin(!pinned)); } catch { /* осталось как было */ }
  });

  // События от Rust: курсор над формой (запасной путь, если событие мыши
  // потерялось), переезд к другому краю, перетаскивание файлов.
  if (tauri) {
    const { listen } = await import("@tauri-apps/api/event");
    void listen<boolean>("notch-hover", (e) => { if (e.payload) { if (mode !== "open") enter(); } else if (mode === "open" && !drag) leave(); });
    void listen("notch-leave", () => hideToEdge());
    void listen<string>("notch-anchor", (e) => arrive(e.payload as NotchAnchor));
    // Найдено на лету: помощник программы или адрес, который подгружает сайт.
    void listen<{ kind: string; app: string; item: string }>("follow-learned", (e) =>
      activity("info", `${e.payload.app.replace(/\.exe$/i, "")}: ещё ${learnedLabel(e.payload.item)}`,
        e.payload.kind === "site" ? "напрямую не открывался — теперь тем же путём" : "теперь тем же путём"));
  }
  initDrop({ enter: dropEnter, over: dropOver, leave: dropLeave, drop: (got, x, y) => void dropDone(got, x, y) });

  const apply = (s: Snapshot) => {
    const prev = snap;
    snap = s;
    document.body.dataset.health = s.health;
    if (s.on_reserve && s.reserve) document.body.dataset.reserve = "1"; else delete document.body.dataset.reserve;
    for (const c of cats) c.set(moodOf(s.health));
    feedScene(s.traffic.found ? s.traffic.rx_bps : 0, s.traffic.found ? s.traffic.tx_bps : 0, s.last_ms);
    for (const p of s.latency_tail) if (!lat.length || p[0] > lat[lat.length - 1][0]) lat.push(p);
    if (lat.length > 120) lat = lat.slice(-120);
    renderClosed(s);
    renderOpen();
    if (prev) events(prev, s);
  };

  try {
    const f = await api.full();
    lat = f.latency.slice(-120);
    apply(f.snapshot);
  } catch { /* дождёмся тика */ }
  renderPage();
  // Окно покажется по первой форме — капсула ещё в краю (data-hide), поэтому
  // не мигает; чуть позже она выезжает.
  await new Promise((r) => window.setTimeout(r, 60));
  api.widgetShape(...shapeOf(mode));
  window.setTimeout(() => { delete nt.dataset.hide; }, 140);
  // Демо в браузере: ?view=widget&demo&mode=open|act|down|drop|place&page=1&at=left
  const dm = q.get("mode");
  if (dm === "open") setMode("open");
  if (dm === "act") activity("info", "Теперь через Hysteria2", "Хельсинки", "583 мс");
  if (dm === "down") activity("bad", "Нет связи", "сервер прокси не отвечает");
  if (dm === "drop") dropEnter();
  if (dm === "place") { setMode("open"); placeShow(true); }
  if (q.has("demo")) Object.assign(window, { wpxNotch: { dropEnter, dropOver, dropDone, dropLeave, moveTo, arrive, hideToEdge } });
  api.onTick(apply);
}
