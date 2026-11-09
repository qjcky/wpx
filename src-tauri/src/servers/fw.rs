//! Файрвол сервера: снаружи открыты только SSH и порты VPN wpx.
//!
//! Своя таблица nftables `inet wpx_fw`, фильтр только на входе к самому
//! серверу (hook input). Правила Docker и чужих контейнеров (AmneziaVPN) не
//! трогаются: трафик к опубликованным портам контейнеров идёт через forward,
//! а не input; их порты всё равно добавляются в открытые — на случай
//! userland-proxy. Страховка от потери доступа: после включения wpx заходит по
//! SSH новым соединением и только тогда закрепляет правила; не зашёл — сервер
//! сам снимет таблицу через 90 с.

use super::*;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Firewall {
    /// Что ещё оставить открытым по выбору человека: "tcp/80", "udp/1194".
    #[serde(default)]
    pub keep: Vec<String>,
}

/// Что будет открыто и что закроется — для окна (по последнему осмотру).
#[derive(Serialize, Clone, Debug, Default)]
pub struct FwPlan {
    pub open: Vec<String>,
    /// ("tcp/111", "rpcbind") — слушают снаружи, но не нужны wpx.
    pub close: Vec<(String, String)>,
}

/// Порты, которые должны быть открыты: SSH, VPN wpx, контейнеры, выбранные.
fn ports(s: &Server, fw: &Firewall) -> (Vec<u16>, Vec<u16>) {
    let f = s.facts.clone().unwrap_or_default();
    let (mut tcp, mut udp) = our_ports(s);
    udp.extend(s.awg.iter().map(|a| a.port));
    tcp.extend(s.xhttp.iter().map(|x| x.port));
    tcp.extend(s.mtproxy.iter().map(|m| m.port));
    tcp.push(s.port);
    tcp.extend(f.tcp.iter().filter(|(_, p)| p == "sshd").map(|(n, _)| *n));
    tcp.extend(f.tcp.iter().filter(|(_, p)| p == "docker-proxy").map(|(n, _)| *n));
    udp.extend(f.udp.iter().filter(|(_, p)| p == "docker-proxy").map(|(n, _)| *n));
    for k in &fw.keep {
        match k.split_once('/') {
            Some(("tcp", n)) => tcp.extend(n.parse::<u16>().ok()),
            Some(("udp", n)) => udp.extend(n.parse::<u16>().ok()),
            _ => {}
        }
    }
    for v in [&mut tcp, &mut udp] {
        v.sort_unstable();
        v.dedup();
    }
    (tcp, udp)
}

pub fn plan(s: &Server) -> FwPlan {
    let fw = s.fw.clone().unwrap_or_default();
    let (tcp, udp) = ports(s, &fw);
    let f = s.facts.clone().unwrap_or_default();
    let name = |proto: &str, n: u16| -> String {
        let mine = |x: Option<u16>| x == Some(n);
        if proto == "tcp" && (n == s.port || f.tcp.iter().any(|(p, w)| *p == n && w == "sshd")) {
            "SSH".into()
        } else if proto == "tcp" && mine(s.vless.as_ref().map(|v| v.port)) {
            "VLESS".into()
        } else if proto == "udp" && mine(s.hy2.as_ref().map(|h| h.port)) {
            "Hysteria2".into()
        } else if proto == "udp" && mine(s.awg.as_ref().map(|a| a.port)) {
            "AmneziaWG".into()
        } else if proto == "tcp" && mine(s.xhttp.as_ref().map(|x| x.port)) {
            "XHTTP".into()
        } else if proto == "tcp" && mine(s.mtproxy.as_ref().map(|m| m.port)) {
            "MTProxy".into()
        } else if s.pipes.iter().any(|p| p.listen == n) {
            "каскад".into()
        } else {
            let list = if proto == "tcp" { &f.tcp } else { &f.udp };
            list.iter().find(|(p, _)| *p == n).map(|(_, w)| if w == "docker-proxy" { "контейнер".to_string() } else { w.clone() }).unwrap_or_default()
        }
    };
    let mut open: Vec<String> = tcp.iter().map(|&n| format!("{} :{n}", name("tcp", n))).collect();
    open.extend(udp.iter().map(|&n| format!("{} :{n}/udp", name("udp", n))));
    let close = f
        .public
        .iter()
        .filter(|(proto, n, _)| !(if proto == "tcp" { &tcp } else { &udp }).contains(n))
        .map(|(proto, n, w)| (format!("{proto}/{n}"), w.clone()))
        .collect();
    FwPlan { open, close }
}

