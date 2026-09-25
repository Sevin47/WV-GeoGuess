# Phase 0 recon notes — ArcGIGuess upstream

Snapshot of `aelhussiny/ArcGIGuess` at `a1dd62c` ("Fixed URL case sensitivity bug"), read and run
locally on 2026-09-24. No behavior changes were made in Phase 0.

**How it was run:** `python -m http.server 8000` → `http://localhost:8000` (also saved as the `static`
config in `.claude/launch.json`). The demo web map loaded, one round was played end to end
(start → click → Confirm → result polygon + score), and the console showed no errors.

---

## 1. File map

| File | Size | Role |
|---|---|---|
| `index.html` | ~450 lines | All markup: the map, 5 panels, 3 modals, and a hidden share card. Loads the CDNs, then `config.js` (classic script), then `script.js` (module). |
| `config.js` | ~300 lines | `window.ARCGIGUESS_CONFIG`: branding, web map/layer, scoring, languages and all strings, social meta, leaderboard. |
| `script.js` | ~1,020 lines | All game logic in one `$arcgis.import([...]).then(...)` closure. No exports. |
| `style.css` | ~125 lines | Full-screen map, overlay pointer-events, button styles, and one mobile tweak. |
| `assets/` | | `logo.svg`, `pin.svg` (24:36 aspect, tip at bottom-center), `screenshot.png` (~940 KB, README/OG image). |

**CDN dependencies**

| Dependency | How it's loaded | Pinned? |
|---|---|---|
| ArcGIS Maps SDK | `https://js.arcgis.com/5.1/` | Minor-pinned; the patch version floats |
| Tailwind | `https://cdn.tailwindcss.com` (play CDN) | **No.** It's unversioned and the play CDN isn't meant for production. Pin or replace it (brief §9). |
| html2canvas | cdnjs `1.4.1` | Yes |

---

## 2. Runtime flow (`script.js`)

```
$arcgis.import(config, WebMap, Graphic, request, containsOperator, distanceOperator)
  └─ applyStaticConfig()        title, logo alt, share footer, OG meta, hide leaderboard buttons
  └─ init()                     esriConfig.portalUrl → new WebMap(portalItem) → mapEl.map = webmap
       ├─ webmap.load(); find layer by title (CONFIG.landmarkLayerTitle); layer.visible = false
       ├─ mapEl.viewOnReady()
       └─ loadGameData()         queryFeatures(1=1, name fields + id, geometry)
                                  └─ queryAttachments per feature (N requests) → attributes.imageUrl
  └─ updateUI()                 renders ALL text + shows the one panel for gameState

START ──startGame()──▶ PLAYING ──confirmGuess()──▶ ROUND_RESULT ──nextRound()──▶ PLAYING … ──▶ GAME_OVER
                        ▲ map click (arcgisViewClick) sets clickedPoint, drops animated pin
```

### Key functions

| Function | Line | Notes |
|---|---|---|
| `t(key, repl)` | [script.js:151](../script.js:151) | String lookup with `{placeholder}` fill. `{appName}` and `{url}` are always available. |
| `updateUI()` | [script.js:188](../script.js:188) | Re-sets every string and toggles panels on each call. The only renderer. |
| `init()` | [script.js:349](../script.js:349) | Web map and layer bootstrap. |
| `loadGameData()` | [script.js:399](../script.js:399) | Features plus the first attachment of each as its photo. |
| `startGame()` / `startRound()` | [script.js:480](../script.js:480) / [:503](../script.js:503) | Optional shuffle and `roundsPerGame` slice. Shows the **name** and photo. |
| `handleMapClick()` | [script.js:544](../script.js:544) | Picture-marker pin with a bounce (`animatePinDrop`, which swaps `yoffset` per frame). |
| `confirmGuess()` | [script.js:593](../script.js:593) | **Scoring.** Contains → `pointsForHit`, else planar `distanceOperator` → linear bands. |
| `endGame()` | [script.js:725](../script.js:725) | Total, accuracy %, "found" count. Fills the share card. |
| `shareResults()` | [script.js:746](../script.js:746) | html2canvas → Web Share API, with an image-modal fallback. |
| `showSubmitModal()` / `fetchLeaderboardData()` | [script.js:814](../script.js:814) / [:844](../script.js:844) | Survey123 iframe with the score in the URL. Top N read from a FeatureServer `/query` via `esriRequest`. |
| `window.skipToResults()` | [script.js:1009](../script.js:1009) | Dev helper that jumps to GAME_OVER with a random score. |

