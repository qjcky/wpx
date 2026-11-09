// Игровой режим: игра — выбранным путём (по умолчанию — самым быстрым по
// проверке с этого ПК). «Перенаправление входа» ведёт тем же путём всё, что
// нужно для входа: папку игры (вход, выбор сервера, античит, помощники) и
// лаунчер — без этого часть онлайн-игр не пускает дальше первого экрана.
// Пока режим включён, «Сейчас» показывает, куда подключена игра, и меряет
// пути до её сервера: напрямую, через свои серверы и каскадом.

import type { Api } from "../core/api";
import type { Dropped, EngineInfo, GameMode, GameServer, NetSettings, ProfilesState, ProfileView, RouteRtt } from "../core/types";
import { $, esc, modal, runEngineOp, STEPS_RESTART } from "../core/ui";
import { showProtocols } from "./protocols";

export interface Game { id: string; name: string; tint: string; apps: string[]; dir?: string; path?: string; launchers: string[]; domains: string[] }

const STEAM = { launchers: ["steam.exe", "steamwebhelper.exe", "steamservice.exe"], domains: ["steampowered.com", "steamcommunity.com", "steamcontent.com", "steamserver.net", "steamstatic.com", "valvesoftware.com"] };
const RIOT = { launchers: ["RiotClientServices.exe", "RiotClientUx.exe", "RiotClientUxRender.exe", "vgc.exe"], domains: ["riotgames.com", "riotcdn.net", "pvp.net", "leagueoflegends.com", "playvalorant.com"] };
const EPIC = { launchers: ["EpicGamesLauncher.exe", "EpicWebHelper.exe"], domains: ["epicgames.com", "epicgames.dev", "unrealengine.com", "fortnite.com"] };
const EA = { launchers: ["EADesktop.exe", "EABackgroundService.exe", "EAConnect_microsoft.exe"], domains: ["ea.com", "origin.com", "respawn.com"] };
const BNET = { launchers: ["Battle.net.exe", "Agent.exe"], domains: ["battle.net", "blizzard.com"] };

/** Популярные онлайн-игры: exe, лаунчер и сайты входа (их можно поправить у себя). */
export const GAMES: Game[] = [
  { id: "cs2", name: "Counter-Strike 2", tint: "#f59e0b", apps: ["cs2.exe"], ...STEAM },
  { id: "dota2", name: "Dota 2", tint: "#ef4444", apps: ["dota2.exe"], ...STEAM },
  { id: "valorant", name: "Valorant", tint: "#f43f5e", apps: ["VALORANT-Win64-Shipping.exe"], ...RIOT },
  { id: "lol", name: "League of Legends", tint: "#38bdf8", apps: ["League of Legends.exe", "LeagueClient.exe", "LeagueClientUx.exe"], ...RIOT },
  { id: "fortnite", name: "Fortnite", tint: "#a78bfa", apps: ["FortniteClient-Win64-Shipping.exe"], ...EPIC },
  { id: "pubg", name: "PUBG", tint: "#facc15", apps: ["TslGame.exe"], launchers: STEAM.launchers, domains: [...STEAM.domains, "pubg.com", "playbattlegrounds.com"] },
  { id: "apex", name: "Apex Legends", tint: "#dc2626", apps: ["r5apex.exe", "r5apex_dx12.exe"], ...EA },
  { id: "genshin", name: "Genshin Impact", tint: "#60a5fa", apps: ["GenshinImpact.exe"], launchers: ["HYP.exe", "launcher.exe"], domains: ["hoyoverse.com", "mihoyo.com", "hoyolab.com"] },
  { id: "wow", name: "World of Warcraft", tint: "#3b82f6", apps: ["Wow.exe"], ...BNET },
  { id: "r6", name: "Rainbow Six Siege", tint: "#94a3b8", apps: ["RainbowSix.exe", "RainbowSix_Vulkan.exe"], launchers: ["upc.exe", "UbisoftConnect.exe", "UplayWebCore.exe"], domains: ["ubi.com", "ubisoft.com", "ubisoftconnect.com"] },
  { id: "tarkov", name: "Escape from Tarkov", tint: "#a3a380", apps: ["EscapeFromTarkov.exe"], launchers: ["BsgLauncher.exe"], domains: ["escapefromtarkov.com", "battlestategames.com"] },
  { id: "roblox", name: "Roblox", tint: "#e5e7eb", apps: ["RobloxPlayerBeta.exe"], launchers: ["RobloxPlayerLauncher.exe"], domains: ["roblox.com", "rbxcdn.com"] },
];

