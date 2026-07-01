from __future__ import annotations

import json
import math
import os
import re
import shutil
import struct
import subprocess
import uuid
import wave
from dataclasses import asdict, dataclass
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
AUDIO_SEPARATOR_BIN = BASE_DIR / ".venv-audio-separator" / "bin" / "audio-separator"
SEPARATOR_MODEL_DIR = BASE_DIR / "audio-separator-models"
DEFAULT_SEPARATOR_MODEL = "htdemucs_6s.yaml"
RVC_DIR = BASE_DIR / "Retrieval-based-Voice-Conversion-WebUI"
RVC_PYTHON = RVC_DIR / ".venv" / "bin" / "python"
RVC_CONVERT = RVC_DIR / "convert_cli.py"
DEFAULT_RVC_MODEL = "Charlie Brown.pth"
PIPELINE_JOBS_DIR = BASE_DIR / "pipeline_jobs"

MP3_BITRATE = "192k"
SILENT_RMS_THRESHOLD = 0.0035
SILENT_PEAK_THRESHOLD = 0.02


@dataclass
class StemInfo:
    name: str
    wav_path: str
    compressed_path: str | None
    duration_seconds: float
    rms: float
    peak: float
    dbfs: float
    silent: bool
    deleted: bool
    compressed_size_bytes: int | None


@dataclass
class PipelineResult:
    job_id: str
    input_path: str
    output_dir: str
    separator_model: str
    rvc_model: str
    stems: list[StemInfo]
    vocals_source_wav: str | None
    rvc_wav_path: str | None
    rvc_compressed_path: str | None
    animation_audio_path: str | None
    manifest_path: str


def _safe_filename(filename: str) -> str:
    name = Path(filename or "input_audio").name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .")
    return name or "input_audio"


def _stem_name(path: Path) -> str:
    match = re.search(r"_\(([^)]+)\)_", path.name)
    if match:
        return match.group(1)
    return path.stem


def _safe_model_label(model: str) -> str:
    label = Path(model).stem
    label = re.sub(r"[^A-Za-z0-9._-]+", "_", label).strip("._-")
    return label or "rvc"


def _run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd or BASE_DIR),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stdout}")
    return proc.stdout


def _assert_ready(separator_model: str, rvc_model: str) -> None:
    required_paths = [
        AUDIO_SEPARATOR_BIN,
        SEPARATOR_MODEL_DIR / separator_model,
        RVC_PYTHON,
        RVC_CONVERT,
        RVC_DIR / "assets" / "weights" / rvc_model,
    ]
    missing = [str(path) for path in required_paths if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing required files:\n" + "\n".join(missing))


def analyze_wav(path: Path) -> tuple[float, float, float, float, bool]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        frame_rate = wav.getframerate()
        total_frames = wav.getnframes()
        duration = total_frames / frame_rate if frame_rate else 0.0
        raw = wav.readframes(total_frames)

    if not raw or sample_width != 2:
        return duration, 0.0, 0.0, -120.0, True

    count = len(raw) // sample_width
    samples = struct.unpack("<" + "h" * count, raw)
    if channels > 1:
        mono_samples = []
        for idx in range(0, len(samples), channels):
            mono_samples.append(sum(samples[idx : idx + channels]) / channels)
    else:
        mono_samples = samples

    if not mono_samples:
        return duration, 0.0, 0.0, -120.0, True

    peak = max(abs(value) for value in mono_samples) / 32768.0
    rms = math.sqrt(sum((value / 32768.0) ** 2 for value in mono_samples) / len(mono_samples))
    dbfs = 20 * math.log10(max(rms, 1e-6))
    silent = rms < SILENT_RMS_THRESHOLD
    return duration, rms, peak, dbfs, silent


def compress_audio(input_path: Path, output_path: Path, bitrate: str = MP3_BITRATE) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-map",
            "0:a:0",
            "-ar",
            "44100",
            "-b:a",
            bitrate,
            str(output_path),
        ]
    )


