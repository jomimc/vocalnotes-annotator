"""Build one folder per VocalNotes track for the annotator.

  <out>/<group>/<song>/
      <song>.wav|mp3                    audio (hard link, no extra disk space)
      <song>__<T>__notes.csv            notes per transcriber T   (hard link)
      <song>__<T>__pitches.csv          f0 per transcriber T      (hard link)
      <song>__MMS__syllables.csv        MMS alignment / free decoding (TIME,LABEL,SCORE)
      <song>__OV__syllables.csv         Russian: OV's syllable annotation (TIME,LABEL)
      <song>__kana.txt / <song>__text.txt   text to place, if any
      annotations/                      human annotations saved by the annotator (never overwritten here)

Audio and annotations stay out of the git repo (default output: ../annotation_data).
Usage: python3 tools/prepare_vocalnotes.py [--out ../annotation_data] [--groups Alpine ...]
"""
import argparse
import csv
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]                 # .../VocalNotes
DS = ROOT / "VocalNotesMelodyComparison/Dataset"
LYR = ROOT / "projects/lyrics"
MMS = ROOT / "projects/whisper_sandbox/mms_output"


def link(src, dst):
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:                                         # different filesystem: copy
        shutil.copy2(src, dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "annotation_data"))
    ap.add_argument("--groups", nargs="*", default=["Alpine", "China", "Japan", "Jewish", "Russian"])
    a = ap.parse_args()
    n = 0
    for g in a.groups:
        for audio in sorted((DS / "VocalNotesAudio" / g).iterdir()):
            if audio.suffix.lower() not in {".wav", ".mp3", ".m4a", ".flac"}:
                continue
            song = audio.stem
            d = Path(a.out) / g / song
            d.mkdir(parents=True, exist_ok=True)
            (d / "annotations").mkdir(exist_ok=True)
            link(audio, d / audio.name)
            for f in (DS / "VocalNotesAnnotations" / g / song).glob("*/*.csv"):
                if f.name.endswith(("__notes.csv", "__pitches.csv")):
                    link(f, d / f.name)
            m = MMS / g / f"{song}.csv"
            if m.exists():
                with open(m, encoding="utf-8") as fi, open(d / f"{song}__MMS__syllables.csv", "w", newline="", encoding="utf-8") as fo:
                    w = csv.writer(fo); w.writerow(["TIME", "LABEL", "SCORE"])
                    for r in csv.DictReader(fi):
                        if r["syll"] != "*":
                            w.writerow([r["start"], r["syll"].strip("-"), r["score"]])
            ov = LYR / "Russian" / f"{song}__syllables.csv"
            if g == "Russian" and ov.exists():
                shutil.copy2(ov, d / f"{song}__OV__syllables.csv")
            for suffix, name in [("__kana.txt", f"{song}__kana.txt"), (".txt", f"{song}__text.txt")]:
                t = LYR / g / f"{song}{suffix}"
                if t.exists() and t.read_text(encoding="utf-8").strip():
                    shutil.copy2(t, d / name)
            n += 1
    print(f"{n} track folders in {a.out}")


if __name__ == "__main__":
    main()
