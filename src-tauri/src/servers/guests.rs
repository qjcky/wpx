//! «Поделиться доступом»: личный доступ на своём сервере для каждого
//! человека — свой UUID VLESS, свой пароль Hysteria2, свой ключ AmneziaWG
//! (адрес 10.66.0.N). Отключить одного — остальные и владелец не замечают.
//! Ключи гостей рождаются на ПК и лежат зашифрованными вместе с ключами сервера,
//! поэтому QR можно показать ещё раз. Срок действия wpx соблюдает сам:
//! фоновая проверка убирает просроченных с сервера.

use super::*;
use qrcode::{render::svg, EcLevel, QrCode};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Guest {
    pub id: String,
    pub name: String,
    /// Когда выдан и до какого момента действует (мс, unix); `None` — бессрочно.
    pub created: i64,
    #[serde(default)]
    pub expires: Option<i64>,
    pub vless: bool,
    pub hy2: bool,
    /// Последний октет адреса AWG (10.66.0.N); 0 — без AmneziaWG.
    #[serde(default)]
    pub awg_ip: u8,
    /// Ссылки ведут через вход каскада (id сервера-входа), а не напрямую.
    #[serde(default)]
    pub via: Option<String>,
    /// Отключён (вручную или по сроку): ключи сохранены, на сервере его нет.
    #[serde(default)]
    pub off: bool,
}

impl Guest {
    pub fn live(&self, now: i64) -> bool {
        !self.off && self.expires.map_or(true, |e| e > now)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub(super) struct GuestKeys {
    pub id: String,
    pub uuid: String,
    pub hy2_password: String,
    pub awg_private: String,
    pub awg_psk: String,
}

/// Гости, которых сервер сейчас должен пускать, — с их ключами.
pub(super) fn live<'a>(s: &'a Server, sec: &'a Secrets, now: i64) -> Vec<(&'a Guest, &'a GuestKeys)> {
    s.guests
        .iter()
        .filter(|g| g.live(now))
        .filter_map(|g| sec.guests.iter().find(|k| k.id == g.id).map(|k| (g, k)))
        .collect()
}

// ─── Ссылки, конфиг, QR ──────────────────────────────────────────

#[derive(Serialize)]
pub struct ShareItem {
    pub kind: &'static str,
    pub title: &'static str,
    /// Ссылка или текст .conf — это и зашито в QR.
    pub text: String,
    /// QR в SVG (чёрное на белом — так читают все камеры).
    pub qr: String,
    /// Чем открыть на телефоне или ПК.
    pub apps: &'static str,
}

#[derive(Serialize)]
pub struct Share {
    pub guest: Guest,
    pub server: String,
    /// Куда ведут ссылки: сам сервер или вход каскада.
    pub host: String,
    pub items: Vec<ShareItem>,
}

pub(super) fn qr_svg(text: &str) -> String {
    QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L)
        .map(|c| {
            let svg = c
                .render::<svg::Color>()
                .min_dimensions(240, 240)
                .dark_color(svg::Color("#000000"))
                .light_color(svg::Color("#ffffff"))
                .quiet_zone(true)
                .build();
            svg.find("<svg").map(|i| svg[i..].to_string()).unwrap_or(svg)
        })
        .unwrap_or_default()
}

/// Конфиг AmneziaWG гостя — тот же формат, что импортируют AmneziaWG и
/// AmneziaVPN (файлом или QR). `::/0` — IPv6 тоже в туннель (там он
/// отбрасывается), чтобы телефон не ходил по IPv6 мимо VPN.
fn guest_awg_conf(a: &Awg, k: &GuestKeys, ip: u8, host: &str, port: u16, via: bool) -> String {
    format!(
        "[Interface]\nPrivateKey = {}\nAddress = {AWG_NET}.{ip}/32\nDNS = 1.1.1.1, 1.0.0.1\n{}{}\n\
         [Peer]\nPublicKey = {}\nPresharedKey = {}\nEndpoint = {at}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n",
        k.awg_private, mtu_line(via), obf_lines(a), a.server_public, k.awg_psk, at = host_port(host, port)
    )
}

