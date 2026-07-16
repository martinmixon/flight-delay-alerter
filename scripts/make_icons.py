#!/usr/bin/env python3
"""Generate the PWA icons with no third-party image libraries.

Draws a brand-blue tile with a white paper-plane glyph and writes:
  docs/icons/icon-192.png          (rounded, for Android home screen)
  docs/icons/icon-512.png          (rounded, high-res)
  docs/icons/icon-512-maskable.png (full-bleed square for maskable safe-area)

Run: ``py scripts/make_icons.py`` (only needed when changing the icon design;
the generated PNGs are committed so CI never has to run this).
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "icons"

# Brand palette (top -> bottom gradient) and glyph color.
TOP = (37, 99, 235)      # #2563eb
BOTTOM = (30, 58, 138)   # #1e3a8a
WHITE = (255, 255, 255)


def _lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = sign((px, py), a, b), sign((px, py), b, c), sign((px, py), c, a)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def render(size: int, maskable: bool) -> bytes:
    radius = 0 if maskable else int(size * 0.22)
    # Paper-plane made of two triangles, centered, pointing up-right.
    s = size
    body = [(s * 0.24, s * 0.70), (s * 0.78, s * 0.26), (s * 0.50, s * 0.74)]
    wing = [(s * 0.24, s * 0.70), (s * 0.78, s * 0.26), (s * 0.44, s * 0.56)]

    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter type 0 (none) for this row
        grad = _lerp(TOP, BOTTOM, y / (size - 1))
        for x in range(size):
            # Rounded-corner alpha mask (skipped when maskable/full-bleed).
            alpha = 255
            if radius:
                cx = min(x, size - 1 - x)
                cy = min(y, size - 1 - y)
                if cx < radius and cy < radius:
                    dx, dy = radius - cx, radius - cy
                    if dx * dx + dy * dy > radius * radius:
                        alpha = 0
            if _in_triangle(x, y, *body) or _in_triangle(x, y, *wing):
                r, g, b = WHITE
            else:
                r, g, b = grad
            rows += bytes((r, g, b, alpha))
    return _png(size, size, bytes(rows))


def _png(width: int, height: int, raw: bytes) -> bytes:
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-512-maskable.png", 512, True),
    ]
    for name, size, maskable in targets:
        (OUT / name).write_bytes(render(size, maskable))
        print(f"wrote {OUT / name} ({size}px, maskable={maskable})")


if __name__ == "__main__":
    main()
