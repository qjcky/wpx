//! Windows: транзакции на PowerShell. Окно UAC → скрипт (аргументом, base64,
//! без файла) → страховочная задача SYSTEM `wpx-rollback`.
//! Движок — задача Планировщика `wpx-engine` от SYSTEM, kill switch — правила
//! брандмауэра Windows. Скрипты — ASCII-only: PowerShell 5.1 иначе путается в
//! кодировках.

use base64::Engine as _;
use std::path::Path;
use std::process::Command;

use super::ApplyResult;
use crate::config::{self, EngineKind, EngineLoc, WPX_DIR, WPX_ROOT};
use crate::engine::netcfg::NetSettings;
use crate::platform::Hidden;

fn ps_quote(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => format!("{c}{c}"),
            _ => c.to_string(),
        })
        .collect()
}

/// Скрипт строкой base64 (UTF-8; скрипты ASCII — тест) и команда, которая его
/// выполнит: вдвое короче `-EncodedCommand` (UTF-16) на каждом слое — команда
/// с вложенным откатом не упрётся в лимит Windows 32 767 символов.
fn b64(script: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(script.as_bytes())
}

/// Запуск окна UAC: скрипт с правами — аргументом, файлом его не подменить.
fn launcher(script: &str) -> String {
    format!(
        "try {{ $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''{}'')))'; exit $p.ExitCode }} catch {{ exit 1223 }}",
        b64(script)
    )
}

fn user_sid() -> Result<String, String> {
    let out = Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .hidden()
        .output()
        .map_err(|e| e.to_string())?;
    let t = String::from_utf8_lossy(&out.stdout);
    t.split(',')
        .nth(1)
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| s.starts_with("S-1-") && s.chars().all(|c| c.is_ascii_digit() || c == '-' || c == 'S'))
        .ok_or_else(|| "не удалось узнать SID пользователя".into())
}

/// Адаптеры для блокировок мимо туннеля (IPv6, прямой DNS): выбранный и все
/// включённые физические — ПК с Wi-Fi и кабелем сразу не утекает через второй.
/// Имена проверенные: уходят в скрипт администратора.
fn adapters(primary: &str) -> Vec<String> {
    let mut v: Vec<String> = crate::platform::physical_adapters().into_iter().filter(|a| crate::engine::netcfg::valid_iface(a)).collect();
    if !primary.is_empty() && !v.iter().any(|a| a == primary) {
        v.insert(0, primary.to_string());
    }
    v
}

/// Список адаптеров для `-InterfaceAlias`: 'A','B'.
fn alias_list(ifaces: &[String]) -> String {
    ifaces.iter().map(|a| format!("'{}'", ps_quote(a))).collect::<Vec<_>>().join(",")
}

/// Команда задачи движка: домашняя папка mihomo — `home`, конфиг и exe — выше.
fn engine_args() -> String {
    format!(
        "/v:on /c chcp 65001 >nul & {on} & {d}\\mihomo.exe -d {d}\\home -f {d}\\config.yaml >> {d}\\engine.log 2>&1 & set rc=!errorlevel! & {off} & exit !rc!",
        d = WPX_DIR,
        on = fw_switch(true),
        off = fw_off_unless_ks(),
    )
}

/// Блок прямого DNS и IPv6 (группа правил `wpx`) — включить или выключить.
fn fw_switch(on: bool) -> String {
    format!("netsh advfirewall firewall set rule group=\"wpx\" new enable={} >nul 2>&1", if on { "yes" } else { "no" })
}

/// Без kill switch блоки DNS и IPv6 действуют, только пока работает движок:
/// он остановлен (вручную, сбой, не запущен после загрузки) — у ПК обычный
/// интернет, а не «сайты не открываются». С kill switch (`ks-prev.json`) —
/// остаются: мимо туннеля не уходит ничего.
fn fw_off_unless_ks() -> String {
    // В скобках: иначе `& exit` после `if` выполнялся бы только при условии.
    format!("(if not exist {d}\\ks-prev.json {})", fw_switch(false), d = WPX_DIR)
}

/// Домашняя папка mihomo (`home`): пишет туда только он сам (SYSTEM). Папок с
/// записью для пользователя внутри быть не должно — mihomo проверяет пути
/// лишь по тексту, и ссылка в такой папке пустила бы его запись куда угодно;
/// поэтому прежние папки правил убираем (ссылку — как ссылку), а кэш
/// скачанных списков (его писал SYSTEM) переносим.
fn home_block() -> String {
    format!(
        r#"  $h = '{d}\home'
  $i = Get-Item -LiteralPath $h -Force -ErrorAction SilentlyContinue
  if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ throw 'E_WPX_DIR_LINK' }}
  New-Item -ItemType Directory -Force -Path $h | Out-Null
  # The downloaded lists cache (written by SYSTEM, admin-only) moves along.
  $r = '{d}\rules'; $i = Get-Item -LiteralPath $r -Force -ErrorAction SilentlyContinue
  if ($i -and -not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not (Test-Path -LiteralPath "$h\rules")) {{
    try {{ Move-Item -LiteralPath $r -Destination "$h\rules" }} catch {{}}
  }}
  # No user-writable folder may stay inside the engine: links there would let mihomo write anywhere.
  foreach ($p in "$h\user", '{d}\user', '{d}\rules') {{
    $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ [IO.Directory]::Delete($p) }} elseif ($i) {{ & cmd.exe /c rmdir /s /q "$p" }}
  }}
"#,
        d = WPX_DIR,
    )
}

/// Перевести установку на домашнюю папку `home` (и задачу — на неё): при
/// перезапуске и обновлении движка, не только при «Применить».
fn migrate() -> String {
    // Установка без автозапуска (выключили ещё прежней версией) — задача,
    // снимающая блоки DNS и IPv6 при загрузке ПК, нужна и ей.
    format!(
        "{}{}  if ((Get-Content -LiteralPath '{d}\\wpx-boot' -ErrorAction SilentlyContinue) -eq '0') {{\n{}  }}\n",
        home_block(),
        retask(),
        fw_boot_task(),
        d = WPX_DIR
    )
}

