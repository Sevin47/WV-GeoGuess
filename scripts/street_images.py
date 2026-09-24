#!/usr/bin/env python3
"""
Street-level round photos for WV GeoGuess: sample -> review -> finalize.

    1. SAMPLE candidates (downloads into work/, which is git-ignored):
         python scripts/street_images.py sample wvdot --count 150
         python scripts/street_images.py sample mapillary --count 150
    2. REVIEW them in the browser (python scripts/serve.py, then open
       http://localhost:8000/tools/review.html) — keep the good ones, reject
       blurry/dark shots, frames with readable people or plates, and wrong
       coordinates.
    3. FINALIZE the kept set:
         python scripts/street_images.py finalize --count 100
       -> assets/rounds/r001.jpg ...   (public: cropped, scrubbed, neutral names)
       -> work/landmarks.geojson       (PRIVATE answers: 0.5-mile hit circles)
       Then upload with scripts/load_landmarks.py.

    python scripts/street_images.py status      # counts so far

Sources
  wvdot      WVDOT dashcam frames (Nextbase). There's no GPS metadata in the
             files, so the coordinates are read (OCR, Tesseract) off the text
             strip the camera burns into each frame — and that strip is cropped
             off before a photo is used, since it would give the answer away.
  mapillary  Crowd-sourced imagery, CC BY-SA 4.0 (credited per photo). Faces
             and plates are already blurred by Mapillary.

Secrets come from environment variables or a git-ignored .env file in the repo
root (never commit either):
  WVDOT_FRAMES_URL   the bucket's pre-authenticated URL, ending in /o
  MAPILLARY_TOKEN    a Mapillary client token (MLY|...)
  TESSERACT_EXE      optional; defaults to the standard Windows install path

Requires Pillow; wvdot also needs Tesseract OCR installed.
"""
import argparse
import io
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps, ImageStat

sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_exif import prepare, verify_clean  # noqa: E402  (same folder)

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
CANDIDATES_DIR = WORK / "candidates"
CANDIDATES_JSON = WORK / "candidates.json"
REVIEW_JSON = WORK / "review.json"
ANSWERS_GEOJSON = WORK / "landmarks.geojson"
ROUNDS_DIR = ROOT / "assets" / "rounds"

HIT_RADIUS_MILES = 0.5  # a pin this close to where the photo was taken scores 1000
MIN_SPACING_MILES = 2.0  # no two candidates closer than this
CELL_DEG = 0.25  # spread: at most --per-cell candidates per 0.25° grid cell
WVDOT_CROP_BOTTOM = 0.12  # the text strip (and most of the hood) lives in the bottom ~12%
DARK_LIMIT = 55  # mean brightness (0-255) below this = too dark to play
PROMPT = "Where in West Virginia was this taken?"


