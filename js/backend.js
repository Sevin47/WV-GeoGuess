/* =============================================================================
 * WV GeoGuess — Backend adapters
 * =============================================================================
 * One interface, two implementations:
 *   mock — localStorage + BroadcastChannel. host.html and play.html can run in
 *          two tabs of the same browser with no ArcGIS Online layers at all.
 *   agol — the real hosted layers over the ArcGIS REST API (brief §3.1).
 *
 * The interface is split by ROLE, mirroring the AGOL permissions, so play.html
 * can't accidentally depend on something players won't be allowed to do:
 *
 *   Player (public views):  getState, submitGuess, onHint, close
 *   Host   (owner):         getState, createSession, updateState,
 *                           listGuesses, countGuesses, getLandmarks,
 *                           onHint, close
 *
 * Everything that crosses the interface is a plain JS object in camelCase;
 * the snake_case field names live only in the maps below. Geometries come
 * back as lon/lat (guesses) or Esri JSON polygons in WGS84 (landmarks).
 *
 * No SDK imports: this file runs in Node for tests (tests/backend.test.mjs).
 * ========================================================================== */

// --- Field maps (JS name -> hosted layer field name) -------------------------

export const STATE_FIELDS = {
    sessionId: "session_id",
    phase: "phase",
    roundNum: "round_num",
    roundTotal: "round_total",
    setName: "set_name",
    imagePath: "image_path",
    promptText: "prompt_text",
    roundEndsAt: "round_ends_at",
    reveal: "reveal_json",
    leaderboard: "leaderboard_json",
    updatedAt: "updated_at",
};
const STATE_JSON_KEYS = new Set(["reveal", "leaderboard"]);

export const GUESS_FIELDS = {
    sessionId: "session_id",
    roundNum: "round_num",
    playerId: "player_id",
    nickname: "nickname",
    clientTs: "client_ts",
};

export const LANDMARK_FIELDS = {
    landmarkId: "landmark_id",
    name: "name",
    promptText: "prompt_text",
    setName: "set_name",
    roundOrder: "round_order",
    imagePath: "image_path",
    funFact: "fun_fact",
    credit: "credit",
};

export const PHASES = ["lobby", "guessing", "locked", "reveal", "leaderboard", "final"];
export const NICKNAME_MAX = 24; // matches the guesses layer's nickname field length

/**
 * Resolve a site-relative path from config (e.g. "data/x.json") against the
 * site root rather than the current page, so pages in subfolders (tools/)
 * load the same files. The site root is the parent of this js/ folder.
 */
export function siteUrl(path) {
    return new URL(path, new URL("../", import.meta.url)).href;
}

export class BackendError extends Error {
    constructor(message, { code, details } = {}) {
        super(message);
        this.name = "BackendError";
        this.code = code;
        this.details = details;
    }
}

// --- Validation & conversion helpers -----------------------------------------

// Session IDs end up inside SQL where clauses, so keep them to a safe alphabet.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function assertSessionId(sessionId) {
    if (!SESSION_ID_RE.test(sessionId || "")) {
        throw new BackendError(`Invalid session ID "${sessionId}"`, { code: "BAD_SESSION_ID" });
    }
}

export function isTestSession(sessionId) {
    return /^test-/.test(sessionId);
}

function assertRoundNum(roundNum) {
    if (!Number.isInteger(roundNum) || roundNum < 0) {
        throw new BackendError(`Invalid round number "${roundNum}"`, { code: "BAD_ROUND" });
    }
}

/** JS state (or partial state) -> layer attributes. Enforces the JSON field length. */
export function stateToAttributes(state, { jsonFieldLength }) {
    const attrs = {};
    for (const [key, field] of Object.entries(STATE_FIELDS)) {
        if (!(key in state)) continue;
        let value = state[key];
        if (STATE_JSON_KEYS.has(key) && value != null) {
            value = JSON.stringify(value);
            if (value.length > jsonFieldLength) {
                throw new BackendError(
                    `${field} is ${value.length} chars; the field holds ${jsonFieldLength}`,
                    { code: "JSON_TOO_LONG" }
                );
            }
        }
        attrs[field] = value ?? null;
    }
    return attrs;
}

