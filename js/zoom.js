/* =============================================================================
 * WV GeoGuess — Zoomable photo viewer (play.html)
 * =============================================================================
 * The phone page turns off browser pinch-zoom (it would fight the map), so
 * the enlarged round photo gets its own: pinch to zoom, drag to pan,
 * double-tap to zoom in/out, mouse wheel on desktop, plus buttons.
 *
 * The image is laid out at its "fit" size and moved with a CSS transform
 * (transform-origin 0 0): screen = translate + scale × image point.
 * ========================================================================== */

export function makeZoomable(stage, img, { maxScale = 6, doubleTapScale = 2.5 } = {}) {
    let baseW = 0;
    let baseH = 0;
    let s = 1; // zoom relative to fit
    let tx = 0;
    let ty = 0;
    const pointers = new Map();
    let pinch = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    let downAt = null;

    const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });

    function fit() {
        const { w, h } = size();
        if (!img.naturalWidth || !w) return;
        const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
        baseW = img.naturalWidth * k;
        baseH = img.naturalHeight * k;
        img.style.width = `${baseW}px`;
        img.style.height = `${baseH}px`;
        reset();
    }

    function reset() {
        const { w, h } = size();
        s = 1;
        tx = (w - baseW) / 2;
        ty = (h - baseH) / 2;
        apply();
    }

    // Keep the photo covering the screen when zoomed in, centered when not.
    function clampPan() {
        const { w, h } = size();
        const iw = baseW * s;
        const ih = baseH * s;
        tx = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, tx));
        ty = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, ty));
    }

    function apply() {
        clampPan();
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    }

    /** Zoom to `next`, keeping the screen point (px, py) over the same spot of the photo. */
    function zoomAt(px, py, next) {
        next = Math.min(maxScale, Math.max(1, next));
        const u = (px - tx) / s;
        const v = (py - ty) / s;
        s = next;
        tx = px - u * s;
        ty = py - v * s;
        apply();
    }

    const local = (e) => {
        const r = stage.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function startPinch() {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s, u: (mid.x - tx) / s, v: (mid.y - ty) / s };
    }

    stage.addEventListener("pointerdown", (e) => {
        try {
            stage.setPointerCapture(e.pointerId); // keep getting moves if the finger leaves the photo
        } catch {
            /* pointer already gone; the gesture still works without capture */
        }
        const p = local(e);
        pointers.set(e.pointerId, p);
        downAt = { ...p, t: performance.now() };
        if (pointers.size === 2) startPinch();
    });

    stage.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) return;
        const prev = pointers.get(e.pointerId);
        const p = local(e);
        pointers.set(e.pointerId, p);
        if (pointers.size >= 2 && pinch) {
            const [a, b] = [...pointers.values()];
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            s = Math.min(maxScale, Math.max(1, (pinch.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist));
            tx = mid.x - pinch.u * s;
            ty = mid.y - pinch.v * s;
            apply();
        } else if (pointers.size === 1 && s > 1) {
            tx += p.x - prev.x;
            ty += p.y - prev.y;
            apply();
        }
    });

    function end(e) {
        if (!pointers.has(e.pointerId)) return;
        const p = pointers.get(e.pointerId);
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 1) {
            // one finger lifted mid-pinch: keep panning with the other
            return;
        }
        // Double tap: two quick taps near each other toggle zoom there.
        const quick = downAt && performance.now() - downAt.t < 250 && Math.hypot(p.x - downAt.x, p.y - downAt.y) < 10;
        if (!quick || e.type === "pointercancel") return;
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
            if (s > 1.05) reset();
            else zoomAt(p.x, p.y, doubleTapScale);
            lastTap = { t: 0, x: 0, y: 0 };
        } else {
            lastTap = { t: now, x: p.x, y: p.y };
        }
    }
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);

    stage.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            const p = local(e);
            zoomAt(p.x, p.y, s * Math.exp(-e.deltaY * 0.0025));
        },
        { passive: false }
    );

    img.addEventListener("load", fit);
    window.addEventListener("resize", fit);

    const center = () => {
        const { w, h } = size();
        return [w / 2, h / 2];
    };
    return {
        fit,
        reset,
        zoomIn: () => zoomAt(...center(), s * 1.6),
        zoomOut: () => zoomAt(...center(), s / 1.6),
        get scale() {
            return s;
        },
    };
}