def load_env():
    """Read KEY=VALUE lines from the repo's .env (git-ignored) into os.environ."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ---------------------------------------------------------------------------
# Geography: WV boundary, counties, places (all local files in data/)
# ---------------------------------------------------------------------------

def _rings(geometry):
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return [p[0] for p in polys]


def _in_rings(lon, lat, rings):
    inside = False
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside


def miles_between(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class WV:
    def __init__(self):
        b = json.loads((ROOT / "data/wv-boundary.geojson").read_text())
        self.rings = [r for f in b["features"] for r in _rings(f["geometry"])]
        xs = [c[0] for r in self.rings for c in r]
        ys = [c[1] for r in self.rings for c in r]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        c = json.loads((ROOT / "data/wv-counties.geojson").read_text())
        self.counties = [(f["properties"]["NAME"], _rings(f["geometry"])) for f in c["features"]]
        self.places = json.loads((ROOT / "data/wv-places.json").read_text())["places"]

    def contains(self, lon, lat):
        return _in_rings(lon, lat, self.rings)

    def county(self, lon, lat):
        return next((name for name, rings in self.counties if _in_rings(lon, lat, rings)), None)

    def nearest_place(self, lon, lat):
        best = min(self.places, key=lambda p: miles_between(lat, lon, p["lat"], p["lon"]))
        return best["name"], miles_between(lat, lon, best["lat"], best["lon"])

    def random_point(self, rng):
        x0, y0, x1, y1 = self.bbox
        while True:
            lon, lat = rng.uniform(x0, x1), rng.uniform(y0, y1)
            if self.contains(lon, lat):
                return lon, lat


def describe(wv, lon, lat):
    county = wv.county(lon, lat)
    place, miles = wv.nearest_place(lon, lat)
    where = f"in {place}" if miles < 1.5 else f"near {place}"
    name = f"{where[0].upper()}{where[1:]}" + (f", {county}" if county else "")
    return name, county, {"name": place, "miles": round(miles, 1)}


# ---------------------------------------------------------------------------
# Candidate store
# ---------------------------------------------------------------------------

_lock = threading.Lock()


def load_candidates():
    return json.loads(CANDIDATES_JSON.read_text()) if CANDIDATES_JSON.exists() else []


def save_candidates(cands):
    tmp = CANDIDATES_JSON.with_suffix(".tmp")
    tmp.write_text(json.dumps(cands, indent=1))
    tmp.replace(CANDIDATES_JSON)


def spacing_problem(cands, lon, lat, per_cell):
    cell = (math.floor(lon / CELL_DEG), math.floor(lat / CELL_DEG))
    in_cell = 0
    for c in cands:
        if miles_between(lat, lon, c["lat"], c["lon"]) < MIN_SPACING_MILES:
            return "too close to another candidate"
        if (math.floor(c["lon"] / CELL_DEG), math.floor(c["lat"] / CELL_DEG)) == cell:
            in_cell += 1
    return "area already has enough candidates" if in_cell >= per_cell else None


def http_get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------------------
# WVDOT dashcam frames
# ---------------------------------------------------------------------------

TESSERACT = os.environ.get("TESSERACT_EXE") or r"C:\Program Files\Tesseract-OCR\tesseract.exe"
COORD_RE = re.compile(r"([NS])(\d{2})[.,]?(\d{5})([EW])(\d{2,3})[.,]?(\d{5})")
DATE_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})(\d{2})/(\d{2})/(\d{4})")


def _tesseract(img, whitelist):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    cmd = [TESSERACT, "stdin", "-", "--psm", "7", "-c", f"tessedit_char_whitelist={whitelist}"]
    return subprocess.run(cmd, input=buf.getvalue(), capture_output=True, timeout=60).stdout.decode(errors="replace")


def _strip_variants(strip):
    """Several binarizations: the white text sits on anything from black to a white hood."""
    g = ImageOps.grayscale(strip).resize((strip.width * 2, strip.height * 2), Image.Resampling.LANCZOS)
    yield ImageOps.expand(g, border=16, fill=0)
    for t in (170, 200, 225):
        yield ImageOps.expand(ImageOps.invert(g.point(lambda p, t=t: 255 if p > t else 0)), border=16, fill=255)
    e = ImageOps.autocontrast(g.filter(ImageFilter.UnsharpMask(radius=2, percent=250)))
    yield ImageOps.expand(ImageOps.invert(e.point(lambda p: 255 if p > 200 else 0)), border=16, fill=255)


def read_overlay(im):
    """OCR the Nextbase text strip -> (lat, lon, votes, reads, captured_iso)."""
    w, h = im.size
    coords_strip = im.crop((int(w * 0.05), int(h * 0.945), int(w * 0.62), h))
    reads = []
    for v in _strip_variants(coords_strip):
        m = COORD_RE.search(_tesseract(v, "NSEW0123456789. ").replace(" ", ""))
        if m:
            lat = float(f"{m[2]}.{m[3]}") * (-1 if m[1] == "S" else 1)
            lon = float(f"{m[5]}.{m[6]}") * (-1 if m[4] == "W" else 1)
            reads.append((round(lat, 5), round(lon, 5)))
    if not reads:
        return None
    (lat, lon), votes = Counter(reads).most_common(1)[0]
    captured = None
    date_strip = im.crop((int(w * 0.55), int(h * 0.945), int(w * 0.95), h))
    for v in list(_strip_variants(date_strip))[1:3]:
        m = DATE_RE.search(_tesseract(v, "0123456789:/ ").replace(" ", ""))
        if m:
            try:
                captured = datetime(int(m[6]), int(m[5]), int(m[4])).date().isoformat()
                break
            except ValueError:
                pass
    return lat, lon, votes, len(reads), captured


class Wvdot:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self._dates = None

    def _list(self, **query):
        return json.loads(http_get(f"{self.base}/?{urllib.parse.urlencode(query)}", timeout=30))

    def dates(self):
        """Distinct YYMMDD prefixes, found by hopping from one date to the next."""
        if self._dates is None:
            cache = WORK / "wvdot_dates.json"
            if cache.exists() and time.time() - cache.stat().st_mtime < 7 * 86400:
                self._dates = json.loads(cache.read_text())
            else:
                dates, key = [], ""
                while True:
                    objs = self._list(start=key, limit=1).get("objects", [])
                    if not objs:
                        break
                    dates.append(objs[0]["name"][:6])
                    key = dates[-1] + "`"  # '`' sorts just after '_': skip the rest of this date
                cache.write_text(json.dumps(dates))
                self._dates = dates
        return self._dates

    def random_frame(self, rng):
        """Random date -> random time -> the next clip -> a frame from its middle."""
        day = rng.choice(self.dates())
        start = f"{day}_{rng.randrange(24):02d}{rng.randrange(60):02d}{rng.randrange(60):02d}"
        objs = self._list(start=start, limit=1).get("objects", [])
        if not objs:
            return None
        clip = "_".join(objs[0]["name"].split("_")[:4])
        frames = [o["name"] for o in self._list(prefix=clip + "_", limit=1000).get("objects", [])]
        if not frames:
            return None
        trim = len(frames) // 10  # skip clip edges (parking, pulling out)
        name = rng.choice(frames[trim: len(frames) - trim] or frames)
        return name, http_get(f"{self.base}/{urllib.parse.quote(name)}")


NEIGHBOR_MAX_DEG = 0.008  # ~0.5 mi: adjacent frames are about a second apart


def neighbor_confirms(src, name, lat, lon):
    """Read the next (or previous) frame of the same clip; True if its GPS
    text agrees with (lat, lon). A single OCR read can misread a digit, and a
    wrong digit would silently move the answer, so this is a second opinion."""
    m = re.search(r"_Frame_(\d+)\.jpg$", name)
    if not m:
        return False
    n, width = int(m[1]), len(m[1])
    for other in (n + 1, n - 1, n + 2):
        if other < 0:
            continue
        neighbor = name[: m.start(1)] + f"{other:0{width}d}" + name[m.end(1):]
        try:
            data = http_get(f"{src.base}/{urllib.parse.quote(neighbor)}")
        except Exception:  # noqa: BLE001 — frame missing at a clip edge
            continue
        ocr = read_overlay(Image.open(io.BytesIO(data)).convert("RGB"))
        if ocr:
            return abs(ocr[0] - lat) < NEIGHBOR_MAX_DEG and abs(ocr[1] - lon) < NEIGHBOR_MAX_DEG
    return False


def wvdot_candidate(src, rng, wv, cands, per_cell):
    got = src.random_frame(rng)
    if not got:
        return None, "no clip at that time"
    name, data = got
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    body = im.crop((0, 0, w, int(h * (1 - WVDOT_CROP_BOTTOM))))
    brightness = ImageStat.Stat(ImageOps.grayscale(body)).mean[0]
    if brightness < DARK_LIMIT:
        return None, "too dark"
    ocr = read_overlay(im)
    if not ocr:
        return None, "no GPS text"
    lat, lon, votes, reads, captured = ocr
    if not wv.contains(lon, lat):
        return None, "outside WV"
    with _lock:
        problem = spacing_problem(cands, lon, lat, per_cell)
    if problem:
        return None, problem
    confirmed = votes >= 2 or neighbor_confirms(src, name, lat, lon)
    if not confirmed and votes < 2:
        return None, "single OCR read not confirmed by neighbor frame"
    cid = "w_" + re.sub(r"\W", "_", name.rsplit(".", 1)[0])
    im.save(CANDIDATES_DIR / f"{cid}.jpg", quality=92)
    im.crop((0, int(h * 0.93), w, h)).save(CANDIDATES_DIR / f"{cid}_strip.jpg", quality=92)
    label, county, near = describe(wv, lon, lat)
    when = datetime.fromisoformat(captured).strftime("%B %Y") if captured and not captured.startswith("2020-01") else None
    return {
        "id": cid,
        "source": "wvdot",
        "sourceRef": name,
        "lon": lon,
        "lat": lat,
        "votes": votes,
        "reads": reads,
        "neighborConfirmed": votes < 2,
        "captured": captured,
        "county": county,
        "near": near,
        "name": label,
        "credit": "WVDOT dashcam",
        "funFact": "A WVDOT dashcam frame" + (f", {when}." if when else "."),
        "brightness": round(brightness),
        "file": f"candidates/{cid}.jpg",
        "strip": f"candidates/{cid}_strip.jpg",
        "cropBottom": WVDOT_CROP_BOTTOM,
    }, None


# ---------------------------------------------------------------------------
# Mapillary
# ---------------------------------------------------------------------------

def mapillary_candidate(token, rng, wv, cands, per_cell):
    lon, lat = wv.random_point(rng)
    with _lock:
        if spacing_problem(cands, lon, lat, per_cell):
            return None, "area already covered"
    for half in (0.01, 0.03):  # ~1 km, then ~3 km around the random point
        q = urllib.parse.urlencode({
            "fields": "id,thumb_2048_url,computed_geometry,geometry,captured_at,is_pano,creator",
            "bbox": f"{lon - half},{lat - half},{lon + half},{lat + half}",
            "limit": 50,
        })
        data = json.loads(http_get(f"https://graph.mapillary.com/images?{q}",
                                   headers={"Authorization": f"OAuth {token}"}, timeout=30))
        imgs = [i for i in data.get("data", []) if not i.get("is_pano") and i.get("thumb_2048_url")]
        if imgs:
            break
    else:
        return None, "no Mapillary imagery nearby"
    img = max(imgs, key=lambda i: i.get("captured_at") or 0)  # most recent
    geom = img.get("computed_geometry") or img.get("geometry")
    ilon, ilat = geom["coordinates"]
    if not wv.contains(ilon, ilat):
        return None, "outside WV"
    with _lock:
        problem = spacing_problem(cands, ilon, ilat, per_cell)
    if problem:
        return None, problem
    raw = http_get(img["thumb_2048_url"])  # thumbnail URLs expire: download now
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    brightness = ImageStat.Stat(ImageOps.grayscale(im)).mean[0]
    if brightness < DARK_LIMIT:
        return None, "too dark"
    cid = f"m_{img['id']}"
    im.save(CANDIDATES_DIR / f"{cid}.jpg", quality=92)
    label, county, near = describe(wv, ilon, ilat)
    captured = datetime.fromtimestamp(img["captured_at"] / 1000, tz=timezone.utc).date().isoformat() if img.get("captured_at") else None
    user = (img.get("creator") or {}).get("username") or "a Mapillary contributor"
    return {
        "id": cid,
        "source": "mapillary",
        "sourceRef": str(img["id"]),
        "lon": round(ilon, 6),
        "lat": round(ilat, 6),
        "votes": None,
        "captured": captured,
        "county": county,
        "near": near,
        "name": label,
        "credit": f"© {user}, Mapillary (CC BY-SA 4.0)",
        "funFact": "Crowd-sourced street imagery from Mapillary"
        + (f", {datetime.fromisoformat(captured).strftime('%B %Y')}." if captured else "."),
        "brightness": round(brightness),
        "file": f"candidates/{cid}.jpg",
        "strip": None,
        "cropBottom": 0,
    }, None


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_sample(args):
    global TESSERACT
    load_env()
    TESSERACT = os.environ.get("TESSERACT_EXE") or TESSERACT  # .env may set it
    CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)
    wv = WV()
    cands = load_candidates()
    rng = random.Random(args.seed)

    if args.source == "wvdot":
        base = os.environ.get("WVDOT_FRAMES_URL")
        if not base:
            sys.exit("Set WVDOT_FRAMES_URL (env var or .env) to the bucket URL ending in /o")
        if not Path(TESSERACT).exists() and not shutil.which("tesseract"):
            sys.exit(f"Tesseract not found at {TESSERACT}; set TESSERACT_EXE")
        src = Wvdot(base)
        print(f"WVDOT: {len(src.dates())} recording dates")
        make = lambda r: wvdot_candidate(src, r, wv, cands, args.per_cell)  # noqa: E731
    else:
        token = os.environ.get("MAPILLARY_TOKEN")
        if not token:
            sys.exit("Set MAPILLARY_TOKEN (env var or .env)")
        make = lambda r: mapillary_candidate(token, r, wv, cands, args.per_cell)  # noqa: E731

    target = args.count
    added, attempts, reasons = 0, 0, Counter()
    max_attempts = args.count * args.max_tries
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = set()

        def submit():
            nonlocal attempts
            attempts += 1
            futures.add(pool.submit(make, random.Random(rng.random())))

        for _ in range(args.workers * 2):
            submit()
        while futures:
            done = next(as_completed(futures))
            futures.discard(done)
            try:
                cand, why = done.result()
            except Exception as e:  # noqa: BLE001 — network hiccups: count and move on
                cand, why = None, f"error: {type(e).__name__}"
            if cand and added >= target:
                reasons["over target"] += 1  # a frame still in flight when the target was reached
            elif cand:
                with _lock:
                    if not spacing_problem(cands, cand["lon"], cand["lat"], args.per_cell):
                        cands.append(cand)
                        save_candidates(cands)
                        added += 1
                        print(f"  + {added}/{target}  {cand['name']}  ({cand['source']})", flush=True)
                    else:
                        reasons["spacing (race)"] += 1
            else:
                reasons[why] += 1
            if added < target and attempts < max_attempts:
                submit()
    print(f"\nAdded {added} candidates in {attempts} attempts. Skipped: {dict(reasons.most_common())}")
    print(f"Total candidates: {len(cands)}. Review at http://localhost:8000/tools/review.html")


def cmd_verify(_args):
    """Neighbor-frame check for WVDOT candidates with a single OCR read.
    Unconfirmed ones are marked rejected ("coords") in the review file."""
    load_env()
    src = Wvdot(os.environ["WVDOT_FRAMES_URL"])
    cands = load_candidates()
    review = json.loads(REVIEW_JSON.read_text()) if REVIEW_JSON.exists() else {}
    todo = [c for c in cands if c["source"] == "wvdot" and (c.get("votes") or 0) < 2 and not c.get("neighborConfirmed")]
    print(f"Checking {len(todo)} single-read candidates against neighbor frames…")
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda c: neighbor_confirms(src, c["sourceRef"], c["lat"], c["lon"]), todo))
    ok = 0
    for c, good in zip(todo, results):
        if good:
            c["neighborConfirmed"] = True
            ok += 1
        elif c["id"] not in review:
            review[c["id"]] = {"decision": "reject", "reason": "coords", "auto": "neighbor frame disagreed or unreadable"}
    save_candidates(cands)
    REVIEW_JSON.write_text(json.dumps(review, indent=1))
    print(f"Confirmed {ok}; auto-rejected {len(todo) - ok} (you can still override in review).")


def cmd_status(_args):
    cands = load_candidates()
    review = json.loads(REVIEW_JSON.read_text()) if REVIEW_JSON.exists() else {}
    by_source = Counter(c["source"] for c in cands)
    decisions = Counter((review.get(c["id"]) or {}).get("decision", "unreviewed") for c in cands)
    counties = Counter(c["county"] for c in cands if (review.get(c["id"]) or {}).get("decision") == "keep")
    print(f"Candidates: {len(cands)} {dict(by_source)}")
    print(f"Review: {dict(decisions)}")
    print(f"Kept per county: {dict(counties.most_common())}")


def circle(lon, lat, miles, n=48):
    """Geodesic circle as a GeoJSON polygon ring (counter-clockwise)."""
    r = miles / 3958.8
    la, lo = math.radians(lat), math.radians(lon)
    ring = []
    for i in range(n + 1):
        b = 2 * math.pi * i / n
        la2 = math.asin(math.sin(la) * math.cos(r) + math.cos(la) * math.sin(r) * math.cos(b))
        lo2 = lo + math.atan2(math.sin(b) * math.sin(r) * math.cos(la), math.cos(r) - math.sin(la) * math.sin(la2))
        ring.append([round(math.degrees(lo2), 6), round(math.degrees(la2), 6)])
    return list(reversed(ring))  # bearings go clockwise; reverse for GeoJSON's CCW outer ring


def cmd_finalize(args):
    cands = {c["id"]: c for c in load_candidates()}
    review = json.loads(REVIEW_JSON.read_text()) if REVIEW_JSON.exists() else {}
    kept = [cands[i] for i, r in review.items() if r.get("decision") == "keep" and i in cands]
    if not kept:
        sys.exit("No kept candidates yet — review them first (tools/review.html).")
    rng = random.Random(args.seed)
    rng.shuffle(kept)  # round numbers must not follow source, date, or place
    kept = kept[: args.count]

    ROUNDS_DIR.mkdir(parents=True, exist_ok=True)
    stale = [p for p in ROUNDS_DIR.glob("r[0-9][0-9][0-9].jpg")]
    if stale and not args.overwrite:
        sys.exit(f"{len(stale)} r###.jpg files already in {ROUNDS_DIR}; re-run with --overwrite to replace them.")
    for p in stale:
        p.unlink()

    features, problems = [], 0
    for i, c in enumerate(kept, 1):
        lid = f"r{i:03d}"
        im = Image.open(WORK / c["file"]).convert("RGB")
        if c.get("cropBottom"):
            im = im.crop((0, 0, im.width, int(im.height * (1 - c["cropBottom"]))))
        buf = io.BytesIO()
        im.save(buf, "PNG")
        out = ROUNDS_DIR / f"{lid}.jpg"
        prepare(io.BytesIO(buf.getvalue()), out)
        issues = verify_clean(out)
        if issues:
            problems += 1
            print(f"FAIL {lid}: {issues}")
        features.append({
            "type": "Feature",
            "properties": {
                "landmark_id": lid,
                "name": c["name"],
                "prompt_text": PROMPT,
                "set_name": "Pool",
                "round_order": None,  # pool: not played live until given a round number
                "image_path": f"assets/rounds/{lid}.jpg",
                "fun_fact": c["funFact"],
                "credit": c["credit"],
                "_source": c["source"],
                "_source_ref": c["sourceRef"],
                "_lon": c["lon"],
                "_lat": c["lat"],
            },
            "geometry": {"type": "Polygon", "coordinates": [circle(c["lon"], c["lat"], HIT_RADIUS_MILES)]},
        })
    ANSWERS_GEOJSON.write_text(json.dumps({"type": "FeatureCollection", "features": features}, indent=1))
    print(f"Wrote {len(features)} photos to {ROUNDS_DIR} and answers to {ANSWERS_GEOJSON} (PRIVATE — keep it out of git).")
    print("Next: python scripts/load_landmarks.py  (dry run), then add --apply.")
    sys.exit(1 if problems else 0)


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample", help="download candidates")
    s.add_argument("source", choices=["wvdot", "mapillary"])
    s.add_argument("--count", type=int, default=50, help="candidates to add")
    s.add_argument("--workers", type=int, default=4)
    s.add_argument("--per-cell", type=int, default=3, help="max candidates per 0.25° cell (spread)")
    s.add_argument("--max-tries", type=int, default=8, help="give up after count × this many attempts")
    s.add_argument("--seed", type=int, default=None)
    s.set_defaults(func=cmd_sample)
    v = sub.add_parser("verify", help="confirm single-read WVDOT coordinates with neighbor frames")
    v.set_defaults(func=cmd_verify)
    st = sub.add_parser("status", help="counts so far")
    st.set_defaults(func=cmd_status)
    f = sub.add_parser("finalize", help="write round photos + private answers from the kept set")
    f.add_argument("--count", type=int, default=100)
    f.add_argument("--seed", type=int, default=2026)
    f.add_argument("--overwrite", action="store_true", help="replace existing assets/rounds/r###.jpg")
    f.set_defaults(func=cmd_finalize)
    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