/** Layer attributes -> JS state. */
export function attributesToState(attrs) {
    const state = {};
    for (const [key, field] of Object.entries(STATE_FIELDS)) {
        let value = attrs[field] ?? null;
        if (STATE_JSON_KEYS.has(key) && typeof value === "string" && value) {
            value = JSON.parse(value);
        }
        state[key] = value;
    }
    return state;
}

const EARTH_RADIUS = 6378137;

/** WGS84 lon/lat -> Web Mercator (wkid 102100/3857) x/y in meters. */
export function lonLatToWebMercator(lon, lat) {
    const x = (EARTH_RADIUS * lon * Math.PI) / 180;
    const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    return { x, y };
}

function cleanNickname(nickname) {
    return String(nickname || "").trim().slice(0, NICKNAME_MAX);
}

function mapAttributes(attrs, fieldMap) {
    const out = {};
    for (const [key, field] of Object.entries(fieldMap)) out[key] = attrs[field] ?? null;
    return out;
}

/**
 * Make a GeoJSON Polygon/MultiPolygon into an Esri JSON polygon in WGS84.
 * Esri treats clockwise rings as outer rings and counter-clockwise as holes,
 * while GeoJSON (RFC 7946) is the opposite, so outer rings are reversed.
 */
export function geoJsonToEsriPolygon(geometry) {
    const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const rings = [];
    for (const poly of polys) {
        poly.forEach((ring, i) => {
            const clockwise = signedArea(ring) < 0;
            const wantClockwise = i === 0; // outer ring first, then holes
            rings.push(clockwise === wantClockwise ? ring : ring.slice().reverse());
        });
    }
    return { rings, spatialReference: { wkid: 4326 } };
}

function signedArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return sum / 2; // > 0 = counter-clockwise
}

// --- Factory -------------------------------------------------------------------

/**
 * Pick the adapter named by CONFIG.live, with ?backend= and ?session= URL
 * overrides for development. Returns a copy; never mutates config.
 */
export function resolveLiveConfig(live, search = "") {
    const params = new URLSearchParams(search);
    const backend = params.get("backend") || live.backend;
    const sessionId = params.get("session") || live.defaultSessionId;
    return { ...live, backend, sessionId };
}

export function createPlayerBackend(live, deps = {}) {
    return createBackend("player", live, deps);
}

export function createHostBackend(live, deps = {}) {
    return createBackend("host", live, deps);
}

function createBackend(role, live, deps) {
    if (live.backend === "mock") return createMockBackend(role, live, deps);
    if (live.backend === "agol") return createAgolBackend(role, live, deps);
    throw new BackendError(`Unknown backend "${live.backend}"`, { code: "BAD_BACKEND" });
}

// =============================================================================
// mock
// =============================================================================
// Shared store: localStorage (same-origin tabs see the same data, and it
// survives a host refresh, so recovery can be tested). Change hints go over a
// BroadcastChannel so other tabs refresh immediately instead of waiting for
// their next poll. If localStorage is unavailable (private mode, Node), it
// falls back to memory and only works within one tab.
//
// It imitates the server where it matters: guesses get a "server"
// CreationDate at insert time, players can't read guesses, and JSON fields
// hit the same length limit as the real ones.

const MOCK_PREFIX = "wvgg.mock.";

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

function browserStorage() {
    try {
        const s = globalThis.localStorage;
        s.setItem("wvgg.probe", "1");
        s.removeItem("wvgg.probe");
        return s;
    } catch {
        return null;
    }
}

