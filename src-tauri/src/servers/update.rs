//! Обновление ядер на сервере кнопкой, с откатом: новая версия sing-box
//! (образ по digest или бинарник с sha256) и образ AmneziaWG. Не поднялась
//! новая — сервер сам возвращает прежнюю (образ или `sing-box.prev`).

use super::*;

/// Что отстаёт от версий, закреплённых в wpx: ("sb" | "awg", подпись).
pub fn pending(s: &Server) -> Vec<(&'static str, String)> {
    let Some(f) = &s.facts else { return vec![] };
    let mut out = vec![];
    let sb_used = s.vless.is_some() || s.hy2.is_some() || !s.pipes.is_empty();
    let sb_old = match s.runtime.as_str() {
        "docker" => !f.sb_img.is_empty() && f.sb_img != SB_IMAGE,
        "systemd" => !f.sb_ver.is_empty() && f.sb_ver != SB_VERSION,
        _ => false,
    };
    if sb_used && sb_old {
        out.push(("sb", format!("sing-box {} → {SB_VERSION}", if f.sb_ver.is_empty() { "?" } else { &f.sb_ver })));
    }
    if s.awg.is_some() && !f.awg_img.is_empty() && f.awg_img != AWG_IMAGE {
        out.push(("awg", format!("AmneziaWG → {AWG_VERSION}")));
    }
    out
}

/// sing-box в Docker: прежний образ запоминается, новый не поднялся — назад.
/// `BREAK=1` — проверка отката (новая версия считается не поднявшейся).
const SB_DOCKER: &str = r#"
set -u
old=$(docker inspect -f '{{.Image}}' wpx-singbox 2>/dev/null)
docker pull -q "$IMG" >/dev/null || { echo "не скачался образ sing-box" >&2; exit 3; }
sb_run "$IMG"; ok=0
for i in 1 2 3 4 5 6 7 8; do sleep 1; if sb_up && [ "${BREAK:-0}" != 1 ]; then ok=1; break; fi; done
[ $ok = 1 ] && { echo UPDATE-OK; exit 0; }
l=$(docker logs --tail 3 wpx-singbox 2>&1 | tr '\n' ' ')
[ -n "$old" ] || { echo "новая версия не поднялась: $l" >&2; exit 1; }
sb_run "$old"
for i in 1 2 3 4 5 6 7 8; do sleep 1; sb_up && { echo "ROLLED-BACK $l"; exit 0; }; done
echo "новая версия не поднялась, и прежняя тоже: $l" >&2; exit 1
"#;

/// sing-box бинарником: копия прежнего → новый (ENSURE_RUNTIME уже положил) →
/// перезапуск и проверка; не поднялся — прежний бинарник обратно.
const SB_SYSTEMD_BACKUP: &str = "cp -p /opt/wpx/bin/sing-box /opt/wpx/bin/sing-box.prev 2>/dev/null; echo BACKUP-OK\n";
const SB_SYSTEMD: &str = r#"
set -u
systemctl restart wpx-singbox; ok=0
for i in 1 2 3 4 5 6 7 8; do sleep 1; if sb_up && [ "${BREAK:-0}" != 1 ]; then ok=1; break; fi; done
[ $ok = 1 ] && { rm -f /opt/wpx/bin/sing-box.prev; echo UPDATE-OK; exit 0; }
l=$(journalctl -u wpx-singbox -n 3 --no-pager -o cat 2>/dev/null | tr '\n' ' ')
[ -f /opt/wpx/bin/sing-box.prev ] || { echo "новая версия не поднялась: $l" >&2; exit 1; }
mv /opt/wpx/bin/sing-box.prev /opt/wpx/bin/sing-box; systemctl restart wpx-singbox
for i in 1 2 3 4 5 6 7 8; do sleep 1; sb_up && { echo "ROLLED-BACK $l"; exit 0; }; done
echo "новая версия не поднялась, и прежняя тоже: $l" >&2; exit 1
"#;

const AWG_UPDATE: &str = r#"
set -u
old=$(docker inspect -f '{{.Image}}' wpx-awg 2>/dev/null)
docker pull -q "$AWG_IMG" >/dev/null || { echo "не скачался образ AmneziaWG" >&2; exit 3; }
awg_run "$AWG_IMG"; ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; if awg_up && [ "${BREAK:-0}" != 1 ]; then ok=1; break; fi; done
[ $ok = 1 ] && { echo UPDATE-OK; exit 0; }
l=$(docker logs --tail 3 wpx-awg 2>&1 | tr '\n' ' ')
[ -n "$old" ] || { echo "новая версия не поднялась: $l" >&2; exit 1; }
awg_run "$old"
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; awg_up && { echo "ROLLED-BACK $l"; exit 0; }; done
echo "новая версия не поднялась, и прежняя тоже: $l" >&2; exit 1
"#;

