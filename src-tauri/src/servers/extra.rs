//! Службы в своих контейнерах рядом с sing-box:
//!
//! - **VLESS + XHTTP + Reality** на Xray — самый стойкий к DPI транспорт
//!   сейчас: запрос и ответ идут разными HTTP-потоками, рисунка «TLS в TLS»
//!   нет; маскировка — Reality под настоящий сайт, свой домен не нужен.
//! - **MTProxy** для Telegram на mtg: FakeTLS с прикрытием под настоящий
//!   сайт — чужой, кто постучится без секрета, увидит этот сайт.
//!
//! Оба — официальные образы по digest, с минимумом прав (без возможностей,
//! кроме привязки к порту, файловая система только для чтения), и
//! транзакцией: конфиг проверяется до запуска, не поднялось — прежний назад.

use super::*;

/// 26.3.27 — последний выпуск, с которым Reality+XHTTP понимает mihomo
/// 1.19.33 (с 26.7.11 рукопожатие Reality у Xray несовместимо).
/// Обновлять — только вместе с проверкой mihomo.
pub const XRAY_VERSION: &str = "26.3.27";
const XRAY_IMAGE: &str = "ghcr.io/xtls/xray-core@sha256:592ec4d11f656db95598d01e76dbcc6e002d67360b96a5436500a938230f52c7";
pub const MTG_VERSION: &str = "2.3.0";
const MTG_IMAGE: &str = "nineseconds/mtg@sha256:9553495b5216cbe6b238e88ce8a3d43ef582e4dc45fcdd7a14d54497500f5d4f";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Xhttp {
    pub port: u16,
    /// Сайт-прикрытие Reality (тот же, что у VLESS, если он есть).
    pub dest: String,
    pub public_key: String,
    pub short_id: String,
    /// Путь XHTTP — случайный, без него сервер отвечает как сайт-прикрытие.
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MtProxy {
    pub port: u16,
    /// Сайт, под который маскируется FakeTLS.
    pub domain: String,
}

/// Чужие и внутренние адреса сервера клиентам недоступны.
const PRIVATE: &[&str] = &["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"];

pub(super) fn xray_config(s: &Server, x: &Xhttp, sec: &Secrets) -> Value {
    let live = guests::live(s, sec, crate::monitor::now_ms());
    let mut clients = vec![json!({ "id": sec.uuid, "email": "wpx" })];
    // Гость с доступом VLESS получает и XHTTP — тот же ключ.
    clients.extend(live.iter().filter(|(g, _)| g.vless).map(|(g, k)| json!({ "id": k.uuid, "email": g.id })));
    json!({
        "log": { "loglevel": "warning" },
        "inbounds": [{
            "tag": "xhttp", "listen": "::", "port": x.port, "protocol": "vless",
            "settings": { "clients": clients, "decryption": "none" },
            "streamSettings": {
                "network": "xhttp",
                "xhttpSettings": { "path": x.path, "mode": "auto" },
                "security": "reality",
                "realitySettings": {
                    "target": format!("{}:443", x.dest), "serverNames": [x.dest],
                    "privateKey": sec.xhttp_private, "shortIds": [x.short_id]
                }
            },
            "sniffing": { "enabled": true, "destOverride": ["http", "tls", "quic"], "routeOnly": true }
        }],
        // У части хостеров IPv6 доходит не до всех сайтов — сначала IPv4.
        "outbounds": [
            { "protocol": "freedom", "tag": "direct", "streamSettings": { "sockopt": { "domainStrategy": "UseIPv4v6" } } },
            { "protocol": "blackhole", "tag": "block" }
        ],
        "routing": { "rules": [{ "type": "field", "ip": PRIVATE, "outboundTag": "block" }] }
    })
}

/// Секрет FakeTLS: `ee` + 16 случайных байт + имя сайта-прикрытия (hex).
pub(super) fn mtg_secret(domain: &str) -> String {
    format!("ee{}{}", hex(&rnd(16)), hex(domain.as_bytes()))
}

fn mtg_config(m: &MtProxy, secret: &str) -> String {
    format!("secret = \"{secret}\"\nbind-to = \"0.0.0.0:{}\"\nprefer-ip = \"prefer-ipv4\"\n", m.port)
}

/// Ссылка Telegram на MTProxy.
pub(super) fn mtg_link(host: &str, m: &MtProxy, secret: &str) -> String {
    format!("tg://proxy?server={host}&port={}&secret={secret}", m.port)
}

/// Общий запуск контейнера: только чтение, без возможностей (кроме привязки
/// к порту), без повышения прав; конфиг — смонтированная папка wpx.
const RUN_FUNCS: &str = r#"
run_box() { # имя образ папка аргументы…
  n=$1; img=$2; dir=$3; shift 3
  docker rm -f "$n" >/dev/null 2>&1 || true
  docker run -d --name "$n" --restart unless-stopped --network host --memory 200m \
    --user 0:0 --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --read-only \
    -v "$dir:$dir:ro" "$img" "$@" >/dev/null
}
port_up() { ss -tlnH "sport = :$1" 2>/dev/null | grep -q .; }
"#;

/// Xray: конфиг из stdin → `xray run -test` → замена → запуск → порт слушает;
/// при сбое — прежний конфиг.
const DEPLOY_XRAY: &str = r#"
set -u
X=/opt/wpx/xray
mkdir -p "$X" && chmod 700 /opt/wpx "$X"
cat > "$X/config.new.json"; chmod 600 "$X/config.new.json"
docker pull -q "$IMG" >/dev/null || { echo "не скачался образ $IMG" >&2; exit 3; }
if ! out=$(docker run --rm --user 0:0 -v "$X:$X:ro" "$IMG" run -test -c "$X/config.new.json" 2>&1); then rm -f "$X/config.new.json"; echo "конфиг не принят: $out" >&2; exit 2; fi
[ -f "$X/config.json" ] && cp -p "$X/config.json" "$X/config.prev.json"
mv "$X/config.new.json" "$X/config.json"
start() { run_box wpx-xray "$IMG" "$X" run -c "$X/config.json"; }
start; ok=0
for i in 1 2 3 4 5 6 7 8; do sleep 1; if port_up "$PORT"; then ok=1; break; fi; done
if [ $ok = 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$PORT/tcp" >/dev/null; fi
  rm -f "$X/config.prev.json"; echo XRAY-OK; exit 0
fi
l=$(docker logs --tail 5 wpx-xray 2>&1)
if [ -f "$X/config.prev.json" ]; then mv "$X/config.prev.json" "$X/config.json"; start; echo "вернул прежний конфиг" >&2; fi
echo "Xray не поднялся: $l" >&2; exit 1
"#;

const DEPLOY_MTG: &str = r#"
set -u
M=/opt/wpx/mtg
mkdir -p "$M" && chmod 700 /opt/wpx "$M"
cat > "$M/config.new.toml"; chmod 600 "$M/config.new.toml"
docker pull -q "$IMG" >/dev/null || { echo "не скачался образ $IMG" >&2; exit 3; }
[ -f "$M/config.toml" ] && cp -p "$M/config.toml" "$M/config.prev.toml"
mv "$M/config.new.toml" "$M/config.toml"
start() { run_box wpx-mtg "$IMG" "$M" run "$M/config.toml"; }
start; ok=0
for i in 1 2 3 4 5 6 7 8; do sleep 1; if port_up "$PORT"; then ok=1; break; fi; done
if [ $ok = 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$PORT/tcp" >/dev/null; fi
  rm -f "$M/config.prev.toml"; echo MTG-OK; exit 0
fi
l=$(docker logs --tail 5 wpx-mtg 2>&1)
if [ -f "$M/config.prev.toml" ]; then mv "$M/config.prev.toml" "$M/config.toml"; start; echo "вернул прежний конфиг" >&2; fi
echo "MTProxy не поднялся: $l" >&2; exit 1
"#;

/// Убрать службу: контейнер и её папку.
const REMOVE_BOX: &str = r#"
docker rm -f "$NAME" >/dev/null 2>&1 || true
rm -rf "/opt/wpx/$DIR"
echo REMOVED
"#;

pub(super) async fn deploy_xray(c: &Conn, s: &Server, x: &Xhttp, sec: &Secrets, log: &Log) -> Result<(), String> {
    log("step", format!("Xray {XRAY_VERSION}: VLESS + XHTTP + Reality, свой контейнер wpx-xray, TCP {} (при сбое — откат)", x.port));
    let cfg = serde_json::to_vec_pretty(&xray_config(s, x, sec)).map_err(|e| e.to_string())?;
    let o = c.sh(&[("IMG", XRAY_IMAGE.into()), ("PORT", x.port.to_string())], &format!("{RUN_FUNCS}{DEPLOY_XRAY}"), &cfg, 300).await?;
    if o.code != 0 || !o.out.contains("XRAY-OK") {
        return Err(o.reason());
    }
    log("ok", format!("XHTTP слушает TCP {}", x.port));
    Ok(())
}

async fn deploy_mtg(c: &Conn, m: &MtProxy, secret: &str, log: &Log) -> Result<(), String> {
    log("step", format!("MTProxy (mtg {MTG_VERSION}): FakeTLS под {}, свой контейнер wpx-mtg, TCP {}", m.domain, m.port));
    let o = c.sh(&[("IMG", MTG_IMAGE.into()), ("PORT", m.port.to_string())], &format!("{RUN_FUNCS}{DEPLOY_MTG}"), mtg_config(m, secret).as_bytes(), 300).await?;
    if o.code != 0 || !o.out.contains("MTG-OK") {
        return Err(o.reason());
    }
    log("ok", format!("MTProxy слушает TCP {} — ссылка и QR: кнопка «Telegram» на карточке сервера", m.port));
    Ok(())
}

async fn remove(c: &Conn, name: &str, dir: &str) -> Result<(), String> {
    c.sh(&[("NAME", name.into()), ("DIR", dir.into())], REMOVE_BOX, b"", 60).await.map(|_| ())
}

/// Свободный TCP-порт: из «похожих на HTTPS», иначе случайный высокий.
fn tcp_port(f: &Facts, taken: &[u16]) -> Option<u16> {
    PORTS_MAIN.iter().copied().find(|&p| free(&f.tcp, p) && !taken.contains(&p))
        .or_else(|| (0..64).map(|_| rnd_in(20000, 60000) as u16).find(|&p| free(&f.tcp, p) && !taken.contains(&p)))
}

/// Поставить, обновить или убрать XHTTP и MTProxy (в ходе установки).
pub(super) async fn apply(c: &Conn, s: &mut Server, sec: &mut Secrets, f: &Facts, dest: &str, want_x: bool, want_m: bool, log: &Log) -> Result<(), String> {
    let mut taken: Vec<u16> = s.pipes.iter().map(|p| p.listen).chain(s.vless.iter().map(|v| v.port)).collect();
    if want_x {
        let port = match &s.xhttp {
            Some(x) => x.port,
            None => tcp_port(f, &taken).ok_or("нет свободного TCP-порта для XHTTP")?,
        };
        taken.push(port);
        if sec.uuid.is_empty() {
            sec.uuid = uuid4();
        }
        if sec.xhttp_private.is_empty() {
            sec.xhttp_private = reality_keypair().0;
        }
        let x = Xhttp {
            port,
            dest: s.xhttp.as_ref().map(|x| x.dest.clone()).unwrap_or_else(|| dest.to_string()),
            public_key: reality_public(&sec.xhttp_private)?,
            short_id: s.xhttp.as_ref().map(|x| x.short_id.clone()).unwrap_or_else(|| hex(&rnd(8))),
            path: s.xhttp.as_ref().map(|x| x.path.clone()).unwrap_or_else(|| format!("/{}", hex(&rnd(6)))),
        };
        deploy_xray(c, s, &x, sec, log).await?;
        s.xhttp = Some(x);
    } else if s.xhttp.take().is_some() {
        log("step", "Убираю XHTTP (Xray) wpx".into());
        remove(c, "wpx-xray", "xray").await?;
    }
    if want_m {
        let port = match &s.mtproxy {
            Some(m) => m.port,
            None => tcp_port(f, &taken).ok_or("нет свободного TCP-порта для MTProxy")?,
        };
        let m = MtProxy { port, domain: s.mtproxy.as_ref().map(|m| m.domain.clone()).unwrap_or_else(|| dest.to_string()) };
        if sec.mtg_secret.is_empty() || !sec.mtg_secret.ends_with(&hex(m.domain.as_bytes())) {
            sec.mtg_secret = mtg_secret(&m.domain);
        }
        deploy_mtg(c, &m, &sec.mtg_secret, log).await?;
        s.mtproxy = Some(m);
    } else if s.mtproxy.take().is_some() {
        log("step", "Убираю MTProxy wpx".into());
        remove(c, "wpx-mtg", "mtg").await?;
    }
    Ok(())
}

/// Ссылка на MTProxy для Telegram: открыть на телефоне или отсканировать.
#[derive(Serialize)]
pub struct MtLink {
    pub link: String,
    /// Та же ссылка через t.me — откроется и там, где tg:// не понимают.
    pub web: String,
    pub qr: String,
}

#[tauri::command]
pub fn server_mtproxy_link(id: String) -> Result<MtLink, String> {
    let st = load();
    let s = st.servers.iter().find(|x| x.id == id).ok_or("сервер не найден")?;
    let m = s.mtproxy.as_ref().ok_or("MTProxy на этом сервере не установлен")?;
    let sec = secrets_of(s)?;
    let link = mtg_link(&s.host, m, &sec.mtg_secret);
    let web = link.replacen("tg://proxy?", "https://t.me/proxy?", 1);
    Ok(MtLink { qr: guests::qr_svg(&link), link, web })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_and_configs() {
        let s = mtg_secret("www.apple.com");
        assert!(s.starts_with("ee") && s.ends_with(&hex(b"www.apple.com")) && s.len() == 2 + 32 + 26);
        let m = MtProxy { port: 2053, domain: "www.apple.com".into() };
        assert!(mtg_config(&m, &s).contains("bind-to = \"0.0.0.0:2053\""));
        assert_eq!(mtg_link("1.2.3.4", &m, "ee00"), "tg://proxy?server=1.2.3.4&port=2053&secret=ee00");
        let (private, public) = reality_keypair();
        let x = Xhttp { port: 8443, dest: "www.microsoft.com".into(), public_key: public, short_id: "ab".into(), path: "/p1".into() };
        let sec = Secrets { uuid: uuid4(), xhttp_private: private, ..Default::default() };
        let srv = Server { xhttp: Some(x.clone()), ..Default::default() };
        let c = xray_config(&srv, &x, &sec);
        assert_eq!(c["inbounds"][0]["streamSettings"]["network"], "xhttp");
        assert_eq!(c["inbounds"][0]["streamSettings"]["realitySettings"]["target"], "www.microsoft.com:443");
        assert_eq!(c["inbounds"][0]["settings"]["clients"][0]["id"], sec.uuid);
        assert_eq!(c["routing"]["rules"][0]["outboundTag"], "block");
    }
}
