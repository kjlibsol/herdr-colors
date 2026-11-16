import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import {
  spaces, panes, exec, hc, readTextFile, writeTextFile, setWindowTitle, checking,
  shared, setShared, props, appHome, theme, window, closeOverlay, watchFolder,
} from "herdr";
import {
  resolveColor, parsePersonal, personalText, herdrFileText, normalizeHex, textOn,
  baseName, mergeSpaceColors, nameKey, PRESETS, containerFromTarget,
  repoFromConfigFile, repoFromGit, psEncode, psWriteScript, psRemoveScript, SH_WRITE, SH_REMOVE, b64,
  colorFromHerdrFile, isNetworkPath, isInside, linkedPaths,
} from "./color.js";

// How colors are kept fresh without polling:
// - git runs once per folder a space is in, and again only when that repo's
//   .git is gone, the folder itself became a repo, it found no repo, or the
//   machine didn't answer;
// - docker inspect runs once per container (a failed probe isn't kept);
// - the .herdr and .vscode folders of local repos, and the personal file's
//   folder, are watched: an edit shows within about half a second;
// - a timer every minute re-reads the color files (in process here, through the
//   machine for remote spaces), checks repos are still there, and lists machines.
const REFRESH_MS = 60000;
// Watch wake-ups are gathered for this long before anything is re-read.
const SETTLE_MS = 500;
// A read through a machine that takes longer than this counts as unreachable.
const REMOTE_MS = 8000;
const PERSONAL = /[\\/]project-colors\.json$/;

const personalPath = () => `${appHome().replace(/[\\/]+$/, "")}/project-colors.json`;
const trim = (p) => String(p).replace(/[\\/]+$/, "");
// One spelling per local folder, so watches and comparisons line up on Windows.
const norm = (p) => trim(/^[A-Za-z]:/.test(String(p)) ? String(p).replace(/\\/g, "/") : p);
const localWindows = (machine) => !machine && window()?.platform === "windows";
// A local read of our own files: missing or unreadable is simply null.
const read = (path) => readTextFile(path).catch(() => null);
const UNREACHABLE = Symbol("unreachable");

// A read of a repo's file, here or through a machine: null for a missing or
// unreadable file, UNREACHABLE when a machine didn't answer. Both give up
// after REMOTE_MS, so a file that never ends (a link to /dev/zero) or a hung
// machine can't hold a lookup forever; locally that counts as unreadable.
function readOn(path, on, cx) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    cx.timer.after(REMOTE_MS, () => finish(on ? UNREACHABLE : null));
    readTextFile(path, on ? { on } : undefined).then(finish, () => finish(on ? UNREACHABLE : null));
  });
}

// Runs a write or remove of <root>/.herdr/color.json on the space's machine.
// On this Windows computer the script goes to PowerShell encoded, so no path
// ever passes through cmd.exe or argument quoting; elsewhere sh gets the
// paths as separate arguments. Both refuse to follow links.
async function runFileScript(machine, root, { text = null, remove = false }) {
  const dir = `${trim(root)}/.herdr`, file = `${dir}/color.json`;
  let r;
  // The whole file travels on the command line; Windows caps that near 32,000
  // characters, so a color.json over a few kilobytes is refused with a reason.
  if (text && text.length > 6000) throw new Error(".herdr/color.json is too large to rewrite here; edit it by hand");
  if (localWindows(machine)) {
    const win = (p) => p.replace(/\//g, "\\");
    const script = remove ? psRemoveScript(win(dir), win(file)) : psWriteScript(win(dir), win(file), text);
    r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", psEncode(script)], { timeout: 15000 });
  } else {
    // Every argument goes base64: backslashes don't survive `docker exec ... sh -c`.
    r = await exec("sh", remove ? ["-c", SH_REMOVE, "sh", b64(dir), b64(file)] : ["-c", SH_WRITE, "sh", b64(dir), b64(file), b64(text)], { on: machine, timeout: 15000 });
  }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split(/\r?\n/).pop() || `could not change ${file}`);
}

