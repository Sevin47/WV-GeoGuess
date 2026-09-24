# ArcGIS Online setup — WV GeoGuess

This guide sets up the hosted layers from brief §3.1 in **ArcGIS Online**. It takes about 30–45 minutes
by hand or about 5 minutes with the script. Either way, finish with
[§8 Verify](#8-verify-with-toolscheck-agolhtml).

UI labels quoted in "double quotes" were checked against the ArcGIS Online help on 2026-09-24. Esri
renames things occasionally, so if a label doesn't match exactly, look for the closest equivalent.

---

## 0. Before you start

- **Account privileges.** You need to create content, create hosted feature layers, and **share
  publicly**. Some orgs block public sharing, or public *editable* layers, for regular members. If
  sharing to Everyone is greyed out, ask your AGOL admin.
- **Who signs in.** Only the **host** signs in to AGOL. Players never do. They scan the QR code, type a
  nickname, and play through the public views.
- **Sign-in type.** WVDOT uses **ArcGIS logins** (username and password typed on the ArcGIS page), so
  nothing extra is needed and [§7](#7-host-sign-in-only-if-your-org-uses-single-sign-on) can be skipped.
- **What will be public, and what won't:**

| Item | Sharing | Editing | Why |
|---|---|---|---|
| `WV_GeoGuess_Landmarks` | **Owner only** | Owner | The answers. Never share it. |
| `WV_GeoGuess_Landmarks_Solo` (view) | Owner only, **until after the event** | None | Solo mode needs readable answers. Share it only for Fallback A or after GIS Day. |
| `WV_GeoGuess_State` | Owner only | Owner | The host writes game state here. |
| `WV_GeoGuess_State_Public` (view) | **Everyone** | None | Phones poll this. |
| `WV_GeoGuess_Guesses` | Owner only | Owner | The host reads all guesses here. |
| `WV_GeoGuess_Guesses_Public` (view) | **Everyone** | **Add only, blind** | Phones submit guesses here and can't read any back. |

Turn on **Delete protection** (item page → Settings) for all three source layers once they exist.

---

## 1. Option A — the script (recommended)

[`scripts/create_layers.py`](../scripts/create_layers.py) creates everything in the table above, skips
items that already exist, and then reads everything back and checks it against the spec. It needs
Esri's free **ArcGIS API for Python** library (`arcgis`). That library doesn't require ArcGIS Pro or a
license, only your AGOL login. There are two ways to get it.

**In an ArcGIS Online Notebook** (no local install; your account needs notebook privileges, which it
has if **Notebook** appears in the AGOL app launcher):

1. Go to ArcGIS Online → **Notebook** → **New notebook** → **Standard**.
2. Paste the whole contents of `scripts/create_layers.py` into a cell and run it.
3. In a new cell, run `main(["--apply", "--home"])`.

**Or locally, on any PC with Python.** This is a large download (about 0.5 GB). A virtual environment
keeps it out of your main Python install.

1. Create the environment:

   ```bash
   python -m venv .venv
   ```

2. Install the library:

   ```bash
   .venv/Scripts/python -m pip install arcgis
   ```

3. Do a dry run, which changes nothing:

   ```bash
   .venv/Scripts/python scripts/create_layers.py
   ```

4. Apply it. It prompts for your AGOL password and stores nothing:

   ```bash
   .venv/Scripts/python scripts/create_layers.py --apply --username YOUR_AGOL_USERNAME
   ```

`.venv/` is git-ignored. Single sign-on orgs would use `--portal https://YOURORG.maps.arcgis.com
--client-id YOUR_CLIENT_ID` instead of `--username`.

At the end the script prints a block of URLs to paste into `config.js`, plus a VERIFY list. A `FAIL`
line means the setting didn't apply; fix that item by hand using §3–§5.

**The script can't do one thing:** approve public editing on `WV_GeoGuess_Guesses_Public`. Do that by
hand ([§4](#4-guesses--the-public-add-only-blind-view), last step). Then skip to [§6](#6-load-the-landmarks).

---

## 2. Option B — by hand: create the three source layers

For each one: **Content → New item → Feature layer → Define your own layer** (for State, choose a
**table**). Then add fields on the item's **Data → Fields → Add field**. Field names must match exactly;
the code depends on them.

### 2a. `WV_GeoGuess_Landmarks`: polygon layer

| Field | Type | Length |
|---|---|---|
| `landmark_id` | String | 16 |
| `name` | String | 128 |
| `prompt_text` | String | 256 |
| `set_name` | String | 64 |
| `round_order` | Integer | |
| `image_path` | String | 256 |
| `fun_fact` | String | 1000 |
| `credit` | String | 256 |

### 2b. `WV_GeoGuess_State`: table

| Field | Type | Length |
|---|---|---|
| `session_id` | String | 40 |
| `phase` | String | 16 |
| `round_num` | Integer | |
| `round_total` | Integer | |
| `set_name` | String | 64 |
| `image_path` | String | 256 |
| `prompt_text` | String | 256 |
| `round_ends_at` | Double | |
| `reveal_json` | String | **64000** (see below) |
| `leaderboard_json` | String | **64000** |
| `updated_at` | Double | |

**JSON field length.** The ArcGIS Online help documents a 256 default for string fields but no maximum. If
the Add field dialog won't accept 64000, enter the largest value it allows and write that number down.
Then put it in `config.js` → `live.jsonFieldLength`. The code refuses to write more than that, so an
oversized value fails loudly instead of being silently cut off. For scale: about 150 players needs
roughly 10–15 K characters per field. The [§8 check](#8-verify-with-toolscheck-agolhtml) compares the
real length to the config.

### 2c. `WV_GeoGuess_Guesses`: point layer

| Field | Type | Length |
|---|---|---|
| `session_id` | String | 40 |
| `round_num` | Integer | |
| `player_id` | String | 40 |
| `nickname` | String | 24 |
| `client_ts` | Double | |

Then go to **Settings → Editing**, check **"Keep track of who edited the data (editor name, date and
time)"**, and save. This adds `CreationDate`, the server timestamp the host uses to reject late guesses.

**Spatial reference.** Layers created this way are Web Mercator (102100). That matters because
`addFeatures` has no input-SR parameter and the game sends Web Mercator. If you create the layer some
other way (for example, publishing from Pro in another SR), change `live.agol.guessLayerWkid` to match.

---

## 3. State — the public read-only view

1. On the `WV_GeoGuess_State` item page, click **Create View Layer**. Name it `WV_GeoGuess_State_Public`
   and keep all fields.
2. On the **view's** Settings page:
   - Leave editing **off**. The view has its own editing settings, separate from the source.
   - **Cache control:** set it to the **lowest** value offered. The service property `cacheMaxAge`
     accepts 0–3600 seconds and defaults to 30. If the UI's lowest option is above 0, the script sets
     0 directly, or you can leave the UI value, because the game adds a cache-busting parameter to
     every poll (`live.agol.cacheBust: true`). Cache control only applies to public, non-editable
     layers, which is exactly this view.
3. **Share** the view with **Everyone**. Leave the source table private.

---

## 4. Guesses — the public add-only, blind view

1. On the `WV_GeoGuess_Guesses` item page, click **Create View Layer**. Name it
   `WV_GeoGuess_Guesses_Public`.
2. On the **view's** Settings → Editing:
   - Check **"Enable editing"**.
   - Under **"What kind of editing is allowed?"**, check only **"Add"**. Uncheck "Update" and "Delete".
     The next option stays greyed out while Update or Delete is checked.
   - Under **"What features can editors see?"**, choose **"Editors can't see any features, even those
     they add"**. With "Add" only, this removes the view's Query capability entirely.
   - Keep **"Keep track of who edited the data"** checked.
   - If there's a section for anonymous (public) users, choose **"Only add new features, if allowed
     above (requires editor tracking)"**.
3. **Share** the view with **Everyone**.
4. **Approve public editing.** ArcGIS Online requires an explicit approval before a public layer with
   editing enabled accepts edits. Look for **"Approve this layer to be shared with the public when
   editing is enabled"** in the view's Settings and turn it on. The script can't do this step.

---

## 5. Solo view (for Fallback A and "play at home")

1. On `WV_GeoGuess_Landmarks`, click **Create View Layer**. Name it `WV_GeoGuess_Landmarks_Solo` and
   leave editing off.
2. **Leave it private for now.** Sharing it exposes every answer (docs/NOTES.md §3.1).
3. Make a web map for solo mode:
   - Use a **basemap without labels**. A labeled basemap gives the answers away.
   - Add `WV_GeoGuess_Landmarks_Solo`.
   - Save it privately.
4. In `config.js`, set the following:
   - `webMapItemId`: the web map's item ID
   - `landmarkLayerTitle`: `WV_GeoGuess_Landmarks_Solo`, or whatever the layer is titled in the map
   - `landmarkImageField`: `"image_path"`
   - `landmarkPromptField`: `"prompt_text"`
5. **For Fallback A or after the event:** share both the view and the web map with Everyone.

---

## 6. Load the landmarks

For each round (brief §5):

1. **Photo.** Run [`scripts/strip_exif.py`](../scripts/strip_exif.py). It fixes rotation, strips all
   metadata including GPS, resizes to a 1600 px long edge, keeps each file under 400 KB, and names files
   neutrally:

   ```bash
   python scripts/strip_exif.py --out assets/rounds --manifest photos.csv
   ```

   `photos.csv` has a header row with two columns, `source` and `landmark_id`. Keep the original
   photos **out of the repo**, because they still carry GPS tags. Commit only `assets/rounds/r01.jpg`
   and so on.
2. **Polygon.** In Map Viewer, open `WV_GeoGuess_Landmarks` and draw the footprint with the **Edit**
   tool. Be generous: the footprint is what counts as a direct hit.
3. **Attributes:**
   - `landmark_id`: `r01`, `r02`, …
   - `round_order`: 1, 2, …, across the whole day
   - `set_name`: `Break 1`, `Break 2`, …
   - `image_path`: `assets/rounds/r01.jpg`
   - `prompt_text`: an optional clue that **doesn't name the place**
   - `name`, `fun_fact`, `credit`
4. **Anti-cheat (brief §3.6).** Nothing public (the file name, the prompt, the alt text) may give the
   location away.

---

## 7. Host sign-in (only if your org uses single sign-on)

**Not needed for WVDOT**, which uses ArcGIS logins. This section is kept in case that changes.

With no extra setup, the SDK's sign-in prompt asks for an ArcGIS username and password. **That prompt
doesn't support single sign-on (SAML/OIDC).** If your AGOL login redirects to a WVDOT or Microsoft page:

1. In ArcGIS Online, go to **Content → New item → Developer credentials → OAuth 2.0 credentials**.
2. Add these redirect URLs:
   - the hosted site, e.g. `https://sevin47.github.io/WV-GeoGuess/host.html` (hosting is still open,
     brief §8)
   - `http://localhost:8000/host.html` for development
3. Copy the **Client ID** into `config.js` → `live.agol.oauthClientId`. A client ID is a public
   identifier, not a secret, so it's fine in the repo. **Never** put a client *secret* or an API key in
   the repo.

`host.html` (Phase 5) uses the client ID when it's set.

---

## 8. Verify with `tools/check-agol.html`

1. Paste the five URLs into `config.js` → `live.agol`. The script prints them. By hand, each is the
   item's service URL plus `/0`.
2. Set `live.jsonFieldLength` to the confirmed field length.
3. Serve the site and open `tools/check-agol.html`. It checks everything **anonymously**, the way a
   phone does:

| Check | Expect |
|---|---|
| Landmarks, State, and Guesses source layers | **Refuse** anonymous queries (Token Required) |
| State public view | Readable, `Query` capability only, `cacheMaxAge` 0, JSON fields ≥ config |
| Guesses public view | `Create` only (no Query/Update/Delete), Web Mercator, editor tracking, anonymous query sees nothing |
| **Send a test guess** button | Anonymous add succeeds. It writes one point to session `test-check`. |

4. **Run it again from the real hosting URL, and from a phone on cell data and on venue Wi-Fi.** That
   tests CORS and network blocks for real (brief §3.7).
5. **Test the live flow.** Open `tools/harness.html?backend=agol&role=player&session=test-agol` on a
   phone and in a browser. (The host side of the harness needs sign-in, which arrives with `host.html`
   in Phase 5.) Until then, confirm that a player tab can see a `test-agol` state row you add by hand in
   the State table's Data tab.

---

## 9. Leaderboard for solo Fallback A (optional)

The solo game's Submit Score and Leaderboard buttons are off (`leaderboard.enabled: false`), because the
upstream values pointed at the original author's survey. To use them:

1. Create a Survey123 form with `first_name`, `last_name`, and an integer `score` question. Share the
   form with Everyone.
2. Create a public **view** of the survey's results layer with only `first_name`, `last_name`, and
   `score` visible.
3. Set `leaderboard.survey123Url`, `leaderboard.dataApiUrl` (the view's `/0/query` URL), and
   `enabled: true`.

Players can edit the score in the URL, so this is acceptable for the fallback only.

---

## 10. Housekeeping

- Use `test-*` session IDs for everything except the event. The code refuses host writes to any other
  session unless `live.allowProductionWrites` is `true` (brief §9). Turn it on only on event day.
- Test rows (`test-*` sessions, the `test-check` guess) can be deleted from the owner layers' Data tab
  at any time.
- After the event (brief §7), export `WV_GeoGuess_Guesses` for the "where everyone guessed" map. Then
  turn off public editing on `WV_GeoGuess_Guesses_Public`, or unshare it.
