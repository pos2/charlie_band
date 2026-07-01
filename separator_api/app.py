from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from audio_pipeline.pipeline import PIPELINE_JOBS_DIR, compress_audio, convert_vocals_with_rvc, process_audio_file

VENV_DIR = BASE_DIR / ".venv-audio-separator"
SEPARATOR_BIN = VENV_DIR / "bin" / "audio-separator"
MODEL_DIR = BASE_DIR / "audio-separator-models"
JOB_DIR = BASE_DIR / "separator_jobs"
PIPELINE_UPLOAD_DIR = BASE_DIR / "pipeline_uploads"
ALIGNMENT_CONFIG_PATH = BASE_DIR / "charlie_demo" / "assets" / "characters" / "alignment_config.json"
ALIGNMENT_SCRIPT_PATH = BASE_DIR / "charlie_demo" / "tools" / "process_character_frames.py"
STAGE_CONFIG_PATH = BASE_DIR / "charlie_demo" / "stage_config.json"
PERFORMANCE_DIR = BASE_DIR / "charlie_demo" / "performances"
RVC_WEIGHTS_DIR = BASE_DIR / "Retrieval-based-Voice-Conversion-WebUI" / "assets" / "weights"
DEFAULT_MODEL = "htdemucs_6s.yaml"
DEFAULT_OUTPUT_FORMAT = "WAV"
DEFAULT_RVC_MODEL = "Charlie Brown.pth"


