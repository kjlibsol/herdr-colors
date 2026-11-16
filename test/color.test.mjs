import assert from "node:assert/strict";
import { test } from "node:test";
import { stripJsonc, normalizeHex, colorFromSettings, hashColor, textOn, baseName, PALETTE, mergeSpaceColors } from "../mods/project-color/color.js";

test("JSONC with comments and trailing commas", () => {
  const text = `{
    // a comment
    "url": "http://example.com/a//b", /* block */
    "workbench.colorCustomizations": {
      "titleBar.activeBackground": "#7D6608",
      "titleBar.activeForeground": "#fff",
    },
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(text)).url, "http://example.com/a//b");
  assert.deepEqual(colorFromSettings(text), { background: "#7d6608", foreground: "#ffffff", source: "titleBar.activeBackground" });
});

test("peacock.color when no title bar color", () => {
  assert.deepEqual(colorFromSettings(`{ "peacock.color": "#42b883" }`), { background: "#42b883", foreground: null, source: "peacock.color" });
});

test("no color, broken or missing file", () => {
  assert.equal(colorFromSettings(`{ "editor.tabSize": 2 }`), null);
  assert.equal(colorFromSettings(`{ nope`), null);
  assert.equal(colorFromSettings(null), null);
});

test("hex normalisation", () => {
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("#11223344"), "#112233");
  assert.equal(normalizeHex("red"), null);
});

test("hash is stable and in the palette", () => {
  assert.equal(hashColor("Plus"), hashColor("plus"));
  assert.ok(PALETTE.includes(hashColor("whatever")));
});

test("space colors: replaces herdr's picks and our own, keeps a person's hex", () => {
  const current = { a: "ansi6", b: "#123456", c: "#abcdef", e: "ansi2" };
  const written = { b: "#123456" };
  const found = { a: "#7d6608", b: "#922b21", c: "#007acc", d: "#1e8449" };
  const r = mergeSpaceColors(current, written, found);
  assert.deepEqual(r.colors, { a: "#7d6608", b: "#922b21", c: "#abcdef", d: "#1e8449", e: "ansi2" });
  assert.deepEqual(r.written, { a: "#7d6608", b: "#922b21", d: "#1e8449" });
  assert.equal(r.changed, true);
  // Running again with the same input changes nothing.
  assert.equal(mergeSpaceColors(r.colors, r.written, found).changed, false);
});

test("contrast and base names", () => {
  assert.equal(textOn("#7d6608"), "#ffffff");
  assert.equal(textOn("#f1c40f"), "#000000");
  assert.equal(baseName("/workspaces/plus/"), "plus");
  assert.equal(baseName("X:\\herdr-colors"), "herdr-colors");
});
