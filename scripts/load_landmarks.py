#!/usr/bin/env python3
"""
Upload the finalized landmarks (work/landmarks.geojson, written by
`street_images.py finalize`) to the PRIVATE WV_GeoGuess_Landmarks layer.

    python scripts/load_landmarks.py                                   # dry run: checks only
    python scripts/load_landmarks.py --apply --username YOUR_AGOL_USERNAME
    python scripts/load_landmarks.py --apply --username YOU --replace  # overwrite same landmark_ids

Landmarks already in the layer (same landmark_id) are skipped unless
--replace. They arrive as the "Pool" set with no round_order: host.html only
plays landmarks that have a round_order (1, 2, …), so pick the live rounds by
setting round_order and set_name in the layer's Data tab. Solo mode can use
the whole pool.

Needs the ArcGIS API for Python for --apply (see docs/AGOL_SETUP.md §1).
"""
import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from create_layers import NO_ARCGIS, check_args, connect, find_owned  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ANSWERS = ROOT / "work" / "landmarks.geojson"
LAYER_TITLE = "WV_GeoGuess_Landmarks"
FIELDS = ["landmark_id", "name", "prompt_text", "set_name", "round_order", "image_path", "fun_fact", "credit"]
R = 6378137


def to_web_mercator(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def signed_area(ring):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:])) / 2


def esri_polygon(geometry):
    """GeoJSON polygon (lon/lat, CCW outer) -> Esri JSON in Web Mercator (CW outer).
    The layer is 102100 and addFeatures has no inSR, so convert here."""
    rings = []
    for i, ring in enumerate(geometry["coordinates"]):
        wm = [list(to_web_mercator(lon, lat)) for lon, lat in ring]
        clockwise = signed_area(wm) < 0
        if clockwise != (i == 0):  # outer rings clockwise, holes counter-clockwise
            wm.reverse()
        rings.append(wm)
    return {"rings": rings, "spatialReference": {"wkid": 102100}}


def check(features):
    """Local checks before touching AGOL. Returns a list of problems."""
    problems = []
    ids = [f["properties"].get("landmark_id") for f in features]
    if len(set(ids)) != len(ids):
        problems.append("duplicate landmark_id values")
    for f in features:
        p = f["properties"]
        lid = p.get("landmark_id")
        img = ROOT / (p.get("image_path") or "")
        if not p.get("image_path") or not img.is_file():
            problems.append(f"{lid}: image missing ({p.get('image_path')})")
        if f["geometry"]["type"] != "Polygon":
            problems.append(f"{lid}: geometry is {f['geometry']['type']}, expected Polygon")
        for key in ("name", "credit"):
            if not p.get(key):
                problems.append(f"{lid}: {key} is empty")
    return problems


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="upload (default is a dry run)")
    ap.add_argument("--replace", action="store_true", help="delete and re-add landmarks with the same landmark_id")
    ap.add_argument("--file", default=str(ANSWERS))
    ap.add_argument("--portal", default="https://www.arcgis.com")
    ap.add_argument("--username")
    ap.add_argument("--client-id")
    ap.add_argument("--home", action="store_true")
    args = ap.parse_args(argv)

    path = Path(args.file)
    if not path.exists():
        sys.exit(f"{path} not found. Run: python scripts/street_images.py finalize")
    features = json.loads(path.read_text())["features"]
    problems = check(features)
    print(f"{len(features)} landmarks in {path.name}")
    for p in problems:
        print(f"  FAIL {p}")
    if problems:
        sys.exit(1)
    sample = features[0]["properties"]
    print(f"  e.g. {sample['landmark_id']}: {sample['name']} · {sample['credit']}")
    if not args.apply:
        print("\nDRY RUN — nothing uploaded. Add --apply --username YOUR_AGOL_USERNAME to upload.")
        return

    check_args(args)
    try:
        from arcgis.features import FeatureLayerCollection
    except ImportError:
        sys.exit(NO_ARCGIS)
    gis = connect(args)
    item = find_owned(gis, LAYER_TITLE)
    if not item:
        sys.exit(f"{LAYER_TITLE} not found in your content. Run scripts/create_layers.py first.")
    layer = FeatureLayerCollection.fromitem(item).layers[0]

    existing = {f.attributes["landmark_id"]: f.attributes[layer.properties.objectIdField]
                for f in layer.query(where="1=1", out_fields=f"landmark_id,{layer.properties.objectIdField}").features}
    ours = {f["properties"]["landmark_id"] for f in features}
    clash = ours & existing.keys()
    if clash and args.replace:
        res = layer.edit_features(deletes=[existing[i] for i in clash])
        print(f"Deleted {sum(r['success'] for r in res['deleteResults'])} existing landmarks to replace them")
        clash = set()
    todo = [f for f in features if f["properties"]["landmark_id"] not in clash]
    if clash:
        print(f"Skipping {len(clash)} landmark_ids already in the layer (use --replace to overwrite)")

    added = 0
    for start in range(0, len(todo), 50):
        batch = todo[start: start + 50]
        adds = [{"attributes": {k: f["properties"].get(k) for k in FIELDS},
                 "geometry": esri_polygon(f["geometry"])} for f in batch]
        res = layer.edit_features(adds=adds)
        for f, r in zip(batch, res["addResults"]):
            if r.get("success"):
                added += 1
            else:
                print(f"  FAIL {f['properties']['landmark_id']}: {r.get('error')}")
    print(f"Uploaded {added} of {len(todo)} landmarks to {LAYER_TITLE}.")
    print("Next: set round_order (1, 2, …) and set_name on the ones to play live, then run tools/check-agol.html.")


if __name__ == "__main__":
    main()
