#!/usr/bin/env node
/* =============================================================================
 * WV GeoGuess — Load test: N simulated phones (brief §4 Phase 6)
 * =============================================================================
 * Each bot behaves like play.html: polls the public state (same js/backend.js
 * code path, same jittered intervals and cache-busting), and submits one guess
 * per round at a random moment while the round is open. The script reports:
 *
 *   - poll latency (p50/p95/max) and requests per second
 *   - propagation: how long after the host wrote a new phase each bot saw it
 *   - errors by kind (HTTP 429 = rate limited), guess failures
 *
 * AGOL run (you drive the real host):
 *   1. node tools/bots.mjs --session test-load-1 --bots 200
 *   2. Open host.html?backend=agol&session=test-load-1, sign in, play a few
 *      rounds as usual. The bots join, guess, and follow along.
 *   3. Ctrl+C (or reach the final screen) for the summary. A JSON report is
 *      written to work/loadtest-<time>.json.
 *   Run it on the same PC as the host: propagation compares the host's
 *   updatedAt with this machine's clock.
 *
 * Self-test without AGOL (simulated host in this process):
 *   node tools/bots.mjs --backend mock --self-host --bots 50 --round-seconds 15
 *
 * Only test-* sessions are allowed: bots write real guess rows.
 * ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { createPlayerBackend, createHostBackend, resolveLiveConfig } from "../js/backend.js";
import { scoreRound } from "../js/round.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Options ------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? true : v;
};
const BOTS = Number(opt("bots", 200));
const SESSION = String(opt("session", "test-load-1"));
const BACKEND = String(opt("backend", "agol"));
const RAMP_S = Number(opt("ramp", 60)); // bots join over this many seconds, like people scanning a QR code
const DURATION_S = Number(opt("duration", 3600));
const LATE = Number(opt("late", 0.03)); // share of bots that deliberately guess just after the lock
const SELF_HOST = !!opt("self-host", false);
const ROUND_S = Number(opt("round-seconds", 20)); // self-host only

if (!/^test-/.test(SESSION)) {
    console.error(`Refusing to run against "${SESSION}": bots write real guesses, so use a test-* session.`);
    process.exit(1);
}
if (SELF_HOST && BACKEND !== "mock") {
    console.error("--self-host only works with --backend mock (the AGOL host needs your sign-in: use host.html).");
    process.exit(1);
}

// config.js is a browser script that sets window.ARCGIGUESS_CONFIG.
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(join(ROOT, "config.js"), "utf8"), sandbox);
const CONFIG = sandbox.window.ARCGIGUESS_CONFIG;
const live = { ...resolveLiveConfig(CONFIG.live, `?backend=${BACKEND}&session=${SESSION}`) };
if (BACKEND === "mock") live.mock = { ...live.mock, latencyMs: [20, 120] };

// Mock: one shared in-memory store for the whole process (bots + simulated host).
function memoryStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => void m.set(k, String(v)),
        removeItem: (k) => void m.delete(k),
        key: (i) => [...m.keys()][i] ?? null,
        get length() {
            return m.size;
        },
    };
}
const sharedStorage = memoryStorage();
const deps = BACKEND === "mock" ? { storage: sharedStorage } : {};

// --- Random guess locations inside WV ------------------------------------------------
const wv = JSON.parse(readFileSync(join(ROOT, "data/wv-boundary.geojson"), "utf8"));
const rings = wv.features.flatMap((f) =>
    f.geometry.type === "Polygon" ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0])
);
const inWV = (lon, lat) => {
    let inside = false;
    for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const [xi, yi] = r[i];
            const [xj, yj] = r[j];
            if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
    }
    return inside;
};
function randomWVPoint() {
    for (;;) {
        const lon = -82.64 + Math.random() * 4.92;
        const lat = 37.2 + Math.random() * 3.44;
        if (inWV(lon, lat)) return { lon, lat };
    }
}

// --- Metrics --------------------------------------------------------------------------
const stats = {
    polls: 0,
    pollLatency: [],
    errors: {}, // kind -> count
    guessesSent: 0,
    guessesFailed: 0,
    guessLatency: [],
    lateSent: 0,
    phaseSeen: new Map(), // "round:phase:updatedAt" -> { wroteAt, delays: [] }
    started: Date.now(),
};
let windowPolls = 0;

function pct(arr, p) {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
const ms = (v) => (v == null ? "—" : `${Math.round(v)} ms`);
const secs = (v) => (v == null ? "—" : `${(v / 1000).toFixed(1)} s`);
function recordError(err) {
    const kind = err?.code === "HTTP" ? err.message.replace(/ from .*/, "") : err?.code ?? err?.name ?? "error";
    stats.errors[kind] = (stats.errors[kind] || 0) + 1;
}

