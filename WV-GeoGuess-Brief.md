# WV GeoGuess — Project Brief for Claude Code

**Working title:** WV GeoGuess (rename freely)
**Event:** WVDOT GIS Day, Friday, November 13, 2026
**Purpose of this doc:** Hand-off from planning to build. Claude Code should read this whole file before touching code, then start at Phase 0.

---

## 1. What we're building

A live, audience-participation geo-guessing game played in the breaks between GIS Day presentations, replacing the usual trivia.

A photo of a West Virginia location appears on the projector. Everyone in the room drops a pin on a WV map on their phone. The host locks the round and reveals all of the audience's pins alongside the correct answer, then shows a leaderboard. The leaderboard accumulates across the day, and a champion is crowned at the end.

### Success criteria

- A player can join in under 30 seconds by scanning a QR code. No account or app install is needed.
- One round (show photo, guess, reveal) fits in about 2–3 minutes.
- The game works on iOS Safari and Android Chrome, over both cell data and venue Wi-Fi.
- It handles about 150 simultaneous players. Confirm the real headcount.
- If live mode fails, the host can fall back to solo mode within a minute.

---

## 2. Starting point: ArcGIGuess (fork this)

- **Repo:** https://github.com/aelhussiny/ArcGIGuess (MIT license)
- **Demo:** https://aelhussiny.github.io/ArcGIGuess/
- **Blog:** https://www.esri.com/arcgis-blog/products/js-api-arcgis/developers/building-arcgiguess

### What's in the repo

This summary comes from reading the source on 2026-09-24.

- **Stack.** Plain HTML/CSS/JS with no build step: `index.html` (~450 lines), `config.js` (~300), `script.js` (~1,000), `style.css`, and `assets/`.
- **SDK.** ArcGIS Maps SDK for JavaScript **5.1**, loaded from CDN (`https://js.arcgis.com/5.1/`). The page uses the `<arcgis-map>` web component and loads modules with `$arcgis.import()`.
- **Libraries.** Tailwind comes from the play CDN. html2canvas renders the share card.
- **`init()`** loads a web map by item ID, finds the answer layer by title, and sets `visible = false`.
- **`loadGameData()`** queries all polygon features, then uses the first attachment of each feature as its photo.
- **Scoring (`confirmGuess()`).**
  - If `containsOperator` puts the guess inside the polygon, the player gets full points.
  - Otherwise, `distanceOperator` measures the distance from the guess to the polygon edge in meters.
  - The player loses `penaltyPerBucket` points per `bucketMeters` of distance, down to `minScore`.
- **State machine.** A single `gameState` (`START`, `LOADING`, `PLAYING`, `ROUND_RESULT`, `GAME_OVER`) drives `updateUI()`.
- **Leaderboard.** Players submit through a Survey123 form in an iframe, with the score pre-filled via URL params. The app reads the top N scores from a FeatureServer `/query` URL.
- **Languages.** The app is bilingual (en/ar), with all strings in `config.js`.

### Limitations for our use case

1. **It's solo and self-paced.** There's no shared, host-controlled round and no group reveal.
2. **Answers are only hidden visually.** If the answer layer is public, anyone can query it through REST. A GIS Day audience *will* try this.
3. **Distance is planar.** `distanceOperator` is planar in the geometry's spatial reference. If the data is in Web Mercator, distances at WV latitudes (about 37–40.6°N) are inflated by roughly 1.25–1.3×.
   - **Fix:** Project to UTM 17N first. All of WV falls in zone 17, and EPSG:26917 or 32617 both work. Alternatively, use a geodetic operator.
   - **Verify** the operator names in the 5.1 docs before relying on them.

---

## 3. Target architecture

There are three pages in one repo, and the only backend is ArcGIS Online hosted layers. There are no servers to run.

| Page | Used by | Purpose |
|---|---|---|
| `index.html` (solo) | Anyone | The original game, configured for WV. Serves as the emergency fallback and as a "play at home" link after the event. |
| `play.html` | Audience phones | Join, guess, and see your own result and rank. |
| `host.html` | Presenter laptop driving the projector | Control rounds, show the photo and timer, reveal, and show the leaderboard. |

### Data flow

