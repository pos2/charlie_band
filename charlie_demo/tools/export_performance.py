#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from urllib.parse import unquote, urlparse


BASE_DIR = Path(__file__).resolve().parents[2]
DEMO_DIR = BASE_DIR / "charlie_demo"
DEFAULT_EXPORT_DIR = DEMO_DIR / "public_export"

STATIC_FILES = [
    "performance.html",
    "performance.css",
    "styles.css",
    "performance.js",
]


def safe_name(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return name or "track"


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".DS_Store"))


def local_audio_path(audio: str) -> Path:
    parsed = urlparse(audio)
    if parsed.scheme in {"http", "https"}:
        match = re.search(r"/api/pipeline/([^/]+)/files/compressed/(.+)$", parsed.path)
        if match:
            job_id = match.group(1)
            filename = unquote(match.group(2))
            return BASE_DIR / "pipeline_jobs" / job_id / "compressed" / filename
        raise ValueError(f"Cannot map remote audio URL to local file: {audio}")

    path = Path(unquote(audio))
    if path.is_absolute():
        return path
    return (DEMO_DIR / path).resolve()


def source_job_id(config: dict) -> str | None:
    if config.get("sourceJobId"):
        return str(config["sourceJobId"])
    for track in config.get("tracks", []):
        match = re.search(r"/api/pipeline/([^/]+)/", str(track.get("audio", "")))
        if match:
            return match.group(1)
    return None


def weeknd_voice_switch(job_id: str | None) -> dict | None:
    if not job_id:
        return None
    compressed_dir = BASE_DIR / "pipeline_jobs" / job_id / "compressed"
    if not compressed_dir.exists():
        return None
    candidates = sorted(compressed_dir.glob("*Vocals*weeknd*.mp3"))
    if not candidates:
        return None
    return {
        "label": "weeknd",
        "value": "weeknd.pth",
        "audio": str(candidates[0]),
        "characterId": "vocal_cos_weeknd",
        "character": "Weeknd Bag Charlie",
        "role": "Vocal",
    }


def prepare_static_shell(export_dir: Path) -> None:
    export_dir.mkdir(parents=True, exist_ok=True)
    for filename in STATIC_FILES:
        shutil.copy2(DEMO_DIR / filename, export_dir / filename)
    (export_dir / "app-config.js").write_text('window.CHARLIE_BAND_API_BASE = "";\n', encoding="utf-8")
    copy_tree(DEMO_DIR / "assets", export_dir / "assets")
    (export_dir / "performances").mkdir(parents=True, exist_ok=True)
    (export_dir / "media").mkdir(parents=True, exist_ok=True)


def export_performance(performance_id: str, export_dir: Path) -> Path:
    source_json = DEMO_DIR / "performances" / f"{performance_id}.json"
    if not source_json.exists():
        raise FileNotFoundError(f"Performance config not found: {source_json}")

    prepare_static_shell(export_dir)

    config = json.loads(source_json.read_text(encoding="utf-8"))
    original_job_id = source_job_id(config)
    media_dir = export_dir / "media" / performance_id
    media_dir.mkdir(parents=True, exist_ok=True)

    used_names: set[str] = set()
    copied_by_source: dict[str, str] = {}

    def rewrite_audio(item: dict, index: int, label: str) -> None:
        source_audio = local_audio_path(item["audio"])
        if not source_audio.exists():
            raise FileNotFoundError(f"Audio file not found for {label}: {source_audio}")
        source_key = str(source_audio.resolve())
        if source_key in copied_by_source:
            item["audio"] = copied_by_source[source_key]
            return

        stem = safe_name(label)
        suffix = source_audio.suffix or ".mp3"
        filename = f"{index:02d}-{stem}{suffix}"
        while filename in used_names:
            filename = f"{index:02d}-{stem}-{len(used_names)}{suffix}"
        used_names.add(filename)

        shutil.copy2(source_audio, media_dir / filename)
        item["audio"] = f"./media/{performance_id}/{filename}"
        copied_by_source[source_key] = item["audio"]

    for index, track in enumerate(config.get("tracks", []), start=1):
        rewrite_audio(track, index, track.get("stem") or track.get("role") or f"track-{index}")

    switch_offset = len(config.get("tracks", []))
    for index, cue in enumerate(config.get("switches", []), start=1):
        if cue.get("audio"):
            rewrite_audio(cue, switch_offset + index, f"{cue.get('stem') or 'switch'}-{cue.get('rvcModel') or 'cue'}")

    voice_switches = []
    existing_voice_switches = list(config.get("voiceSwitches", []))
    generated_weeknd = weeknd_voice_switch(original_job_id)
    if generated_weeknd:
        existing_voice_switches = [
            item for item in existing_voice_switches if "weeknd" not in f"{item.get('label', '')} {item.get('value', '')}".lower()
        ]
        existing_voice_switches.append(generated_weeknd)

    for index, item in enumerate(existing_voice_switches, start=1):
        if item.get("audio") or item.get("url"):
            if not item.get("audio"):
                item["audio"] = item["url"]
            rewrite_audio(item, switch_offset + len(config.get("switches", [])) + index, f"voice-{item.get('value') or item.get('label') or 'switch'}")
            item["url"] = item.pop("audio")
            voice_switches.append(item)
    if voice_switches:
        config["voiceSwitches"] = voice_switches

    target_json = export_dir / "performances" / f"{performance_id}.json"
    target_json.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    return target_json


def main() -> None:
    parser = argparse.ArgumentParser(description="Export one Charlie band performance as static web assets.")
    parser.add_argument("performance_id", help="ID from charlie_demo/performances/{id}.json")
    parser.add_argument("--export-dir", default=str(DEFAULT_EXPORT_DIR), help="Static export directory")
    args = parser.parse_args()

    export_dir = Path(args.export_dir).resolve()
    target_json = export_performance(args.performance_id, export_dir)
    print(f"Exported {args.performance_id}")
    print(f"Directory: {export_dir}")
    print(f"Config: {target_json}")
    print(f"URL path: /performance.html?id={args.performance_id}")


if __name__ == "__main__":
    main()
