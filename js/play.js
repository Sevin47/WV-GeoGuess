/* =============================================================================
 * WV GeoGuess — Phone page (play.html)
 * =============================================================================
 * Everything on screen follows the session state the host publishes
 * (js/backend.js watchState). The phone never decides anything:
 *
 *   no name yet            -> join
 *   no session / lobby     -> wait       ("Eyes on the big screen")
 *   guessing               -> guess      (or locked, if already submitted)
 *   locked                 -> locked     (or timesup, if no guess)
 *   reveal                 -> result     (from state.reveal, see js/round.js)
 *   leaderboard            -> standings
 *   final                  -> final
 *
 * URL options: ?session=gisday2026  ?backend=mock|agol
 *              ?poll=always  keep polling in a background tab (testing several
 *                            player tabs in one browser; phones should pause)
 * ========================================================================== */
import { createPlayerBackend, resolveLiveConfig, watchState, siteUrl } from "./backend.js";
import { sdkReady, setupWVMap, makePinSymbol, animatePinDrop, zoomToLonLats } from "./map.js";
import { validateNickname } from "./names.js";
import { playerTag, leaderboardRank } from "./round.js";
import { formatMiles } from "./scoring.js";
import { makeZoomable } from "./zoom.js";

const CONFIG = window.ARCGIGUESS_CONFIG;
const live = resolveLiveConfig(CONFIG.live, location.search);
const sid = live.sessionId;
const backend = createPlayerBackend(live);

const $ = (id) => document.getElementById(id);
const mapEl = $("map");
const PIN_SCALE = 1.4; // big, easy-to-see pin (brief §3.4)

// --- Per-device storage (a refresh rejoins automatically) ---------------------
// localStorage can throw (private mode, blocked storage), so every access is
// wrapped, and guesses are also kept in memory for this page load.
const store = {
    get(key) {
        try {
            return JSON.parse(localStorage.getItem(key));
        } catch {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            /* memory copy still works for this page load */
        }
    },
};
const KEY_PLAYER = "wvgg.player";
const keyGuess = (round) => `wvgg.guess.${sid}.${round}`;
const guessMemory = new Map();

function myGuess(round) {
    return guessMemory.get(round) ?? store.get(keyGuess(round));
}

/** UUID v4. crypto.randomUUID only exists on https/localhost; phones testing
 *  against a LAN IP over plain http need the fallback. */
function newPlayerId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let player = store.get(KEY_PLAYER);
if (!player?.id || !player?.name) player = null;

// --- App state -------------------------------------------------------------------
let state = null; // latest session state from the host
let editingName = false;
let pending = null; // map point tapped but not yet confirmed
let submitting = false;
let sendError = "";
let mapApi = null; // { Graphic, resetView } once the map is ready
let currentRound = null;
let drawnKey = null; // which screen/round the map graphics were drawn for
let screen = "boot";

// --- Rendering ---------------------------------------------------------------------

function screenFor() {
    if (!player || editingName) return "join";
    if (!state) return "wait";
    const guessed = !!myGuess(state.roundNum);
    switch (state.phase) {
        case "guessing":
            return guessed ? "locked" : "guess";
        case "locked":
            return guessed ? "locked" : "timesup";
        case "reveal":
            return state.reveal ? "result" : "locked";
        case "leaderboard":
            return "standings";
        case "final":
            return "final";
        default:
            return "wait";
    }
}

function render() {
    screen = screenFor();
    document.body.dataset.screen = screen;

    if (screen === "join") return renderJoin();
    if (screen === "wait") return renderWait();
    if (screen === "standings") return renderStandings();
    if (screen === "final") return renderFinal();
    renderRound();
}

function renderJoin() {
    const input = $("nickname");
    if (!input.value && player?.name) input.value = player.name;
}

