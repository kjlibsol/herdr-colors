// Pure helpers: no herdr imports, so node can test them (test/color.test.mjs).

// For projects without a color of their own: a soft gray, so "no color set"
// is plain to see next to the projects that have one.
export const FALLBACK = "#5f6670";

// Removes // and /* */ comments and trailing commas, leaving strings untouched,
// so VS Code's settings.json (JSONC) parses with JSON.parse.
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Second pass: drop a comma whose next non-space character closes an object or array.
  let res = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    res += c;
  }
  return res;
}

// "#abc", "#aabbcc" or "#aabbccdd" to "#aabbcc"; anything else to null.
export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return "#" + [...m[1]].map((d) => d + d).join("");
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  return m ? "#" + m[1] : null;
}

// The project's own colors from .vscode/settings.json text, or null.
// Returns { background, foreground|null, source }.
export function colorFromSettings(text) {
  if (!text) return null;
  let s;
  try { s = JSON.parse(stripJsonc(text)); } catch { return null; }
  if (!s || typeof s !== "object") return null;
  const cc = s["workbench.colorCustomizations"];
  const bg = normalizeHex(cc?.["titleBar.activeBackground"]);
  if (bg) return { background: bg, foreground: normalizeHex(cc?.["titleBar.activeForeground"]), source: "titleBar.activeBackground" };
  const peacock = normalizeHex(s["peacock.color"]);
  if (peacock) return { background: peacock, foreground: null, source: "peacock.color" };
  return null;
}

// Black or white text, whichever reads better on the background (WCAG luminance).
export function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.179 ? "#000000" : "#ffffff";
}

// Merges project colors into herdr's shared "space.colors" map.
// current: the map as it is (theme names like "ansi6" that herdr assigned, or
// "#rrggbb"); written: what this mod wrote last time; found: space id -> hex.
// A space's entry is replaced only when it is missing, a theme name (herdr's
// automatic pick) or exactly what this mod wrote before, so a hex color the
// person picked stays. Returns the new maps and whether anything changed.
export function mergeSpaceColors(current, written, found) {
  const colors = { ...current };
  const mine = { ...written };
  let changed = false;
  for (const [id, hex] of Object.entries(found)) {
    const now = colors[id];
    const ours = now === undefined || !String(now).startsWith("#") || now === mine[id];
    if (!ours) { if (id in mine) { delete mine[id]; changed = true; } continue; }
    if (now !== hex) { colors[id] = hex; changed = true; }
    if (mine[id] !== hex) { mine[id] = hex; changed = true; }
  }
  return { colors, written: mine, changed };
}

// Last path segment, for "/workspaces/plus" or "X:\\plus" alike.
export function baseName(path) {
  return String(path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}
