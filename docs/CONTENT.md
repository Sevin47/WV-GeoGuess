# Round content: street-level photos

The Landmarks layer is filled mostly with **random street-level photos from around WV**: a pool of about
100. The live game plays a chosen handful, plus a few curated landmarks. The whole pool becomes the "play
at home" solo set after the event.

```
sample ──▶ work/candidates/ ──▶ review (tools/review.html) ──▶ finalize ──▶ assets/rounds/r001.jpg …   (public)
                                                                        └──▶ work/landmarks.geojson   (PRIVATE answers)
                                                                                 └──▶ load_landmarks.py ──▶ AGOL layer
```

Everything under `work/` is git-ignored, and it contains the answers. Never commit it or copy it into the
site.

## Sources

| | WVDOT dashcam frames | Mapillary |
|---|---|---|
| What | The agency's Nextbase dashcam frames (Oracle Cloud bucket) | Crowd-sourced street imagery |
| License | WVDOT's own | CC BY-SA 4.0, credited on every photo (`credit` field, shown at reveal) |
| Location | **Not in the file metadata.** OCR'd off the text strip the camera burns into each frame, then cross-checked (below). | From the API |
| Privacy | Faces and plates are **not** blurred, so reject those frames in review | Blurred by Mapillary |
| Secret | `WVDOT_FRAMES_URL`: a pre-authenticated, **listable** bucket URL | `MAPILLARY_TOKEN` |

Place names come from **OpenStreetMap** (© OpenStreetMap contributors, ODbL). Fun facts come from
**Wikipedia** (CC BY-SA). Landmark photos carry both credits.

Google Street View **can't** be used, not even as manual screenshots. Google's geo guidelines say "You may not
screenshot Street View imagery … for any purpose", including nonprofit use. Its API terms also forbid bulk
downloading, caching, or storing images, and showing Street View next to a non-Google map (Google Maps
Platform Terms §3.2.3).

Put both secrets in a `.env` file in the repo root. It's git-ignored, and the scripts read it:

```
WVDOT_FRAMES_URL=https://…/b/dashcam_frames/o
MAPILLARY_TOKEN=MLY|…
```

## 1. Sample candidates

```bash
python scripts/street_images.py sample wvdot --count 150
```

```bash
python scripts/street_images.py sample mapillary --count 100
```

```bash
python scripts/street_images.py status
```

- **WVDOT.** The bucket holds 243 recording dates (Jan 2020 to Sep 2026). Each sample picks a random
  date and time, the next clip, and a frame from the middle of that clip. Night frames, frames without a
  GPS fix, and points outside WV are skipped.
  - **Coordinates.** Five OCR passes (Tesseract) run over the text strip. A reading is trusted when two
    or more passes agree, or when a single read matches the **next frame's** reading to within ~0.5 mi.
    Anything else is dropped: a misread digit would silently move the answer.
  - **Crop.** The strip is cropped off at finalize, since it prints the exact latitude and longitude.
    It's kept only as `*_strip.jpg`, so you can check the digits during review.
- **Mapillary.** The script picks a random point in WV and takes the most recent non-panorama image
  within ~1 km, or ~3 km if there's nothing closer.
- **Spread.** No two candidates are closer than 2 miles, and each 0.25° grid cell holds at most 3.
- **Town mode (`--urban`).** WV is mostly forest, so random statewide photos are mostly lone roads with
  nothing to go on. With `--urban`, Mapillary samples inside the cores of the 63 towns of 2,500+ people
  (bigger towns more often), and WVDOT keeps only frames that fall inside one. Spacing drops to 0.75 mi
  and 8 per cell, so a city can contribute several photos. A town's core radius runs from about 0.55 mi
  (2,500 people) to 2 mi (Charleston). `python scripts/street_images.py annotate` tags existing
  candidates the same way, and the review page sorts town photos first.