function renderWait() {
    $("wait-name").textContent = player.name;
    $("wait-detail").textContent = !state
        ? "Waiting for the game to open…"
        : state.phase === "lobby"
          ? "You're in! The first round starts soon."
          : "Next round coming up.";
    const me = myStanding();
    $("wait-standing").hidden = !me;
    if (me) setStanding($("wait-standing"), me, "So far: ");
}

function renderRound() {
    // Top bar
    const img = $("photo-thumb-img");
    const src = state.imagePath ? siteUrl(state.imagePath) : "";
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    $("round-label").textContent = [
        state.roundTotal ? `Round ${state.roundNum} of ${state.roundTotal}` : `Round ${state.roundNum}`,
        state.setName,
    ]
        .filter(Boolean)
        .join(" · ");
    $("prompt").textContent = state.promptText || "Where in West Virginia is this?";
    tickCountdown();

    // Bottom bar
    const status = $("status");
    const confirm = $("confirm");
    const result = $("result");
    result.hidden = screen !== "result";

    if (screen === "guess") {
        confirm.disabled = !pending || submitting || !mapApi;
        confirm.textContent = submitting
            ? "Sending…"
            : pending
              ? "Confirm guess"
              : mapApi
                ? "Tap the map to place your pin"
                : "Loading map…";
        status.textContent = sendError || (secondsLeft() === 0 ? "Time's up! Locking…" : "");
    } else if (screen === "locked") {
        status.textContent = "✓ Locked in — watch the big screen for the answer";
    } else if (screen === "timesup") {
        status.textContent = "⏱ Time's up — no guess this round";
    } else if (screen === "result") {
        status.textContent = "";
        renderResult(result);
    }

    updateMapPadding();
    drawMapForScreen();
}

function renderResult(el) {
    const r = state.reveal;
    const tag = playerTag(player.id);
    const mine = r.results?.[tag];
    const guessed = !!myGuess(state.roundNum);
    const overall = leaderboardRank(state.leaderboard, tag);

    let headline;
    let line = "";
    if (mine) {
        const [points, miles, rank] = mine;
        headline = miles === 0 ? "🎯 Nailed it!" : `${formatMiles(miles)} mi away`;
        line = [`+${points.toLocaleString()} pts`, `#${rank} this round`, overall && `#${overall} overall`]
            .filter(Boolean)
            .join(" · ");
    } else if (guessed) {
        headline = "Your guess didn't count";
        line = "It reached the game after the round locked.";
    } else {
        headline = "No guess this round";
        line = overall ? `#${overall} overall` : "";
    }

    el.replaceChildren(
        div("headline", headline),
        div("line", line),
        div("answer", `📍 ${r.answer?.name ?? "—"}`),
        ...(r.answer?.funFact ? [div("fact", r.answer.funFact)] : [])
    );
}

function renderStandings() {
    const board = state.leaderboard;
    $("standings-title").textContent = board?.afterRound
        ? `Standings after round ${board.afterRound}`
        : "Standings";
    const me = myStanding();
    if (me) setStanding($("standings-me"), me, "You're ");
    else $("standings-me").textContent = "You haven't scored yet — jump in next round!";
    fillTopList($("standings-top"), board, 5);
}

function renderFinal() {
    const board = state.leaderboard;
    const champ = board?.rows?.[0];
    $("final-champion").replaceChildren(
        ...(champ
            ? [document.createTextNode("Champion"), strong(champ[1]), document.createTextNode(`${champ[2].toLocaleString()} pts`)]
            : [])
    );
    const me = myStanding();
    if (me) setStanding($("final-me"), me, "You finished ");
    else $("final-me").textContent = "Thanks for joining!";
    fillTopList($("final-top"), board, 10);
}

function myStanding() {
    const board = state?.leaderboard;
    const tag = player && playerTag(player.id);
    const row = board?.rows?.find((r) => r[0] === tag);
    if (!row) return null;
    return { rank: leaderboardRank(board, tag), of: board.rows.length, points: row[2] };
}

function setStanding(el, me, prefix) {
    el.replaceChildren(
        document.createTextNode(prefix),
        strong(`#${me.rank}`),
        document.createTextNode(` of ${me.of} · ${me.points.toLocaleString()} pts`)
    );
}