/** Своё у пользователя: правки пресетов, свои игры, значки по пути exe,
 *  выбранная игра (общая для окна и выреза). */
interface Mine { over: Record<string, Partial<Game>>; custom: Game[]; icons: Record<string, string>; sel?: string }
export const KEY = "wpx.games";
function mine(): Mine {
  try { const m = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return { over: m.over ?? {}, custom: m.custom ?? [], icons: m.icons ?? {}, sel: m.sel }; }
  catch { return { over: {}, custom: [], icons: {} }; }
}
function keep(m: Mine) { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* приватный режим */ } }

/** Все игры: пресеты с правками пользователя и свои. */
export function all(): Game[] {
  const m = mine();
  return [...GAMES.map((g) => ({ ...g, ...m.over[g.id] })), ...m.custom];
}

let api: Api;
let picked: string | null = null;
let target = "main";
let profiles: ProfileView[] = [];
let active: string | null = null;
/** Пинг путей по последней проверке: id профиля → мс (null — не ответил). */
let ping = new Map<string, number | null>();

const list = (s: string) => s.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
/** Путь передаёт UDP (онлайн-играм он нужен): VPN, каскад, маршрут — да; HTTP/SOCKS — нет. */
const udp = (p: ProfileView) => p.endpoints.length > 0 || !!p.cascade || p.route.length > 0;
/** Точки, которые сами ходят по UDP: для игр лучше TCP (VLESS). */
const UDP_KINDS = new Set(["awg", "hysteria2"]);
const KIND_NAME: Record<string, string> = { awg: "AmneziaWG", hysteria2: "Hysteria2" };
const hasUdpPoints = (p: ProfileView) => p.endpoints.some((e) => UDP_KINDS.has(e.kind)) || !!p.cascade || p.route.length > 0;

/** Что в профиле для игры: точки по UDP или только по TCP. */
function forGames(p: ProfileView) {
  if (!udp(p)) return "прокси без UDP — онлайн-играм не подойдёт";
  if (p.cascade) return "каскад";
  if (p.route.length) return "маршрут";
  const u = [...new Set(p.endpoints.map((e) => e.kind).filter((k) => UDP_KINDS.has(k)))].map((k) => KIND_NAME[k]);
  return u.length ? `${u.join(", ")} — по UDP, для игр хорошо` : "только VLESS (TCP) — при потерях пакетов игра подлагивает";
}
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2);

/** Ключ значка: exe, иначе папка игры. */
const iconKey = (g: Pick<Game, "path" | "dir">) => (g.path || g.dir || "").toLowerCase();

export function icon(g: Game) {
  const src = mine().icons[iconKey(g)];
  return src ? `<img class="gm-ico" src="${src}" alt="">` : `<span class="gm-ico">${esc(initials(g.name))}</span>`;
}

/** Выбранная игра: та, что в работе, иначе последняя выбранная (в окне или вырезе). */
export function selected(g: GameMode | null | undefined): string | null {
  return g?.on ? g.game : mine().sel ?? null;
}
export function select(id: string | null) {
  const m = mine();
  if (id) m.sel = id; else delete m.sel;
  keep(m);
}

/** Мои игры: свои, поправленные и выбранная — для быстрого выбора в вырезе. */
export function mineFirst(): Game[] {
  const m = mine();
  return all().filter((g) => m.custom.some((c) => c.id === g.id) || m.over[g.id] || g.id === m.sel);
}

/** Состав игры для движка. */
export function gameMode(g: Game, login: boolean, target: string, udpOnly: boolean): GameMode {
  return { on: true, game: g.id, name: g.name, apps: g.apps, dir: login ? g.dir ?? "" : "", login, launchers: g.launchers, domains: g.domains, target, udp_only: udpOnly };
}

/** Перетащенное на вырез или найденное запущенным — в игры: совпало с
 *  пресетом по exe — дополняем его, та же папка — обновляем свою, иначе — новая. */