const FW_APPLY: &str = r#"
set -u
command -v nft >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; apt-get -qq install -y nftables >/dev/null 2>&1; }
command -v nft >/dev/null 2>&1 || { echo "нет nftables и не удалось поставить" >&2; exit 3; }
# Для надёжности добавить то, что видно прямо сейчас: sshd и порты контейнеров.
TCP="$TCP $(ss -tlnpH 2>/dev/null | awk '/"sshd"/{n=split($4,a,":"); print a[n]}' | tr '\n' ' ')"
DP=$(docker ps --format '{{.Ports}}' 2>/dev/null | tr ',' '\n' | sed -n 's/.*:\([0-9][0-9]*\)->[0-9][0-9]*\/\(tcp\|udp\).*/\1 \2/p')
TCP="$TCP $(echo "$DP" | awk '$2=="tcp"{print $1}' | tr '\n' ' ')"
UDP="$UDP $(echo "$DP" | awk '$2=="udp"{print $1}' | tr '\n' ' ')"
set_of() { echo "$@" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -un | paste -sd, -; }
T=$(set_of $TCP); U=$(set_of $UDP)
[ -n "$T" ] || { echo "пустой список TCP — не включаю, чтобы не потерять SSH" >&2; exit 2; }
mkdir -p /opt/wpx && chmod 700 /opt/wpx
{
  echo 'table inet wpx_fw'
  echo 'delete table inet wpx_fw'
  echo 'table inet wpx_fw {'
  echo '  chain input {'
  echo '    type filter hook input priority filter + 10; policy accept;'
  echo '    ct state established,related accept'
  echo '    iifname "lo" accept'
  echo '    iifname "docker0" accept'
  echo '    iifname "br-*" accept'
  echo '    meta l4proto { icmp, ipv6-icmp } accept'
  echo '    udp sport 67 udp dport 68 accept'
  echo '    udp sport 547 udp dport 546 accept'
  echo "    tcp dport { $T } accept"
  [ -n "$U" ] && echo "    udp dport { $U } accept"
  echo '    counter drop'
  echo '  }'
  echo '}'
} > /opt/wpx/fw.new
nft -c -f /opt/wpx/fw.new 2>&1 || { rm -f /opt/wpx/fw.new; echo "правила не приняты" >&2; exit 2; }
mv /opt/wpx/fw.new /opt/wpx/fw.nft
rm -f /opt/wpx/fw.ok
nft -f /opt/wpx/fw.nft || exit 1
# Страховка: не подтвердили новым входом по SSH за 90 с — правила снимаются.
nohup setsid sh -c 'sleep 90; [ -f /opt/wpx/fw.ok ] || nft delete table inet wpx_fw' >/dev/null 2>&1 &
echo "FW-ON tcp=$T udp=$U"
"#;

/// Подтверждение из нового SSH-соединения: закрепить и включить при загрузке.
const FW_CONFIRM: &str = r#"
touch /opt/wpx/fw.ok
if [ -d /run/systemd/system ]; then
cat > /etc/systemd/system/wpx-fw.service <<'UNIT'
[Unit]
Description=wpx firewall (SSH + VPN only)
Wants=network-pre.target
Before=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft -f /opt/wpx/fw.nft'
ExecStop=/bin/sh -c 'nft delete table inet wpx_fw 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable wpx-fw >/dev/null 2>&1
fi
echo FW-OK
"#;

pub(super) const FW_OFF: &str = r#"
systemctl disable wpx-fw >/dev/null 2>&1 || true
rm -f /etc/systemd/system/wpx-fw.service; systemctl daemon-reload 2>/dev/null || true
nft delete table inet wpx_fw 2>/dev/null || true
rm -f /opt/wpx/fw.nft /opt/wpx/fw.ok; echo FW-OFF
"#;

/// Включить или обновить правила: применить → войти заново → закрепить.
pub(super) async fn apply(st: &Store, c: &Conn, s: &Server, log: &Log) -> Result<(), String> {
    let fw = s.fw.clone().unwrap_or_default();
    let (tcp, udp) = ports(s, &fw);
    let list = |v: &[u16]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");
    log("step", format!("Файрвол: открыто только SSH и VPN (TCP {} · UDP {})", list(&tcp), list(&udp)));
    let o = c.sh(&[("TCP", list(&tcp)), ("UDP", list(&udp))], FW_APPLY, b"", 180).await?;
    if o.code != 0 || !o.out.contains("FW-ON") {
        return Err(format!("файрвол не включился: {}", o.reason()));
    }
    log("step", "Проверяю, что SSH пускает новым соединением (иначе через 90 с правила снимутся сами)".into());
    let quiet: Log = Arc::new(|_, _| {});
    let again = open(st, s, &quiet).await;
    let r = match again {
        Ok(c2) => {
            let r = c2.sh(&[], FW_CONFIRM, b"", 60).await;
            c2.close().await;
            r
        }
        Err(e) => Err(e),
    };
    match r {
        Ok(o) if o.out.contains("FW-OK") => {
            log("ok", "Файрвол включён и переживёт перезагрузку".into());
            Ok(())
        }
        Ok(o) => Err(format!("файрвол не закреплён: {} — через 90 с правила снимутся сами", o.reason())),
        Err(e) => Err(format!("после включения файрвола SSH не пустил ({e}) — через 90 с правила снимутся сами")),
    }
}

