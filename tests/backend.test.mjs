// Run from the repo root with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createHostBackend,
    createPlayerBackend,
    resolveLiveConfig,
    stateToAttributes,
    attributesToState,
    lonLatToWebMercator,
    geoJsonToEsriPolygon,
    watchState,
} from "../js/backend.js";

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

const LANDMARKS = {
    type: "FeatureCollection",
    features: [
        {
            type: "Feature",
            properties: { landmark_id: "r02", name: "B", round_order: 2 },
            geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
        {
            type: "Feature",
            properties: { landmark_id: "r01", name: "A", round_order: 1 },
            geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
    ],
};

function mockPair({ now } = {}) {
    const live = { backend: "mock", jsonFieldLength: 200, mock: { channelName: `t-${Math.random()}` } };
    const storage = memoryStorage();
    const host = createHostBackend(live, { storage, now, landmarks: LANDMARKS });
    const player = createPlayerBackend(live, { storage, now });
    return { host, player, close: () => (host.close(), player.close()) };
}

test("mock: host creates and updates state; player reads it", async () => {
    let t = 1000;
    const { host, player, close } = mockPair({ now: () => t });
    try {
        assert.equal(await player.getState("test-a"), null);
        await host.createSession("test-a", { roundTotal: 6 });
        t = 2000;
        await host.updateState("test-a", { phase: "reveal", roundNum: 1, reveal: { answer: "x" } });
        const s = await player.getState("test-a");
        assert.equal(s.phase, "reveal");
        assert.equal(s.roundNum, 1);
        assert.equal(s.roundTotal, 6);
        assert.deepEqual(s.reveal, { answer: "x" });
        assert.equal(s.updatedAt, 2000);
        await assert.rejects(host.createSession("test-a"), { code: "SESSION_EXISTS" });
    } finally {
        close();
    }
});

test("mock: players can submit but not read guesses; host sees them in arrival order", async () => {
    let t = 5000;
    const { host, player, close } = mockPair({ now: () => t++ });
    try {
        assert.equal(player.listGuesses, undefined);
        assert.equal(player.updateState, undefined);
        await player.submitGuess({ sessionId: "test-a", roundNum: 1, playerId: "p1", nickname: "  Ann  ", lon: -81, lat: 38 });
        await player.submitGuess({ sessionId: "test-a", roundNum: 1, playerId: "p2", nickname: "x".repeat(40), lon: -80, lat: 39 });
        await player.submitGuess({ sessionId: "test-a", roundNum: 2, playerId: "p1", nickname: "Ann", lon: -79, lat: 39 });
        const g = await host.listGuesses("test-a", 1);
        assert.deepEqual(g.map((x) => x.playerId), ["p1", "p2"]);
        assert.equal(g[0].nickname, "Ann");
        assert.equal(g[1].nickname.length, 24);
        assert.ok(g[0].createdAt < g[1].createdAt);
        assert.equal(await host.countGuesses("test-a", 1), 2);
        assert.equal(await host.countGuesses("test-a", 2), 1);
    } finally {
        close();
    }
});

test("mock: landmarks come back sorted with clockwise Esri rings", async () => {
    const { host, close } = mockPair();
    try {
        const lm = await host.getLandmarks();
        assert.deepEqual(lm.map((l) => l.landmarkId), ["r01", "r02"]);
        // GeoJSON square above is counter-clockwise; Esri outer ring must be clockwise.
        assert.deepEqual(lm[0].geometry.rings[0][1], [0, 1]);
        assert.equal(lm[0].geometry.spatialReference.wkid, 4326);
    } finally {
        close();
    }
});

test("JSON fields are size-checked and round-trip", () => {
    const attrs = stateToAttributes({ phase: "reveal", leaderboard: [{ n: "a" }] }, { jsonFieldLength: 100 });
    assert.equal(attrs.leaderboard_json, '[{"n":"a"}]');
    assert.equal("reveal_json" in attrs, false); // only keys present are written
    assert.deepEqual(attributesToState(attrs).leaderboard, [{ n: "a" }]);
    assert.throws(
        () => stateToAttributes({ reveal: { big: "x".repeat(200) } }, { jsonFieldLength: 100 }),
        { code: "JSON_TOO_LONG" }
    );
});

test("session IDs are validated (they go into SQL where clauses)", async () => {
    const { host, close } = mockPair();
    try {
        await assert.rejects(host.getState("x' OR 1=1 --"), { code: "BAD_SESSION_ID" });
    } finally {
        close();
    }
});

// --- agol adapter against a fake fetch ------------------------------------------

function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
        const [path, qs] = url.split("?");
        const query = qs ? Object.fromEntries(new URLSearchParams(qs)) : null;
        const call = { path, method: init.method || "GET", params: body || query };
        calls.push(call);
        const json = handler(call);
        return { ok: true, status: 200, json: async () => json };
    };
    return { fn, calls };
}