export async function addDropped(a: Api, d: Dropped): Promise<Game | null> {
  const exe = d.exe?.split(/[\\/]/).pop() ?? "";
  if (!exe && !d.dir) return null;
  const lo = (s?: string | null) => (s ?? "").toLowerCase();
  const preset = exe ? all().find((g) => g.apps.some((x) => x.toLowerCase() === exe.toLowerCase())) : undefined;
  const same = mine().custom.find((g) => d.dir && lo(g.dir) === lo(d.dir));
  const g: Game = preset
    ? { ...preset, dir: d.dir ?? preset.dir, path: d.exe ?? preset.path }
    : { id: same?.id ?? `c${Date.now().toString(36)}`, name: d.name || same?.name || "Игра", tint: "#a3a3a3", apps: exe ? [exe] : same?.apps ?? [], dir: d.dir ?? "", path: d.exe ?? undefined, launchers: same?.launchers ?? [], domains: same?.domains ?? [] };
  saveGame(g);
  const src = d.icon || d.exe;
  if (src) {
    const ic = await a.exeIcon(src).catch(() => "");
    if (ic) { const m = mine(); m.icons[iconKey(g)] = ic; keep(m); }
  }
  select(g.id);
  return g;
}

function gamesHtml() {
  return all().map((g) => `<button type="button" class="gm-game" data-g="${esc(g.id)}" aria-pressed="${picked === g.id}" style="--gt:${g.tint}">${icon(g)}<b>${esc(g.name)}</b></button>`).join("")
    + `<button type="button" class="gm-game other" data-g="custom" aria-pressed="${picked === "custom"}"><span class="gm-ico">+</span><b>Другая игра</b></button>`;
}

/** Состав выбранной игры — можно поправить; правка хранится у пользователя. */
function compHtml() {
  const g = all().find((x) => x.id === picked);
  if (picked !== "custom" && !g) return "";
  const v = (a?: string[]) => esc((a ?? []).join(", "));
  const preset = GAMES.some((x) => x.id === picked);
  const edited = preset && !!mine().over[picked!];
  return `<details class="gm-comp" ${picked === "custom" || edited ? "open" : ""}><summary>Состав игры${edited ? " · изменён" : ""}</summary>
    <div class="gm-fields">
      ${picked === "custom" || (g && !preset) ? `<label class="field"><span>Название</span><input id="gmName" value="${esc(g?.name ?? "")}" placeholder="Aion 2"></label>` : ""}
      <label class="field"><span>exe игры</span><input id="gmExe" class="mono" value="${v(g?.apps)}" placeholder="game.exe"></label>
      <label class="field wide"><span>Папка игры — всё, что из неё запускается (вход, античит), пойдёт тем же путём</span><input id="gmDir" class="mono" value="${esc(g?.dir ?? "")}" placeholder="D:\\Games\\Aion 2"></label>
      <label class="field"><span>Лаунчер</span><input id="gmLaunch" class="mono" value="${v(g?.launchers)}" placeholder="launcher.exe"></label>
      <label class="field"><span>Сайты входа — обычно не нужно</span><input id="gmDomains" class="mono" value="${v(g?.domains)}" placeholder="game.com"></label>
    </div>
    <p class="hint">Проще всего: запустите игру и нажмите «Найти игру» — exe, папку и значок wpx возьмёт сам. Сайты входа нужны, только если вход идёт через браузер.</p>
    <div class="gm-comp-acts"><button type="button" class="btn sm" id="gmSave">Сохранить состав</button>
      ${edited ? '<button type="button" class="btn sm" id="gmReset">Как было</button>' : ""}
      ${g && !preset ? '<button type="button" class="btn sm danger" id="gmDel">Убрать игру</button>' : ""}</div>
  </details>`;
}

