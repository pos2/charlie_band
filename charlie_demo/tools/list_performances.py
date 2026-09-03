#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[2]
DEMO_DIR = BASE_DIR / "charlie_demo"
PERFORMANCE_DIR = DEMO_DIR / "performances"
EXPORT_PERFORMANCE_DIR = DEMO_DIR / "public_export" / "performances"
PIPELINE_JOBS_DIR = BASE_DIR / "pipeline_jobs"
PUBLIC_BASE_URL = "https://band.pos2.fun"


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def source_job_id(config: dict) -> str:
    if config.get("sourceJobId"):
        return str(config["sourceJobId"])
    for track in config.get("tracks", []):
        match = re.search(r"/api/pipeline/([^/]+)/", str(track.get("audio", "")))
        if match:
            return match.group(1)
    return ""


def manifest_input_name(job_id: str) -> str:
    if not job_id:
        return ""
    manifest_path = PIPELINE_JOBS_DIR / job_id / "manifest.json"
    if not manifest_path.exists():
        return ""
    manifest = read_json(manifest_path)
    input_path = manifest.get("input_path") or ""
    return Path(input_path).name if input_path else ""


def infer_name_from_tracks(config: dict) -> str:
    for track in config.get("tracks", []):
        audio = str(track.get("audio", ""))
        if "/compressed/" not in audio:
            continue
        filename = audio.rsplit("/compressed/", 1)[-1]
        return filename.split("_(", 1)[0] or filename
    return ""


def display_name(config: dict) -> str:
    for key in ("inputName", "input_name", "sourceName", "title"):
        if config.get(key):
            return str(config[key])
    job_id = source_job_id(config)
    return manifest_input_name(job_id) or infer_name_from_tracks(config) or "(unknown source)"


def main() -> None:
    exported_ids = {path.stem for path in EXPORT_PERFORMANCE_DIR.glob("*.json")} if EXPORT_PERFORMANCE_DIR.exists() else set()
    rows = []
    for path in sorted(PERFORMANCE_DIR.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        config = read_json(path)
        performance_id = path.stem
        exported = performance_id in exported_ids
        rows.append(
            {
                "id": performance_id,
                "name": display_name(config),
                "job": source_job_id(config),
                "exported": exported,
                "url": f"{PUBLIC_BASE_URL}/performance.html?id={performance_id}" if exported else "",
            }
        )

    if not rows:
        print("No performances found.")
        return

    print("STATUS      PERFORMANCE ID   SOURCE")
    print("----------  ---------------  ------")
    for row in rows:
        status = "exported" if row["exported"] else "local-only"
        print(f"{status:<10}  {row['id']:<15}  {row['name']}")
        if row["exported"]:
            print(f"{'':<10}  {'':<15}  {row['url']}")


if __name__ == "__main__":
    main()