const AGOL = {
    backend: "agol",
    jsonFieldLength: 1000,
    agol: {
        stateUrl: "https://x/State/FeatureServer/0",
        statePublicUrl: "https://x/State_Public/FeatureServer/0",
        guessesUrl: "https://x/Guesses/FeatureServer/0",
        guessesPublicUrl: "https://x/Guesses_Public/FeatureServer/0",
        landmarksUrl: "https://x/Landmarks/FeatureServer/0",
    },
};

test("agol player: guess is posted to the public view in Web Mercator, no token", async () => {
    const { fn, calls } = fakeFetch(() => ({ addResults: [{ objectId: 7, success: true }] }));
    const player = createPlayerBackend(AGOL, { fetch: fn, now: () => 123 });
    const r = await player.submitGuess({ sessionId: "test-a", roundNum: 3, playerId: "p", nickname: "N", lon: -81.6, lat: 38.3 });
    assert.equal(r.objectId, 7);
    const c = calls[0];
    assert.equal(c.path, "https://x/Guesses_Public/FeatureServer/0/addFeatures");
    assert.equal(c.method, "POST");
    assert.equal(c.params.token, undefined);
    const [feature] = JSON.parse(c.params.features);
    assert.equal(feature.geometry.spatialReference.wkid, 102100);
    const wm = lonLatToWebMercator(-81.6, 38.3);
    assert.equal(feature.geometry.x, wm.x);
    assert.equal(feature.attributes.round_num, 3);
    assert.equal(feature.attributes.client_ts, 123);
});

test("agol player: state polls the public view with GET + cache buster", async () => {
    const { fn, calls } = fakeFetch(() => ({
        objectIdFieldName: "OBJECTID",
        features: [{ attributes: { OBJECTID: 1, session_id: "test-a", phase: "guessing", round_num: 2, reveal_json: null } }],
    }));
    const player = createPlayerBackend(AGOL, { fetch: fn, now: () => 42 });
    const s = await player.getState("test-a");
    assert.equal(s.phase, "guessing");
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].path, "https://x/State_Public/FeatureServer/0/query");
    assert.equal(calls[0].params.where, "session_id = 'test-a'");
    assert.equal(calls[0].params._, "42");
});

test("agol host: updates by objectId with a token; refuses production sessions", async () => {
    const { fn, calls } = fakeFetch((c) =>
        c.path.endsWith("/query")
            ? { objectIdFieldName: "ObjectId", features: [{ attributes: { ObjectId: 9, session_id: "test-a", phase: "lobby" } }] }
            : { updateResults: [{ objectId: 9, success: true }] }
    );
    const host = createHostBackend(AGOL, { fetch: fn, getToken: async () => "TKN", now: () => 5 });
    const s = await host.updateState("test-a", { phase: "guessing", roundEndsAt: 50 });
    assert.equal(s.phase, "guessing");
    const upd = calls.find((c) => c.path.endsWith("/updateFeatures"));
    assert.equal(upd.path, "https://x/State/FeatureServer/0/updateFeatures");
    assert.equal(upd.params.token, "TKN");
    const [f] = JSON.parse(upd.params.features);
    assert.deepEqual(f.attributes, { ObjectId: 9, phase: "guessing", round_ends_at: 50, updated_at: 5 });

    await assert.rejects(host.updateState("gisday2026", { phase: "lobby" }), { code: "PRODUCTION_WRITE_BLOCKED" });
    const allowed = createHostBackend({ ...AGOL, allowProductionWrites: true }, { fetch: fn });
    await allowed.updateState("gisday2026", { phase: "lobby" });
});

