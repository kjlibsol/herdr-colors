// Pure helpers: no herdr imports, so node can test them (test/color.test.mjs).

// Colors a project gets when it has none of its own: 14 hues around the
// wheel, all dark enough for white text, none closer than about 18 CIE76 dE
// to another in normal vision. A new project gets the one fewest projects use
// (see assignColor), so projects stay apart instead of colliding by hash.
export const PALETTE = [
  "#b02e26", "#a8561a", "#6e5a10", "#4f6b1a", "#1e7b34", "#0f7466", "#156a8c",
  "#2257b8", "#1d3a7a", "#5236a8", "#80309a", "#a12c7a", "#7a2a3c", "#55606e",
];

// The picker's swatches: the palette, so a picked color matches the automatic ones.
export const PRESETS = PALETTE;

// FNV-1a over the lowercased name: where a new project starts looking in the palette.
export function hashIndex(name) {
  let h = 0x811c9dc5;
  for (const ch of String(name ?? "").toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PALETTE.length;
}

// How repo names are compared: Unicode-normalised (macOS can hand back
// decomposed names) and case-blind, so "MyApp" and "myapp" are one project.
export const nameKey = (name) => String(name ?? "").normalize("NFC").toLowerCase();

// The personal file's entry for a repo: an exact key first, else one that
// differs only in case or Unicode form. Returns the hex or null.
export function personalColor(personal, name) {
  const repos = personal?.repos ?? {};
  if (Object.hasOwn(repos, name)) return repos[name];
  const k = nameKey(name);
  for (const key of Object.keys(repos)) if (nameKey(key) === k) return repos[key];
  return null;
}

// A project's automatic color. assigned: { name: hex } remembered so far.
// A known name keeps its color; a new one gets the palette color used least,
// ties broken by the name's hash, and the caller remembers it.
export function assignColor(name, assigned) {
  const key = nameKey(name);
  if (Object.hasOwn(assigned ?? {}, key)) return assigned[key];
  const uses = new Map(PALETTE.map((c) => [c, 0]));
  for (const c of Object.values(assigned ?? {})) if (uses.has(c)) uses.set(c, uses.get(c) + 1);
  const start = hashIndex(key);
  let best = null;
  for (let i = 0; i < PALETTE.length; i++) {
    const c = PALETTE[(start + i) % PALETTE.length];
    if (best === null || uses.get(c) < uses.get(best)) best = c;
  }
  return best;
}

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

// "#abc", "abc", "#aabbcc", "aabbcc" or "#aabbccdd" to "#aabbcc"; anything else to null.
export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/^#?/, "#");
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return "#" + [...m[1]].map((d) => d + d).join("");
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  return m ? "#" + m[1] : null;
}

// JSONC text to a plain object; null for empty or missing text; throws when
// there is text that doesn't parse, so callers never mistake a typo for "empty".
function parseStrict(text) {
  if (text == null || !String(text).trim()) return null;
  const s = JSON.parse(stripJsonc(String(text)));
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("not a JSON object");
  return s;
}
const parseLoose = (text) => { try { return parseStrict(text); } catch { return null; } };

// The repo's herdr color from .herdr/color.json text: { "color": "#rrggbb", "foreground"?: "#rrggbb" }.
export function colorFromHerdrFile(text) {
  const s = parseLoose(text);
  const bg = normalizeHex(s?.color);
  return bg ? { background: bg, foreground: normalizeHex(s.foreground), source: "repo" } : null;
}

// .herdr/color.json's new text with color set, keeping every other key the
// file had. Throws when the old file has text that doesn't parse.
export function herdrFileText(oldText, hex) {
  return JSON.stringify({ ...(parseStrict(oldText) ?? {}), color: hex }, null, 2) + "\n";
}

// The person's own file in herdr's home:
// { "vscode": true, "repos": { "<repo name>": "#rrggbb" } }.
// ok is false when the file has text that doesn't parse: lookups then act as
// if it were empty, and saves refuse, so a typo never wipes it.
export function parsePersonal(text) {
  let raw;
  try { raw = parseStrict(text) ?? {}; } catch (e) { return { ok: false, error: String(e.message ?? e), raw: null, vscode: true, repos: {} }; }
  const repos = Object.create(null);
  const src = raw.repos && typeof raw.repos === "object" ? raw.repos : {};
  for (const name of Object.keys(src)) {
    const hex = normalizeHex(src[name]);
    if (hex) repos[name] = hex;
  }
  return { ok: true, raw, vscode: raw.vscode !== false, repos };
}

