// Builds the project-color versions of two of Herdr's shipped mods:
//
//   project-color-agents  the agents panel, plus each agent's space color as a
//                         stripe on its row and a dot on its space header
//   project-color-tabs    the tab bar, with the shown space's color behind the tabs
//
// Both read the colors project-color publishes in shared "space.colors".
// Rerun after a Herdr update to pick up its changes:
//
//   node tools/build-clones.mjs [herdr home]   (default ~/.config/herdr-app)
//
// Writes into the repo's mods/. Checks every patch first and exits nonzero,
// writing nothing, if a shipped mod no longer has the code it hooks into.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.argv[2] ?? join(homedir(), ".config", "herdr-app");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELPER = `
// project-color: a space's color as the spaces sidebar draws it (shared
// "space.colors": a picked #rrggbb, or a theme color name herdr assigned).
const PC_MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function pcSpaceColor(t, id) {
  const c = (shared("space.colors") ?? {})[id];
  if (!c) return t.dim;
  return c.startsWith("#") ? c : PC_MARK[c] ?? t[c] ?? t.dim;
}
// Colors for a bar painted in the space's color: black or white text by WCAG
// luminance, as project-color's bar does. Without a color, the theme's own.
function pcBar(t, space) {
  const c = space ? (shared("space.colors") ?? {})[space.id] : null;
  const bg = !c ? null : c.startsWith("#") ? c : PC_MARK[c] ?? null;
  if (!bg) return { bg: t.chrome, muted: t.muted, dim: t.dim, line: t.border };
  const n = parseInt(bg.slice(1, 7), 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const fg = L > 0.179 ? "#000000" : "#ffffff";
  return { bg, muted: fg + "d9", dim: fg + "a6", line: bg };
}
`;

const helper = {
  what: "helper after the herdr import",
  find: /^import \{[^}]*\bshared\b[^}]*\} from "herdr";\n/m,
  add: (m) => m + HELPER,
};

const CLONES = [
  {
    from: "agents",
    to: "project-color-agents",
    patches: [
      helper,
      {
        what: "stripe on the narrow rail row",
        find: /(\.on_click\(\(\) => run\("pane\.focus", \{ pane: a\.pane \}\)\)\n)(\s*)(\.child\(div\(\)\.flex_1\(\)\.min_w\(0\)\.whitespace_nowrap\(\))/,
        add: (_m, click, ind, next) => `${click}${ind}.child(div().w(6).h(14).flex_none().rounded(2).bg(pcSpaceColor(t, a.space)))\n${ind}${next}`,
      },
      {
        what: "stripe on the agent row",
        find: /(\.on_click\(\(\) => run\("pane\.focus", \{ pane: a\.pane \}\)\)\n)(\s*)(\.when\(Boolean\(pic\))/,
        add: (_m, click, ind, next) => `${click}${ind}.child(div().w(6).h(16).ml(-4).mr(-3).flex_none().rounded(2).bg(pcSpaceColor(t, a.space)))\n${ind}${next}`,
      },
      {
        what: "dot on the space header",
        find: /(\s*)(\.child\(div\(\)\.truncate\(\)\.text_color\(t\[g\.status\] \?\? t\.dim\)\.child\(g\.label\)\))/,
        add: (_m, ind, label) => `${ind}.when(g.id.startsWith("sp-"), (el) => el.child(div().size(7).flex_none().rounded(4).bg(pcSpaceColor(t, g.id.slice(3)))))${ind}${label}`,
      },
    ],
  },
  {
    from: "tabs",
    to: "project-color-tabs",
    patches: [
      helper,
      {
        what: "bar colors for the shown space",
        find: /(\n(\s*)const space = spaces\(\)\.find\(p => p\.active\);\n)/,
        add: (_m, line, ind) => `${line}${ind}const pc = pcBar(t, space);\n`,
      },
      {
        what: "the bar's background",
        find: /\.items_center\(\)\.bg\(t\.chrome\)\.border_b\(1\)\.border_color\(t\.border\)/,
        add: () => ".items_center().bg(pc.bg).border_b(1).border_color(pc.line)",
      },
      {
        what: "inactive tabs",
        find: /\.border_color\(c\.active \? t\.border : t\.chrome\)\.bg\(c\.active \? t\.raised : t\.chrome\)\.text_color\(c\.active \? t\.foreground : t\.muted\)/,
        add: () => ".border_color(c.active ? t.border : pc.bg).bg(c.active ? t.raised : pc.bg).text_color(c.active ? t.foreground : pc.muted)",
      },
      {
        what: "inactive tab icons",
        find: /svg\(program\.icon\)\.size\(14\)\.text_color\(t\.muted\)/,
        add: () => "svg(program.icon).size(14).text_color(c.active ? t.muted : pc.muted)",
      },
      {
        what: "bar buttons (+, window buttons)",
        find: /\.rounded\(6\)\.text_color\(t\.dim\)\.hover\(s => s\.bg\(t\.hover\)\.text_color\(t\.foreground\)\)/,
        add: () => ".rounded(6).text_color(pc.dim).hover(s => s.bg(t.hover).text_color(t.foreground))",
      },
      {
        what: "panel buttons (Files, Changes)",
        find: /\.bg\(on \? t\.selected : t\.chrome\)\.text_color\(on \? t\.foreground : t\.muted\)/,
        add: () => ".bg(on ? t.selected : pc.bg).text_color(on ? t.foreground : pc.muted)",
      },
    ],
  },
];

// Patch everything in memory first, so a failure writes nothing.
const built = [];
for (const clone of CLONES) {
  const file = join(home, "mods", clone.from, "main.js");
  let code = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const p of clone.patches) {
    const hits = code.match(new RegExp(p.find.source, p.find.flags.replace("g", "") + "g")) ?? [];
    if (hits.length !== 1) {
      console.error(`build-clones: "${p.what}" matched ${hits.length} times in ${file}; Herdr's ${clone.from} mod changed, update tools/build-clones.mjs`);
      process.exit(1);
    }
    code = code.replace(p.find, p.add);
  }
  const manifest = JSON.parse(readFileSync(join(home, "mods", clone.from, "mod.json"), "utf8"));
  built.push({ clone, code, manifest });
}

for (const { clone, code, manifest } of built) {
  const out = join(repo, "mods", clone.to);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "main.js"), `// Generated by tools/build-clones.mjs from Herdr's ${clone.from} mod. Don't edit; rerun the script.\n${code}`);
  writeFileSync(join(out, "mod.json"), JSON.stringify({ ...manifest, place: "none" }) + "\n");
  console.log(`build-clones: wrote ${out}`);
}
