# Snapchat Image & Video Downloader (HD)

Userscript that adds a download button to images and videos on
`snapchat.com`.

## Install

Requires a userscript manager: [Tampermonkey](https://www.tampermonkey.net/),
[Violentmonkey](https://violentmonkey.github.io/), or Firefox's built-in
Greasemonkey support.

1. Install a userscript manager extension.
2. Create a new script and paste the contents of `snapdl.js`, or import the
   file directly.
3. Open `snapchat.com` — a download button appears on every image/video.

## Features

- **Download button** on every image and video in the conversation.
- **Bulk download**: once 2+ media are detected, a floating "Download all"
  button appears and downloads every one of them, staggered to avoid the
  browser's multi-download prompt/block.
- **Double-click** an image/video as a shortcut to download it.
- Detects the real content type (mp4/webm/etc.) from the response so files
  get the correct extension.
- Files are saved through the browser's native download manager
  (`<a download>`), byte-for-byte — original resolution, codec and
  container, never re-encoded or converted.
- Filenames include the conversation name and original send date when
  available.
- 13 languages for the UI (English, French, Spanish, German, Portuguese,
  Russian, Chinese, Hindi, Arabic, Japanese, Korean, Bengali, Italian,
  Indonesian).

## Browser support

Tested on Firefox and Chrome-based browsers.