// The personal file's text with one repo's color set, or removed when hex is
// null. Every other key and every other entry (valid or not) is kept.
export function personalText(personal, name, hex) {
  if (!personal.ok) throw new Error(`project-colors.json doesn't parse (${personal.error}); fix it first`);
  const raw = personal.raw ?? {};
  const repos = { ...(raw.repos && typeof raw.repos === "object" ? raw.repos : {}) };
  if (hex) repos[name] = hex; else delete repos[name];
  return JSON.stringify({ ...raw, repos }, null, 2) + "\n";
}

// Where a project's color comes from, first match wins: .herdr/color.json in
// the repo (repoTexts: the worktree's, then the main checkout's), the personal
// file, VS Code (unless switched off), the remembered automatic color.
// Returns { background, foreground|null, source }.
export function resolveColor({ repoTexts = [], personal, name, vscodeText, assigned }) {
  for (const text of repoTexts) {
    const repo = colorFromHerdrFile(text);
    if (repo) return repo;
  }
  const mine = personalColor(personal, name);
  if (mine) return { background: mine, foreground: null, source: "personal" };
  if (personal?.vscode !== false) {
    const vs = colorFromSettings(vscodeText);
    if (vs) return { ...vs, source: "vscode" };
  }
  return { background: assignColor(name, assigned), foreground: null, source: "auto" };
}

// The project's own colors from .vscode/settings.json text, or null.
// Returns { background, foreground|null, source }.
export function colorFromSettings(text) {
  const s = parseLoose(text);
  if (!s) return null;
  const cc = s["workbench.colorCustomizations"];
  const bg = normalizeHex(cc?.["titleBar.activeBackground"]);
  if (bg) return { background: bg, foreground: normalizeHex(cc?.["titleBar.activeForeground"]), source: "titleBar.activeBackground" };
  const peacock = normalizeHex(s["peacock.color"]);
  if (peacock) return { background: peacock, foreground: null, source: "peacock.color" };
  return null;
}

// Black or white text, whichever reads better on the background (WCAG luminance).
export function textOn(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.179 ? "#000000" : "#ffffff";
}

// Merges project colors into herdr's shared "space.colors" map.
// current: the map as it is (theme names like "ansi6" that herdr assigned, or
// "#rrggbb"); written: what this mod wrote last time; found: space id -> hex;
// live: the ids of spaces that exist now (written forgets the others).
// A space's entry is replaced only when it is missing, a theme name (herdr's
// automatic pick) or exactly what this mod wrote before, so a hex color the
// person picked stays. Returns the new maps and whether anything changed.
export function mergeSpaceColors(current, written, found, live = null) {
  const colors = { ...current };
  const mine = { ...written };
  let changed = false;
  if (live) for (const id of Object.keys(mine)) if (!live.has(id)) { delete mine[id]; changed = true; }
  for (const [id, hex] of Object.entries(found)) {
    const now = colors[id];
    const ours = now === undefined || !String(now).startsWith("#") || now === mine[id];
    if (!ours) { if (id in mine) { delete mine[id]; changed = true; } continue; }
    if (now !== hex) { colors[id] = hex; changed = true; }
    if (mine[id] !== hex) { mine[id] = hex; changed = true; }
  }
  return { colors, written: mine, changed };
}

// Splits a command line into words, honouring '...' and "..." quotes.
export function splitWords(line) {
  const words = [];
  let cur = null, quote = null;
  for (const ch of String(line ?? "")) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur ??= ""; continue; }
    if (/\s/.test(ch)) { if (cur !== null) { words.push(cur); cur = null; } continue; }
    cur = (cur ?? "") + ch;
  }
  if (cur !== null) words.push(cur);
  return words;
}

// `docker exec` / `podman exec` options that take a value.
const EXEC_VALUE_OPTS = new Set(["-u", "--user", "-e", "--env", "-w", "--workdir", "--env-file", "--detach-keys"]);