fn enc_label(t: &str) -> String {
    percent_encoding::utf8_percent_encode(t, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Что выдать гостю: ссылки на сервер или на трубы входа каскада.
fn share_of(st: &Store, x: &Server, sec: &Secrets, g: &Guest) -> Result<Share, String> {
    let k = sec.guests.iter().find(|k| k.id == g.id).ok_or("ключи этого доступа не найдены")?;
    let (host, ports) = match &g.via {
        Some(v) => {
            let e = st.servers.iter().find(|e| &e.id == v).ok_or("вход каскада удалён из wpx")?;
            let pipes: Vec<Pipe> = e.pipes.iter().filter(|p| p.to == x.id).cloned().collect();
            (e.host.clone(), Ports::via(x, &pipes))
        }
        None => (x.host.clone(), Ports::of(x)),
    };
    let label = format!("{} · {}", x.name, g.name);
    let mut items = vec![];
    if let (true, Some(a), Some(port)) = (g.awg_ip > 0, &x.awg, ports.awg) {
        let text = guest_awg_conf(a, k, g.awg_ip, &host, port, g.via.is_some());
        items.push(ShareItem { kind: "awg", title: "AmneziaWG", qr: qr_svg(&text), text, apps: "AmneziaWG, AmneziaVPN (iPhone, Android, Windows, macOS)" });
    }
    if let (true, Some(v), Some(port)) = (g.vless, &x.vless, ports.vless) {
        let text = format!(
            "vless://{}@{at}?encryption=none&security=reality&sni={}&fp=chrome&pbk={}&sid={}&type=tcp&flow=xtls-rprx-vision#{}",
            k.uuid, v.dest, v.public_key, v.short_id, enc_label(&label), at = host_port(&host, port)
        );
        items.push(ShareItem { kind: "vless", title: "VLESS + Reality", qr: qr_svg(&text), text, apps: "v2RayTun, Happ, Streisand, Hiddify, Shadowrocket, v2rayNG" });
    }
    if let (true, Some(xh), Some(port)) = (g.vless, &x.xhttp, ports.xhttp) {
        let text = format!(
            "vless://{}@{at}?encryption=none&security=reality&sni={}&fp=chrome&pbk={}&sid={}&type=xhttp&path={}&mode=auto#{}",
            k.uuid, xh.dest, xh.public_key, xh.short_id, enc_label(&xh.path), enc_label(&format!("{label} · XHTTP")), at = host_port(&host, port)
        );
        items.push(ShareItem { kind: "xhttp", title: "VLESS + XHTTP + Reality", qr: qr_svg(&text), text, apps: "v2RayTun, Happ, Hiddify, v2rayNG, Streisand" });
    }
    if let (true, Some(h), Some(port)) = (g.hy2, &x.hy2, ports.hy2) {
        // Сертификат свой: pinSHA256 для клиентов, что умеют закрепление,
        // insecure=1 — для остальных (без пароля salamander трафик не разобрать).
        let mport = h.hop.filter(|_| port == h.port).map(|(lo, hi)| format!("&mport={lo}-{hi}")).unwrap_or_default();
        let text = format!(
            "hysteria2://{}@{at}?sni={}&obfs=salamander&obfs-password={}&insecure=1&pinSHA256={}{mport}#{}",
            k.hy2_password, h.sni, sec.hy2_obfs, h.cert_sha256, enc_label(&label), at = host_port(&host, port)
        );
        items.push(ShareItem { kind: "hy2", title: "Hysteria2", qr: qr_svg(&text), text, apps: "Hiddify, Streisand, Shadowrocket, v2RayTun, Happ" });
    }
    if items.is_empty() {
        return Err(match &g.via {
            Some(_) => "через этот вход нет труб к нужным протоколам — пересоздайте каскад".into(),
            None => "на сервере больше нет протоколов этого доступа".into(),
        });
    }
    Ok(Share { guest: g.clone(), server: x.name.clone(), host, items })
}

// ─── Применение на сервере ───────────────────────────────────────

/// Пиры AmneziaWG — на лету (`awg set`), без перезапуска контейнера:
/// подключённые не замечают. Список берётся из нового wg0.conf.
const AWG_PEERS: &str = r#"
set -u
A=/opt/wpx/awg
cat > "$A/wg0.new"; chmod 600 "$A/wg0.new"; mv "$A/wg0.new" "$A/wg0.conf"
[ "$(docker inspect -f '{{.State.Running}}' wpx-awg 2>/dev/null)" = true ] || { echo "контейнер wpx-awg не запущен" >&2; exit 1; }
want=$(awk '/^\[Peer\]/{if(p!="")print p" "k" "a; p="";k="";a=""}
  /^PublicKey/{sub(/^PublicKey *= */,""); p=$0}
  /^PresharedKey/{sub(/^PresharedKey *= */,""); k=$0}
  /^AllowedIPs/{sub(/^AllowedIPs *= */,""); a=$0}
  END{if(p!="")print p" "k" "a}' "$A/wg0.conf")
echo "$want" | while read -r pub psk ips; do
  [ -n "$pub" ] || continue
  docker exec wpx-awg sh -c "umask 077; printf '%s' '$psk' > /tmp/psk; awg set wg0 peer '$pub' preshared-key /tmp/psk allowed-ips '$ips'; r=\$?; rm -f /tmp/psk; exit \$r" || exit 1
done || { echo "ключ не добавился" >&2; exit 1; }
for cur in $(docker exec wpx-awg awg show wg0 peers); do
  echo "$want" | grep -qF -- "$cur " || docker exec wpx-awg awg set wg0 peer "$cur" remove
done
echo "AWG-PEERS $(docker exec wpx-awg awg show wg0 peers | wc -l)"
"#;

/// Что поменялось на сервере: пользователи sing-box и/или пиры AWG.
#[derive(Clone, Copy)]
struct Touch {
    sb: bool,
    awg: bool,
}

impl Touch {
    fn of(g: &Guest) -> Self {
        Touch { sb: g.vless || g.hy2, awg: g.awg_ip > 0 }
    }
    fn or(self, o: Touch) -> Self {
        Touch { sb: self.sb || o.sb, awg: self.awg || o.awg }
    }
}

async fn apply(c: &Conn, s: &Server, sec: &Secrets, t: Touch, log: &Log) -> Result<(), String> {
    if t.sb && (s.vless.is_some() || s.hy2.is_some()) {
        deploy(c, s, sec, log).await?;
    }
    if let (true, Some(x)) = (t.sb, &s.xhttp) {
        extra::deploy_xray(c, s, x, sec, log).await?;
    }
    if let (true, Some(a)) = (t.awg, &s.awg) {
        log("step", "AmneziaWG: ключи на лету, без перезапуска".into());
        let conf = awg_server_conf(s, a, sec)?;
        let o = c.sh(&[], AWG_PEERS, conf.as_bytes(), 120).await?;
        let n = o.out.lines().find_map(|l| l.strip_prefix("AWG-PEERS ")).map(str::trim).map(String::from);
        match (o.code, n) {
            (0, Some(n)) => log("ok", format!("AmneziaWG: ключей на сервере {n} (с вашим)")),
            _ => return Err(format!("AmneziaWG: {}", o.reason())),
        }
    }
    Ok(())
}

/// Открыть сервер, поменять гостей, применить, сохранить.
async fn change<F>(id: &str, log: &Log, f: F) -> Result<(Store, Server, Secrets), String>
where
    F: FnOnce(&mut Server, &mut Secrets) -> Result<Touch, String>,
{
    let mut st = load();
    let mut s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
    let mut sec = secrets_of(&s)?;
    let t = f(&mut s, &mut sec)?;
    let c = open(&st, &s, log).await?;
    let r = apply(&c, &s, &sec, t, log).await;
    c.close().await;
    r?;
    s.secrets_enc = enc(&serde_json::to_string(&sec).map_err(|e| e.to_string())?)?;
    if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) {
        *x = s.clone();
    }
    save(&st)?;
    Ok((st, s, sec))
}

/// Свой ключ AmneziaWG для пути к выходу `exit` через вход `via`: пир на
/// выходе — на лету, как у гостей (подключённые не замечают). Уже есть — ничего.
pub(super) async fn path_key(exit: &str, via: &str, log: &Log) -> Result<(), String> {
    let has = load().servers.iter().find(|s| s.id == exit).is_some_and(|s| s.awg.is_none() || s.awg_paths.iter().any(|p| p.via == via));
    if has {
        return Ok(());
    }
    log("step", "AmneziaWG через вход: свой ключ пути на выходе".into());
    change(exit, log, |s, sec| {
        let ip = free_awg_ip(s)?;
        s.awg_paths.push(AwgPath { via: via.into(), ip });
        sec.awg_paths.retain(|k| k.via != via);
        sec.awg_paths.push(AwgPathKey { via: via.into(), private: wg_keypair().0 });
        Ok(Touch { sb: false, awg: true })
    })
    .await
    .map(|_| ())
}

// ─── Команды окна ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GuestInput {
    pub name: String,
    pub vless: bool,
    pub hy2: bool,
    pub awg: bool,
    /// До какого момента (мс, unix); `None` — бессрочно.
    pub expires: Option<i64>,
    pub via: Option<String>,
}

#[derive(Serialize)]
pub struct GuestOp {
    pub state: ServersState,
    pub share: Option<Share>,
}

async fn add(id: &str, input: GuestInput, log: &Log) -> Result<GuestOp, String> {
    let st0 = load();
    let x = st0.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    let (vless, hy2, awg) = (input.vless && x.vless.is_some(), input.hy2 && x.hy2.is_some(), input.awg && x.awg.is_some());
    if !vless && !hy2 && !awg {
        return Err("Выберите хотя бы один протокол, установленный на сервере".into());
    }
    if let Some(v) = &input.via {
        let e = st0.servers.iter().find(|e| &e.id == v).ok_or("вход каскада не найден")?;
        let pipes: Vec<Pipe> = e.pipes.iter().filter(|p| p.to == x.id).cloned().collect();
        let p = Ports::via(x, &pipes);
        let miss: Vec<&str> = [(vless && p.vless.is_none(), "VLESS"), (hy2 && p.hy2.is_none(), "Hysteria2"), (awg && p.awg.is_none(), "AmneziaWG")]
            .iter()
            .filter(|(m, _)| *m)
            .map(|(_, n)| *n)
            .collect();
        if !miss.is_empty() {
            return Err(format!("Через «{}» нет трубы для {} — пересоздайте каскад", e.name, miss.join(", ")));
        }
    }
    let name = {
        let n = input.name.trim().chars().take(40).collect::<String>();
        if n.is_empty() { format!("Гость {}", x.guests.len() + 1) } else { n }
    };
    if x.guests.iter().any(|g| g.name == name) {
        return Err(format!("Доступ «{name}» уже есть — дайте другое имя"));
    }
    let gid = format!("g{}", hex(&rnd(4)));
    log("step", format!("Новый доступ «{name}»: свои ключи{}", if awg { " и адрес AmneziaWG" } else { "" }));
    let (st, s, sec) = change(id, log, |s, sec| {
        let awg_ip = if awg {
            free_awg_ip(s)?
        } else {
            0
        };
        let g = Guest { id: gid.clone(), name: name.clone(), created: crate::monitor::now_ms(), expires: input.expires, vless, hy2, awg_ip, via: input.via.clone(), off: false };
        sec.guests.push(GuestKeys {
            id: gid.clone(),
            uuid: if vless { uuid4() } else { String::new() },
            hy2_password: if hy2 { hex(&rnd(16)) } else { String::new() },
            awg_private: if awg { wg_keypair().0 } else { String::new() },
            awg_psk: if awg { B64.encode(rnd(32)) } else { String::new() },
        });
        let t = Touch::of(&g);
        s.guests.push(g);
        Ok(t)
    })
    .await?;
    let g = s.guests.iter().find(|g| g.id == gid).ok_or("доступ не сохранился")?;
    log("ok", format!("Доступ «{name}» готов — покажите QR или отправьте ссылку"));
    Ok(GuestOp { share: Some(share_of(&st, &s, &sec, g)?), state: state(&st) })
}

#[tauri::command]
pub async fn guest_add(app: AppHandle, id: String, input: GuestInput) -> Result<GuestOp, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = add(&id, input, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

/// Включить/отключить и сменить срок. На сервер идём, только если от этого
/// меняется, пускать ли человека.
async fn update(id: &str, guest: &str, off: bool, expires: Option<i64>, log: &Log) -> Result<ServersState, String> {
    let now = crate::monitor::now_ms();
    let st = load();
    let s = st.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    let g = s.guests.iter().find(|g| g.id == guest).ok_or("доступ не найден")?;
    let was = g.live(now);
    let next = Guest { off, expires, ..g.clone() };
    if was == next.live(now) {
        let mut st = st;
        if let Some(x) = st.servers.iter_mut().find(|x| x.id == id).and_then(|s| s.guests.iter_mut().find(|g| g.id == guest)) {
            *x = next;
        }
        save(&st)?;
        log("ok", "Срок изменён".into());
        return Ok(state(&st));
    }
    log("step", format!("«{}»: {}", g.name, if next.live(now) { "включаю доступ" } else { "отключаю доступ" }));
    let t = Touch::of(g);
    let (st, _, _) = change(id, log, |s, _| {
        if let Some(x) = s.guests.iter_mut().find(|g| g.id == guest) {
            *x = next;
        }
        Ok(t)
    })
    .await?;
    log("ok", "Готово — остальные подключения не прерывались".into());
    Ok(state(&st))
}

#[tauri::command]
pub async fn guest_update(app: AppHandle, id: String, guest: String, off: bool, expires: Option<i64>) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = update(&id, &guest, off, expires, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

async fn remove(id: &str, guest: &str, log: &Log) -> Result<ServersState, String> {
    let st = load();
    let s = st.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    let g = s.guests.iter().find(|g| g.id == guest).cloned().ok_or("доступ не найден")?;
    let now = crate::monitor::now_ms();
    log("step", format!("Удаляю доступ «{}» и его ключи", g.name));
    if !g.live(now) {
        // На сервере его уже нет — только забыть ключи.
        let mut st = st;
        if let Some(s) = st.servers.iter_mut().find(|x| x.id == id) {
            let mut sec = secrets_of(s)?;
            sec.guests.retain(|k| k.id != guest);
            s.secrets_enc = enc(&serde_json::to_string(&sec).map_err(|e| e.to_string())?)?;
            s.guests.retain(|x| x.id != guest);
        }
        save(&st)?;
        log("ok", "Удалён".into());
        return Ok(state(&st));
    }
    let (st, _, _) = change(id, log, |s, sec| {
        s.guests.retain(|x| x.id != guest);
        sec.guests.retain(|k| k.id != guest);
        Ok(Touch::of(&g))
    })
    .await?;
    log("ok", format!("«{}» больше не подключится; остальные не заметили", g.name));
    Ok(state(&st))
}

#[tauri::command]
pub async fn guest_remove(app: AppHandle, id: String, guest: String) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = remove(&id, &guest, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

fn find_share(id: &str, guest: &str) -> Result<(Share, String), String> {
    let st = load();
    let s = st.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    let g = s.guests.iter().find(|g| g.id == guest).ok_or("доступ не найден")?;
    let sec = secrets_of(s)?;
    Ok((share_of(&st, s, &sec, g)?, format!("{} {}", s.name, g.name)))
}

#[tauri::command]
pub fn guest_share(id: String, guest: String) -> Result<Share, String> {
    find_share(&id, &guest).map(|(s, _)| s)
}

/// Сохранить .conf AmneziaWG в «Загрузки» и показать файл в проводнике —
/// чтобы отправить человеку в мессенджере.
#[tauri::command]
pub fn guest_save_conf(id: String, guest: String) -> Result<String, String> {
    let (sh, name) = find_share(&id, &guest)?;
    let item = sh.items.iter().find(|i| i.kind == "awg").ok_or("у этого доступа нет AmneziaWG")?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let dir = std::path::PathBuf::from(std::env::var("USERPROFILE").map_err(|e| e.to_string())?).join("Downloads");
    let path = dir.join(format!("wpx-{}.conf", safe.trim_matches('-')));
    std::fs::write(&path, &item.text).map_err(|e| format!("не записал {}: {e}", path.display()))?;
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    Ok(path.display().to_string())
}

#[derive(Serialize, Default)]
pub struct GuestStat {
    pub id: String,
    /// Последнее рукопожатие AmneziaWG (с, unix); 0 — ещё не подключался.
    pub handshake: i64,
    pub rx: u64,
    pub tx: u64,
}

/// Кто был в сети: рукопожатия и трафик AmneziaWG по ключам (только
/// чтение). Для VLESS/Hysteria2 sing-box счётчиков по людям не даёт.
async fn stats(id: &str) -> Result<Vec<GuestStat>, String> {
    let st = load();
    let s = st.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    if s.awg.is_none() || !s.guests.iter().any(|g| g.awg_ip > 0) {
        return Ok(vec![]);
    }
    let sec = secrets_of(s)?;
    let quiet: Log = Arc::new(|_, _| {});
    let c = open(&st, s, &quiet).await?;
    let o = c
        .sh(&[], "docker exec wpx-awg awg show wg0 latest-handshakes | sed 's/^/hs /'; docker exec wpx-awg awg show wg0 transfer | sed 's/^/tr /'", b"", 30)
        .await;
    c.close().await;
    let o = o?;
    let mut out = vec![];
    for g in s.guests.iter().filter(|g| g.awg_ip > 0) {
        let Some(pk) = sec.guests.iter().find(|k| k.id == g.id).and_then(|k| wg_public(&k.awg_private).ok()) else { continue };
        let mut x = GuestStat { id: g.id.clone(), ..Default::default() };
        for l in o.out.lines() {
            let f: Vec<&str> = l.split_whitespace().collect();
            match f.as_slice() {
                ["hs", k, t] if *k == pk => x.handshake = t.parse().unwrap_or(0),
                ["tr", k, rx, tx] if *k == pk => {
                    x.rx = rx.parse().unwrap_or(0);
                    x.tx = tx.parse().unwrap_or(0);
                }
                _ => {}
            }
        }
        out.push(x);
    }
    Ok(out)
}

#[tauri::command]
pub async fn guest_stats(id: String) -> Result<Vec<GuestStat>, String> {
    stats(&id).await
}

// ─── Срок действия ───────────────────────────────────────────────

/// Убрать с сервера тех, у кого истёк срок. Возвращает их имена.
async fn expire(id: &str, log: &Log) -> Result<Vec<String>, String> {
    let now = crate::monitor::now_ms();
    let due = |g: &Guest| !g.off && g.expires.is_some_and(|e| e <= now);
    let st = load();
    let s = st.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    let names: Vec<String> = s.guests.iter().filter(|g| due(g)).map(|g| g.name.clone()).collect();
    if names.is_empty() {
        return Ok(names);
    }
    let t = s.guests.iter().filter(|g| due(g)).fold(Touch { sb: false, awg: false }, |t, g| t.or(Touch::of(g)));
    change(id, log, |s, _| {
        for g in s.guests.iter_mut().filter(|g| due(g)) {
            g.off = true;
        }
        Ok(t)
    })
    .await?;
    Ok(names)
}

/// Фон: раз в 15 минут — нет ли просроченных доступов. Сервер недоступен
/// или занят другой операцией — попробуем в следующий раз.
pub async fn expiry_task(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(90)).await;
    loop {
        let now = crate::monitor::now_ms();
        let ids: Vec<String> = load()
            .servers
            .iter()
            .filter(|s| s.guests.iter().any(|g| !g.off && g.expires.is_some_and(|e| e <= now)))
            .map(|s| s.id.clone())
            .collect();
        for id in ids {
            let Ok(_g) = BUSY.try_lock() else { break };
            let quiet: Log = Arc::new(|_, _| {});
            if let Ok(names) = expire(&id, &quiet).await {
                if !names.is_empty() {
                    let server = load().servers.iter().find(|s| s.id == id).map(|s| s.name.clone()).unwrap_or_default();
                    use tauri::Manager;
                    use tauri_plugin_notification::NotificationExt;
                    let notify = app.try_state::<crate::monitor::Shared>().map(|s| s.settings().notify).unwrap_or(true);
                    if notify {
                        let _ = app
                            .notification()
                            .builder()
                            .title(crate::app::lang::tr("wpx · срок доступа истёк"))
                            .body(crate::app::lang::tr(&format!("«{server}»: отключён доступ {}", names.join(", "))))
                            .show();
                    }
                    let _ = app.emit("servers-changed", ());
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(15 * 60)).await;
    }
}

// ─── Консоль (лаборатория) ───────────────────────────────────────

/// `--server guests <сервер>` · `share <сервер> <имя> [--no-vless] [--no-hy2]
/// [--no-awg] [--days N] [--via <вход>] --out <папка>` · `unshare <сервер> <имя>`.
/// Ссылки и QR пишутся в файлы папки — в консоль ключи не печатаются.
pub(super) async fn cli(args: &[String], log: &Log) -> Result<String, String> {
    let opt = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned());
    let flag = |k: &str| args.iter().any(|a| a == k);
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    let find = |key: &str| -> Result<String, String> {
        load().servers.iter().find(|s| s.id == key || s.name == key || s.host == key).map(|s| s.id.clone()).ok_or(format!("нет сервера «{key}»"))
    };
    let id = find(&arg(1))?;
    let guest_id = |name: &str| -> Result<String, String> {
        load()
            .servers
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.guests.iter().find(|g| g.id == name || g.name == name))
            .map(|g| g.id.clone())
            .ok_or(format!("нет доступа «{name}»"))
    };
    match arg(0).as_str() {
        "guests" => {
            let now = crate::monitor::now_ms();
            let st = stats(&id).await.unwrap_or_default();
            let s = load().servers.into_iter().find(|s| s.id == id).ok_or("нет")?;
            Ok(s
                .guests
                .iter()
                .map(|g| {
                    let x = st.iter().find(|x| x.id == g.id);
                    format!(
                        "{} [{}] {}{}{} {}{}",
                        g.name, g.id,
                        if g.vless { "VLESS " } else { "" }, if g.hy2 { "Hy2 " } else { "" },
                        if g.awg_ip > 0 { format!("AWG .{} ", g.awg_ip) } else { String::new() },
                        if g.live(now) { "вкл" } else { "откл" },
                        x.map(|x| format!(" · рукопожатие {} · ↓{} ↑{} КБ", x.handshake, x.tx / 1024, x.rx / 1024)).unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "share" => {
            let out = opt("--out").ok_or("нужна --out <папка>")?;
            let via = match opt("--via") { Some(v) => Some(find(&v)?), None => None };
            let expires = opt("--days").and_then(|d| d.parse::<i64>().ok()).map(|d| crate::monitor::now_ms() + d * 86_400_000);
            let input = GuestInput { name: arg(2), vless: !flag("--no-vless"), hy2: !flag("--no-hy2"), awg: !flag("--no-awg"), expires, via };
            let r = add(&id, input, log).await?;
            let sh = r.share.ok_or("нет ссылок")?;
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let mut files = vec![];
            for i in &sh.items {
                for (ext, body) in [("txt", &i.text), ("svg", &i.qr)] {
                    let p = std::path::Path::new(&out).join(format!("{}-{}.{ext}", sh.guest.id, i.kind));
                    std::fs::write(&p, body).map_err(|e| e.to_string())?;
                    files.push(p.display().to_string());
                }
            }
            Ok(format!("доступ {} → {}\n{}", sh.guest.id, sh.host, files.join("\n")))
        }
        "unshare" => remove(&id, &guest_id(&arg(2))?, log).await.map(|_| "удалён".into()),
        "guest-off" => update(&id, &guest_id(&arg(2))?, true, None, log).await.map(|_| "отключён".into()),
        "guest-on" => update(&id, &guest_id(&arg(2))?, false, None, log).await.map(|_| "включён".into()),
        _ => Err("guests|share|unshare|guest-off|guest-on".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_guests() -> (Server, Secrets) {
        let (private, public) = reality_keypair();
        let mut s = Server {
            id: "s1".into(),
            name: "Сингапур".into(),
            host: "203.0.113.5".into(),
            vless: Some(Vless { port: 443, dest: "www.apple.com".into(), public_key: public, short_id: "0123456789abcdef".into() }),
            hy2: Some(Hy2 { port: 443, sni: "www.apple.com".into(), cert_sha256: "ab".repeat(32), hop: Some((30000, 30999)) }),
            ..Default::default()
        };
        let mut sec = Secrets {
            uuid: uuid4(),
            reality_private: private,
            hy2_password: "pw".into(),
            hy2_obfs: "ob".into(),
            awg_server_private: wg_keypair().0,
            awg_client_private: wg_keypair().0,
            awg_psk: B64.encode(rnd(32)),
            ..Default::default()
        };
        s.awg = Some(Awg { port: 50738, server_public: wg_public(&sec.awg_server_private).unwrap(), obf: awg_obf() });
        let now = crate::monitor::now_ms();
        for (i, (name, expires, off)) in [("Маша", None, false), ("Старый", Some(now - 1000), false), ("Пауза", None, true)].into_iter().enumerate() {
            let id = format!("g{i}");
            s.guests.push(Guest { id: id.clone(), name: name.into(), created: now, expires, vless: true, hy2: true, awg_ip: 3 + i as u8, via: None, off });
            sec.guests.push(GuestKeys { id, uuid: uuid4(), hy2_password: format!("p{i}"), awg_private: wg_keypair().0, awg_psk: B64.encode(rnd(32)) });
        }
        (s, sec)
    }

    #[test]
    fn only_live_guests_reach_the_server() {
        let (s, sec) = with_guests();
        let cfg = singbox_config(&s, &sec);
        let names = |i: usize| cfg["inbounds"][i]["users"].as_array().unwrap().iter().map(|u| u["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names(0), ["wpx", "g0"]);
        assert_eq!(names(1), ["wpx", "g0"]);
        assert_eq!(cfg["inbounds"][1]["users"][1]["password"], "p0");
        let conf = awg_server_conf(&s, s.awg.as_ref().unwrap(), &sec).unwrap();
        assert_eq!(conf.matches("[Peer]").count(), 2);
        assert!(conf.contains(&format!("AllowedIPs = {AWG_NET}.3/32")) && !conf.contains(&format!("{AWG_NET}.4/32")));
        // Подхват с сервера: владелец остаётся владельцем, гости его не путают.
        let mut back = Secrets::default();
        adopt_awg(&conf, &mut back).unwrap();
        assert_eq!(back.awg_psk, sec.awg_psk);
        let mut srv = Server { id: "s1".into(), ..Default::default() };
        let got = adopt(&mut srv, &cfg, "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n", "docker", &[]).unwrap();
        assert_eq!((got.uuid.as_str(), got.hy2_password.as_str()), (sec.uuid.as_str(), "pw"));
    }

    #[test]
    fn share_links_conf_and_qr() {
        let (s, sec) = with_guests();
        let entry = Server { id: "e1".into(), name: "Вход".into(), host: "198.51.100.1".into(), pipes: vec![Pipe { to: "s1".into(), to_host: s.host.clone(), listen: 8443, to_port: 443, ..Default::default() }, Pipe { to: "s1".into(), to_host: s.host.clone(), listen: 9443, to_port: 50738, ..Default::default() }], ..Default::default() };
        let st = Store { servers: vec![s.clone(), entry] };
        let sh = share_of(&st, &s, &sec, &s.guests[0]).unwrap();
        assert_eq!(sh.items.iter().map(|i| i.kind).collect::<Vec<_>>(), ["awg", "vless", "hy2"]);
        let v = proto::parse(&sh.items[1].text).unwrap();
        assert_eq!((v.server.as_str(), v.port), ("203.0.113.5", 443));
        assert!(sh.items[1].text.contains(&sec.guests[0].uuid) && !sh.items[1].text.contains(&sec.uuid));
        assert!(sh.items[2].text.contains("insecure=1") && sh.items[2].text.starts_with("hysteria2://p0@"));
        assert!(sh.items[2].text.contains("mport=30000-30999"), "смена портов в ссылке гостя");
        let ep = crate::profiles::proto::parse(&sh.items[2].text).unwrap();
        assert_eq!(ep.params["ports"], "30000-30999");
        let conf = &sh.items[0].text;
        assert!(conf.contains(&format!("Address = {AWG_NET}.3/32")) && conf.contains("Endpoint = 203.0.113.5:50738") && conf.contains("::/0"));
        assert!(!conf.contains(&sec.awg_server_private) && !conf.contains(&sec.awg_client_private));
        let e = proto::parse_awg_conf(conf).unwrap();
        assert_eq!(e.params["amnezia-wg-option"]["jc"], json!(s.awg.as_ref().unwrap().obf[0].1.parse::<u32>().unwrap()));
        assert!(sh.items.iter().all(|i| i.qr.starts_with("<svg") && i.qr.len() > 1000));
        // Через вход каскада: адрес входа, порты труб.
        let mut g = s.guests[0].clone();
        g.via = Some("e1".into());
        let sh = share_of(&st, &s, &sec, &g).unwrap();
        assert_eq!(sh.host, "198.51.100.1");
        assert_eq!(sh.items.iter().map(|i| i.kind).collect::<Vec<_>>(), ["awg", "vless", "hy2"]);
        assert!(sh.items[0].text.contains("Endpoint = 198.51.100.1:9443"));
    }
}