### SDK 5.1 surface actually used

- `<arcgis-map>` with `<arcgis-zoom slot="top-left">`. The code uses `mapEl.map`, `mapEl.graphics`, `mapEl.goTo()`, `mapEl.viewOnReady()`, and the `arcgisViewClick` event (`event.detail.mapPoint`).
- `WebMap`, `Graphic`, `request`, `config`
- `containsOperator.execute(polygon, point)` and `distanceOperator.execute(a, b, {unit})`
- `FeatureLayer.createQuery()`, `.queryFeatures()`, `.queryAttachments()`

---

## 3. Verified findings

These were checked live in the running page, not taken from memory.

### 3.1 The answer layer is readable anonymously (brief §2, limitation 2)

An unauthenticated `fetch` to `…/Dubai_Landmarks/FeatureServer/0/query?where=1=1&outFields=*` returned
names and geometry. Hiding the layer with `visible = false` is purely cosmetic. Even without crafting a query,
anyone with devtools open can read every answer in the Network tab, because the client downloads them all. **The live game must never
load answers on player phones.**

### 3.2 Planar distance in Web Mercator is badly inflated at WV latitudes (brief §2, limitation 3)

The demo layer and view are both **wkid 102100 (Web Mercator)**. `distanceOperator` is planar in the
input SR. Measured with real WV points:

| Pair | Geodetic | Planar Web Mercator | Planar UTM 17N (26917) |
|---|---|---|---|
| Capitol → Morgantown | 126.14 mi | 162.40 mi (**×1.287**) | 126.09 mi (−0.04%) |
| Charleston → Huntington | 44.38 mi | 56.54 mi (**×1.274**) | 44.36 mi (−0.03%) |

**What Phase 1 shipped:** geodesic distance, not UTM 17N. `js/scoring.js` uses
`geodesicProximityOperator.getNearestCoordinate(polygon, point).distance`. That's the geodesic distance, in
meters, to the nearest point on the polygon, and it's the same whether the input is WGS84 or Web Mercator.
It agrees with planar UTM 17N to within 0.04% in WV.

UTM was tried first and dropped. `projectOperator.execute(geom, {wkid: 26917})` **returns `null` for
geometry outside zone 17.** The Dubai placeholder data (55°E) crashed `confirmGuess()`, and any test data
outside WV would do the same. The geodesic approach works everywhere and needs no SR config.
`containsOperator` still runs in the data's own SR, which is fine for inside/outside tests.

### 3.3 Operators available in 5.1

Confirmed via `$arcgis.import` in the running page:

- `containsOperator`: `execute`, `accelerateGeometry`
- `distanceOperator`: `execute`
- `projectOperator`: `execute`, `executeMany`, `load`, `isLoaded`. **Needs `await load()` first.**
- `geodeticDistanceOperator`, `geodeticLengthOperator`: `execute`, `load`, `isLoaded`
- `proximityOperator`, `geodesicProximityOperator`: `getNearestCoordinate` and related

### 3.4 View constraints behave differently from what the docs suggest (SDK 5.1.25)

Found while building `js/map.js` in Phase 2, and confirmed one variable at a time in the running page:

| What we tried | What happened |
|---|---|
| `mapEl.constraints = { … }` (new object) | Drops the zoom levels taken from the basemap. Reading `view.zoom` then throws `reading 'scaleToZoom'`. **Mutate `view.constraints` instead.** |
| `constraints.minZoom = 7.45` (fractional) | Throws `reading 'scale'`. It's used as an LOD index. |
| `constraints.minScale = <fit scale>` | The effective limit snaps to the next *more zoomed-in* LOD (even `minScale` = LOD 7 → LOD 8), so the statewide fit itself is blocked. |
| `constraints.minZoom = floor(fit zoom)` | **Works.** It allows the fit and at most one zoom level beyond it. This is what `constrainToWV()` uses. |
| `constraints.geometry = <extent>` | Limits only the view's **center**, not the visible extent. |

`constrainToWV()` recomputes `minZoom` whenever the map is resized (phone rotation, the URL bar collapsing)
without moving the view.

### 3.5 ArcGIS REST edit details (checked against the REST docs, 2026-09-24)

- `addFeatures` and `updateFeatures` are POST requests. They return `{addResults|updateResults: [{objectId,
  success, error}]}`. `updateFeatures` identifies the row by the object ID field inside `attributes`.