// --- A bot ----------------------------------------------------------------------------
const intervals = CONFIG.live.polling;
const jitter = intervals.jitter ?? 0.25;
const sleep = (t) => new Promise((r) => setTimeout(r, t));
let stopping = false;

async function runBot(n) {
    const backend = createPlayerBackend(live, deps);
    const playerId = crypto.randomUUID();
    const nickname = `Bot ${String(n).padStart(3, "0")}`;
    const late = Math.random() < LATE;
    let lastUpdated = null;
    let guessedRound = null;
    let phase = null;

    while (!stopping) {
        const t0 = performance.now();
        let state = null;
        try {
            state = await backend.getState(SESSION);
            stats.polls++;
            windowPolls++;
            stats.pollLatency.push(performance.now() - t0);
        } catch (err) {
            recordError(err);
        }
        if (state && state.updatedAt !== lastUpdated) {
            lastUpdated = state.updatedAt;
            phase = state.phase;
            const key = `${state.roundNum}:${state.phase}:${state.updatedAt}`;
            if (!stats.phaseSeen.has(key)) stats.phaseSeen.set(key, { round: state.roundNum, phase: state.phase, wroteAt: state.updatedAt, delays: [] });
            stats.phaseSeen.get(key).delays.push(Date.now() - state.updatedAt);

            if (state.phase === "guessing" && guessedRound !== state.roundNum) {
                guessedRound = state.roundNum;
                scheduleGuess(backend, state, playerId, nickname, late);
            }
            if (state.phase === "final") return backend.close();
        }
        const base = intervals[phase] ?? intervals.default;
        await sleep(base * (1 + jitter * (2 * Math.random() - 1)));
    }
    backend.close();
}

function scheduleGuess(backend, state, playerId, nickname, late) {
    const left = state.roundEndsAt - Date.now();
    // Most people guess somewhere in the middle of the round; a few just miss it.
    const at = late ? left + 1000 + Math.random() * 3000 : Math.max(500, Math.min(left - 1500, 3000 + Math.random() * (left - 5000)));
    setTimeout(async () => {
        if (stopping) return;
        const { lon, lat } = randomWVPoint();
        const t0 = performance.now();
        try {
            await backend.submitGuess({ sessionId: SESSION, roundNum: state.roundNum, playerId, nickname, lon, lat });
            stats.guessesSent++;
            if (late) stats.lateSent++;
            stats.guessLatency.push(performance.now() - t0);
        } catch (err) {
            stats.guessesFailed++;
            recordError(err);
        }
    }, Math.max(0, at));
}

// --- Simulated host (mock self-test only) ------------------------------------------------
async function selfHost() {
    const host = createHostBackend(live, { ...deps, landmarks: JSON.parse(readFileSync(join(ROOT, "data/mock/landmarks.geojson"), "utf8")) });
    await host.resetSession?.(SESSION);
    let state = await host.createSession(SESSION, { roundTotal: 2 });
    const landmarks = (await host.getLandmarks()).slice(0, 2);
    await sleep(Math.min(RAMP_S, 10) * 1000 + 2000);
    const toRad = (d) => (d * Math.PI) / 180;
    const miles = (a, b) => {
        const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
        return 7917.6 * Math.asin(Math.sqrt(h));
    };
    for (const lm of landmarks) {
        state = await host.updateState(SESSION, { phase: "guessing", roundNum: lm.roundOrder, roundEndsAt: Date.now() + ROUND_S * 1000, reveal: null });
        await sleep(ROUND_S * 1000);
        state = await host.updateState(SESSION, { phase: "locked", roundEndsAt: Math.min(state.roundEndsAt, Date.now()) });
        await sleep(4000); // let late bots try
        const ring = lm.geometry.rings[0];
        const center = { lon: ring.reduce((s, p) => s + p[0], 0) / ring.length, lat: ring.reduce((s, p) => s + p[1], 0) / ring.length };
        const { reveal, leaderboard } = scoreRound({
            roundNum: lm.roundOrder,
            landmark: lm,
            guesses: await host.listGuesses(SESSION, lm.roundOrder),
            lockTime: state.roundEndsAt,
            prevBoard: state.leaderboard,
            scoreGuess: (_l, g) => {
                const mi = miles(g, center);
                return { points: Math.round(1000 * Math.exp(-mi / 25)), miles: mi };
            },
        });
        state = await host.updateState(SESSION, { phase: "reveal", reveal, leaderboard });
        console.log(`  [self-host] round ${lm.roundOrder}: ${reveal.count} guesses counted, ${leaderboard.rows.length} players on the board`);
        await sleep(5000);
    }
    await host.updateState(SESSION, { phase: "final" });
    host.close();
}

