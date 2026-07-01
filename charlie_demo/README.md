# Charlie Motion Demo

This demo turns six cropped character frames into an audio-reactive loop.

Run it from this directory:

```sh
python3 -m http.server 8790
```

Open:

```text
http://127.0.0.1:8790/
```

The page uses `assets/audio/jfzj_charlie_brown.mp3` by default. It also accepts any local audio file through the file input. While audio is playing, the browser measures RMS volume through Web Audio. When the smoothed level is above the threshold, it cycles through the six frames; when the level drops below the threshold, it returns to the still frame.
