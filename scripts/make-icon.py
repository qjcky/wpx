"""Значки wpx — кот-маскот, тот же, что в трее (src-tauri/src/app/tray.rs), в цвете «на связи».

    python scripts/make-icon.py

Пишет src-tauri/icons/ (PNG для Linux и окна, icon.ico для Windows) и
assets/app-icon.png (1024×1024). Пиксель-арт 16×16 клеток масштабируется без
сглаживания, поэтому каждый размер рисуется из сетки, а не из большой картинки.
Только stdlib.
"""
import os
import struct
import sys
import zlib

G = 16
# Как в tray.rs: строка, первый и последний столбец тела.
BODY = [(2, 3, 3), (2, 12, 12), (3, 3, 4), (3, 11, 12), (4, 3, 5), (4, 10, 12), (5, 3, 12),
        (6, 2, 13), (7, 2, 13), (8, 2, 13), (9, 2, 13), (10, 2, 13), (11, 3, 12), (12, 4, 11)]
EARS = [(4, 4), (11, 4)]
EYES = [(5, 7), (6, 7), (5, 8), (6, 8), (9, 7), (10, 7), (9, 8), (10, 8)]
ONLINE = (0x78, 0xEE, 0x9A)


def grid():
    """0 — пусто, 1 — тело, 2 — контур, 3 — глаз, 4 — ухо изнутри."""
    cell = [[0] * G for _ in range(G)]
    for y, a, z in BODY:
        for x in range(a, z + 1):
            cell[y][x] = 1
    out = [row[:] for row in cell]
    for y in range(G):
        for x in range(G):
            if cell[y][x] == 0 and any(
                0 <= x + dx < G and 0 <= y + dy < G and cell[y + dy][x + dx] == 1
                for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            ):
                out[y][x] = 2
    for x, y in EARS:
        out[y][x] = 4
    for x, y in EYES:
        out[y][x] = 3
    return out


def colors():
    lite = lambda k: tuple(int(c + (255 - c) * k) for c in ONLINE)
    return {0: (0, 0, 0, 0), 1: (5, 5, 8, 255), 2: (*lite(0.35), 255), 3: (*ONLINE, 255), 4: (*lite(0.6), 255)}


def png(n: int) -> bytes:
    cells, pal = grid(), colors()
    rows = b"".join(
        b"\0" + b"".join(bytes(pal[cells[y * G // n][x * G // n]]) for x in range(n)) for y in range(n)
    )

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def ico(sizes) -> bytes:
    """ICO с PNG внутри (Windows Vista и новее)."""
    images = [png(n) for n in sizes]
    head = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b""
    for n, data in zip(sizes, images):
        entries += struct.pack("<BBBBHHII", n % 256, n % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return head + entries + b"".join(images)


def main(root: str):
    icons = os.path.join(root, "src-tauri", "icons")
    os.makedirs(icons, exist_ok=True)
    files = {
        "32x32.png": png(32),
        "128x128.png": png(128),
        "128x128@2x.png": png(256),
        "icon.png": png(512),
        "icon.ico": ico([16, 24, 32, 48, 64, 128, 256]),
    }
    for name, data in files.items():
        with open(os.path.join(icons, name), "wb") as f:
            f.write(data)
    os.makedirs(os.path.join(root, "assets"), exist_ok=True)
    with open(os.path.join(root, "assets", "app-icon.png"), "wb") as f:
        f.write(png(1024))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