function pathsHtml() {
  // Самый быстрый — один (при равенстве — первый проверенный).
  const fastest = [...ping.entries()].filter(([, v]) => v != null).sort((a, b) => a[1]! - b[1]!)[0]?.[0];
  const row = (id: string, name: string, sub: string, ok: boolean) => {
    const pid = id === "main" ? active : id.slice(8);
    const ms = pid ? ping.get(pid) : undefined;
    const best = ok && ms != null && pid === fastest;
    return `<label class="gm-path${ok ? "" : " off"}"><input type="radio" name="gmPath" value="${id}" ${target === id ? "checked" : ""} ${ok ? "" : "disabled"}>
      <span class="nm"><b>${esc(name)}</b><small>${esc(sub)}</small></span>
      <span class="ms">${ms === undefined ? "" : ms === null ? '<em class="bad">не ответил</em>' : `${ms} мс`}${best ? ' <em class="ok">быстрее всех</em>' : ""}</span></label>`;
  };
  const main = profiles.find((p) => p.id === active);
  const rows = [row("main", `Рабочий профиль${main ? ` «${main.name}»` : ""}`, main ? forGames(main) : "тот, что сейчас в работе", !main || udp(main))];
  for (const p of profiles.filter((x) => x.id !== active)) rows.push(row(`profile:${p.id}`, p.name, forGames(p), udp(p)));
  rows.push(row("direct", "Напрямую, без VPN", "если игру не блокируют и напрямую пинг ниже; kill switch на роутере прямой путь не пустит", true));
  return rows.join("");
}

/** Подсказка у «Только UDP-точки»: в выбранном профиле их может не быть. */
function udpNote() {
  const pid = target === "main" ? active : target.startsWith("profile:") ? target.slice(8) : null;
  const p = profiles.find((x) => x.id === pid);
  const on = $<HTMLInputElement>("gmUdp").checked;
  $("gmUdpNote").textContent = target === "direct" ? "игра идёт напрямую — VPN-точки не участвуют"
    : p && !udp(p) ? "этот профиль — прокси без UDP: для онлайн-игры выберите VPN"
    : on && p && !hasUdpPoints(p) ? "в этом профиле нет точек AmneziaWG или Hysteria2 — игра пойдёт обычными (TCP)"
    : "AmneziaWG или Hysteria2 — с VLESS (TCP) игра может подлагивать";
}

function render(g: GameMode | null) {
  $("gmGames").innerHTML = gamesHtml();
  $("gmComp").innerHTML = compHtml();
  $("gmPaths").innerHTML = pathsHtml();
  udpNote();
  const on = !!g?.on;
  $("gmStop").hidden = !on;
  $<HTMLButtonElement>("gmGo").textContent = on ? "Применить изменения" : "Запустить игровой режим";
  const tname = (t: string) => (t === "main" || !t ? "рабочий профиль" : t === "direct" ? "напрямую" : profiles.find((p) => `profile:${p.id}` === t)?.name ?? "профиль удалён");
  $("gmState").innerHTML = on ? `<span class="badge">включён</span> ${esc(g!.name)} → ${esc(tname(g!.target))}${g!.login ? " · вход тем же путём" : ""}` : "";
}

/** Поля состава → игра (для своей — новая или обновлённая). */
function fromFields(): Game | null {
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
  const apps = list(val("gmExe"));
  const dir = val("gmDir").trim().replace(/[\\/]+$/, "");
  if (!apps.length && !dir) return null;
  const base = all().find((x) => x.id === picked);
  const name = val("gmName").trim() || base?.name || (apps[0] ?? dir.split(/[\\/]/).pop() ?? "Игра").replace(/\.exe$/i, "");
  return { id: picked === "custom" || !picked ? `c${Date.now().toString(36)}` : picked, name, tint: base?.tint ?? "#a3a3a3", apps, dir, path: base?.path, launchers: list(val("gmLaunch")), domains: list(val("gmDomains")) };
}

function saveGame(g: Game) {
  const m = mine();
  if (GAMES.some((x) => x.id === g.id)) m.over[g.id] = { apps: g.apps, dir: g.dir, path: g.path, launchers: g.launchers, domains: g.domains };
  else m.custom = [...m.custom.filter((x) => x.id !== g.id), g];
  m.sel = g.id;
  keep(m);
  picked = g.id;
}

