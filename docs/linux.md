# wpx on Linux

Supported: x86-64 desktops with systemd, polkit, nftables and curl (Debian 12+, Ubuntu 22.04+, Fedora, Arch, …).
Packages: `.deb` (Debian/Ubuntu) and `.AppImage` (everything else).

## What gets installed

*Install engine* (one polkit password prompt) creates:

- `/opt/wpx/engine/` — `mihomo` (from the wpx package, verified by SHA-256), `config.yaml`, `engine.log`, `rules.nft`.
- `/etc/systemd/system/wpx-engine.service` — the engine, restarted on failure, enabled at boot.
- `/etc/systemd/system/wpx-firewall.service` — loads `rules.nft` before the network comes up.
- Optional `wpx-watchdog.timer` — restarts the engine if the tunnel is down (Engine → self-healing).

*Remove engine* stops and deletes all of it, including the nftables table `inet wpx`.

## Rules (nftables)

Table `inet wpx`, chain `out` (hook output):

- the engine's own traffic carries the mark `6666` (`routing-mark` in the mihomo config) and always passes;
- loopback and the tunnel interface pass;
- direct DNS (53/853) on the physical adapter is dropped; IPv6 is dropped on the adapter (tunnel mode) or everywhere;
- with the kill switch: private networks, DHCP and IPv6 neighbour discovery pass, everything else is dropped.

## The notch

The notch window needs to place itself at a screen edge and let clicks through. Wayland does not allow either, so on
Linux wpx starts through XWayland by default (`GDK_BACKEND=x11`). To force native Wayland set `WPX_WAYLAND=1` — the
main window works, the notch may stay in the middle of the screen. wpx also sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`
(avoids a blank window on some GPUs) unless you set it yourself.

## Differences from Windows

- No `.lnk` shortcuts: drag `.desktop` files, programs or folders. Steam games are found in `~/.steam`,
  `~/.local/share/Steam` and the Flatpak location.
- Program icons are shown only when a `.desktop` file points to a `.png`.
- The *direct exit* check in the guard is replaced by **Deep check** (see [security](security.md)).
- Secrets are encrypted with a per-user key file instead of DPAPI.

## Troubleshooting

```bash
systemctl status wpx-engine wpx-firewall
journalctl -u wpx-engine -n 50
sudo nft list table inet wpx
tail -n 50 /opt/wpx/engine/engine.log
```

If the polkit prompt never appears, install and run a polkit agent for your desktop (most desktops have one).
