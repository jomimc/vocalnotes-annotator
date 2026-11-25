# Syllable Annotator

A browser tool for placing and correcting **syllable onsets** on recordings of singing, with
existing note and f0 annotations as a guide. Built for the VocalNotes project; works for any
folder that follows the conventions below.

Everything runs locally in the browser. **Audio and annotations are never uploaded.**

## Use

**Online:** https://jomimc.github.io/vocalnotes-annotator/ — use **Chrome or Edge** so saves go
straight into the track folder.

Locally: serve this folder (`python3 -m http.server`) and open it in the browser — browsers block
ES modules from `file://`.

1. **Open folder** — pick the folder of one track (see *Folder format*).
2. Choose which syllable file to edit (**Edit** menu), or *New (empty)*.
3. Annotate in the **Syllables** lane:

| Action | Effect |
|---|---|
| Left-click | Add an onset and type its label straight away (Enter to confirm); with *Place next on click* it takes the next syllable from the text panel instead |
| Right-click | Delete the nearest onset |
| Drag a line or box | Move the onset (Shift: snap to the nearest note onset) |
| Double-click a box / Enter | Edit the label (Enter OK, Tab next, Esc cancel) |
| Delete / Backspace | Delete the selected onset |
| A | Add an onset at the playback cursor (tap along while playing) |

Navigation and playback:

| Action | Effect |
|---|---|
| Mouse wheel | Zoom around the pointer (default window 15 s) |
| Shift+wheel, trackpad sideways, drag in other lanes | Scroll in time |
| Click in waveform / spectrogram / f0 lanes | Move the playback cursor |
| Overview bar | Click or drag to jump |
| Space | Play / pause |
| [ / ] | Slower / faster (0.25×–1.25×, pitch preserved) |
| C | Toggle clicks at each onset during playback |
| ← / → (Shift: fine) | Scroll half a window (move cursor 0.1 s) |
| + / − | Zoom |
| Ctrl+Z / Ctrl+Shift+Z, Ctrl+S, Ctrl+O | Undo / redo, save, open folder |
| ? | Help |

4. **Save** writes `<song>__<initials>__syllables.csv` into the subfolder `annotations/` of the
   track folder (created if needed); files there are loaded again when the folder is opened.
   **Use Chrome or Edge**: Firefox and Safari do not let web pages write into folders, so there the
   file is downloaded and has to be moved into `annotations/` by hand. Unsaved work is
   kept as a draft in the browser and offered back next time the same file is opened.

## Folder format

One folder per recording. Files are recognised by their endings; the transcriber/annotator id is
the middle part of `SONG__ID__type.csv`.

| File | Content |
|---|---|
| `*.wav` / `*.mp3` / `*.m4a` / `*.flac` | the recording (required; first one found) |
| `*__ID__notes.csv` (or `*segments.csv`) | `ONSET,F0,DURATION` (s, Hz, s) — one per transcriber, toggle in the f0 lane legend |
| `*__ID__pitches.csv` | `TIME,F0` (s, Hz) — f0 trace per transcriber |
| `*__ID__syllables.csv` | `TIME,LABEL[,SCORE]` — syllable onsets; the others are shown as read-only ticks |
| `*.txt` | text to place; split by spaces/hyphens, or by character (Japanese kana: by mora) |
| `annotations/*__ID__syllables.csv` | human annotations saved by the tool (loaded like the above) |

Headerless CSVs are read positionally in the column order shown.

### Preparing VocalNotes folders

`tools/prepare_vocalnotes.py` builds folders for all 60 VocalNotes tracks in
`../annotation_data/` (outside this repository) from the dataset, the MMS alignments/decodings
and the collected lyrics. Audio is hard-linked, not copied.

## Development

No build step and no dependencies: plain ES modules and Canvas.

- `js/main.js` — state, loading, editing, navigation, saving
- `js/render.js` — drawing of all lanes
- `js/io.js` — folder reading, CSV parsing, saving
- `js/audio.js` — playback, slow-down, onset clicks
- `js/viewport.js` — shared time window
- `js/spectrogram-worker.js` — STFT in a Web Worker

`tests/smoke_test.py` (Python + Playwright) loads a prepared track in headless Chromium and
exercises adding, dragging, editing, deleting, undo, zoom and the spectrogram.

## Licence

MIT — see `LICENSE`.