export default class ProjectColor extends View {
  init(_props, cx) {
    // Opened as an overlay (right-click "Color..." on a space, or a click on
    // a machine or agent, or `mod.open project-color`): the picker.
    const p = props();
    if (p?.picker || p?.overlay) return this.initPicker(cx);
    this.cache = {};      // key -> { root, mainRoot, machine, name, background, foreground, source }
    this.repos = {};      // key -> { git, retry, unreachable }: git's answer, kept per folder
    this.labels = {};     // "engine|container" -> { repo, inside }: inspect's answer, kept per container
    this.loading = {};    // key -> the rev it started at
    this.dirty = new Set(); // keys asked to look again while they were looking
    this.noGit = new Set(); // machines ("" = this computer) where git can't start
    this.watches = new Map(); // folder -> { handle, repo } ; repo null for the personal file's folder
    this.unwatchable = new Set(); // folders watchFolder refused: left to the timer until it runs again
    this.settling = null; // { repos: Set, personal: bool } gathered wake-ups
    this.keys = {};       // space id -> key, refreshed each render
    this.saved = shared("project-color.targets")?.spaces ?? {}; // last run's colors, until fresh ones land
    this.title = undefined;
    this.closed = false;
    // This copy, for publisher election. Kept in the copy's own localStorage,
    // which survives a reload (a reload doesn't run close()), so a reloaded
    // publisher carries on at once instead of waiting for its old slot to expire.
    this.id = null;
    try { this.id = localStorage.getItem("pc-id"); } catch {}
    if (!this.id) {
      this.id = Math.random().toString(36).slice(2);
      try { localStorage.setItem("pc-id", this.id); } catch {}
    }
    this.rev = shared("project-color.rev") ?? 0;
    if (checking()) return;
    this.lookupMachines(cx);
    this.watch(norm(appHome()), null, cx);
    cx.timer.every(REFRESH_MS, (cx) => {
      this.unwatchable.clear();
      this.reread(cx, null, true);
    });
  }

  async close() {
    if (this.picking) return;
    this.closed = true;
    // Only the copy that publishes owns the title and the publisher slot.
    if (shared("project-color.publisher")?.id === this.id) {
      setWindowTitle(null);
      setShared("project-color.publisher", null);
    }
    for (const w of this.watches.values()) w.handle?.cancel?.();
    this.watches.clear();
  }

  // Only one copy publishes (two copies whose lookups differ for a moment
  // would otherwise overwrite each other's colors back and forth). The
  // publisher renews a heartbeat; another copy takes over if it goes quiet.
  publisher() {
    const p = shared("project-color.publisher"), now = Date.now();
    if (p && p.id !== this.id && now - p.at < 150000) return false;
    if (!p || p.id !== this.id || now - p.at > 30000) setShared("project-color.publisher", { id: this.id, at: now });
    return true;
  }

  // Automatic colors counted among the projects in use now (open spaces and
  // known machines), so names of repos long gone don't crowd the palette;
  // every name keeps the color it was given.
  inUse(name) {
    const all = this.assigned(), live = new Set([nameKey(name)]);
    for (const c of Object.values(this.cache)) if (c?.name) live.add(nameKey(c.name));
    for (const m of Object.values(this.machineInfo ?? {})) if (m?.name) live.add(nameKey(m.name));
    return Object.fromEntries(Object.entries(all).filter(([k]) => live.has(k)));
  }

  // Looks again. repos: a Set of local repo roots to limit it to, or null for
  // every space; check: also make sure known repos are still there (timer).
  reread(cx, repos = null, check = false) {
    for (const s of spaces()) {
      const key = this.keys[s.id] ?? this.key(s);
      if (repos) {
        const g = this.repos[key]?.git;
        if (!g || s.machine || !(repos.has(norm(g.root)) || repos.has(norm(g.mainRoot)))) continue;
      }
      this.lookup(s, cx, true, key, check);
    }
    if (!repos) this.lookupMachines(cx);
  }

  // Watches one local folder. repo: the repo root it belongs to (its .herdr
  // or .vscode), or null for the personal file's folder. Wake-ups are gathered
  // for SETTLE_MS, then only the affected repo's spaces look again (all of
  // them, plus machines, when the personal file changed).
  watch(dir, repo, cx) {
    if (this.watches.has(dir) || this.unwatchable.has(dir) || this.closed) return;
    const entry = { handle: null, repo };
    this.watches.set(dir, entry);
    cx.spawn(async (cx) => {
      for (;;) {
        let paths;
        try {
          const w = watchFolder(dir);
          if (this.watches.get(dir) !== entry) { w.cancel(); return; }
          entry.handle = w;
          paths = await w;
        } catch {
          // Missing (no .herdr yet) or refused: the timer covers it, and tries again in a minute.
          if (this.watches.get(dir) === entry) this.watches.delete(dir);
          this.unwatchable.add(dir);
          return;
        }
        if (this.watches.get(dir) !== entry) return;
        // Reclaimed with nothing changed: pause a second so a watch that keeps
        // being reclaimed can't spin, then watch again. The timer catches anything missed.
        if (paths.length === 0) { await new Promise((r) => cx.timer.after(1000, () => r())); continue; }
        if (repo) this.settle(cx, { repo });
        else if (paths.some((p) => norm(p) === dir || PERSONAL.test(p))) this.settle(cx, { personal: true });
      }
    });
  }