function createMockBackend(role, live, deps) {
    const mock = live.mock || {};
    const storage = deps.storage || browserStorage() || memoryStorage();
    const now = deps.now || Date.now;
    const [minLat, maxLat] = mock.latencyMs || [0, 0];
    const jsonFieldLength = live.jsonFieldLength;

    const channel =
        typeof BroadcastChannel !== "undefined"
            ? new BroadcastChannel(mock.channelName || "wvgg-mock")
            : null;
    const hintListeners = new Set();
    if (channel) {
        channel.onmessage = (e) => hintListeners.forEach((fn) => fn(e.data));
    }

    function hint(sessionId, what) {
        const msg = { sessionId, what };
        channel?.postMessage(msg); // other tabs
        hintListeners.forEach((fn) => fn(msg)); // this tab
    }

    function delay() {
        const ms = minLat + Math.random() * (maxLat - minLat);
        return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
    }

    const stateKey = (sid) => `${MOCK_PREFIX}state.${sid}`;
    const guessPrefix = (sid, round) => `${MOCK_PREFIX}guess.${sid}.${round}.`;

    function readAttrs(sessionId) {
        const raw = storage.getItem(stateKey(sessionId));
        return raw ? JSON.parse(raw) : null;
    }

    function guessKeys(prefix) {
        const keys = [];
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k && k.startsWith(prefix)) keys.push(k);
        }
        return keys;
    }

    const common = {
        kind: "mock",

        async getState(sessionId) {
            assertSessionId(sessionId);
            await delay();
            const attrs = readAttrs(sessionId);
            return attrs ? attributesToState(attrs) : null;
        },

        onHint(sessionId, fn) {
            const listener = (msg) => {
                if (msg && msg.sessionId === sessionId) fn(msg.what);
            };
            hintListeners.add(listener);
            return () => hintListeners.delete(listener);
        },

        close() {
            hintListeners.clear();
            channel?.close();
        },
    };

    if (role === "player") {
        return {
            ...common,
            async submitGuess({ sessionId, roundNum, playerId, nickname, lon, lat }) {
                assertSessionId(sessionId);
                assertRoundNum(roundNum);
                await delay();
                // Server time is taken on arrival, like CreationDate.
                const objectId = Math.floor(Math.random() * 2 ** 31);
                const record = {
                    objectId,
                    attributes: {
                        session_id: sessionId,
                        round_num: roundNum,
                        player_id: playerId,
                        nickname: cleanNickname(nickname),
                        client_ts: now(),
                        CreationDate: now(),
                    },
                    lon,
                    lat,
                };
                storage.setItem(guessPrefix(sessionId, roundNum) + objectId, JSON.stringify(record));
                hint(sessionId, "guess");
                return { objectId };
            },
        };
    }

    return {
        ...common,

        async createSession(sessionId, initial = {}) {
            assertSessionId(sessionId);
            await delay();
            if (readAttrs(sessionId)) {
                throw new BackendError(`Session "${sessionId}" already exists`, { code: "SESSION_EXISTS" });
            }
            const state = { phase: "lobby", roundNum: 0, ...initial, sessionId, updatedAt: now() };
            const attrs = stateToAttributes(state, { jsonFieldLength });
            storage.setItem(stateKey(sessionId), JSON.stringify(attrs));
            hint(sessionId, "state");
            return attributesToState(attrs);
        },

        async updateState(sessionId, patch) {
            assertSessionId(sessionId);
            await delay();
            const attrs = readAttrs(sessionId);
            if (!attrs) throw new BackendError(`No session "${sessionId}"`, { code: "NO_SESSION" });
            const { sessionId: _ignored, ...rest } = patch;
            Object.assign(attrs, stateToAttributes({ ...rest, updatedAt: now() }, { jsonFieldLength }));
            storage.setItem(stateKey(sessionId), JSON.stringify(attrs));
            hint(sessionId, "state");
            return attributesToState(attrs);
        },

        async listGuesses(sessionId, roundNum) {
            assertSessionId(sessionId);
            assertRoundNum(roundNum);
            await delay();
            return guessKeys(guessPrefix(sessionId, roundNum))
                .map((k) => JSON.parse(storage.getItem(k)))
                .map((r) => ({
                    objectId: r.objectId,
                    ...mapAttributes(r.attributes, GUESS_FIELDS),
                    createdAt: r.attributes.CreationDate,
                    lon: r.lon,
                    lat: r.lat,
                }))
                .sort((a, b) => a.createdAt - b.createdAt);
        },

        async countGuesses(sessionId, roundNum) {
            assertSessionId(sessionId);
            assertRoundNum(roundNum);
            await delay();
            return guessKeys(guessPrefix(sessionId, roundNum)).length;
        },

        async getLandmarks() {
            await delay();
            const geojson = deps.landmarks || (await fetchJson(deps.fetch, siteUrl(mock.landmarksUrl)));
            return geojson.features
                .map((f) => ({
                    ...mapAttributes(f.properties, LANDMARK_FIELDS),
                    geometry: geoJsonToEsriPolygon(f.geometry),
                }))
                .sort((a, b) => a.roundOrder - b.roundOrder);
        },

        /** Mock only: delete a session's state and guesses. */
        async resetSession(sessionId) {
            assertSessionId(sessionId);
            storage.removeItem(stateKey(sessionId));
            guessKeys(`${MOCK_PREFIX}guess.${sessionId}.`).forEach((k) => storage.removeItem(k));
            hint(sessionId, "state");
        },
    };
}