// The container a herdr machine reaches through `docker exec` or `podman
// exec`, from its `hc machine ls` target, and the command that reaches the
// engine the same way (sudo, a full binary path, --context or -H kept), so
// `inspect` asks the same engine:
//   "docker.exe exec -i --user vscode some_container sh -c"
//     -> { engine: ["docker.exe"], container: "some_container" }
//   "sudo /usr/bin/docker --context prod exec -it -u me box bash -c"
//     -> { engine: ["sudo", "/usr/bin/docker", "--context", "prod"], container: "box" }
// docker compose targets name a service, not a container: null.
export function containerFromTarget(target) {
  const w = splitWords(target);
  const bin = w.findIndex((x) => /(^|[\\/])(docker|podman)(\.exe)?$/i.test(x));
  if (bin < 0 || w.includes("compose")) return null;
  const exec = w.indexOf("exec", bin + 1);
  if (exec < 0) return null;
  let i = exec + 1;
  while (i < w.length && w[i].startsWith("-")) i += EXEC_VALUE_OPTS.has(w[i]) ? 2 : 1;
  const container = w[i];
  if (!container) return null;
  return { engine: [...w.slice(0, bin).filter((x) => x === "sudo"), ...w.slice(bin, exec)], container };
}

// A dev container's repo from its devcontainer.config_file label: the repo's
// name, the folder the label names (a host path: on this computer only if the
// caller finds the config file there, since the engine may be remote), and
// where the repo is inside the container when that is "/workspaces/<repo>".
// Configs nested under .devcontainer/<name>/ count; a path with ".." doesn't.
export function repoFromConfigFile(path) {
  const p = String(path ?? "").replace(/\\/g, "/");
  if (p.split("/").includes("..")) return null;
  const m = /^(.*?)\/\.devcontainer\/.+$/.exec(p);
  if (!m || !m[1]) return null;
  const root = m[1];
  const inside = root.startsWith("/workspaces/");
  return { name: baseName(root), hostRoot: inside ? null : root, containerRoot: inside ? root : null, configFile: p };
}

const isAbsolute = (p) => /^([A-Za-z]:)?[\\/]/.test(p);

// Joins a relative path onto a folder and resolves "." and "..", keeping the
// folder's separator style. Absolute paths come back as they are.
export function resolvePath(base, rel) {
  if (isAbsolute(rel)) return rel.replace(/[\\/]+$/, "");
  const sep = String(base).includes("\\") && !String(base).includes("/") ? "\\" : "/";
  const parts = String(base).replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const seg of String(rel).split(/[\\/]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (parts.length > 1) parts.pop(); } else parts.push(seg);
  }
  return parts.join(sep);
}

// From `git rev-parse --show-toplevel --git-common-dir` run in cwd: the
// checkout's root, the main checkout's root (differs in a worktree) and the
// repo's name, so a worktree at <dir>/<repo>/<branch> is named after the repo.
// Works on old git too: the common dir may be relative to cwd, and any line a
// git that doesn't know an option echoes back ("--...") is skipped.
// Bare-repo layouts (common dir "proj.git" or "proj/.bare") are named after
// the repo, and have no main checkout to write to, so mainRoot is the worktree.
export function repoFromGit(stdout, cwd) {
  const lines = String(stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("--"));
  const [top, rawCommon] = lines;
  if (!top) return null;
  const common = rawCommon ? resolvePath(cwd ?? top, rawCommon) : null;
  if (!common) return { root: top, mainRoot: top, name: baseName(top) };
  if (/[\\/]\.git$/.test(common)) {
    const main = common.replace(/[\\/]\.git$/, "");
    return { root: top, mainRoot: main, name: baseName(main) || baseName(top) };
  }
  // Bare: ".../proj.git" -> "proj"; ".../proj/.bare" -> "proj".
  const last = baseName(common);
  const name = last.startsWith(".") ? baseName(common.slice(0, -last.length)) : last.replace(/\.git$/, "");
  return { root: top, mainRoot: top, name: name || baseName(top) };
}

