// Run from the repo root with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNickname } from "../js/names.js";

test("accepts ordinary names, trimmed and space-collapsed", () => {
    assert.deepEqual(validateNickname("  Mountain   Mama "), { ok: true, name: "Mountain Mama" });
    for (const n of ["Jo", "Seneca_Rocks", "Mary-Kate", "O'Brien", "José", "Team 304", "Road.Warrior"]) {
        assert.equal(validateNickname(n).ok, true, n);
    }
});

test("does not block innocent names that contain short bad words", () => {
    for (const n of ["Cassidy", "Dickens", "Hancock", "Peacock", "Cummings", "Titus", "Sexton",
        "Scunthorpe", "Classic", "Grass Hopper", "Shiitake", "Matilda", "Dickson", "Cockrell"]) {
        assert.equal(validateNickname(n).ok, true, n);
    }
});

test("blocks obvious profanity, including spacing and look-alike tricks", () => {
    for (const n of ["fuck", "Big Shit", "sh1t", "s.h.i.t", "f u c k", "B!tch", "ass", "Kick Ass", "dick", "cum"]) {
        assert.equal(validateNickname(n).ok, false, n);
    }
});

test("length and character rules", () => {
    assert.equal(validateNickname("A").ok, false);
    assert.equal(validateNickname("x".repeat(21)).ok, false);
    assert.equal(validateNickname("x".repeat(20)).ok, true);
    assert.equal(validateNickname("<script>").ok, false);
    assert.equal(validateNickname("🔥🔥").ok, false);
    assert.equal(validateNickname("a\u0000b").name, "ab");
});