/// Блок прямого DNS мимо туннеля — на всех адаптерах из списка; пусто —
/// оставляем прежний (адаптер не определился).
fn dns_rules(ifaces: &[String]) -> String {
    if ifaces.is_empty() {
        return String::new();
    }
    format!(
        "  foreach ($p in 'TCP','UDP') {{\n    Remove-NetFirewallRule -Name \"WPX-Block-DNS-$p\" -ErrorAction SilentlyContinue\n    New-NetFirewallRule -Name \"WPX-Block-DNS-$p\" -DisplayName \"wpx: block direct DNS $p\" -Group wpx -Direction Outbound -Action Block -Protocol $p -RemotePort 53,853 -InterfaceAlias {} | Out-Null\n  }}\n",
        alias_list(ifaces)
    )
}

/// Задаче движка — новая команда (домашняя папка `home`); триггеры и
/// учётная запись остаются прежними.
fn retask() -> String {
    format!(
        "  $t = Get-ScheduledTask -TaskName wpx-engine -ErrorAction SilentlyContinue\n  if ($t -and $t.Actions[0].Arguments -ne '{a}') {{ $t.Actions[0].Arguments = '{a}'; Set-ScheduledTask -InputObject $t | Out-Null }}\n",
        a = ps_quote(&engine_args())
    )
}

// ─── Самовосстановление ──────────────────────────────────────────

