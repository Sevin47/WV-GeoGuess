/* =============================================================================
 * WV GeoGuess — Host / projector page (host.html)
 * =============================================================================
 * The single source of truth (brief §3.2): it holds the answers, runs the
 * clock, scores rounds (js/round.js), and publishes state for the phones.
 * It keeps its own copy of the state and writes changes, so it never polls,
 * and its timers keep running while the tab is hidden behind the slides.
 *
 *   lobby ─next→ guessing ─(timer or L)→ locked ─(next or R)→ reveal
 *     ↑                                                          │ next
 *     └──── lobby ←next─ leaderboard ←─(end of a set)────────────┤
 *                                                                ├─→ next round (same set)
 *                                                                └─→ final (no rounds left)
 *
 * Recovery: a refresh reloads the State row and carries on — round number,
 * lock time (roundEndsAt), and totals (leaderboard) all live there.
 *
 * URL options: ?session=gisday2026  ?backend=mock|agol
 * ========================================================================== */
import { createHostBackend, resolveLiveConfig, siteUrl, assertSessionId } from "./backend.js";
import { sdkReady, setupWVMap, makePinSymbol, zoomToLonLats } from "./map.js";
import { createScorer, formatMiles } from "./scoring.js";
import { scoreRound, selectValidGuesses, playerTag, setNameHidden, hideNameInReveal } from "./round.js";

const CONFIG = window.ARCGIGUESS_CONFIG;
const live = resolveLiveConfig(CONFIG.live, location.search);
const sid = live.sessionId;
const isAgol = live.backend === "agol";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Sign-in (ArcGIS Online) ---------------------------------------------------------
// Only the host signs in; players never do. The SDK's built-in dialog handles
// ArcGIS usernames (docs/AGOL_SETUP.md §7 covers single sign-on orgs).
// Credentials are kept in sessionStorage — this tab only, gone when it
// closes — so a refresh mid-game doesn't ask for the password again.
const IDM_KEY = "wvgg.host.identity";
let identityPromise = null;

function identity() {
    identityPromise ??= (async () => {
        await sdkReady();
        const [esriId, OAuthInfo] = await $arcgis.import([
            "@arcgis/core/identity/IdentityManager.js",
            "@arcgis/core/identity/OAuthInfo.js",
        ]);
        if (live.agol.oauthClientId) {
            esriId.registerOAuthInfos([new OAuthInfo({ appId: live.agol.oauthClientId, popup: false })]);
        }
        try {
            const saved = sessionStorage.getItem(IDM_KEY);
            if (saved) esriId.initialize(JSON.parse(saved));
        } catch {
            /* no saved sign-in */
        }
        esriId.on("credential-create", () => {
            try {
                sessionStorage.setItem(IDM_KEY, JSON.stringify(esriId.toJSON()));
            } catch {
                /* storage blocked: the host signs in again after a refresh */
            }
        });
        return esriId;
    })();
    return identityPromise;
}

async function getToken(url) {
    const esriId = await identity();
    return (await esriId.getCredential(url)).token;
}

const backend = createHostBackend(live, { getToken });

// --- State ---------------------------------------------------------------------------
let state = null; // the session state, as last written/read
let rounds = []; // landmarks (the answers), sorted by round order
let busy = false; // one action at a time (clickers double-fire)
let jumpTo = null; // admin override for the next round
let guessCount = 0;
let mapApi = null;
let revealToken = 0; // cancels a running reveal animation
let scorer = null;

const roundByNum = (n) => rounds.find((r) => r.roundOrder === n);

function nextRound() {
    if (jumpTo) return jumpTo;
    return rounds.find((r) => r.roundOrder > (state?.roundNum || 0)) ?? null;
}

// --- Actions ---------------------------------------------------------------------------

async function write(patch) {
    state = await backend.updateState(sid, patch);
    render();
}

