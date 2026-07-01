#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from pipeline import process_audio_file


def main() -> None:
    parser = argparse.ArgumentParser(description="Separate, clean, compress, and RVC-convert an audio file.")
    parser.add_argument("input", help="Input audio path")
    parser.add_argument("--job-id", default=None, help="Optional stable job id")
    parser.add_argument("--separator-model", default="htdemucs_6s.yaml")
    parser.add_argument("--rvc-model", default="Charlie Brown.pth")
    args = parser.parse_args()

    result = process_audio_file(
        Path(args.input).expanduser().resolve(),
        separator_model=args.separator_model,
        rvc_model=args.rvc_model,
        job_id=args.job_id,
    )
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
