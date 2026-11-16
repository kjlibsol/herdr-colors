import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, exec, readTextFile, setWindowTitle, checking, shared, setShared, props } from "herdr";
import { colorFromSettings, hashColor, textOn, baseName, mergeSpaceColors } from "./color.js";

// How often the shown project's settings.json is read again, so a color
// edited in VS Code shows up without switching spaces.
const REFRESH_MS = 30000;

export default class ProjectColor extends View {
  init(_props, cx) {
    this.cache = {};      // "machine|cwd" -> { root, name, background, foreground, source }
    this.loading = {};    // keys with a lookup in flight, so renders never stack lookups
    this.title = undefined;
    if (checking()) return;
    cx.timer.every(REFRESH_MS, (cx) => {
      const key = this.key(spaces().find((s) => s.active));
      if (key) { delete this.cache[key]; this.lookup(key, cx); }
    });
  }

  // Where the space's project is: its first terminal's live folder, as herdr's
  // own mods take a space's repo, else the folder new terminals start in.
  where(space) {
    const tabs = new Set(space.tabs.map((t) => t.id));
    const first = panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd);
    return first?.cwd ?? space.folder ?? "";
  }

  key(space) {
    return space ? `${space.machine ?? ""}|${this.where(space)}` : null;
  }

  lookup(key, cx) {
    if (this.loading[key] || this.cache[key]) return;
    this.loading[key] = true;
    const sep = key.indexOf("|");
    const machine = key.slice(0, sep) || null;
    const cwd = key.slice(sep + 1);
    cx.spawn(async (cx) => {
      let root = cwd;
      try {
        const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { on: machine, timeout: 5000 });
        if (r.code === 0 && r.stdout.trim()) root = r.stdout.trim();
      } catch { /* machine offline or no git: keep the folder */ }
      let found = null;
      try {
        found = colorFromSettings(await readTextFile(`${root.replace(/[\\/]+$/, "")}/.vscode/settings.json`, { on: machine }));
      } catch { /* unreadable: fall back to the hash */ }
      const name = baseName(root) || "~";
      this.cache[key] = found
        ? { root, name, ...found }
        : { root, name, background: hashColor(name), foreground: null, source: "hash" };
      delete this.loading[key];
      cx.notify();
    });
  }

  // Publishes every space's project color in shared "space.colors", which the
  // spaces sidebar and the picker already paint their space tiles from.
  publish(list) {
    const found = {};
    for (const s of list) {
      const c = this.cache[this.key(s)];
      if (c) found[s.id] = c.background;
    }
    const { colors, written, changed } = mergeSpaceColors(shared("space.colors") ?? {}, shared("project-color.written") ?? {}, found);
    if (!changed) return;
    setShared("project-color.written", written);
    setShared("space.colors", colors);
  }

  render(cx) {
    const list = spaces();
    const space = list.find((s) => s.active);
    if (!checking()) {
      for (const s of list) this.lookup(this.key(s), cx);
      this.publish(list);
    }
    const key = this.key(space);
    const c = key ? this.cache[key] : null;

    const title = space ? `${space.name} - Herdr` : null;
    if (title !== this.title && !checking()) { this.title = title; setWindowTitle(title); }

    // props { bar: false }: only look up and publish colors (for the tinted tab
    // bar), drawn nowhere; give its block { "px": 0 }.
    if (props()?.bar === false || !space || !c) return div().size_full();
    const fg = c.foreground ?? textOn(c.background);
    return h_flex().id("project-color").size_full().px(12).gap(10).items_center()
      .bg(c.background).text_color(fg).text_size(12.5)
      .child(div().font_semibold().truncate().child(space.name))
      .when(Boolean(space.branch), (el) => el.child(div().opacity(0.8).truncate().child(space.branch)))
      .child(div().flex_1())
      .when(Boolean(space.machine), (el) => el.child(div().opacity(0.8).child(space.machine)));
  }
}
