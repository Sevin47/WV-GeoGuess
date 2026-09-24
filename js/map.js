/* =============================================================================
 * WV GeoGuess — Map helpers (shared by index.html, play.html, host.html)
 * =============================================================================
 *   Pin symbol + drop animation   the guess marker (moved from script.js)
 *   loadWebMap()                  solo mode: web map from a portal item
 *   setupWVMap()                  live pages: no-label basemap, WV boundary,
 *                                 optional counties, dimmed neighbors, and
 *                                 navigation constrained to WV (brief §3.4)
 *   constrainToWV()               just the constraints, for any map
 *
 * SDK modules are loaded with the global $arcgis.import(), like script.js.
 * ========================================================================== */
import { siteUrl } from "./backend.js";

// WGS84 bounding box of West Virginia (from data/wv-boundary.geojson).
export const WV_BBOX = { xmin: -82.645, ymin: 37.201, xmax: -77.719, ymax: 40.639 };

// Keyless raster basemaps with no labels (labels would give answers away).
// All verified to load anonymously on 2026-09-24.
export const BASEMAPS = {
    hillshade: "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer",
    lightgray: "https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Base/MapServer",
    imagery: "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer",
};

// --- Guess pin ---------------------------------------------------------------
// The artwork is a plain file (assets/pin.svg) — replace it to restyle. It's
// drawn on the map canvas, so it's animated by swapping the symbol's offset
// each frame rather than with CSS.

export const PIN_IMAGE = siteUrl("assets/pin.svg");
export const PIN_WIDTH = 28; // matches the 24:36 (2:3) artwork aspect ratio
export const PIN_HEIGHT = 42;
export const PIN_REST_YOFFSET = PIN_HEIGHT / 2; // lifts the pin's tip onto the clicked point

export function makePinSymbol(yoffset = PIN_REST_YOFFSET, { scale = 1 } = {}) {
    return {
        type: "picture-marker",
        url: PIN_IMAGE,
        width: PIN_WIDTH * scale,
        height: PIN_HEIGHT * scale,
        yoffset: yoffset * scale,
    };
}

/**
 * Animate a freshly placed pin so it appears to drop from above and bounce
 * into place.
 */
