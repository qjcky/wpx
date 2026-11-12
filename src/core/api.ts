// Мост окна к Rust-командам (или к мок-данным в обычном браузере).

import type { MonitorInfo,
  ApplyResult, ChainProbe, ConnList, EngineInfo, FullState, NetSettings, ParsedItem, Prefs, ProbeResult, ProfileInput, ProfileTest,
  MemberProbe, ProfilesState, RouterCheck, RouterRule, ServerInput, ServerLog, ServerOpResult, ServersState, Snapshot, SpeedResult, TrialStatus, WidgetState,
  GameServer, GuestInput, GuestOp, GuestStat, LeakCheck, ListItems, MovePlan, RouteRtt, PointHistory, ServerCheck, Share, UpdateInfo,
} from "./types";

export interface Api {
  full(): Promise<FullState>;
  onTick(cb: (s: Snapshot) => void): void;
  checkNow(): void;
  minimize(): void;
  hide(): void;
  openLog(): void;
  refreshErrors(): Promise<[number, number][]>;
  getPrefs(): Promise<Prefs>;
  setPrefs(p: Prefs): Promise<Prefs>;
  /** Язык и словарь для трея и уведомлений. */
  setLang(lang: string, dict: unknown): Promise<void>;
  /** Запущенные программы, похожие на игры (exe, папка). */
  gamesRunning(): Promise<import("./types").RunningApp[]>;
  /** Значок exe как data-URL. */
  exeIcon(path: string): Promise<string>;
  gameServers(): Promise<GameServer[]>;
  gameMeasure(ip: string, port: number, network: string): Promise<RouteRtt[]>;
  // Профили
  profiles(): Promise<ProfilesState>;
  profileSave(input: ProfileInput): Promise<ProfilesState>;
  profileDelete(id: string): Promise<ProfilesState>;
  profileTest(input: ProfileInput): Promise<ProfileTest>;
  profileActivate(id: string): Promise<ApplyResult>;
  profileDeactivate(): Promise<ApplyResult>;
  linksParse(text: string): Promise<ParsedItem[]>;
  linksProbe(text: string, direct: boolean): Promise<ProbeResult[]>;
  profileImport(name: string, text: string, mode: string, order: number[]): Promise<ProfilesState>;
  profileEditVpn(input: { id: string; name: string; mode: string; order: number[]; add: string }): Promise<ProfilesState>;
  profileProbe(id: string, direct: boolean): Promise<ProbeResult[]>;
  profileHistory(id: string): Promise<PointHistory[]>;
  routerRules(id: string): Promise<RouterRule[]>;
  routerCheck(id: string): Promise<RouterCheck[]>;
  routeSave(id: string | null, name: string, members: string[], mode: string): Promise<ProfilesState>;
  routeProbe(members: string[], direct: boolean): Promise<MemberProbe[]>;
  cascadeProbe(entry: string, exit: string, direct: boolean): Promise<ChainProbe>;
  cascadeSave(id: string | null, name: string, entry: string, exit: string): Promise<ProfilesState>;
  buildInfo(): Promise<{ lab: boolean; version: string }>;
  // Обновление wpx
  /** Есть ли новая версия (null — у вас последняя). */
  updateCheck(): Promise<UpdateInfo | null>;
  /** Скачать и поставить; при успехе wpx перезапускается и ответа не будет. */
  updateInstall(): Promise<void>;
  // Пробный запуск профиля (без TUN)
  trialStart(id: string): Promise<TrialStatus>;
  trialStatus(): Promise<TrialStatus>;
  trialCheck(): Promise<TrialStatus>;
  trialStop(): Promise<void>;
  trialBrowser(): Promise<string>;
  trialSpeed(): Promise<SpeedResult>;
  // Свои серверы
  servers(): Promise<ServersState>;
  serverAdd(input: ServerInput): Promise<ServersState>;
  /** Отпечаток ключа нового сервера — до входа, пароль не отправляется. */
  serverFingerprint(host: string, port: number | null, via: string | null): Promise<string>;
  serverInspect(id: string): Promise<ServersState>;
  serverInstall(id: string, vless: boolean, hy2: boolean, awg: boolean, xhttp: boolean, mtproxy: boolean, harden: boolean, cover?: string): Promise<ServerOpResult>;
  /** Профиль этого ПК из уже настроенного сервера — сервер не меняется. */
  serverProfile(id: string): Promise<ServerOpResult>;
  serverMtproxyLink(id: string): Promise<{ link: string; web: string; qr: string }>;
  serverHarden(id: string, bbr: boolean, autoupd: boolean, f2b: boolean): Promise<ServersState>;
  serverCascade(entry: string, exit: string, via?: string | null): Promise<ServerOpResult>;
  serverCascadeRemove(entry: string, exit: string): Promise<ServersState>;
  serverUninstall(id: string): Promise<ServersState>;
  serverForget(id: string): Promise<ServersState>;
  serverFirewall(id: string, on: boolean, keep: string[]): Promise<ServersState>;
  serverCheck(id: string): Promise<ServerCheck>;
  serverUpdate(id: string): Promise<ServersState>;
  serverMovePlan(from: string, to: string): Promise<MovePlan>;
  serverMove(from: string, to: string, cleanOld: boolean): Promise<ServerOpResult>;
  onServerLog(cb: (l: ServerLog) => void): void;
  onServersChanged(cb: () => void): void;
  // Поделиться доступом
  guestAdd(id: string, input: GuestInput): Promise<GuestOp>;
  guestUpdate(id: string, guest: string, off: boolean, expires: number | null): Promise<ServersState>;
  guestRemove(id: string, guest: string): Promise<ServersState>;
  guestShare(id: string, guest: string): Promise<Share>;
  guestSaveConf(id: string, guest: string): Promise<string>;
  guestStats(id: string): Promise<GuestStat[]>;
  // Диагностика
  leakCheck(): Promise<LeakCheck>;
  supportReport(hide: boolean): Promise<string>;
  // Движок
  engineInfo(): Promise<EngineInfo>;
  netSave(net: NetSettings): Promise<void>;
  netCheck(net: NetSettings): Promise<string>;
  engineApplyNet(): Promise<ApplyResult>;
  restart(): Promise<ApplyResult>;
  start(): Promise<ApplyResult>;
  stop(): Promise<ApplyResult>;
  setBoot(on: boolean): Promise<ApplyResult>;
  deepTest(): Promise<ApplyResult>;
  /** Удалить движок: задачи, правила файрвола, папку движка. */
  engineUninstall(): Promise<ApplyResult>;
  setHeal(on: boolean): Promise<ApplyResult>;
  /** Заменить mihomo версией из поставки wpx — с проверкой туннеля и откатом. */
  engineUpdate(): Promise<ApplyResult>;
  /** Пауза VPN: всё напрямую, без прав администратора; до «Включить» или перезапуска движка. */
  enginePause(on: boolean, minutes?: number): Promise<void>;
  // Трафик
  conns(): Promise<ConnList>;
  listItems(id: string): Promise<ListItems>;
  connsClose(ids: string[]): Promise<number>;
  speedTest(): Promise<SpeedResult>;
  speedHistory(): Promise<SpeedResult[]>;
  // Виджет
  widgetToggle(): void;
  widgetClose(): void;
  widgetPin(on: boolean): Promise<boolean>;
  widgetState(): Promise<WidgetState>;
  showMain(): void;
  startResize(): void;
  /** Вырез: текущая форма (капсула, панель, активность) — там окно принимает мышь. */
  widgetShape(w: number, h: number): void;
  /** Экраны для выреза и перенос на выбранный (null — основной). */
  widgetMonitors(): Promise<MonitorInfo[]>;
  widgetSetMonitor(name: string | null): Promise<void>;
  /** Поставить вырез к краю или углу экрана. */
  widgetSetAnchor(anchor: import("./types").NotchAnchor): Promise<void>;
  /** Перетаскивание выреза: по отпусканию — к ближайшему краю или углу. */
  widgetDrag(): Promise<void>;
  /** Убрать найденное у правила «и всё, что она запускает». */
  followForget(app: string, item: string): Promise<void>;
  /** Разобрать перетащенное на вырез. */
  dropInspect(path: string): Promise<import("./types").Dropped>;
}

