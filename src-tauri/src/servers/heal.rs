//! Самовосстановление на сервере: systemd-таймер раз в минуту проверяет службы wpx, поднимает
//! упавшие и ведёт журнал — wpx показывает его на карточке сервера и в «Где рвётся?».
//! Что проверять, скрипт берёт из конфигов на сервере, так что смена портов и
//! протоколов его не касается. Чужие контейнеры (AmneziaVPN и др.) не трогает.

use super::*;

/// /opt/wpx/heal.sh. Строка журнала: «время служба действие причина».
const SCRIPT: &str = r#"#!/bin/sh
W=/opt/wpx
LOG=$W/heal.log
now=$(date +%s)

note() { echo "$now $1 $2 $3" >> "$LOG"; }

# Записей «служба действие» за последний час.
count() { awk -v s="$1" -v a="$2" -v t=$((now - 3600)) '$1 >= t && $2 == s && $3 == a' "$LOG" 2>/dev/null | wc -l; }

# Пять перезапусков за час не помогли — до конца часа не трогаем (отметив это один раз).
tired() {
  [ "$(count "$1" fix)" -ge 5 ] || return 1
  [ "$(count "$1" giveup)" -gt 0 ] || note "$1" giveup often
}

fix() {
  svc=$1 why=$2
  shift 2
  tired "$svc" && return
  if "$@" >/dev/null 2>&1; then note "$svc" fix "$why"; else note "$svc" fail "$why"; fi
}

# Система убила процесс за нехватку памяти (последние 2 минуты).
oom() { journalctl -k --since -2min 2>/dev/null | grep -q "Killed process .*($1)"; }

# Запущен меньше 90 с назад — его сейчас ставит или перезапускает сам wpx.
fresh() { t=$(date -d "$1" +%s 2>/dev/null) && [ $((now - t)) -lt 90 ]; }

# Каждый порт кто-то слушает (TCP или UDP), иначе — «port».
listening() {
  for p in "$@"; do ss -Htuln "sport = :$p" | grep -q . || { echo port; return; }; done
}

# Проверки служб: печатают причину сбоя или ничего.
singbox_ok() { listening $(grep -o '"listen_port": *[0-9]*' $W/sing-box/config.json 2>/dev/null | grep -o '[0-9]*$'); }
xray_ok() { listening $(grep -o '"port": *[0-9]*' $W/xray/config.json 2>/dev/null | grep -o '[0-9]*$'); }
mtg_ok() { listening $(sed -n 's/^bind-to = ".*:\([0-9]*\)"$/\1/p' $W/mtg/config.toml 2>/dev/null); }
awg_ok() {
  p=$(sed -n 's/^ListenPort *= *//p' $W/awg/wg0.conf)
  if [ "$(docker exec wpx-awg awg show wg0 listen-port 2>/dev/null)" != "$p" ]; then echo iface
  elif command -v iptables >/dev/null && [ "$(iptables -t nat -S 2>/dev/null | grep -c -- "--dport $p -j DNAT")" = 0 ]; then echo nat
  fi
}
hop_ok() { nft list table inet wpx_hop >/dev/null 2>&1 || echo table; }

# Docker сам перезапустил контейнер (упал процесс) — тоже в журнал, с причиной.
restarts() {
  n=$(docker inspect -f '{{.RestartCount}}' "$1")
  was=$(sed -n "s/^$1 //p" $W/heal.seen 2>/dev/null)
  echo "$1 $n" >> $W/heal.seen.new
  [ -n "$was" ] && [ "$n" -gt "$was" ] || return 0
  if oom "$3"; then note "$2" restarted oom; else note "$2" restarted crash; fi
}

# Служба в контейнере: имя контейнера, служба, процесс, проверка.
box() {
  docker inspect "$1" >/dev/null 2>&1 || return 0
  restarts "$1" "$2" "$3"
  fresh "$(docker inspect -f '{{.State.StartedAt}}' "$1")" && return 0
  if [ "$(docker inspect -f '{{.State.Running}}' "$1")" = true ]; then why=$($4); else why=stopped; fi
  [ -n "$why" ] || return 0
  if [ "$why" != stopped ] && oom "$3"; then why=oom; fi
  fix "$2" "$why" docker restart -t 5 "$1"
}

# Служба на systemd: юнит, служба, проверка.
unit() {
  systemctl is-enabled --quiet "$1" 2>/dev/null || return 0
  fresh "$(systemctl show -p ActiveEnterTimestamp --value "$1")" && return 0
  if systemctl is-active --quiet "$1"; then why=$($3); else why=stopped; fi
  [ -z "$why" ] || fix "$2" "$why" systemctl restart "$1"
}

if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 || fix docker stopped systemctl start docker
  : > $W/heal.seen.new
  box wpx-singbox sing-box sing-box singbox_ok
  box wpx-xray xray xray xray_ok
  box wpx-mtg mtg mtg mtg_ok
  box wpx-awg awg amneziawg-go awg_ok
  mv $W/heal.seen.new $W/heal.seen
fi
unit wpx-singbox sing-box singbox_ok
unit wpx-hop hop hop_ok

# Журнал не растёт без конца.
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 500 ]; then tail -n 300 "$LOG" > "$LOG.new" && mv "$LOG.new" "$LOG"; fi
"#;

