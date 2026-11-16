// Builds the project-color versions of four of Herdr's shipped mods:
//
//   project-color-tabs    the tab bar, with the shown space's color behind the tabs
//   project-color-agents  the agents panel: each agent's space color as a stripe,
//                         a dot on space headers; right-click opens the color picker
//   project-color-spaces  the spaces sidebar: machine rows get a tile in their
//                         color; right-click a machine opens the picker, a space
//                         opens the menu below
//   project-color-menu    the right-click menu, with "Color..." for spaces
//
// They read the colors project-color publishes in shared state. They are
// built from the copies in your own Herdr (not shipped in this repo), so
// rerun after a Herdr update:
//
//   node tools/build-clones.mjs [herdr home]   (default $HERDR_APP_HOME, else ~/.config/herdr-app)
//
// Writes into the repo's mods/. Checks every patch first and exits nonzero,
// writing nothing, if a shipped mod no longer has the code it hooks into.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.argv[2] ?? process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
if (!existsSync(join(home, "mods", "tabs", "main.js"))) {
  console.error(`build-clones: no Herdr mods in ${home}; pass Herdr's home folder (default $HERDR_APP_HOME, else ~/.config/herdr-app)`);
  process.exit(1);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// The picker as a popup: for a space id or a machine name (expressions).
const PICKER_W = 320, PICKER_H = 430;
const openPicker = (what) => `openOverlay({ mod: "project-color", kind: "popup", width: ${PICKER_W}, height: ${PICKER_H}, props: { picker: true, ${what} } })`;
const rightClick = (what) => `.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); ${openPicker(what)}; })`;

const HELPER = `
// project-color: colors from shared state ("space.colors": a picked #rrggbb
// or a theme color name herdr assigned; "project-color.machines").
const PC_MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function pcLum(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
const pcTextOn = (hex) => (pcLum(hex) > 0.179 ? "#000000" : "#ffffff");
const pcHex = (t, c) => (!c ? null : c.startsWith("#") ? c : PC_MARK[c] ?? t[c] ?? null);
function pcSpaceColor(t, id) {
  return pcHex(t, (shared("space.colors") ?? {})[id]) ?? t.dim;
}
// A small mark (stripe, dot) on the panel background: lifted toward white on
// a dark theme so a deep project color still stands out.
function pcMark(t, id) {
  const c = pcSpaceColor(t, id);
  if (!c.startsWith("#") || pcLum(t.chrome ?? "#000000") > 0.2) return c;
  const n = parseInt(c.slice(1, 7), 16);
  const up = (v) => Math.round(v + (255 - v) * 0.3).toString(16).padStart(2, "0");
  return "#" + up(n >> 16) + up((n >> 8) & 255) + up(n & 255);
}
// Colors for a bar painted in the space's color. Without a color, the theme's own.
function pcBar(t, space) {
  const bg = space ? pcHex(t, (shared("space.colors") ?? {})[space.id]) : null;
  if (!bg) return { bg: t.chrome, muted: t.muted, dim: t.dim, line: t.border };
  const fg = pcTextOn(bg);
  return { bg, muted: fg + "f2", dim: fg + "d9", line: bg };
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
        what: "stripe and right-click on the narrow rail row",
        find: /(\.on_click\(\(\) => run\("pane\.focus", \{ pane: a\.pane \}\)\)\n)(\s*)(\.child\(div\(\)\.flex_1\(\)\.min_w\(0\)\.whitespace_nowrap\(\))/,
        add: (_m, click, ind, next) => `${click}${ind}${rightClick("space: a.space")}\n${ind}.child(div().w(6).h(14).flex_none().rounded(2).bg(pcMark(t, a.space)))\n${ind}${next}`,
      },
      {
        what: "stripe and right-click on the agent row",
        find: /(\.on_click\(\(\) => run\("pane\.focus", \{ pane: a\.pane \}\)\)\n)(\s*)(\.when\(Boolean\(pic\))/,
        add: (_m, click, ind, next) => `${click}${ind}${rightClick("space: a.space")}\n${ind}.child(div().w(6).h(16).ml(-4).mr(-3).flex_none().rounded(2).bg(pcMark(t, a.space)))\n${ind}${next}`,
      },
      {
        what: "dot and right-click on the space header",
        find: /(\s*)(\.child\(div\(\)\.truncate\(\)\.text_color\(t\[g\.status\] \?\? t\.dim\)\.child\(g\.label\)\))/,
        add: (_m, ind, label) => `${ind}.when(g.id.startsWith("sp-"), (el) => el${rightClick("space: g.id.slice(3)")}.child(div().size(7).flex_none().rounded(4).bg(pcMark(t, g.id.slice(3)))))${ind}${label}`,
      },
    ],
  },
  {
    from: "spaces",
    to: "project-color-spaces",
    patches: [
      helper,
      {
        what: "machine icon as a tile in the machine's color, faded when not connected",
        find: /const icon = svg\(`mods\/workspace-chrome\/\$\{m \? "server" : "monitor"\}\.svg`\)\.size\(13\)\.flex_none\(\);/,
        add: (m) => `const pcM = m ? (shared("project-color.machines") ?? {})[m] : null;
      ${m.replace("const icon =", "const pcPlain =")}
      const icon = pcM
        ? h_flex().size(16).flex_none().rounded(4).bg(pcM).items_center().justify_center().when(!connected, el => el.opacity(0.45))
          .child(svg("mods/workspace-chrome/server.svg").size(11).text_color(pcTextOn(pcM)))
        : pcPlain;`,
      },
      {
        what: "space right-click opens the menu with Color...",
        find: /openOverlay\(\{ mod: "menu", kind: "popup", width: 200, height: 260, props: \{ tab: "space", target: \{ id: w\.id \} \} \}\);/,
        add: (m) => m.replace('mod: "menu"', 'mod: "project-color-menu"').replace("height: 260", "height: 300"),
      },
      {
        what: "machine row right-click opens the picker",
        find: /(\.cursor_pointer\(\)\.hover\(s => s\.bg\(t\.hover\)\)\n)(\s*)(\.on_click\(\(_e, cx\) => \{\n\s*if \(collapsed && login\))/,
        add: (_m, hover, ind, click) => `${hover}${ind}.when(Boolean(m), el => el${rightClick("machine: m")})\n${ind}${click}`,
      },
    ],
  },
  {
    from: "menu",
    to: "project-color-menu",
    patches: [
      {
        what: "Color... in the space menu",
        find: /(\n(\s*)\["Close", "space\.close", \{ id: tg\.id \}\],)/,
        add: (_m, line, ind) => `\n${ind}["Color…", "project-color", { space: tg.id }],${line}`,
      },
      {
        what: "Color... opens the picker",
        find: /(\n(\s*)else run\(it\[1\], it\[2\]\);)/,
        add: (_m, line, ind) => `\n${ind}else if (it[1] === "project-color") ${openPicker("...it[2]")};${line}`,
      },
      {
        what: "palette icon for Color...",
        find: /(function menuIcon\(command\) \{\n)/,
        add: (m) => `${m}  if (command === "project-color") return "mods/project-color/palette.svg";\n`,
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
        what: "the bar can hold the traffic-light backdrop",
        find: /return h_flex\(\)\.size_full\(\)\.min_w\(0\)\.px\(10\)\.pl\(lightsPadding\)/,
        add: () => "return h_flex().relative().size_full().min_w(0).px(10).pl(lightsPadding)",
      },
      {
        what: "macOS traffic lights keep the plain bar behind them",
        find: /(\n(\s*)\.on_scroll_wheel\(e => this\.wheel\(e\)\))/,
        add: (_m, line, ind) => `${line}\n${ind}.when(lightsPadding > 10 && pc.bg !== t.chrome, el => el.child(div().absolute().left(0).top(0).bottom(0).w(lightsPadding - 4).bg(t.chrome)))`,
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
  if (code.includes("project-color")) {
    console.error(`build-clones: ${file} already mentions project-color; is it a patched copy? Use Herdr's own mods.`);
    process.exit(1);
  }
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
