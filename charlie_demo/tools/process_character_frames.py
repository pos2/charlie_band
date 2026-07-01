#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
CHARACTER_DIR = ROOT / "assets" / "characters"
FRAME_COUNT = 6
BACKGROUND_TOLERANCE = 68
EDGE_SOFTNESS = 28
CONFIG_PATH = CHARACTER_DIR / "alignment_config.json"


def color_distance_sq(pixel: tuple[int, int, int], bg: tuple[int, int, int]) -> int:
    return sum((int(pixel[idx]) - int(bg[idx])) ** 2 for idx in range(3))


def is_green_screen(bg: tuple[int, int, int]) -> bool:
    red, green, blue = bg
    return green - red > 6 and green - blue > 6


def is_greenish(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel
    return green > 80 and green - red > 5 and green - blue > 3


def has_green_screen_pixels(rgb: Image.Image) -> bool:
    width, height = rgb.size
    total = 0
    greenish = 0
    for y in range(0, height, 8):
        for x in range(0, width, 8):
            total += 1
            if is_greenish(rgb.getpixel((x, y))):
                greenish += 1
    return total > 0 and greenish / total > 0.05


def is_background_pixel(pixel: tuple[int, int, int], bg: tuple[int, int, int], threshold: int, green_screen: bool) -> bool:
    if not green_screen:
        return color_distance_sq(pixel, bg) <= threshold

    return is_greenish(pixel)


def estimate_background(rgb: Image.Image) -> tuple[int, int, int]:
    width, height = rgb.size
    samples: list[tuple[int, int, int]] = []
    points = [
        (0, 0),
        (width - 1, 0),
        (0, height - 1),
        (width - 1, height - 1),
        (width // 2, 0),
        (width // 2, height - 1),
        (0, height // 2),
        (width - 1, height // 2),
    ]
    for point in points:
        samples.append(rgb.getpixel(point))
    return tuple(sorted(channel)[len(channel) // 2] for channel in zip(*samples))


def make_background_mask(rgb: Image.Image, bg: tuple[int, int, int]) -> Image.Image:
    width, height = rgb.size
    px = rgb.load()
    threshold = BACKGROUND_TOLERANCE * BACKGROUND_TOLERANCE
    visited = bytearray(width * height)
    alpha = Image.new("L", (width, height), 255)
    alpha_px = alpha.load()
    queue: deque[tuple[int, int]] = deque()
    green_screen = is_green_screen(bg) or has_green_screen_pixels(rgb)

    def enqueue(x: int, y: int) -> None:
        idx = y * width + x
        if visited[idx]:
            return
        visited[idx] = 1
        if is_background_pixel(px[x, y], bg, threshold, green_screen):
            alpha_px[x, y] = 0
            queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                enqueue(nx, ny)

    if green_screen:
        for y in range(height):
            for x in range(width):
                if is_greenish(px[x, y]):
                    alpha_px[x, y] = 0

    return alpha


def soften_alpha(alpha: Image.Image) -> Image.Image:
    alpha_px = alpha.load()
    width, height = alpha.size
    transparent = 0
    opaque = 255

    for y in range(height):
        for x in range(width):
            if alpha_px[x, y] != opaque:
                continue
            neighbors = []
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < width and 0 <= ny < height:
                    neighbors.append(alpha_px[nx, ny])
            if any(value == transparent for value in neighbors):
                alpha_px[x, y] = 210

    return alpha


def remove_background(path: Path) -> Image.Image:
    rgb = Image.open(path).convert("RGB")
    bg = estimate_background(rgb)
    green_screen = is_green_screen(bg) or has_green_screen_pixels(rgb)
    alpha = make_background_mask(rgb, bg)
    alpha = soften_alpha(alpha)

    # Fade very bright fringe pixels near the flood-filled background.
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    px = out.load()
    alpha_px = alpha.load()
    width, height = out.size
    fringe_threshold = (BACKGROUND_TOLERANCE + EDGE_SOFTNESS) ** 2
    if not green_screen:
        for y in range(height):
            for x in range(width):
                if alpha_px[x, y] == 255 and color_distance_sq(px[x, y][:3], bg) <= fringe_threshold:
                    px[x, y] = (*px[x, y][:3], 230)
    return out


def load_config() -> dict[str, object]:
    if not CONFIG_PATH.exists():
        return {"defaults": {}, "characters": {}}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def character_config(config: dict[str, object], character_id: str) -> dict[str, object]:
    defaults = config.get("defaults", {})
    characters = config.get("characters", {})
    item = dict(defaults if isinstance(defaults, dict) else {})
    specific = characters.get(character_id, {}) if isinstance(characters, dict) else {}
    if isinstance(specific, dict):
        item.update(specific)
    return item


def frame_offset(config: dict[str, object], frame_index: int) -> tuple[int, int]:
    offsets = config.get("offsets", {})
    if not isinstance(offsets, dict):
        return (0, 0)
    value = offsets.get(str(frame_index), [0, 0])
    if not isinstance(value, list) or len(value) != 2:
        return (0, 0)
    return (int(value[0]), int(value[1]))


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return (0, 0, image.width, image.height)
    return bbox


def largest_component_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    width, height = alpha.size
    px = alpha.load()
    visited = bytearray(width * height)
    best: tuple[int, int, int, int, int] | None = None

    for start_y in range(height):
        for start_x in range(width):
            idx = start_y * width + start_x
            if visited[idx] or px[start_x, start_y] < 16:
                visited[idx] = 1
                continue

            stack = [(start_x, start_y)]
            visited[idx] = 1
            min_x = max_x = start_x
            min_y = max_y = start_y
            count = 0

            while stack:
                x, y = stack.pop()
                count += 1
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)

                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if not (0 <= nx < width and 0 <= ny < height):
                        continue
                    next_idx = ny * width + nx
                    if visited[next_idx]:
                        continue
                    visited[next_idx] = 1
                    if px[nx, ny] >= 16:
                        stack.append((nx, ny))

            if best is None or count > best[0]:
                best = (count, min_x, min_y, max_x + 1, max_y + 1)

    if best is None:
        return alpha_bbox(image)
    return (best[1], best[2], best[3], best[4])


def bbox_center_bottom(bbox: tuple[int, int, int, int]) -> tuple[float, int]:
    left, _top, right, bottom = bbox
    return ((left + right) / 2, bottom)


def is_near_white(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, alpha = pixel
    return alpha > 0 and red > 225 and green > 225 and blue > 225 and max(red, green, blue) - min(red, green, blue) < 35


def clear_edge_connected_near_white(image: Image.Image) -> Image.Image:
    out = image.copy()
    px = out.load()
    width, height = out.size
    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        idx = y * width + x
        if visited[idx]:
            return
        visited[idx] = 1
        if is_near_white(px[x, y]):
            px[x, y] = (*px[x, y][:3], 0)
            queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                enqueue(nx, ny)

    return out


def clear_outer_near_white(image: Image.Image, margin: int = 36) -> Image.Image:
    out = image.copy()
    px = out.load()
    width, height = out.size
    for y in range(height):
        for x in range(width):
            if x >= margin and y >= margin and x < width - margin and y < height - margin:
                continue
            if is_near_white(px[x, y]):
                px[x, y] = (*px[x, y][:3], 0)
    return out


def clear_border_near_white_lines(image: Image.Image, margin: int = 48) -> Image.Image:
    out = image.copy()
    px = out.load()
    width, height = out.size

    for y in list(range(min(margin, height))) + list(range(max(0, height - margin), height)):
        hits = sum(1 for x in range(width) if is_near_white(px[x, y]))
        if hits > width * 0.25:
            for x in range(width):
                if is_near_white(px[x, y]):
                    px[x, y] = (*px[x, y][:3], 0)

    for x in list(range(min(margin, width))) + list(range(max(0, width - margin), width)):
        hits = sum(1 for y in range(height) if is_near_white(px[x, y]))
        if hits > height * 0.25:
            for y in range(height):
                if is_near_white(px[x, y]):
                    px[x, y] = (*px[x, y][:3], 0)

    return out


def process_character(character_dir: Path, output_root: Path, config: dict[str, object]) -> dict[str, object]:
    frames = [character_dir / f"frame-{idx}.png" for idx in range(1, FRAME_COUNT + 1)]
    char_config = character_config(config, character_dir.name)
    should_remove_background = bool(char_config.get("removeBackground", True))
    should_auto_align = False
    processed = [remove_background(frame) if should_remove_background else Image.open(frame).convert("RGBA") for frame in frames]
    bboxes = [alpha_bbox(image) for image in processed]
    anchor_bboxes = [largest_component_bbox(image) if should_auto_align else bbox for image, bbox in zip(processed, bboxes)]
    target_center_x, target_bottom = bbox_center_bottom(anchor_bboxes[0])

    viewport_width = max(image.width for image in processed)
    viewport_height = max(image.height for image in processed)

    out_dir = output_root / character_dir.name
    out_dir.mkdir(parents=True, exist_ok=True)
    metadata_frames = []

    for idx, (image, bbox, anchor_bbox) in enumerate(zip(processed, bboxes, anchor_bboxes), start=1):
        manual_offset_x, manual_offset_y = frame_offset(char_config, idx)
        current_center_x, current_bottom = bbox_center_bottom(anchor_bbox)
        auto_offset_x = round(target_center_x - current_center_x) if should_auto_align else 0
        auto_offset_y = target_bottom - current_bottom if should_auto_align else 0
        offset_x = auto_offset_x + manual_offset_x
        offset_y = auto_offset_y + manual_offset_y
        paste_x = offset_x
        paste_y = offset_y
        canvas = Image.new("RGBA", (viewport_width, viewport_height), (255, 255, 255, 0))
        canvas.paste(image, (paste_x, paste_y), image)
        canvas = clear_edge_connected_near_white(canvas)
        canvas = clear_outer_near_white(canvas)
        canvas = clear_border_near_white_lines(canvas)
        out_path = out_dir / f"frame-{idx}.png"
        canvas.save(out_path)
        metadata_frames.append(
            {
                "frame": idx,
                "source": str(frames[idx - 1]),
                "output": str(out_path),
                "bbox": list(bbox),
                "anchor_bbox": list(anchor_bbox),
                "paste": [paste_x, paste_y],
                "auto_offset": [auto_offset_x, auto_offset_y],
                "manual_offset": [manual_offset_x, manual_offset_y],
                "offset": [offset_x, offset_y],
            }
        )

    return {
        "id": character_dir.name,
        "removeBackground": should_remove_background,
        "viewport": [0, 0, viewport_width, viewport_height],
        "canvas": [viewport_width, viewport_height],
        "frames": metadata_frames,
    }


def make_preview(output_root: Path, metadata: list[dict[str, object]]) -> None:
    rows = []
    for item in metadata:
        char_dir = output_root / str(item["id"])
        frames = [Image.open(char_dir / f"frame-{idx}.png").convert("RGBA") for idx in range(1, FRAME_COUNT + 1)]
        frame_width = 128
        scaled = []
        for frame in frames:
            ratio = frame_width / frame.width
            scaled.append(frame.resize((frame_width, int(frame.height * ratio)), Image.Resampling.LANCZOS))
        row_height = max(frame.height for frame in scaled)
        row = Image.new("RGBA", (frame_width * FRAME_COUNT, row_height), (255, 255, 255, 0))
        for idx, frame in enumerate(scaled):
            row.alpha_composite(frame, (idx * frame_width, row_height - frame.height))
        rows.append(row)

    preview_width = max(row.width for row in rows)
    preview_height = sum(row.height for row in rows)
    preview = Image.new("RGBA", (preview_width, preview_height), (255, 255, 255, 0))
    y = 0
    for row in rows:
        preview.alpha_composite(row, (0, y))
        y += row.height

    checker = Image.new("RGBA", preview.size, (245, 243, 237, 255))
    draw = ImageDraw.Draw(checker)
    block = 16
    for y in range(0, preview.height, block):
        for x in range(0, preview.width, block):
            if (x // block + y // block) % 2 == 0:
                draw.rectangle((x, y, x + block - 1, y + block - 1), fill=(225, 222, 216, 255))
    checker.alpha_composite(preview)
    checker.save(output_root / "preview-aligned.png")


def update_manifest(output_root: Path) -> None:
    manifest_path = CHARACTER_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for item in manifest["characters"].values():
        char_id = item["id"]
        item["frames"] = [f"./assets/characters/aligned/{char_id}/frame-{idx}.png" for idx in range(1, FRAME_COUNT + 1)]
    out_path = output_root / "manifest.json"
    out_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Remove white backgrounds and align character animation frames.")
    parser.add_argument("--source", type=Path, default=CHARACTER_DIR)
    parser.add_argument("--output", type=Path, default=CHARACTER_DIR / "aligned")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    character_dirs = [
        path
        for path in sorted(args.source.iterdir())
        if path.is_dir() and all((path / f"frame-{idx}.png").exists() for idx in range(1, FRAME_COUNT + 1))
    ]

    config = load_config()
    metadata = [process_character(character_dir, args.output, config) for character_dir in character_dirs]
    (args.output / "alignment.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    update_manifest(args.output)
    make_preview(args.output, metadata)
    print(f"Processed {len(metadata)} characters into {args.output}")


if __name__ == "__main__":
    main()