- **There is no `inSR` parameter.** Guess geometry must already be in the guesses layer's SR.
  `js/backend.js` converts lon/lat to Web Mercator (`agol.guessLayerWkid: 102100`). Phase 3 must confirm
  that the hosted layer really is 102100.
- Errors come back as HTTP 200 with `{error: {code, message}}`, and the adapter checks for this.
- The object ID field name varies (`OBJECTID` vs `ObjectId`), so the adapter reads `objectIdFieldName`
  from each query response.

---

## 4b. Phase 2 modules

| Module | What it is |
|---|---|
| `js/scoring.js` | Points and distance (Phase 1). |
| `js/backend.js` | Adapter interface split by **role**: player = `getState`, `submitGuess`. Host = `getState`, `createSession`, `updateState`, `listGuesses`, `countGuesses`, `getLandmarks`. Two implementations, `mock` and `agol`. Also `watchState()`, which polls with jitter, runs slower in the lobby, pauses while the tab is hidden, and backs off on errors. No SDK imports, so it's unit-tested in Node. |
| `js/map.js` | Pin symbol and drop animation (moved from `script.js`), `loadWebMap()` for solo mode, `setupWVMap()` (keyless no-label basemap, WV outline, county lines, dimmed surroundings), and `constrainToWV()`. |
| `tools/harness.html` | Dev page for the backend. Open `?role=host` in one tab and `?role=player` in others. |
| `data/wv-boundary.geojson`, `data/wv-counties.geojson` | Census TIGERweb 2020 (State_County layers 54/55), simplified to ~0.002° (~200 m). 19 KB and 108 KB. |
| `data/mock/landmarks.geojson`, `assets/rounds/mock/` | Six **approximate** WV test landmarks and placeholder photos, for the mock backend only. |

**Mock backend design.** The brief says "in-memory + BroadcastChannel". The mock stores data in
**localStorage**, which all tabs of the same site share and which survives a host refresh, so recovery
(brief §3.2) can be tested. The BroadcastChannel carries "something changed" hints so other tabs update
immediately. Each guess gets its own storage key, so tabs writing at the same time can't overwrite each
other. If localStorage is unavailable, the mock falls back to memory, which only works within one tab.

**Safety rails (brief §9).**
- The `agol` adapter refuses host writes to any session that doesn't start with `test-`, unless
  `CONFIG.live.allowProductionWrites` is true.
- Session IDs are checked against a safe character set before they go into SQL `where` clauses.
- Oversized reveal and leaderboard JSON fails loudly in both adapters.

**Open items for later phases**
- **Clock skew.** Phones draw the countdown from the host's `roundEndsAt` using their own clocks, so a few
  seconds of skew is possible. The host's lock time is what counts, so this only affects the display.
  Consider estimating the offset in Phase 4.
- **"N guesses in"** counts raw guesses (`countGuesses`), not distinct players. Deduplicate in Phase 5 if
  needed.
- **Late-guess rule.** "First guess per player, drop guesses later than lock + 3 s" belongs in the host
  scoring step (Phase 5).

---

## 4c. Phase 3: data setup

| File | What it is |
|---|---|
| `docs/AGOL_SETUP.md` | Step-by-step AGOL setup: layers, views, sharing, editing, cache, sign-in, verification. |
| `scripts/create_layers.py` | Creates the layers and views from one spec, reads them back, and round-trips the JSON field length. Dry run by default. Calls checked against arcgis **2.4.3**, but **not yet run against a live org**. |
| `scripts/strip_exif.py` | Photo prep: applies rotation, strips all metadata, 1600 px long edge, ≤ 400 KB, neutral names. Tested on a GPS-tagged, rotated 4000×3000 JPEG. |
| `scripts/serve.py` | No-cache local dev server. Plain `http.server` let the browser run stale `config.js` and modules during testing. |
| `tools/check-agol.html` | Anonymous, phone's-eye check of the security model and settings. Smoke-tested against a public Esri layer: it correctly FAILs "private" and "blind", and WARNs on a bad URL instead of passing. |

**Verified against Esri docs (2026-09-24)**
- The editing option wording is exact: "Editors can't see any features, even those they add". It's only
  selectable with "Add" only, and it **removes the Query capability**.
- A public layer with editing needs an extra approval: "Approve this layer to be shared with the public
  when editing is enabled". This step is manual.
- `cacheMaxAge` accepts 0–3600 s and defaults to 30. It only applies to public layers **without**
  editing, and editable layers bypass the CDN.
