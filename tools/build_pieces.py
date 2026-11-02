#!/usr/bin/env python3
"""
Build the piece data used by the web app.

For every piece in PIECES:
  1. load the public-domain score from the music21 corpus (or a local file),
  2. engrave it with Verovio into one tall SVG page (many long systems),
  3. pull note timing from Verovio's timemap + MIDI values,
  4. pull every notehead's (x, y) and staff/system index from the SVG,
  5. write data/<id>/score.svg and data/<id>/notes.json.

Usage:  pip install verovio music21 && python tools/build_pieces.py
"""
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

import verovio
from music21 import bar, corpus, converter, repeat

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.join(ROOT, "data")
SVG_NS = "{http://www.w3.org/2000/svg}"

# (id, corpus path, title, composer, instrument family, year)
PIECES = [
    ("bach-bwv846", "bach/bwv846", "Prelude in C major, BWV 846", "J. S. Bach", "keyboard", 1722),
    ("joplin-maple-leaf-rag", "joplin/maple_leaf_rag", "Maple Leaf Rag", "Scott Joplin", "keyboard", 1899),
    ("verdi-la-donna-e-mobile", "verdi/laDonnaEMobile", "La donna è mobile (Rigoletto)", "Giuseppe Verdi", "keyboard", 1851),
    ("chopin-mazurka-op6-no2", "chopin/mazurka06-2", "Mazurka in C-sharp minor, Op. 6 No. 2", "Frédéric Chopin", "keyboard", 1832),
    ("handel-lascia-chio-pianga", "handel/rinaldo/Lascia_chio_pianga", "Lascia ch'io pianga (Rinaldo)", "G. F. Handel", "vocal", 1711),
    ("haydn-op1-no1-i", "haydn/opus1no1/movement1", "String Quartet Op. 1 No. 1, I. Presto", "Joseph Haydn", "strings", 1762),
    ("beethoven-op18-no1-i", "beethoven/opus18no1/movement1", "String Quartet Op. 18 No. 1, I. Allegro con brio", "Ludwig van Beethoven", "strings", 1800),
]

VRV_OPTIONS = {
    "breaks": "auto",
    "pageWidth": 12000,
    "pageHeight": 60000,
    "adjustPageHeight": True,
    "scale": 40,
    "header": "none",
    "footer": "none",
    "svgViewBox": True,
    "mnumInterval": 0,
    "spacingSystem": 14,
    "spacingStaff": 10,
    "lyricSize": 3.5,
    "svgRemoveXlink": True,
}