/** Run one action at a time; show failures instead of throwing. */
async function act(fn) {
    if (busy || !state) return;
    busy = true;
    try {
        await fn();
        hideToast();
    } catch (err) {
        console.error(err);
        toast(err.code === "PRODUCTION_WRITE_BLOCKED" ? err.message : `Couldn't do that: ${err.message}`);
    } finally {
        busy = false;
        render();
    }
}

async function startRound(lm) {
    jumpTo = null;
    guessCount = 0;
    revealToken++;
    mapApi?.clear();
    await write({
        phase: "guessing",
        roundNum: lm.roundOrder,
        roundTotal: rounds.length,
        setName: lm.setName,
        imagePath: lm.imagePath,
        promptText: lm.promptText,
        roundEndsAt: Date.now() + live.roundSeconds * 1000,
        reveal: null,
    });
}

async function lock() {
    if (state.phase !== "guessing") return;
    // Pull roundEndsAt in to the lock time: phones' countdowns stop, and the
    // late-guess cutoff survives a refresh.
    await write({ phase: "locked", roundEndsAt: Math.min(state.roundEndsAt, Date.now()) });
}

async function reveal() {
    if (state.phase === "guessing") await lock();
    if (state.phase !== "locked" && state.phase !== "reveal") return;
    const lm = roundByNum(state.roundNum);
    if (!lm) throw new Error(`No landmark for round ${state.roundNum}`);
    if (!scorer) throw new Error("the map is still loading — try again in a moment");

    const guesses = await backend.listGuesses(sid, state.roundNum);
    let { reveal: rv, leaderboard } = state;
    const alreadyScored = leaderboard?.afterRound >= state.roundNum && rv?.round === state.roundNum;
    if (!alreadyScored) {
        const polygon = scorer.Polygon.fromJSON(lm.geometry);
        ({ reveal: rv, leaderboard } = scoreRound({
            roundNum: state.roundNum,
            landmark: lm,
            guesses,
            lockTime: state.roundEndsAt,
            graceMs: live.lateGraceMs,
            missedRoundMiles: live.missedRoundMiles,
            prevBoard: state.leaderboard,
            scoreGuess: (_lm, g) =>
                scorer.scoreGuess(polygon, new scorer.Point({ longitude: g.lon, latitude: g.lat })),
        }));
    }
    await write({ phase: "reveal", reveal: rv, leaderboard });
    animateReveal(lm, guesses);
}

/** B: only between rounds, so a round is never abandoned unscored by accident. */
async function showLeaderboard() {
    if (state.phase === "guessing" || state.phase === "locked") {
        throw new Error("reveal this round first (R), then show the leaderboard");
    }
    await write({ phase: "leaderboard" });
}

async function next() {
    switch (state.phase) {
        case "lobby": {
            const r = nextRound();
            return r ? startRound(r) : write({ phase: "final" });
        }
        case "guessing":
            return lock();
        case "locked":
            return reveal();
        case "reveal": {
            const r = nextRound();
            if (!r) return write({ phase: "final" });
            const current = roundByNum(state.roundNum);
            // End of a set (break) -> leaderboard; otherwise straight on.
            if (!jumpTo && current && r.setName !== current.setName) return write({ phase: "leaderboard" });
            return startRound(r);
        }
        case "leaderboard":
            return write({ phase: nextRound() ? "lobby" : "final" });
        default:
            return undefined;
    }
}

// --- Timers --------------------------------------------------------------------------------
// setInterval keeps running in a hidden tab (throttled to ~1/s, which is
// plenty for a 45 s round).

setInterval(() => {
    if (!state) return;
    const left = state.phase === "guessing" ? Math.max(0, Math.ceil((state.roundEndsAt - Date.now()) / 1000)) : null;
    const timer = $("timer");
    if (state.phase === "guessing") {
        timer.textContent = String(left);
        timer.className = `timer${left <= 10 ? " hurry" : ""}`;
        $("timer-note").textContent = "";
        if (left === 0 && !busy) act(lock); // auto-lock (brief §3.2)
    } else if (state.phase === "locked") {
        timer.textContent = "Time's up!";
        timer.className = "timer done";
        $("timer-note").textContent = "Press → to reveal";
    }
}, 250);