```
host.html ──(owner edits)──────────▶ GameState table ──(public read-only view, polled)──▶ play.html
play.html ──(anonymous, add-only)──▶ Guesses point layer ──(owner queries)────────────▶ host.html
host.html ──(owner only)───────────▶ Landmarks layer (answers, PRIVATE)
```

The host page is the single source of truth. It holds the answers, does all the scoring, and publishes results.

### 3.1 Hosted layers (ArcGIS Online)

#### A. `WV_GeoGuess_Landmarks`: polygon layer, PRIVATE

Only the signed-in host can read this layer.

| Field | Type | Notes |
|---|---|---|
| `landmark_id` | string | Stable key, e.g. `r01` |
| `name` | string | Shown at reveal |
| `prompt_text` | string | Optional clue for players, e.g. "Where is this bridge?" |
| `set_name` | string | Which break it plays in, e.g. `Break 1` |
| `round_order` | integer | Order within the day |
| `image_path` | string | Relative path to the prompt image, e.g. `assets/rounds/r01.jpg` |
| `fun_fact` | string | Shown at reveal |
| `credit` | string | Photo credit |

- **Photos** are static files in the repo (see §3.6), not attachments. This lets phones display a round's photo without being able to read the private layer.
- **Solo mode** needs public answers, because it scores on the client. Give it a separate public view that gets shared only for the fallback or after the event.

#### B. `WV_GeoGuess_State`: table

The owner edits the source table. Players read it through a public, read-only view called `WV_GeoGuess_State_Public`. There is one row per session.

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | e.g. `gisday2026`. Use `test-*` IDs during development. |
| `phase` | string | `lobby` \| `guessing` \| `locked` \| `reveal` \| `leaderboard` \| `final` |
| `round_num` / `round_total` | integer | |
| `set_name` | string | |
| `image_path` | string | Copied from the landmark when the round starts |
| `prompt_text` | string | |
| `round_ends_at` | double | Epoch ms. Phones render the countdown from this. |
| `reveal_json` | string (large) | Answer centroid, name, fun fact, and per-player results. Written only at reveal. |
| `leaderboard_json` | string (large) | Cumulative totals, so the host can recover after a refresh |
| `updated_at` | double | Epoch ms |

- **Field length.** Set the JSON fields' length large enough for about 150 players, i.e. tens of thousands of characters. Verify the AGOL limit.
- **Caching.** Set the public view's **Cache Control** to the lowest value. Test for stale reads, because AGOL can cache public queries.

#### C. `WV_GeoGuess_Guesses`: point layer

- **The owner** has full access and queries the source layer from `host.html`.
- **The public view** allows **Add** only, with **"editors can't see any features, even those they add"**. Verify the exact wording of that setting in AGOL.
- **Editor tracking** must be enabled. The server-side `CreationDate` is used to reject late guesses.

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | |
| `round_num` | integer | |
| `player_id` | string | Random UUID stored in the phone's localStorage |
| `nickname` | string(24) | |
| `client_ts` | double | For debugging only. Don't trust it. |

### 3.2 Round flow

1. **Lobby.** The projector shows a big QR code and the join URL.
2. **Start round.** The host writes `phase=guessing`, the round's fields, and `round_ends_at = now + 45s`.
3. **Guess.** Phones poll the state view and show the photo thumbnail (tap to enlarge), a countdown, and the map.
   - The player taps to place a pin, then taps **Confirm**. This calls `addFeatures` on the public guesses view.
   - Each player gets one guess per round. After confirming, the phone shows "Locked in ✓".
4. **Lock.** The round locks when the timer expires or the host presses **Lock**. The host writes `phase=locked`, and phones stop accepting guesses.
5. **Score (host side).**
   - Query guesses for the current `session_id` and `round_num`.
   - Keep the first guess per `player_id`, and drop any with `CreationDate` later than lock time plus a 3-second grace period.
   - Score against the private polygon, then update the cumulative totals.
6. **Reveal.** The host writes `reveal_json` and `phase=reveal`.
   - **Projector:** All pins appear, followed by the answer polygon, distance lines for the top 5, the closest names, and the fun fact.
   - **Phones:** Each player sees their own line, e.g. "12.4 mi away · +612 pts · #9 this round · #14 overall".
