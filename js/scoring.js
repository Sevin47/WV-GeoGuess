/* =============================================================================
 * WV GeoGuess — Scoring
 * =============================================================================
 * Two layers:
 *   1. Pure math (pointsForMiles, formatMiles, ...) — no SDK, unit-tested in
 *      tests/scoring.test.mjs (run `node --test`).
 *   2. createScorer() — wraps the ArcGIS geometry operators. Distance is the
 *      geodesic distance to the nearest point on the polygon, NOT planar
 *      distance in the data's SR: planar Web Mercator overstates WV distances
 *      by ~1.28x (see docs/NOTES.md §3.2). Geodesic works in any SR and any
 *      part of the world (a fixed UTM 17N projection returns null outside
 *      the zone), and agrees with UTM 17N to within 0.04% across WV.
 *
 * Settings come from CONFIG.scoring in config.js.
 * ========================================================================== */

export const METERS_PER_MILE = 1609.344;

export function metersToMiles(meters) {
    return meters / METERS_PER_MILE;
}

/** "12.4 mi" style: one decimal, never shows "0.0" for a real miss. */
export function formatMiles(miles) {
    if (miles > 0 && miles < 0.1) return "<0.1";
    return miles.toFixed(1);
}

/**
 * Points for one guess.
 *   inside  — the guess landed inside the answer polygon
 *   miles   — distance from the guess to the polygon edge (0 when inside)
 */
export function pointsForMiles(miles, inside, scoring) {
    const max = scoring.maxPoints;
    if (inside) return max;

    if (scoring.mode === "bands") {
        const b = scoring.bands;
        const bands = Math.floor(miles / b.bandMiles);
        return Math.max(b.minScore, max - bands * b.penaltyPerBand);
    }

    // Default: "exponential"
    return Math.round(max * Math.exp(-miles / scoring.exponential.scaleMiles));
}

/**
 * Build the SDK-backed scorer. Pass in the operator modules loaded via
 * $arcgis.import() so this file stays free of SDK imports (and testable).
 * Call `await scorer.load()` once before the first scoreGuess().
 */
export function createScorer(
    { containsOperator, geodesicProximityOperator },
    scoring
) {
    return {
        load() {
            return geodesicProximityOperator.isLoaded()
                ? Promise.resolve()
                : geodesicProximityOperator.load();
        },

        /** Score a guess point against an answer polygon (same SR, any SR). */
        scoreGuess(polygon, point) {
            const inside = containsOperator.execute(polygon, point);
            // `distance` is geodesic meters regardless of the input SR.
            const meters = inside
                ? 0
                : geodesicProximityOperator.getNearestCoordinate(polygon, point)
                      .distance;
            const miles = metersToMiles(meters);

            return {
                inside,
                meters,
                miles,
                points: pointsForMiles(miles, inside, scoring),
            };
        },
    };
}