/// Включить, обновить список или выключить файрвол.
async fn set(id: &str, on: bool, keep: Vec<String>, log: &Log) -> Result<ServersState, String> {
    let mut st = load();
    let mut s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
    let c = open(&st, &s, log).await?;
    let r = async {
        let f = inspect(&c).await?;
        s.facts = Some(f);
        if on {
            s.fw = Some(Firewall { keep: keep.into_iter().filter(|k| k.starts_with("tcp/") || k.starts_with("udp/")).collect() });
            apply(&st, &c, &s, log).await
        } else {
            log("step", "Выключаю файрвол wpx".into());
            let o = c.sh(&[], FW_OFF, b"", 60).await?;
            if !o.out.contains("FW-OFF") {
                return Err(o.reason());
            }
            s.fw = None;
            log("ok", "Файрвол wpx выключен".into());
            Ok(())
        }
    }
    .await;
    if let Ok(f) = inspect(&c).await {
        s.facts = Some(f);
    }
    c.close().await;
    r?;
    if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) {
        *x = s;
    }
    save(&st)?;
    Ok(state(&st))
}

#[tauri::command]
pub async fn server_firewall(app: AppHandle, id: String, on: bool, keep: Vec<String>) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = set(&id, on, keep, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

/// `--server firewall <сервер> on|off [--keep tcp/80,udp/1194]`.
pub(super) async fn cli(args: &[String], log: &Log) -> Result<String, String> {
    let key = args.get(1).cloned().unwrap_or_default();
    let id = load().servers.iter().find(|s| s.id == key || s.name == key || s.host == key).map(|s| s.id.clone()).ok_or(format!("нет сервера «{key}»"))?;
    let on = args.get(2).map(String::as_str) != Some("off");
    let keep = args.iter().position(|a| a == "--keep").and_then(|i| args.get(i + 1)).map(|k| k.split(',').map(String::from).collect()).unwrap_or_default();
    set(&id, on, keep, log).await?;
    let s = load().servers.into_iter().find(|s| s.id == id).ok_or("нет")?;
    let p = plan(&s);
    Ok(format!("открыто: {}\nзакрыто: {}", p.open.join(", "), p.close.iter().map(|(k, w)| format!("{k} {w}")).collect::<Vec<_>>().join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_keeps_ssh_vpn_and_containers() {
        let f = Facts {
            tcp: vec![(22, "sshd".into()), (443, "sing-box".into()), (111, "rpcbind".into()), (53, "systemd-resolve".into())],
            udp: vec![(443, "sing-box".into()), (35387, "docker-proxy".into()), (111, "rpcbind".into())],
            public: vec![("tcp".into(), 22, "sshd".into()), ("tcp".into(), 443, "sing-box".into()), ("tcp".into(), 111, "rpcbind".into()), ("udp".into(), 35387, "docker-proxy".into()), ("udp".into(), 111, "rpcbind".into())],
            ..Default::default()
        };
        let mut s = Server {
            port: 22,
            facts: Some(f),
            vless: Some(Vless { port: 443, dest: "x".into(), public_key: "k".into(), short_id: "s".into() }),
            hy2: Some(Hy2 { port: 443, sni: "x".into(), cert_sha256: "z".into(), hop: None }),
            awg: Some(Awg { port: 50738, server_public: "k".into(), obf: vec![] }),
            pipes: vec![Pipe { to: "x".into(), to_host: "1.2.3.4".into(), listen: 8443, to_port: 443, ..Default::default() }],
            ..Default::default()
        };
        let (tcp, udp) = ports(&s, &Firewall::default());
        assert_eq!(tcp, vec![22, 443, 8443]);
        assert_eq!(udp, vec![443, 8443, 35387, 50738]);
        let p = plan(&s);
        assert_eq!(p.close, vec![("tcp/111".to_string(), "rpcbind".to_string()), ("udp/111".to_string(), "rpcbind".to_string())]);
        assert!(p.open.contains(&"SSH :22".to_string()) && p.open.contains(&"контейнер :35387/udp".to_string()));
        s.fw = Some(Firewall { keep: vec!["tcp/111".into()] });
        assert_eq!(plan(&s).close.len(), 1);
    }
}