function fillTopList(ol, board, n) {
    const tag = player && playerTag(player.id);
    ol.replaceChildren(
        ...(board?.rows || []).slice(0, n).map((r, i) => {
            const li = document.createElement("li");
            if (r[0] === tag) li.className = "me";
            const name = document.createElement("span");
            name.className = "name";
            name.textContent = `${i + 1}. ${r[1]}`;
            const pts = document.createElement("span");
            pts.textContent = `${r[2].toLocaleString()} pts`;
            li.append(name, pts);
            return li;
        })
    );
}

// Small DOM helpers (textContent only: nicknames are player-supplied).
function div(className, text) {
    const d = document.createElement("div");
    d.className = className;
    d.textContent = text;
    return d;
}
function strong(text) {
    const s = document.createElement("strong");
    s.textContent = text;
    return s;
}

// --- Countdown ---------------------------------------------------------------------
// Drawn from the host's roundEndsAt using this phone's clock. It's display
// only: the host decides when the round locks and which guesses count, so
// Confirm stays available until the phase actually changes.

function secondsLeft() {
    if (state?.phase !== "guessing" || !state.roundEndsAt) return null;
    return Math.max(0, Math.ceil((state.roundEndsAt - Date.now()) / 1000));
}

function tickCountdown() {
    const s = secondsLeft();
    const el = $("countdown");
    el.textContent = s == null ? "" : String(s);
    el.classList.toggle("hurry", s != null && s <= 10);
    if (screen === "guess" && s === 0 && !sendError && !$("status").textContent) {
        $("status").textContent = "Time's up! Locking…";
    }
}
setInterval(tickCountdown, 250);

// --- Map -----------------------------------------------------------------------------

async function initMap() {
    document.body.classList.add("map-pending");
    await sdkReady();
    const [Graphic] = await $arcgis.import(["@arcgis/core/Graphic.js"]);
    const { resetView } = await setupWVMap(mapEl, CONFIG.map);
    mapApi = { Graphic, resetView };
    document.body.classList.remove("map-pending");
    $("map-loading").hidden = true;

    mapEl.addEventListener("arcgisViewClick", (e) => {
        if (screen !== "guess" || submitting) return;
        pending = e.detail.mapPoint;
        sendError = "";
        drawMine({ longitude: pending.longitude, latitude: pending.latitude }, true);
        render();
    });
    render();
}

function updateMapPadding() {
    if (!mapEl.view) return;
    mapEl.view.padding = {
        top: $("topbar").offsetHeight,
        bottom: $("bottombar").offsetHeight,
        left: 0,
        right: 0,
    };
}

function removeGraphics(kind) {
    const doomed = mapEl.graphics.filter((g) => g.attributes?.kind === kind);
    mapEl.graphics.removeMany(doomed);
}

function drawMine({ longitude, latitude }, animate = false) {
    if (!mapApi) return null;
    removeGraphics("mine");
    const pin = new mapApi.Graphic({
        geometry: { type: "point", longitude, latitude },
        symbol: makePinSymbol(undefined, { scale: PIN_SCALE }),
        attributes: { kind: "mine" },
    });
    mapEl.graphics.add(pin);
    if (animate) animatePinDrop(pin, { scale: PIN_SCALE });
    return pin;
}

function drawMapForScreen() {
    if (!mapApi) return;
    const key = `${screen}:${state?.roundNum}`;
    if (key === drawnKey) return;
    drawnKey = key;

    const g = myGuess(state.roundNum);
    if (screen === "guess") {
        if (!pending) removeGraphics("mine");
        return;
    }
    if (screen === "locked" && g) drawMine({ longitude: g.lon, latitude: g.lat });
    if (screen === "result") drawReveal(g);
}

