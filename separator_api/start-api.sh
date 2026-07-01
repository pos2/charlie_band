#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
exec ../.venv-audio-separator/bin/python app.py
