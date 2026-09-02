# Charlie Band

Charlie Band is a local audio-to-performance prototype. It separates an input song into stems, converts the vocal stem with an RVC model, and drives a browser-based cartoon band where each character reacts to its own audio track.

The repository is intended to store the application code only. Large generated assets, model weights, separated audio, converted vocals, and exported performances are kept out of Git.

## What It Does

- Upload an audio file from the maker page.
- Separate the audio into stems with `python-audio-separator`.
- Filter nearly silent stems and compress usable tracks to MP3.
- Convert the vocal stem through an installed RVC model.
- Build an editable band stage with per-track volume, activity threshold, position, and character scale.
- Save a performance URL for playback.
- Export a static performance bundle for VPS hosting.

## Project Layout

```text
audio_pipeline/        Audio separation, silence detection, compression, and RVC orchestration
separator_api/         FastAPI backend for processing, model management, performances, and alignment
charlie_demo/          Frontend pages and browser playback logic
charlie_demo/tools/    Character frame processing and static export helpers
```

Ignored local data includes:

```text
Retrieval-based-Voice-Conversion-WebUI/
audio-separator-models/
pipeline_jobs/
pipeline_uploads/
separator_jobs/
separator_output/
RVC_input/
RVC_output/
characters/
charlie_demo/performances/
charlie_demo/public_export/
charlie_demo/assets/characters/
charlie_demo/assets/ui/toggles/
charlie_demo/assets/background/
```

## Local Requirements

This project expects these local dependencies to exist beside the code:

- RVC WebUI cloned at `Retrieval-based-Voice-Conversion-WebUI/`
- RVC virtual environment at `Retrieval-based-Voice-Conversion-WebUI/.venv/`
- `convert_cli.py` inside the RVC WebUI directory
- `python-audio-separator` installed in `.venv-audio-separator/`
- Separator model cache in `audio-separator-models/`
- Character source sheets in `characters/`
- Processed character frames under `charlie_demo/assets/characters/`

Those files are intentionally not committed because they are large, generated, machine-specific, or copyrighted/source assets.

## Run Locally

Start the API:

```sh
cd /Users/pos2/Documents/audio
/Users/pos2/Documents/audio/.venv-audio-separator/bin/python -m uvicorn separator_api.app:app --host 127.0.0.1 --port 8787
```

Start the frontend:

```sh
cd /Users/pos2/Documents/audio/charlie_demo
python3 -m http.server 8790 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8790/index.html
```

Useful pages:

```text
http://127.0.0.1:8790/make.html
http://127.0.0.1:8790/manage.html
http://127.0.0.1:8790/align.html
```

## RVC Models

Install `.pth` model files into:

```text
Retrieval-based-Voice-Conversion-WebUI/assets/weights/
```

Install matching `.index` files under:

```text
Retrieval-based-Voice-Conversion-WebUI/logs/<model-name>/
```

The backend exposes model listing, folder import, deletion, and cached vocal revoice endpoints through `separator_api/app.py`.

## Character Assets

Character source sheets live in `characters/`. Processed animation frames are generated into:

```text
charlie_demo/assets/characters/aligned/<character-id>/frame-1.png
```

Use the alignment page to manually align frames:

```text
http://127.0.0.1:8790/align.html
```

Then regenerate aligned assets through the API or the frame processing script.

## Static Export

To export a saved performance for static hosting:

```sh
cd /Users/pos2/Documents/audio
python3 charlie_demo/tools/export_performance.py <performance_id>
```

The export is written to:

```text
charlie_demo/public_export/
```

The export helper copies the required performance JSON, media files, frontend files, and static assets. It also records cached voice-switch audio when available.

## VPS Publishing

Configure `charlie_demo/deploy.env` with your remote target, then run:

```sh
cd /Users/pos2/Documents/audio/charlie_demo
./publish_performance.sh <performance_id>
```

The intended VPS setup is static hosting, for example behind Caddy. Audio processing remains local because separation and RVC inference are too heavy for a small VPS.

## Git Notes

Before committing, always check that no models or generated audio are staged:

```sh
git status --short
git diff --cached --stat
```

The root `.gitignore` is set up to exclude large runtime data and media outputs.