app = FastAPI(title="Audio Pipeline API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StemFile(BaseModel):
    name: str
    filename: str
    path: str
    url: str
    size_bytes: int


class SeparationResult(BaseModel):
    job_id: str
    model: str
    input_path: str
    output_dir: str
    stems: list[StemFile]
    log: str


class ProcessResult(BaseModel):
    job_id: str
    input_path: str
    output_dir: str
    separator_model: str
    rvc_model: str
    stems: list[dict[str, Any]]
    vocals_source_wav: str | None
    rvc_wav_path: str | None
    rvc_compressed_path: str | None
    animation_audio_path: str | None
    manifest_path: str
    urls: dict[str, str]


class RevoiceResult(BaseModel):
    job_id: str
    rvc_model: str
    rvc_compressed_path: str
    animation_audio_path: str
    url: str
    cached: bool


def _safe_filename(filename: str) -> str:
    name = Path(filename or "input_audio").name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .")
    return name or "input_audio"


def _stem_label(path: Path) -> str:
    match = re.search(r"_\(([^)]+)\)_", path.name)
    if match:
        return match.group(1)
    return path.stem


def _read_alignment_config() -> dict[str, Any]:
    if not ALIGNMENT_CONFIG_PATH.exists():
        return {"defaults": {}, "characters": {}}
    import json

    return json.loads(ALIGNMENT_CONFIG_PATH.read_text(encoding="utf-8"))


def _write_alignment_config(config: dict[str, Any]) -> None:
    import json

    ALIGNMENT_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    ALIGNMENT_CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_stage_config() -> dict[str, Any]:
    if not STAGE_CONFIG_PATH.exists():
        return {"tracks": {}}
    import json

    return json.loads(STAGE_CONFIG_PATH.read_text(encoding="utf-8"))


def _write_stage_config(config: dict[str, Any]) -> None:
    import json

    STAGE_CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def _performance_path(performance_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", performance_id):
        raise HTTPException(status_code=404, detail="performance not found")
    return PERFORMANCE_DIR / f"{performance_id}.json"


def _rvc_model_path(model: str) -> Path:
    if not re.fullmatch(r"[^/\\]+\.pth", model or ""):
        raise HTTPException(status_code=400, detail="invalid RVC model")
    path = RVC_WEIGHTS_DIR / model
    if not path.exists():
        raise HTTPException(status_code=400, detail=f"RVC model is not installed: {model}")
    return path


def _safe_model_label(model: str) -> str:
    label = Path(model).stem
    label = re.sub(r"[^A-Za-z0-9._-]+", "_", label).strip("._-")
    return label or "rvc"


def _source_job_from_tracks(tracks: list[dict[str, Any]]) -> str | None:
    for track in tracks:
        match = re.search(r"/api/pipeline/([^/]+)/", str(track.get("audio", "")))
        if match:
            return match.group(1)
    return None


def _input_name_from_manifest(manifest: dict[str, Any]) -> str | None:
    input_path = manifest.get("input_path")
    return Path(input_path).name if input_path else None


def _job_path(job_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", job_id):
        raise HTTPException(status_code=404, detail="job not found")
    path = (PIPELINE_JOBS_DIR / job_id).resolve()
    root = PIPELINE_JOBS_DIR.resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=404, detail="job not found")
    return path


def _read_json(path: Path) -> dict[str, Any]:
    import json

    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: dict[str, Any]) -> None:
    import json

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _pipeline_manifest(job_id: str) -> tuple[Path, dict[str, Any]]:
    job_dir = _job_path(job_id)
    manifest_path = job_dir / "manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="pipeline manifest not found")
    return manifest_path, _read_json(manifest_path)


def _pipeline_file_url(job_id: str, path: Path) -> str:
    job_dir = _job_path(job_id).resolve()
    resolved = path.resolve()
    if job_dir not in resolved.parents:
        raise HTTPException(status_code=500, detail="pipeline file is outside job directory")
    relative = resolved.relative_to(job_dir)
    return f"/api/pipeline/{job_id}/files/{relative.as_posix()}"


def _vocals_source_for_job(job_id: str, manifest: dict[str, Any]) -> Path:
    for stem in manifest.get("stems", []):
        if str(stem.get("name", "")).lower() == "vocals" and stem.get("compressed_path"):
            path = Path(stem["compressed_path"])
            if path.exists():
                return path
    raise HTTPException(status_code=404, detail="compressed vocals stem not found")


def _rvc_output_candidates(vocals_audio: Path, rvc_model: str) -> list[Path]:
    compressed_dir = vocals_audio.parent
    model_label = _safe_model_label(rvc_model)
    candidates = [compressed_dir / f"{vocals_audio.stem}_{model_label}.mp3"]
    if Path(rvc_model).name == DEFAULT_RVC_MODEL:
        legacy = compressed_dir / f"{vocals_audio.stem}_charlie.mp3"
        if legacy not in candidates:
            candidates.append(legacy)
    return candidates


def _list_rvc_models() -> list[dict[str, Any]]:
    models = []
    for path in sorted(RVC_WEIGHTS_DIR.glob("*.pth"), key=lambda item: item.name.lower()):
        label = path.stem
        index_dir = BASE_DIR / "Retrieval-based-Voice-Conversion-WebUI" / "logs" / label
        has_index = index_dir.exists() and any(index_dir.glob("*.index"))
        models.append(
            {
                "label": label,
                "value": path.name,
                "path": str(path),
                "has_index": has_index,
                "default": path.name == DEFAULT_RVC_MODEL,
            }
        )
    return models


def _assert_ready() -> None:
    if not SEPARATOR_BIN.exists():
        raise HTTPException(status_code=500, detail=f"audio-separator not found: {SEPARATOR_BIN}")
    if not (MODEL_DIR / DEFAULT_MODEL).exists():
        raise HTTPException(status_code=500, detail=f"model is not cached: {MODEL_DIR / DEFAULT_MODEL}")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "separator_bin": str(SEPARATOR_BIN),
        "model_dir": str(MODEL_DIR),
        "default_model": DEFAULT_MODEL,
        "default_model_cached": (MODEL_DIR / DEFAULT_MODEL).exists(),
    }


@app.get("/api/rvc/models")
def rvc_models() -> dict[str, Any]:
    return {"default": DEFAULT_RVC_MODEL, "models": _list_rvc_models()}


