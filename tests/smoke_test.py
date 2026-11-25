"""Headless browser smoke test (Playwright + Chromium).

Serves the VocalNotes root, opens the annotator, loads one prepared track folder through the
same code path as the folder picker, exercises the main interactions, and saves a screenshot.
Fails on any page error or console error.

Usage: python3 tests/smoke_test.py [--track ../annotation_data/Japan/PES_Kuroda-bushi]
"""
import argparse
import functools
import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    h.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", default=str(ROOT / "annotation_data/Japan/PES_Kuroda-bushi"))
    ap.add_argument("--shot", default=str(Path(__file__).parent / "smoke.png"))
    a = ap.parse_args()
    track = Path(a.track).resolve()
    rel = track.relative_to(ROOT).as_posix()
    files = [p.name for p in track.iterdir() if p.is_file()] + \
            [f"annotations/{p.name}" for p in (track / "annotations").glob("*") if p.is_file()]
    srv = serve(); base = f"http://127.0.0.1:{srv.server_port}"
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page(viewport={"width": 1500, "height": 950})
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        pg.goto(f"{base}/annotation_tools/index.html")
        pg.wait_for_function("window.__annotator")
        # load the folder through loadFolder (same path as the picker)
        pg.evaluate("""async ([base, rel, names]) => {
            const files = [];
            for (const n of names) { const r = await fetch(`${base}/${rel}/${n.split('/').map(encodeURIComponent).join('/')}`);
                                     files.push(new File([await r.blob()], n.split('/').pop())); }
            await window.__annotator.loadFolder({files, dirHandle: null, folderName: rel.split('/').pop()});
        }""", [base, rel, files])
        A = "window.__annotator"
        info = pg.evaluate(f"""() => {{ const S = {A}.S;
            return {{song: S.song, dur: {A}.audio.duration, tracks: S.tracks.map(t => t.id), layers: S.layers.map(l => l.id),
                     edit: S.editId, n: S.sylls.length, tokens: S.tokens.length}}; }}""")
        print("loaded:", info)
        assert info["dur"] > 1 and info["tracks"], "audio/notes not loaded"

        syl = pg.locator("#cv-syll"); box = syl.bounding_box()
        n0 = pg.evaluate(f"{A}.S.sylls.length")
        # add an onset by clicking empty space in the lower part of the syllable lane
        pg.evaluate(f"{A}.selectLayer('new')")
        pg.mouse.click(box["x"] + 300, box["y"] + box["height"] - 6)
        pg.mouse.click(box["x"] + 600, box["y"] + box["height"] - 6)
        n1 = pg.evaluate(f"{A}.S.sylls.length"); assert n1 == 2, f"add failed: {n1}"
        if pg.evaluate(f"{A}.S.tokens.length") == 0:
            # no text: a new onset must open the label editor at once; letters go into the label,
            # not to shortcuts ("o" used to open the folder picker)
            pg.mouse.click(box["x"] + 900, box["y"] + box["height"] - 6)
            pg.wait_for_timeout(50)
            assert pg.is_visible("#label-editor"), "editor did not open on add"
            pg.keyboard.type("yo"); pg.keyboard.press("Enter")
            labs = pg.evaluate(f"{A}.S.sylls.map(s => s.label)")
            assert "yo" in labs, f"typed label missing: {labs}"
            pg.keyboard.press("Control+z"); pg.keyboard.press("Control+z")   # undo label + add
            assert pg.evaluate(f"{A}.S.sylls.length") == 2, "undo of add+label failed"
        lab = pg.evaluate(f"{A}.S.sylls[0].label"); print("placed labels:", pg.evaluate(f"{A}.S.sylls.map(s=>s.label)"))
        # drag first onset right by 50 px
        t_before = pg.evaluate(f"{A}.S.sylls[0].t")
        pg.mouse.move(box["x"] + 300, box["y"] + 30); pg.mouse.down()
        pg.mouse.move(box["x"] + 350, box["y"] + 30, steps=5); pg.mouse.up()
        t_after = pg.evaluate(f"{A}.S.sylls[0].t"); assert t_after > t_before, "drag failed"
        # edit label via double-click on the box
        pg.mouse.dblclick(box["x"] + 365, box["y"] + 30)
        pg.keyboard.press("Control+a"); pg.keyboard.type("test"); pg.keyboard.press("Enter")
        assert pg.evaluate(f"{A}.S.sylls[0].label") == "test", "label edit failed"
        # right-click delete second onset, then undo
        pg.mouse.click(box["x"] + 600, box["y"] + 30, button="right")
        assert pg.evaluate(f"{A}.S.sylls.length") == 1, "delete failed"
        pg.keyboard.press("Control+z"); assert pg.evaluate(f"{A}.S.sylls.length") == 2, "undo failed"
        # zoom with wheel over waveform
        span0 = pg.evaluate(f"{A}.S.vp.span")
        wv = pg.locator("#cv-wave").bounding_box(); pg.mouse.move(wv["x"] + 500, wv["y"] + 40)
        pg.mouse.wheel(0, -300); span1 = pg.evaluate(f"{A}.S.vp.span"); assert span1 < span0, "zoom failed"
        pg.mouse.wheel(0, 300)
        # CSV edge cases (headerless TIME,LABEL; semicolons with decimal commas)
        parsed = pg.evaluate("""async () => { const io = await import('./js/io.js');
            return [io.parseSyllables('0.52,la\\n1.0,"a,b"\\n').length, io.parseNotes('ONSET;F0;DURATION\\n0,5;220;0,3\\n').length]; }""")
        assert parsed == [2, 1], f"CSV parsing: {parsed}"
        # save (download fallback) -> layer list updated and selected
        pg.evaluate("localStorage.setItem('annotator', 'TEST')")
        with pg.expect_download() as dl:
            pg.keyboard.press("Control+s")
        assert dl.value.suggested_filename.endswith("__TEST__syllables.csv"), dl.value.suggested_filename
        assert pg.evaluate(f"{A}.S.editId") == "TEST" and not pg.evaluate(f"{A}.S.dirty"), "save bookkeeping"
        # folder save path (Chrome/Edge): writes into <folder>/annotations/ — checked with the
        # origin-private file system, which implements the same directory-handle API as the picker
        saved = pg.evaluate("""async () => { const io = await import('./js/io.js');
            const root = await navigator.storage.getDirectory();
            const where = await io.saveFile(root, 'x__TEST__syllables.csv', 'TIME,LABEL\\n1.0,ya\\n');
            const sub = await root.getDirectoryHandle('annotations');
            const txt = await (await (await sub.getFileHandle('x__TEST__syllables.csv')).getFile()).text();
            return [where, txt.includes('1.0,ya')]; }""")
        assert saved == ["folder", True], f"folder save: {saved}"
        # playback at 0.5x with clicks on (scheduler + cancel on pause must not throw)
        pg.select_option("#sel-speed", "0.5"); pg.check("#chk-clicks")
        pg.evaluate(f"{A}.audio.time = 2.0"); pg.keyboard.press("Space"); pg.wait_for_timeout(1500)
        pg.keyboard.press("Space")
        print("playback reached", round(pg.evaluate(f"{A}.audio.time"), 2), "s")
        # spectrogram
        pg.check("#chk-spec")
        pg.wait_for_function(f"{A}.S.spec && {A}.S.spec.tiles", timeout=60000)
        # back to the loaded layer for the screenshot
        pg.evaluate(f"() => {{ {A}.S.dirty = false; {A}.selectLayer({A}.S.layers[0]?.id ?? 'new'); }}")
        pg.wait_for_timeout(300)
        pg.screenshot(path=a.shot, full_page=True)
        b.close()
    srv.shutdown()
    if errors:
        print("\n".join(errors)); raise SystemExit("FAILED: browser errors")
    print(f"OK (layers {n0}->{n1} syllables; drag {t_before:.2f}->{t_after:.2f} s; zoom {span0:.1f}->{span1:.1f} s). Screenshot: {a.shot}")


if __name__ == "__main__":
    main()