- **Landmarks (`sample landmarks`).** This is the most guessable source. It takes about 880 named WV
  places from OpenStreetMap (courthouses, bridges, universities, stadiums, town halls, museums,
  historic buildings), with courthouses and bridges tried most often. For each, it finds a Mapillary
  photo taken 15–200 m away whose **camera heading points at the place** (within 30°). The reveal name
  becomes, for example, "Kanawha County Courthouse, Charleston". The fun fact is the first sentence of
  the place's Wikipedia article, when it has one.
- **Hand-picked (`add`).** Browse [mapillary.com/app](https://www.mapillary.com/app), copy a photo's
  URL (it contains `pKey=…`), and run `python scripts/street_images.py add <URL or ID> …`. These are
  marked "keep" automatically. 360° panoramas are skipped because they look warped as flat photos.
- **Speed.** It runs at about 5 candidates per minute with 6 workers, and each candidate is saved as it
  arrives, so you can stop and restart anytime.

For candidates sampled before the neighbor check existed, run:

```bash
python scripts/street_images.py verify
```

Unconfirmed ones are marked rejected ("coords"), and you can still override that in review.

## 2. Review

First start the local server:

```bash
python scripts/serve.py
```

Then open `http://localhost:8000/tools/review.html`.

| Key | Action |
|---|---|
| **K** | Keep |
| **P** | Reject: people or plates readable |
| **B** | Reject: blurry, dark, or obstructed |
| **N** | Reject: no clues / too generic |
| **C** | Reject: coordinates look wrong |
| ← / → | Previous / next |
| U | Undo |
| F | Show unreviewed only |

- The red dashed line shows where the text strip will be cropped.
- WVDOT candidates show the original strip under the photo, plus a badge ("OCR agreed 3/5", "Confirmed
  by the next frame", or "Check digits").
- "Check location on OpenStreetMap" opens the spot so you can sanity-check the place.
- Decisions save automatically to `work/review.json`.

**Aim for variety:** towns, rivers, ridges, interstates, and back roads, with some easy ones and some
hard ones.

## 3. Finalize and upload

```bash
python scripts/street_images.py finalize --count 100
```

This writes the kept candidates, shuffled, as `assets/rounds/r001.jpg` …:
- the strip is cropped off
- metadata is stripped
- images are resized to 1600 px and kept under 400 KB

It also writes the answers to `work/landmarks.geojson`, with a **0.5-mile hit circle** around each photo
location.

**Adding more photos later:** use `finalize --append`. It gives only the new keeps the next ids
(`r039`, …) and leaves every existing photo, id, and answer untouched, so round numbers already set in
AGOL stay correct. Plain `finalize` refuses to run once photos exist; `--overwrite` renumbers
everything from scratch.

Then upload. The first command is a dry run with checks only:

```bash
python scripts/load_landmarks.py
```

```bash
python scripts/load_landmarks.py --apply --username YOUR_AGOL_USERNAME
```

Uploaded landmarks join the **"Pool"** set with no `round_order`. **`host.html` plays only landmarks
that have a `round_order`.** To choose the live rounds, open the layer's Data tab in AGOL and set
`round_order` (1, 2, …) and `set_name` (`Break 1`, …) on the ones you want. Curated landmarks (a photo
plus a drawn footprint, docs/AGOL_SETUP.md §6) mix in the same way.

Commit `assets/rounds/r*.jpg`. Those are public prompt photos with no location in them.

## Anti-cheat checklist (brief §3.6)

- [ ] Every photo had its text strip cropped (finalize does this; spot-check a few in `assets/rounds/`).
- [ ] No EXIF (finalize re-verifies each file).
- [ ] File names are `r###.jpg`, shuffled, so the number says nothing about source, date, or place.
- [ ] `work/` (answers) is not committed, and the Landmarks layer stays private.
- [ ] `name` (e.g. "Near Buckhannon, Upshur County") appears only at reveal. `prompt_text` is generic.
