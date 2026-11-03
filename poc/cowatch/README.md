# co-watch poc (task #1261)

the agent watches a video *with* you: frames + the tab's own audio, not a transcript from the site.

1. `capture.mjs <url> <out> [secs] [startAt]`: headless chromium (never the user's olive). plays the page's `<video>`,
   samples ~1 frame/s, keeps a frame on scene change (mean luma diff of a 32x18 thumbnail > `CW_SCENE`, default 0.03)
   or every 15 s, records the element's audio (`video.captureStream()` -> MediaRecorder, opus), and saves page
   title/url/text/selection/scroll. youtube: the watch page shows "something went wrong" headless, so use the embed
   player (`youtube-nocookie.com/embed/<id>`) with a referer (default https://reframe.so/). `CW_CHANNEL=chromium` = new headless.
2. transcribe locally: `ffmpeg -i out/audio.webm -ar 16000 -ac 1 out/audio.wav && mlx_whisper out/audio.wav --model mlx-community/whisper-small.en-mlx --output-format json --output-dir out`
3. `ask.mjs <out> "<question>" [windowS] [identityFile]`: one turn = identity block + page + timestamped transcript +
   kept frames (image files the model reads), last `windowS` seconds, through `claude -p --model opus`.

proof (2026-11-03, karpathy "intro to large language models", embed player): `proof/run1-*` (10:01-11:16, 75 s,
5 frames kept of 75 sampled, answer in 13 s, $0.15) and `proof/run2-*` (21:01-22:31, 90 s, 7 of 90 kept, 3 scene
changes, 12 s, $0.13). run1's answer read "blacknose dace" off the slide and flagged whisper's "black nose days".
