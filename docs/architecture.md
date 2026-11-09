# Architecture

wpx is a [Tauri 2](https://tauri.app) app: a Rust backend and a TypeScript frontend without a framework. The tunnel
itself is [mihomo](https://github.com/MetaCubeX/mihomo) (a Clash.Meta core) running as a system service; wpx builds its
config, installs and supervises it, and never routes traffic itself.

```
┌─────────────── user session ───────────────┐        ┌──────── system ────────┐
│ wpx (window, notch, tray)                  │        │ engine: mihomo (TUN)   │
│  ├─ monitor: checks every few seconds ─────┼─API──▶ │  config.yaml           │
│  ├─ rules / profiles / servers             │        │  rules (Win FW / nft)  │
│  └─ ops: builds a transaction script ──────┼─admin─▶│  service / task        │
└────────────────────────────────────────────┘ prompt └────────────────────────┘
          │ SSH (russh)                                   ▲ the whole PC's traffic
          ▼
   your VPS: sing-box, Xray, mtg, amneziawg-go (Docker or systemd)
```

## Backend (`src-tauri/src`)

| Module | Responsibility |
|---|---|
| `config.rs` | where the engine lives, parsing its config, wpx settings, data folder |
| `engine/netcfg.rs` | network settings and the mihomo config builder (TUN, DNS, rules, groups, cascades) |
| `engine/ops/` | every system change as a transaction: `mod.rs` (staging, result parsing), `windows.rs` (PowerShell, Task Scheduler, Windows Firewall), `linux.rs` (bash, systemd, nftables) |
| `engine/controller.rs` | mihomo's local API: active exit, connections, rule providers |
| `engine/follow.rs` | "…and everything it launches": helper processes and their sites, applied live |
| `engine/sandbox.rs`, `engine/trial.rs` | a separate mihomo without TUN to test endpoints and profiles |
| `engine/guard.rs`, `engine/logtail.rs` | kill switch state, engine log events |
| `monitor/` | background loop: tunnel pulse, exits, external IP, history, notifications, diagnostics, speed test |
| `profiles/` | profiles store (secrets encrypted), link formats (`proto.rs`) |
| `servers/` | own VPS over SSH: inspect, install, firewall, cascades, guests, move, core updates |
| `app/` | Tauri commands for the UI, tray, notch window, updates, game mode helpers, drag-and-drop (Windows) |
| `platform/` | the few OS differences shared by everything (hidden processes, adapters, file opener) |

## Transactions

Everything that changes the system goes through `engine::ops`:

1. The config is built in the user's data folder and checked with `mihomo -t` (no admin rights).
2. One admin prompt runs a script passed as an argument (no script file): `powershell -EncodedCommand` via UAC on
   Windows, `pkexec /bin/bash -c` via polkit on Linux.
3. The script arms a rollback guard owned by the system — a SYSTEM scheduled task (`wpx-rollback`) or a transient
   systemd timer — then copies files **and verifies the copies by SHA-256**, applies, and checks the tunnel.
4. Tunnel alive → the guard is disarmed. Not alive → rollback right away. If wpx or the script dies midway, the
   guard fires after a few minutes anyway.

The script reports `TAG|info|message` (`OK`, `ROLLEDBACK`, `NOTUNNEL`, `ERR`); `ops::outcome` turns it into the
result shown in the UI.

## Where things live

| | Windows | Linux |
|---|---|---|
| Engine | `C:\ProgramData\wpx\engine` | `/opt/wpx/engine` |
| Engine runs as | scheduled task `wpx-engine` (SYSTEM) | `wpx-engine.service` |
| Kill switch / base rules | Windows Firewall groups `wpx`, `wpx-ks` | nftables table `inet wpx` (`wpx-firewall.service`) |
| Watchdog | task `wpx-watchdog` | `wpx-watchdog.timer` |
| wpx data | `%APPDATA%\wpx` | `~/.local/share/wpx` |

Engine folder contents: `mihomo(.exe)`, `config.yaml`, `engine.log`, markers (`wpx-active`, `wpx-boot`, `wpx-heal`,
`wpx-stopped`, `wpx-maint`), `user/` (rule files the user may write — see *follow*), and `rules.nft` on Linux.

wpx data: `profiles.json`, `servers.json` (secrets encrypted), `engine.json` (network settings), `settings.json`,
history, and short-lived `staged/`, `sandbox/`, `trial/` folders.

## Live rule updates ("follow")

App rules with *…and everything it launches* get a mihomo `file` rule provider in the engine's `user/` folder. That
folder is created during *Apply* with write access for the user, so wpx can append discovered helpers and sites and
ask mihomo to reload the provider through its API — no restart and no admin prompt.

## Frontend (`src`)

`main.ts` decides which window it is (main window or `?view=widget` — the notch). `core/api.ts` is the only place that
calls Rust (`invoke`); in a plain browser `core/mock.ts` provides demo data, so the UI can be developed with
`npm run dev` alone. Translation is a live DOM pass (`core/i18n.ts`) over Russian source strings using
`locales/<lang>.json`; streamer mode (`core/streamer.ts`) masks addresses, links and keys the same way.

## Bundled engine

`scripts/fetch-mihomo.mjs` downloads a pinned mihomo release for the build target, checks the archive's SHA-256 and
puts it into `src-tauri/binaries/` as a Tauri sidecar (`wpx-mihomo`). `build.rs` embeds the binary's SHA-256 into wpx;
the install transaction refuses a copy that does not match.
