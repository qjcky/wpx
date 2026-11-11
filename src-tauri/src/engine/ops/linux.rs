//! Linux: транзакции на bash. Окно polkit (pkexec) → скрипт (аргументом, без
//! файла; итог — последней строкой вывода, в папку пользователя от root
//! ничего не пишется) → страховка `systemd-run --on-active` с отменой.
//! Движок — служба systemd `wpx-engine`, правила (прямой DNS и IPv6 мимо
//! туннеля, kill switch) — таблица nftables `inet wpx`, её поднимает служба
//! `wpx-firewall` до сети. Свой трафик mihomo помечает (`routing-mark`), по
//! этой метке правила его пропускают.

use base64::Engine as _;
use std::path::Path;
use std::process::Command;

use super::ApplyResult;
use crate::config::{self, EngineKind, EngineLoc, WPX_DIR, WPX_ROOT};
use crate::engine::netcfg::{NetSettings, ROUTING_MARK};

/// Значение в одинарных кавычках для bash.
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

struct Tx {
    /// Проверки до изменений (`fail КОД` — ничего не тронуто).
    pre: String,
    /// Изменения (`set -e`: первая ошибка — отмена).
    mutate: String,
    /// Отмена (None — без страховки).
    undo: Option<String>,
    /// Минут до срабатывания страховки.
    guard_min: u32,
    /// Проверять туннель после изменений.
    verify: bool,
}

const ENGINE_UNIT: &str = r"[Unit]
Description=wpx engine (mihomo, TUN)
Wants=network-online.target
After=network-online.target wpx-firewall.service

[Service]
Type=simple
ExecStartPre=-/usr/sbin/nft -f /opt/wpx/engine/rules.nft
ExecStart=/opt/wpx/engine/mihomo -d /opt/wpx/engine/home -f /opt/wpx/engine/config.yaml
ExecStopPost=-/bin/sh -c 'grep -q dport.67.return /opt/wpx/engine/rules.nft || /usr/sbin/nft delete table inet wpx'
Restart=always
RestartSec=5
StandardOutput=append:/opt/wpx/engine/engine.log
StandardError=append:/opt/wpx/engine/engine.log

[Install]
WantedBy=multi-user.target
";

const FIREWALL_UNIT: &str = r"[Unit]
Description=wpx firewall rules (nftables)
DefaultDependencies=no
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'grep -q dport.67.return /opt/wpx/engine/rules.nft && /usr/sbin/nft -f /opt/wpx/engine/rules.nft || true'

[Install]
WantedBy=multi-user.target
";