/** Найти запущенную игру: exe, папка и значок — сами. */
async function find() {
  const apps = await api.gamesRunning().catch(() => []);
  const m = mine();
  await Promise.all(apps.slice(0, 16).map(async (a) => {
    const k = a.path.toLowerCase();
    if (!m.icons[k]) m.icons[k] = await api.exeIcon(a.path).catch(() => "");
  }));
  keep(m);
  const body = apps.length
    ? `<p>Запустите игру (хотя бы до первого экрана) и выберите её в списке. wpx возьмёт exe, папку и значок.</p>
       <div class="gm-run">${apps.map((a, i) => `<button type="button" class="gm-run-row" data-i="${i}">${m.icons[a.path.toLowerCase()] ? `<img src="${m.icons[a.path.toLowerCase()]}" alt="">` : '<span class="gm-ico">?</span>'}
         <span><b>${esc(a.name)}</b><small>${esc(a.dir)}</small></span><em>${a.mem_mb} МБ</em></button>`).join("")}</div>`
    : `<p>Похожих на игру программ не нашлось. Запустите игру и нажмите «Найти игру» ещё раз.</p>`;
  const done = modal("Найти игру", body, null, "Отмена");
  document.querySelectorAll<HTMLButtonElement>(".gm-run-row").forEach((b) => b.addEventListener("click", () => {
    const a = apps[Number(b.dataset.i)];
    // Совпало с пресетом по exe — дополняем его; иначе — своя игра.
    const preset = all().find((g) => g.apps.some((x) => x.toLowerCase() === a.name.toLowerCase()));
    const g: Game = preset
      ? { ...preset, dir: a.dir, path: a.path }
      : { id: `c${Date.now().toString(36)}`, name: a.name.replace(/\.exe$/i, ""), tint: "#a3a3a3", apps: [a.name], dir: a.dir, path: a.path, launchers: [], domains: [] };
    saveGame(g);
    $("modalCancel").click();
    void onGamesShown();
  }));
  await done;
}

/** Проверить пути с этого ПК (как пойдёт движок) и выбрать самый быстрый. */
async function pickFastest() {
  const btn = $<HTMLButtonElement>("gmPick");
  btn.disabled = true;
  btn.textContent = "Проверяю пути…";
  const cands = profiles.filter(udp);
  ping = new Map();
  await Promise.all(cands.map(async (p) => {
    try {
      const r = await api.profileProbe(p.id, true);
      const ms = r.filter((x) => x.ok > 0 && x.median_ms != null).map((x) => x.median_ms!);
      ping.set(p.id, ms.length ? Math.min(...ms) : null);
    } catch { ping.set(p.id, null); }
  }));
  const best = [...ping.entries()].filter(([, v]) => v != null).sort((a, b) => a[1]! - b[1]!)[0];
  if (best) target = best[0] === active ? "main" : `profile:${best[0]}`;
  btn.disabled = false;
  btn.textContent = "Подобрать самый быстрый";
  $("gmPaths").innerHTML = pathsHtml();
  $("gmNote").textContent = best ? "" : "Ни один путь не ответил с этого ПК — проверьте профили на вкладке «Профили».";
}

async function apply(on: boolean) {
  let net: NetSettings;
  try { net = (await api.engineInfo()).net; }
  catch (e) { loadFailed(e); return; }
  if (on) {
    // Несохранённые правки состава — тоже в дело.
    const f = picked ? fromFields() : null;
    if (f && picked === "custom") saveGame(f);
    const g = f ?? all().find((x) => x.id === picked);
    if (!g || (!g.apps.length && !g.dir)) {
      await modal("Игровой режим", `<div class="result bad">${picked ? "Укажите exe или папку игры — или нажмите «Найти игру»." : "Выберите игру."}</div>`, null, "Понятно");
      return;
    }
    net.game = gameMode(g, $<HTMLInputElement>("gmLogin").checked, target, $<HTMLInputElement>("gmUdp").checked);
  } else {
    net.game = { ...net.game, on: false };
  }
  const path = target === "main" ? "рабочий профиль" : target === "direct" ? "напрямую, без VPN" : profiles.find((p) => `profile:${p.id}` === target)?.name ?? "";
  await runEngineOp({
    title: on ? "Игровой режим" : "Выключить игровой режим",
    intro: on
      ? `<p>Движок перезапустится: «${esc(net.game.name)}» пойдёт через «${esc(path)}»${net.game.login ? ", вход в игру — тем же путём" : ""}. Если туннель не поднимется — всё вернётся как было.</p>${live.length ? "<p>Игра сейчас на сервере — она переподключится.</p>" : ""}`
      : "<p>Игра снова пойдёт по общим правилам. Движок перезапустится.</p>",
    confirm: on ? "Запустить" : "Выключить",
    steps: STEPS_RESTART,
    // Сохраняем только после подтверждения: отказ ничего не меняет.
    call: async () => { await api.netSave(net); return api.engineApplyNet(); },
  });
  await onGamesShown();
}