export function animatePinDrop(graphic, { scale = 1 } = {}) {
    const dropHeight = 60; // starting height above rest, in points
    const duration = 650; // ms
    const start = performance.now();

    function frame(now) {
        const p = Math.min((now - start) / duration, 1);
        const extra = dropHeight * (1 - easeOutBounce(p));
        graphic.symbol = makePinSymbol(PIN_REST_YOFFSET + extra, { scale });
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

// --- Solo mode ---------------------------------------------------------------

/**
 * Load a web map by portal item ID into an <arcgis-map>. Points the SDK at an
 * ArcGIS Enterprise portal first if one is configured (this must happen
 * before the web map loads so item requests and sign-in target it).
 */
export async function loadWebMap(mapEl, { portalUrl, webMapItemId }) {
    const [esriConfig, WebMap] = await $arcgis.import([
        "@arcgis/core/config.js",
        "@arcgis/core/WebMap.js",
    ]);
    if (portalUrl) esriConfig.portalUrl = portalUrl;
    const webmap = new WebMap({ portalItem: { id: webMapItemId } });
    mapEl.map = webmap;
    await webmap.load();
    return webmap;
}

// --- Live pages --------------------------------------------------------------

/**
 * Build the WV map for play.html / host.html.
 *   basemap      "hillshade" | "lightgray" | "imagery"
 *   boundaryUrl  GeoJSON of the state outline (site-relative)
 *   countiesUrl  GeoJSON of county lines, or null to skip
 *   dimOutside   fade everything outside WV
 *   constrain    keep the view on WV (see constrainToWV)
 */
export async function setupWVMap(mapEl, opts = {}) {
    const {
        basemap = "hillshade",
        boundaryUrl = "data/wv-boundary.geojson",
        countiesUrl = "data/wv-counties.geojson",
        dimOutside = true,
        constrain = true,
    } = opts;

    const [Map, Basemap, TileLayer, GeoJSONLayer, GraphicsLayer, Graphic] = await $arcgis.import([
        "@arcgis/core/Map.js",
        "@arcgis/core/Basemap.js",
        "@arcgis/core/layers/TileLayer.js",
        "@arcgis/core/layers/GeoJSONLayer.js",
        "@arcgis/core/layers/GraphicsLayer.js",
        "@arcgis/core/Graphic.js",
    ]);

    const layers = [];

    if (dimOutside) {
        // A big rectangle with WV cut out of it, filled semi-opaque white.
        const boundary = await (await fetch(siteUrl(boundaryUrl))).json();
        const mask = new GraphicsLayer({ title: "Outside WV" });
        mask.add(
            new Graphic({
                geometry: outsideMask(boundary),
                symbol: { type: "simple-fill", color: [255, 255, 255, 0.55], outline: null },
            })
        );
        layers.push(mask);
    }

    let countiesLayer = null;
    if (countiesUrl) {
        countiesLayer = new GeoJSONLayer({
            title: "WV counties",
            url: siteUrl(countiesUrl),
            popupEnabled: false,
            renderer: {
                type: "simple",
                symbol: {
                    type: "simple-fill",
                    color: [0, 0, 0, 0],
                    outline: { color: [0, 40, 85, 0.35], width: 0.75 },
                },
            },
        });
        layers.push(countiesLayer);
    }

    const boundaryLayer = new GeoJSONLayer({
        title: "WV boundary",
        url: siteUrl(boundaryUrl),
        popupEnabled: false,
        renderer: {
            type: "simple",
            symbol: {
                type: "simple-fill",
                color: [0, 40, 85, 0.04],
                outline: { color: [0, 40, 85, 0.9], width: 2.5 },
            },
        },
    });
    layers.push(boundaryLayer);

    const map = new Map({
        basemap: new Basemap({
            baseLayers: [new TileLayer({ url: BASEMAPS[basemap] || BASEMAPS.hillshade })],
        }),
        layers,
    });

    mapEl.popupDisabled = true;
    mapEl.map = map;
    await mapEl.viewOnReady();

    if (constrain) await constrainToWV(mapEl);

    return { map, boundaryLayer, countiesLayer };
}

/**
 * Fit the view to WV, then keep the player near it: the view's center must
 * stay within WV's extent plus `padding`, and zooming out stops at most one
 * zoom level past the statewide fit. Rotation is disabled.
 *   margin   breathing room around WV in the fitted view (fraction)
 *
 * The zoom limit is recomputed whenever the map resizes (phone rotation, the
 * mobile URL bar collapsing, layout settling after load) WITHOUT moving the
 * view, so a player's zoom survives a resize.
 */
export async function constrainToWV(mapEl, { margin = 0.04, padding = 0.15 } = {}) {
    const [Extent, webMercatorUtils, reactiveUtils] = await $arcgis.import([
        "@arcgis/core/geometry/Extent.js",
        "@arcgis/core/geometry/support/webMercatorUtils.js",
        "@arcgis/core/core/reactiveUtils.js",
    ]);
    const wv = webMercatorUtils.geographicToWebMercator(
        new Extent({ ...WV_BBOX, spatialReference: { wkid: 4326 } })
    );
    const view = mapEl.view;

    // SDK 5.1.25 behavior, all confirmed in testing (docs/NOTES.md §3.4):
    //  - Assigning a new constraints object drops the zoom levels the view
    //    derived from the basemap, after which reading `zoom` throws. So
    //    mutate the existing object.
    //  - A fractional minZoom throws "reading 'scale'" (used as an LOD index).
    //  - minScale is snapped to the next MORE zoomed-in LOD, so minScale =
    //    fit scale blocks the fit itself. An integer minZoom (the fitted zoom
    //    rounded down) is the reliable way to limit zooming out.
    //  - constraints.geometry limits only the view's center, not its extent.
    const c = view.constraints;
    c.rotationEnabled = false;
    c.snapToZoom = false;
    c.geometry = wv.clone().expand(1 + padding);

    const fitScale = () => fitScaleForSize(wv, view.width, view.height, margin);
    const applyMinZoom = () => {
        const scale = fitScale();
        // Zoom level z has scale ZOOM0_SCALE / 2^z in the standard Web
        // Mercator tiling scheme used by the basemaps above.
        if (scale) c.minZoom = Math.max(0, Math.floor(Math.log2(ZOOM0_SCALE / scale)));
    };

    applyMinZoom();
    const scale = fitScale();
    if (scale) await mapEl.goTo({ target: wv.center, scale }, { animate: false });

    reactiveUtils.watch(() => [view.width, view.height], applyMinZoom);
    return wv;
}

const ZOOM0_SCALE = 591657527.591555; // standard Web Mercator LOD 0

/**
 * Scale that fits `extent`, grown by `margin`, into a width × height pixel
 * view. The SDK uses 96 dpi: scale = resolution × 96 / 0.0254.
 */
function fitScaleForSize(extent, width, height, margin) {
    if (!width || !height) return null;
    const resolution = Math.max(
        (extent.width * (1 + margin)) / width,
        (extent.height * (1 + margin)) / height
    );
    return (resolution * 96) / 0.0254;
}

/** Polygon covering the region around WV with the state's outline as a hole. */
function outsideMask(geojson) {
    const outer = [[-95, 30], [-95, 48], [-65, 48], [-65, 30], [-95, 30]]; // clockwise
    const rings = [outer];
    for (const f of geojson.features) {
        const g = f.geometry;
        const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
        for (const poly of polys) {
            // Holes in Esri JSON are counter-clockwise.
            const ring = poly[0];
            rings.push(ringArea(ring) > 0 ? ring : ring.slice().reverse());
        }
    }
    return { type: "polygon", rings, spatialReference: { wkid: 4326 } };
}

function ringArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return sum / 2; // > 0 = counter-clockwise
}
