"""Render the plugin's tray/app icon (assets/icon.ico + assets/icon.png).

Run when the artwork changes:

    python tools/make-icon.py [path-to-DSH-icon.png]

The artwork is DSH's own icon **recoloured**, which is what the user asked for:
the whale keeps its shape and the light rounded plate it sits on, and only the ink
changes to this plugin's blue, so the two icons side by side in the notification
area can be told apart at a glance. The source is the installed application's
`resources/icon.png` (1024 px, transparent corners), looked up in this order: the
command-line argument, `$DSH_ICON`, the usual install path, then Program Files.

Note what that means: the whale is DeepSeek's mark, used here for a personal local
tool. Recolouring does not make it yours to redistribute — keep this plugin
private, or draw your own mark instead.

The tray companion needs a real .ico because Windows PowerShell loads it through
System.Drawing; shipping the rendered file keeps the plugin free of a build step.
"""
from __future__ import annotations

import os
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

#: The plugin's accent, and the only thing that distinguishes this icon from
#: DSH's own. Change it here to recolour the whole icon.
ACCENT = (76, 141, 255)

#: How dark a pixel must be to count as ink (the whale) rather than plate.
INK_LEVEL = 128

#: Candidate locations for the application's own icon on this machine.
SOURCE_CANDIDATES = (
    pathlib.Path(r"D:\Software\DeepSeek Harness\resources\icon.png"),
    pathlib.Path(r"C:\Program Files\DeepSeek Harness\resources\icon.png"),
    pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "DeepSeek Harness" / "resources" / "icon.png",
)


def find_source(argv: list[str]) -> pathlib.Path:
    """Locate the application icon to derive from.

    @param argv - the script arguments.
    @returns the source image path.
    """
    candidates = [pathlib.Path(argument) for argument in argv[1:2]]
    configured = os.environ.get("DSH_ICON")
    if configured:
        candidates.append(pathlib.Path(configured))
    candidates.extend(SOURCE_CANDIDATES)
    for candidate in candidates:
        if str(candidate) != "" and candidate.is_file():
            return candidate
    raise SystemExit(
        "找不到 DSH 自己的图标（resources/icon.png）。\n"
        "用法：python tools/make-icon.py [path-to-icon.png]，或设置环境变量 DSH_ICON。"
    )


def recolour(source: Image.Image) -> Image.Image:
    """Repaint the source's ink in the accent colour, plate and edges included.

    The blend is per pixel: how far a pixel sits between the plate and the ink
    decides how much accent it gets, which keeps the anti-aliased outline smooth
    instead of leaving a hard cut-out.
    """
    image = source.convert("RGBA")
    pixels = image.load()
    width, height = image.size
    # The plate's own colour, sampled from a point inside the rounded square but
    # away from the whale.
    plate = pixels[int(width * 0.08), int(height * 0.5)][:3]
    plate_luminance = (plate[0] * 299 + plate[1] * 587 + plate[2] * 114) // 1000
    span = max(1, plate_luminance - INK_LEVEL)
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue
            luminance = (red * 299 + green * 587 + blue * 114) // 1000
            if luminance >= plate_luminance:
                continue
            coverage = min(1.0, max(0.0, (plate_luminance - luminance) / span))
            pixels[x, y] = (
                int(red + (ACCENT[0] - red) * coverage),
                int(green + (ACCENT[1] - green) * coverage),
                int(blue + (ACCENT[2] - blue) * coverage),
                alpha,
            )
    return image


def main() -> None:
    source = find_source(sys.argv)
    print(f"source: {source}")
    icon = recolour(Image.open(source))
    ASSETS.mkdir(parents=True, exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    # `sizes=` is the path this deployment has already proven: System.Drawing in
    # the tray companion loads these frames without complaint.
    icon.save(ASSETS / "icon.ico", format="ICO", sizes=[(size, size) for size in sizes])
    icon.resize((256, 256), Image.LANCZOS).save(ASSETS / "icon.png")
    print(f"wrote {ASSETS / 'icon.ico'} and {ASSETS / 'icon.png'}")


if __name__ == "__main__":
    main()