/** Показать игру во вкладке «Игры» (перетащили ярлык в окно). */
export function openGame(id: string) {
  picked = id;
  select(id);
  document.querySelector<HTMLButtonElement>('[data-page="games"]')?.click();
  void onGamesShown();
}

/** Движок не ответил — причина в заметке под кнопкой (до следующей удачной загрузки). */
let loadErr = "";
function loadFailed(e: unknown) {
  loadErr = String(e);
  $("gmNote").textContent = loadErr;
}

export async function onGamesShown() {
  let ps: ProfilesState, info: EngineInfo;
  try { [ps, info] = await Promise.all([api.profiles(), api.engineInfo()]); }
  catch (e) { loadFailed(e); return; }
  if (loadErr && $("gmNote").textContent === loadErr) $("gmNote").textContent = "";
  loadErr = "";
  profiles = ps.profiles;
  active = ps.active;
  const g = info.net.game;
  if (g?.on && !picked) {
    picked = g.game;
    target = g.target || "main";
    $<HTMLInputElement>("gmLogin").checked = g.login;
    $<HTMLInputElement>("gmUdp").checked = g.udp_only;
  }
  // Выбранная в вырезе (перетащили ярлык) — и здесь.
  if (!g?.on && mine().sel && all().some((x) => x.id === mine().sel)) picked = mine().sel!;
  render(g ?? null);
  gameOn = !!g?.on;
  liveStart();
}

// ─── Сейчас: куда подключена игра и замер путей до её сервера ───

let gameOn = false;
let liveTimer: number | undefined;
let live: GameServer[] = [];
/** Выбранный адрес игры («ip:port/udp»); замер — для него. */
let liveSel: string | null = null;
let rts: RouteRtt[] | null = null;
let rtsFor = "";
let measuring = false;
let measureErr = "";

const srvKey = (s: GameServer) => `${s.ip}:${s.port}/${s.network}`;
const mb = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

function rtsHtml() {
  if (measureErr && rtsFor === liveSel) return `<div class="result bad">${esc(measureErr)}</div>`;
  if (!rts || rtsFor !== liveSel) return "";
  const cur = target === "main" ? active : target === "direct" ? "direct" : target.slice(8);
  const best = rts.find((r) => r.total != null);
  return `<div class="gm-rts">${rts.map((r) => {
    const pid = r.kind === "direct" ? "direct" : r.profile;
    const now = !!pid && pid === cur;
    const legs = r.legs.map((l) => `${esc(l.name)} ${l.ms == null ? "—" : l.ms}`).join(" · ");
    return `<div class="gm-rt${r === best ? " best" : ""}"><span class="nm"><b>${esc(r.name)}</b><small>${legs}</small></span>
      <span class="ms">${r.total == null ? '<em class="bad">не ответил</em>' : `${r.total} мс`}${r === best ? ' <em class="ok">быстрее всех</em>' : ""}${now ? ' <em class="now">сейчас</em>' : ""}</span>
      ${pid && !now && r.total != null ? `<button type="button" class="btn sm" data-use="${esc(pid)}">Играть через этот путь</button>` : "<span></span>"}
      ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}</div>`;
  }).join("")}</div>
  <p class="note">Пинг пути — сумма участков; в самой игре он обычно на 5–15 мс больше. «Напрямую» и «ПК → сервер» меряются мимо туннеля: если на роутере kill switch, прямой путь не ответит.</p>`;
}

