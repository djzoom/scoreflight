#!/usr/bin/env python3
"""
Encode ScoreFlight pieces (data/<id>/notes.json) into the Cantus flash format (CNT3).

Cantus (ICS55 version) has 16 two-operator FM voices, 8 built-in patches,
stereo output and a MIDI UART input. Voice allocation now happens on the chip,
so a flash file is simply a timed MIDI message stream: the chip feeds flash
bytes and UART bytes into the same MIDI parser.

File format "CNT3":
  magic    4 bytes  "CNT3"
  length   u32 LE   piece length in ms
  events   repeated:
             varint  delay before this message, in ms (7 bits per byte, MSB = more)
             MIDI channel message, running status allowed:
               0x9n note velocity     note on (velocity 0 = note off)
               0xCn program           patch 0–7 (see PATCHES)
               0xBn 10 value          pan, 0 = left, 64 = centre, 127 = right
               0xBn 7  value          channel volume
           ends with  varint 0, 0xFF  (end of piece)
"""
import base64
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PATCHES = ["羽管键琴", "钢琴", "管风琴", "弦乐", "长笛", "八音盒", "竖琴", "方波"]
HARPSI, PIANO, ORGAN, STRINGS, FLUTE, MUSICBOX, HARP, SQUARE = range(8)

# per piece: (program, pan) for each staff, top staff first
ARRANGE = {
    "bach-bwv846": [(HARPSI, 72), (HARPSI, 56)],
    "joplin-maple-leaf-rag": [(PIANO, 70), (PIANO, 58)],
    "verdi-la-donna-e-mobile": [(PIANO, 70), (PIANO, 58)],
    "chopin-mazurka-op6-no2": [(PIANO, 70), (PIANO, 58)],
    "handel-lascia-chio-pianga": [(FLUTE, 64), (HARPSI, 44), (HARPSI, 84)],
    "haydn-op1-no1-i": [(STRINGS, 28), (STRINGS, 50), (STRINGS, 80), (STRINGS, 100)],
    "beethoven-op18-no1-i": [(STRINGS, 28), (STRINGS, 50), (STRINGS, 80), (STRINGS, 100)],
}


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return out


def encode(meta):
    arr = ARRANGE.get(meta["id"], [(PIANO, 64)] * meta["staves"])
    msgs = []  # (time_ms, order, bytes)
    for ch, (prog, pan) in enumerate(arr):
        msgs.append((0, 0, bytes([0xC0 | ch, prog])))
        msgs.append((0, 0, bytes([0xB0 | ch, 10, pan])))
        msgs.append((0, 0, bytes([0xB0 | ch, 7, 110 if ch == 0 else 96])))
    for t, d, m, staff, *_ in meta["notes"]:
        ch = min(staff, 15)
        on, off = round(t * 1000), round((t + d) * 1000) - 4   # tiny gap so repeats re-strike
        vel = 100 if staff == 0 else 84
        msgs.append((on, 2, bytes([0x90 | ch, m, vel])))
        msgs.append((max(on + 10, off), 1, bytes([0x90 | ch, m, 0])))   # offs before ons at equal times
    msgs.sort(key=lambda x: (x[0], x[1]))
    blob = bytearray(b"CNT3") + int(meta["duration"] * 1000).to_bytes(4, "little")
    last_t, status = 0, None
    for t, _, msg in msgs:
        blob += varint(t - last_t)
        last_t = t
        if msg[0] == status:
            blob += msg[1:]          # running status
        else:
            blob += msg
            status = msg[0]
    blob += varint(0) + b"\xff"
    return bytes(blob), arr


def decode(blob):
    """Reference parser (the chip does the same): returns [(time_ms, status, data...)]"""
    assert blob[:4] == b"CNT3"
    i, t, status, out = 8, 0, None, []
    while True:
        d = sh = 0
        while True:
            x = blob[i]; i += 1
            d |= (x & 0x7F) << sh; sh += 7
            if not x & 0x80:
                break
        t += d
        if blob[i] == 0xFF:
            return out
        if blob[i] & 0x80:
            status = blob[i]; i += 1
        n = 1 if status & 0xF0 == 0xC0 else 2
        out.append((t, status, *blob[i:i + n])); i += n


def main():
    index = json.load(open(os.path.join(ROOT, "data", "index.json")))
    songs = []
    for p in index:
        meta = json.load(open(os.path.join(ROOT, "data", p["id"], "notes.json")))
        meta["id"] = p["id"]
        blob, arr = encode(meta)
        ev = decode(blob)
        ons = sum(1 for e in ev if e[1] & 0xF0 == 0x90 and e[3] > 0)
        assert ons == len(meta["notes"]), (p["id"], ons, len(meta["notes"]))
        # peak polyphony, to check against the chip's 16 voices
        live, peak = set(), 0
        for e in ev:
            if e[1] & 0xF0 == 0x90:
                key = (e[1] & 15, e[2])
                if e[3]: live.add(key)
                else: live.discard(key)
                peak = max(peak, len(live))
        songs.append({
            "id": p["id"], "title": p["title"], "composer": p["composer"], "year": p["year"],
            "notes": len(meta["notes"]), "bytes": len(blob), "duration": round(meta["duration"], 2),
            "peak": peak, "patches": [PATCHES[a[0]] for a in arr],
            "b64": base64.b64encode(blob).decode(),
        })
        print(f'{p["id"]:28s} {len(meta["notes"]):5d} notes -> {len(blob):6d} B  peak polyphony {peak:2d}  {"/".join(sorted(set(songs[-1]["patches"])))}')
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "cantus-songs.json")
    json.dump(songs, open(out, "w"), ensure_ascii=False)
    print("total", sum(s["bytes"] for s in songs), "B ->", out)


if __name__ == "__main__":
    main()
