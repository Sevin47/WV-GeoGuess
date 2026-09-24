// Run from the repo root with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    pointsForMiles,
    formatMiles,
    sameSR,
    metersToMiles,
} from "../js/scoring.js";

const exponential = {
    mode: "exponential",
    maxPoints: 1000,
    exponential: { scaleMiles: 25 },
    bands: { bandMiles: 5, penaltyPerBand: 40, minScore: 0 },
};
const bands = { ...exponential, mode: "bands" };

test("inside the polygon always scores max", () => {
    assert.equal(pointsForMiles(0, true, exponential), 1000);
    assert.equal(pointsForMiles(0, true, bands), 1000);
});

test("exponential matches the table in the brief (§3.3)", () => {
    const expected = { 5: 819, 10: 670, 25: 368, 50: 135, 100: 18 };
    for (const [miles, pts] of Object.entries(expected)) {
        assert.equal(pointsForMiles(Number(miles), false, exponential), pts);
    }
});

test("exponential never goes negative and decreases with distance", () => {
    let prev = Infinity;
    for (let mi = 0; mi <= 300; mi += 7.3) {
        const p = pointsForMiles(mi, false, exponential);
        assert.ok(p >= 0 && p <= prev);
        prev = p;
    }
});

test("bands: full points in the first band, linear drop, floored at min", () => {
    assert.equal(pointsForMiles(4.9, false, bands), 1000);
    assert.equal(pointsForMiles(5, false, bands), 960);
    assert.equal(pointsForMiles(52, false, bands), 600);
    assert.equal(pointsForMiles(500, false, bands), 0);
});

test("sameSR treats the Web Mercator aliases as equal", () => {
    assert.ok(sameSR({ wkid: 102100 }, { wkid: 3857 }));
    assert.ok(sameSR({ wkid: 102100, latestWkid: 3857 }, { wkid: 3857 }));
    assert.ok(sameSR({ wkid: 4326 }, { wkid: 4326 }));
    assert.ok(!sameSR({ wkid: 4326 }, { wkid: 102100 }));
});

test("formatMiles", () => {
    assert.equal(formatMiles(12.44), "12.4");
    assert.equal(formatMiles(0.04), "<0.1");
    assert.equal(formatMiles(0), "0.0");
    assert.equal(metersToMiles(1609.344), 1);
});