const WATCHDOG_SH: &str = r#"#!/bin/bash
# wpx watchdog: the tunnel is down - restart the engine (not more often than every 5 min).
D=/opt/wpx/engine
{ [ -f $D/wpx-stopped ] || [ -f $D/wpx-maint ] || [ ! -f $D/wpx-active ]; } && exit 0
c=$(curl -s -o /dev/null -m 8 -w '%{http_code}' http://www.gstatic.com/generate_204)
[ "$c" = 204 ] && exit 0
now=$(date +%s); last=$(cat $D/heal-last 2>/dev/null || echo 0)
[ $((now - last)) -lt 300 ] && exit 0
echo "$now" > $D/heal-last
echo "$(date -Is) tunnel down - restarting the engine" >> $D/heal.log
systemctl restart wpx-engine
"#;

const WATCHDOG_UNITS: &str = r"cat > /etc/systemd/system/wpx-watchdog.service <<'WPX_EOF'
[Unit]
Description=wpx watchdog
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/wpx/engine/watchdog.sh
WPX_EOF
cat > /etc/systemd/system/wpx-watchdog.timer <<'WPX_EOF'
[Unit]
Description=wpx watchdog (every minute)
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
WPX_EOF
";

/// Таблица nftables `inet wpx`: как правила брандмауэра Windows — прямой DNS
/// и IPv6 мимо туннеля закрыты на физическом адаптере; kill switch — всё
/// мимо туннеля, кроме локальной сети, DHCP и NDP. mihomo проходит по метке.
pub(super) fn nft_rules(n: &NetSettings) -> String {
    // Имена уже проверены (netcfg::valid_iface/valid_tun); здесь — ещё раз:
    // строка уходит в nft от root, лишнее (кавычки, перевод строки) — прочь.
    let safe = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric() || "_.-".contains(*c)).collect::<String>();
    let iface = safe(&n.interface);
    let tun = safe(&n.tun_device);
    let v6 = if n.ipv6 == "tunnel" {
        format!("    oifname \"{iface}\" meta nfproto ipv6 drop\n")
    } else {
        "    meta nfproto ipv6 drop\n".to_string()
    };
    let ks = if n.kill_switch {
        let lan: Vec<String> = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]
            .iter()
            .map(|s| s.to_string())
            .chain(n.lan.iter().map(|c| c.trim()).filter(|c| crate::engine::netcfg::valid_cidr(c)).map(String::from))
            .collect();
        format!(
            "    ip daddr {{ {} }} return\n    udp sport 68 udp dport 67 return\n    icmpv6 type {{ nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert }} return\n    drop\n",
            lan.join(", ")
        )
    } else {
        String::new()
    };
    format!(
        "table inet wpx\ndelete table inet wpx\ntable inet wpx {{\n  chain out {{\n    type filter hook output priority 0; policy accept;\n    meta mark {ROUTING_MARK} return\n    oifname \"lo\" return\n    oifname \"{tun}\" return\n    oifname \"{iface}\" udp dport {{ 53, 853 }} drop\n    oifname \"{iface}\" tcp dport {{ 53, 853 }} drop\n{v6}{ks}  }}\n}}\n"
    )
}

/// Скопировать файл в папку движка и проверить уже копию (её пользователь
/// подменить не может): не совпал хэш — копия удаляется, транзакция падает.
fn copy_verified(src: &str, dst: &str, hash: &str, err: &str) -> String {
    format!(
        "  cp -f -- {s} {n}\n  [ \"$(sha256sum {n} | cut -d' ' -f1 | tr a-f A-F)\" = {h} ] || {{ rm -f {n}; fail {e}; }}\n  mv -f {n} {d}\n",
        s = q(src),
        n = q(&format!("{dst}.new")),
        d = q(dst),
        h = q(hash),
        e = q(err),
    )
}

/// Записать текст в файл (heredoc с кавычками — без подстановок).
fn write_file(path: &str, text: &str) -> String {
    format!("  cat > {} <<'WPX_EOF'\n{}WPX_EOF\n", q(path), if text.ends_with('\n') { text.to_string() } else { format!("{text}\n") })
}

/// Домашняя папка mihomo (`home`): пишет туда только он сам (root). Папок
/// пользователя внутри быть не должно — mihomo проверяет пути лишь по тексту,
/// и символическая ссылка в такой папке пустила бы его запись куда угодно;
/// прежние папки правил убираем (`rm -rf` ссылки не раскрывает), кэш
/// скачанных списков переносим.
fn home_block() -> String {
    format!(
        "  install -d -m 755 {d}/home\n  if [ -d {d}/rules ] && [ ! -L {d}/rules ] && [ ! -e {d}/home/rules ]; then mv {d}/rules {d}/home/rules; fi\n  rm -rf {d}/home/user {d}/user {d}/rules\n",
        d = WPX_DIR,
    )
}

/// Правила: файл и (если служба wpx-firewall уже есть) её перезапуск — она
/// поднимает их и при загрузке ПК; при установке службы ещё нет — тогда
/// напрямую через nft, служба запустится ниже.
fn rules_block(n: &NetSettings) -> String {
    format!(
        "{}  if [ -f /etc/systemd/system/wpx-firewall.service ]; then systemctl restart wpx-firewall; else nft -f {d}/rules.nft; fi\n",
        write_file(&format!("{WPX_DIR}/rules.nft"), &nft_rules(n)),
        d = WPX_DIR
    )
}