test("agol: ArcGIS error payloads and failed edits throw", async () => {
    const err = fakeFetch(() => ({ error: { code: 498, message: "Invalid token." } }));
    const host = createHostBackend(AGOL, { fetch: err.fn });
    await assert.rejects(host.getState("test-a"), { code: 498, message: "Invalid token." });

    const fail = fakeFetch(() => ({ addResults: [{ success: false, error: { code: 1000, description: "nope" } }] }));
    const player = createPlayerBackend(AGOL, { fetch: fail.fn });
    await assert.rejects(
        player.submitGuess({ sessionId: "test-a", roundNum: 1, playerId: "p", nickname: "n", lon: 0, lat: 0 }),
        { message: "nope" }
    );
});

test("agol host: guesses are paged and mapped", async () => {
    let page = 0;
    const { fn, calls } = fakeFetch(() => {
        page++;
        return {
            objectIdFieldName: "OBJECTID",
            exceededTransferLimit: page === 1,
            features: [{ attributes: { OBJECTID: page, player_id: `p${page}`, CreationDate: page * 10 }, geometry: { x: -80, y: 39 } }],
        };
    });
    const host = createHostBackend(AGOL, { fetch: fn });
    const g = await host.listGuesses("test-a", 1);
    assert.deepEqual(g.map((x) => [x.playerId, x.createdAt, x.lon]), [["p1", 10, -80], ["p2", 20, -80]]);
    assert.equal(calls[1].params.resultOffset, "1");
    assert.equal(calls[0].params.where, "session_id = 'test-a' AND round_num = 1");
});

// --- misc --------------------------------------------------------------------------

test("resolveLiveConfig applies URL overrides", () => {
    const r = resolveLiveConfig({ backend: "agol", defaultSessionId: "test-dev" }, "?backend=mock&session=test-x");
    assert.equal(r.backend, "mock");
    assert.equal(r.sessionId, "test-x");
});

test("geoJsonToEsriPolygon keeps holes counter-clockwise", () => {
    const outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]; // CCW
    const hole = [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]; // CW
    const { rings } = geoJsonToEsriPolygon({ type: "Polygon", coordinates: [outer, hole] });
    assert.deepEqual(rings[0], outer.slice().reverse());
    assert.deepEqual(rings[1], hole.slice().reverse());
});

test("watchState pauses while the document is hidden, unless document: null", async () => {
    const { host, player, close } = mockPair();
    try {
        await host.createSession("test-h");
        const hiddenDoc = { hidden: true, addEventListener() {}, removeEventListener() {} };
        const paused = [];
        const w1 = watchState(player, "test-h", (s) => paused.push(s?.phase), { intervals: { default: 10, lobby: 10 }, document: hiddenDoc });
        const always = [];
        const saved = globalThis.document;
        globalThis.document = hiddenDoc; // a hidden page, as in a background tab
        const w2 = watchState(player, "test-h", (s) => always.push(s?.phase), { intervals: { default: 10, lobby: 10 }, document: null });
        await new Promise((r) => setTimeout(r, 50));
        w1.stop();
        w2.stop();
        globalThis.document = saved;
        assert.deepEqual(paused, []);
        assert.deepEqual(always, ["lobby"]);
    } finally {
        close();
    }
});

test("watchState reports changes only, and stops cleanly", async () => {
    const { host, player, close } = mockPair();
    try {
        await host.createSession("test-w");
        const seen = [];
        const w = watchState(player, "test-w", (s) => seen.push(s?.phase), {
            intervals: { default: 10, lobby: 10 },
            document: null,
        });
        await new Promise((r) => setTimeout(r, 60));
        await host.updateState("test-w", { phase: "guessing" });
        await new Promise((r) => setTimeout(r, 60));
        w.stop();
        assert.deepEqual(seen, ["lobby", "guessing"]);
    } finally {
        close();
    }
});
