// Run from the repo root with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    playerTag,
    selectValidGuesses,
    scoreRound,
    leaderboardRank,
    polygonCentroid,
    setNameHidden,
    HIDDEN_NAME,
} from "../js/round.js";

const LANDMARK = {
    name: "Capitol",
    funFact: "Gold dome",
    credit: "",
    geometry: { rings: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]], spatialReference: { wkid: 4326 } },
};
// Fake geometry: miles = plain distance from (1, 1) in "degrees"; points = 1000 - 10*miles.
const scoreGuess = (_lm, g) => {
    const miles = Math.hypot(g.lon - 1, g.lat - 1);
    return { points: Math.max(0, Math.round(1000 - 10 * miles)), miles };
};
const guess = (playerId, createdAt, lon, lat, nickname = playerId) => ({ playerId, nickname, createdAt, lon, lat });

test("playerTag is the first 8 hex digits, never the full ID", () => {
    assert.equal(playerTag("3F2504E0-4F89-11D3-9A0C-0305E82C3301"), "3f2504e0");
});

test("first guess per player counts; late guesses are dropped by server time", () => {
    const valid = selectValidGuesses(
        [guess("a", 105, 0, 0), guess("a", 100, 1, 1), guess("b", 1003, 1, 1), guess("c", 1004, 1, 1)],
        { lockTime: 1000, graceMs: 3 }
    );
    assert.deepEqual(valid.map((g) => [g.playerId, g.createdAt]), [["a", 100], ["b", 1003]]);
});

test("scoreRound builds reveal + leaderboard with ranks and ties", () => {
    const { reveal, leaderboard } = scoreRound({
        roundNum: 1,
        landmark: LANDMARK,
        lockTime: 1000,
        scoreGuess,
        guesses: [
            guess("aaaaaaaa-1", 10, 1, 1, "Ann"), // 0 mi, 1000
            guess("bbbbbbbb-1", 11, 4, 5, "Bo"), // 5 mi, 950
            guess("cccccccc-1", 12, 4, 5, "Cy"), // tie with Bo
            guess("dddddddd-1", 13, 11, 1, "Di"), // 10 mi, 900
        ],
    });
    assert.deepEqual(reveal.results.aaaaaaaa, [1000, 0, 1]);
    assert.deepEqual(reveal.results.bbbbbbbb, [950, 5, 2]);
    assert.deepEqual(reveal.results.cccccccc, [950, 5, 2]);
    assert.deepEqual(reveal.results.dddddddd, [900, 10, 4]);
    assert.equal(reveal.count, 4);
    assert.deepEqual(reveal.top[0], ["Ann", 1000, 0]);
    assert.deepEqual({ lon: reveal.answer.lon, lat: reveal.answer.lat }, { lon: 1, lat: 1 });
    assert.equal(leaderboard.rows[0][0], "aaaaaaaa");
    assert.equal(leaderboardRank(leaderboard, "cccccccc"), 2);
    assert.equal(leaderboardRank(leaderboard, "nobody"), null);
    // No full player IDs anywhere in the public JSON.
    assert.ok(!JSON.stringify({ reveal, leaderboard }).includes("-1"));
});

test("totals accumulate; skipping a round adds the miss penalty to distance", () => {
    const r1 = scoreRound({
        roundNum: 1, landmark: LANDMARK, lockTime: 1000, scoreGuess,
        guesses: [guess("aaaaaaaa", 1, 1, 1, "Ann"), guess("bbbbbbbb", 1, 1, 1, "Bo")],
    });
    const r2 = scoreRound({
        roundNum: 2, landmark: LANDMARK, lockTime: 1000, scoreGuess, prevBoard: r1.leaderboard,
        missedRoundMiles: 300,
        guesses: [guess("aaaaaaaa", 1, 1, 1, "Ann")],
    });
    const rows = Object.fromEntries(r2.leaderboard.rows.map((r) => [r[0], r]));
    assert.deepEqual(rows.aaaaaaaa, ["aaaaaaaa", "Ann", 2000, 0, 2]);
    assert.deepEqual(rows.bbbbbbbb, ["bbbbbbbb", "Bo", 1000, 300, 1]);
    assert.equal(r2.leaderboard.afterRound, 2);
});

test("hidden names stay hidden in later rounds and in the round's top list", () => {
    const r1 = scoreRound({ roundNum: 1, landmark: LANDMARK, lockTime: 1000, scoreGuess, guesses: [guess("aaaaaaaa", 1, 1, 1, "Rude")] });
    const board = setNameHidden(r1.leaderboard, "aaaaaaaa");
    assert.equal(board.rows[0][1], HIDDEN_NAME);
    const r2 = scoreRound({ roundNum: 2, landmark: LANDMARK, lockTime: 1000, scoreGuess, prevBoard: board, guesses: [guess("aaaaaaaa", 1, 1, 1, "Rude")] });
    assert.equal(r2.leaderboard.rows[0][1], HIDDEN_NAME);
    assert.equal(r2.reveal.top[0][0], HIDDEN_NAME);
});

test("refuses to score a round that's already on the leaderboard", () => {
    const r1 = scoreRound({ roundNum: 1, landmark: LANDMARK, lockTime: 1000, scoreGuess, guesses: [guess("aaaaaaaa", 1, 1, 1)] });
    assert.throws(() => scoreRound({ roundNum: 1, landmark: LANDMARK, lockTime: 1000, scoreGuess, prevBoard: r1.leaderboard, guesses: [] }), /already/);
});

test("polygonCentroid of a square", () => {
    assert.deepEqual(polygonCentroid(LANDMARK.geometry), { lon: 1, lat: 1 });
});
