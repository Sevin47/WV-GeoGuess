/* =============================================================================
 * WV GeoGuess — Solo game logic (forked from ArcGIGuess)
 * =============================================================================
 * A "guess where it is" geography game built on the ArcGIS Maps SDK for
 * JavaScript. Players see a landmark's name and photo and click the map where
 * they think it is; points are awarded based on how close they get.
 *
 * You normally do NOT need to edit this file — all of the things you'd want to
 * change (web map, layer, scoring, languages, branding, leaderboard) live in
 * config.js. This file just reads that config and runs the game.
 *
 * High-level flow:
 *   init()          -> load the web map + landmark layer, then query landmarks
 *   startGame()     -> pick/shuffle the rounds for a new game
 *   startRound()    -> show a landmark, wait for the player's map click
 *   confirmGuess()  -> score the guess against the landmark's polygon
 *   endGame()       -> show total score + accuracy, offer share/submit
 *
 * Core modules are loaded from the ArcGIS CDN via the global `$arcgis.import()`
 * helper, and the map is rendered by the <arcgis-map> web component.
 * Scoring math lives in js/scoring.js.
 * ========================================================================== */
import { createScorer, formatMiles, pointsForMiles } from "./js/scoring.js";

$arcgis
    .import([
        "@arcgis/core/config.js",
        "@arcgis/core/WebMap.js",
        "@arcgis/core/Graphic.js",
        "@arcgis/core/request.js",
        "@arcgis/core/geometry/operators/containsOperator.js",
        "@arcgis/core/geometry/operators/geodesicProximityOperator.js",
    ])
    .then(([esriConfig, WebMap, Graphic, esriRequest, containsOperator, geodesicProximityOperator]) => {
        // -------------------------------------------------------------------
        // All settings live in config.js (exposed as window.ARCGIGUESS_CONFIG).
        // Edit THAT file — not this one — to make the game your own.
        // -------------------------------------------------------------------
        const CONFIG = window.ARCGIGUESS_CONFIG;
        const LEADERBOARD = CONFIG.leaderboard;
        const scorer = createScorer(
            { containsOperator, geodesicProximityOperator },
            CONFIG.scoring
        );

        // --- DOM Elements ---
        const $ = (id) => document.getElementById(id);
        const mapEl = document.querySelector("arcgis-map");
        const panels = {
            start: $("start-panel"),
            loading: $("loading-panel"),
            game: $("game-panel"),
            roundResult: $("round-result-panel"),
            gameOver: $("game-over-panel"),
            shareModal: $("share-modal"),
            submitModal: $("submit-modal"),
            leaderboardModal: $("leaderboard-modal"),
            leaderboardLoading: $("leaderboard-loading"),
            leaderboardList: $("leaderboard-list"),
        };
        const buttons = {
            langToggle: $("lang-toggle"),
            start: $("start-button"),
            confirm: $("confirm-button"),
            next: $("next-button"),
            finishEarly: $("finish-early-button"),
            playAgain: $("play-again-button"),
            share: $("share-button"),
            closeModal: $("close-modal-button"),
            submitScore: $("submit-score-button"),
            viewLeaderboard: $("view-leaderboard-button"),
            closeSubmitModal: $("close-submit-modal-button"),
            closeLeaderboardModal: $("close-leaderboard-modal-button"),
        };

        const imageElements = {
            container: $("landmark-image-container"),
            image: $("landmark-image"),
            spinner: $("image-spinner"),
        };

        // --- Languages ---
        // Every piece of on-screen text and each language's settings come from
        // config.js. The first language in the array is the default one.
        const LANGUAGES = CONFIG.languages;
        const LANG_BY_CODE = {};
        LANGUAGES.forEach((lang) => (LANG_BY_CODE[lang.code] = lang));
        const DEFAULT_LANG = LANGUAGES[0];

        // --- Game State ---
        let currentLanguage = DEFAULT_LANG.code;
        let gameState = "LOADING"; // START, LOADING, PLAYING, ROUND_RESULT, GAME_OVER
        let landmarkPool = []; // Every landmark loaded from the layer (the master list).
        let allLandmarks = []; // The landmarks selected for the current game.
        let currentLandmarkIndex = 0;
        let totalScore = 0;
        let accuracyTracker = []; // 1 for correct, 0 for incorrect
        let clickedPoint = null;
        let webmap, landmarksLayer;
        // Whether a map click currently counts as placing a guess (see startRound).
        let clicksEnabled = false;
        // "Finish early" needs two taps to confirm; these track that armed state.
        let finishEarlyArmed = false;
        let finishEarlyTimer = null;

        // Graphics Symbols
        // The player's guess is shown as a pushpin (fitting the app's name). The
        // artwork is a plain file (assets/pin.svg) — replace that file to restyle
        // it. It's drawn on the map canvas, so we animate it by swapping the
        // symbol's offset each frame (see animatePinDrop below).
        const PIN_IMAGE = "./assets/pin.svg"; // replace this file to restyle the pin
        const PIN_WIDTH = 28; // matches the 24:36 (2:3) artwork aspect ratio
        const PIN_HEIGHT = 42;
        const PIN_REST_YOFFSET = PIN_HEIGHT / 2; // lifts the pin's tip onto the clicked point

        function makePinSymbol(yoffset) {
            return {
                type: "picture-marker",
                url: PIN_IMAGE,
                width: PIN_WIDTH,
                height: PIN_HEIGHT,
                yoffset: yoffset,
            };
        }

        const correctSymbol = {
            type: "simple-fill",
            color: [50, 205, 50, 0.3], // Translucent green
            outline: {
                color: "white",
                width: 2,
            },
        };

        const incorrectSymbol = {
            type: "simple-fill",
            color: [220, 20, 60, 0.3], // Translucent red
            outline: {
                color: "white",
                width: 2,
            },
        };

        // --- Helper Functions ---

        /**
         * Return the config object for the language currently in use.
         */
        function currentLang() {
            return LANG_BY_CODE[currentLanguage] || DEFAULT_LANG;
        }

        /**
         * Look up a translated string by key and fill in any {placeholders}.
         * Falls back to the default language, then to the key itself.
         * `{appName}` is always available without passing it in.
         */
        function t(key, replacements = {}) {
            const active = currentLang();
            let text =
                (active.strings && active.strings[key]) ||
                DEFAULT_LANG.strings[key] ||
                key;
            // `{appName}` and `{url}` (from config.social.url) are always available.
            const values = {
                appName: CONFIG.appName,
                url: (CONFIG.social && CONFIG.social.url) || "",
                ...replacements,
            };
            for (const [placeholder, value] of Object.entries(values)) {
                // split/join replaces every occurrence of the placeholder.
                text = text.split(`{${placeholder}}`).join(value);
            }
            return text;
        }

        /**
         * Build the human-readable scoring explanation shown on the start
         * screen, straight from the numbers in CONFIG.scoring — so the text
         * can never disagree with the actual scoring rules.
         */
        function buildScoringSummary() {
            const s = CONFIG.scoring;
            if (s.mode === "bands") {
                return t("scoringSummaryBands", {
                    points: s.maxPoints,
                    band: s.bands.bandMiles,
                    penalty: s.bands.penaltyPerBand,
                    min: s.bands.minScore,
                });
            }
            return t("scoringSummaryExponential", {
                points: s.maxPoints,
                p10: pointsForMiles(10, false, s),
                p25: pointsForMiles(25, false, s),
                p50: pointsForMiles(50, false, s),
            });
        }

        /**
         * Update all UI text and panel visibility based on state
         */
        function updateUI() {
            // Update language and text direction from the active language config.
            document.documentElement.lang = currentLanguage;
            document.body.dir = currentLang().dir;

            // Toggle button text (label defined per-language in config)
            buttons.langToggle.innerText = currentLang().toggleLabel;

            // If there's only one language configured, hide the toggle entirely.
            buttons.langToggle.classList.toggle("hidden", LANGUAGES.length < 2);

            // Translate all static text
            // Start Panel
            $("welcome-title").innerHTML = t("welcomeTitle");
            // The scoring summary is generated from CONFIG.scoring and injected
            // into the welcome description.
            $("welcome-desc").innerHTML = t("welcomeDesc", {
                scoringSummary: buildScoringSummary(),
            });
            buttons.start.innerText = t("startButton");

            // Loading Panel
            $("loading-text").innerText = t("loadingText");

            // Game Panel
            $("find-landmark-text").innerText = t("findLandmarkText");
            $("score-display").innerText = t("scoreDisplay", {
                score: totalScore,
            });
            if (allLandmarks.length > 0) {
                $("round-display").innerText = t("roundDisplay", {
                    current: currentLandmarkIndex + 1,
                    total: allLandmarks.length,
                });
            }

            // Confirm Panel
            buttons.confirm.innerText = t("confirmButton");

            // Finish-early button: only while playing, and only if there are
            // still rounds left to skip. Keep its label unless it's "armed".
            const canFinishEarly =
                CONFIG.allowFinishEarly &&
                gameState === "PLAYING" &&
                currentLandmarkIndex < allLandmarks.length - 1;
            buttons.finishEarly.classList.toggle("hidden", !canFinishEarly);
            if (!finishEarlyArmed) {
                buttons.finishEarly.innerText = t("finishEarlyButton");
            }

            // Round Result Panel
            buttons.next.innerText = t(
                currentLandmarkIndex === allLandmarks.length - 1
                    ? "gameOverButton"
                    : "nextButton"
            );

            // Game Over Panel
            $("game-over-title").innerText = t("gameOverTitle");
            $("final-score-text").innerText = t("finalScoreText");
            $("total-score-label").innerText = t("totalScoreLabel");
            $("accuracy-label").innerText = t("accuracyLabel");
            $("found-label").innerText = t("foundLabel");
            buttons.playAgain.innerText = t("playAgainButton");
            buttons.share.innerText = t("shareButton");
            buttons.submitScore.innerText = t("submitScoreButton");
            buttons.viewLeaderboard.innerText = t("viewLeaderboardButton");


            // Share Modal
            $("share-modal-title").innerText = t("shareModalTitle");
            $("share-modal-desc").innerText = t("shareModalDesc");
            
            
            $("submit-modal-title").innerText = t("submitModalTitle");
            $("leaderboard-modal-title").innerText = t("leaderboardModalTitle");
            $("leaderboard-loading-text").innerText = t("leaderboardLoadingText");


            // Share Card (Hidden)
            $("share-card-title").innerText = t("shareCardTitle");
            $("share-card-score-label").innerText = t("shareCardScoreLabel");
            $("share-card-accuracy-label").innerText = t(
                "shareCardAccuracyLabel"
            );
            $("share-card-found-label").innerText = t("foundLabel");

            // Show/Hide Panels
            for (const panel of Object.values(panels)) {
                panel.classList.add("hidden");
            }

            switch (gameState) {
                case "LOADING":
                    panels.loading.classList.remove("hidden");
                    break;
                case "START":
                    panels.start.classList.remove("hidden");
                    break;
                case "PLAYING":
                    panels.game.classList.remove("hidden");
                    // The Confirm button lives inside the game panel and only
                    // appears once the player has placed a guess on the map.
                    buttons.confirm.classList.toggle("hidden", !clickedPoint);
                    break;
                case "ROUND_RESULT":
                    panels.roundResult.classList.remove("hidden");
                    break;
                case "GAME_OVER":
                    panels.gameOver.classList.remove("hidden");
                    break;
            }
        }

        /**
         * Toggle language
         */
        function toggleLanguage() {
            // Cycle to the next language defined in config (wraps around),
            // so this works whether there are two languages or ten.
            const idx = LANGUAGES.findIndex((l) => l.code === currentLanguage);
            currentLanguage = LANGUAGES[(idx + 1) % LANGUAGES.length].code;

            // Re-render UI with new language
            updateUI();

            // Update the dynamic landmark name if a round is in progress
            if (gameState === "PLAYING") {
                const landmark = allLandmarks[currentLandmarkIndex];
                $("landmark-name").innerText =
                    landmark.attributes[CONFIG.landmarkNameField];
            }
        }

        /**
         * Shuffle an array
         */
        function shuffleArray(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        /**
         * Convert data URL to File object (for Web Share API)
         */
        function dataURLtoFile(dataUrl, filename) {
            return fetch(dataUrl)
                .then((res) => res.blob())
                .then((blob) => {
                    return new File([blob], filename, { type: blob.type });
                });
        }

        // --- Game Logic Functions ---

        /**
         * Initialize the map and load game data
         */
        async function init() {
            try {
                // Point the SDK at an ArcGIS Enterprise portal if one is
                // configured; otherwise it defaults to ArcGIS Online. This
                // must be set before the web map loads so item requests and
                // any sign-in prompts target the right portal.
                if (CONFIG.portalUrl) {
                    esriConfig.portalUrl = CONFIG.portalUrl;
                }

                // Create the web map and hand it to the <arcgis-map> component.
                webmap = new WebMap({
                    portalItem: {
                        id: CONFIG.webMapItemId,
                    },
                });
                mapEl.map = webmap;

                // Load the web map so we can find the landmarks layer by title.
                await webmap.load();
                landmarksLayer = webmap.layers.find(
                    (layer) => layer.title === CONFIG.landmarkLayerTitle
                );

                if (!landmarksLayer) {
                    console.error(
                        `Could not find layer '${CONFIG.landmarkLayerTitle}'`
                    );
                    alert(t("layerError"));
                    return;
                }

                // Hide the answer layer, then wait for the view, the
                // projection engine (used by scoring), and game data.
                landmarksLayer.visible = false;
                await mapEl.viewOnReady();
                await scorer.load();
                await loadGameData();

                console.log("Map view ready and game data loaded.");
                gameState = "START";
                updateUI();
            } catch (error) {
                console.error("Error during initialization:", error);
                alert(t("webMapError"));
                panels.loading.classList.remove("hidden");
            }
        }

        /**
         * Query all features from the landmarks layer
         */
        function loadGameData() {
            try {
                const query = landmarksLayer.createQuery();
                query.where = "1=1"; // Get all features
                query.outFields = [
                    CONFIG.landmarkNameField,
                    CONFIG.landmarkIdField,
                ];
                query.returnGeometry = true;

                return landmarksLayer
                    .queryFeatures(query)
                    .then((featureSet) => {
                        // Keep the layer's natural order here; shuffling (if
                        // enabled) happens per-game in startGame().
                        allLandmarks = featureSet.features;

                        const attachmentPromises = allLandmarks.map(
                            (feature) => {
                                return landmarksLayer
                                    .queryAttachments({
                                        objectIds: [
                                            feature.attributes[
                                                CONFIG.landmarkIdField
                                            ],
                                        ],
                                    })
                                    .then((attachmentMap) => {
                                        const objectId =
                                            feature.attributes[
                                                CONFIG.landmarkIdField
                                            ];
                                        const attachments =
                                            attachmentMap[objectId];

                                        if (
                                            attachments &&
                                            attachments.length > 0
                                        ) {
                                            feature.attributes.imageUrl =
                                                attachments[0].url;
                                        } else {
                                            feature.attributes.imageUrl = null;
                                        }
                                        return feature;
                                    });
                            }
                        );
                        return Promise.all(attachmentPromises);
                    })
                    .then((landmarksWithImages) => {
                        // Keep the full set as the master pool. Each game draws
                        // (and optionally limits) its rounds from this list.
                        landmarkPool = landmarksWithImages;
                        allLandmarks = landmarksWithImages;
                        console.log(
                            "Landmarks and images loaded:",
                            landmarkPool
                        );
                    })
                    .catch((error) => {
                        console.error(
                            "Error querying features or attachments:",
                            error
                        );
                        alert("Could not load landmark data.");
                        return Promise.reject(error);
                    });
            } catch (error) {
                console.error("Error creating query:", error);
                alert("Could not load landmark data.");
                return Promise.reject(error);
            }
        }

        /**
         * Start the game
         */
        function startGame() {
            // Reset game state
            currentLandmarkIndex = 0;
            totalScore = 0;
            accuracyTracker = [];
            clickedPoint = null;
            mapEl.graphics.removeAll();

            // Draw the rounds for this game from the master pool. Shuffle only
            // if CONFIG.shuffleLandmarks is enabled; otherwise keep layer order.
            allLandmarks = CONFIG.shuffleLandmarks
                ? shuffleArray(landmarkPool.slice())
                : landmarkPool.slice();
            if (CONFIG.roundsPerGame) {
                allLandmarks = allLandmarks.slice(0, CONFIG.roundsPerGame);
            }

            startRound();
        }

        /**
         * Start a new round
         */
        function startRound() {
            clickedPoint = null;
            mapEl.graphics.removeAll();
            resetFinishEarly();

            const landmark = allLandmarks[currentLandmarkIndex];
            const name = landmark.attributes[CONFIG.landmarkNameField];
            const imageUrl = landmark.attributes.imageUrl;

            $("landmark-name").innerText = name;

            // Handle the image display
            if (imageUrl) {
                imageElements.container.classList.remove("hidden");
                imageElements.image.classList.add("hidden"); // Hide img tag while loading
                imageElements.spinner.classList.remove("hidden"); // Show spinner

                imageElements.image.src = imageUrl;
                // Neutral alt text: the name would give the answer away once
                // prompts are photo-only (brief §3.6).
                imageElements.image.alt = "Photo of the location to find";
                imageElements.image.onload = () => {
                    imageElements.image.classList.remove("hidden");
                    imageElements.spinner.classList.add("hidden");
                };
                imageElements.image.onerror = () => {
                    imageElements.container.classList.add("hidden");
                };
            } else {
                imageElements.container.classList.add("hidden");
            }

            gameState = "PLAYING";
            updateUI();

            // Start accepting map clicks as guesses for this round.
            clicksEnabled = true;
        }

        /**
         * Handle user's click on the map
         */
        function handleMapClick(mapPoint) {
            clickedPoint = mapPoint;
            mapEl.graphics.removeAll();
            const pinGraphic = new Graphic({
                geometry: clickedPoint,
                symbol: makePinSymbol(PIN_REST_YOFFSET),
            });
            mapEl.graphics.add(pinGraphic);
            animatePinDrop(pinGraphic);
            updateUI();
        }

        /**
         * Animate a freshly-placed pin so it appears to drop from above and
         * bounce into place. The marker is rendered on the map (not the DOM),
         * so we nudge its vertical offset each frame instead of using CSS.
         */
        function animatePinDrop(graphic) {
            const dropHeight = 60; // starting height above rest, in points
            const duration = 650; // ms
            const start = performance.now();

            function frame(now) {
                const p = Math.min((now - start) / duration, 1);
                const extra = dropHeight * (1 - easeOutBounce(p));
                graphic.symbol = makePinSymbol(PIN_REST_YOFFSET + extra);
                if (p < 1) requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
        }

        /** Standard "ease out bounce" easing: 0 → 1 with a settling bounce. */
        function easeOutBounce(x) {
            const n1 = 7.5625;
            const d1 = 2.75;
            if (x < 1 / d1) {
                return n1 * x * x;
            } else if (x < 2 / d1) {
                return n1 * (x -= 1.5 / d1) * x + 0.75;
            } else if (x < 2.5 / d1) {
                return n1 * (x -= 2.25 / d1) * x + 0.9375;
            } else {
                return n1 * (x -= 2.625 / d1) * x + 0.984375;
            }
        }

        /**
         * User confirms their guess, time to score
         */
        function confirmGuess() {
            if (!clickedPoint) return;

            // Stop accepting further clicks while we score this guess.
            clicksEnabled = false;

            const targetLandmark = allLandmarks[currentLandmarkIndex];
            const targetPolygon = targetLandmark.geometry;

            // Geodesic distance, not planar Web Mercator — see js/scoring.js.
            const result = scorer.scoreGuess(targetPolygon, clickedPoint);
            const roundScore = result.points;

            // Only a guess inside the polygon counts as "found" — for both the
            // message shown and the accuracy stat — so they can't contradict.
            const found = result.inside;

            let resultTitle;
            let resultMessage;
            let resultSymbol;
            if (found) {
                resultTitle = t("correctTitle");
                resultMessage = t("correctMessage", { roundScore: roundScore });
                resultSymbol = correctSymbol;
                accuracyTracker.push(1);
            } else {
                resultTitle = t("incorrectTitle");
                resultMessage = t("incorrectMessage", {
                    distance: formatMiles(result.miles),
                    roundScore: roundScore,
                });
                resultSymbol = incorrectSymbol;
                accuracyTracker.push(0);
            }

            totalScore += roundScore;

            $("round-result-title").innerText = resultTitle;
            $("round-result-message").innerHTML = resultMessage;
            $("round-result-title").style.color = found
                ? "#16a34a"
                : "#dc2626";

            const resultGraphic = new Graphic({
                geometry: targetPolygon,
                symbol: resultSymbol,
            });
            mapEl.graphics.add(resultGraphic);

            mapEl.goTo(targetPolygon.extent.expand(1.5)).catch((err) => {
                // goTo rejects if its animation is interrupted — that's harmless.
                if (err && err.name !== "AbortError") console.error(err);
            });

            gameState = "ROUND_RESULT";
            updateUI();
        }

        /**
         * Reset the "finish early" button back to its unarmed state.
         */
        function resetFinishEarly() {
            finishEarlyArmed = false;
            if (finishEarlyTimer) {
                clearTimeout(finishEarlyTimer);
                finishEarlyTimer = null;
            }
            buttons.finishEarly.classList.remove("armed");
            buttons.finishEarly.innerText = t("finishEarlyButton");
        }

        /**
         * "Finish early": the player accepts their current score (the remaining
         * landmarks are left unplayed and count as missed) and jumps to the
         * results. The first tap "arms" the button and the second confirms, so
         * the game can't be ended by a stray click.
         */
        function handleFinishEarly() {
            if (!finishEarlyArmed) {
                finishEarlyArmed = true;
                buttons.finishEarly.classList.add("armed");
                buttons.finishEarly.innerText = t("finishEarlyConfirm");
                finishEarlyTimer = setTimeout(resetFinishEarly, 3000);
                return;
            }

            resetFinishEarly();
            clicksEnabled = false;
            endGame();
        }

        /**
         * Move to the next round or end the game
         */
        function nextRound() {
            currentLandmarkIndex++;
            if (currentLandmarkIndex < allLandmarks.length) {
                startRound();
            } else {
                endGame();
            }
        }

        function endGame() {
            gameState = "GAME_OVER";
            updateUI();

            const total = allLandmarks.length || 1;
            const foundCount = accuracyTracker.filter((a) => a === 1).length;
            const accuracy = Math.round((foundCount / total) * 100);
            const foundText = `${foundCount} / ${allLandmarks.length}`;

            $("total-score").innerText = totalScore;
            $("accuracy").innerText = `${accuracy}%`;
            $("found-count").innerText = foundText;

            $("share-card-score").innerText = totalScore;
            $("share-card-accuracy").innerText = `${accuracy}%`;
            $("share-card-found").innerText = foundText;
        }

        /**
         * Handle sharing the results
         */
        function shareResults() {
            const shareCard = $("share-card");
            // PNG: universally accepted by share targets and lossless, so the
            // card's text stays crisp (WebP/JPEG can soften text and be rejected
            // by some upload flows).
            const fileName = `${CONFIG.appName
                .replace(/\s+/g, "-")
                .toLowerCase()}-results.png`;

            shareCard.classList.remove("hidden");
            shareCard.style.position = "absolute";
            shareCard.style.left = "-9999px";

            setTimeout(() => {
                html2canvas(shareCard, { scale: 2, useCORS: true })
                    .then((canvas) => {
                        const dataUrl = canvas.toDataURL("image/png");
                        return dataURLtoFile(dataUrl, fileName).then(
                            (file) => ({ dataUrl, file })
                        );
                    })
                    .then(({ dataUrl, file }) => {
                        hideShareCard();
                        if (
                            navigator.share &&
                            navigator.canShare({ files: [file] })
                        ) {
                            return navigator.share({
                                title: t("shareCardTitle"),
                                text: t("shareText", { score: totalScore }),
                                files: [file],
                            });
                        } else {
                            $("share-image-preview").src = dataUrl;
                            panels.shareModal.classList.remove("hidden");
                        }
                    })
                    .catch((error) => {
                        console.error("Error sharing:", error);
                        hideShareCard();
                        html2canvas($("share-card"), { scale: 2, useCORS: true })
                            .then((canvas) => {
                                $("share-image-preview").src =
                                    canvas.toDataURL("image/png");
                                panels.shareModal.classList.remove("hidden");
                            })
                            .catch((e) => {
                                console.error(
                                    "Error generating fallback share image:",
                                    e
                                );
                                hideShareCard();
                            });
                    });
            }, 100);
        }

        // Helper to hide the share card
        function hideShareCard() {
            const shareCard = $("share-card");
            shareCard.classList.add("hidden");
            shareCard.style.position = "";
            shareCard.style.left = "";
        }

        /**
         * Opens the Survey123 modal with the score pre-filled
         */
        function showSubmitModal() {
            // Pre-fill the score field and hide the survey's chrome. The score
            // field is also hidden so players can't tamper with the value.
            const fieldId = LEADERBOARD.submitScoreFieldId;
            let url = `${LEADERBOARD.survey123Url}?${fieldId}=${totalScore}&hide=navbar,header,description,footer,${fieldId}`;

            // Open the survey in the active language, if one is configured for it.
            const surveyLang = currentLang().surveyLang;
            if (surveyLang) {
                url += `&lang=${surveyLang}`;
            }
            $("survey-iframe").src = url;
            panels.submitModal.classList.remove("hidden");
        }

        /**
         * Opens the leaderboard modal and fetches data
         */
        function showLeaderboard() {
            panels.leaderboardModal.classList.remove("hidden");
            panels.leaderboardLoading.classList.remove("hidden");
            panels.leaderboardList.classList.add("hidden");
            panels.leaderboardList.innerHTML = ""; // Clear old results
            
            fetchLeaderboardData();
        }

        /**
         * Fetches and displays the top 10 scores
         */
        function fetchLeaderboardData() {
            const queryParams = {
                f: "json",
                where: "1=1",
                outFields: `${LEADERBOARD.firstNameField},${LEADERBOARD.lastNameField},${LEADERBOARD.scoreField}`,
                orderByFields: `${LEADERBOARD.scoreField} DESC`,
                resultRecordCount: LEADERBOARD.topN,
            };

            esriRequest(LEADERBOARD.dataApiUrl, {
                query: queryParams,
                responseType: "json",
            })
                .then((response) => {
                    const features = response.data.features;
                    populateLeaderboard(features);
                })
                .catch((error) => {
                    console.error("Error fetching leaderboard:", error);
                    panels.leaderboardLoading.classList.add("hidden");
                    panels.leaderboardList.classList.remove("hidden");
                    panels.leaderboardList.innerHTML = `<li class="text-red-600">${t("leaderboardError")}</li>`;
                });
        }

        /**
         * Populates the leaderboard list with data
         */
        function populateLeaderboard(features) {
            panels.leaderboardLoading.classList.add("hidden");
            panels.leaderboardList.classList.remove("hidden");
            
            if (!features || features.length === 0) {
                 panels.leaderboardList.innerHTML = `<li>${t("noScores")}</li>`;
                 return;
            }

            features.forEach((feature, index) => {
                // Combine the first and last name fields into one display name.
                const firstName = feature.attributes[LEADERBOARD.firstNameField] || "";
                const lastName = feature.attributes[LEADERBOARD.lastNameField] || "";
                const name = `${firstName} ${lastName}`.trim() || "Anonymous";
                const score = feature.attributes[LEADERBOARD.scoreField] || 0;

                // Build with textContent (never innerHTML) so a player-submitted
                // name can't inject HTML or script into the page.
                const li = document.createElement("li");
                li.className =
                    "p-3 bg-gray-100 rounded-lg flex justify-between items-center";

                const nameSpan = document.createElement("span");
                nameSpan.className = "font-bold text-lg text-blue-700";
                nameSpan.textContent = `${index + 1}. ${name}`;

                const scoreSpan = document.createElement("span");
                scoreSpan.className = "font-semibold text-lg";
                scoreSpan.textContent = `${score} ${t("points")}`;

                li.appendChild(nameSpan);
                li.appendChild(scoreSpan);
                panels.leaderboardList.appendChild(li);
            });
        }

        /**
         * Apply one-time, config-driven branding and feature toggles to the DOM.
         * Runs once at startup, before the map begins loading.
         */
        function applyStaticConfig() {
            // Browser tab title: "AppName | tagline".
            document.title = `${CONFIG.appName} | ${CONFIG.tagline}`;

            // Logos live at assets/logo.svg (referenced directly in index.html).
            // We only keep their alt text in sync with the app name here.
            const logoAlt = `${CONFIG.appName} Logo`;
            [$("start-logo"), $("share-logo")].forEach((img) => {
                if (img) img.alt = logoAlt;
            });

            // Footer line on the shareable results card.
            $("share-card-footer").innerText =
                CONFIG.shareCardFooter || CONFIG.tagline;

            // Keep the social link-preview <meta> tags in sync with config.
            applySocialMeta();

            // If the leaderboard feature is off, hide its two buttons entirely.
            if (!LEADERBOARD || !LEADERBOARD.enabled) {
                buttons.submitScore.classList.add("hidden");
                buttons.viewLeaderboard.classList.add("hidden");
            }
        }

        /**
         * Mirror the CONFIG.social values into the page's Open Graph / Twitter
         * <meta> tags.
         *
         * NOTE: link-preview crawlers (WhatsApp, LinkedIn, Facebook, X, Slack)
         * do NOT execute JavaScript, so they read the STATIC tags in index.html,
         * not the values set here. This keeps the two consistent for in-app use
         * and JS-aware tools — but for guaranteed previews, also edit the static
         * tags in index.html (see the README).
         */
        function applySocialMeta() {
            const s = CONFIG.social;
            if (!s) return;

            const setMeta = (selector, value) => {
                if (value == null || value === "") return;
                const el = document.head.querySelector(selector);
                if (el) el.setAttribute("content", value);
            };

            setMeta('meta[name="description"]', s.description);
            setMeta('meta[property="og:site_name"]', CONFIG.appName);
            setMeta('meta[property="og:title"]', s.title);
            setMeta('meta[property="og:description"]', s.description);
            setMeta('meta[property="og:image"]', s.image);
            setMeta('meta[property="og:url"]', s.url);
            setMeta('meta[name="twitter:title"]', s.title);
            setMeta('meta[name="twitter:description"]', s.description);
            setMeta('meta[name="twitter:image"]', s.image);
            setMeta('meta[name="twitter:site"]', s.twitterHandle);
            setMeta('meta[name="twitter:creator"]', s.twitterHandle);
        }

        // --- Event Listeners ---
        // A single click listener on the map component; the `clicksEnabled` flag
        // decides whether a click counts as placing a guess this round.
        mapEl.addEventListener("arcgisViewClick", (event) => {
            if (clicksEnabled) handleMapClick(event.detail.mapPoint);
        });

        buttons.langToggle.addEventListener("click", toggleLanguage);
        buttons.start.addEventListener("click", startGame);
        buttons.confirm.addEventListener("click", confirmGuess);
        buttons.next.addEventListener("click", nextRound);
        buttons.finishEarly.addEventListener("click", handleFinishEarly);
        buttons.playAgain.addEventListener("click", startGame);
        buttons.share.addEventListener("click", shareResults);
        buttons.closeModal.addEventListener("click", () => {
            panels.shareModal.classList.add("hidden");
        });

        buttons.submitScore.addEventListener("click", showSubmitModal);
        buttons.viewLeaderboard.addEventListener("click", showLeaderboard);
        buttons.closeSubmitModal.addEventListener("click", () => {
            panels.submitModal.classList.add("hidden");
            $("survey-iframe").src = ""; // Clear src to stop survey
        });
        buttons.closeLeaderboardModal.addEventListener("click", () => {
            panels.leaderboardModal.classList.add("hidden");
        });


        // Apply branding and feature toggles from config, then start up.
        applyStaticConfig();

        // Start the application
        init();
        updateUI(); // Show loading screen initially

        // --- Testing helper ---
        // Open the browser console and call skipToResults() to jump straight to
        // the results screen with a random score. Handy for styling that screen.
        window.skipToResults = () => {
            console.log("Skipping to results with a random score...");
            if (allLandmarks.length === 0) {
                 // Mock data if landmarks haven't loaded
                 allLandmarks = new Array(5).fill(1);
                 console.log("Mocking 5 landmarks for test.");
            }
            totalScore = Math.floor(Math.random() * (allLandmarks.length * 8)) + 10; // Random score
            accuracyTracker = allLandmarks.map(() => Math.random() > 0.5 ? 1 : 0);
            
            endGame(); // This will set gameState = "GAME_OVER" and update UI
        };

    });
