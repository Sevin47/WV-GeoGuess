/* =============================================================================
 * WV GeoGuess — Round scoring and the public result format
 * =============================================================================
 * The contract between host.html (writes) and play.html (reads). No SDK
 * imports; the geometry scorer is passed in. Unit-tested in
 * tests/round.test.mjs.
 *
 * PUBLIC JSON (written to the State table's reveal_json / leaderboard_json,
 * readable by anyone):
 *
 *   reveal = {
 *     v: 1, round: 3,
 *     answer:  { name, funFact, credit, lon, lat },    // lon/lat = centroid
 *     results: { <tag>: [points, miles, roundRank] },  // one per counted guess
 *     count:   42,                                     // guesses counted
 *     top:     [[tag, nickname, points, miles], ...]   // best 5 this round
 *   }
 *
 *   leaderboard = {
 *     v: 1, afterRound: 3,
 *     rows:   [[tag, nickname, totalPoints, totalMiles, roundsPlayed], ...],
 *     hidden: [tag, ...]                               // names the host hid
 *   }
 *
 * <tag> is the first 8 hex digits of the player's UUID, NEVER the full ID:
 * the guesses view accepts anonymous adds and the host keeps each player's
 * FIRST guess, so a published full ID would let anyone lock in a bad guess
 * for someone else (docs/NOTES.md §4c).
 * ========================================================================== */

export const HIDDEN_NAME = "(name hidden)";

/** Short public tag for a player ID (UUID). */
export function playerTag(playerId) {
    return String(playerId || "").replace(/-/g, "").slice(0, 8).toLowerCase();
}

/**
 * Keep the guesses that count: guesses at or before lockTime + graceMs
 * (server CreationDate), and only each player's FIRST guess.
 */
export function selectValidGuesses(guesses, { lockTime, graceMs = 3000 }) {
    const cutoff = lockTime + graceMs;
    const seen = new Set();
    const valid = [];
    for (const g of [...guesses].sort((a, b) => a.createdAt - b.createdAt)) {
        if (!g.playerId || seen.has(g.playerId)) continue;
        if (g.createdAt > cutoff) continue;
        seen.add(g.playerId);
        valid.push(g);
    }
    return valid;
}

/** Competition ranks (1, 2, 2, 4) for items already sorted best-first. */
function competitionRanks(items, sameScore) {
    const ranks = [];
    items.forEach((item, i) => {
        ranks.push(i > 0 && sameScore(items[i - 1], item) ? ranks[i - 1] : i + 1);
    });
    return ranks;
}

