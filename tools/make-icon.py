"""Render the plugin's tray/app icon (assets/icon.ico + assets/icon.png).

Run once when the artwork changes:

    python tools/make-icon.py

The tray companion needs a real .ico because Windows PowerShell loads it through
System.Drawing; shipping the rendered file keeps the plugin free of a build step.
"""
from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

BLUE = (76, 141, 255, 255)
DEEP = (14, 17, 22, 255)
WHITE = (255, 255, 255, 255)


def render(size: int) -> Image.Image:
    """One icon at one size, drawn at 4x and downsampled for clean edges."""
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    unit = canvas / 32

    def box(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        return (x0 * unit, y0 * unit, x1 * unit, y1 * unit)

    # Toolbox body with a lid band.
    draw.rounded_rectangle(box(2, 7, 30, 27), radius=int(5 * unit), fill=BLUE)
    draw.rectangle(box(2, 12, 30, 15), fill=(14, 17, 22, 90))

    # Handle.
    draw.arc(
        box(12, 3, 20, 11),
        start=180,
        end=360,
        fill=DEEP,
        width=max(2, int(2.2 * unit)),
    )

    # Yuan mark: two horizontal strokes, a Y, and a stem.
    stroke = max(2, int(2.3 * unit))
    draw.line(box(11.5, 19.5, 20.5, 19.5), fill=WHITE, width=stroke)
    draw.line(box(16, 19.5, 16, 27), fill=WHITE, width=stroke)
    draw.line(box(12.7, 23.4, 19.3, 23.4), fill=WHITE, width=stroke)
    draw.line(box(12.4, 16.2, 16, 20.2), fill=WHITE, width=stroke)
    draw.line(box(19.6, 16.2, 16, 20.2), fill=WHITE, width=stroke)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [render(size) for size in sizes]
    frames[-1].save(ASSETS / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes])
    frames[-1].resize((128, 128), Image.LANCZOS).save(ASSETS / "icon.png")
    print(f"wrote {ASSETS / 'icon.ico'} and {ASSETS / 'icon.png'}")


if __name__ == "__main__":
    main()