async function fetchJson(fetchFn = globalThis.fetch, url) {
    const res = await fetchFn(url);
    if (!res.ok) throw new BackendError(`HTTP ${res.status} loading ${url}`, { code: "HTTP" });
    return res.json();
}

// =============================================================================
// agol
// =============================================================================
// Plain REST calls (no SDK), so play.html doesn't need SDK modules to talk to
// the backend. The host passes `getToken` (from the SDK's IdentityManager
// after sign-in); players never send a token.
//
// Notes verified against the REST docs (2026-09-24):
//   - addFeatures/updateFeatures are POST, return {addResults|updateResults:
//     [{objectId, success, error}]}, and have NO inSR parameter — geometry
//     must already be in the layer's SR (see agol.guessLayerWkid).
//   - Errors come back as HTTP 200 with {error: {code, message}}.

function createAgolBackend(role, live, deps) {
    const agol = live.agol || {};
    const fetchFn = deps.fetch || globalThis.fetch.bind(globalThis);
    const getToken = deps.getToken || (async () => null);
    const now = deps.now || Date.now;
    const jsonFieldLength = live.jsonFieldLength;
    const createdField = agol.createdField || "CreationDate";

    async function request(url, params, { method = "GET", auth = false } = {}) {
        if (!url) throw new BackendError("Layer URL not configured (CONFIG.live.agol)", { code: "NO_URL" });
        const p = new URLSearchParams({ f: "json" });
        for (const [k, v] of Object.entries(params)) {
            if (v != null) p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
        if (auth) {
            const token = await getToken(url);
            if (token) p.set("token", token);
        }
        let res;
        if (method === "POST") {
            res = await fetchFn(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: p.toString(),
            });
        } else {
            // Public views can be CDN-cached; a unique param forces a fresh read.
            if (agol.cacheBust !== false) p.set("_", String(now()));
            res = await fetchFn(`${url}?${p}`, { cache: "no-store" });
        }
        if (!res.ok) throw new BackendError(`HTTP ${res.status} from ${url}`, { code: "HTTP" });
        const json = await res.json();
        if (json.error) {
            throw new BackendError(json.error.message || "ArcGIS request failed", {
                code: json.error.code,
                details: json.error.details,
            });
        }
        return json;
    }

    async function edit(layerUrl, op, features) {
        const json = await request(`${layerUrl}/${op}`, { features }, { method: "POST", auth: role === "host" });
        const result = (json.addResults || json.updateResults || [])[0];
        if (!result || !result.success) {
            throw new BackendError(result?.error?.description || `${op} failed`, {
                code: result?.error?.code ?? "EDIT_FAILED",
            });
        }
        return result;
    }

    // Host reads the owner table; players read the public view.
    const stateReadUrl = role === "host" ? agol.stateUrl : agol.statePublicUrl;

    async function queryStateRow(sessionId) {
        assertSessionId(sessionId);
        const json = await request(
            `${stateReadUrl}/query`,
            { where: `${STATE_FIELDS.sessionId} = '${sessionId}'`, outFields: "*", returnGeometry: false },
            { method: role === "host" ? "POST" : "GET", auth: role === "host" }
        );
        const feature = json.features?.[0];
        if (!feature) return null;
        return {
            objectIdField: json.objectIdFieldName || "OBJECTID",
            attributes: feature.attributes,
        };
    }

    function assertWritable(sessionId) {
        if (!isTestSession(sessionId) && !live.allowProductionWrites) {
            throw new BackendError(
                `Refusing to write session "${sessionId}": only test-* sessions are writable ` +
                    `unless CONFIG.live.allowProductionWrites is true`,
                { code: "PRODUCTION_WRITE_BLOCKED" }
            );
        }
    }

    const common = {
        kind: "agol",
        async getState(sessionId) {
            const row = await queryStateRow(sessionId);
            return row ? attributesToState(row.attributes) : null;
        },
        onHint() {
            return () => {}; // no push channel; polling only
        },
        close() {},
    };

    if (role === "player") {
        return {
            ...common,
            async submitGuess({ sessionId, roundNum, playerId, nickname, lon, lat }) {
                assertSessionId(sessionId);
                assertRoundNum(roundNum);
                const wkid = agol.guessLayerWkid || 102100;
                const xy = wkid === 4326 ? { x: lon, y: lat } : lonLatToWebMercator(lon, lat);
                const result = await edit(agol.guessesPublicUrl, "addFeatures", [
                    {
                        geometry: { ...xy, spatialReference: { wkid } },
                        attributes: {
                            session_id: sessionId,
                            round_num: roundNum,
                            player_id: playerId,
                            nickname: cleanNickname(nickname),
                            client_ts: now(),
                        },
                    },
                ]);
                return { objectId: result.objectId };
            },
        };
    }

    async function queryGuesses(sessionId, roundNum, extra) {
        assertSessionId(sessionId);
        assertRoundNum(roundNum);
        return request(
            `${agol.guessesUrl}/query`,
            {
                where: `${GUESS_FIELDS.sessionId} = '${sessionId}' AND ${GUESS_FIELDS.roundNum} = ${roundNum}`,
                ...extra,
            },
            { method: "POST", auth: true }
        );
    }

    return {
        ...common,

        async createSession(sessionId, initial = {}) {
            assertWritable(sessionId);
            if (await queryStateRow(sessionId)) {
                throw new BackendError(`Session "${sessionId}" already exists`, { code: "SESSION_EXISTS" });
            }
            const state = { phase: "lobby", roundNum: 0, ...initial, sessionId, updatedAt: now() };
            const attributes = stateToAttributes(state, { jsonFieldLength });
            await edit(agol.stateUrl, "addFeatures", [{ attributes }]);
            return attributesToState(attributes);
        },

        async updateState(sessionId, patch) {
            assertWritable(sessionId);
            const row = await queryStateRow(sessionId);
            if (!row) throw new BackendError(`No session "${sessionId}"`, { code: "NO_SESSION" });
            const { sessionId: _ignored, ...rest } = patch;
            const changes = stateToAttributes({ ...rest, updatedAt: now() }, { jsonFieldLength });
            await edit(agol.stateUrl, "updateFeatures", [
                { attributes: { [row.objectIdField]: row.attributes[row.objectIdField], ...changes } },
            ]);
            return attributesToState({ ...row.attributes, ...changes });
        },

        async listGuesses(sessionId, roundNum) {
            const guesses = [];
            // Page through in case a round ever exceeds maxRecordCount.
            for (let offset = 0; ; ) {
                const json = await queryGuesses(sessionId, roundNum, {
                    outFields: "*",
                    returnGeometry: true,
                    outSR: 4326,
                    orderByFields: `${createdField} ASC`,
                    resultOffset: offset,
                });
                const oidField = json.objectIdFieldName || "OBJECTID";
                for (const f of json.features || []) {
                    guesses.push({
                        objectId: f.attributes[oidField],
                        ...mapAttributes(f.attributes, GUESS_FIELDS),
                        createdAt: f.attributes[createdField],
                        lon: f.geometry?.x,
                        lat: f.geometry?.y,
                    });
                }
                if (!json.exceededTransferLimit) break;
                offset += json.features.length;
            }
            return guesses;
        },

        async countGuesses(sessionId, roundNum) {
            const json = await queryGuesses(sessionId, roundNum, { returnCountOnly: true });
            return json.count;
        },

        async getLandmarks() {
            const json = await request(
                `${agol.landmarksUrl}/query`,
                {
                    where: "1=1",
                    outFields: "*",
                    returnGeometry: true,
                    outSR: 4326,
                    orderByFields: `${LANDMARK_FIELDS.roundOrder} ASC`,
                },
                { method: "POST", auth: true }
            );
            return (json.features || []).map((f) => ({
                ...mapAttributes(f.attributes, LANDMARK_FIELDS),
                geometry: { rings: f.geometry.rings, spatialReference: { wkid: 4326 } },
            }));
        },
    };
}