@app.post("/api/rvc/models/import-folder")
def import_rvc_model_folder(folder_path: str = Form(...)) -> dict[str, Any]:
    source_dir = Path(folder_path).expanduser().resolve()
    if not source_dir.exists() or not source_dir.is_dir():
        raise HTTPException(status_code=400, detail="model folder not found")

    pth_files = sorted(source_dir.glob("*.pth"))
    index_files = sorted(source_dir.glob("*.index"))
    if not pth_files:
        raise HTTPException(status_code=400, detail="no .pth file found in model folder")

    imported = []
    for pth_path in pth_files:
        model_name = pth_path.name
        model_label = pth_path.stem
        target_pth = RVC_WEIGHTS_DIR / model_name
        target_pth.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(pth_path, target_pth)

        copied_index = None
        if index_files:
            same_name_index = next((path for path in index_files if path.stem == model_label), index_files[0])
            target_index_dir = BASE_DIR / "Retrieval-based-Voice-Conversion-WebUI" / "logs" / model_label
            target_index_dir.mkdir(parents=True, exist_ok=True)
            target_index = target_index_dir / f"added_{model_label}.index"
            shutil.copy2(same_name_index, target_index)
            copied_index = str(target_index)

        imported.append({"label": model_label, "value": model_name, "path": str(target_pth), "index_path": copied_index})

    return {"ok": True, "imported": imported, "models": _list_rvc_models()}


@app.delete("/api/rvc/models/{model_name}")
def delete_rvc_model(model_name: str) -> dict[str, Any]:
    if model_name == DEFAULT_RVC_MODEL:
        raise HTTPException(status_code=400, detail="default RVC model cannot be deleted")
    path = _rvc_model_path(model_name)
    label = path.stem
    deleted = [str(path)]
    path.unlink()

    index_dir = BASE_DIR / "Retrieval-based-Voice-Conversion-WebUI" / "logs" / label
    if index_dir.exists():
        shutil.rmtree(index_dir)
        deleted.append(str(index_dir))

    return {"ok": True, "model": model_name, "deleted": deleted, "models": _list_rvc_models()}


@app.post("/api/separate", response_model=SeparationResult)
async def separate_audio(
    audio: UploadFile = File(...),
    model: str = Form(DEFAULT_MODEL),
    output_format: str = Form(DEFAULT_OUTPUT_FORMAT),
) -> SeparationResult:
    _assert_ready()

    model_path = MODEL_DIR / model
    if not model_path.exists():
        raise HTTPException(status_code=400, detail=f"model is not cached: {model}")

    job_id = uuid.uuid4().hex
    job_path = JOB_DIR / job_id
    input_dir = job_path / "input"
    output_dir = job_path / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    input_path = input_dir / _safe_filename(audio.filename or "input_audio")
    try:
        with input_path.open("wb") as fh:
            shutil.copyfileobj(audio.file, fh)
    finally:
        await audio.close()

    cmd = [
        str(SEPARATOR_BIN),
        str(input_path),
        "-m",
        model,
        "--model_file_dir",
        str(MODEL_DIR),
        "--output_dir",
        str(output_dir),
        "--output_format",
        output_format,
    ]
    env = os.environ.copy()
    env["AUDIO_SEPARATOR_MODEL_DIR"] = str(MODEL_DIR)

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(BASE_DIR),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to run audio-separator: {exc}") from exc

    log = proc.stdout or ""
    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail={
                "message": "audio separation failed",
                "job_id": job_id,
                "returncode": proc.returncode,
                "log": log[-6000:],
            },
        )

    stems = []
    for output_path in sorted(output_dir.iterdir()):
        if output_path.is_file():
            stems.append(
                StemFile(
                    name=_stem_label(output_path),
                    filename=output_path.name,
                    path=str(output_path),
                    url=f"/api/jobs/{job_id}/files/{output_path.name}",
                    size_bytes=output_path.stat().st_size,
                )
            )

    if not stems:
        raise HTTPException(
            status_code=500,
            detail={"message": "separation finished but no output files were produced", "job_id": job_id, "log": log[-6000:]},
        )

    return SeparationResult(
        job_id=job_id,
        model=model,
        input_path=str(input_path),
        output_dir=str(output_dir),
        stems=stems,
        log=log[-6000:],
    )


