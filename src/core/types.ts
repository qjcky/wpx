// Зеркало Rust-структур из src-tauri/src (serde → JSON).

export type Health = "starting" | "online" | "slow" | "down" | "engine_off";

export interface LegResult {
  ok: boolean;
  connect_ms: number | null;
  ready_ms: number | null;
  err: string | null;
}

export interface Leg {
  /** Имя в конфиге движка; у прокси-профиля — "HTTP" | "SOCKS5". */
  name: string;
  label: string;
  kind: string;
  /** Транспорт VLESS ("xhttp"…); пусто — обычный TCP. */
  net: string;
  role: "exit" | "entry";
  server: string;
  port: number;
  active: boolean;
  result: LegResult;
  at: number;
}

export interface GuardItem {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

export type EventKind =
  | "proxy_unreachable" | "timeout" | "dropped" | "net_startup"
  | "link" | "engine_start" | "engine_stop" | "heal" | "path_switch" | "slowdown" | "other";

export interface LogEvent {
  t: number;
  kind: EventKind;
  dest: string | null;
  count: number;
  text: string;
}

export interface Outage {
  start: number;
  end: number | null;
  cause: string;
}

export interface Snapshot {
  t: number;
  health: Health;
  health_since: number;
  cause: string | null;
  last_ms: number | null;
  last_err: string | null;
  server: string;
  active_kind: string;
  config_err: string | null;
  legs: Leg[];
  engine: { running: boolean; pid: number | null; uptime_s: number; mem_mb: number };
  traffic: { found: boolean; rx_bps: number; tx_bps: number; rx_total: number; tx_total: number };
  guard: GuardItem[];
  guard_at: number;
  ip: string | null;
  ip_expected: boolean;
  events: LogEvent[];
  latency_tail: [number, number | null][];
  traffic_tail: [number, number, number][];
  current_outage: Outage | null;
  slow_ms: number;
  dual: boolean;
  active_leg: string | null;
  /** Лаборатория: звенья пробного движка этого профиля. */
  legs_trial: string | null;
  busy: boolean;
  engine_kind: "missing" | "wpx";
  boot: boolean | null;
  profile: string | null;
  tun_device: string;
  heal: boolean;
  /** Резерв: [id, название]; трафик сейчас через него. */
  reserve: [string, string] | null;
  on_reserve: boolean;
  /** Свой сервер рабочего профиля — для «Где рвётся?». */
  server_id: string | null;
  /** Пауза: движок работает, весь трафик идёт напрямую. */
  paused: boolean;
  /** Пауза до этого времени (unix ms); null — до «Включить VPN». */
  pause_until: number | null;
}

/** Готовый набор: id, название, домены с поддоменами, списки (id из `lists`). */
export type Preset = [string, string, string[]?, string[]?];

/** Состав списка: адреса или подсети; откуда взят. */
export interface ListItems { items: string[]; source: "engine" | "cache" | "fresh"; url: string }

export interface Conn {
  id: string;
  process: string;
  host: string;
  ip: string;
  port: number;
  network: string;
  up: number;
  down: number;
  start: number;
  via: string;
  rule: string;
  /** Куда ушло: через профиль, напрямую или заблокировано. */
  route: "vpn" | "direct" | "block";
  /** Точка профиля для людей («Сингапур · VLESS»); у прямых — пусто. */
  label: string;
}

export interface ConnList {
  conns: Conn[];
  up_total: number;
  down_total: number;
}

export interface SpeedResult {
  at: number;
  ping_ms: number | null;
  down_mbps: number | null;
  up_mbps: number | null;
  down_mb: number;
  up_mb: number;
  error: string | null;
}

export interface MonitorInfo {
  name: string;
  label: string;
  primary: boolean;
  current: boolean;
}

/** Где вырез: край или угол экрана. */
export type NotchAnchor = "top" | "top-left" | "top-right" | "bottom" | "bottom-left" | "bottom-right" | "left" | "right";

export interface WidgetState {
  open: boolean;
  pinned: boolean;
  anchor?: NotchAnchor;
  x: number | null;
  y: number | null;
  w: number;
  h: number;
}

export interface ProfileView {
  id: string;
  name: string;
  server: string;
  http_port: number | null;
  socks_port: number | null;
  username: string;
  has_password: boolean;
  primary: "http" | "socks5";
  fallback: boolean;
  /** Порт HTTP — по TLS (HTTPS-прокси). */
  https: boolean;
  tls_sni: string;
  tls_insecure: boolean;
  active: boolean;
  endpoints: { kind: ProtoKind; label: string; summary: string }[];
  mode: string;
  /** Каскад: вход и выход — ссылки на другие профили. */
  cascade: { entry: string; exit: string; entry_name: string; exit_name: string } | null;
  /** `server:<id>` / `pipe:<вход>:<выход>` — создан из своего сервера. */
  origin: string;
  /** Маршрут: участники по порядку. */
  route: { id: string; name: string }[];
}

export interface MemberProbe { id: string; name: string; ok: boolean; best_ms: number | null; detail: string }

// ─── Свои серверы ────────────────────────────────────────────────

export interface ServerFacts {
  os: string; arch: string; cpus: number; ram_mb: number; avail_mb: number; swap_mb: number; disk_free_mb: number;
  country: string; city: string; org: string;
  root: boolean; docker: boolean; systemd: boolean;
  containers: string[];
  tcp: [number, string][];
  udp: [number, string][];
  wpx: boolean; ufw: boolean; at: number;
  uptime_s: number; load: string; net_rx: number; net_tx: number; cc: string; bbr_avail: boolean;
  autoupd: boolean; f2b: boolean; updates: number; sec_updates: number; reboot: boolean; sb_ver: string; apt: boolean;
  public: [string, number, string][]; fw: boolean;
}

export interface ServerView {
  id: string; name: string; host: string; port: number; user: string; host_key: string;
  via: string | null; via_name: string | null;
  facts: ServerFacts | null;
  runtime: string;
  vless: { port: number; dest: string; public_key: string; short_id: string } | null;
  hy2: { port: number; sni: string; cert_sha256: string; hop?: [number, number] } | null;
  awg: { port: number; server_public: string; obf: [string, string][] } | null;
  /** VLESS + XHTTP + Reality (Xray). */
  xhttp: { port: number; dest: string; public_key: string; short_id: string; path: string } | null;
  /** MTProxy для Telegram (mtg, FakeTLS). */
  mtproxy: { port: number; domain: string } | null;
  pipes: { to: string; to_name: string; to_host: string; listen: number; to_port: number; profile: string | null; hop?: string | null; hop_name?: string | null }[];
  profile: string | null;
  /** Входы каскада, ведущие на этот сервер. */
  entries: string[];
  /** Профиль маршрута ко всем путям. */
  route: string | null;
  /** Личный доступ для других людей. */
  guests: Guest[];
  /** Файрвол wpx: снаружи только SSH и VPN. */
  fw: boolean;
  fw_plan: { open: string[]; close: [string, string][] };
  /** Что можно обновить: «sing-box 1.14.3 → 1.14.4». */
  updates: string[];
}

export interface ServerCheck {
  server: string;
  verdict: "ok" | "bad" | "warn";
  summary: string;
  steps: { title: string; verdict: "ok" | "bad" | "warn" | "skip"; detail: string }[];
  advice: { kind: "cascade" | "move" | "redeploy" | "hoster"; text: string; entry: string | null }[];
}

export interface MovePlan { from: string; to: string; steps: string[]; guests: number; error: string | null }

export interface Guest {
  id: string; name: string;
  /** мс, unix; null — бессрочно. */
  created: number; expires: number | null;
  vless: boolean; hy2: boolean;
  /** 10.66.0.N; 0 — без AmneziaWG. */
  awg_ip: number;
  /** Ссылки через вход каскада (id сервера-входа). */
  via: string | null;
  off: boolean;
}

export interface GuestInput { name: string; vless: boolean; hy2: boolean; awg: boolean; expires: number | null; via: string | null }

export interface GuestStat { id: string; handshake: number; rx: number; tx: number }

export interface ShareItem { kind: "vless" | "xhttp" | "hy2" | "awg"; title: string; text: string; qr: string; apps: string }

export interface Share { guest: Guest; server: string; host: string; items: ShareItem[] }

export interface GuestOp { state: ServersState; share: Share | null }

export interface LeakItem { key: string; title: string; verdict: "ok" | "leak" | "unknown"; detail: string }

export interface LeakCheck { at: number; verdict: "ok" | "leak" | "unknown"; summary: string; items: LeakItem[] }

export interface ServersState {
  servers: ServerView[];
  version: string;
  /** Сайты-прикрытия для Reality, из которых выбирает wpx. */
  covers: string[];
}

export interface ServerOpResult {
  state: ServersState;
  probe: ProbeResult[];
  profile: string | null;
  note: string | null;
}

export interface ServerInput {
  name: string; host: string; port: number | null; user: string;
  password: string | null; key_path: string | null; via: string | null;
  /** Отпечаток ключа сервера (`SHA256:…`), который человек сверил перед входом. */
  fingerprint: string | null;
}

export interface ServerLog { kind: "step" | "ok" | "warn" | "fail"; text: string }

export interface TrialPoint {
  name: string; label: string; summary: string;
  role: "exit" | "entry"; alive: boolean; delay_ms: number | null; active: boolean;
}

export interface TrialStatus {
  running: boolean; profile_id: string; profile: string; mode: string;
  port: number; uptime_s: number; points: TrialPoint[]; error: string | null;
}

export interface RouterRule { server: string; tcp: number[]; udp: number[]; udp_ranges?: string[]; what: string[] }
export interface RouterCheck { server: string; ok: boolean; detail: string }

export interface ChainProbe {
  /** Вход сам по себе. */
  entry: ProbeResult[];
  /** Выход — через вход. */
  exit: ProbeResult[];
}

export type ProtoKind = "http" | "socks5" | "vless" | "hysteria2" | "trojan" | "shadowsocks" | "awg";

export interface ParsedItem {
  ok: boolean;
  kind: ProtoKind | null;
  label: string;
  summary: string;
  udp: boolean;
  error: string | null;
}

export interface ProbeResult {
  index: number;
  label: string;
  kind: ProtoKind;
  summary: string;
  ok: number;
  rounds: number;
  median_ms: number | null;
  best_ms: number | null;
  error: string | null;
  /** Проверка на заморозку: 256 КБ через точку. */
  bulk?: { bytes: number; ms: number; stalled: boolean } | null;
}

/** История точки для «умного выбора»: сейчас (или по суткам) и лучший час. */
export interface PointHistory {
  score: { tries: number; rate: number; ms: number | null; stall_rate: number; cost: number; by_hour: boolean } | null;
  best_hour: number | null;
}

export interface ProfileInput {
  id: string | null;
  name: string;
  server: string;
  http_port: number | null;
  socks_port: number | null;
  username: string;
  password: string | null;
  primary: "http" | "socks5";
  fallback: boolean;
  https: boolean;
  tls_sni: string;
  tls_insecure: boolean;
}

export interface GameMode {
  on: boolean;
  game: string;
  name: string;
  apps: string[];
  /** Папка игры: всё, что из неё запускается, — тем же путём. */
  dir: string;
  /** Перенаправление входа: лаунчер и серверы входа — тем же путём. */
  login: boolean;
  launchers: string[];
  domains: string[];
  /** "main" или "profile:<id>". */
  target: string;
  /** Только точки, которые сами ходят по UDP (AmneziaWG, Hysteria2). */
  udp_only: boolean;
}

/** Адрес, с которым игра сейчас на связи. */
export interface GameServer { ip: string; port: number; network: string; host: string; bytes: number; conns: number; via: string }

/** Путь до сервера игры: участки и их пинг. */
export interface RouteRtt {
  name: string;
  kind: "direct" | "server" | "cascade";
  legs: { name: string; ms: number | null }[];
  total: number | null;
  /** Профиль этого пути, если уже есть. */
  profile: string | null;
  note: string;
}

export interface RunningApp { name: string; path: string; dir: string; mem_mb: number }

/** Что перетащили на вырез: ярлык, exe, папка, ярлык Steam или Epic, ссылка. */
export interface Dropped { name: string; exe?: string | null; dir?: string | null; icon?: string | null; site?: string | null; from: string }

export interface ProfilesState {
  profiles: ProfileView[];
  active: string | null;
}

export interface ProfileTest {
  http: LegResult | null;
  socks: LegResult | null;
}

export interface RouteRule {
  kind: "app" | "site" | "preset" | "list";
  value: string;
  /** "main" | "profile:<id>" | "direct" | "block" */
  target: string;
  /** Для приложения: и всё, что оно запускает — помощники и их сайты (wpx находит сам). */
  follow?: boolean;
  /** Найденное: "app:codex.exe", "site:oaistatic.com". */
  learned?: string[];
}

/** Свой набор: адреса (с поддоменами) и подсети под одним именем. */
export interface UserSet { id: string; name: string; items: string[] }

export interface NetSettings {
  mode: "strict" | "apps" | "blocked";
  rules: RouteRule[];
  sets: UserSet[];
  /** Готовые наборы, скрытые из подборщика. */
  hidden_presets: string[];
  apps: string[];
  tunnel_domains: string[];
  lists: string[];
  block_telemetry: boolean;
  block_domains: string[];
  interface: string;
  lan: string[];
  direct: string[];
  block_udp: boolean;
  udp: "auto" | "block" | "allow";
  block_quic: boolean;
  /** IPv6: через туннель или закрыт везде. */
  ipv6: "tunnel" | "block";
  /** Игровой режим (вкладка «Игры»). */
  game: GameMode;
  /** Kill switch в брандмауэре Windows (без роутера). */
  kill_switch: boolean;
  /** Настоящие адреса сайтов вместо fake-ip — для ExitLag и античитов. */
  real_ip: boolean;
  tun_device: string;
  mixed_port: number;
  secret: string;
  /** Резервный профиль (id): VPN не отвечает — движок сам уходит на него. */
  reserve: string;
}

export interface EngineInfo {
  kind: "missing" | "wpx";
  boot: boolean | null;
  heal: boolean;
  telemetry_list: string[];
  config_current: boolean;
  net: NetSettings;
  interfaces: string[];
  wpx_dir: string;
  lists: [string, string][];
  /** id, название, домены набора. */
  presets: Preset[];
  /** Адреса выхода для «постоянного IP» в правилах. */
  exits: { ip: string; name: string; ways: string[] }[];
  /** Установленный mihomo старее того, что в поставке этой версии wpx. */
  engine_outdated: boolean;
}

/** Новая версия wpx (null — у вас последняя). */
export interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
  date: string | null;
}

export interface Prefs {
  autostart: boolean;
  notify: boolean;
  slow_ms: number;
  exe: string;
}

export interface ApplyResult {
  ok: boolean;
  outcome: "applied" | "rolled_back" | "error" | "cancelled";
  message: string;
  info: string | null;
}

export interface FullState {
  snapshot: Snapshot;
  latency: [number, number | null][];
  traffic: [number, number, number][];
  err_minutes: [number, number][];
  outages: Outage[];
}