- **String field max length is not documented** beyond the 256 default. `create_layers.py` round-trips
  64,000 chars, and `check-agol.html` compares the real field length with `live.jsonFieldLength`.
- **Host sign-in:** the SDK's built-in prompt uses `generateToken`, which **doesn't support SAML/OIDC
  single sign-on**. If WVDOT's AGOL uses SSO, `host.html` needs an OAuth client ID
  (`live.agol.oauthClientId`, a public ID and not a secret).

**Solo mode for our data model.** `landmarkImageField` loads photos from static `image_path` files, with
no attachment queries. `landmarkPromptField` shows the clue during play and reveals the name with the
result. Both are `null` while the Dubai placeholder is in use.

**Security notes for Phase 5**
- **Never publish full `player_id`s** in `reveal_json` or `leaderboard_json`. The guesses view accepts
  anonymous adds, and the host keeps the *first* guess per player, so anyone who knew another player's
  ID could lock in a bad guess for them in the next round. Publish a short tag instead (e.g. the first 8
  characters) and let phones match on it.
- Anyone can add junk guesses to the public view. The host ignores unknown sessions and rounds and keeps
  one guess per player, and `listGuesses` pages through results. A flood would only slow the host's
  query.

**Caching on the hosted site.** GitHub Pages lets browsers cache files for about 10 minutes, so a
`config.js` change made on event day can take that long to reach phones that already loaded the page.
Freeze the config before doors open (Runbook, Phase 7).

---

## 4d. Phase 4: the phone page

| File | What it is |
|---|---|
| `play.html`, `css/play.css`, `js/play.js` | Phone page. There's no framework and no Tailwind: the play CDN is ~400 KB of JS and not meant for production. The join screen works before the multi-MB SDK finishes loading (`sdkReady()`), and the map loads in the background while the player types a name. |
| `js/round.js` | **The host↔phone contract.** `scoreRound()` handles first-guess-per-player, the late cutoff (server time), ranks with ties, cumulative totals, and hidden names. It also defines the public JSON format. The Phase 5 host calls it as-is. |
| `js/names.js` | Nickname rules: 2–20 characters, letters/numbers/spaces, and a light profanity filter. It allows Dickens, Hancock, Cummings, and Scunthorpe, and blocks "sh1t", "s.h.i.t", and "Kick Ass". |
| `assets/answer.svg` | Answer marker (a target). |

**Screens** follow the host's phase:

| Host phase | Phone screen |
|---|---|
| (no name yet) | join |
| no session / `lobby` | wait ("Eyes on the big screen") |
| `guessing` | guess, or locked if already submitted |
| `locked` | locked, or timesup |
| `reveal` | result |
| `leaderboard` | standings |
| `final` | final |

Only the host decides anything. The phone countdown is display-only, and **Confirm stays available until
the phase changes**, so a phone whose clock runs fast can't cut itself off early. Late guesses are dropped
by the host using server time.

**Result line** (brief §3.2): "6.4 mi away · +773 pts · #1 this round · #1 overall", followed by the answer
and fun fact. The map shows the player's pin, a dashed line, and the answer target.

**Rules that Phase 5 must follow**
- **Locking early** writes `roundEndsAt = lock time`. Every phone's countdown stops, and the lock time
  (the late-guess cutoff) survives a host refresh.
- Call `scoreRound()` only once per round. It throws if the leaderboard already includes that round.
- **The host must not pause polling when its tab is hidden** (for example, when the presenter switches to
  the slides). Pass `document: null` to `watchState`. This was found in testing: a hidden harness tab
  never updated. The same testing exposed a bug where `document: null` was ignored because `??` treats
  null as missing; it's fixed and has a test.

**Found and fixed while testing on a 375×812 viewport**
- `goTo()` with WGS84 graphics in a Web Mercator view treated degrees as meters and zoomed to level 23.
  The reveal zoom now builds a Web Mercator extent, with a 3 km minimum.
- `crypto.randomUUID()` doesn't exist on plain-http LAN addresses (phones testing against a dev PC), so
  there's a `getRandomValues` fallback.

**Test options.** `?poll=always` keeps a background player tab polling, for several player tabs in one
browser. `tools/harness.html?role=host` now locks and reveals through `scoreRound()` with the real
geodesic scorer, so it can stand in for the host until `host.html` exists.

**Not yet measured:** cold-load time on cell data and on an older phone (brief §3.4). Do this during the
venue test.

