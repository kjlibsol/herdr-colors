import assert from "node:assert/strict";
import { test } from "node:test";
import {
  stripJsonc, normalizeHex, colorFromSettings, textOn, baseName, mergeSpaceColors,
  resolveColor, parsePersonal, personalText, herdrFileText, colorFromHerdrFile,
  containerFromTarget, repoFromConfigFile, repoFromGit, PALETTE, PRESETS, hashIndex, assignColor,
  psQuote, psEncode, personalColor, nameKey, SH_WRITE, SH_REMOVE, b64,
} from "../mods/project-color/color.js";

test("JSONC with comments and trailing commas", () => {
  const text = `{
    // a comment
    "url": "http://example.com/a//b", /* block */
    "workbench.colorCustomizations": {
      "titleBar.activeBackground": "#7D6608",
      "titleBar.activeForeground": "#fff",
    },
  }`;
  assert.equal(JSON.parse(stripJsonc(text)).url, "http://example.com/a//b");
  assert.deepEqual(colorFromSettings(text), { background: "#7d6608", foreground: "#ffffff", source: "titleBar.activeBackground" });
});

test("peacock.color, no color, broken file", () => {
  assert.deepEqual(colorFromSettings(`{ "peacock.color": "#42b883" }`), { background: "#42b883", foreground: null, source: "peacock.color" });
  assert.equal(colorFromSettings(`{ "editor.tabSize": 2 }`), null);
  assert.equal(colorFromSettings(`{ nope`), null);
  assert.equal(colorFromSettings(null), null);
});

test("hex: with or without #, short, with alpha, junk", () => {
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("f1c40f"), "#f1c40f");
  assert.equal(normalizeHex(" #11223344 "), "#112233");
  assert.equal(normalizeHex("#f1c40"), null);
  assert.equal(normalizeHex("red"), null);
});

test("palette: 14 distinct colors, white text on all, presets are the palette", () => {
  assert.equal(PALETTE.length, 14);
  assert.equal(new Set(PALETTE).size, 14);
  for (const c of PALETTE) assert.equal(textOn(c), "#ffffff", c);
  assert.deepEqual(PRESETS, PALETTE);
});

test("automatic colors: remembered, least used first, case-blind", () => {
  const a = {};
  const names = Array.from({ length: 14 }, (_, i) => `repo-${i}`);
  for (const n of names) a[n] = assignColor(n, a);
  assert.equal(new Set(Object.values(a)).size, 14, "14 projects get 14 different colors");
  assert.equal(assignColor("repo-3", a), a["repo-3"], "a known project keeps its color");
  assert.equal(assignColor("REPO-3", a), a["repo-3"]);
  assert.equal(assignColor("fresh", {}), PALETTE[hashIndex("fresh")], "the first one starts at its hash");
});

test("lookup order: repo file (worktree, then main), personal, VS Code, automatic", () => {
  const vscodeText = `{ "workbench.colorCustomizations": { "titleBar.activeBackground": "#7d6608" } }`;
  const personal = parsePersonal(`{ "repos": { "demo": "#922b21", "bad": "nope" } }`);
  assert.equal(resolveColor({ repoTexts: [null, `{ "color": "#007ACC" }`], personal, name: "demo", vscodeText }).background, "#007acc");
  assert.equal(resolveColor({ repoTexts: [`{ "color": "#111111" }`, `{ "color": "#222222" }`], personal, name: "demo" }).background, "#111111");
  assert.deepEqual(resolveColor({ personal, name: "demo", vscodeText }), { background: "#922b21", foreground: null, source: "personal" });
  assert.equal(resolveColor({ personal, name: "other", vscodeText }).source, "vscode");
  assert.equal(resolveColor({ repoTexts: [`{ "color": "red" }`], personal, name: "other" }).source, "auto");
});

test("VS Code import can be switched off", () => {
  const vscodeText = `{ "peacock.color": "#42b883" }`;
  assert.equal(resolveColor({ personal: parsePersonal(`{ "vscode": false }`), name: "x", vscodeText }).source, "auto");
  assert.equal(resolveColor({ personal: parsePersonal(null), name: "x", vscodeText }).source, "vscode");
});