def separate_audio(input_path: Path, output_dir: Path, model: str) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["AUDIO_SEPARATOR_MODEL_DIR"] = str(SEPARATOR_MODEL_DIR)
    return _run(
        [
            str(AUDIO_SEPARATOR_BIN),
            str(input_path),
            "-m",
            model,
            "--model_file_dir",
            str(SEPARATOR_MODEL_DIR),
            "--output_dir",
            str(output_dir),
            "--output_format",
            "WAV",
        ],
        env=env,
    )


def convert_vocals_with_rvc(input_path: Path, output_path: Path, rvc_model: str) -> str:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    return _run(
        [
            str(RVC_PYTHON),
            str(RVC_CONVERT),
            str(input_path),
            str(output_path),
            "--model",
            rvc_model,
            "--f0-method",
            "rmvpe",
        ],
        cwd=RVC_DIR,
    )


def process_audio_file(
    source_path: Path,
    *,
    original_filename: str | None = None,
    separator_model: str = DEFAULT_SEPARATOR_MODEL,
    rvc_model: str = DEFAULT_RVC_MODEL,
    job_id: str | None = None,
) -> PipelineResult:
    _assert_ready(separator_model, rvc_model)

    job_id = job_id or uuid.uuid4().hex
    job_dir = PIPELINE_JOBS_DIR / job_id
    input_dir = job_dir / "input"
    stems_wav_dir = job_dir / "stems_wav"
    compressed_dir = job_dir / "compressed"
    rvc_dir = job_dir / "rvc"
    input_dir.mkdir(parents=True, exist_ok=True)

    input_path = input_dir / _safe_filename(original_filename or source_path.name)
    if source_path.resolve() != input_path.resolve():
        shutil.copy2(source_path, input_path)

    separate_audio(input_path, stems_wav_dir, separator_model)

    stems: list[StemInfo] = []
    vocals_source_wav: Path | None = None

    for wav_path in sorted(stems_wav_dir.glob("*.wav")):
        name = _stem_name(wav_path)
        duration, rms, peak, dbfs, silent = analyze_wav(wav_path)
        compressed_path: Path | None = None
        deleted = False
        compressed_size: int | None = None

        if silent:
            wav_path.unlink()
            deleted = True
        else:
            compressed_path = compressed_dir / f"{wav_path.stem}.mp3"
            compress_audio(wav_path, compressed_path)
            compressed_size = compressed_path.stat().st_size
            if name.lower() == "vocals":
                vocals_source_wav = wav_path

        stems.append(
            StemInfo(
                name=name,
                wav_path=str(wav_path),
                compressed_path=str(compressed_path) if compressed_path else None,
                duration_seconds=duration,
                rms=rms,
                peak=peak,
                dbfs=dbfs,
                silent=silent,
                deleted=deleted,
                compressed_size_bytes=compressed_size,
            )
        )

    rvc_wav_path: Path | None = None
    rvc_compressed_path: Path | None = None
    if vocals_source_wav:
        rvc_label = _safe_model_label(rvc_model)
        rvc_wav_path = rvc_dir / f"{vocals_source_wav.stem}_{rvc_label}.wav"
        convert_vocals_with_rvc(vocals_source_wav, rvc_wav_path, rvc_model)
        rvc_compressed_path = compressed_dir / f"{vocals_source_wav.stem}_{rvc_label}.mp3"
        compress_audio(rvc_wav_path, rvc_compressed_path)
        rvc_wav_path.unlink()

    for stem in stems:
        if not stem.silent and stem.wav_path:
            wav_path = Path(stem.wav_path)
            if wav_path.exists():
                wav_path.unlink()
                stem.deleted = True

    manifest = PipelineResult(
        job_id=job_id,
        input_path=str(input_path),
        output_dir=str(job_dir),
        separator_model=separator_model,
        rvc_model=rvc_model,
        stems=stems,
        vocals_source_wav=str(vocals_source_wav) if vocals_source_wav else None,
        rvc_wav_path=str(rvc_wav_path) if rvc_wav_path and rvc_wav_path.exists() else None,
        rvc_compressed_path=str(rvc_compressed_path) if rvc_compressed_path else None,
        animation_audio_path=str(rvc_compressed_path) if rvc_compressed_path else None,
        manifest_path=str(job_dir / "manifest.json"),
    )
    manifest_path = Path(manifest.manifest_path)
    manifest_path.write_text(json.dumps(asdict(manifest), ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest
