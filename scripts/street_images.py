#!/usr/bin/env python3
"""
Street-level round photos for WV GeoGuess: sample -> review -> finalize.

    1. SAMPLE candidates (downloads into work/, which is git-ignored):
         python scripts/street_images.py sample wvdot --count 150
         python scripts/street_images.py sample mapillary --count 150
         python scripts/street_images.py sample mapillary --urban --count 80   # towns only
         python scripts/street_images.py sample landmarks --count 80           # photos facing courthouses, bridges...
         python scripts/street_images.py add 123456789 https://www.mapillary.com/app/?pKey=987654321
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
import urllib.error
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
MIN_SPACING_MILES = 2.0  # no two candidates closer than this (--urban uses less)
URBAN_MIN_POP = 2500  # Census "urban" threshold; WV has 63 places this size
MIN_SPACING = MIN_SPACING_MILES  # set per run by `sample`
URBAN = False  # set per run by `sample --urban`


def town_radius(pop):
    """Radius of a town's core, in miles (~0.55 mi for 2,500 people ... 2 mi for Charleston).
    Kept tight on purpose: town centers have the signs and buildings that make a
    photo guessable; the edges look like any rural road."""
    return max(0.4, min(2.0, math.sqrt(pop) / 90))


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
        self.towns = [p for p in self.places if (p.get("pop") or 0) >= URBAN_MIN_POP]

    def contains(self, lon, lat):
        return _in_rings(lon, lat, self.rings)

    def county(self, lon, lat):
        return next((name for name, rings in self.counties if _in_rings(lon, lat, rings)), None)

    def nearest_place(self, lon, lat):
        best = min(self.places, key=lambda p: miles_between(lat, lon, p["lat"], p["lon"]))
        return best["name"], miles_between(lat, lon, best["lat"], best["lon"])

    def town_context(self, lon, lat):
        """Nearest town of URBAN_MIN_POP+ and whether (lon, lat) is inside its built-up radius."""
        t = min(self.towns, key=lambda p: miles_between(lat, lon, p["lat"], p["lon"]))
        miles = miles_between(lat, lon, t["lat"], t["lon"])
        return {"name": t["name"], "pop": t["pop"], "miles": round(miles, 1), "urban": miles <= town_radius(t["pop"])}

    def random_town_point(self, rng):
        """A random spot inside a random town, bigger towns more often (weight ~ sqrt(pop))."""
        t = rng.choices(self.towns, weights=[math.sqrt(p["pop"]) for p in self.towns])[0]
        r = town_radius(t["pop"]) * math.sqrt(rng.random()) / 69.0  # miles -> degrees latitude
        a = rng.uniform(0, 2 * math.pi)
        return t["lon"] + r * math.cos(a) / math.cos(math.radians(t["lat"])), t["lat"] + r * math.sin(a)

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
        if miles_between(lat, lon, c["lat"], c["lon"]) < MIN_SPACING:
            return "too close to another candidate"
        if (math.floor(c["lon"] / CELL_DEG), math.floor(c["lat"] / CELL_DEG)) == cell:
            in_cell += 1
    return "area already has enough candidates" if in_cell >= per_cell else None


def http_get(url, headers=None, timeout=60, retries=3):
    """GET with retries on transient failures (Mapillary returns occasional
    500s marked is_transient; rate limits come back as 429)."""
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries:
                raise
        time.sleep(1.5 * 2 ** attempt + random.random())


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
    town = wv.town_context(lon, lat)
    if URBAN and not town["urban"]:
        return None, "not in a town"
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
        "town": town,
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
    lon, lat = wv.random_town_point(rng) if URBAN else wv.random_point(rng)
    with _lock:
        if spacing_problem(cands, lon, lat, per_cell):
            return None, "area already covered"
    # ~0.5 km then ~1.3 km in towns; ~1 km then ~3 km anywhere else
    for half in ((0.005, 0.012) if URBAN else (0.01, 0.03)):
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
    town = wv.town_context(ilon, ilat)
    if URBAN and not town["urban"]:
        return None, "not in a town"
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
        "town": town,
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
# Landmarks (OpenStreetMap places + Mapillary photos facing them), and
# hand-picked Mapillary images
# ---------------------------------------------------------------------------

OSM_RAW = WORK / "osm_raw.json"
OVERPASS_QUERY = """[out:json][timeout:180];
area["ISO3166-2"="US-WV"][admin_level=4]->.wv;
(
  nwr["amenity"="courthouse"](area.wv);
  nwr["amenity"="townhall"]["name"](area.wv);
  nwr["tourism"~"^(attraction|museum|viewpoint)$"]["wikidata"](area.wv);
  nwr["historic"]["wikidata"](area.wv);
  nwr["man_made"="bridge"]["name"](area.wv);
  way["bridge"]["wikidata"](area.wv);
  nwr["leisure"="stadium"]["name"](area.wv);
  nwr["amenity"="university"]["name"](area.wv);
  nwr["building"]["wikidata"](area.wv);
  nwr["railway"="station"]["name"](area.wv);
);
out center tags;"""
# How often each kind of place is tried: courthouses and big bridges are the
# most recognizable things in most WV towns.
POI_WEIGHTS = [
    ("amenity=courthouse", 5), ("man_made=bridge", 4), ("bridge", 4), ("amenity=university", 3),
    ("leisure=stadium", 3), ("amenity=townhall", 3), ("tourism", 3), ("railway=station", 2),
    ("historic", 2), ("building", 2),
]
POI_SKIP_NAMES = re.compile(r"farm|cemetery|substation|water tower|fire (station|department)|tank", re.I)
FACING_MAX_DEG = 30  # the photo's camera heading must point within this of the landmark
FACING_DIST_M = (15, 200)  # ...from this far away
MAPILLARY_FIELDS = ("id,thumb_2048_url,thumb_original_url,computed_geometry,geometry,captured_at,"
                    "is_pano,creator,compass_angle,computed_compass_angle")


def _poi_kind(tags):
    for kind, _ in POI_WEIGHTS:
        key, _, value = kind.partition("=")
        if (value and tags.get(key) == value) or (not value and key in tags):
            return kind
    return None


def load_pois(refresh=False):
    """Named WV landmarks from OpenStreetMap (© OpenStreetMap contributors, ODbL)."""
    if refresh or not OSM_RAW.exists():
        req = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode(),
            headers={"User-Agent": "WV-GeoGuess content pipeline (WVDOT GIS Day)"},
        )
        with urllib.request.urlopen(req, timeout=240) as r:
            OSM_RAW.write_bytes(r.read())
    pois = []
    for e in json.loads(OSM_RAW.read_text())["elements"]:
        t = e.get("tags", {})
        name = t.get("name")
        pt = e.get("center") or e
        if not name or "lat" not in pt or POI_SKIP_NAMES.search(name):
            continue
        kind = _poi_kind(t)
        if kind:
            pois.append({"name": name, "kind": kind, "lat": pt["lat"], "lon": pt["lon"],
                         "osm": f"{e['type']}/{e['id']}", "wikipedia": t.get("wikipedia")})
    return pois


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def mapillary_images(token, lon, lat, half):
    q = urllib.parse.urlencode({"fields": MAPILLARY_FIELDS, "bbox": f"{lon - half},{lat - half},{lon + half},{lat + half}", "limit": 100})
    data = json.loads(http_get(f"https://graph.mapillary.com/images?{q}", headers={"Authorization": f"OAuth {token}"}, timeout=30))
    return data.get("data", [])


def wikipedia_blurb(tag):
    """First sentence of the English Wikipedia summary for an OSM wikipedia=en:Title tag."""
    if not tag or not tag.startswith("en:"):
        return None
    title = urllib.parse.quote(tag[3:].replace(" ", "_"))
    try:
        data = json.loads(http_get(f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}",
                                   headers={"User-Agent": "WV-GeoGuess (WVDOT GIS Day)"}, timeout=20))
    except Exception:  # noqa: BLE001 - a fun fact is optional
        return None
    text = (data.get("extract") or "").strip()
    first = re.split(r"(?<=[.!?])\s+", text)[0] if text else ""
    return (first[:237] + "...") if len(first) > 240 else (first or None)


def pano_view(pano, x, y=0.5, fov_deg=90, out_w=1600, out_h=900):
    """A flat 16:9 photo from an equirectangular 360° panorama, looking at the
    spot (x, y) — both 0..1 across the panorama image, exactly what Mapillary
    puts in its URLs as x= and y= when you're viewing a panorama."""
    import numpy as np

    src = np.asarray(pano.convert("RGB"), dtype=np.float32)
    H, W = src.shape[:2]
    yaw = (x - 0.5) * 2 * math.pi
    pitch = (0.5 - y) * math.pi
    f = (out_w / 2) / math.tan(math.radians(fov_deg) / 2)
    X, Y = np.meshgrid(np.arange(out_w) - out_w / 2 + 0.5, np.arange(out_h) - out_h / 2 + 0.5)
    Z = np.full_like(X, f)
    cp, sp = math.cos(pitch), math.sin(pitch)
    Y2, Z2 = Y * cp - Z * sp, Y * sp + Z * cp  # tilt up/down
    cy, sy = math.cos(yaw), math.sin(yaw)
    X3, Z3 = X * cy + Z2 * sy, -X * sy + Z2 * cy  # turn left/right
    lon = np.arctan2(X3, Z3)
    lat = np.arctan2(-Y2, np.hypot(X3, Z3))
    u = (lon / (2 * math.pi) + 0.5) * W - 0.5
    v = (0.5 - lat / math.pi) * H - 0.5
    # bilinear sampling; wrap around horizontally, clamp vertically
    u0, v0 = np.floor(u).astype(int), np.floor(v).astype(int)
    du, dv = (u - u0)[..., None], (v - v0)[..., None]
    u0w, u1w = u0 % W, (u0 + 1) % W
    v0c, v1c = np.clip(v0, 0, H - 1), np.clip(v0 + 1, 0, H - 1)
    out = (src[v0c, u0w] * (1 - du) * (1 - dv) + src[v0c, u1w] * du * (1 - dv)
           + src[v1c, u0w] * (1 - du) * dv + src[v1c, u1w] * du * dv)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def mapillary_to_candidate(img, wv, *, label=None, fact=None, extra=None, credit_suffix="", pil=None):
    """Download a Mapillary image record and turn it into a candidate (no spacing checks)."""
    geom = img.get("computed_geometry") or img.get("geometry")
    ilon, ilat = geom["coordinates"]
    if not wv.contains(ilon, ilat):
        return None, "outside WV"
    if pil is not None:
        im = pil.convert("RGB")
    else:
        raw = http_get(img["thumb_2048_url"])  # thumbnail URLs expire: download now
        im = Image.open(io.BytesIO(raw)).convert("RGB")
    brightness = ImageStat.Stat(ImageOps.grayscale(im)).mean[0]
    cid = f"m_{img['id']}"
    im.save(CANDIDATES_DIR / f"{cid}.jpg", quality=92)
    auto_label, county, near = describe(wv, ilon, ilat)
    captured = datetime.fromtimestamp(img["captured_at"] / 1000, tz=timezone.utc).date().isoformat() if img.get("captured_at") else None
    user = (img.get("creator") or {}).get("username") or "a Mapillary contributor"
    cand = {
        "id": cid,
        "source": "mapillary",
        "sourceRef": str(img["id"]),
        "lon": round(ilon, 6),
        "lat": round(ilat, 6),
        "votes": None,
        "captured": captured,
        "county": county,
        "near": near,
        "town": wv.town_context(ilon, ilat),
        "name": label or auto_label,
        "credit": f"© {user}, Mapillary (CC BY-SA 4.0){credit_suffix}",
        "funFact": fact or ("Crowd-sourced street imagery from Mapillary"
                            + (f", {datetime.fromisoformat(captured).strftime('%B %Y')}." if captured else ".")),
        "brightness": round(brightness),
        "file": f"candidates/{cid}.jpg",
        "strip": None,
        "cropBottom": 0,
    }
    cand.update(extra or {})
    return cand, None


def landmark_candidate(token, poi, wv, cands, per_cell):
    """A Mapillary photo taken near `poi` whose camera points at it."""
    with _lock:
        if spacing_problem(cands, poi["lon"], poi["lat"], per_cell):
            return None, "area already covered"
        if any((c.get("poi") or {}).get("osm") == poi["osm"] for c in cands):
            return None, "landmark already used"
    best, best_score = None, None
    for img in mapillary_images(token, poi["lon"], poi["lat"], 0.002):  # ~200 m
        if img.get("is_pano") or not img.get("thumb_2048_url"):
            continue
        heading = img.get("computed_compass_angle", img.get("compass_angle"))
        geom = img.get("computed_geometry") or img.get("geometry")
        if heading is None or not geom:
            continue
        ilon, ilat = geom["coordinates"]
        dist_m = miles_between(ilat, ilon, poi["lat"], poi["lon"]) * 1609.344
        if not FACING_DIST_M[0] <= dist_m <= FACING_DIST_M[1]:
            continue
        off = abs((bearing_deg(ilat, ilon, poi["lat"], poi["lon"]) - heading + 180) % 360 - 180)
        if off > FACING_MAX_DEG:
            continue
        age_years = (time.time() * 1000 - (img.get("captured_at") or 0)) / 3.15e10
        score = off / FACING_MAX_DEG + dist_m / FACING_DIST_M[1] + min(age_years, 10) / 10
        if best_score is None or score < best_score:
            best, best_score = img, score
    if not best:
        return None, "no photo facing it"
    place = wv.nearest_place(poi["lon"], poi["lat"])[0]
    county = wv.county(poi["lon"], poi["lat"]) or ""
    where = place if place.lower() not in poi["name"].lower() else county
    blurb = wikipedia_blurb(poi.get("wikipedia"))
    cand, why = mapillary_to_candidate(
        best, wv,
        label=f"{poi['name']}, {where}" if where else poi["name"],
        fact=f"{blurb} (Wikipedia)" if blurb else None,
        extra={"poi": {"name": poi["name"], "kind": poi["kind"], "osm": poi["osm"]}},
        credit_suffix=" · place: © OpenStreetMap contributors",
    )
    if cand and cand["brightness"] < DARK_LIMIT:
        return None, "too dark"
    return cand, why


def cmd_add(args):
    """Add hand-picked Mapillary images by ID or URL; they're marked 'keep'."""
    load_env()
    token = os.environ.get("MAPILLARY_TOKEN") or sys.exit("Set MAPILLARY_TOKEN (env var or .env)")
    CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)
    text = " ".join(args.ids) + (" " + Path(args.file).read_text() if args.file else "")
    views = {}  # image id -> (x, y) the viewer was looking at, from a URL's x= / y=
    ids = []
    for item in text.split():
        if "pKey=" in item:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(item).query)
            mid = q["pKey"][0]
            if "x" in q:
                views[mid] = (float(q["x"][0]), float(q.get("y", ["0.5"])[0]))
        elif re.fullmatch(r"\d{6,}", item):
            mid = item
        else:
            continue
        if mid not in ids:
            ids.append(mid)
    if not ids:
        sys.exit("No Mapillary image IDs found. Paste IDs or URLs like https://www.mapillary.com/app/?pKey=123456789")
    wv = WV()
    cands = load_candidates()
    review = json.loads(REVIEW_JSON.read_text()) if REVIEW_JSON.exists() else {}
    for mid in ids:
        try:
            img = json.loads(http_get(f"https://graph.mapillary.com/{mid}?fields={MAPILLARY_FIELDS}",
                                      headers={"Authorization": f"OAuth {token}"}, timeout=30))
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {mid}: {e}")
            continue
        pil = None
        if img.get("is_pano"):
            if mid not in views and not args.allow_pano:
                print(f"skip {mid}: 360-degree panorama. Paste the full mapillary.com URL (it records "
                      "where you were looking, x=/y=) to get a flat view, or --allow-pano to use it warped.")
                continue
            if mid in views:
                pano = Image.open(io.BytesIO(http_get(img.get("thumb_original_url") or img["thumb_2048_url"])))
                pil = pano_view(pano, *views[mid])
                print(f"  panorama {mid}: rendered a flat view at x={views[mid][0]:.3f}, y={views[mid][1]:.3f}")
        cand, why = mapillary_to_candidate(img, wv, extra={"handpicked": True}, pil=pil)
        if not cand:
            print(f"skip {mid}: {why}")
            continue
        cands = [c for c in cands if c["id"] != cand["id"]] + [cand]
        review[cand["id"]] = {"decision": "keep", "handpicked": True}
        print(f"  + {cand['name']}  ({cand['credit']})")
    save_candidates(cands)
    REVIEW_JSON.write_text(json.dumps(review, indent=1))
    print("Hand-picked images are marked 'keep'; they show up in tools/review.html too.")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_sample(args):
    global TESSERACT, URBAN, MIN_SPACING
    load_env()
    URBAN = args.urban
    landmarks = args.source == "landmarks"
    MIN_SPACING = args.min_spacing if args.min_spacing is not None else (
        0.3 if landmarks else 0.75 if URBAN else MIN_SPACING_MILES)
    if args.per_cell is None:
        args.per_cell = 20 if landmarks else 8 if URBAN else 3
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
    elif args.source == "landmarks":
        token = os.environ.get("MAPILLARY_TOKEN") or sys.exit("Set MAPILLARY_TOKEN (env var or .env)")
        pois = load_pois(refresh=args.refresh_places)
        weights = dict(POI_WEIGHTS)
        # weighted shuffle: courthouses and bridges come up first more often
        order = sorted(pois, key=lambda p: rng.random() ** (1 / weights[p["kind"]]), reverse=True)
        queue_lock = threading.Lock()
        print(f"Landmarks: {len(pois)} named WV places from OpenStreetMap")

        def make(_r):
            with queue_lock:
                if not order:
                    return None, "no landmarks left"
                poi = order.pop(0)
            return landmark_candidate(token, poi, wv, cands, args.per_cell)
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


def cmd_annotate(_args):
    """Add town context (nearest town, population, in-town or not) to existing candidates."""
    wv = WV()
    cands = load_candidates()
    for c in cands:
        c["town"] = wv.town_context(c["lon"], c["lat"])
    save_candidates(cands)
    urban = sum(c["town"]["urban"] for c in cands)
    print(f"Annotated {len(cands)} candidates: {urban} in a town of {URBAN_MIN_POP:,}+, {len(cands) - urban} rural.")


def cmd_answer_key(_args):
    """A PRINTABLE, PRIVATE answer key (work/answer-key.html) for Fallback B:
    if AGOL is down, show the photos and read the answers off paper."""
    import html
    fc = json.loads(ANSWERS_GEOJSON.read_text()) if ANSWERS_GEOJSON.exists() else sys.exit("Run finalize first.")
    rows = []
    for f in sorted(fc["features"], key=lambda f: f["properties"]["landmark_id"]):
        p = f["properties"]
        rows.append(
            f"<tr><td><img src='../{html.escape(p['image_path'])}'></td><td><b>{html.escape(p['landmark_id'])}</b></td>"
            f"<td><b>{html.escape(p['name'])}</b><br><small>{html.escape(p.get('fun_fact') or '')}</small>"
            f"<br><small>{p['_lat']:.5f}, {p['_lon']:.5f}</small></td></tr>")
    out = WORK / "answer-key.html"
    out.write_text("<!doctype html><meta charset=utf-8><title>WV GeoGuess answer key (PRIVATE)</title>"
                   "<style>body{font:12px system-ui}img{width:160px}td{border-bottom:1px solid #ccc;padding:4px;vertical-align:top}"
                   "tr{break-inside:avoid}</style><h1>WV GeoGuess answer key — PRIVATE, do not share</h1>"
                   f"<table>{''.join(rows)}</table>", encoding="utf-8")
    print(f"Wrote {out} ({len(rows)} rounds). Open it through scripts/serve.py and print; keep it off the projector.")


