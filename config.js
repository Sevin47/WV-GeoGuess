/* =============================================================================
 * WV GeoGuess — Configuration
 * =============================================================================
 * Forked from ArcGIGuess (https://github.com/aelhussiny/ArcGIGuess, MIT).
 *
 * This is the file to edit for branding, data, scoring, and on-screen text.
 * Players are shown a photo of a West Virginia location and must click the
 * map where they think it is. Points are awarded based on how close they get.
 *
 * The object is exposed as a global (window.ARCGIGUESS_CONFIG) and is read by
 * script.js. Keep this file loaded BEFORE script.js in index.html.
 * ========================================================================== */

window.ARCGIGUESS_CONFIG = {
    /* -------------------------------------------------------------------------
     * 1. BRANDING
     * ---------------------------------------------------------------------- */

    // The name of your game. Shown in the browser tab, share card, and messages.
    // (Working title — final name is still an open decision.)
    appName: "WV GeoGuess",

    // A short tagline used in the page title and as the default share-card footer.
    tagline: "How well do you know West Virginia?",

    // Text shown at the bottom of the shareable results card.
    // Set to null to fall back to `tagline`.
    shareCardFooter: "WVDOT GIS Day 2026",

    // Note: the logo, guess-pin, and README/social screenshot are plain files
    // in the /assets folder — just REPLACE them (keeping the same filenames)
    // rather than pointing config at new paths:
    //   assets/logo.svg        the start-screen & results-card logo
    //   assets/pin.svg         the marker dropped where the player guesses
    //   assets/screenshot.png  the README image and social link-preview

    /* -------------------------------------------------------------------------
     * 2. THE MAP & LANDMARK DATA
     * ---------------------------------------------------------------------- */

    // The portal that hosts your web map. Leave null to use ArcGIS Online.
    // To use ArcGIS Enterprise, set this to your portal's URL, e.g.
    // "https://gis.example.com/portal".
    portalUrl: null,

    // TODO(Phase 3): replace with the WV web map once the landmark data exists.
    // PLACEHOLDER: this is the upstream ArcGIGuess Dubai demo map. It keeps
    // solo mode playable end to end until our own layers are published.
    webMapItemId: "707a71d354c540f78c2f9101eead4c09",

    // The title of the layer (inside the web map above) that holds your
    // landmarks. This layer is hidden during play — its features are the
    // "answers". Each feature should be a polygon (the landmark's footprint).
    // TODO(Phase 3): "WV_GeoGuess_Landmarks" (the public solo-mode view).
    landmarkLayerTitle: "Dubai Landmarks",

    // Field names on the landmark layer.
    //   idField     — the unique ID field (used to fetch attachment photos).
    //   nameField   — the landmark's display name.
    //   imageField  — site-relative photo path (e.g. assets/rounds/r01.jpg).
    //                 null = use each feature's first attachment (upstream).
    //   promptField — clue shown during play instead of the name; the name is
    //                 then revealed with the result. null = show the name.
    // TODO(Phase 3): "image_path" and "prompt_text" once the WV web map exists
    // (docs/AGOL_SETUP.md §5). The Dubai placeholder has neither field.
    landmarkIdField: "OBJECTID",
    landmarkNameField: "name",
    landmarkImageField: null,
    landmarkPromptField: null,

    // How many landmarks to play per game. Set to null to use every landmark
    // in the layer. If you have 40 landmarks and set this to 10, each game
    // picks 10 at random.
    roundsPerGame: null,

    // Whether to randomize landmark order each game. Set to false to always
    // play them in the layer's natural order (handy for a guided/curated tour).
    shuffleLandmarks: true,

    // Let players bail out mid-game: accept their current score (remaining
    // landmarks count as missed) and jump straight to the results screen.
    // Set to false to require finishing every round.
    allowFinishEarly: true,

    /* -------------------------------------------------------------------------
     * 3. SCORING  (implemented in js/scoring.js)
     * ---------------------------------------------------------------------- */
    // The intro text shown to players is generated automatically from these
    // values, so the explanation can never drift out of sync with the rules.
    //
    // A guess inside the landmark polygon always scores `maxPoints` and counts
    // as "found". Otherwise the distance (in miles) from the guess to the
    // polygon's edge sets the score:
    //   exponential — round(maxPoints · e^(−miles / scaleMiles)).
    //                 With scaleMiles 25: 5 mi ≈ 819, 10 ≈ 670, 25 ≈ 368,
    //                 50 ≈ 135, 100 ≈ 18.
    //   bands       — lose `penaltyPerBand` for every full `bandMiles` off,
    //                 never dropping below `minScore`.
    scoring: {
        mode: "exponential", // "exponential" | "bands"
        maxPoints: 1000,
        exponential: {
            scaleMiles: 25,
        },
        bands: {
            bandMiles: 5,
            penaltyPerBand: 40, // hits 0 at 125 mi — about half the state's width
            minScore: 0,
        },
        // Distances are geodesic (true ground distance), not planar Web
        // Mercator, which overstates WV distances ~1.28x. See js/scoring.js.
    },

    /* -------------------------------------------------------------------------
     * 4. ON-SCREEN TEXT
     * ---------------------------------------------------------------------- */
    // English only. Upstream's multi-language `languages` array is kept with a
    // single entry; with only one language, the toggle button hides itself.
    // Placeholders in {curly braces} are filled in by the app.
    languages: [
        {
            code: "en",
            dir: "ltr",
            toggleLabel: "",
            surveyLang: null,
            strings: {
                welcomeTitle: "WV GeoGuess",
                // {scoringSummary} is generated from the `scoring` block above.
                welcomeDesc:
                    "We'll show you a place in West Virginia. Click the map where you think it is.<br><br>{scoringSummary}",
                // Scoring explanation templates, one per mode.
                // exponential placeholders: {points} {p10} {p25} {p50}
                scoringSummaryExponential:
                    "- Pin it inside the spot: <strong>{points} points</strong><br>- Miss, and points shrink with distance: 10&nbsp;mi&nbsp;≈&nbsp;{p10}, 25&nbsp;mi&nbsp;≈&nbsp;{p25}, 50&nbsp;mi&nbsp;≈&nbsp;{p50}",
                // bands placeholders: {points} {band} {penalty} {min}
                scoringSummaryBands:
                    "- Pin it (or within {band}&nbsp;mi): <strong>{points} points</strong><br>- Then <strong>−{penalty}</strong> for every {band}&nbsp;mi you're off, down to {min}.",
                startButton: "Start Game",
                loadingText: "Loading...",
                findLandmarkText: "Where in West Virginia is this?",
                scoreDisplay: "Score: {score}",
                roundDisplay: "Round {current} / {total}",
                confirmButton: "Confirm Guess",
                correctTitle: "Nailed it!",
                correctMessage:
                    "Right on target. You earned <strong>+{roundScore} points</strong>.",
                incorrectTitle: "Not quite!",
                incorrectMessage:
                    "You were <strong>{distance} mi</strong> away. You earned <strong>+{roundScore} points</strong>. Here's the correct location.",
                // Appended to the result when landmarkPromptField hides the name.
                answerReveal: "<br>It was <strong>{name}</strong>.",
                nextButton: "Next Location",
                finishEarlyButton: "Finish early",
                finishEarlyConfirm: "Tap again to end game",
                gameOverButton: "Show Results",
                gameOverTitle: "Game Over!",
                finalScoreText: "Here are your results:",
                totalScoreLabel: "Total Score",
                accuracyLabel: "Accuracy",
                foundLabel: "Places Found",
                playAgainButton: "Play Again",
                shareButton: "Share Results",
                // {score}, {appName}, and {url} (from social.url) are available.
                shareText:
                    "I scored {score} points in {appName}! How well do you know West Virginia? Play at {url}",
                shareCardTitle: "My {appName} Score!",
                shareCardScoreLabel: "Total Score",
                shareCardAccuracyLabel: "Accuracy",
                shareModalTitle: "Share Your Results!",
                shareModalDesc:
                    "Right-click or long-press the image to save and share it.",
                webMapError: "Could not load the web map. Please check the ID.",
                layerError:
                    "Could not find the landmark layer in the web map. Check the layer title in config.js.",
                submitScoreButton: "Submit Score",
                viewLeaderboardButton: "Leaderboard",
                submitModalTitle: "Submit Your Score",
                leaderboardModalTitle: "Top Scorers",
                leaderboardLoadingText: "Loading leaderboard...",
                leaderboardError:
                    "Could not load leaderboard data. Please try again later.",
                noScores: "No scores submitted yet.",
                points: "points",
            },
        },
    ],

    /* -------------------------------------------------------------------------
     * 5. LIVE MODE (play.html / host.html) — see js/backend.js
     * ---------------------------------------------------------------------- */
    live: {
        // "mock" — localStorage + BroadcastChannel; run host and players as
        //          tabs in one browser. No ArcGIS Online layers needed.
        // "agol" — the real hosted layers below.
        // Override per page load with ?backend=mock|agol (and ?session=...).
        backend: "mock",

        // Use test-* IDs during development. The agol adapter refuses to write
        // any other session unless allowProductionWrites is true (brief §9).
        defaultSessionId: "test-dev",
        allowProductionWrites: false,

        // Max length of reveal_json / leaderboard_json. Writes over this fail
        // loudly, in the mock too. 64000 round-tripped intact on the real
        // State table (create_layers.py, 2026-09-24).
        jsonFieldLength: 64000,

        // Round rules (host.html).
        roundSeconds: 45, // guessing time per round (brief §8 suggests 45)
        lateGraceMs: 3000, // guesses up to this long after the lock still count
        missedRoundMiles: 300, // added to total distance when a player skips a round (tie-breaker)

        // The URL on the lobby QR code. null = play.html next to host.html,
        // with this session (and backend, if overridden) in the query string.
        joinUrl: null,

        // Milliseconds between state polls, per phase (brief §3.2). ±jitter.
        // Lobby was 5 s to spare AGOL; with time-bucketed CDN caching (cacheBucketMs)
        // AGOL's load no longer grows with phones, so faster is free. Load test
        // 2026-09-25: 200 bots, 0 errors; round starts seen in <=7 s at lobby 5 s.
        polling: { lobby: 3000, final: 10000, default: 2500, jitter: 0.25 },

        mock: {
            landmarksUrl: "data/mock/landmarks.geojson",
            latencyMs: [80, 400], // simulated network delay per call
        },

        // Created 2026-09-24 by scripts/create_layers.py. Service URLs aren't
        // secrets: the owner layers refuse anonymous access (token required).
        agol: {
            // WV_GeoGuess_Landmarks (PRIVATE, host only)
            landmarksUrl: "https://services2.arcgis.com/xLpB90lOmCXYDAWo/arcgis/rest/services/WV_GeoGuess_Landmarks/FeatureServer/0",
            // WV_GeoGuess_State (owner)
            stateUrl: "https://services2.arcgis.com/xLpB90lOmCXYDAWo/arcgis/rest/services/WV_GeoGuess_State/FeatureServer/0",
            // WV_GeoGuess_State_Public (read-only view)
            statePublicUrl: "https://services2.arcgis.com/xLpB90lOmCXYDAWo/arcgis/rest/services/WV_GeoGuess_State_Public/FeatureServer/0",
            // WV_GeoGuess_Guesses (owner)
            guessesUrl: "https://services2.arcgis.com/xLpB90lOmCXYDAWo/arcgis/rest/services/WV_GeoGuess_Guesses/FeatureServer/0",
            // WV_GeoGuess_Guesses_Public (add-only, blind view)
            guessesPublicUrl: "https://services2.arcgis.com/xLpB90lOmCXYDAWo/arcgis/rest/services/WV_GeoGuess_Guesses_Public/FeatureServer/0",
            guessLayerWkid: 102100, // addFeatures has no inSR; send in layer SR
            createdField: "CreationDate", // editor-tracking field
            cacheBust: true, // time-bucket param on public state polls (see cacheBucketMs)
            // All phones share one CDN-cached request per bucket, so AGOL sees
            // ~1 poll per bucket instead of one per phone. Staleness <= bucket.
            // 0 = unique per request (bypasses the CDN; got rate-limited at 200 bots).
            cacheBucketMs: 2000,
            // Only if the org uses single sign-on (docs/AGOL_SETUP.md §7).
            // A public client ID — never a client secret or API key.
            oauthClientId: null,
        },
    },

    /* -------------------------------------------------------------------------
     * 6. MAP (play.html / host.html) — see js/map.js
     * ---------------------------------------------------------------------- */
    map: {
        basemap: "hillshade", // "hillshade" | "lightgray" | "imagery" (no labels)
        boundaryUrl: "data/wv-boundary.geojson", // Census TIGERweb 2020, generalized
        countiesUrl: "data/wv-counties.geojson", // null to hide county lines
        dimOutside: true,
    },

    /* -------------------------------------------------------------------------
     * 7. SOCIAL SHARING (link previews)
     * ---------------------------------------------------------------------- */
    // Controls the preview card shown when the game's LINK is shared.
    //
    // ⚠️ Link-preview crawlers do NOT run JavaScript, so they read the <meta>
    // tags in index.html — not this file. Keep the two in sync.
    //
    // TODO(Phase 7): hosting is still an open decision (GitHub Pages vs. an
    // agency server). These assume GitHub Pages on the Sevin47/WV-GeoGuess
    // fork; update url/image if that changes, and replace the screenshot.
    social: {
        title: "WV GeoGuess — How well do you know West Virginia?",
        description:
            "A quick geo-guessing game from WVDOT GIS Day: we show you a place in West Virginia, you pin it on the map.",
        image: "https://sevin47.github.io/WV-GeoGuess/assets/screenshot.png",
        url: "https://sevin47.github.io/WV-GeoGuess/",
        twitterHandle: "",
    },

    /* -------------------------------------------------------------------------
     * 8. LEADERBOARD (optional — solo-mode fallback only)
     * ---------------------------------------------------------------------- */
    // Solo mode can let players submit their score through an ArcGIS Survey123
    // form and view a public leaderboard. The live event uses host.html's own
    // leaderboard instead; this is for Fallback A (brief §7).
    //
    // DISABLED until we publish our own Survey123 form (Phase 3). The upstream
    // values pointed at the original author's survey — we must not send WV
    // scores there.
    leaderboard: {
        enabled: false,

        // TODO(Phase 3): the share URL of our Survey123 form.
        survey123Url: "",

        // The Survey123 field to pre-fill with the player's score.
        // Format is "field:<your_field_name>".
        submitScoreFieldId: "field:score",

        // TODO(Phase 3): FeatureServer /query URL of a public view of the
        // survey's results layer.
        dataApiUrl: "",

        // The fields in that layer used to display the leaderboard.
        firstNameField: "first_name",
        lastNameField: "last_name",
        scoreField: "score",

        // How many top scores to show.
        topN: 10,
    },
};