---

## 4e. Phase 5: the host page

| File | What it is |
|---|---|
| `host.html`, `css/host.css`, `js/host.js` | Projector page. Sized in vw/vh and designed at 1920×1080. Screens: setup/sign-in, lobby (QR + URL), round (photo, timer, "N guesses in", mini QR), reveal (map + closest list), leaderboard (top 10), final (champion). |

**How it runs**
- **Source of truth.** The host keeps its own copy of the state and writes changes; it never polls. Its
  timers (auto-lock, the "N guesses in" count every 2 s) keep running while the tab is hidden behind the
  slides.
- **Flow.** lobby → guessing → (timer or L) locked → (→ or R) reveal → next round in the same set. At
  the end of a set (a `set_name` change) it goes to the leaderboard, then an intermission lobby with the
  QR code again, then the next set. When no rounds are left it goes to final.
- **Controls.**
  - Space, →, PageDown, or Enter: next
  - L: lock. R: reveal (locks first if needed)
  - B: leaderboard, only between rounds, so a round can't be abandoned unscored
  - F: fullscreen (hides the control bar until hover)
  - A or \`: admin
  - ← and PageUp (a clicker's "back") are ignored on purpose.
- **Admin panel.** Start any round now (jump), skip to the next round without scoring, +15 s, show the
  lobby/QR, hide or unhide names (also hidden in the current reveal), and switch to a new session.
- **Recovery.** A refresh reloads the State row. In reveal, it replays the animation *without*
  re-scoring (`afterRound` guard).
- **Sign-in.** `IdentityManager.getCredential()` shows the SDK's own ArcGIS username dialog. Cancelling
  is handled ("Sign-in was cancelled…"). Credentials are saved in **sessionStorage** (this tab only), so
  a mid-game refresh doesn't ask again. An OAuth client ID is used only if `oauthClientId` is set.
- **QR code** is drawn locally by `qrcode-generator` 1.4.4 from cdnjs, pinned with an SRI hash (2.0.4
  has no files on cdnjs). The join URL is `play.html?session=…`, plus `&backend=` when the host overrides
  the configured backend.
- **Reveal animation.** All pins drop in, then the answer polygon and target appear. Dashed lines go to
  the top 5; the top 3 get name labels, staggered above/below/right. The map zooms to the answer plus
  the top 3. Found in testing: including a far-off 5th place zoomed out until the leaders' labels piled
  up.

**Tested on the mock backend (pane-sized 16:9-ish viewport).** This was a full 6-round game with 5
simulated players and a phone tab:
- The timer auto-locked at 0 while the phone showed "Time's up".
- The reveal ranked the players correctly: inside → 1000, 4.1 mi → 849, …
- A refresh mid-reveal resumed without re-scoring.
- Round 2 scored the phone's guess (0.3 mi, +987). Round 3, with no guesses, revealed cleanly.
- At the end of Break 1 the flow went leaderboard → intermission lobby ("Break 2 — round 4 of 6 is up
  next").
- B mid-round was refused. +15 s worked (44 → 57). Hiding a name worked, and a jump to round 6 worked.
- Final showed the champion, and the phone showed "You finished #2 of 6".
- With `?backend=agol`, the sign-in dialog appeared, and cancelling it was handled.

**Not yet done:** a real AGOL game. That needs your sign-in, and it writes `test-*` rows to the State and
Guesses tables.

**Runbook notes (Phase 7)**
- **Keep the host tab visible during a round.** Chrome slows timers in hidden tabs, heavily after about
  5 minutes, so an auto-lock could fire late behind the slides. Between breaks it doesn't matter.
- Clickers: confirm which keys yours sends. Some send "b" or "." for "black screen", and B is the
  leaderboard key here (it's refused mid-round).

---

## 4f. Phase 6: load test (`tools/bots.mjs`)

This is a Node script that runs N simulated phones through the same `js/backend.js` code as `play.html`:
the same jittered polling, and one guess per round at a random moment (3% deliberately late). It reports
poll latency, errors by kind, guess failures, and **propagation** (host write → bot sees it; run it on the
host's PC so the clocks match). A JSON report goes to `work/`. `--backend mock --self-host` tests the
tool itself with no AGOL.

To run it:

```bash
node tools/bots.mjs --session test-load-1 --bots 200
```

Then play the rounds on `host.html?backend=agol&session=test-load-1`.

**Results on the real AGOL layers, 200 bots from one PC (= one venue Wi-Fi IP), 2026-09-25:**

| Polling | Outcome |
|---|---|
| Unique cache-buster per poll (bypasses the CDN) | ~70 polls/s reached AGOL. **HTTP 429 after ~2 min**, then polls were almost fully blocked. Test stopped. |
| **Time-bucketed** cache-buster, 2 s (`cacheBucketMs`) | 6 rounds, 444 s, **29,120 polls, 0 errors**. 1,200 guesses, 0 failed. Poll p50 83 ms / p95 184 ms (CDN hits). |

- **Propagation with time buckets:** usually 1.5–3 s, and at most ~7 s. The slow cases were round
  starts straight from the lobby, which then polled every 5 s. The lobby now polls every 3 s, which is
  free now that AGOL's load doesn't grow with the number of phones.
- **Guesses:** `addFeatures` isn't cached and wasn't throttled. That's 200 adds spread over a 45 s
  round.
- **Clean-up:** test rows live in the Guesses and State tables under sessions `test-load-1` and
  `test-load-2`. They can be deleted from the Data tab.

---

## 4. Other things to know before changing code

**Answer leaks and anti-cheat (brief §3.6)**
- `startRound()` sets `image.alt = name` ([script.js:522](../script.js:522)), which leaks the answer. It
  doesn't matter for the upstream design, where the name is shown anyway, but in photo-only mode the alt
  text must be neutral.
- The landmark **name is the prompt** in upstream (`#landmark-name`). We're going photo-only plus an
  optional clue (brief §8), so that element becomes `prompt_text`.
