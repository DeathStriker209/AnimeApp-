# Anime Stream+

A desktop anime app with a built-in player and full keyboard navigation.

## Run it

1. Install Node.js 18 or newer from https://nodejs.org
2. Open a terminal in this folder and run:

   npm install
   npm start

## Build a Windows installer (.exe)

   npm run dist

The installer appears in the `dist` folder.

## How it works

- Home, Browse, Genres, Movies and the anime pages pull titles, covers, banners,
  scores, descriptions, trailers and recommendations from AniList (free, no key).
- "Where to watch" on each anime page lists its official streaming services
  (Crunchyroll, Netflix, etc.) and opens them in your browser.
- "Link episode files" lets you pick video files on your PC. Episode numbers are
  read from the file names (e.g. "Show - 14.mkv", "S01E14", "Episode 14").
  Linked episodes play in the built-in player; progress is saved automatically.
- A subtitle file with the same name next to the video (.srt or .vtt) loads automatically.

## Keyboard

| Key | Action |
| --- | --- |
| Arrow keys | Move around the app |
| Enter | Open / select |
| Esc / Backspace | Back |
| / | Search |
| Space or K | Play / pause |
| ← or J | Back 10 seconds |
| → or L | Forward 10 seconds |
| ↑ / ↓ | Volume |
| F | Fullscreen |
| M | Mute |
| C | Subtitles on/off (or load a file) |
| N / P | Next / previous episode |
| E | Episode list (↑ ↓ Enter, E to leave) |
| 0–9 | Jump to 0%–90% |

## Video formats

MP4, WebM, and MKV with H.264 video play directly. HEVC (x265) files or
AC3/DTS audio may not play in Chromium; convert those to H.264/AAC MP4.