// =============================================================================
// State polling
// =============================================================================

/**
 * Poll the session state and call onState(state) whenever it changes
 * (compared by updatedAt). Follows brief §3.2:
 *   - jittered interval so 150 phones don't poll in lockstep
 *   - slower in the lobby / final screen
 *   - paused while the tab is hidden; polls immediately when it comes back
 *   - backs off on errors (up to 15 s)
 * Mock hints (other tabs' writes) trigger an immediate poll.
 * Returns { stop, refresh }.
 */
export function watchState(backend, sessionId, onState, opts = {}) {
    const intervals = { lobby: 5000, final: 10000, default: 2500, ...opts.intervals };
    const jitter = opts.jitter ?? 0.25;
    const onError = opts.onError || (() => {});
    const doc = opts.document ?? globalThis.document;

    let stopped = false;
    let timer = null;
    let inflight = false;
    let errors = 0;
    let lastKey;
    let lastPhase = null;

    const hidden = () => !!(doc && doc.hidden);

    function schedule() {
        clearTimeout(timer);
        if (stopped || hidden()) return;
        const base = intervals[lastPhase] ?? intervals.default;
        const wait = errors ? Math.min(base * 2 ** errors, 15000) : base;
        timer = setTimeout(tick, wait * (1 + jitter * (2 * Math.random() - 1)));
    }

    async function tick() {
        clearTimeout(timer);
        if (stopped || hidden() || inflight) return;
        inflight = true;
        try {
            const state = await backend.getState(sessionId);
            errors = 0;
            const key = state ? String(state.updatedAt) : "none";
            if (key !== lastKey && !stopped) {
                lastKey = key;
                lastPhase = state?.phase ?? null;
                onState(state);
            }
        } catch (err) {
            errors++;
            onError(err);
        } finally {
            inflight = false;
            schedule();
        }
    }

    const onVisibility = () => (hidden() ? clearTimeout(timer) : tick());
    doc?.addEventListener?.("visibilitychange", onVisibility);
    const unhint = backend.onHint(sessionId, (what) => what === "state" && tick());

    tick();

    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
            doc?.removeEventListener?.("visibilitychange", onVisibility);
            unhint();
        },
        refresh: tick,
    };
}