// "N guesses in" while a round is open.
setInterval(async () => {
    if (!state || (state.phase !== "guessing" && state.phase !== "locked")) return;
    try {
        guessCount = await backend.countGuesses(sid, state.roundNum);
        renderRoundCount();
    } catch (err) {
        console.warn("Guess count failed", err);
    }
}, 2000);

// --- Rendering ---------------------------------------------------------------------------------

const SCREEN_FOR_PHASE = {
    lobby: "lobby",
    guessing: "round",
    locked: "round",
    reveal: "reveal",
    leaderboard: "leaderboard",
    final: "final",
};

function render() {
    if (!state) return;
    document.body.dataset.screen = SCREEN_FOR_PHASE[state.phase] || "lobby";
    $("status-line").textContent = `${sid} · ${backend.kind} · ${state.phase}${state.roundNum ? ` · round ${state.roundNum}/${rounds.length}` : ""}`;

    const phase = state.phase;
    $("btn-lock").disabled = phase !== "guessing";
    $("btn-reveal").disabled = phase !== "guessing" && phase !== "locked";
    $("btn-next").disabled = phase === "final";

    if (phase === "lobby") renderLobby();
    if (phase === "guessing" || phase === "locked") renderRound();
    if (phase === "reveal") renderReveal();
    if (phase === "leaderboard") renderBoard($("board-list"), 10);
    if (phase === "final") renderFinal();
    if ($("admin").open) renderAdmin();
}

function joinUrl() {
    const url = new URL(live.joinUrl || "play.html", location.href);
    url.searchParams.set("session", sid);
    if (live.backend !== CONFIG.live.backend) url.searchParams.set("backend", live.backend);
    return url.href;
}

