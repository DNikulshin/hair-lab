#!/usr/bin/env python3
"""Генерация иконок PWA для `apps/web/public/icons/`.

Знак — временная монограмма «С» цветом `--surface` (#faf8f5) на фоне `--accent`
(#2f4f4a) из дизайн-токенов (`src/app/globals.css`). Это не бренд-дизайн: когда
палитра и логотип будут утверждены (#13), меняются только файлы иконок — имена
и размеры остаются прежними, манифест и service worker править не нужно.

Запуск (вручную, результат коммитим):

    python3 apps/web/scripts/generate-icons.py

Зависимость — Pillow (в окружении разработчика уже есть, в `apps/web` не ставится:
скрипт не входит в сборку и не нужен в CI).

Файлы и их назначение:
    icon-192.png            purpose="any", 192×192
    icon-512.png            purpose="any", 512×512
    icon-maskable-512.png   purpose="maskable", 512×512 — знак внутри safe zone
    apple-touch-icon.png    iOS, 180×180 (прозрачности нет: iOS не любит альфу)
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Цвета дублируют CSS-переменные `--accent` и `--surface` из `src/app/globals.css`.
ACCENT = (47, 79, 74)  # #2f4f4a
SURFACE = (250, 248, 245)  # #faf8f5

# Кириллическая «С» (U+0421) — первая буква названия салона.
GLYPH = "\u0421"

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"

# Системные шрифты: первый найденный. Список покрывает Linux/macOS/Windows,
# чтобы скрипт оставался воспроизводимым на машинах команды.
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)

# Размер знака относительно стороны иконки.
GLYPH_RATIO_ANY = 0.54
# Maskable: Android обрезает иконку по своей маске, безопасная зона — круг
# радиусом 40% от стороны. Держим знак заметно меньше, чтобы обрезка его не срезала.
GLYPH_RATIO_MASKABLE = 0.40

# (сторона, имя файла, доля знака)
ICONS = (
    (192, "icon-192.png", GLYPH_RATIO_ANY),
    (512, "icon-512.png", GLYPH_RATIO_ANY),
    (512, "icon-maskable-512.png", GLYPH_RATIO_MASKABLE),
    (180, "apple-touch-icon.png", GLYPH_RATIO_ANY),
)

# Радиус безопасной зоны maskable (доля от стороны) и допуск проверки.
SAFE_ZONE_RADIUS = 0.40


def resolve_font_path() -> Path:
    for candidate in FONT_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            return path
    raise SystemExit(
        "Не найден системный шрифт. Добавь путь к TTF в FONT_CANDIDATES: " + ", ".join(FONT_CANDIDATES)
    )


def render_icon(size: int, filename: str, glyph_ratio: float, font_path: Path) -> Image.Image:
    """Фон на всю иконку (без альфы — так безопаснее для maskable и iOS) и знак по центру."""
    image = Image.new("RGB", (size, size), ACCENT)
    draw = ImageDraw.Draw(image)

    font = ImageFont.truetype(str(font_path), int(round(size * glyph_ratio)))
    bbox = draw.textbbox((0, 0), GLYPH, font=font)
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    # Центрируем по фактическим границам глифа, а не по метрикам строки:
    # иначе знак уезжает вверх из-за выносных элементов.
    position = ((size - width) / 2 - bbox[0], (size - height) / 2 - bbox[1])
    draw.text(position, GLYPH, font=font, fill=SURFACE)

    if "maskable" in filename:
        assert_within_safe_zone(size, position, width, height, filename)

    return image


def assert_within_safe_zone(
    size: int, position: tuple[float, float], width: int, height: int, filename: str
) -> None:
    """Знак целиком внутри безопасной зоны maskable — иначе иконку обрежет маска Android."""
    center = size / 2
    half_diagonal = ((width / 2) ** 2 + (height / 2) ** 2) ** 0.5
    glyph_center_x = position[0] + width / 2
    glyph_center_y = position[1] + height / 2
    offset = ((glyph_center_x - center) ** 2 + (glyph_center_y - center) ** 2) ** 0.5
    if offset + half_diagonal > SAFE_ZONE_RADIUS * size:
        raise SystemExit(f"{filename}: знак выходит за safe zone maskable")


def main() -> int:
    font_path = resolve_font_path()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for size, filename, glyph_ratio in ICONS:
        image = render_icon(size, filename, glyph_ratio, font_path)
        target = OUTPUT_DIR / filename
        image.save(target, format="PNG", optimize=True)
        print(f"{target.relative_to(OUTPUT_DIR.parent.parent)}: {size}×{size}")

    print(f"Шрифт: {font_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