test("a typo in the personal file never wipes it", () => {
  const broken = parsePersonal(`{ "repos": { "a": "#111111" } oops }`);
  assert.equal(broken.ok, false);
  assert.throws(() => personalText(broken, "b", "#222222"), /doesn't parse/);
  assert.equal(resolveColor({ personal: broken, name: "a" }).source, "auto", "lookups treat it as empty");
});

test("personal file: other keys and invalid entries are kept", () => {
  const p = parsePersonal(`{ "vscode": false, "note": "kept", "repos": { "a": "#111111", "odd": "not a color" } }`);
  assert.deepEqual(JSON.parse(personalText(p, "b", "#222222")), { vscode: false, note: "kept", repos: { a: "#111111", odd: "not a color", b: "#222222" } });
  assert.deepEqual(JSON.parse(personalText(p, "a", null)).repos, { odd: "not a color" });
});

test("repo names like constructor or __proto__ don't break anything", () => {
  const p = parsePersonal(`{ "repos": {} }`);
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const c = resolveColor({ personal: p, name, assigned: {} });
    assert.equal(typeof c.background, "string", name);
    assert.ok(PALETTE.includes(c.background), name);
    assert.ok(PALETTE.includes(assignColor(name, {})), name);
  }
});

test(".herdr/color.json: saving keeps other keys, refuses a broken file", () => {
  assert.deepEqual(JSON.parse(herdrFileText(`{ "color": "#000000", "foreground": "#ffffff" }`, "#1d4ed8")), { color: "#1d4ed8", foreground: "#ffffff" });
  assert.deepEqual(colorFromHerdrFile(herdrFileText(null, "#7d6608")), { background: "#7d6608", foreground: null, source: "repo" });
  assert.throws(() => herdrFileText(`{ broken`, "#7d6608"));
});

test("space colors: replaces herdr's picks and our own, keeps a person's hex, forgets closed spaces", () => {
  const current = { a: "ansi6", b: "#123456", c: "#abcdef", e: "ansi2" };
  const written = { b: "#123456", gone: "#000000" };
  const found = { a: "#7d6608", b: "#922b21", c: "#007acc", d: "#1e8449" };
  const r = mergeSpaceColors(current, written, found, new Set(["a", "b", "c", "d", "e"]));
  assert.deepEqual(r.colors, { a: "#7d6608", b: "#922b21", c: "#abcdef", d: "#1e8449", e: "ansi2" });
  assert.deepEqual(r.written, { a: "#7d6608", b: "#922b21", d: "#1e8449" });
  assert.equal(mergeSpaceColors(r.colors, r.written, found, new Set(["a", "b", "c", "d", "e"])).changed, false, "running again changes nothing");
});

test("machines: container and engine from many target shapes", () => {
  const t = containerFromTarget;
  assert.deepEqual(t("docker.exe exec -i --user vscode some_container sh -c"), { engine: ["docker.exe"], container: "some_container" });
  assert.deepEqual(t("docker exec -i box sh -c"), { engine: ["docker"], container: "box" });
  assert.deepEqual(t("sudo /usr/bin/docker --context prod exec -it -u me -e A=1 box bash -c"), { engine: ["sudo", "/usr/bin/docker", "--context", "prod"], container: "box" });
  assert.deepEqual(t("podman exec -i box /bin/sh -c"), { engine: ["podman"], container: "box" });
  assert.deepEqual(t('"/Users/John Doe/.docker/bin/docker" exec -i box sh -c'), { engine: ["/Users/John Doe/.docker/bin/docker"], container: "box" });
  assert.deepEqual(t("docker -H ssh://me@host exec box sh -c"), { engine: ["docker", "-H", "ssh://me@host"], container: "box" });
  assert.equal(t("docker compose exec app sh -c"), null);
  assert.equal(t("ssh me@box"), null);
  assert.equal(t(""), null);
});