- Photos come from **attachments**, so reading them requires access to the answer layer. The brief moves
  them to static `image_path` files, which is correct.

**Scoring semantics**
- "Found" is `roundScore === pointsForHit`, which also counts guesses inside the first 500 m band. The
  exponential mode needs a new definition of "found". Suggestion: inside the polygon only.
- `buildScoringSummary()` generates the start-screen text from `CONFIG.scoring`. Keep that idea, but make
  it mode-aware.
- Result distance is shown as raw rounded meters (`{distance}m`). Switch to miles with one decimal.

**Structure and refactor hooks (Phase 2)**
- Everything lives in one closure, so there's nothing to import. Extracting `scoring.js` and `map.js` means
  lifting `confirmGuess()`'s math and the `init()` map setup into ES modules that receive SDK modules or
  the map element.
- `index.html` loads `script.js` as a module but `config.js` as a classic script that sets a global. That
  can stay as is, or `config.js` can become `export default`. Either way, all three pages should share it.
- `updateUI()` rewrites every string on every state change. That's fine for solo mode, and it's a decent
  pattern to copy for `play.html`'s phase-driven screens.
- `loadGameData()` makes one `queryAttachments` call **per feature**. That's irrelevant once photos are
  static files.

**Leaderboard and HTML safety**
- The leaderboard renders names with `textContent`, which is good. Strings from config go through
  `innerHTML` in several places. That's acceptable because config is trusted, but **never route nicknames
  through `t()` + `innerHTML`.**
- Survey123 pre-fills the score via URL (`?field:score=N`). Players can edit it trivially. That's
  acceptable for the solo fallback only.

**Language and map**
- `lang-toggle` hides itself automatically when there's only one language, so English-only means deleting
  the `ar` entry and nothing else.
- The map has no extent constraint and no min zoom yet. `play.html` needs `constraints` (geometry = WV
  extent, `minZoom`) per brief §3.4.
- `#ui-overlay` uses `pointer-events: none` so the map receives clicks under the bottom panel. Keep this
  when restyling.

---

## 5. What maps to which phase

| Upstream piece | Fate |
|---|---|
| `config.js` structure | **Keep** (Phase 1): WV branding, `en` only, miles, `scoring.mode`, placeholder web map ID. |
| `confirmGuess()` scoring math | → `js/scoring.js`. **Done in Phase 1**, with exponential and bands modes and geodesic distance. |
| `init()` map bootstrap | → `js/map.js`. **Done in Phase 2**, with solo web map loading, WV constraints, and a no-label basemap. |
| Pin symbol + drop animation | **Reuse** in `play.html`. It's good UX already. |
| Share card / html2canvas | Solo only. Optional for `play.html` final standing. |
| Survey123 leaderboard | Solo fallback only (brief §7 Fallback A). |
| `gameState` + `updateUI()` | Pattern reused. Live pages are driven by the backend `phase` instead. |
