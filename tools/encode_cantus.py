#!/usr/bin/env python3
"""
Encode ScoreFlight pieces (data/<id>/notes.json) into the Cantus flash format.

Cantus has 3 square-wave voices, so the encoder (not the chip) decides which
voice plays each note. Priority: keep the top line (melody) and the bass;
inner notes are dropped, or steal a voice from an older inner note.

File format "CNT1" (little endian):
  magic   4 bytes  "CNT1"
  count   u16      number of note events
  length  u32      piece length in ms
  events  count ×  varint(delta ticks, 1 tick = 10 ms)
                   u8  pitch (MIDI 0–127)
                   u8  voice << 6 | duration index (6 bits, log table)
Duration table: DUR[k] = 0.03 s × (8 / 0.03)^(k / 63), k = 0..63.
"""
import base64
import json
import math
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
VOICES = 3
TICK = 0.01
DUR = [0.03 * (8 / 0.03) ** (k / 63) for k in range(64)]


def dur_index(d):
    return min(range(64), key=lambda k: abs(math.log(DUR[k]) - math.log(max(d, 0.03))))


def allocate(notes):
    """notes: [t, d, midi, staff,...] -> list of [t, d, midi, voice], stats"""
    groups = {}
    for n in notes:
        groups.setdefault(round(n[0], 3), []).append([n[0], n[1], n[2]])
    out, active = [], [None] * VOICES   # active[v] = index into out
    dropped = stolen = 0
    for t in sorted(groups):
        g = sorted(groups[t], key=lambda n: n[2])
        order = [g[-1]] + ([g[0]] if len(g) > 1 else []) + g[1:-1][::-1]  # top, bass, then inner high→low
        for n in order:
            for v in range(VOICES):               # release finished voices
                if active[v] is not None and out[active[v]][0] + out[active[v]][1] <= t + 1e-6:
                    active[v] = None
            free = [v for v in range(VOICES) if active[v] is None]
            sounding = [out[active[v]][2] for v in range(VOICES) if active[v] is not None]
            if free:
                pref = 0 if n[2] <= min(sounding + [n[2]]) else (VOICES - 1 if n[2] >= max(sounding + [n[2]]) else 1)
                v = min(free, key=lambda x: abs(x - pref))
            else:
                lo, hi = min(sounding), max(sounding)
                if not (n[2] > hi or n[2] < lo or n is order[0]):
                    dropped += 1
                    continue
                inner = [v for v in range(VOICES) if out[active[v]][2] not in (lo, hi)] or \
                        [v for v in range(VOICES) if out[active[v]][2] != (hi if n[2] > hi else lo)]
                v = min(inner, key=lambda x: out[active[x]][0])
                out[active[v]][1] = max(0.03, t - out[active[v]][0])  # cut the old note short
                stolen += 1
            out.append([n[0], n[1], n[2], v])
            active[v] = len(out) - 1
    return out, dropped, stolen


def encode(events, length):
    b = bytearray(b"CNT1")
    b += len(events).to_bytes(2, "little") + int(length * 1000).to_bytes(4, "little")
    last = 0
    for t, d, m, v in events:
        tick = round(t / TICK)
        delta = tick - last
        last = tick
        while True:
            byte = delta & 0x7F
            delta >>= 7
            b.append(byte | (0x80 if delta else 0))
            if not delta:
                break
        b.append(m & 0x7F)
        b.append((v << 6) | dur_index(d))
    return bytes(b)


def main():
    index = json.load(open(os.path.join(ROOT, "data", "index.json")))
    songs = []
    for p in index:
        meta = json.load(open(os.path.join(ROOT, "data", p["id"], "notes.json")))
        ev, dropped, stolen = allocate(meta["notes"])
        ev.sort(key=lambda e: (e[0], e[3]))
        blob = encode(ev, meta["duration"])
        songs.append({
            "id": p["id"], "title": p["title"], "composer": p["composer"], "year": p["year"],
            "notes": len(meta["notes"]), "kept": len(ev), "dropped": dropped, "stolen": stolen,
            "bytes": len(blob), "duration": round(meta["duration"], 2),
            "b64": base64.b64encode(blob).decode(),
        })
        print(f'{p["id"]:28s} {len(meta["notes"]):5d} notes -> {len(blob):6d} B, dropped {dropped}, stolen {stolen}')
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "cantus-songs.json")
    json.dump(songs, open(out, "w"), ensure_ascii=False)
    print("total", sum(s["bytes"] for s in songs), "B ->", out)


if __name__ == "__main__":
    main()