/// Сторож: задача SYSTEM `wpx-watchdog`, раз в минуту. Лежит в папке движка
/// (пользователю только чтение — подменить нельзя). Журнал — heal.log.
/// Перезапускает движок, только если туннель лежит, а прокси отвечает
/// напрямую (иначе перезапуск не поможет); не чаще раза в 5 минут; не
/// трогает движок, остановленный вручную (wpx-stopped) или во время
/// операции wpx (wpx-maint).
const WATCHDOG_PS: &str = r#"$ErrorActionPreference='SilentlyContinue'
$d='C:\ProgramData\wpx\engine'
if (-not (Test-Path "$d\wpx-active")) { exit }
if (Test-Path "$d\wpx-stopped") { exit }
$mt = Get-Item -LiteralPath "$d\wpx-maint"
if ($mt -and ((Get-Date) - $mt.LastWriteTime).TotalMinutes -lt 6) { exit }
$log = "$d\heal.log"
$lg = Get-Item -LiteralPath $log
if ($lg -and $lg.Length -gt 200KB) { Move-Item -LiteralPath $log -Destination "$log.old" -Force }
function W($a, $b) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + '|' + $a + '|' + $b) -Encoding ASCII }
function Restart-Engine {
  Stop-ScheduledTask -TaskName wpx-engine
  Get-Process mihomo | Where-Object { $_.Path -eq 'C:\ProgramData\wpx\engine\mihomo.exe' } | Stop-Process -Force
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName wpx-engine
  Set-Content -LiteralPath "$d\heal.last" -Value (Get-Date).ToString('o') -Encoding ASCII
}
$last = Get-Content -LiteralPath "$d\heal.last"
$cool = $false
if ($last) { try { $cool = ((Get-Date) - [datetime]$last).TotalMinutes -lt 5 } catch {} }
if (-not (Get-Process mihomo | Where-Object { $_.Path -eq 'C:\ProgramData\wpx\engine\mihomo.exe' })) {
  $boot = Get-Content -LiteralPath "$d\wpx-boot"
  if ($boot -eq '0' -or $cool) { exit }
  W 'start' 'engine not running'
  Restart-Engine
  exit
}
function T { $c = & curl.exe --noproxy '*' -s -o NUL -m 8 -w '%{http_code}' http://www.gstatic.com/generate_204; return ($c -eq '204') }
if (T) { exit }
Start-Sleep -Seconds 5; if (T) { exit }
Start-Sleep -Seconds 10; if (T) { exit }
$cfg = Get-Content -LiteralPath "$d\config.yaml" -Raw | ConvertFrom-Json
$ok = $false; $udp = $false
foreach ($p in $cfg.proxies) {
  # Cascade hops behind an entry cannot be reached directly; UDP protocols
  # (Hysteria2, AWG) are invisible to a TCP check - treat as unknown, allow restart.
  if ($p.'dialer-proxy') { continue }
  if (@('hysteria2', 'wireguard', 'tuic') -contains [string]$p.type) { $udp = $true; continue }
  $c = [Net.Sockets.TcpClient]::new()
  try { if ($c.ConnectAsync([string]$p.server, [int]$p.port).Wait(4000) -and $c.Connected) { $ok = $true } } catch {} finally { $c.Dispose() }
  if ($ok) { break }
}
if (-not $ok -and -not $udp) { W 'skip' 'proxy unreachable'; exit }
if ($cool) { W 'skip' 'cooldown'; exit }
W 'restart' 'tunnel down, proxy ok'
Restart-Engine
"#;

fn tx_heal(on: bool) -> Tx {
    let mutate = if on {
        format!(
            r#"  $wd='{d}'
  [IO.File]::WriteAllText("$wd\watchdog.ps1", [Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('{b64}')), [Text.Encoding]::ASCII)
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $wd\watchdog.ps1"
  $t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $t2 = New-ScheduledTaskTrigger -AtStartup; $t2.Delay = 'PT2M'; $t2.Repetition = $t1.Repetition
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew -StartWhenAvailable
  $pr = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName wpx-watchdog -Action $act -Trigger @($t1, $t2) -Settings $set -Principal $pr -Force | Out-Null
  Set-Content -LiteralPath "$wd\wpx-heal" -Value '1' -Encoding ASCII
"#,
            d = WPX_DIR,
            b64 = base64::engine::general_purpose::STANDARD.encode(WATCHDOG_PS.as_bytes()),
        )
    } else {
        format!(
            "  Unregister-ScheduledTask -TaskName wpx-watchdog -Confirm:$false -ErrorAction SilentlyContinue\n  Set-Content -LiteralPath '{d}\\wpx-heal' -Value '0' -Encoding ASCII\n",
            d = WPX_DIR
        )
    };
    Tx {
        pre: format!("  if (-not (Test-Path '{d}\\wpx-active')) {{ throw 'E_NOT_WPX' }}\n", d = WPX_DIR),
        mutate,
        undo: None,
        guard_min: 0,
        verify: false,
        log: None,
    }
}

pub(super) fn set_heal(on: bool) -> ApplyResult {
    run(tx_heal(on))
}

// ─── Транзакция ──────────────────────────────────────────────────

const PS_KM: &str = "function KM { Get-Process mihomo -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq 'C:\\ProgramData\\wpx\\engine\\mihomo.exe' } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 }\n";
const PS_UNARM: &str = "Unregister-ScheduledTask -TaskName wpx-rollback -Confirm:$false -ErrorAction SilentlyContinue\n";

struct Tx {
    /// Проверки до изменений (бросают — ничего не тронуто).
    pre: String,
    /// Изменения.
    mutate: String,
    /// Самодостаточный скрипт отмены (None — без страховки).
    undo: Option<String>,
    /// Минут до срабатывания страховки.
    guard_min: u32,
    /// Проверять туннель после изменений.
    verify: bool,
    /// Журнал движка — его хвост попадёт в сообщение, если туннель не поднимется.
    log: Option<String>,
}

fn log_of(loc: &EngineLoc) -> Option<String> {
    Some(loc.log().to_string_lossy().into_owned())
}

fn restart_block(loc: &EngineLoc) -> String {
    match loc.kind {
        EngineKind::Wpx => format!(
            "Remove-Item -LiteralPath '{d}\\wpx-stopped' -Force -ErrorAction SilentlyContinue\n\
             Stop-ScheduledTask -TaskName wpx-engine -ErrorAction SilentlyContinue; KM\n\
             $l='{d}\\engine.log'; if ((Test-Path $l) -and ((Get-Item $l).Length -gt 5MB)) {{ Move-Item -LiteralPath $l -Destination \"$l.old\" -Force }}\n\
             Start-ScheduledTask -TaskName wpx-engine\n",
            d = WPX_DIR
        ),
        EngineKind::Missing => "throw 'E_NOT_INSTALLED'\n".into(),
    }
}

fn undo_script(body: &str) -> String {
    format!("$ErrorActionPreference='Continue'\n{PS_KM}{body}{PS_UNARM}")
}

fn script(tx: &Tx, result: &Path) -> String {
    let undo_enc = tx.undo.as_deref().map(b64).unwrap_or_default();
    let guarded = if tx.undo.is_some() { "$true" } else { "$false" };
    let verify = if tx.verify { "$true" } else { "$false" };
    format!(
        r#"$ErrorActionPreference='Stop'
$res='{res}'
# The result goes to the user's folder, where anyone can plant a link: drop what is
# there and write only a new file (CreateNew never writes into an existing one).
function Done($s) {{
  Remove-Item -LiteralPath $res -Force -ErrorAction SilentlyContinue
  try {{ $f = [IO.File]::Open($res, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write); $b = [Text.Encoding]::UTF8.GetBytes($s); $f.Write($b, 0, $b.Length); $f.Close() }} catch {{}}
}}
{km}function TestTunnel {{
  for ($i=0; $i -lt 20; $i++) {{
    Start-Sleep -Seconds 3
    # mihomo died right away - no point waiting a minute with no internet
    if ($i -ge 3 -and -not (Get-Process mihomo -ErrorAction SilentlyContinue)) {{ return $false }}
    $c = & curl.exe --noproxy '*' -s -o NUL -m 6 -w '%{{http_code}}' http://www.gstatic.com/generate_204
    if ($c -eq '204') {{ return $true }}
  }}
  return $false
}}
function LogTail {{
  $p = '{log}'
  if ($p -eq '') {{ return '' }}
  return (@(Get-Content -LiteralPath $p -Tail 3 -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' / ')
}}
$undoEnc='{undo}'
$undoCmd = "iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$undoEnc')))"
function Undo {{ & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $undoCmd | Out-Null }}
$guarded={guarded}; $armed=$false; $changed=$false; $info=''; $out='OK'; $msg=''
# The watchdog keeps out while an operation runs.
$wd='{wd}'
if (Test-Path $wd) {{ Set-Content -LiteralPath "$wd\wpx-maint" -Value 'op' -Encoding ASCII -ErrorAction SilentlyContinue }}
try {{
{pre}
  if ($guarded) {{
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$undoCmd`""
    Register-ScheduledTask -TaskName wpx-rollback -Action $act -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes({gmin})) -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    $armed=$true
  }}
  $changed=$true
{mutate}
  if ({verify}) {{
    if (-not (TestTunnel)) {{
      $msg = 'LOG:' + (LogTail)
      if ($guarded) {{ Undo; $out='ROLLEDBACK' }} else {{ $out='NOTUNNEL' }}
    }}
  }}
  if ($armed) {{ {unarm} }}
  Done "$out|$info|$msg"
}} catch {{
  $m = $_.Exception.Message
  if ($changed -and $guarded) {{ try {{ Undo }} catch {{}}; Done "ROLLEDBACK|$info|$m" }} else {{ Done "ERR|$info|$m" }}
  if ($armed) {{ {unarm} }}
}}
Remove-Item -LiteralPath "$wd\wpx-maint" -Force -ErrorAction SilentlyContinue
"#,
        res = ps_quote(&result.to_string_lossy()),
        km = PS_KM,
        undo = undo_enc,
        guarded = guarded,
        gmin = tx.guard_min.max(2),
        pre = tx.pre,
        mutate = tx.mutate,
        verify = verify,
        unarm = PS_UNARM.trim(),
        log = ps_quote(tx.log.as_deref().unwrap_or("")),
        wd = WPX_DIR,
    )
}

/// Одно окно UAC → скрипт → разбор итога.
fn run(tx: Tx) -> ApplyResult {
    if config::LAB {
        return ApplyResult::fail(super::LAB_OFF);
    }
    let result = config::data_dir().join("op-result.txt");
    let _ = std::fs::remove_file(&result);
    let launcher = launcher(&script(&tx, &result));
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &launcher])
        .hidden()
        .status();
    let text = std::fs::read_to_string(&result).unwrap_or_default();
    super::outcome(text.trim_start_matches('\u{feff}'), matches!(status, Ok(s) if s.code() == Some(1223)))
}

// ─── Сборка транзакций (чистые функции — их скрипты проверяет тест) ──

fn hash_check(path: &Path, hash: &str) -> String {
    format!(
        "  if ((Get-FileHash -LiteralPath '{p}' -Algorithm SHA256).Hash -ne '{hash}') {{ throw 'E_CANDIDATE_CHANGED' }}\n",
        p = ps_quote(&path.to_string_lossy())
    )
}

/// Установка движка: папка с правами (SYSTEM и администраторы — запись,
/// пользователь — чтение), mihomo из поставки, конфиг, правила kill switch,
/// задача SYSTEM `wpx-engine` (старт при включении ПК, перезапуск при падении).
fn tx_install(staged: &Path, hash: &str, sid: &str, src: &Path, sha: &str, ifaces: &[String]) -> Tx {
    let pre = format!(
        "  $src='{src}'; if (-not (Test-Path -LiteralPath $src) -and -not (Test-Path '{d}\\mihomo.exe')) {{ throw 'E_NO_MIHOMO' }}\n{hc}",
        src = ps_quote(&src.to_string_lossy()),
        d = WPX_DIR,
        hc = hash_check(staged, hash),
    );
    let mutate = format!(
        r#"  $root='{root}'; $dst='{d}'
  # ProgramData lets any user create folders: a folder made by someone else (or a link)
  # is not trusted - move it aside and create ours already locked, in one call.
  $it = Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
  if ($it) {{
    $bad = [bool]($it.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if (-not $bad) {{ $own = (Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value; $bad = ($own -ne 'S-1-5-18') -and ($own -ne 'S-1-5-32-544') }}
    if ($bad) {{ Rename-Item -LiteralPath $root -NewName ('wpx.untrusted-' + (Get-Date -Format 'yyyyMMddHHmmss')); $it = $null }}
  }}
  if (-not $it) {{
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetSecurityDescriptorSddlForm('O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;{sid})')
    [IO.Directory]::CreateDirectory($root, $sec) | Out-Null
    # The path could be taken between the check and the call: make sure it is ours.
    $it = Get-Item -LiteralPath $root -Force
    $own = (Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (($own -ne 'S-1-5-18') -and ($own -ne 'S-1-5-32-544'))) {{ throw 'E_WPX_DIR_LINK' }}
  }}
  $i = Get-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
  if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ throw 'E_WPX_DIR_LINK' }}
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  # ACL on the root only; everything inside inherits it. (Applying the same
  # grant with /T strips files of all access - that broke the first attempt.)
  & icacls.exe '{root}' /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*{sid}:(OI)(CI)RX' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) {{ throw 'E_ACL' }}
  & icacls.exe '{root}' /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  & icacls.exe '{root}\*' /reset /T /C /Q | Out-Null
{copy_mihomo}{copy_config}{home}  Remove-Item -LiteralPath "$dst\engine.log" -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$dst\wpx-stopped" -Force -ErrorAction SilentlyContinue
  if (@(Get-NetFirewallRule -Group wpx -ErrorAction SilentlyContinue).Count -eq 0) {{
    # Leftovers of an interrupted earlier attempt (WPX-* outside group wpx).
    Get-NetFirewallRule -Name 'WPX-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name 'WPX-Block-IPv6' -DisplayName 'wpx: block IPv6' -Group wpx -Direction Outbound -Action Block -RemoteAddress '::/1','8000::/1' | Out-Null
{dns}    # Rules made by this install: the rollback removes them (or DNS and IPv6 stay blocked).
    Set-Content -LiteralPath "$dst\fw-created" -Value '1' -Encoding ASCII
  }}
  $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '{args}' -WorkingDirectory $dst
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
  $pr = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName wpx-engine -Action $act -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $set -Principal $pr -Force | Out-Null
  Set-Content -LiteralPath "$dst\wpx-boot" -Value '1' -Encoding ASCII
  Unregister-ScheduledTask -TaskName wpx-fw-boot -Confirm:$false -ErrorAction SilentlyContinue
  KM
  Set-Content -LiteralPath "$dst\wpx-active" -Value 'wpx' -Encoding ASCII
  Start-ScheduledTask -TaskName wpx-engine
"#,
        d = WPX_DIR,
        root = WPX_ROOT,
        sid = sid,
        dns = dns_rules(ifaces),
        args = ps_quote(&engine_args()),
        home = home_block(),
        copy_mihomo = copy_verified(&src.to_string_lossy(), &format!("{WPX_DIR}\\mihomo.exe"), sha, "E_MIHOMO_HASH"),
        copy_config = copy_verified(&staged.to_string_lossy(), &format!("{WPX_DIR}\\config.yaml"), hash, "E_CANDIDATE_CHANGED"),
    );
    let undo = undo_script(&format!(
        "Stop-ScheduledTask -TaskName wpx-engine -ErrorAction SilentlyContinue; KM\n\
         Unregister-ScheduledTask -TaskName wpx-engine -Confirm:$false -ErrorAction SilentlyContinue\n\
         Remove-Item -LiteralPath '{d}\\wpx-active' -Force -ErrorAction SilentlyContinue\n\
         if (Test-Path '{d}\\fw-created') {{ Get-NetFirewallRule -Group wpx -ErrorAction SilentlyContinue | Remove-NetFirewallRule; Remove-Item -LiteralPath '{d}\\fw-created' -Force }}\n",
        d = WPX_DIR
    ));
    Tx { pre, mutate, undo: Some(undo), guard_min: 5, verify: true, log: log_of(&config::wpx()) }
}

/// Правило «IPv6 мимо туннеля закрыт»: везде или только на физическом
/// адаптере (IPv6 идёт через туннель, `::1` и TUN не трогаем).
fn ipv6_rule(ifaces: Option<&[String]>) -> String {
    let only = ifaces.filter(|v| !v.is_empty()).map(|v| format!(" -InterfaceAlias {}", alias_list(v))).unwrap_or_default();
    format!(
        "  Remove-NetFirewallRule -Name 'WPX-Block-IPv6' -ErrorAction SilentlyContinue\n  New-NetFirewallRule -Name 'WPX-Block-IPv6' -DisplayName 'wpx: block IPv6' -Group wpx -Direction Outbound -Action Block -RemoteAddress '::/1','8000::/1'{only} | Out-Null\n"
    )
}

/// Kill switch в брандмауэре Windows: исходящие по умолчанию — запрет; своя
/// группа разрешений `wpx-ks`: движок, сам wpx (SSH к серверам, проверки мимо
/// туннеля), песочница, адаптер туннеля, локальная сеть, DHCP и NDP. Прежние
/// умолчания профилей запоминаются и возвращаются при выключении.
fn kill_switch(n: &NetSettings) -> String {
    let off = format!(
        "  if (Test-Path '{d}\\ks-prev.json') {{ foreach ($p in (Get-Content '{d}\\ks-prev.json' -Raw | ConvertFrom-Json)) {{ Set-NetFirewallProfile -Name $p.Name -DefaultOutboundAction $p.A }}; Remove-Item -LiteralPath '{d}\\ks-prev.json' -Force }}\n  Get-NetFirewallRule -Group 'wpx-ks' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n",
        d = WPX_DIR
    );
    if !n.kill_switch {
        return off;
    }
    let q = |p: &Path| ps_quote(&p.to_string_lossy());
    let app = std::env::current_exe().unwrap_or_default();
    let probe = crate::config::data_dir().join("sandbox").join("wpx-probe.exe");
    let trial = crate::config::data_dir().join("trial").join("wpx-trial.exe");
    let lan: Vec<String> = std::iter::once("LocalSubnet".to_string()).chain(n.lan.iter().map(|c| format!("'{}'", ps_quote(c)))).collect();
    let allow = |name: &str, args: String| format!("  New-NetFirewallRule -Name 'WPX-KS-{name}' -DisplayName 'wpx kill switch: {name}' -Group 'wpx-ks' -Direction Outbound -Action Allow {args} | Out-Null\n");
    format!(
        "  Get-NetFirewallRule -Group 'wpx-ks' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n{}{}{}{}{}{}{}{}{}  if (-not (Test-Path '{d}\\ks-prev.json')) {{ Get-NetFirewallProfile | Select-Object Name, @{{n='A';e={{\"$($_.DefaultOutboundAction)\"}}}} | ConvertTo-Json | Set-Content -LiteralPath '{d}\\ks-prev.json' -Encoding UTF8 }}\n  Set-NetFirewallProfile -All -DefaultOutboundAction Block\n",
        allow("Engine", format!("-Program '{d}\\mihomo.exe'", d = WPX_DIR)),
        allow("App", format!("-Program '{}'", q(&app))),
        allow("Probe", format!("-Program '{}'", q(&probe))),
        allow("Trial", format!("-Program '{}'", q(&trial))),
        allow("Tunnel", format!("-InterfaceAlias '{}'", ps_quote(&n.tun_device))),
        allow("LAN", format!("-RemoteAddress {}", lan.join(","))),
        allow("DHCP", "-Protocol UDP -LocalPort 68 -RemotePort 67".into()),
        allow("DHCPv6", "-Protocol UDP -LocalPort 546 -RemotePort 547".into()),
        allow("NDP", "-Protocol ICMPv6".into()),
        d = WPX_DIR
    )
}

fn tx_apply(staged: &Path, hash: &str, n: &NetSettings, ifaces: &[String]) -> Tx {
    let v6_iface = (n.ipv6 == "tunnel").then_some(ifaces);
    let wpx = config::wpx();
    let pre = format!("  if (-not (Test-Path '{d}\\wpx-active')) {{ throw 'E_NOT_WPX' }}\n{hc}", d = WPX_DIR, hc = hash_check(staged, hash));
    // Папка правил «найденного на лету»: пользователю запись (wpx дописывает
    // без окна Windows), файлы — из настроек, а не из папки пользователя.
    let home = home_block();
    let mutate = format!(
        "  Copy-Item -LiteralPath '{d}\\config.yaml' -Destination '{d}\\config.prev.yaml' -Force\n{copy}{home}{task}{v6}{dns}{ks}{r}",
        d = WPX_DIR,
        copy = copy_verified(&staged.to_string_lossy(), &format!("{WPX_DIR}\\config.yaml"), hash, "E_CANDIDATE_CHANGED"),
        task = retask(),
        v6 = ipv6_rule(v6_iface),
        dns = dns_rules(ifaces),
        ks = kill_switch(n),
        r = restart_block(&wpx)
    );
    // Откат — IPv6 закрыт везде; kill switch выключается: туннель не поднялся,
    // и без него ПК остался бы совсем без интернета.
    let undo = undo_script(&format!(
        "Copy-Item -LiteralPath '{d}\\config.prev.yaml' -Destination '{d}\\config.yaml' -Force\n{v6}{ks}{r}",
        d = WPX_DIR,
        v6 = ipv6_rule(None),
        ks = kill_switch(&NetSettings { kill_switch: false, ..n.clone() }),
        r = restart_block(&wpx)
    ));
    Tx { pre, mutate, undo: Some(undo), guard_min: 4, verify: true, log: log_of(&wpx) }
}

/// `migrate` — перевод на папку `home` (см. migrate), у чужого движка пусто.
fn tx_restart(loc: &EngineLoc, migrate: &str) -> Tx {
    let undo = undo_script(&format!("KM\nStart-ScheduledTask -TaskName {t} -ErrorAction SilentlyContinue\n", t = loc.task));
    Tx { pre: String::new(), mutate: format!("{migrate}{}", restart_block(loc)), undo: Some(undo), guard_min: 3, verify: true, log: log_of(loc) }
}

fn tx_start(loc: &EngineLoc) -> Tx {
    Tx {
        pre: format!("  if (-not (Get-ScheduledTask -TaskName {t} -ErrorAction SilentlyContinue)) {{ throw 'E_TASK_MISSING' }}\n", t = loc.task),
        mutate: format!(
            "  Remove-Item -LiteralPath '{d}\\wpx-stopped' -Force -ErrorAction SilentlyContinue\n  Enable-ScheduledTask -TaskName {t} | Out-Null\n  Start-ScheduledTask -TaskName {t}\n",
            t = loc.task,
            d = WPX_DIR
        ),
        undo: None,
        guard_min: 0,
        verify: true,
        log: log_of(loc),
    }
}

fn tx_stop(loc: &EngineLoc) -> Tx {
    // Метка «остановлен вручную» — сторож не будет поднимать движок.
    let mark = if loc.kind == EngineKind::Wpx {
        format!("  Set-Content -LiteralPath '{d}\\wpx-stopped' -Value '1' -Encoding ASCII\n", d = WPX_DIR)
    } else {
        String::new()
    };
    Tx {
        pre: String::new(),
        mutate: format!(
            "{mark}  Stop-ScheduledTask -TaskName {t} -ErrorAction SilentlyContinue\n  KM\n  if (-not (Test-Path '{d}\\ks-prev.json')) {{ Get-NetFirewallRule -Group wpx -ErrorAction SilentlyContinue | Disable-NetFirewallRule }}\n",
            t = loc.task,
            d = WPX_DIR
        ),
        undo: None,
        guard_min: 0,
        verify: false,
        log: None,
    }
}

/// Задача `wpx-fw-boot` (только без автозапуска движка): при загрузке ПК
/// выключить блоки DNS и IPv6, если ПК выключили с работающим движком — иначе
/// после перезагрузки сайты не открывались бы.
fn fw_boot_task() -> String {
    let cmd = format!("/c tasklist /fi \"imagename eq mihomo.exe\" | find /i \"mihomo.exe\" >nul || {}", fw_off_unless_ks());
    format!(
        "  $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '{}'\n  $pr = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest\n  Register-ScheduledTask -TaskName wpx-fw-boot -Action $act -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $pr -Force | Out-Null\n",
        ps_quote(&cmd)
    )
}
const FW_BOOT_OFF: &str = "  Unregister-ScheduledTask -TaskName wpx-fw-boot -Confirm:$false -ErrorAction SilentlyContinue\n";

fn tx_boot(on: bool) -> Tx {
    let mutate = if on {
        format!(
            "  Set-ScheduledTask -TaskName wpx-engine -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null\n  Set-Content -LiteralPath '{d}\\wpx-boot' -Value '1' -Encoding ASCII\n{FW_BOOT_OFF}",
            d = WPX_DIR
        )
    } else {
        format!(
            "  $t = Get-ScheduledTask -TaskName wpx-engine; $t.Triggers = $null; Set-ScheduledTask -InputObject $t | Out-Null\n  Set-Content -LiteralPath '{d}\\wpx-boot' -Value '0' -Encoding ASCII\n{}",
            fw_boot_task(),
            d = WPX_DIR
        )
    };
    Tx { pre: String::new(), mutate, undo: None, guard_min: 0, verify: false, log: None }
}

/// `hops` — TCP-точки, к которым ПК ходит напрямую (первые звенья рабочего
/// профиля и резерва): при остановленном движке они должны быть доступны,
/// а всё остальное — нет.
/// Первые звенья при включённом kill switch не проверяются: PowerShell он не
/// пропустит (пропускает только движок) — проверка соврала бы «недоступно».
fn tx_deep(loc: &EngineLoc, hops: &[(String, u16)], ks: bool) -> Tx {
    let hops: &[(String, u16)] = if ks { &[] } else { hops };
    let list = hops.iter().map(|(s, p)| format!("'{}:{p}'", ps_quote(s))).collect::<Vec<_>>().join(",");
    let mutate = format!(
        r#"  Stop-ScheduledTask -TaskName {t} -ErrorAction SilentlyContinue; KM; Start-Sleep -Seconds 2
  function P($a, $p) {{ $c = [Net.Sockets.TcpClient]::new(); try {{ $c.ConnectAsync($a, $p).Wait(3000) -and $c.Connected }} catch {{ $false }} finally {{ $c.Dispose() }} }}
  $d1 = P '1.1.1.1' 443; $d2 = P '8.8.8.8' 443; $v6 = P '2606:4700:4700::1111' 443
  $dns = $false; try {{ $dns = [bool](Resolve-DnsName example.com -Server 8.8.8.8 -DnsOnly -QuickTimeout -ErrorAction Stop) }} catch {{}}
  $hops = @(@({list}) | Where-Object {{ $_ }} | ForEach-Object {{ $i = $_.LastIndexOf(':'); $s = $_.Substring(0, $i); $p = [int]$_.Substring($i + 1); @{{s=$s; p=$p; ok=(P $s $p)}} }})
  $px = if ($hops.Count) {{ @($hops | Where-Object {{ $_.ok }}).Count -gt 0 }} else {{ $null }}
  Start-ScheduledTask -TaskName {t}
  $info = (@{{direct1=$d1; direct2=$d2; ipv6=$v6; dns=$dns; proxy=$px; hops=$hops}} | ConvertTo-Json -Compress -Depth 4)
"#,
        t = loc.task,
        list = list,
    );
    let undo = undo_script(&format!("Start-ScheduledTask -TaskName {t} -ErrorAction SilentlyContinue\n", t = loc.task));
    Tx { pre: String::new(), mutate, undo: Some(undo), guard_min: 3, verify: true, log: log_of(loc) }
}

fn tx_uninstall() -> Tx {
    let mutate = format!(
        "  Stop-ScheduledTask -TaskName wpx-engine -ErrorAction SilentlyContinue; KM\n\
         foreach ($t in 'wpx-engine','wpx-watchdog','wpx-rollback','wpx-fw-boot') {{ Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }}\n\
         {ks}  Get-NetFirewallRule -Group wpx -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n\
         $i = Get-Item -LiteralPath '{root}' -Force -ErrorAction SilentlyContinue\n\
         if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ [IO.Directory]::Delete('{root}') }} elseif ($i) {{ & cmd.exe /c rmdir /s /q '{root}' }}\n",
        ks = kill_switch(&NetSettings { kill_switch: false, ..NetSettings::default() }),
        root = WPX_ROOT,
    );
    Tx { pre: String::new(), mutate, undo: None, guard_min: 0, verify: false, log: None }
}


/// Скопировать файл в папку движка и проверить уже копию (её пользователь
/// подменить не может): не совпал хэш — копия удаляется, транзакция падает.
fn copy_verified(src: &str, dst: &str, hash: &str, err: &str) -> String {
    format!(
        "  Copy-Item -LiteralPath '{src}' -Destination '{dst}.new' -Force\n  if ((Get-FileHash -LiteralPath '{dst}.new' -Algorithm SHA256).Hash -ne '{hash}') {{ Remove-Item -LiteralPath '{dst}.new' -Force; throw '{err}' }}\n  Move-Item -LiteralPath '{dst}.new' -Destination '{dst}' -Force\n",
        src = ps_quote(src),
        dst = ps_quote(dst),
    )
}

fn tx_update_engine(src: &Path, sha: &str, migrate: &str) -> Tx {
    let mutate = format!(
        "  Stop-ScheduledTask -TaskName wpx-engine -ErrorAction SilentlyContinue; KM\n  Copy-Item -LiteralPath '{d}\\mihomo.exe' -Destination '{d}\\mihomo.prev.exe' -Force\n{copy}{migrate}  Start-ScheduledTask -TaskName wpx-engine\n",
        d = WPX_DIR,
        copy = copy_verified(&src.to_string_lossy(), &format!("{WPX_DIR}\\mihomo.exe"), sha, "E_MIHOMO_HASH"),
    );
    let undo = undo_script(&format!(
        "Stop-ScheduledTask -TaskName wpx-engine -ErrorAction SilentlyContinue; KM\nCopy-Item -LiteralPath '{d}\\mihomo.prev.exe' -Destination '{d}\\mihomo.exe' -Force\nStart-ScheduledTask -TaskName wpx-engine\n",
        d = WPX_DIR
    ));
    Tx { pre: String::new(), mutate, undo: Some(undo), guard_min: 4, verify: true, log: log_of(&config::wpx()) }
}

// ─── Вход из mod.rs ──────────────────────────────────────────────

pub(super) fn install(staged: &Path, hash: &str, src: &Path, sha: &str, n: &NetSettings) -> ApplyResult {
    match user_sid() {
        Ok(sid) => run(tx_install(staged, hash, &sid, src, sha, &adapters(&n.interface))),
        Err(e) => ApplyResult::fail(e),
    }
}

pub(super) fn apply(staged: &Path, hash: &str, n: &NetSettings) -> ApplyResult {
    run(tx_apply(staged, hash, n, &adapters(&n.interface)))
}

/// Перевод на папку `home` — только для своего движка.
fn migrate_for(loc: &EngineLoc) -> String {
    if loc.kind == EngineKind::Wpx { migrate() } else { String::new() }
}

pub(super) fn restart(loc: &EngineLoc) -> ApplyResult {
    run(tx_restart(loc, &migrate_for(loc)))
}

pub(super) fn start(loc: &EngineLoc) -> ApplyResult {
    run(tx_start(loc))
}

pub(super) fn stop(loc: &EngineLoc) -> ApplyResult {
    run(tx_stop(loc))
}

pub(super) fn set_boot(on: bool) -> ApplyResult {
    run(tx_boot(on))
}

pub(super) fn deep_test(loc: &EngineLoc, hops: &[(String, u16)]) -> ApplyResult {
    run(tx_deep(loc, hops, crate::engine::netcfg::load().kill_switch))
}

pub(super) fn uninstall() -> ApplyResult {
    run(tx_uninstall())
}

pub(super) fn update_engine(src: &Path, sha: &str) -> ApplyResult {
    run(tx_update_engine(src, sha, &migrate_for(&config::wpx())))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Командная строка Windows — до 32 767 символов: с запасом и при
    /// «тяжёлых» настройках (много адаптеров и файлов правил).
    #[test]
    fn scripts_fit_command_line() {
        let ifaces: Vec<String> = ["Ethernet", "Беспроводная сеть", "vEthernet (WSL)", "Ethernet 2"].iter().map(|s| s.to_string()).collect();
        let st = Path::new(r"C:\Users\Пользователь\AppData\Roaming\wpx\staged\config.yaml");
        let heavy = NetSettings { kill_switch: true, ipv6: "tunnel".into(), lan: vec!["10.0.0.0/8".into(); 6], ..NetSettings::default() };
        let r = Path::new(r"C:\Users\Пользователь\AppData\Roaming\wpx\op-result.txt");
        let src = Path::new(r"C:\Users\Пользователь\AppData\Local\wpx\wpx-mihomo-x86_64-pc-windows-msvc.exe");
        let sid = "S-1-5-21-1234567890-1234567890-1234567890-1001";
        let mut txs: Vec<(&str, Tx)> = all();
        txs.push(("install_heavy", tx_install(st, "AB", sid, src, "CD", &ifaces)));
        txs.push(("apply_heavy", tx_apply(st, "AB", &heavy, &ifaces)));
        for (name, tx) in txs {
            let n = launcher(&script(&tx, r)).len();
            assert!(n < 24_000, "{name}: {n} символов");
        }
    }

    #[test]
    fn names_in_admin_scripts_are_quoted() {
        // PowerShell 5.1 считает кавычкой и типографский апостроф — его тоже удваиваем.
        let evil = "Wi-Fi\u{2019}; Remove-Item C:\\x; \u{2019}";
        let r = ipv6_rule(Some(&[evil.to_string(), "Wi-Fi".into()]));
        assert!(r.contains("Wi-Fi\u{2019}\u{2019}; Remove-Item"), "{r}");
        assert!(r.contains("\u{2019}','Wi-Fi'"), "второй адаптер: {r}");
        let n = NetSettings { kill_switch: true, tun_device: "w\u{2019}x".into(), ..NetSettings::default() };
        assert!(kill_switch(&n).contains("-InterfaceAlias 'w\u{2019}\u{2019}x'"));
    }

    fn all() -> Vec<(&'static str, Tx)> {
        let st = Path::new(r"C:\Users\u\AppData\Roaming\wpx\staged\config.yaml");
        let w = config::wpx();
        let missing = config::EngineLoc { kind: EngineKind::Missing, ..config::wpx() };
        vec![
            ("install", tx_install(st, "AB", "S-1-5-21-1-2-3-1001", Path::new(r"C:\Program Files\wpx\wpx-mihomo.exe"), "CD", &["Ethernet".into(), "Wi-Fi".into()])),
            ("apply", tx_apply(st, "AB", &NetSettings { kill_switch: true, ipv6: "tunnel".into(), ..NetSettings::default() }, &["Ethernet".into(), "Wi-Fi".into()])),
            ("restart_wpx", tx_restart(&w, &migrate())),
            ("restart_missing", tx_restart(&missing, "")),
            ("start", tx_start(&w)),
            ("stop", tx_stop(&w)),
            ("boot_on", tx_boot(true)),
            ("boot_off", tx_boot(false)),
            ("deep", tx_deep(&w, &[("1.2.3.4".into(), 59100), ("5.6.7.8".into(), 443)], false)),
            ("uninstall", tx_uninstall()),
            ("update_engine", tx_update_engine(Path::new(r"C:\Program Files\wpx\wpx-mihomo.exe"), "CD", &migrate())),
            ("heal_on", tx_heal(true)),
            ("heal_off", tx_heal(false)),
        ]
    }

    #[test]
    fn scripts_are_ascii_and_balanced() {
        let r = Path::new(r"C:\x\r.txt");
        for (name, tx) in all() {
            let s = script(&tx, r);
            assert!(s.is_ascii(), "{name}: не ASCII");
            assert_eq!(s.matches('{').count(), s.matches('}').count(), "{name}: скобки");
            if let Some(u) = &tx.undo {
                assert!(u.is_ascii(), "{name}: undo не ASCII");
            }
        }
    }

    /// `cargo test dump_scripts -- --ignored` — выгрузить все скрипты и
    /// скрипты отмены в %TEMP%\wpx-lint для проверки парсером PowerShell.
    #[test]
    #[ignore]
    fn dump_scripts() {
        let dir = std::env::temp_dir().join("wpx-lint");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = Path::new(r"C:\x\r.txt");
        for (name, tx) in all() {
            std::fs::write(dir.join(format!("{name}.ps1")), script(&tx, r)).unwrap();
            if let Some(u) = &tx.undo {
                std::fs::write(dir.join(format!("{name}.undo.ps1")), u).unwrap();
            }
        }
        std::fs::write(dir.join("watchdog.ps1"), WATCHDOG_PS).unwrap();
        std::fs::write(dir.join("engine-args.txt"), engine_args()).unwrap();
    }

    /// Без kill switch блоки DNS и IPv6 живут, пока работает движок: включить
    /// до mihomo, выключить после (код выхода — его), выключить при остановке
    /// и при загрузке ПК без автозапуска.
    #[test]
    fn dns_block_follows_engine() {
        let a = engine_args();
        let (on, mh, off) = (a.find("enable=yes").unwrap(), a.find("mihomo.exe").unwrap(), a.find("enable=no").unwrap());
        assert!(on < mh && mh < off, "{a}");
        assert!(a.contains("(if not exist C:\\ProgramData\\wpx\\engine\\ks-prev.json netsh") && a.ends_with("& exit !rc!"), "{a}");
        assert!(tx_stop(&config::wpx()).mutate.contains("Disable-NetFirewallRule"));
        assert!(tx_boot(false).mutate.contains("wpx-fw-boot") && tx_boot(true).mutate.contains("Unregister-ScheduledTask -TaskName wpx-fw-boot"));
        assert!(tx_uninstall().mutate.contains("'wpx-fw-boot'"));
    }

    #[test]
    fn watchdog_is_ascii() {
        assert!(WATCHDOG_PS.is_ascii());
    }
}

