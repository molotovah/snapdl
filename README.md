# Snapchat Image & Video Downloader (HD)

Userscript that adds a download button to images and videos on
`snapchat.com`, and lets you merge multi-part (split) videos into one file.

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
- **Double-click** an image/video as a shortcut to download it.
- Detects the real content type (mp4/webm/etc.) from the response so files
  get the correct extension.
- Filenames include the conversation name and original send date when
  available.
- **Video merge**: for videos Snapchat has split into multiple parts, a
  floating panel lists every captured part (thumbnail + size) with a
  checkbox, so you can pick exactly which ones to merge into a single file
  and download it.
- 13 languages for the UI (English, French, Spanish, German, Portuguese,
  Russian, Chinese, Hindi, Arabic, Japanese, Korean, Bengali, Italian,
  Indonesian).

## How video merge works

Split video parts are captured (fetched) as soon as their `<video>` element
first mounts — this is deliberate, since Snapchat's feed is virtualized and
unmounts off-screen `<video>` elements (sometimes revoking their blob URL)
as you scroll past them. Waiting until merge time to fetch would miss
anything no longer mounted.

Real Snapchat video segments turned out to be standalone, complete MP4
files rather than fragments of one continuous stream, so byte-level
concatenation can't produce a file that plays past the first part without a
full muxing library. Instead, merging re-encodes: each selected segment
plays through a hidden `<video>`, its frames are drawn to a `<canvas>`, and
canvas + WebAudio output are piped into one continuous `MediaRecorder`
stream. This works regardless of the source container/codec, at the cost of
a real-time pass (merging N segments takes roughly as long as their combined
duration) and re-encoded (not lossless) output, always saved as `.webm`.

Captured segments persist across the whole viewing session (not just one
story) until merged or removed, so the panel can list videos from more than
one conversation moment at once — use the checkboxes (and the per-item `×`)
to pick only the parts that actually belong together before merging.

## Known limitations

- Merge output is always WebM, regardless of the source format.
- Merging is real-time (re-encode), not instant.
- No automatic detection of which captured segments belong to the same
  split video — Snapchat exposes no reliable signal for this, so selection
  is manual.

## Browser support

Tested on Firefox and Chrome-based browsers. The blob-handling code
avoids `TypedArray`/`DataView` access on cross-origin objects to stay clear
of Firefox's Xray wrapper restrictions.