def cmd_status(_args):
    cands = load_candidates()
    review = json.loads(REVIEW_JSON.read_text()) if REVIEW_JSON.exists() else {}
    by_source = Counter(c["source"] for c in cands)
    decisions = Counter((review.get(c["id"]) or {}).get("decision", "unreviewed") for c in cands)
    urban = sum(1 for c in cands if (c.get("town") or {}).get("urban"))
    print(f"In towns of {URBAN_MIN_POP:,}+: {urban} of {len(cands)}")
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
    ROUNDS_DIR.mkdir(parents=True, exist_ok=True)

    if args.append:
        # Keep every landmark_id already finalized (and uploaded, with round
        # numbers set in AGOL); only NEW keeps get the next free ids.
        if not ANSWERS_GEOJSON.exists():
            sys.exit("Nothing to append to yet; run finalize without --append first.")
        features = json.loads(ANSWERS_GEOJSON.read_text())["features"]
        done = {f["properties"]["_source_ref"] for f in features}
        kept = [c for c in kept if c["sourceRef"] not in done]
        next_n = 1 + max(int(f["properties"]["landmark_id"][1:]) for f in features)
        numbered = [(f"r{next_n + i:03d}", c) for i, c in enumerate(kept)]
        if not numbered:
            sys.exit("No new kept photos to append.")
    else:
        kept = kept[: args.count]
        stale = [p for p in ROUNDS_DIR.glob("r[0-9][0-9][0-9].jpg")]
        if stale and not args.overwrite:
            sys.exit(f"{len(stale)} r###.jpg files already in {ROUNDS_DIR}. Use --append to add new keeps "
                     "without renumbering (ids already in AGOL keep their round numbers), or --overwrite "
                     "to renumber everything from scratch.")
        for p in stale:
            p.unlink()
        features = []
        numbered = [(f"r{i:03d}", c) for i, c in enumerate(kept, 1)]

    problems = 0
    for lid, c in numbered:
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
    print(f"Wrote {len(numbered)} photos ({', '.join(lid for lid, _ in numbered)}) to {ROUNDS_DIR}; "
          f"{ANSWERS_GEOJSON} now has {len(features)} answers (PRIVATE, keep it out of git).")
    print("Next: python scripts/load_landmarks.py  (dry run), then add --apply.")
    sys.exit(1 if problems else 0)


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample", help="download candidates")
    s.add_argument("source", choices=["wvdot", "mapillary", "landmarks"],
                   help="landmarks = Mapillary photos facing named OpenStreetMap places")
    s.add_argument("--refresh-places", action="store_true", help="re-download the OpenStreetMap place list")
    s.add_argument("--count", type=int, default=50, help="candidates to add")
    s.add_argument("--workers", type=int, default=4)
    s.add_argument("--urban", action="store_true",
                   help=f"only towns of {URBAN_MIN_POP:,}+ people (more signs, buildings, context)")
    s.add_argument("--per-cell", type=int, default=None, help="max candidates per 0.25° cell (default 3; 8 with --urban)")
    s.add_argument("--min-spacing", type=float, default=None, help="miles between candidates (default 2; 0.75 with --urban)")
    s.add_argument("--max-tries", type=int, default=8, help="give up after count × this many attempts")
    s.add_argument("--seed", type=int, default=None)
    s.set_defaults(func=cmd_sample)
    ad = sub.add_parser("add", help="add hand-picked Mapillary images by ID or URL (marked keep)")
    ad.add_argument("ids", nargs="*", help="image IDs or mapillary.com URLs")
    ad.add_argument("--file", help="text file with IDs/URLs, one per line")
    ad.add_argument("--allow-pano", action="store_true")
    ad.set_defaults(func=cmd_add)
    k = sub.add_parser("answer-key", help="printable private answer key (work/answer-key.html) for Fallback B")
    k.set_defaults(func=cmd_answer_key)
    a = sub.add_parser("annotate", help="tag existing candidates with town context (no downloads)")
    a.set_defaults(func=cmd_annotate)
    v = sub.add_parser("verify", help="confirm single-read WVDOT coordinates with neighbor frames")
    v.set_defaults(func=cmd_verify)
    st = sub.add_parser("status", help="counts so far")
    st.set_defaults(func=cmd_status)
    f = sub.add_parser("finalize", help="write round photos + private answers from the kept set")
    f.add_argument("--count", type=int, default=100)
    f.add_argument("--seed", type=int, default=2026)
    f.add_argument("--overwrite", action="store_true", help="renumber everything from scratch (replaces r###.jpg)")
    f.add_argument("--append", action="store_true",
                   help="only add new keeps as the next ids; existing ids (and their AGOL round numbers) stay put")
    f.set_defaults(func=cmd_finalize)
    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