7. **Next.** The host moves to the next round. At the end of a set, it goes to `leaderboard`. After the last set of the day, it goes to `final`.

**Recovery.** If `host.html` is refreshed or crashes, it must be able to resume from the State row, including round number and totals from `leaderboard_json`.

**Polling.** 150 phones polling every 2.5 seconds comes to about 60 requests per second.
- Add jitter to the polling interval.
- Poll slower in the lobby (about 5 seconds).
- Pause polling while the tab is hidden.

### 3.3 Scoring

Put scoring in its own module, `js/scoring.js`, with its settings in `config.js`. Display distances in **miles**.

**Mode `exponential` (default):**
- A guess inside the polygon scores 1000.
- Any other guess scores `round(1000 · exp(-miles / 25))`.

| Miles off | Points |
|---|---|
| 5 | ~819 |
| 10 | ~670 |
| 25 | ~368 |
| 50 | ~135 |
| 100 | ~18 |

**Mode `bands`:** Keep the original linear-band logic, retuned for statewide distances.

**Tie-breaker:** Lower cumulative distance wins. A speed bonus is optional and off by default.

Always compute distance with the projected/geodesic fix from §2.

### 3.4 Phone UX (`play.html`)

- **Join.**
  - The player enters a nickname of 2–20 characters. Run a light profanity filter, and let the host hide any name.
  - Store `player_id` and the nickname in localStorage, wrapped in try/catch, so a refresh rejoins automatically.
- **Map.**
  - Show WV only: constrain the view to the state extent and set a min zoom.
  - Use a basemap with no labels, plus the WV boundary and optional county lines.
  - The pin should be big and easy to see.
  - Put a large Confirm button in thumb reach.
  - Prevent accidental page zoom and scroll.
- **Screens:**
  - Waiting ("Eyes on the big screen")
  - Guessing
  - Locked in
  - Time's up
  - My result
  - Final standing
- **Performance.** SDK 5.1 is a hefty download. Measure cold-load time on cell data and on an older phone. Keep the web map light.
- **Accessibility.** Use large text, and never let color be the only signal.

### 3.5 Host UX (`host.html`)

- **Layout.** Designed for a 1920×1080 projector and readable from the back of the room.
- **Sign-in.** The host signs in to ArcGIS, since the private landmarks layer triggers the SDK sign-in prompt.
- **Screens:**
  - Lobby: QR code, join URL, and title
  - Round: large photo, timer, "N guesses in", and "Round X of Y"
  - Reveal: map animation
  - Leaderboard: top 10 cumulative
  - Final: the champion
- **Controls.** On-screen buttons plus keyboard shortcuts, so a presentation clicker (which sends PageUp/PageDown/arrow keys) can advance the game.
  - Space / →: next step
  - L: lock
  - R: reveal
  - B: leaderboard
- **Admin panel (hidden):**
  - Jump to a round
  - Skip a round
  - Add 15 seconds to the timer
  - Hide a nickname
  - Start a new session
- **QR code.** Generate it client-side with a small library pinned from cdnjs. Don't call any external QR API.

### 3.6 Security and anti-cheat

- **Answers stay private.** The answers never leave the private layer until reveal time.
- **Prompt images are scrubbed:**
  - **Strip EXIF**, especially GPS tags.
  - Use neutral filenames like `r01.jpg`.
  - Keep location out of alt text.
  - Resize to about 1600 px on the long edge and under 400 KB.
- **Layers are locked down.** The guesses view is add-only and blind, so players can't see other guesses. The state view is read-only.
- **The host decides what counts.** Duplicate and late guesses are discarded using the server-side `CreationDate`.
- **No PII.** Only nicknames are stored.

### 3.7 Hosting and network

- **Static hosting.** GitHub Pages is the easiest option. **Confirm the WVDOT network doesn't block `github.io`.** An agency web server is the alternative.
- **AGOL rather than Enterprise** for the public layers. Phones on cell data likely can't reach an internal Enterprise portal. This is still an open decision (see §8).
- **Venue test.** Test on cellular and on venue Wi-Fi, with both iOS and Android.

---

## 4. Build plan (phases for Claude Code)

**Keep solo mode working at the end of every phase.**

