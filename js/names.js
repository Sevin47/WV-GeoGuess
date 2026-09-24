/* =============================================================================
 * WV GeoGuess — Nickname validation (brief §3.4)
 * =============================================================================
 * A LIGHT filter: it catches the obvious stuff on a projector at a work
 * event. It will never be perfect, so the host can also hide any name
 * (js/round.js setNameHidden). Unit-tested in tests/names.test.mjs.
 * ========================================================================== */

export const NAME_MIN = 2;
export const NAME_MAX = 20;

// Letters (any language), digits, spaces, and a little punctuation.
const ALLOWED = /^[\p{L}\p{N} .'_-]+$/u;

// Normalization for matching: lowercase, undo common look-alike swaps, and
// drop everything that isn't a letter (so "s.h.i.t" and "sh1t" both match).
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "!": "i" };

function normalize(text) {
    return text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "") // accents
        .replace(/[013457 8@$!]/g, (c) => LEET[c] ?? c)
        .replace(/[^a-z]/g, "");
}

// Blocked anywhere inside the name. Only terms with no common innocent
// surname or word containing them belong here.
const BLOCK_SUBSTRING = [
    "fuck", "shit", "bitch", "cunt", "pussy", "whore", "slut", "bastard",
    "asshole", "dildo", "porn", "nigg", "fagg", "retard", "rapist", "nazi",
    "hitler", "wank", "twat", "jizz",
];
const SUBSTRING_EXCEPTIONS = ["scunthorpe"];

// Blocked only as a whole word, because they sit inside innocent names:
// Cassidy, Dickens, Hancock, Cummings, Titus, Sexton, Penistone...
const BLOCK_WORD = [
    "ass", "fag", "tit", "tits", "sex", "anal", "hoe", "kkk", "piss", "damn",
    "crap", "cum", "dick", "cock", "penis", "boner", "vagina",
];

function containsBlocked(name) {
    const flat = normalize(name);
    const cleared = SUBSTRING_EXCEPTIONS.reduce((s, ok) => s.split(ok).join(""), flat);
    if (BLOCK_SUBSTRING.some((w) => cleared.includes(w))) return true;
    const words = name.toLowerCase().split(/[\s._-]+/).map(normalize);
    return words.some((w) => BLOCK_WORD.includes(w));
}

/**
 * Clean and check a nickname.
 * Returns { ok: true, name } or { ok: false, error } (error is player-facing).
 */
export function validateNickname(raw) {
    const name = String(raw ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, "") // control characters
        .replace(/\s+/g, " ")
        .trim();
    if (name.length < NAME_MIN) return { ok: false, error: `Use at least ${NAME_MIN} characters.` };
    if (name.length > NAME_MAX) return { ok: false, error: `Keep it to ${NAME_MAX} characters or fewer.` };
    if (!ALLOWED.test(name)) return { ok: false, error: "Use letters, numbers, and spaces only." };
    if (containsBlocked(name)) return { ok: false, error: "Please pick a different name." };
    return { ok: true, name };
}