// --- Reporting -----------------------------------------------------------------------------
function phaseReport() {
    return [...stats.phaseSeen.values()]
        .filter((p) => p.wroteAt)
        .map((p) => ({
            round: p.round,
            phase: p.phase,
            botsSaw: p.delays.length,
            p50: pct(p.delays, 50),
            p95: pct(p.delays, 95),
            max: pct(p.delays, 100),
        }));
}

const ticker = setInterval(() => {
    const secsRun = Math.round((Date.now() - stats.started) / 1000);
    const errs = Object.entries(stats.errors).map(([k, v]) => `${k}:${v}`).join(" ") || "none";
    const recent = stats.pollLatency.slice(-500);
    console.log(
        `[${String(secsRun).padStart(4)}s] ${(windowPolls / 5).toFixed(1)} polls/s · poll p50 ${ms(pct(recent, 50))} p95 ${ms(pct(recent, 95))} · ` +
            `guesses ${stats.guessesSent} sent / ${stats.guessesFailed} failed · errors ${errs}`
    );
    windowPolls = 0;
}, 5000);

let finished = false;
function finish(reason) {
    if (finished) return;
    finished = true;
    stopping = true;
    clearInterval(ticker);
    const report = {
        reason,
        session: SESSION,
        backend: BACKEND,
        bots: BOTS,
        seconds: Math.round((Date.now() - stats.started) / 1000),
        polls: stats.polls,
        pollsPerSecond: +(stats.polls / ((Date.now() - stats.started) / 1000)).toFixed(1),
        pollLatencyMs: { p50: pct(stats.pollLatency, 50), p95: pct(stats.pollLatency, 95), max: pct(stats.pollLatency, 100) },
        guesses: { sent: stats.guessesSent, failed: stats.guessesFailed, deliberatelyLate: stats.lateSent },
        guessLatencyMs: { p50: pct(stats.guessLatency, 50), p95: pct(stats.guessLatency, 95), max: pct(stats.guessLatency, 100) },
        errors: stats.errors,
        propagation: phaseReport(),
    };
    console.log(`\n=== Load test summary (${reason}) ===`);
    console.log(`${BOTS} bots · ${report.seconds}s · ${report.polls} polls (${report.pollsPerSecond}/s)`);
    console.log(`Poll latency: p50 ${ms(report.pollLatencyMs.p50)} · p95 ${ms(report.pollLatencyMs.p95)} · max ${ms(report.pollLatencyMs.max)}`);
    console.log(`Guesses: ${report.guesses.sent} sent (${report.guesses.deliberatelyLate} deliberately late), ${report.guesses.failed} failed · p95 ${ms(report.guessLatencyMs.p95)}`);
    console.log(`Errors: ${JSON.stringify(report.errors)}`);
    console.log("How fast bots saw each host change (host write -> bot sees it):");
    for (const p of report.propagation) {
        console.log(`  round ${p.round} ${p.phase.padEnd(11)} ${String(p.botsSaw).padStart(3)} bots · p50 ${secs(p.p50)} · p95 ${secs(p.p95)} · max ${secs(p.max)}`);
    }
    try {
        mkdirSync(join(ROOT, "work"), { recursive: true });
        const file = join(ROOT, "work", `loadtest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        writeFileSync(file, JSON.stringify(report, null, 1));
        console.log(`Report: ${file}`);
    } catch (err) {
        console.warn("Couldn't write the report:", err.message);
    }
    setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", () => finish("stopped"));
setTimeout(() => finish("duration reached"), DURATION_S * 1000);

// --- Go --------------------------------------------------------------------------------------
console.log(`Load test: ${BOTS} bots → session "${SESSION}" (${BACKEND}), joining over ${RAMP_S}s. Ctrl+C for the summary.`);
if (BACKEND === "agol") console.log(`Now open host.html?backend=agol&session=${SESSION} and play as usual.`);
const bots = [];
for (let i = 1; i <= BOTS; i++) {
    bots.push(sleep((RAMP_S * 1000 * (i - 1)) / BOTS).then(() => runBot(i)));
}
if (SELF_HOST) selfHost().catch((err) => console.error("self-host failed:", err));
Promise.all(bots).then(() => finish("every bot reached the final screen"));