- **Phase 0: Recon.**
  - Fork the repo, run it locally (`python -m http.server 8000`), and read `script.js`.
  - Write `docs/NOTES.md` summarizing the code.
  - Make no behavior changes.
- **Phase 1: WV solo mode.**
  - Update `config.js`: English only, WV/WVDOT branding, miles, new scoring, and a placeholder web map ID until the data exists.
  - Fix the distance calculation (§2).
- **Phase 2: Refactor.**
  - Extract shared modules: `js/scoring.js`, `js/map.js` (WV-constrained map setup), and `js/backend.js`.
  - `backend.js` should expose an adapter interface with two implementations:
    - **`agol`**: the real hosted layers.
    - **`mock`**: in-memory, using `BroadcastChannel`, so `host.html` and `play.html` can be developed and tested in two browser tabs before any AGOL layers exist.
- **Phase 3: Data setup.**
  - Write `docs/AGOL_SETUP.md` with step-by-step instructions for layers, views, sharing, and editing and caching settings.
  - Optionally add `scripts/create_layers.py` (ArcGIS API for Python) and `scripts/strip_exif.py`.
- **Phase 4:** Build `play.html`.
- **Phase 5:** Build `host.html`.
- **Phase 6: Load and rehearsal tools.**
  - Build `tools/bots.html` (or a Node script) that simulates N players guessing against a `test-*` session.
  - Target 200 bots.
- **Phase 7:** Polish, write `docs/RUNBOOK.md`, and add a "play at home" solo link for after the event.

---

## 5. Content (human task, in parallel)

Plan for **15–25 landmarks**: about 3 rounds per break times the number of breaks, plus spares.

- **Mix difficulty.** Include some easy crowd-pleasers and some deep cuts.
- **Candidate subjects:**
  - WVDOT bridges and tunnels
  - Interchanges
  - State parks
  - County courthouses
  - Photolog frames of recognizable roads
- **Each landmark needs:**
  - A polygon footprint
  - A scrubbed photo
  - A credit
  - A fun fact

---

## 6. Timeline (today is 9/24; the event is Friday, 11/13)

| Dates | Work |
|---|---|
| Week of 9/28 | Phases 0–2 |
| Week of 10/5 | Phase 3; start collecting content |
| 10/12 – 10/23 | Phases 4–5 |
| 10/26 – 10/30 | Phase 6; office playtest with 15–30 coworkers |
| 11/2 – 11/6 | Venue network test; finalize content; polish |
| 11/9 – 11/12 | Code freeze; full rehearsal; print QR table tents |
| **11/13** | **GIS Day** |

---

## 7. Event-day runbook (summary)

**Before doors open:**
- Open `host.html`, sign in, and create a fresh `session_id`.
- Run one test round from your own phone, on cell data and on Wi-Fi.

**Joining:** Put the QR code on the lobby screen and on printed table tents.

**Fallbacks:**
- **Fallback A:** If live mode fails, switch to solo `index.html` and use the Survey123 leaderboard.
- **Fallback B:** Show the photo on screen and have the room shout out guesses.

**After the event:** Share the solo game link. Export the guesses layer and make a map of where everyone guessed, which makes great post-event GIS Day content.

---

## 8. Open decisions

- **ArcGIS Online vs. Enterprise** for the layers. AGOL is recommended.
- **Show the landmark name, or the photo only?** Photo only plus an optional clue is recommended. Names give too much away.
- **Rounds per break and timer length.** The suggestion is 3 rounds of 45 seconds each.
- **Imagery source.** Options are WVDOT photolog frames, staff photos, or both.
- **Expected headcount.**
- **Hosting location:** GitHub Pages or an agency server.
- **Final game name.**

---

## 9. Working rules for Claude Code

- **No build step.** Stick to plain JS ES modules and pinned CDN versions, matching the original repo's approach.
- **Verify the SDK.** Check ArcGIS Maps SDK 5.1 API names against the official docs rather than memory.
- **Protect real data.** Never write to production layers or sessions without asking. Use `test-*` session IDs and the `mock` backend during development.
- **No secrets in the repo.** The design shouldn't need API keys: the host signs in, and players use public views. If a key turns out to be needed, stop and ask.
- **Commit often.** Make small commits per phase, each with a short note of what changed and how it was tested.