let qrDrawn = false;
function drawQrCodes() {
    if (qrDrawn) return;
    qrDrawn = true;
    const url = joinUrl();
    const qr = qrcode(0, "M"); // global from cdnjs qrcode-generator
    qr.addData(url);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $("lobby-qr").innerHTML = svg; // generated locally from our own URL
    $("round-qr").innerHTML = svg;
    const shown = url.replace(/^https?:\/\//, "");
    $("lobby-url").textContent = shown;
    $("round-url").textContent = shown;
}

function renderLobby() {
    drawQrCodes();
    const played = state.leaderboard?.afterRound > 0;
    const upcoming = nextRound();
    $("lobby-title").textContent = played ? "Join in anytime!" : "Scan to play!";
    $("lobby-sub").textContent = upcoming
        ? `${upcoming.setName ? `${upcoming.setName} — ` : ""}round ${upcoming.roundOrder} of ${rounds.length} is up next.`
        : "Drop a pin where you think each photo was taken.";
}

function renderRound() {
    drawQrCodes();
    const img = $("round-photo");
    const src = state.imagePath ? siteUrl(state.imagePath) : "";
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    $("round-label").textContent = [`Round ${state.roundNum} of ${state.roundTotal || rounds.length}`, state.setName]
        .filter(Boolean)
        .join(" · ");
    $("round-prompt").textContent = state.promptText || "Where in West Virginia is this?";
    renderRoundCount();
}

function renderRoundCount() {
    $("guess-count").textContent = guessCount.toLocaleString();
    $("guess-count-label").textContent = guessCount === 1 ? "guess in" : "guesses in";
}

function renderReveal() {
    const r = state.reveal;
    if (!r) return;
    $("reveal-label").textContent = `Round ${r.round} of ${rounds.length}`;
    $("reveal-name").textContent = r.answer.name;
    $("reveal-fact").textContent = r.answer.funFact || "";
    $("reveal-credit").textContent = r.answer.credit ? `Photo: ${r.answer.credit}` : "";
    $("reveal-top").replaceChildren(
        ...r.top.map(([, name, points, miles], i) =>
            row([
                span("name", `${i + 1}. ${name}`),
                span("dist", `${miles === 0 ? "🎯 inside" : `${formatMiles(miles)} mi`} · +${points}`),
            ])
        )
    );
    $("reveal-count").textContent = `${r.count} ${r.count === 1 ? "guess" : "guesses"} counted`;
}

function renderBoard(ol, n) {
    const board = state.leaderboard;
    $("board-title").textContent = board?.afterRound ? `Leaderboard after round ${board.afterRound}` : "Leaderboard";
    ol.replaceChildren(
        ...(board?.rows || []).slice(0, n).map((r, i) =>
            row([span("rank", `${i + 1}`), span("name", r[1]), span("pts", `${r[2].toLocaleString()} pts`)])
        )
    );
}

function renderFinal() {
    const champ = state.leaderboard?.rows?.[0];
    $("final-champion").textContent = champ ? `${champ[1]} · ${champ[2].toLocaleString()} pts` : "—";
    renderBoard($("final-list"), 10);
}

function row(children) {
    const li = document.createElement("li");
    li.append(...children);
    return li;
}
function span(className, text) {
    const s = document.createElement("span");
    s.className = className;
    s.textContent = text; // nicknames are player-supplied: text only
    return s;
}

// --- Reveal map animation (brief §3.2 step 6) -------------------------------------------------
// All pins drop in, then the answer appears, then lines and labels for the
// top 5, zoomed to fit them.

async function initMap() {
    await sdkReady();
    const [Graphic, Polygon, Point, containsOperator, geodesicProximityOperator] = await $arcgis.import([
        "@arcgis/core/Graphic.js",
        "@arcgis/core/geometry/Polygon.js",
        "@arcgis/core/geometry/Point.js",
        "@arcgis/core/geometry/operators/containsOperator.js",
        "@arcgis/core/geometry/operators/geodesicProximityOperator.js",
    ]);
    const s = createScorer({ containsOperator, geodesicProximityOperator }, CONFIG.scoring);
    await s.load();
    scorer = { ...s, Polygon, Point };

    const mapEl = $("map");
    const { resetView } = await setupWVMap(mapEl, CONFIG.map);
    mapApi = {
        mapEl,
        Graphic,
        resetView,
        clear: () => mapEl.graphics.removeAll(),
    };
}

async function animateReveal(lm, guesses) {
    if (!mapApi) return;
    const token = ++revealToken;
    const { mapEl, Graphic } = mapApi;
    const r = state.reveal;
    const valid = selectValidGuesses(guesses, { lockTime: state.roundEndsAt, graceMs: live.lateGraceMs });

    mapApi.clear();
    await mapApi.resetView();

    // 1. Everyone's pins, dropping in over ~1.5 s.
    const batches = 12;
    const per = Math.ceil(valid.length / batches) || 1;
    for (let i = 0; i < valid.length; i += per) {
        if (token !== revealToken) return;
        mapEl.graphics.addMany(
            valid.slice(i, i + per).map(
                (g) =>
                    new Graphic({
                        geometry: { type: "point", longitude: g.lon, latitude: g.lat },
                        symbol: makePinSymbol(undefined, { scale: 0.6 }),
                    })
            )
        );
        await sleep(120);
    }
    await sleep(1200);
    if (token !== revealToken) return;

    // 2. The answer.
    mapEl.graphics.add(
        new Graphic({
            geometry: { type: "polygon", ...lm.geometry },
            symbol: { type: "simple-fill", color: [22, 163, 74, 0.45], outline: { color: [20, 83, 45], width: 3 } },
        })
    );
    mapEl.graphics.add(
        new Graphic({
            geometry: { type: "point", longitude: r.answer.lon, latitude: r.answer.lat },
            symbol: { type: "picture-marker", url: siteUrl("assets/answer.svg"), width: 44, height: 44 },
        })
    );

    // 3. Lines for the top 5; name labels for the top 3, staggered so close
    //    guesses don't overlap; zoom to the answer + top 3 (a far-off 5th
    //    place would otherwise zoom out until the leaders pile up).
    const byTag = new Map(valid.map((g) => [playerTag(g.playerId), g]));
    const zoomPts = [{ lon: r.answer.lon, lat: r.answer.lat }];
    const LABEL_SPOTS = [
        { yoffset: 30 }, // above the pin
        { yoffset: -22 }, // below
        { xoffset: 16, yoffset: 8, horizontalAlignment: "left" }, // to the right
    ];
    r.top.forEach(([tag, name, , miles], i) => {
        const g = byTag.get(tag);
        if (!g) return;
        mapEl.graphics.add(
            new Graphic({
                geometry: {
                    type: "polyline",
                    paths: [[[g.lon, g.lat], [r.answer.lon, r.answer.lat]]],
                    spatialReference: { wkid: 4326 },
                },
                symbol: { type: "simple-line", color: [15, 23, 42, 0.9], width: 3, style: "dash" },
            })
        );
        if (i >= LABEL_SPOTS.length) return;
        zoomPts.push({ lon: g.lon, lat: g.lat });
        mapEl.graphics.add(
            new Graphic({
                geometry: { type: "point", longitude: g.lon, latitude: g.lat },
                symbol: {
                    type: "text",
                    text: `${i + 1}. ${name} · ${miles === 0 ? "inside!" : `${formatMiles(miles)} mi`}`,
                    color: "#0f172a",
                    haloColor: "#ffffff",
                    haloSize: 2.5,
                    font: { size: 16, weight: "bold" },
                    ...LABEL_SPOTS[i],
                },
            })
        );
    });
    await sleep(400);
    if (token !== revealToken) return;
    zoomToLonLats(mapEl, zoomPts, { minMeters: 20000, factor: 1.6, duration: 1800 });
}

// --- Admin panel ----------------------------------------------------------------------------------

function renderAdmin() {
    $("admin-session").textContent = `Session ${sid} · ${backend.kind}${isAgol ? " (ArcGIS Online)" : " (this browser only)"}`;
    const sel = $("admin-round");
    if (sel.options.length !== rounds.length) {
        sel.replaceChildren(
            ...rounds.map((r) => new Option(`${r.roundOrder}. ${r.name}${r.setName ? ` (${r.setName})` : ""}`, r.roundOrder))
        );
    }
    const rows = state.leaderboard?.rows || [];
    const hidden = new Set(state.leaderboard?.hidden || []);
    $("admin-names").replaceChildren(
        ...(rows.length
            ? rows.map((r) => {
                  const div = document.createElement("div");
                  const isHidden = hidden.has(r[0]);
                  const btn = document.createElement("button");
                  btn.className = "btn small ghost";
                  btn.textContent = isHidden ? "Unhide" : "Hide";
                  btn.addEventListener("click", () => act(() => setHidden(r[0], !isHidden)));
                  div.append(span("", `${r[1]} (${r[2]} pts)`), btn);
                  return div;
              })
            : [span("", "No players on the leaderboard yet.")])
    );
}

async function setHidden(tag, hide) {
    const patch = { leaderboard: setNameHidden(state.leaderboard, tag, hide) };
    if (hide && state.reveal) patch.reveal = hideNameInReveal(state.reveal, tag);
    await write(patch);
    if (hide) toast(`Hidden. Unhiding shows the name again after that player's next round.`, 4000);
}

$("btn-admin").addEventListener("click", openAdmin);
function openAdmin() {
    if (!state) return;
    renderAdmin();
    $("admin").showModal();
}
$("admin-jump").addEventListener("click", () => {
    const lm = roundByNum(Number($("admin-round").value));
    $("admin").close();
    if (lm) act(() => startRound(lm));
});
$("admin-skip").addEventListener("click", () => {
    $("admin").close();
    act(async () => {
        const r = rounds.find((x) => x.roundOrder > (state.roundNum || 0));
        return r ? startRound(r) : write({ phase: "final" });
    });
});
$("admin-time").addEventListener("click", () =>
    act(async () => {
        if (state.phase !== "guessing") throw new Error("the timer only runs while guessing");
        await write({ roundEndsAt: state.roundEndsAt + 15000 });
    })
);
$("admin-lobby").addEventListener("click", () => {
    $("admin").close();
    act(() => write({ phase: "lobby" }));
});
$("admin-new").addEventListener("click", () => {
    const id = $("admin-new-session").value.trim();
    try {
        assertSessionId(id);
    } catch {
        return toast("Session IDs: letters, numbers, - and _ only (use test-… for practice).");
    }
    const url = new URL(location.href);
    url.searchParams.set("session", id);
    location.href = url.href;
});

// --- Keyboard & presentation clicker (brief §3.5) ---------------------------------------------------

window.addEventListener("keydown", (e) => {
    if ($("admin").open || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if ([" ", "ArrowRight", "PageDown", "Enter"].includes(k)) {
        e.preventDefault();
        if (!state) return;
        act(next);
    } else if (k === "l" || k === "L") act(lock);
    else if (k === "r" || k === "R") act(reveal);
    else if (k === "b" || k === "B") act(showLeaderboard);
    else if (k === "a" || k === "A" || k === "`") openAdmin();
    else if (k === "f" || k === "F") toggleFullscreen();
    else if (["ArrowLeft", "PageUp"].includes(k)) e.preventDefault(); // clickers' "back": ignored on purpose
});

$("btn-next").addEventListener("click", () => act(next));
$("btn-lock").addEventListener("click", () => act(lock));
$("btn-reveal").addEventListener("click", () => act(reveal));
$("btn-board").addEventListener("click", () => act(showLeaderboard));

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
}
document.addEventListener("fullscreenchange", () =>
    document.body.classList.toggle("presenting", !!document.fullscreenElement)
);

// --- Toast ------------------------------------------------------------------------------------------
let toastTimer = null;
function toast(message, ms = 8000) {
    const t = $("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
    $("toast").hidden = true;
}

// --- Start ---------------------------------------------------------------------------------------------

async function start() {
    $("start").disabled = true;
    $("setup-error").textContent = "";
    try {
        // AGOL: this triggers the sign-in dialog. Only landmarks with a
        // round_order are played live; the rest are the solo-mode pool.
        const all = await backend.getLandmarks();
        rounds = all.filter((r) => r.roundOrder >= 1);
        if (!rounds.length) {
            throw new Error(
                all.length
                    ? `${all.length} landmarks are loaded, but none has a round_order yet. Set round_order 1, 2, … (and set_name) on the ones to play live.`
                    : "The landmarks layer has no rounds yet."
            );
        }
        state = await backend.getState(sid);
        const resumed = !!state;
        if (!state) state = await backend.createSession(sid, { roundTotal: rounds.length });
        render();
        if (resumed && state.phase !== "lobby") {
            toast(`Resumed session ${sid}: ${state.phase}, round ${state.roundNum}.`, 5000);
        }
        await initMap();
        if (state.phase === "reveal") {
            const lm = roundByNum(state.roundNum);
            if (lm) animateReveal(lm, await backend.listGuesses(sid, state.roundNum));
        }
    } catch (err) {
        console.error(err);
        $("start").disabled = false;
        document.body.dataset.screen = state ? document.body.dataset.screen : "setup";
        const msg =
            err.name === "identity-manager:user-aborted"
                ? "Sign-in was cancelled. Press the button to try again."
                : err.code === "PRODUCTION_WRITE_BLOCKED"
                  ? `${err.message}. For practice, use a session like ?session=test-rehearsal.`
                  : `Couldn't start: ${err.message}`;
        if (state) toast(msg);
        else $("setup-error").textContent = msg;
    }
}

$("setup-detail").textContent = `Session “${sid}” · ${isAgol ? "ArcGIS Online" : "mock backend (this browser only)"}`;
$("start").textContent = isAgol ? "Sign in & start" : "Start";
$("start").addEventListener("click", start);

// Mock needs no sign-in, and a saved AGOL sign-in (after a refresh) needs no
// click either: start right away in both cases.
let hasSavedSignIn = false;
try {
    hasSavedSignIn = !!sessionStorage.getItem(IDM_KEY);
} catch {
    /* ignore */
}
if (!isAgol || hasSavedSignIn) start();