def build(piece_id, src, title, composer, family, year):
    print(f"== {piece_id}: {title}")
    score = corpus.parse(src) if not os.path.exists(src) else converter.parse(src)
    # Write repeats out in full. Verovio's timemap advances time over a repeat
    # without re-emitting the notes, which left silent gaps in playback.
    try:
        expanded = score.expandRepeats()
        if expanded.duration.quarterLength > score.duration.quarterLength:
            print(f"   repeats expanded: {score.duration.quarterLength} -> {expanded.duration.quarterLength} quarters")
            score = expanded
    except Exception as e:  # malformed repeat marks: drop them and play the music once as written
        n = 0
        for m in score.recurse().getElementsByClass("Measure"):
            for side in ("leftBarline", "rightBarline"):
                if isinstance(getattr(m, side), bar.Repeat):
                    setattr(m, side, bar.Barline("regular")); n += 1
        for r in list(score.recurse().getElementsByClass(repeat.RepeatExpression)):
            r.activeSite.remove(r); n += 1
        print(f"   repeats could not be expanded ({e}); removed {n} repeat marks")
    xml_path = score.write("musicxml")

    tk = verovio.toolkit()
    tk.setOptions(VRV_OPTIONS)
    if not tk.loadFile(str(xml_path)):
        raise RuntimeError("verovio could not load " + str(xml_path))
    pages = tk.getPageCount()
    if pages != 1:
        print(f"   warning: {pages} pages, only page 1 is used")
    svg = tk.renderToSVG(1)

    # ---- geometry: outer viewBox (px space) and inner "definition-scale" viewBox
    outer = re.search(r'<svg viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    inner = re.search(r'<svg class="definition-scale"[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    outer_w, outer_h = float(outer.group(1)), float(outer.group(2))
    inner_w, inner_h = float(inner.group(1)), float(inner.group(2))
    margin = re.search(r'<g class="page-margin" transform="translate\(([\d.]+), ([\d.]+)\)"', svg)
    mx, my = float(margin.group(1)), float(margin.group(2))

    # ---- timing from verovio
    timemap = tk.renderToTimemap()
    # a note inside a repeated section is switched on once per pass, so keep every onset
    onsets = {}
    for ev in timemap:
        for nid in ev.get("on", []):
            onsets.setdefault(nid, []).append(ev["tstamp"] / 1000.0)
    midi = {}
    for nid in onsets:
        v = tk.getMIDIValuesForElement(nid)
        if v and v.get("pitch", 0) > 0:
            midi[nid] = v

    # ---- positions from the SVG tree
    root = ET.fromstring(svg)
    notes = []
    systems = []
    for sys_idx, system in enumerate(root.iter(SVG_NS + "g")):
        if system.get("class") != "system":
            continue
        sys_idx = len(systems)
        xs, ys = [], []
        for measure in system.iter(SVG_NS + "g"):
            if measure.get("class") != "measure":
                continue
            staff_idx = 0
            for staff in measure:
                if staff.get("class") != "staff":
                    continue
                # staff lines give the system's vertical extent
                for path in staff.findall(SVG_NS + "path"):
                    d = path.get("d", "")
                    m = re.match(r"M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)", d)
                    if m:
                        xs += [float(m.group(1)), float(m.group(3))]
                        ys += [float(m.group(2)), float(m.group(4))]
                for g in staff.iter(SVG_NS + "g"):
                    if g.get("class") != "note":
                        continue
                    nid = g.get("id")
                    if nid not in midi:
                        continue
                    head = None
                    for h in g.iter(SVG_NS + "g"):
                        if h.get("class") == "notehead":
                            head = h
                            break
                    if head is None:
                        continue
                    use = head.find(SVG_NS + "use")
                    if use is None:
                        continue
                    tm = re.search(r"translate\(([-\d.]+), ([-\d.]+)\)", use.get("transform", ""))
                    if not tm:
                        continue
                    x = float(tm.group(1)) + mx
                    y = float(tm.group(2)) + my
                    v = midi[nid]
                    for onset in onsets[nid]:
                        notes.append([
                            round(onset, 4),
                            round(v["duration"] / 1000.0, 4),
                            v["pitch"],
                            staff_idx,
                            round(x, 1),
                            round(y, 1),
                            sys_idx,
                        ])
                staff_idx += 1
        if xs:
            systems.append({
                "x0": round(min(xs) + mx, 1), "x1": round(max(xs) + mx, 1),
                "y0": round(min(ys) + my, 1), "y1": round(max(ys) + my, 1),
            })
    notes.sort(key=lambda n: (n[0], n[2]))
    staves = max(n[3] for n in notes) + 1
    duration = max(n[0] + n[1] for n in notes)
    tempo = next((ev["tempo"] for ev in timemap if "tempo" in ev), None)

    out_dir = os.path.join(DATA, piece_id)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "score.svg"), "w") as f:
        f.write(svg)
    meta = {
        "id": piece_id,
        "title": title,
        "composer": composer,
        "family": family,
        "year": year,
        "source": f"music21 corpus: {src}",
        "tempo": tempo,
        "duration": round(duration, 3),
        "staves": staves,
        "outer": {"w": outer_w, "h": outer_h},
        "inner": {"w": inner_w, "h": inner_h},
        "systems": systems,
        "fields": ["time", "duration", "midi", "staff", "x", "y", "system"],
        "notes": notes,
    }
    with open(os.path.join(out_dir, "notes.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"   {len(notes)} notes, {len(systems)} systems, {duration:.0f}s, staves={staves}, svg {len(svg)//1024} KB")
    return {k: meta[k] for k in ("id", "title", "composer", "family", "year", "duration", "staves")}


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    index = []
    for p in PIECES:
        if wanted and p[0] not in wanted:
            continue
        index.append(build(*p))
    if not wanted:
        with open(os.path.join(DATA, "index.json"), "w") as f:
            json.dump(index, f, ensure_ascii=False, indent=1)