fn outcome(name: &str, o: &ssh::Output, log: &Log) -> Result<bool, String> {
    if o.code == 0 && o.out.contains("UPDATE-OK") {
        log("ok", format!("{name}: новая версия работает"));
        Ok(true)
    } else if o.code == 0 && o.out.contains("ROLLED-BACK") {
        log("warn", format!("{name}: новая версия не поднялась — вернул прежнюю, всё работает как было"));
        Ok(false)
    } else {
        Err(format!("{name}: {}", o.reason()))
    }
}

/// Обновить то, что отстаёт (или всё, если `force` — для проверки отката).
pub(super) async fn run(id: &str, test_rollback: bool, log: &Log) -> Result<ServersState, String> {
    let mut st = load();
    let mut s = st.servers.iter().find(|x| x.id == id).cloned().ok_or("сервер не найден")?;
    let c = open(&st, &s, log).await?;
    let r = async {
        s.facts = Some(inspect(&c).await?);
        let mut todo: Vec<&str> = pending(&s).into_iter().map(|(k, _)| k).collect();
        if test_rollback {
            // Проверка отката: «обновляем» до той же версии и считаем, что не поднялась.
            todo = [(s.vless.is_some() || s.hy2.is_some() || !s.pipes.is_empty()).then_some("sb"), s.awg.as_ref().map(|_| "awg")].into_iter().flatten().collect();
            log("warn", "Проверка отката: новая версия будет считаться не поднявшейся".into());
        }
        if todo.is_empty() {
            log("ok", format!("Обновлять нечего: sing-box {SB_VERSION}, AmneziaWG {AWG_VERSION}"));
            return Ok(());
        }
        let (tcp, udp) = our_ports(&s);
        let list = |v: &[u16]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");
        let brk = if test_rollback { "1" } else { "0" };
        if todo.contains(&"sb") {
            log("step", format!("sing-box → {SB_VERSION} (не поднимется — верну прежний)"));
            let mut env = rt_env(&s.runtime);
            env.extend([("TCP", list(&tcp)), ("UDP", list(&udp)), ("BREAK", brk.into())]);
            let o = if s.runtime == "docker" {
                c.sh(&env, &format!("{SB_FUNCS}{SB_DOCKER}"), b"", 300).await?
            } else {
                c.sh(&[], SB_SYSTEMD_BACKUP, b"", 30).await?;
                ensure_runtime(&c, &mut s, log).await?;
                c.sh(&env, &format!("{SB_FUNCS}{SB_SYSTEMD}"), b"", 120).await?
            };
            outcome("sing-box", &o, log)?;
        }
        if todo.contains(&"awg") {
            let a = s.awg.clone().ok_or("нет AmneziaWG")?;
            log("step", format!("AmneziaWG → {AWG_VERSION} (не поднимется — верну прежний образ)"));
            let o = c.sh(&[("AWG_IMG", AWG_IMAGE.into()), ("PORT", a.port.to_string()), ("BREAK", brk.into())], &format!("{AWG_FUNCS}{AWG_UPDATE}"), b"", 300).await?;
            outcome("AmneziaWG", &o, log)?;
        }
        if let Ok(f) = inspect(&c).await {
            s.facts = Some(f);
        }
        Ok::<(), String>(())
    }
    .await;
    c.close().await;
    r?;
    if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) {
        *x = s;
    }
    save(&st)?;
    Ok(state(&st))
}

#[tauri::command]
pub async fn server_update(app: AppHandle, id: String) -> Result<ServersState, String> {
    let _g = BUSY.try_lock().map_err(|_| "Уже идёт операция с сервером")?;
    let log = logger(&app);
    let r = run(&id, false, &log).await;
    if let Err(e) = &r {
        log("fail", e.clone());
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_compares_with_pinned() {
        let mut s = Server { runtime: "docker".into(), vless: Some(Vless { port: 443, dest: "d".into(), public_key: "k".into(), short_id: "s".into() }), ..Default::default() };
        s.awg = Some(Awg { port: 1, server_public: "k".into(), obf: vec![] });
        s.facts = Some(Facts { sb_ver: "1.14.3".into(), sb_img: "ghcr.io/sagernet/sing-box@sha256:old".into(), awg_img: AWG_IMAGE.into(), ..Default::default() });
        assert_eq!(pending(&s), vec![("sb", format!("sing-box 1.14.3 → {SB_VERSION}"))]);
        s.facts = Some(Facts { sb_ver: SB_VERSION.into(), sb_img: SB_IMAGE.into(), awg_img: "amneziavpn/amneziawg-go:old".into(), ..Default::default() });
        assert_eq!(pending(&s), vec![("awg", format!("AmneziaWG → {AWG_VERSION}"))]);
        s.runtime = "systemd".into();
        s.facts = Some(Facts { sb_ver: "1.13.0".into(), ..Default::default() });
        assert_eq!(pending(&s).len(), 1);
    }
}