  settle(cx, { repo = null, personal = false }) {
    if (!this.settling) {
      this.settling = { repos: new Set(), personal: false };
      cx.timer.after(SETTLE_MS, (cx) => {
        const s = this.settling;
        this.settling = null;
        if (this.closed) return;
        if (s.personal) this.reread(cx);
        else if (s.repos.size) this.reread(cx, s.repos);
      });
    }
    if (repo) this.settling.repos.add(repo);
    if (personal) this.settling.personal = true;
  }

  // Keeps only the given folders watched.
  unwatch(keep) {
    for (const [dir, w] of this.watches) if (!keep.has(dir)) { w.handle?.cancel?.(); this.watches.delete(dir); }
  }

  // Watches a local repo's .herdr and .vscode folders (those that exist).
  watchRepo(git, cx) {
    const linked = new Set(git.linked ?? []);
    for (const root of new Set([norm(git.root), norm(git.mainRoot)])) {
      if (!linked.has(".herdr")) this.watch(`${root}/.herdr`, root, cx);
      if (!linked.has(".vscode")) this.watch(`${root}/.vscode`, root, cx);
    }
  }

  // ---- Looking colors up ----

  // Where the space's project is: its first terminal's live folder, as herdr's
  // own mods take a space's repo, else the folder new terminals start in.
  where(space) {
    const tabs = new Set(space.tabs.map((t) => t.id));
    const first = panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd);
    return first?.cwd ?? space.folder ?? "";
  }

  // One lookup per space and folder: two spaces in the same non-repo folder
  // are colored by their own names, so they can't share a result.
  key(space) {
    return space ? `${space.id}|${space.machine ?? ""}|${this.where(space)}` : null;
  }

  // Automatic colors remembered so far (shared "project-color.assigned",
  // repo name -> hex): a project keeps its color, a new one gets the least used.
  // Picks made in this run are kept here too, at once: shared state may only
  // show a write later, and spaces looked up together must see each other's
  // picks, or they'd all take the same least-used color.
  assigned() { return { ...(shared("project-color.assigned") ?? {}), ...(this.picked ??= {}) }; }
  remember(name, hex) {
    const a = this.assigned(), k = nameKey(name);
    this.picked[k] = hex;
    if (a[k] !== hex || (shared("project-color.assigned") ?? {})[k] !== hex) setShared("project-color.assigned", { ...a, [k]: hex });
  }

  // Is a known repo still a repo where it was, and is the folder not a new repo
  // of its own? Two small reads; UNREACHABLE when the machine didn't answer.
  async stillThere(git, cwd, machine, cx) {
    const root = trim(git.root);
    // On another machine a failed read can't tell "no such file" from "away",
    // so ask git there: same top level = same repo; an exec that fails = away.
    if (machine) {
      try {
        const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { on: machine, timeout: 5000 });
        return r.code === 0 && norm(r.stdout.trim()) === norm(root);
      } catch { return UNREACHABLE; }
    }
    const head = await readOn(`${root}/.git/HEAD`, null, cx);
    if (head === null && (await readOn(`${root}/.git`, null, cx)) === null) return false;  // a worktree's .git is a file
    // The folder became a repo of its own? Compared case-blind, since Windows
    // and macOS spell the same folder in different cases.
    if (norm(cwd).toLowerCase() !== norm(root).toLowerCase()) {
      const own = await readOn(`${trim(cwd)}/.git/HEAD`, null, cx);
      if (own !== null) return false;
    }
    return true;
  }

  // Looks up one space's color. again: even if known (files re-read, git only
  // if needed); check: also make sure a known repo is still there.
  lookup(space, cx, again = false, key = this.key(space), check = false) {
    if (!key || this.closed) return;
    if (key in this.loading) { if (again) this.dirty.add(key); return; }
    // Once asked, a folder waits for the timer or a watch, never for a redraw:
    // that's what keeps an unreachable machine from being asked in a loop.
    if (!again && (this.cache[key] || this.repos[key])) return;
    const rev = this.rev;
    this.loading[key] = rev;
    const machine = space.machine ?? null;
    const cwd = this.where(space);
    cx.spawn(async (cx) => {
      let entry = null;
      try {
        let info = this.repos[key];
        if (info?.git && check) {
          // The timer: is the known repo still there (and reachable)?
          const ok = await this.stillThere(info.git, cwd, machine, cx);
          if (ok === UNREACHABLE) info = { ...info, unreachable: true };
          else info = ok ? { ...info, unreachable: false } : null;  // gone or replaced: ask git again
        } else if (info?.unreachable) info = { ...info, retry: true };
        if (!info || info.retry) {
          const was = info;
          info = await this.askGit(machine, cwd, cx);
          // A slow git isn't an answer: keep what we knew until it replies.
          if (info.slow && was?.git) info = { ...was, retry: true };
        }
        this.repos[key] = info;
        const { git } = info;
        if (git && !machine) this.watchRepo(git, cx);

        let unreachable = this.repos[key].unreachable;
        // A slow git with nothing known yet: show last run's color (or nothing)
        // rather than guess a project from the space name.
        if (info.slow && !git) entry = this.cache[key] ?? this.fromSaved(space.id);
        else if (!unreachable) {
          // Folders the repo tracks as links are skipped entirely.
          const linked = new Set(git?.linked ?? []);
          const roots = git && !linked.has(".herdr") ? [...new Set([norm(git.root), norm(git.mainRoot)])] : [];
          const texts = await Promise.all([
            ...roots.map((r) => readOn(`${r}/.herdr/color.json`, machine, cx)),
            git && !linked.has(".vscode") ? readOn(`${norm(git.root)}/.vscode/settings.json`, machine, cx) : null,
          ]);
          if (texts.includes(UNREACHABLE)) unreachable = true;
          else {
            const personal = parsePersonal(await read(personalPath()));
            // A space outside any repo is named after the space, so cd-ing around doesn't change its color.
            const name = git?.name || space.name || baseName(cwd) || "~";
            const color = resolveColor({ repoTexts: texts.slice(0, roots.length), personal, name, vscodeText: texts[roots.length], assigned: this.inUse(name) });
            // Only repos are remembered: a non-repo space's name can follow its
            // folder, and every cd would leave a name behind.
            if (color.source === "auto" && git) this.remember(name, color.background);
            // Which checkout's .herdr/color.json gave the color (a worktree's
            // own wins over the main checkout's), so Share and Clear act on it.
            const at = color.source === "repo" ? roots[texts.slice(0, roots.length).findIndex((t) => colorFromHerdrFile(t))] : null;
            // With .herdr linked there's nothing safe to share or clear in the repo.
            const writable = git && !linked.has(".herdr");
            entry = { root: writable ? norm(git.root) : null, mainRoot: writable ? norm(git.mainRoot) : null, repoAt: at ?? null, linked: linked.has(".herdr"), machine, name, ...color };
          }
        }
        if (unreachable) {
          // The machine can't be reached: keep what we had (this run or the
          // last), else its machine's color; never guess from a folder name.
          this.repos[key] = { ...this.repos[key], unreachable: true };
          const before = this.cache[key] ?? this.fromSaved(space.id);
          const m = this.machineInfo?.[machine] ?? shared("project-color.targets")?.machines?.[machine];
          entry = before ? { ...before, root: null, mainRoot: null, machine, unreachable: true }
            : m ? { root: null, mainRoot: null, machine, name: m.name, background: m.color, foreground: null, source: m.source, unreachable: true } : null;
        }
      } catch { /* leave the space as it was; the timer tries again */ }
      finally {
        delete this.loading[key];
      }
      if (this.closed) return;
      // A save while this ran made it stale, or something asked again: look again.
      if (rev !== this.rev || this.dirty.has(key)) { this.dirty.delete(key); this.lookup(space, cx, true, key); return; }
      if (entry) this.cache[key] = entry;
      cx.notify();
    });
  }

  // A space's color as the last run published it, for use until a fresh lookup lands.
  fromSaved(id) {
    const s = this.saved[id];
    return s ? { root: null, mainRoot: null, machine: s.machine ?? null, name: s.name, background: s.color, foreground: null, source: s.source } : null;
  }

  // `git rev-parse` in a space's folder: { git, retry, unreachable, slow }.
  async askGit(machine, cwd, cx) {
    const where = machine ?? "";
    if (this.noGit.has(where)) return { git: null, retry: false, unreachable: false };
    try {
      // No --path-format: git before 2.31 doesn't know it; repoFromGit
      // resolves a relative common dir against cwd instead.
      const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir"], { on: machine, timeout: 5000 });
      if (r.code === 0) {
        let git = repoFromGit(r.stdout, cwd);
        // A repo on a network share is left alone for good, not asked about every minute.
        const onShare = !git && isNetworkPath(r.stdout.trim().split(/\r?\n/)[0]);
        // A "repo root" that doesn't contain the folder (a planted core.worktree
        // can point it anywhere) isn't trusted: no reads, watches or writes there.
        if (git && !isInside(cwd, git.root)) return { git: null, retry: false, unreachable: false };
        // Does the repo track .herdr or .vscode as a link? Then they're never
        // read, watched or written (a cloned repo could point them anywhere).
        if (git) {
          const ls = await exec("git", ["-C", git.root, "ls-files", "-s", "--", ".herdr", ".vscode"], { on: machine, timeout: 5000 }).catch(() => null);
          git = { ...git, linked: [...linkedPaths(ls?.code === 0 ? ls.stdout : "")] };
        }
        return { git, retry: !git && !onShare, unreachable: false };
      }
      // macOS without developer tools: /usr/bin/git only offers to install
      // them. Stop asking on that machine until the mod reloads.
      if (/xcode-select|developer tools|command line tools/i.test(r.stderr)) this.noGit.add(where);
      // No git on that machine at all (a slim container): stop asking it.
      if (r.code === 127 || /git: (command )?not found|"git": executable file not found/i.test(r.stderr)) this.noGit.add(where);
      // Not a repo (yet): ask again on the timer, in case of a `git init`.
      return { git: null, retry: !this.noGit.has(where), unreachable: false };
    } catch (e) {
      const cantStart = /cannot start|not found|no such file|os error 2\b|ENOENT/i.test(String(e?.message ?? e));
      if (machine) {
        // Did the machine answer at all? A small read tells "no git there"
        // (stop asking it) from "machine away" (keep the last color, retry).
        const probe = await readOn(`${trim(cwd)}/.herdr/color.json`, machine, cx);
        if (probe === UNREACHABLE) return { git: null, retry: true, unreachable: true };
        if (cantStart) this.noGit.add(where);
        return { git: null, retry: !cantStart, unreachable: false, slow: !cantStart };
      }
      // Here: given up on only when git clearly can't start; anything else
      // (a slow or busy git, a timeout) is asked again on the timer.
      if (cantStart) this.noGit.add(where);
      return { git: null, retry: true, unreachable: false, slow: !cantStart };
    }
  }

  // A dev container's repo from its label, asked once per container:
  // { repo, inside } where inside is its folder in the container, once found.
  async label(target, m, cx) {
    const k = `${target.engine.join(" ")}|${target.container}`;
    let l = this.labels[k];
    if (!l) {
      // One engine timeout per round is enough: the rest of this round's
      // containers keep their colors instead of each waiting 5 s in turn.
      if (this.engineDown) return null;
      const [bin, ...pre] = target.engine;
      let d = null;
      try { d = await exec(bin, [...pre, "inspect", "--format", '{{index .Config.Labels "devcontainer.config_file"}}', target.container], { timeout: 5000 }); }
      catch { this.engineDown = true; }
      if (d?.code !== 0) return null;  // engine not answering, or container gone: not kept
      l = this.labels[k] = { repo: repoFromConfigFile(d.stdout.trim()), inside: undefined };
    }
    // Inside the container: the label's own path, or the dev containers
    // default /workspaces/<repo> if its config is there. Looked for while it
    // runs; a miss isn't kept, so a repo checked out later is still found.
    if (l.repo && l.inside === undefined && m.state === "connected") {
      if (l.repo.containerRoot) l.inside = l.repo.containerRoot;
      else {
        const guess = `/workspaces/${l.repo.name}`;
        const rel = l.repo.configFile.slice(l.repo.configFile.indexOf("/.devcontainer/"));
        const t = await readOn(`${guess}${rel}`, m.name, cx);
        if (t !== null && t !== UNREACHABLE) l.inside = guess;
      }
    }
    return l;
  }

  // Each machine's color, in shared "project-color.machines" (name -> hex) for
  // the spaces sidebar's machine rows. A dev container is colored as its repo,
  // read where its files can be reached: on this computer when its
  // devcontainer.config_file label's file is here, else inside the container
  // while it runs. A container that can't be read keeps the color it had from
  // its repo or VS Code; never read, it gets the personal file's or the
  // automatic color of its repo name. Any other machine: its name's.
  lookupMachines(cx) {
    if (this.closed) return;
    if (this.machinesBusy) { this.machinesAgain = true; return; }
    this.machinesBusy = true;
    this.machinesAgain = false;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        // No answer from hc: keep every machine as it is, rather than forget them all.
        if (r.code !== 0) throw new Error(r.stderr || "hc machine ls failed");
        const list = JSON.parse(r.stdout || "{}").machines ?? [];
        this.engineDown = false;
        const personal = parsePersonal(await read(personalPath()));
        const before = this.machineInfo ?? shared("project-color.targets")?.machines ?? {};
        const found = {}, info = {}, seen = new Set();
        for (const m of list) {
          if (!m.name || m.temporary) continue;
          let name = m.name, root = null, on = null;
          const target = containerFromTarget(m.target);
          if (target) {
            const lk = `${target.engine.join(" ")}|${target.container}`;
            seen.add(lk);
            // Stopping or rebuilding drops the connection: ask its label once
            // more after that, in case it came back as a different repo.
            const was = this.states?.[m.name];
            if (was === "connected" && m.state !== "connected") delete this.labels[lk];
            const l = await this.label(target, m, cx);
            // Docker didn't answer: without the label we don't know the repo,
            // so the machine keeps exactly what it had rather than being
            // recolored (and saved) under its machine name.
            if (!l && before[m.name]) {
              found[m.name] = before[m.name].color;
              info[m.name] = { ...before[m.name], connected: m.state === "connected" };
              continue;
            }
            const repo = l?.repo;
            if (repo) {
              name = repo.name;
              // The label's host path is only ours if its config file is really
              // here (the engine may run on another computer); an in-process read.
              // ...and only if that folder really is a git repo (a label comes
              // from the image, so it could name any folder with a .devcontainer).
              if (repo.hostRoot && (await read(repo.configFile)) !== null
                && ((await read(`${repo.hostRoot}/.git/HEAD`)) !== null || (await read(`${repo.hostRoot}/.git`)) !== null)) root = norm(repo.hostRoot);
              else if (m.state === "connected" && l.inside) { root = l.inside; on = m.name; }
            }
          }
          let texts = root ? await Promise.all([readOn(`${root}/.herdr/color.json`, on, cx), readOn(`${root}/.vscode/settings.json`, on, cx)]) : [null, null];
          if (texts.includes(UNREACHABLE)) { texts = [null, null]; root = null; on = null; }
          let color = resolveColor({ repoTexts: [texts[0]], personal, name, vscodeText: texts[1], assigned: this.inUse(name) });
          const prev = before[m.name];
          // Unreadable now, but read from the repo or VS Code before: keep that
          // color rather than fall back to an automatic one.
          if (!root && color.source === "auto" && prev?.name === name && (prev.source === "repo" || prev.source === "vscode")) color = { background: prev.color, foreground: null, source: prev.source };
          if (color.source === "auto") this.remember(name, color.background);
          found[m.name] = color.background;
          info[m.name] = { label: m.name, machine: on, root, mainRoot: root, repoAt: color.source === "repo" ? root : null, name, color: color.background, source: color.source, connected: m.state === "connected" };
        }
        // Forget containers no machine uses any more.
        for (const k of Object.keys(this.labels)) if (!seen.has(k)) delete this.labels[k];
        this.states = Object.fromEntries(list.map((m) => [m.name, m.state]));
        this.machineInfo = info;
        if (JSON.stringify(found) !== JSON.stringify(shared("project-color.machines") ?? {})) setShared("project-color.machines", found);
      } catch { /* hc unavailable: leave the machine rows as they are */ }
      this.machinesBusy = false;
      if (this.machinesAgain) this.lookupMachines(cx);
      cx.notify();
    });
  }

  // ---- Publishing ----

  // Every space's color to shared "space.colors", which the spaces sidebar and
  // herdr's picker draw from; the tinted tabs and agents read it too.
  publish(list) {
    const found = {};
    for (const s of list) {
      const c = this.cache[this.keys[s.id]];
      if (c) found[s.id] = c.background;
    }
    const live = new Set(list.map((s) => s.id));
    const { colors, written, changed } = mergeSpaceColors(shared("space.colors") ?? {}, shared("project-color.written") ?? {}, found, live);
    if (changed) {
      setShared("project-color.written", written);
      setShared("space.colors", colors);
    }
  }

  // What the picker needs about every space and machine, in shared
  // "project-color.targets": { spaces: { id: info }, machines: { name: info } }.
  // A space still being looked up (just started, or just moved folder) keeps
  // what was published for it, so nothing blanks in between.
  publishTargets(list) {
    const prev = shared("project-color.targets")?.spaces ?? {};
    const sp = {};
    for (const s of list) {
      const c = this.cache[this.keys[s.id]];
      if (c) sp[s.id] = { label: s.name, machine: c.machine, root: c.root, mainRoot: c.mainRoot, repoAt: c.repoAt ?? null, name: c.name, color: c.background, source: c.source, unreachable: Boolean(c.unreachable), linked: Boolean(c.linked) };
      else if (prev[s.id] ?? this.saved[s.id]) sp[s.id] = { ...(prev[s.id] ?? this.saved[s.id]), label: s.name, root: null, mainRoot: null };
    }
    const targets = { spaces: sp, machines: this.machineInfo ?? shared("project-color.targets")?.machines ?? {} };
    if (JSON.stringify(targets) !== JSON.stringify(shared("project-color.targets") ?? null)) setShared("project-color.targets", targets);
  }

  // Forgets folders no space is in any more, and watches only what's in use.
  prune() {
    const keys = new Set(Object.values(this.keys));
    for (const k of new Set([...Object.keys(this.repos), ...Object.keys(this.cache)])) {
      if (!keys.has(k) && !(k in this.loading)) { delete this.repos[k]; delete this.cache[k]; }
    }
    const keep = new Set([norm(appHome())]);
    for (const k of keys) {
      const g = this.repos[k]?.git;
      if (g && !this.cache[k]?.machine && !k.split("|")[1]) for (const r of [norm(g.root), norm(g.mainRoot)]) { keep.add(`${r}/.herdr`); keep.add(`${r}/.vscode`); }
    }
    this.unwatch(keep);
  }

  render(cx) {
    if (this.picking) return this.renderPicker(cx);
    const list = spaces();
    const space = list.find((s) => s.active);
    // Each space's key once per render (it scans the panes).
    this.keys = Object.fromEntries(list.map((s) => [s.id, this.key(s)]));
    const rev = shared("project-color.rev") ?? 0;
    if (rev !== this.rev) {
      this.rev = rev;
      if (!checking()) { for (const s of list) this.lookup(s, cx, true, this.keys[s.id]); this.lookupMachines(cx); }
    }
    const publishing = !checking() && this.publisher();
    if (!checking()) {
      for (const s of list) this.lookup(s, cx, false, this.keys[s.id]);
      if (publishing) { this.publish(list); this.publishTargets(list); }
      this.prune();
    }
    const c = space ? this.cache[this.keys[space.id]] : null;

    const title = space ? `${space.name} - Herdr` : null;
    if (title !== this.title && publishing) { this.title = title; setWindowTitle(title); }

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

  // ---- The picker ----

  initPicker(cx) {
    this.picking = true;
    const p = props() ?? {};
    const targets = shared("project-color.targets") ?? {};
    const id = p.space ?? spaces().find((s) => s.active)?.id;
    this.active = p.machine ? targets.machines?.[p.machine] : targets.spaces?.[id];
    if (this.active) this.active = { ...this.active, kind: p.machine ? "machine" : "space" };
    this.sel = this.active?.color ?? PRESETS[0];
    this.valid = true;
    this.busy = false;
    this.error = null;
    this.input = InputState.new({ placeholder: "#rrggbb", value: this.sel });
    this.input.on("change", (_e, cx) => {
      const hex = normalizeHex(this.input.value());
      this.valid = Boolean(hex);
      if (hex) this.sel = hex;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.saveMine(cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  // How many open spaces share this repo, for "Applies to ...".
  sharing() {
    const a = this.active;
    const all = shared("project-color.targets")?.spaces ?? {};
    return Object.values(all).filter((s) => s.name === a.name).length;
  }

  // Runs one save or clear, then makes every copy look again and closes.
  act(cx, label, work) {
    if (this.busy || !this.active) return;
    this.busy = label; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await work(this.active);
        setShared("project-color.rev", (shared("project-color.rev") ?? 0) + 1);
        closeOverlay(props()?.overlay);
      } catch (e) {
        this.busy = false; this.error = String(e?.message ?? e); cx.notify();
      }
    });
  }

  async savePersonal(name, hex) {
    const path = personalPath();
    const old = await readTextFile(path).catch(() => null);
    await writeTextFile(path, personalText(parsePersonal(old), name, hex), old);
  }

  saveMine(cx) {
    if (!this.valid || this.active?.source === "repo") return;
    this.act(cx, "Saving…", (a) => this.savePersonal(a.name, this.sel));
  }

  // Writes the file that decides the color: the one that gave it now (a
  // worktree's own, if it has one), else the main checkout's.
  saveRepo(cx) {
    if (!this.valid || !this.active?.mainRoot) return;
    this.act(cx, "Saving…", async (a) => {
      const at = a.repoAt ?? a.mainRoot;
      let old;
      try { old = await readTextFile(`${trim(at)}/.herdr/color.json`, a.machine ? { on: a.machine } : undefined); }
      catch { if (a.machine) throw new Error("Can't reach the repo right now; try again when the machine is running."); old = null; }
      await runFileScript(a.machine, at, { text: herdrFileText(old, this.sel) });
    });
  }

  // Removes every herdr color for the project: the personal entry first (so a
  // typo in that file stops before anything is deleted), then the repo files
  // in the worktree and the main checkout.
  clear(cx) {
    this.act(cx, "Clearing…", async (a) => {
      await this.savePersonal(a.name, null);
      // Repo files only when the repo set the color: a color.json that set
      // nothing (other keys only) is someone's file, not ours to remove.
      if (a.source === "repo") for (const r of new Set([a.repoAt, a.root, a.mainRoot].filter(Boolean))) await runFileScript(a.machine, r, { remove: true });
    });
  }

  renderPicker(cx) {
    const t = theme();
    const a = this.active;
    if (!a) return v_flex().p(14).gap(6).text_size(12.5).text_color(t.muted)
      .child("Still looking up colors for this one. Try again in a moment.");
    const from = {
      repo: "Now: shared via the repo (.herdr/color.json)",
      personal: "Now: just for you (project-colors.json)",
      vscode: "Now: from VS Code (.vscode/settings.json)",
      auto: "Now: automatic, no color set",
    }[a.source] ?? "";
    const n = a.kind === "space" ? this.sharing() : 0;
    const applies = `Applies to repo "${a.name}"${n > 1 ? ` · ${n} spaces` : ""}`;
    const fg = textOn(this.sel);
    const swatch = (hex) => div().id(`sw-${hex}`).size(28).rounded(7).bg(hex).cursor_pointer().tooltip(hex)
      .border_2().border_color(hex === this.sel ? t.foreground : hex)
      .on_click((_e, cx) => { this.sel = hex; this.valid = true; this.input.set_value(hex); cx.notify(); });
    const button = (id, label, primary, enabled, onClick, tip) => div().id(id).h(30).px(10).flex().items_center().justify_center()
      .rounded(7).text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(!enabled || Boolean(this.busy), (el) => el.opacity(0.45))
      .when(enabled && !this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(label);
    const repoWins = a.source === "repo";
    // The repo sets the color but can't be reached now (a stopped machine, a
    // folder not read yet): nothing here can change it, so say so plainly.
    const stuck = repoWins && !a.mainRoot;
    const note = stuck
      ? "This color comes from the repo, which can't be reached right now. Try again when it's available."
      : !a.mainRoot
        ? (a.kind === "machine" && !a.connected
          ? "The container is stopped, so only \"Just for me\" is possible now."
          : a.unreachable
            ? "The machine can't be reached right now, so only \"Just for me\" is possible."
            : a.linked
              ? "This repo's .herdr is a link, so it isn't touched; only \"Just for me\" is possible."
              : "Not in a git repo, so only \"Just for me\" is possible.")
        : repoWins ? "The repo's color wins over \"Just for me\"; Clear it first to override it just for you." : null;
    const canClear = a.source === "personal" || (repoWins && Boolean(a.mainRoot));
    return v_flex().w_full().p(12).gap(9).text_size(12.5).text_color(t.foreground)
      .child(h_flex().h(34).px(10).rounded(7).items_center().bg(this.sel).text_color(fg)
        .child(div().font_semibold().truncate().child(a.label)))
      .child(v_flex().gap(2).text_size(11.5).text_color(t.dim).child(div().child(applies)).child(div().child(from))
        // Where "Share via repo" writes, in full, so a surprising folder is visible.
        .when(Boolean(a.repoAt ?? a.mainRoot), (el) => el.child(div().truncate().tooltip(a.repoAt ?? a.mainRoot).child(`In ${a.repoAt ?? a.mainRoot}${a.machine ? ` on ${a.machine}` : ""}`))))
      .child(h_flex().flex_wrap().gap(6).children(PRESETS.map(swatch)))
      .child(Input.new(this.input).h(30).px(8).rounded(7).border_1().border_color(this.valid ? t.input : t.blocked)
        .bg(t.background).text_size(12.5).text_color(t.foreground))
      .when(!this.valid, (el) => el.child(div().text_size(11).text_color(t.blocked).child("Type a color like #1d4ed8")))
      .child(h_flex().gap(6)
        .child(button("pc-mine", this.busy || "Just for me", !a.mainRoot || !repoWins, this.valid && !repoWins, (cx) => this.saveMine(cx), "Saved on this computer only (Enter)"))
        .when(Boolean(a.mainRoot), (el) => el.child(button("pc-repo", "Share via repo", repoWins, this.valid, (cx) => this.saveRepo(cx), "Writes .herdr/color.json; others see it once you commit it"))))
      .when(Boolean(note), (el) => el.child(div().text_size(11).text_color(t.dim).child(note)))
      .child(h_flex().gap(8).items_center()
        .child(button("pc-clear", "Clear", false, canClear, (cx) => this.clear(cx), "Removes the herdr color"))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child("Back to VS Code's or an automatic color")))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error)));
  }
}