/// Скрипт — из stdin, таймер — раз в минуту (первый раз через 2 мин после загрузки).
const INSTALL: &str = r#"
[ -d /run/systemd/system ] || { echo HEAL-NO-SYSTEMD; exit 0; }
mkdir -p /opt/wpx
cat > /opt/wpx/heal.sh && chmod 700 /opt/wpx/heal.sh
cat > /etc/systemd/system/wpx-heal.service <<'UNIT'
[Unit]
Description=wpx: raise fallen VPN services
After=docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh /opt/wpx/heal.sh
UNIT
cat > /etc/systemd/system/wpx-heal.timer <<'UNIT'
[Unit]
Description=wpx: check VPN services every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now wpx-heal.timer >/dev/null 2>&1 && echo HEAL-ON
"#;

/// Включено ли самовосстановление и последние записи журнала: строки `heal_on=1` и `heal=…`.
pub(super) const READ: &str = r#"
systemctl is-enabled --quiet wpx-heal.timer 2>/dev/null && echo heal_on=1
tail -n 20 /opt/wpx/heal.log 2>/dev/null | sed 's/^/heal=/'
"#;

/// Запись журнала самовосстановления.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct HealEvent {
    /// Когда, мс.
    pub at: i64,
    /// Служба: «AmneziaWG», «sing-box»…
    pub svc: String,
    /// Что случилось и что сделано.
    pub what: String,
}

/// Включить или обновить самовосстановление. Не вышло — VPN это не мешает: только предупреждение.
pub(super) async fn install(c: &Conn, log: &Log) {
    match c.sh(&[], INSTALL, SCRIPT.as_bytes(), 60).await {
        Ok(o) if o.out.contains("HEAL-ON") => log("ok", "Самовосстановление на сервере: раз в минуту проверяет службы VPN и поднимает упавшие".into()),
        Ok(o) if o.out.contains("HEAL-NO-SYSTEMD") => log("warn", "Самовосстановление не включено: на сервере нет systemd".into()),
        Ok(o) => log("warn", format!("Самовосстановление не включено: {}", o.reason())),
        Err(e) => log("warn", format!("Самовосстановление не включено: {e}")),
    }
}

/// Строка журнала («1762884700 awg fix oom») → запись; незнакомое — мимо.
pub(super) fn parse(line: &str) -> Option<HealEvent> {
    let mut f = line.split_whitespace();
    let at = f.next()?.parse::<i64>().ok()? * 1000;
    let svc = match f.next()? {
        "sing-box" => "sing-box",
        "xray" => "Xray",
        "mtg" => "MTProxy",
        "awg" => "AmneziaWG",
        "hop" => "смена портов Hysteria2",
        "docker" => "Docker",
        _ => return None,
    };
    let what = match (f.next()?, f.next()?) {
        ("fix", "stopped") => "был остановлен — запустил",
        ("fix", "port") => "не слушал порт — перезапустил",
        ("fix", "iface") => "пропал интерфейс — перезапустил",
        ("fix", "oom") => "не хватило памяти — перезапустил",
        ("fix", "nat") => "пропало правило Docker для порта — перезапустил",
        ("fix", "table") => "пропали правила — вернул",
        ("restarted", "oom") => "не хватило памяти — Docker перезапустил",
        ("restarted", _) => "упал — Docker перезапустил",
        ("fail", _) => "упал, перезапустить не вышло",
        ("giveup", _) => "падает снова и снова — перезапуски отложены на час",
        _ => return None,
    };
    Some(HealEvent { at, svc: svc.into(), what: what.into() })
}

/// Для «Где рвётся?»: последнее за сутки и сколько всего, если что-то было.
pub(super) fn day(log: &[HealEvent]) -> Option<String> {
    let since = chrono::Utc::now().timestamp_millis() - 86_400_000;
    let recent: Vec<&HealEvent> = log.iter().filter(|e| e.at > since).collect();
    let last = recent.last()?;
    let time = chrono::DateTime::from_timestamp_millis(last.at)?.with_timezone(&chrono::Local).format("%H:%M");
    let text = format!("в {time} — {}: {}", last.svc, last.what);
    Some(if recent.len() > 1 { format!("за сутки: {} · {text}", recent.len()) } else { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_log() {
        let e = parse("1762884700 awg fix oom").unwrap();
        assert_eq!((e.at, e.svc.as_str(), e.what.as_str()), (1_762_884_700_000, "AmneziaWG", "не хватило памяти — перезапустил"));
        assert_eq!(parse("1762884700 xray restarted crash").unwrap().what, "упал — Docker перезапустил");
        assert!(parse("1762884700 amnezia-awg2 fix oom").is_none(), "чужое — мимо");
        assert!(parse("мусор").is_none());
    }

    #[test]
    fn sums_up_the_day() {
        let now = chrono::Utc::now().timestamp();
        let log: Vec<HealEvent> = [now - 90_000, now - 3600, now - 60].iter().filter_map(|t| parse(&format!("{t} awg fix oom"))).collect();
        let s = day(&log).unwrap();
        assert!(s.starts_with("за сутки: 2 · в ") && s.ends_with(" — AmneziaWG: не хватило памяти — перезапустил"), "{s}");
        assert_eq!(day(&log[..1]), None, "старше суток — не показываем");
    }
}