function liveHtml() {
  if (!live.length) return `<p class="note">Запустите игру и войдите на сервер — wpx увидит, куда она подключилась, и замерит пути до него: напрямую, через ваши серверы и каскадом из двух.</p>`;
  const rows = live.slice(0, 4).map((s, i) => `<label><input type="radio" name="gmSrv" value="${esc(srvKey(s))}" ${srvKey(s) === liveSel ? "checked" : ""}>
    <span class="nm"><b>${esc(s.ip)}:${s.port} · ${esc(s.network.toUpperCase())}</b><small>${i === 0 ? "основной · " : ""}${s.host ? `${esc(s.host)} · ` : ""}${s.via === "напрямую" || s.via === "блок" ? esc(s.via) : `через ${esc(s.via)}`} · ${mb(s.bytes)}</small></span></label>`).join("");
  return `<div class="gm-srv">${rows}</div>
    <div class="gm-measure"><button type="button" class="btn primary" id="gmMeasure" ${measuring ? "disabled" : ""}>${measuring ? "Замеряю…" : "Замерить пути до сервера"}</button>
      <span class="hint">напрямую, через ваши серверы и каскадом — 10–30 с; серверы мерят по SSH, ничего не меняя</span></div>
    ${rtsHtml()}`;
}

function renderLive() {
  $("gmLive").hidden = !gameOn;
  if (gameOn) $("gmLiveBody").innerHTML = liveHtml();
}

async function poll() {
  if (!gameOn || document.hidden || $("pageGames").hidden) return;
  try { live = await api.gameServers(); } catch { live = []; }
  if (!liveSel || !live.some((s) => srvKey(s) === liveSel)) liveSel = live[0] ? srvKey(live[0]) : null;
  renderLive();
}

function liveStart() {
  onGamesLeft();
  renderLive();
  if (!gameOn) return;
  void poll();
  liveTimer = window.setInterval(() => void poll(), 4000);
}

/** Ушли со вкладки — не опрашиваем. */
export function onGamesLeft() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = undefined; }
}

async function measure() {
  const s = live.find((x) => srvKey(x) === liveSel);
  if (!s || measuring) return;
  measuring = true;
  measureErr = "";
  renderLive();
  try { rts = await api.gameMeasure(s.ip, s.port, s.network); }
  catch (e) { rts = null; measureErr = String(e); }
  rtsFor = srvKey(s);
  measuring = false;
  renderLive();
}

/** «Играть через этот путь»: профиль (или напрямую) — путём игры, движок перезапустится. */
function use(pid: string) {
  target = pid === "direct" ? "direct" : pid === active ? "main" : `profile:${pid}`;
  $("gmPaths").innerHTML = pathsHtml();
  udpNote();
  void apply(true);
}

export function initGames(a: Api) {
  api = a;
  $("gmGames").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".gm-game");
    if (!b) return;
    picked = b.dataset.g!;
    if (picked !== "custom") select(picked);
    document.querySelectorAll<HTMLButtonElement>(".gm-game").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("gmComp").innerHTML = compHtml();
    if (picked === "custom") (document.getElementById("gmName") as HTMLInputElement | null)?.focus();
  });
  $("gmComp").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).id;
    if (id === "gmSave") { const g = fromFields(); if (g) { saveGame(g); render(null); void onGamesShown(); } }
    if (id === "gmReset" && picked) { const m = mine(); delete m.over[picked]; keep(m); void onGamesShown(); }
    if (id === "gmDel" && picked) { const m = mine(); m.custom = m.custom.filter((x) => x.id !== picked); if (m.sel === picked) delete m.sel; keep(m); picked = null; void onGamesShown(); }
  });
  $("gmFind").addEventListener("click", () => void find());
  $("gmPaths").addEventListener("change", (e) => { target = (e.target as HTMLInputElement).value; udpNote(); });
  $("gmUdp").addEventListener("change", udpNote);
  $("gmLiveBody").addEventListener("change", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLInputElement>("input[name=gmSrv]");
    if (r) { liveSel = r.value; renderLive(); }
  });
  $("gmLiveBody").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("#gmMeasure")) { void measure(); return; }
    const u = el.closest<HTMLButtonElement>("button[data-use]");
    if (u) use(u.dataset.use!);
  });
  $("gmPick").addEventListener("click", () => void pickFastest());
  $("gmFaq").addEventListener("click", () => showProtocols("wireguard"));
  $("gmGo").addEventListener("click", () => void apply(true));
  $("gmStop").addEventListener("click", () => void apply(false));
  // Игру добавили в вырезе (перетащили ярлык) — показать здесь.
  window.addEventListener("storage", (e) => { if (e.key === KEY) void onGamesShown(); });
}