@app.post("/api/process", response_model=ProcessResult)
async def process_audio(
    audio: UploadFile = File(...),
    separator_model: str = Form(DEFAULT_MODEL),
    rvc_model: str = Form(DEFAULT_RVC_MODEL),
) -> ProcessResult:
    _rvc_model_path(rvc_model)
    job_id = uuid.uuid4().hex
    upload_dir = PIPELINE_UPLOAD_DIR / job_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    upload_path = upload_dir / _safe_filename(audio.filename or "input_audio")

    try:
        with upload_path.open("wb") as fh:
            shutil.copyfileobj(audio.file, fh)
    finally:
        await audio.close()

    try:
        result = process_audio_file(
            upload_path,
            original_filename=audio.filename,
            separator_model=separator_model,
            rvc_model=rvc_model,
            job_id=job_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    urls: dict[str, str] = {
        "manifest": f"/api/pipeline/{job_id}/files/manifest.json",
    }
    if result.rvc_compressed_path:
        urls["animation_audio"] = f"/api/pipeline/{job_id}/files/compressed/{Path(result.rvc_compressed_path).name}"

    stem_dicts: list[dict[str, Any]] = []
    for stem in result.stems:
        item = stem.__dict__.copy()
        if stem.compressed_path:
            item["url"] = f"/api/pipeline/{job_id}/files/compressed/{Path(stem.compressed_path).name}"
        stem_dicts.append(item)

    return ProcessResult(
        job_id=result.job_id,
        input_path=result.input_path,
        output_dir=result.output_dir,
        separator_model=result.separator_model,
        rvc_model=result.rvc_model,
        stems=stem_dicts,
        vocals_source_wav=result.vocals_source_wav,
        rvc_wav_path=result.rvc_wav_path,
        rvc_compressed_path=result.rvc_compressed_path,
        animation_audio_path=result.animation_audio_path,
        manifest_path=result.manifest_path,
        urls=urls,
    )


@app.post("/api/pipeline/{job_id}/rvc", response_model=RevoiceResult)
def revoice_pipeline_vocals(job_id: str, rvc_model: str = Form(DEFAULT_RVC_MODEL)) -> RevoiceResult:
    _rvc_model_path(rvc_model)
    manifest_path, manifest = _pipeline_manifest(job_id)
    vocals_audio = _vocals_source_for_job(job_id, manifest)
    job_dir = _job_path(job_id)
    rvc_dir = job_dir / "rvc"
    compressed_dir = job_dir / "compressed"
    model_label = _safe_model_label(rvc_model)
    output_wav = rvc_dir / f"{vocals_audio.stem}_{model_label}.wav"
    output_mp3 = compressed_dir / f"{vocals_audio.stem}_{model_label}.mp3"
    cached_path = next((path for path in _rvc_output_candidates(vocals_audio, rvc_model) if path.exists() and path.stat().st_size > 0), None)
    cached = cached_path is not None
    result_mp3 = cached_path or output_mp3

    if not cached:
        try:
            convert_vocals_with_rvc(vocals_audio, output_wav, rvc_model)
            compress_audio(output_wav, output_mp3)
            if output_wav.exists():
                output_wav.unlink()
            result_mp3 = output_mp3
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    manifest["rvc_model"] = rvc_model
    manifest["rvc_wav_path"] = None
    manifest["rvc_compressed_path"] = str(result_mp3)
    manifest["animation_audio_path"] = str(result_mp3)
    _write_json(manifest_path, manifest)

    url = _pipeline_file_url(job_id, result_mp3)
    return RevoiceResult(
        job_id=job_id,
        rvc_model=rvc_model,
        rvc_compressed_path=str(result_mp3),
        animation_audio_path=str(result_mp3),
        url=url,
        cached=cached,
    )


@app.get("/api/pipeline/{job_id}/rvc-variants")
def list_pipeline_rvc_variants(job_id: str) -> dict[str, Any]:
    _, manifest = _pipeline_manifest(job_id)
    vocals_audio = _vocals_source_for_job(job_id, manifest)
    variants = []
    for model in _list_rvc_models():
        model_name = model["value"]
        cached_path = next((path for path in _rvc_output_candidates(vocals_audio, model_name) if path.exists() and path.stat().st_size > 0), None)
        variants.append(
            {
                "label": model["label"],
                "value": model_name,
                "exists": cached_path is not None,
                "path": str(cached_path) if cached_path else None,
                "url": _pipeline_file_url(job_id, cached_path) if cached_path else None,
                "size_bytes": cached_path.stat().st_size if cached_path else None,
            }
        )
    return {"job_id": job_id, "vocals_source": str(vocals_audio), "variants": variants}


@app.get("/api/alignment/config")
def get_alignment_config() -> dict[str, Any]:
    return _read_alignment_config()


@app.post("/api/alignment/config")
async def save_alignment_config(config: dict[str, Any]) -> dict[str, Any]:
    _write_alignment_config(config)
    return {"ok": True, "path": str(ALIGNMENT_CONFIG_PATH)}


@app.post("/api/alignment/process")
def process_alignment_frames() -> dict[str, Any]:
    try:
        output = subprocess.run(
            [str(VENV_DIR / "bin" / "python"), str(ALIGNMENT_SCRIPT_PATH)],
            cwd=str(BASE_DIR),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to run alignment script: {exc}") from exc

    if output.returncode != 0:
        raise HTTPException(status_code=500, detail={"message": "alignment processing failed", "log": output.stdout})

    return {
        "ok": True,
        "log": output.stdout,
        "preview": "/assets/characters/aligned/preview-aligned.png",
        "manifest": "/assets/characters/aligned/manifest.json",
    }


@app.get("/api/stage/config")
def get_stage_config() -> dict[str, Any]:
    return _read_stage_config()


@app.post("/api/stage/config")
async def save_stage_config(config: dict[str, Any]) -> dict[str, Any]:
    _write_stage_config(config)
    return {"ok": True, "path": str(STAGE_CONFIG_PATH)}


@app.post("/api/performances")
async def save_performance(config: dict[str, Any]) -> dict[str, Any]:
    performance_id = config.get("id") or uuid.uuid4().hex[:12]
    path = _performance_path(str(performance_id))
    PERFORMANCE_DIR.mkdir(parents=True, exist_ok=True)
    config["id"] = performance_id
    _write_json(path, config)
    return {
        "ok": True,
        "id": performance_id,
        "path": str(path),
        "url": f"/performance.html?id={performance_id}",
    }


@app.get("/api/performances")
def list_performances() -> dict[str, Any]:
    items = []
    PERFORMANCE_DIR.mkdir(parents=True, exist_ok=True)
    for path in sorted(PERFORMANCE_DIR.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            config = _read_json(path)
        except Exception:
            config = {}
        stat = path.stat()
        source_job_id = config.get("sourceJobId") or _source_job_from_tracks(config.get("tracks", []))
        input_name = None
        if source_job_id:
            try:
                manifest_path = _job_path(source_job_id) / "manifest.json"
                if manifest_path.exists():
                    input_name = _input_name_from_manifest(_read_json(manifest_path))
            except Exception:
                input_name = None
        items.append(
            {
                "id": path.stem,
                "path": str(path),
                "createdAt": config.get("createdAt"),
                "sourceJobId": source_job_id,
                "input_name": input_name,
                "tracks": len(config.get("tracks", [])),
                "updatedAt": stat.st_mtime,
                "size_bytes": stat.st_size,
                "url": f"/performance.html?id={path.stem}",
            }
        )
    return {"performances": items}


@app.get("/api/performances/{performance_id}")
def get_performance(performance_id: str) -> dict[str, Any]:
    path = _performance_path(performance_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="performance not found")
    return _read_json(path)


@app.delete("/api/performances/{performance_id}")
def delete_performance(performance_id: str) -> dict[str, Any]:
    path = _performance_path(performance_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="performance not found")
    path.unlink()
    return {"ok": True, "id": performance_id}


@app.get("/api/pipeline/jobs")
def list_pipeline_jobs() -> dict[str, Any]:
    jobs = []
    PIPELINE_JOBS_DIR.mkdir(parents=True, exist_ok=True)
    for job_dir in sorted((path for path in PIPELINE_JOBS_DIR.iterdir() if path.is_dir()), key=lambda item: item.stat().st_mtime, reverse=True):
        manifest_path = job_dir / "manifest.json"
        manifest: dict[str, Any] = {}
        if manifest_path.exists():
            try:
                manifest = _read_json(manifest_path)
            except Exception:
                manifest = {}
        size_bytes = sum(path.stat().st_size for path in job_dir.rglob("*") if path.is_file())
        jobs.append(
            {
                "id": job_dir.name,
                "path": str(job_dir),
                "input_path": manifest.get("input_path"),
                "input_name": _input_name_from_manifest(manifest),
                "separator_model": manifest.get("separator_model"),
                "rvc_model": manifest.get("rvc_model"),
                "tracks": len(manifest.get("stems", [])),
                "updatedAt": job_dir.stat().st_mtime,
                "size_bytes": size_bytes,
                "has_manifest": manifest_path.exists(),
            }
        )
    return {"jobs": jobs}


@app.delete("/api/pipeline/jobs/{job_id}")
def delete_pipeline_job(job_id: str) -> dict[str, Any]:
    job_dir = _job_path(job_id)
    upload_dir = PIPELINE_UPLOAD_DIR / job_id
    deleted = []
    if job_dir.exists():
        shutil.rmtree(job_dir)
        deleted.append(str(job_dir))
    if upload_dir.exists():
        shutil.rmtree(upload_dir)
        deleted.append(str(upload_dir))
    if not deleted:
        raise HTTPException(status_code=404, detail="job not found")
    return {"ok": True, "id": job_id, "deleted": deleted}


@app.get("/api/jobs/{job_id}/files/{filename}")
def download_job_file(job_id: str, filename: str) -> FileResponse:
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(status_code=404, detail="job not found")
    file_path = (JOB_DIR / job_id / "output" / Path(filename).name).resolve()
    output_root = (JOB_DIR / job_id / "output").resolve()
    if output_root not in file_path.parents or not file_path.exists():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(file_path, filename=file_path.name)


@app.get("/api/pipeline/{job_id}/files/{filename}")
def download_pipeline_manifest(job_id: str, filename: str) -> FileResponse:
    return _download_pipeline_file(job_id, "", filename)


@app.get("/api/pipeline/{job_id}/files/{section}/{filename}")
def download_pipeline_file(job_id: str, section: str, filename: str) -> FileResponse:
    return _download_pipeline_file(job_id, section, filename)


def _download_pipeline_file(job_id: str, section: str, filename: str) -> FileResponse:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", job_id):
        raise HTTPException(status_code=404, detail="job not found")
    if section and section not in {"compressed", "rvc", "stems_wav"}:
        raise HTTPException(status_code=404, detail="file not found")

    root = (PIPELINE_JOBS_DIR / job_id / section).resolve()
    file_path = (root / Path(filename).name).resolve()
    if not file_path.exists() or root not in file_path.parents and file_path.parent != root:
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(file_path, filename=file_path.name)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8787"))
    uvicorn.run("app:app", host="127.0.0.1", port=port, reload=False)