test("machines: repo from devcontainer label", () => {
  assert.deepEqual(repoFromConfigFile("x:\\demo\\.devcontainer\\devcontainer.json"), { name: "demo", hostRoot: "x:/demo", containerRoot: null, configFile: "x:/demo/.devcontainer/devcontainer.json" });
  assert.equal(repoFromConfigFile("/Users/me/My Proj/.devcontainer/devcontainer.json").hostRoot, "/Users/me/My Proj");
  assert.equal(repoFromConfigFile("/workspaces/Demo/.devcontainer/devcontainer.json").containerRoot, "/workspaces/Demo");
  assert.equal(repoFromConfigFile("/workspaces/demo/.devcontainer/python/devcontainer.json").name, "demo");
  assert.equal(repoFromConfigFile("/workspaces/../../root/.devcontainer/devcontainer.json"), null);
  assert.equal(repoFromConfigFile(""), null);
});

test("git: worktrees, old git, relative and bare common dirs", () => {
  // Current git, absolute common dir.
  assert.deepEqual(repoFromGit("/home/me/.herdr/worktrees/demo/login\n/workspaces/demo/.git\n", "/home/me/.herdr/worktrees/demo/login"),
    { root: "/home/me/.herdr/worktrees/demo/login", mainRoot: "/workspaces/demo", name: "demo" });
  // Main checkout, common dir relative to cwd (a subfolder).
  assert.deepEqual(repoFromGit("X:/demo\n../.git\n", "X:/demo/src"), { root: "X:/demo", mainRoot: "X:/demo", name: "demo" });
  // Old git echoing an option it doesn't know.
  assert.deepEqual(repoFromGit("/w/demo/feat\n--path-format=absolute\n/w/demo/.git\n", "/w/demo/feat"), { root: "/w/demo/feat", mainRoot: "/w/demo", name: "demo" });
  // Bare layouts.
  assert.deepEqual(repoFromGit("/srv/wt/main\n/srv/proj.git\n", "/srv/wt/main"), { root: "/srv/wt/main", mainRoot: "/srv/wt/main", name: "proj" });
  assert.deepEqual(repoFromGit("/srv/proj/main\n/srv/proj/.bare\n", "/srv/proj/main"), { root: "/srv/proj/main", mainRoot: "/srv/proj/main", name: "proj" });
  assert.equal(repoFromGit("", "/x"), null);
});

test("repo names: case and Unicode form don't matter", () => {
  const p = parsePersonal(`{ "repos": { "MyApp": "#111111", "bl\u00e5b\u00e6r": "#222222" } }`);
  assert.equal(personalColor(p, "myapp"), "#111111");
  assert.equal(personalColor(p, "bla\u030ab\u00e6r"), "#222222", "decomposed å matches composed");
  assert.equal(nameKey("Bla\u030a"), nameKey("bl\u00e5"));
});

test("b64: UTF-8 round trip with backslashes, quotes and newlines", () => {
  const s = '{"a":"x\\ny \\\\ z","b":"é ✓ 𝄞"}\n';
  assert.equal(Buffer.from(b64(s), "base64").toString("utf8"), s);
  assert.match(b64(s), /^[A-Za-z0-9+/]+=*$/);
});

test("sh scripts: Clear fails loudly, write needs the repo folder, .DS_Store doesn't block", () => {
  assert.match(SH_REMOVE, /rm -f "\$2" \|\| exit 1/);
  assert.match(SH_REMOVE, /\.DS_Store/);
  assert.doesNotMatch(SH_WRITE, /mkdir -p/);
});

test("PowerShell: quoting and encoding keep paths out of any parser", () => {
  assert.equal(psQuote("X:\\R&D's %TEMP% ^x"), "'X:\\R&D''s %TEMP% ^x'");
  assert.match(psEncode("Write-Output 'ok & done'"), /^[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(psEncode("hé"), "base64").toString("utf16le"), "hé");
});

test("contrast and base names", () => {
  assert.equal(textOn("#7d6608"), "#ffffff");
  assert.equal(textOn("#f1c40f"), "#000000");
  assert.equal(baseName("/workspaces/demo/"), "demo");
  assert.equal(baseName("X:\\herdr-colors"), "herdr-colors");
});