// Last path segment, for "/workspaces/web-shop" or "X:\\web-shop" alike.
export function baseName(path) {
  return String(path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

// ---- Writing .herdr/color.json safely ----

// A PowerShell single-quoted literal: nothing inside is interpreted.
export const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// PowerShell -EncodedCommand payload: base64 of UTF-16LE. The whole script,
// paths included, travels as [A-Za-z0-9+/=], so cmd.exe and argument quoting
// never see a path.
export function psEncode(script) {
  const bytes = [];
  for (let i = 0; i < script.length; i++) { const c = script.charCodeAt(i); bytes.push(c & 255, c >> 8); }
  return base64(bytes);
}

// UTF-8 text as base64. Arguments to machines reached through `docker exec ...
// sh -c` lose backslashes on the way, so the sh scripts get every argument in
// this form ([A-Za-z0-9+/=] only) and decode it there.
export function b64(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return base64(bytes);
}

function base64(bytes) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += abc[n >> 18] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
  }
  return out;
}

// Refuses a .herdr folder or color.json that is a link (a repo could ship one
// pointing anywhere), then writes through a temp file and a rename.
export function psWriteScript(dir, file, text) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { [Console]::Out.WriteLine($_.Exception.Message); exit 1 }
$d = ${psQuote(dir)}; $f = ${psQuote(file)}
function Linked($p) { (Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
if (Linked $d) { throw '.herdr is a link; not writing through it' }
$p = Split-Path -LiteralPath $d -Parent
if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw "the repo folder isn't on this computer: $p" }
[void][IO.Directory]::CreateDirectory($d)
if (Linked $f) { throw '.herdr/color.json is a link; not writing through it' }
$t = "$f.tmp"
[IO.File]::WriteAllText($t, ${psQuote(text)}, (New-Object Text.UTF8Encoding $false))
Move-Item -LiteralPath $t -Destination $f -Force`;
}

// Removes color.json, then .herdr only if that left it empty; never follows links.
export function psRemoveScript(dir, file) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { [Console]::Out.WriteLine($_.Exception.Message); exit 1 }
$d = ${psQuote(dir)}; $f = ${psQuote(file)}
function Linked($p) { (Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
if (Linked $d) { throw '.herdr is a link; not touching it' }
if (Test-Path -LiteralPath $f) { if (Linked $f) { throw '.herdr/color.json is a link; not touching it' }; Remove-Item -LiteralPath $f -Force }
if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force }`;
}

// Decodes the base64 arguments (see b64) back into $1, $2, $3, keeping
// trailing newlines. GNU, BusyBox and current macOS take -d; older macOS -D.
const SH_DECODE = `if printf 'YQ==' | base64 -d >/dev/null 2>&1; then D=-d; else D=-D; fi
dec() { printf '%s' "$1" | base64 $D 2>/dev/null; }
a=$(dec "$1"; printf x); a=\${a%x}; b=$(dec "$2"; printf x); b=\${b%x}; c=$(dec "\${3:-}"; printf x); c=\${c%x}
[ -n "$a" ] && [ -n "$b" ] || { echo "could not read the arguments (is base64 installed?)" >&2; exit 5; }
set -- "$a" "$b" "$c"`;

// The same for sh (containers, Linux and macOS machines): $1 dir, $2 file, $3
// text, each base64 (b64). The repo folder must already exist (only .herdr is
// created), so a path that isn't on this machine fails instead of growing a
// stray folder tree.
export const SH_WRITE = `set -e
${SH_DECODE}
[ -L "$1" ] && { echo ".herdr is a link; not writing through it" >&2; exit 3; }
[ -d "$(dirname "$1")" ] || { echo "the repo folder isn't on this machine: $(dirname "$1")" >&2; exit 4; }
[ -d "$1" ] || mkdir "$1"
[ -L "$2" ] && { echo ".herdr/color.json is a link; not writing through it" >&2; exit 3; }
printf '%s' "$3" > "$2.tmp.$$"
mv -f "$2.tmp.$$" "$2"`;
// A failed rm fails the script (so Clear doesn't report success); Finder's
// .DS_Store doesn't keep an otherwise empty .herdr alive.
export const SH_REMOVE = `${SH_DECODE}
[ -L "$1" ] && { echo ".herdr is a link; not touching it" >&2; exit 3; }
[ -L "$2" ] && { echo ".herdr/color.json is a link; not touching it" >&2; exit 3; }
rm -f "$2" || exit 1
[ -e "$2" ] && { echo "could not remove $2" >&2; exit 1; }
rm -f "$1/.DS_Store" 2>/dev/null
rmdir "$1" 2>/dev/null
exit 0`;