export async function tauriApi(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  return {
    full: () => invoke<FullState>("get_state"),
    onTick: (cb) => void listen<Snapshot>("tick", (e) => cb(e.payload)),
    checkNow: () => void invoke("check_now"),
    minimize: () => void win.minimize(),
    hide: () => void invoke("hide_window"),
    openLog: () => void invoke("open_engine_log"),
    refreshErrors: () => invoke<FullState>("get_state").then((f) => f.err_minutes),
    getPrefs: () => invoke<Prefs>("get_prefs"),
    setPrefs: (prefs) => invoke<Prefs>("set_prefs", { prefs }),
    setLang: (lang, dict) => invoke<void>("set_lang", { lang, dict }),
    gamesRunning: () => invoke("games_running"),
    exeIcon: (path) => invoke<string>("exe_icon", { path }),
    gameServers: () => invoke<GameServer[]>("game_servers"),
    gameMeasure: (ip, port, network) => invoke<RouteRtt[]>("game_measure", { ip, port, network }),
    profiles: () => invoke<ProfilesState>("profiles_list"),
    profileSave: (input) => invoke<ProfilesState>("profile_save", { input }),
    profileDelete: (id) => invoke<ProfilesState>("profile_delete", { id }),
    profileTest: (input) => invoke<ProfileTest>("profile_test", { input }),
    profileActivate: (id) => invoke<ApplyResult>("profile_activate", { id }),
    profileDeactivate: () => invoke<ApplyResult>("profile_deactivate"),
    linksParse: (text) => invoke<ParsedItem[]>("links_parse", { text }),
    linksProbe: (text, direct) => invoke<ProbeResult[]>("links_probe", { text, direct }),
    profileImport: (name, text, mode, order) => invoke<ProfilesState>("profile_import", { name, text, mode, order }),
    profileEditVpn: (input) => invoke<ProfilesState>("profile_edit_vpn", { input }),
    profileProbe: (id, direct) => invoke<ProbeResult[]>("profile_probe", { id, direct }),
    profileHistory: (id) => invoke<PointHistory[]>("profile_history", { id }),
    routerRules: (id) => invoke<RouterRule[]>("router_rules", { id }),
    routerCheck: (id) => invoke<RouterCheck[]>("router_check", { id }),
    routeSave: (id, name, members, mode) => invoke<ProfilesState>("route_save", { id, name, members, mode }),
    routeProbe: (members, direct) => invoke<MemberProbe[]>("route_probe", { members, direct }),
    cascadeProbe: (entry, exit, direct) => invoke<ChainProbe>("cascade_probe", { entry, exit, direct }),
    cascadeSave: (id, name, entry, exit) => invoke<ProfilesState>("cascade_save", { id, name, entry, exit }),
    buildInfo: () => invoke<{ lab: boolean; version: string }>("build_info"),
    updateCheck: () => invoke<UpdateInfo | null>("update_check"),
    updateInstall: () => invoke<void>("update_install"),
    trialStart: (id) => invoke<TrialStatus>("trial_start", { id }),
    trialStatus: () => invoke<TrialStatus>("trial_status"),
    trialCheck: () => invoke<TrialStatus>("trial_check"),
    trialStop: () => invoke<void>("trial_stop"),
    trialBrowser: () => invoke<string>("trial_browser"),
    trialSpeed: () => invoke<SpeedResult>("trial_speed"),
    servers: () => invoke<ServersState>("servers_list"),
    serverAdd: (input) => invoke<ServersState>("server_add", { input }),
    serverFingerprint: (host, port, via) => invoke<string>("server_fingerprint", { host, port, via }),
    serverInspect: (id) => invoke<ServersState>("server_inspect", { id }),
    serverInstall: (id, vless, hy2, awg, xhttp, mtproxy, harden, cover) => invoke<ServerOpResult>("server_install", { id, vless, hy2, awg, xhttp, mtproxy, harden, cover: cover || null }),
    serverProfile: (id) => invoke<ServerOpResult>("server_profile", { id }),
    serverMtproxyLink: (id) => invoke<{ link: string; web: string; qr: string }>("server_mtproxy_link", { id }),
    serverHarden: (id, bbr, autoupd, f2b) => invoke<ServersState>("server_harden", { id, bbr, autoupd, f2b }),
    serverCascade: (entry, exit, via) => invoke<ServerOpResult>("server_cascade", { entry, exit, via: via || null }),
    serverCascadeRemove: (entry, exit) => invoke<ServersState>("server_cascade_remove", { entry, exit }),
    serverUninstall: (id) => invoke<ServersState>("server_uninstall", { id }),
    serverForget: (id) => invoke<ServersState>("server_forget", { id }),
    serverFirewall: (id, on, keep) => invoke<ServersState>("server_firewall", { id, on, keep }),
    serverCheck: (id) => invoke<ServerCheck>("server_check", { id }),
    serverUpdate: (id) => invoke<ServersState>("server_update", { id }),
    serverMovePlan: (from, to) => invoke<MovePlan>("server_move_plan", { from, to }),
    serverMove: (from, to, cleanOld) => invoke<ServerOpResult>("server_move", { from, to, cleanOld }),
    onServerLog: (cb) => void listen<ServerLog>("server-log", (e) => cb(e.payload)),
    onServersChanged: (cb) => void listen("servers-changed", () => cb()),
    guestAdd: (id, input) => invoke<GuestOp>("guest_add", { id, input }),
    guestUpdate: (id, guest, off, expires) => invoke<ServersState>("guest_update", { id, guest, off, expires }),
    guestRemove: (id, guest) => invoke<ServersState>("guest_remove", { id, guest }),
    guestShare: (id, guest) => invoke<Share>("guest_share", { id, guest }),
    guestSaveConf: (id, guest) => invoke<string>("guest_save_conf", { id, guest }),
    guestStats: (id) => invoke<GuestStat[]>("guest_stats", { id }),
    leakCheck: () => invoke<LeakCheck>("leak_check"),
    supportReport: (hide) => invoke<string>("support_report", { hide }),
    engineInfo: () => invoke<EngineInfo>("engine_info"),
    netSave: (net) => invoke<void>("net_save", { net }),
    netCheck: (net) => invoke<string>("net_check", { net }),
    engineApplyNet: () => invoke<ApplyResult>("engine_apply_net"),
    restart: () => invoke<ApplyResult>("engine_restart"),
    start: () => invoke<ApplyResult>("engine_start"),
    stop: () => invoke<ApplyResult>("engine_stop"),
    setBoot: (on) => invoke<ApplyResult>("engine_set_boot", { on }),
    deepTest: () => invoke<ApplyResult>("engine_deep_test"),
    engineUninstall: () => invoke<ApplyResult>("engine_uninstall"),
    setHeal: (on) => invoke<ApplyResult>("engine_set_heal", { on }),
    engineUpdate: () => invoke<ApplyResult>("engine_update"),
    enginePause: (on, minutes) => invoke<void>("engine_pause", { on, minutes: minutes || null }),
    conns: () => invoke<ConnList>("conns_list"),
    listItems: (id) => invoke<ListItems>("list_items", { id }),
    connsClose: (ids) => invoke<number>("conns_close", { ids }),
    speedTest: () => invoke<SpeedResult>("speed_test"),
    speedHistory: () => invoke<SpeedResult[]>("speed_history"),
    widgetToggle: () => void invoke("widget_toggle"),
    widgetClose: () => void invoke("widget_close"),
    widgetPin: (on) => invoke<boolean>("widget_pin", { on }),
    widgetState: () => invoke<WidgetState>("widget_state"),
    showMain: () => void invoke("show_main"),
    startResize: () => void win.startResizeDragging("SouthEast"),
    widgetShape: (w, h) => void invoke("widget_shape", { w, h }),
    widgetMonitors: () => invoke<MonitorInfo[]>("widget_monitors"),
    widgetSetMonitor: (name) => invoke<void>("widget_set_monitor", { name }),
    widgetSetAnchor: (anchor) => invoke<void>("widget_set_anchor", { anchor }),
    widgetDrag: () => invoke<void>("widget_drag"),
    dropInspect: (path) => invoke("drop_inspect", { path }),
    followForget: (app, item) => invoke<void>("follow_forget", { app, item }),
  };
}