fn restart_block() -> String {
    format!(
        "  rm -f {d}/wpx-stopped\n  l={d}/engine.log; if [ -f $l ] && [ $(stat -c %s $l) -gt 5242880 ]; then mv -f $l $l.old; fi\n  systemctl restart wpx-engine\n",
        d = WPX_DIR
    )
}

fn script(tx: &Tx) -> String {
    let undo = tx.undo.clone().unwrap_or_default();
    format!(
        r#"set -u
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
D={d}
LOG={d}/engine.log
INFOF=$(mktemp); ERRF=$(mktemp)
fail() {{ printf '%s' "$1" > "$ERRF"; exit 1; }}
test_tunnel() {{
  for i in $(seq 0 19); do
    sleep 3
    if [ "$i" -ge 3 ] && ! systemctl is-active -q wpx-engine; then return 1; fi
    c=$(curl --noproxy '*' -s -o /dev/null -m 6 -w '%{{http_code}}' http://www.gstatic.com/generate_204)
    [ "$c" = 204 ] && return 0
  done
  return 1
}}
log_tail() {{ tail -n 3 "$LOG" 2>/dev/null | tr '\n' ' ' | tr '|' '/'; }}
command -v systemctl >/dev/null || {{ echo "ERR||E_NO_SYSTEMD"; exit 0; }}
command -v nft >/dev/null || {{ echo "ERR||E_NO_NFT"; exit 0; }}
mkdir -p "$D" && touch "$D/wpx-maint"
( set -e
{pre}
); rc=$?
if [ $rc -ne 0 ]; then rm -f "$D/wpx-maint"; echo "ERR||$(cat "$ERRF")"; exit 0; fi
armed=0; guarded={guarded}
if [ $guarded = 1 ]; then
  cat > {root}/rollback.sh <<'WPX_UNDO'
set +e
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
{undo}systemctl stop wpx-rollback.timer 2>/dev/null
rm -f {d}/wpx-maint
WPX_UNDO
  chmod 700 {root}/rollback.sh
  systemctl stop wpx-rollback.timer 2>/dev/null
  systemd-run --quiet --unit=wpx-rollback --on-active={gmin}min --timer-property=AccuracySec=1s /bin/bash {root}/rollback.sh && armed=1
fi
out=OK; msg=''
( set -e
{mutate}
); rc=$?
if [ $rc -eq 0 ]; then
  if [ {verify} = 1 ] && ! test_tunnel; then
    msg="LOG:$(log_tail)"
    if [ $guarded = 1 ]; then bash {root}/rollback.sh >/dev/null 2>&1; out=ROLLEDBACK; else out=NOTUNNEL; fi
  fi
else
  m=$(cat "$ERRF"); [ -z "$m" ] && m=E_FAILED
  if [ $guarded = 1 ]; then bash {root}/rollback.sh >/dev/null 2>&1; out=ROLLEDBACK; else out=ERR; fi
  msg="$m"
fi
[ $armed = 1 ] && systemctl stop wpx-rollback.timer 2>/dev/null
rm -f "$D/wpx-maint" "$ERRF"
echo "$out|$(cat "$INFOF" 2>/dev/null)|$msg"
rm -f "$INFOF"
"#,
        d = WPX_DIR,
        root = WPX_ROOT,
        pre = tx.pre,
        mutate = tx.mutate,
        undo = undo,
        guarded = if tx.undo.is_some() { 1 } else { 0 },
        gmin = tx.guard_min.max(2),
        verify = if tx.verify { 1 } else { 0 },
    )
}

/// Окно polkit → скрипт от root → итог из последней строки вывода.
fn run(tx: Tx) -> ApplyResult {
    if config::LAB {
        return ApplyResult::fail(super::LAB_OFF);
    }
    let out = Command::new("pkexec").arg("/bin/bash").arg("-c").arg(script(&tx)).output();
    match out {
        Ok(o) => {
            // 126 — окно закрыли, 127 — нет прав (или нет агента polkit).
            let cancelled = matches!(o.status.code(), Some(126 | 127));
            super::outcome(&String::from_utf8_lossy(&o.stdout), cancelled)
        }
        Err(e) => ApplyResult::fail(format!("не запустился pkexec ({e}) — нужен polkit")),
    }
}

// ─── Транзакции ──────────────────────────────────────────────────

fn tx_install(staged: &Path, hash: &str, src: &Path, sha: &str, n: &NetSettings) -> Tx {
    let mutate = format!(
        "  install -d -m 755 {root} {d}\n{mihomo}  chmod 755 {d}/mihomo\n{config}  chmod 644 {d}/config.yaml\n{user}{rules}{eu}{fu}  systemctl daemon-reload\n  systemctl enable -q wpx-firewall\n  systemctl restart wpx-firewall\n  echo 1 > {d}/wpx-boot\n  systemctl enable -q wpx-engine\n  echo wpx > {d}/wpx-active\n  rm -f {d}/wpx-stopped\n  systemctl restart wpx-engine\n",
        root = WPX_ROOT,
        d = WPX_DIR,
        mihomo = copy_verified(&src.to_string_lossy(), &format!("{WPX_DIR}/mihomo"), sha, "E_MIHOMO_HASH"),
        config = copy_verified(&staged.to_string_lossy(), &format!("{WPX_DIR}/config.yaml"), hash, "E_CANDIDATE_CHANGED"),
        user = home_block(),
        rules = rules_block(n),
        eu = write_file("/etc/systemd/system/wpx-engine.service", ENGINE_UNIT),
        fu = write_file("/etc/systemd/system/wpx-firewall.service", FIREWALL_UNIT),
    );
    let pre = format!("  [ -f {} ] || fail E_NO_MIHOMO\n", q(&src.to_string_lossy()));
    let undo = format!(
        "systemctl disable --now -q wpx-engine 2>/dev/null\nsystemctl disable -q wpx-firewall 2>/dev/null\nnft delete table inet wpx 2>/dev/null\nrm -f {d}/wpx-active\n",
        d = WPX_DIR
    );
    Tx { pre, mutate, undo: Some(undo), guard_min: 5, verify: true }
}

/// Перевести установку на домашнюю папку `home` (и службу — на неё): при
/// перезапуске и обновлении движка, не только при «Применить».
fn migrate() -> String {
    format!(
        "{}{}{}  systemctl daemon-reload\n",
        home_block(),
        write_file("/etc/systemd/system/wpx-engine.service", ENGINE_UNIT),
        write_file("/etc/systemd/system/wpx-firewall.service", FIREWALL_UNIT)
    )
}

fn tx_apply(staged: &Path, hash: &str, n: &NetSettings) -> Tx {
    let mutate = format!(
        "  cp -f {d}/config.yaml {d}/config.prev.yaml\n  cp -f {d}/rules.nft {d}/rules.prev.nft 2>/dev/null || true\n{config}  chmod 644 {d}/config.yaml\n{user}{eu}  systemctl daemon-reload\n{rules}{r}",
        d = WPX_DIR,
        config = copy_verified(&staged.to_string_lossy(), &format!("{WPX_DIR}/config.yaml"), hash, "E_CANDIDATE_CHANGED"),
        user = home_block(),
        eu = format!("{}{}", write_file("/etc/systemd/system/wpx-engine.service", ENGINE_UNIT), write_file("/etc/systemd/system/wpx-firewall.service", FIREWALL_UNIT)),
        rules = rules_block(n),
        r = restart_block(),
    );
    let pre = format!("  [ -f {d}/wpx-active ] || fail E_NOT_INSTALLED\n", d = WPX_DIR);
    // Откат: прежний конфиг; kill switch выключается — туннель не поднялся,
    // и без него ПК остался бы совсем без интернета.
    let off = NetSettings { kill_switch: false, ..n.clone() };
    let undo = format!(
        "cp -f {d}/config.prev.yaml {d}/config.yaml\ncat > {d}/rules.nft <<'WPX_EOF2'\n{rules}WPX_EOF2\nsystemctl restart wpx-firewall\nsystemctl restart wpx-engine\n",
        d = WPX_DIR,
        rules = nft_rules(&off),
    );
    Tx { pre, mutate, undo: Some(undo), guard_min: 4, verify: true }
}

/// `migrate` — перевод на папку `home` (см. migrate).
fn tx_restart(loc: &EngineLoc, migrate: &str) -> Tx {
    let mutate = match loc.kind {
        EngineKind::Wpx => format!("{migrate}{}", restart_block()),
        EngineKind::Missing => "  fail E_NOT_INSTALLED\n".into(),
    };
    Tx { pre: String::new(), mutate, undo: Some("systemctl restart wpx-engine\n".into()), guard_min: 3, verify: true }
}

fn tx_start() -> Tx {
    Tx {
        pre: format!("  [ -f {d}/wpx-active ] || fail E_NOT_INSTALLED\n", d = WPX_DIR),
        mutate: format!("  rm -f {d}/wpx-stopped\n  systemctl start wpx-engine\n", d = WPX_DIR),
        undo: None,
        guard_min: 0,
        verify: true,
    }
}

fn tx_stop() -> Tx {
    // Метка «остановлен вручную» — самовосстановление не будет поднимать движок.
    // Без kill switch блоки DNS и IPv6 уходят вместе с движком (старая служба
    // этого ещё не умеет — убираем сами).
    Tx {
        pre: String::new(),
        mutate: format!(
            "  touch {d}/wpx-stopped\n  systemctl stop wpx-engine\n  grep -q 'dport 67 return' {d}/rules.nft || nft delete table inet wpx 2>/dev/null || true\n",
            d = WPX_DIR
        ),
        undo: None,
        guard_min: 0,
        verify: false,
    }
}

fn tx_boot(on: bool) -> Tx {
    let mutate = if on {
        format!("  systemctl enable -q wpx-engine\n  echo 1 > {d}/wpx-boot\n", d = WPX_DIR)
    } else {
        format!("  systemctl disable -q wpx-engine\n  echo 0 > {d}/wpx-boot\n", d = WPX_DIR)
    };
    Tx { pre: String::new(), mutate, undo: None, guard_min: 0, verify: false }
}

fn tx_heal(on: bool) -> Tx {
    let mutate = if on {
        format!(
            "{}  chmod 700 {d}/watchdog.sh\n{units}  systemctl daemon-reload\n  systemctl enable --now -q wpx-watchdog.timer\n  echo 1 > {d}/wpx-heal\n",
            write_file(&format!("{WPX_DIR}/watchdog.sh"), WATCHDOG_SH),
            d = WPX_DIR,
            units = WATCHDOG_UNITS,
        )
    } else {
        format!("  systemctl disable --now -q wpx-watchdog.timer 2>/dev/null || true\n  echo 0 > {d}/wpx-heal\n", d = WPX_DIR)
    };
    Tx { pre: String::new(), mutate, undo: None, guard_min: 0, verify: false }
}

/// Движок останавливается на ~15 с: прямые подключения и DNS мимо туннеля
/// должны НЕ пройти. Первые звенья при включённом kill switch не проверяются:
/// root без метки движка kill switch не пропустит — проверка соврала бы.
fn tx_deep(n: &NetSettings, hops: &[(String, u16)]) -> Tx {
    let list: Vec<String> = hops.iter().map(|(s, p)| q(&format!("{s}:{p}"))).collect();
    let mutate = format!(
        r#"  systemctl stop wpx-engine; sleep 2
  P() {{ timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo true || echo false; }}
  d1=$(P 1.1.1.1 443); d2=$(P 8.8.8.8 443); v6=$(P 2606:4700:4700::1111 443)
  dns=false; if command -v dig >/dev/null; then dig +short +time=2 +tries=1 @8.8.8.8 example.com 2>/dev/null | grep -Eq '^[0-9]+([.][0-9]+){{3}}$' && dns=true; fi
  hops=''; px=null
  if [ {ks} = 0 ]; then
    for h in {list}; do s=${{h%:*}}; p=${{h##*:}}; ok=$(P "$s" "$p"); hops="$hops${{hops:+,}}{{\"s\":\"$s\",\"p\":$p,\"ok\":$ok}}"; [ "$ok" = true ] && px=true; done
    [ -n "$hops" ] && [ "$px" = null ] && px=false
  fi
  systemctl start wpx-engine
  printf '{{"direct1":%s,"direct2":%s,"ipv6":%s,"dns":%s,"proxy":%s,"hops":[%s]}}' "$d1" "$d2" "$v6" "$dns" "$px" "$hops" > "$INFOF"
"#,
        ks = if n.kill_switch { 1 } else { 0 },
        list = if list.is_empty() { "''".into() } else { list.join(" ") },
    );
    Tx { pre: String::new(), mutate, undo: Some("systemctl start wpx-engine\n".into()), guard_min: 3, verify: true }
}

fn tx_uninstall() -> Tx {
    let mutate = format!(
        "  for u in wpx-engine wpx-firewall wpx-watchdog.timer wpx-watchdog wpx-rollback.timer; do systemctl disable --now -q $u 2>/dev/null || true; done\n  nft delete table inet wpx 2>/dev/null || true\n  rm -f /etc/systemd/system/wpx-engine.service /etc/systemd/system/wpx-firewall.service /etc/systemd/system/wpx-watchdog.service /etc/systemd/system/wpx-watchdog.timer\n  systemctl daemon-reload\n  rm -rf {root}\n",
        root = WPX_ROOT
    );
    Tx { pre: String::new(), mutate, undo: None, guard_min: 0, verify: false }
}

fn tx_update_engine(src: &Path, sha: &str, migrate: &str) -> Tx {
    let mutate = format!(
        "  systemctl stop wpx-engine\n  cp -f {d}/mihomo {d}/mihomo.prev\n{copy}  chmod 755 {d}/mihomo\n{migrate}  systemctl start wpx-engine\n",
        d = WPX_DIR,
        copy = copy_verified(&src.to_string_lossy(), &format!("{WPX_DIR}/mihomo"), sha, "E_MIHOMO_HASH"),
    );
    let undo = format!("systemctl stop wpx-engine\ncp -f {d}/mihomo.prev {d}/mihomo\nsystemctl start wpx-engine\n", d = WPX_DIR);
    Tx { pre: String::new(), mutate, undo: Some(undo), guard_min: 4, verify: true }
}

// ─── Вход из mod.rs ──────────────────────────────────────────────

pub(super) fn install(staged: &Path, hash: &str, src: &Path, sha: &str, n: &NetSettings) -> ApplyResult {
    run(tx_install(staged, hash, src, sha, n))
}

pub(super) fn apply(staged: &Path, hash: &str, n: &NetSettings) -> ApplyResult {
    run(tx_apply(staged, hash, n))
}

pub(super) fn restart(loc: &EngineLoc) -> ApplyResult {
    run(tx_restart(loc, &migrate()))
}

pub(super) fn start(_loc: &EngineLoc) -> ApplyResult {
    run(tx_start())
}

pub(super) fn stop(_loc: &EngineLoc) -> ApplyResult {
    run(tx_stop())
}

pub(super) fn set_boot(on: bool) -> ApplyResult {
    run(tx_boot(on))
}

pub(super) fn set_heal(on: bool) -> ApplyResult {
    run(tx_heal(on))
}

pub(super) fn deep_test(_loc: &EngineLoc, hops: &[(String, u16)]) -> ApplyResult {
    run(tx_deep(&crate::engine::netcfg::load(), hops))
}

pub(super) fn uninstall() -> ApplyResult {
    run(tx_uninstall())
}

pub(super) fn update_engine(src: &Path, sha: &str) -> ApplyResult {
    run(tx_update_engine(src, sha, &migrate()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<(&'static str, Tx)> {
        let st = Path::new("/home/u/.local/share/wpx/staged/config.yaml");
        let src = Path::new("/usr/bin/wpx-mihomo");
        let ks = NetSettings { kill_switch: true, interface: "eth0".into(), ..NetSettings::default() };
        vec![
            ("install", tx_install(st, "AB", src, "CD", &ks)),
            ("apply", tx_apply(st, "AB", &ks)),
            ("restart", tx_restart(&config::wpx(), &migrate())),
            ("start", tx_start()),
            ("stop", tx_stop()),
            ("boot_on", tx_boot(true)),
            ("boot_off", tx_boot(false)),
            ("heal_on", tx_heal(true)),
            ("heal_off", tx_heal(false)),
            ("deep", tx_deep(&ks, &[("1.2.3.4".into(), 443)])),
            ("uninstall", tx_uninstall()),
            ("update_engine", tx_update_engine(src, "CD", &migrate())),
        ]
    }

    #[test]
    fn scripts_are_valid_bash() {
        // `bash -n` проверяет синтаксис, ничего не выполняя.
        for (name, tx) in all() {
            let s = script(&tx);
            let out = Command::new("bash").arg("-n").arg("-c").arg(&s).output().expect("bash");
            assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stderr));
            assert!(!s.contains("WPX_EOF\nWPX_EOF"), "{name}: пустой heredoc");
        }
    }

    #[test]
    fn nft_rules_shape() {
        let n = NetSettings { kill_switch: true, interface: "wlan0".into(), tun_device: "wpx".into(), ipv6: "tunnel".into(), ..NetSettings::default() };
        let r = nft_rules(&n);
        assert!(r.starts_with("table inet wpx\ndelete table inet wpx\n"));
        assert!(r.contains(&format!("meta mark {ROUTING_MARK} return")));
        assert!(r.contains("oifname \"wlan0\" meta nfproto ipv6 drop"));
        assert!(r.trim_end().ends_with("drop\n  }\n}") || r.contains("    drop\n  }"));
        let off = nft_rules(&NetSettings { kill_switch: false, ..n });
        assert!(!off.contains("    drop\n"));
    }

    /// Скрипты для проверки в контейнере с systemd: `WPX_T=<папка>` с
    /// `config.yaml` и `wpx-mihomo` → `install.sh`, `apply.sh`, `uninstall.sh`
    /// (без pkexec — запускать от root).
    #[test]
    #[ignore]
    fn dump_for_container() {
        use sha2::{Digest, Sha256};
        let dir = std::path::PathBuf::from(std::env::var("WPX_T").expect("WPX_T"));
        let h = |p: &Path| Sha256::digest(std::fs::read(p).unwrap()).iter().map(|b| format!("{b:02X}")).collect::<String>();
        let (cfg, bin) = (dir.join("config.yaml"), dir.join("wpx-mihomo"));
        let n = NetSettings { kill_switch: true, interface: "eth0".into(), tun_device: "wpx".into(), ipv6: "off".into(), ..NetSettings::default() };
        let w = |name: &str, tx: Tx| std::fs::write(dir.join(name), script(&tx)).unwrap();
        w("install.sh", tx_install(&cfg, &h(&cfg), &bin, &h(&bin), &n));
        w("apply.sh", tx_apply(&cfg, &h(&cfg), &NetSettings { kill_switch: false, ..n.clone() }));
        w("deep.sh", tx_deep(&n, &[]));
        w("uninstall.sh", tx_uninstall());
        w("bad.sh", tx_apply(&cfg, "0000", &n));
    }

    #[test]
    fn quoting() {
        assert_eq!(q("a'b"), r"'a'\''b'");
    }
}
