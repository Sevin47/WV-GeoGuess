#!/usr/bin/env python3
"""
Prepare round photos for WV GeoGuess (brief §3.6).

For each photo this:
  1. applies the EXIF orientation (so phone photos don't end up sideways once
     the EXIF is gone),
  2. resizes so the long edge is at most 1600 px (never upscales),
  3. saves a JPEG with NO metadata — no EXIF (GPS!), no XMP, no comments —
     under a neutral name like r01.jpg,
  4. lowers JPEG quality until the file is under 400 KB,
  5. re-opens the output and fails loudly if any metadata survived.

Usage (from the repo root):
    python scripts/strip_exif.py --out assets/rounds  IMG_1234.jpg=r01  bridge.png=r02
    python scripts/strip_exif.py --out assets/rounds  --manifest photos.csv

photos.csv has a header row and two columns:  source,landmark_id

Requires Pillow (pip install Pillow). HEIC/HEIF photos from iPhones also need
pillow-heif (pip install pillow-heif), or export them as JPEG first.

Keep the originals OUT of the repo — they still contain GPS tags.
"""
import argparse
import csv
import io
import re
import sys
from pathlib import Path

from PIL import Image, ImageOps

try:  # optional HEIC support
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

LONG_EDGE = 1600
MAX_BYTES = 400 * 1024
QUALITIES = range(88, 49, -4)  # 88, 84, ... 52
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
GPS_IFD = 0x8825


def prepare(src: Path, out_path: Path, long_edge=LONG_EDGE, max_bytes=MAX_BYTES):
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)  # bake in rotation before dropping EXIF
        icc = im.info.get("icc_profile")  # color profile only; no location data
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        if max(im.size) > long_edge:
            im.thumbnail((long_edge, long_edge), Image.Resampling.LANCZOS)

        # Build a fresh image from pixels only, so no metadata can ride along.
        clean = Image.new(im.mode, im.size)
        clean.paste(im)

    data = None
    for q in QUALITIES:
        buf = io.BytesIO()
        clean.save(buf, "JPEG", quality=q, optimize=True, progressive=True, icc_profile=icc)
        data = buf.getvalue()
        if len(data) <= max_bytes:
            break
    out_path.write_bytes(data)
    return clean.size, len(data), q


def verify_clean(path: Path):
    """Return a list of problems (empty = clean)."""
    problems = []
    with Image.open(path) as im:
        exif = im.getexif()
        if len(exif):
            problems.append(f"EXIF tags present: {sorted(exif.keys())}")
        if exif.get_ifd(GPS_IFD):
            problems.append("GPS tags present")
        for key in ("exif", "xmp", "XML:com.adobe.xmp", "comment", "photoshop"):
            if key in im.info:
                problems.append(f"metadata block present: {key}")
    return problems


def parse_jobs(args):
    jobs = []
    for pair in args.pairs:
        if "=" not in pair:
            sys.exit(f"Expected SOURCE=ID, got {pair!r}")
        src, lid = pair.rsplit("=", 1)
        jobs.append((Path(src), lid.strip()))
    if args.manifest:
        with open(args.manifest, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                jobs.append((Path(row["source"].strip()), row["landmark_id"].strip()))
    return jobs


def main():
    # Windows consoles default to cp1252; never crash on a stray character.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pairs", nargs="*", help="SOURCE=ID pairs, e.g. IMG_1234.jpg=r01")
    ap.add_argument("--manifest", help="CSV with columns source,landmark_id")
    ap.add_argument("--out", required=True, help="output folder, e.g. assets/rounds")
    ap.add_argument("--long-edge", type=int, default=LONG_EDGE)
    ap.add_argument("--max-kb", type=int, default=MAX_BYTES // 1024)
    args = ap.parse_args()

    jobs = parse_jobs(args)
    if not jobs:
        ap.error("no photos given")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    failed = False
    seen = set()
    for src, lid in jobs:
        if not ID_RE.match(lid):
            print(f"FAIL {src}: bad landmark id {lid!r} (use lowercase like r01)")
            failed = True
            continue
        if lid in seen:
            print(f"FAIL {src}: duplicate landmark id {lid!r}")
            failed = True
            continue
        seen.add(lid)
        out_path = out_dir / f"{lid}.jpg"
        try:
            size, nbytes, q = prepare(src, out_path, args.long_edge, args.max_kb * 1024)
        except Exception as e:  # noqa: BLE001 — report and keep going
            print(f"FAIL {src}: {e}")
            failed = True
            continue
        problems = verify_clean(out_path)
        over = nbytes > args.max_kb * 1024
        status = "FAIL" if problems or over else "ok  "
        failed |= bool(problems or over)
        note = f"  !! {'; '.join(problems)}" if problems else ""
        note += f"  !! still {nbytes // 1024} KB at quality {q}" if over else ""
        print(f"{status} {src.name} -> {out_path}  {size[0]}x{size[1]}  {nbytes // 1024} KB  q{q}{note}")

    print("\nImage paths for the landmarks layer's image_path field look like: "
          f"{out_dir.as_posix()}/r01.jpg")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