function drawReveal(g) {
    const a = state.reveal?.answer;
    if (!a) return;
    removeGraphics("answer");
    const answer = new mapApi.Graphic({
        geometry: { type: "point", longitude: a.lon, latitude: a.lat },
        symbol: { type: "picture-marker", url: siteUrl("assets/answer.svg"), width: 36, height: 36 },
        attributes: { kind: "answer" },
    });
    if (g) {
        drawMine({ longitude: g.lon, latitude: g.lat });
        mapEl.graphics.add(
            new mapApi.Graphic({
                geometry: {
                    type: "polyline",
                    paths: [[[g.lon, g.lat], [a.lon, a.lat]]],
                    spatialReference: { wkid: 4326 },
                },
                symbol: { type: "simple-line", color: [17, 24, 39, 0.85], width: 2.5, style: "dash" },
                attributes: { kind: "answer" },
            })
        );
    }
    mapEl.graphics.add(answer);
    zoomToLonLats(mapEl, g ? [a, g] : [a]);
}

function onNewRound() {
    pending = null;
    sendError = "";
    drawnKey = null;
    if (mapApi) {
        removeGraphics("mine");
        removeGraphics("answer");
        mapApi.resetView({ animate: true });
    }
    // Warm the photo so it's instant when the round opens.
    if (state?.imagePath) new Image().src = siteUrl(state.imagePath);
}

// --- Actions -------------------------------------------------------------------------

$("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const check = validateNickname($("nickname").value);
    $("join-error").textContent = check.ok ? "" : check.error;
    if (!check.ok) return;
    player = { id: player?.id || newPlayerId(), name: check.name };
    store.set(KEY_PLAYER, player);
    editingName = false;
    $("nickname").blur();
    render();
});

$("change-name").addEventListener("click", () => {
    editingName = true;
    render();
    $("nickname").focus();
});

$("confirm").addEventListener("click", async () => {
    if (!pending || submitting || state?.phase !== "guessing") return;
    const round = state.roundNum;
    const lon = pending.longitude;
    const lat = pending.latitude;
    submitting = true;
    sendError = "";
    render();
    try {
        await backend.submitGuess({ sessionId: sid, roundNum: round, playerId: player.id, nickname: player.name, lon, lat });
        const guess = { lon, lat, at: Date.now() };
        guessMemory.set(round, guess);
        store.set(keyGuess(round), guess);
        pending = null;
    } catch (err) {
        console.error("Guess failed", err);
        sendError = "Couldn't send your guess. Tap Confirm to try again.";
    } finally {
        submitting = false;
        render();
    }
});

const zoom = makeZoomable($("zoom-stage"), $("photo-full-img"));
$("photo-thumb").addEventListener("click", () => {
    const img = $("photo-full-img");
    const src = $("photo-thumb-img").src;
    $("photo-full").showModal();
    if (img.src !== src) img.src = src; // fits itself on load
    else zoom.fit();
});
$("zoom-in").addEventListener("click", () => zoom.zoomIn());
$("zoom-out").addEventListener("click", () => zoom.zoomOut());
$("zoom-fit").addEventListener("click", () => zoom.reset());
$("photo-close").addEventListener("click", () => $("photo-full").close());

// --- Start -------------------------------------------------------------------------

watchState(
    backend,
    sid,
    (s) => {
        const round = s?.phase === "guessing" || s?.phase === "locked" ? s.roundNum : currentRound;
        state = s;
        if (round !== currentRound) {
            currentRound = round;
            onNewRound();
        }
        render();
    },
    {
        intervals: CONFIG.live.polling,
        jitter: CONFIG.live.polling.jitter,
        ...(new URLSearchParams(location.search).get("poll") === "always" ? { document: null } : {}),
        onSuccess: () => ($("net-banner").hidden = true),
        onError: (err) => {
            console.warn("State poll failed", err);
            $("net-banner").hidden = false;
        },
    }
);

render();
initMap().catch((err) => {
    console.error("Map failed to load", err);
    $("map-loading").textContent = "The map couldn't load. Check your connection and reload.";
});