/** Area-weighted centroid of the first ring of an Esri JSON polygon (lon/lat). */
export function polygonCentroid(geometry) {
    const ring = geometry.rings[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[i + 1];
        const cross = x0 * y1 - x1 * y0;
        a += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    if (Math.abs(a) < 1e-12) return { lon: ring[0][0], lat: ring[0][1] };
    return { lon: cx / (3 * a), lat: cy / (3 * a) };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Sort leaderboard rows: points desc, then total miles asc (brief §3.3). */
export function sortRows(rows) {
    return rows.sort((a, b) => b[2] - a[2] || a[3] - b[3]);
}

/** A player's overall rank (competition ranking), or null if not on the board. */
export function leaderboardRank(leaderboard, tag) {
    const rows = leaderboard?.rows || [];
    const me = rows.find((r) => r[0] === tag);
    if (!me) return null;
    return 1 + rows.filter((r) => r[2] > me[2] || (r[2] === me[2] && r[3] < me[3])).length;
}

/**
 * Score one round and fold it into the cumulative leaderboard.
 *
 *   landmark     { name, funFact, credit, geometry }  (geometry: Esri JSON, WGS84)
 *   guesses      from backend.listGuesses()            (lon/lat, createdAt, ...)
 *   scoreGuess   (landmark, guess) => { points, miles } — geometry lives outside
 *   lockTime     when the round locked (ms). The host writes it as the
 *                state's roundEndsAt, including when it locks early, so it
 *                survives a host refresh and every phone's countdown stops.
 *   prevBoard    previous leaderboard object, or null
 *   missedRoundMiles  added to a player's total miles when they skip a round,
 *                     so skipping never helps the distance tie-breaker
 *
 * Returns { reveal, leaderboard } ready for backend.updateState().
 */
export function scoreRound({
    roundNum,
    landmark,
    guesses,
    lockTime,
    graceMs = 3000,
    scoreGuess,
    prevBoard = null,
    missedRoundMiles = 300,
    topN = 5,
}) {
    if (prevBoard && prevBoard.afterRound >= roundNum) {
        // Scoring the same round twice would double-count it. To re-score,
        // start again from the board as it was before this round.
        throw new Error(`Round ${roundNum} is already in the leaderboard (afterRound ${prevBoard.afterRound})`);
    }
    const valid = selectValidGuesses(guesses, { lockTime, graceMs });

    const scored = valid
        .map((g) => {
            const { points, miles } = scoreGuess(landmark, g);
            return { tag: playerTag(g.playerId), nickname: g.nickname, points, miles: round1(miles) };
        })
        .sort((a, b) => b.points - a.points || a.miles - b.miles);
    const ranks = competitionRanks(scored, (a, b) => a.points === b.points && a.miles === b.miles);

    const hidden = new Set(prevBoard?.hidden || []);
    const shownName = (tag, nickname) => (hidden.has(tag) ? HIDDEN_NAME : nickname);

    const results = {};
    scored.forEach((s, i) => (results[s.tag] = [s.points, s.miles, ranks[i]]));

    // Cumulative totals. A hidden player's row shows HIDDEN_NAME; each scored
    // round rewrites the name from their latest guess, which is also how an
    // unhidden name comes back.
    const byTag = new Map((prevBoard?.rows || []).map((r) => [r[0], [...r]]));
    const scoredTags = new Set(scored.map((s) => s.tag));
    for (const s of scored) {
        const row = byTag.get(s.tag) || [s.tag, s.nickname, 0, 0, 0];
        row[1] = shownName(s.tag, s.nickname);
        row[2] += s.points;
        row[3] = round1(row[3] + s.miles);
        row[4] += 1;
        byTag.set(s.tag, row);
    }
    for (const [tag, row] of byTag) {
        if (!scoredTags.has(tag)) row[3] = round1(row[3] + missedRoundMiles);
    }

    const centroid = polygonCentroid(landmark.geometry);
    const reveal = {
        v: 1,
        round: roundNum,
        answer: {
            name: landmark.name,
            funFact: landmark.funFact || "",
            credit: landmark.credit || "",
            lon: round6(centroid.lon),
            lat: round6(centroid.lat),
        },
        results,
        count: scored.length,
        top: scored.slice(0, topN).map((s) => [s.tag, shownName(s.tag, s.nickname), s.points, s.miles]),
    };

    const leaderboard = {
        v: 1,
        afterRound: roundNum,
        rows: sortRows([...byTag.values()]),
        hidden: [...hidden],
    };
    return { reveal, leaderboard };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** Hide a player's name in a reveal's top list (for hiding mid-reveal). */
export function hideNameInReveal(reveal, tag) {
    if (!reveal?.top) return reveal;
    return { ...reveal, top: reveal.top.map((t) => (t[0] === tag ? [t[0], HIDDEN_NAME, t[2], t[3]] : t)) };
}

/** Hide (or unhide) a player's name on the public leaderboard. */
export function setNameHidden(leaderboard, tag, hide = true) {
    const hidden = new Set(leaderboard?.hidden || []);
    if (hide) hidden.add(tag);
    else hidden.delete(tag);
    const rows = (leaderboard?.rows || []).map((r) => (r[0] === tag && hide ? [r[0], HIDDEN_NAME, r[2], r[3], r[4]] : r));
    return { ...(leaderboard || { v: 1, afterRound: 0, rows: [] }), rows, hidden: [...hidden] };
}
