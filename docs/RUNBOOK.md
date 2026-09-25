# Event-day runbook: WV GeoGuess at WVDOT GIS Day

**Friday, November 13, 2026.** Print this page and keep it next to the laptop.

| What | URL |
|---|---|
| **Host (projector)** | https://sevin47.github.io/WV-GeoGuess/host.html?session=gisday2026 |
| **Players** | https://sevin47.github.io/WV-GeoGuess/play.html?session=gisday2026 (the QR code on the lobby screen and the table tents) |
| Rehearsal host | `host.html?session=test-rehearsal-1` (any `test-…` name) |
| Setup check | https://sevin47.github.io/WV-GeoGuess/tools/check-agol.html |
| Table tents | https://sevin47.github.io/WV-GeoGuess/tools/tent.html |
| Play at home (after the event) | https://sevin47.github.io/WV-GeoGuess/ |

**Host keys:**

| Key | Action |
|---|---|
| **Space**, **→**, **PageDown**, **Enter** | Next step |
| **L** | Lock the round |
| **R** | Reveal |
| **B** | Leaderboard (between rounds only) |
| **F** | Fullscreen |
| **A** | Admin panel |

---

## Before the day

- [ ] **Pick the live rounds** (Landmarks layer → Data tab):
  - `round_order` counts 1, 2, 3 … **across the whole day**. It does not restart each break.
  - `set_name` names each break: "Break 1", "Break 2", …
  - About 3 rounds per break. Everything else stays in the play-at-home pool.
  - The host refuses to start if a `round_order` repeats.
- [ ] **Venue test (by Nov 6), in the actual room:**
  - Open `tools/check-agol.html` on a phone, once on venue Wi-Fi and once on cell data. All checks
    should pass.
  - Run a `test-…` rehearsal on the real projector. Press **F** and check the photo and QR code are
    readable from the back row.
  - Confirm the agency network doesn't block `github.io` or `arcgis.com`.
  - Test the clicker: which keys it sends. "B" and "." are sometimes "black screen" keys.
- [ ] **Print table tents** from the **hosted** `tools/tent.html`, not from localhost. Print at 100%
  scale and fold on the dashed line.
- [ ] **Print the answer key** for Fallback B: run
  `python scripts/street_images.py answer-key`, then print `work/answer-key.html` through
  `scripts/serve.py`. It's **private**, so keep it off the projector.
- [ ] **Code freeze Nov 9.** No pushes after that. A change can take ~10 minutes to reach phones that
  already loaded the page.
- [ ] **Day before:** open the State table's Data tab and delete any `gisday2026` row left over from
  testing, so the day starts at round 1 with an empty leaderboard. Deleting `test-…` rows is optional.
- [ ] (Optional) Re-run the load test with `node tools/bots.mjs --session test-load-N`, driving the
  host on the same session.

## Morning of (about 60 minutes before)

1. **Laptop:** Chrome, plugged in, sleep off, notifications off (Windows Focus assist).
2. **Rehearse on a test session first:** open `host.html?session=test-morning`, sign in, and play one
   round from your phone on cell data and one on Wi-Fi.
3. **Open the real host URL** (`?session=gisday2026`) in the same tab, which keeps the sign-in. It
   creates the session in the lobby.
4. Move the tab to the projector and press **F**. Leave the lobby with its QR code up while people
   arrive.

## Each break

1. **Show the host tab.** Keep it visible during a round: Chrome slows timers in hidden tabs, which can
   delay the auto-lock.
2. **Space** starts the round. The 45 s timer locks it automatically (or press **L**).
3. **R** (or **→**) reveals: pins, the answer, the top 3, and the fun fact.
4. **→** goes to the next round. After the break's last round it shows the **leaderboard**, then
   **→** shows the lobby with the QR code for the next break.
5. Switch back to the slides.

**Admin (A):**
- **+15 seconds** when the room needs more time.
- **Hide a name** for rude nicknames.
- **Start this round now** to jump.
- **Skip** (no scoring) for a broken photo.
- **Show lobby/QR** again.

## If something goes wrong

| Problem | What to do |
|---|---|
| Host page crashed or was refreshed | Reopen the same host URL. It resumes where it was: round, lock time, and totals are stored in AGOL. The sign-in is remembered in that tab. |
| Phones stuck or "Connection trouble" | Tell people to refresh. They rejoin automatically with the same name and score. |
| Few guesses coming in | Put the lobby QR back up (Admin → Show lobby). Late joiners are fine. |
| Rude nickname | Admin → Hide. |
| **AGOL or network down (Fallback B)** | Show the round photos (`assets/rounds/rNNN.jpg`) full screen, let the room shout out answers, and read them from the printed answer key. |
| Live mode unusable but the internet works (Fallback A) | Solo mode (`index.html`) on the projector. It only opens once `WV_GeoGuess_Landmarks_Solo` is shared with Everyone, which **makes every answer public**, so use it only as a last resort. |

## After the event

- [ ] **Open play-at-home:** share `WV_GeoGuess_Landmarks_Solo` with **Everyone**. The site's solo
  page and the phones' "Play more at home" button start working immediately.
- [ ] **Close live guessing:** on `WV_GeoGuess_Guesses_Public`, turn off editing or unshare it.
- [ ] **Export `WV_GeoGuess_Guesses`** (session `gisday2026`) for a "where everyone guessed" map. It
  makes good post-event GIS Day content (brief §7).
- [ ] (Optional) Delete `test-…` rows from the State and Guesses tables.
