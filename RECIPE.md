# Project colors

Every project gets its own color in Herdr: behind the tabs, on the space tiles in the sidebar,
on machine rows and on every agent. Right-click any of them to pick a color, saved in the repo
for everyone or just for yourself.

![Project colors](preview.png)

(The preview puts three spaces side by side; Herdr shows one at a time.)

## What you see

- **Tab bar** (Herdr's 42px bar): its background, the inactive tabs and the Files/Changes
  buttons take the shown space's project color, and so does its bottom border. The active tab
  keeps Herdr's raised card. On the color, inactive tab text and tinted icons are black or white
  at 95% opacity (WCAG luminance, threshold 0.179), the `+` and window buttons at 85%. On macOS,
  the strip behind the traffic lights stays Herdr's plain bar color when the sidebar is hidden.
- **Spaces sidebar:** each space's 18px letter tile is filled with its project color. Each
  machine row's icon becomes a 16px rounded tile in the machine's color with the server glyph in
  black or white; at 45% opacity while the machine isn't connected.
- **Agents panel:** a 6x16px stripe (6x14 on the narrow rail) on each agent row and a 7px dot
  before each space header when sorted by space, in the space's color lifted 30% toward white on
  dark themes. Agent statuses look as in Herdr.
- **Picker** (320x450 popup): a 34px preview bar with the target's name, "Applies to repo X · N
  spaces", "Now: ..." (shared via the repo / just for you / from VS Code / automatic), "In
  <folder> [on <machine>]" (where Share via repo writes), 14 swatches
  (28px, hex tooltip), a hex field (red border and hint while invalid), **Just for me**,
  **Share via repo** (only when a git repo can be reached), **Clear**, a note, errors.
- The OS window title becomes `<space name> - Herdr`.

## How it behaves

- Right-click a space: Herdr's space menu plus **Color...** (palette icon) before Close.
  Right-click a machine row, an agent row or an agents-panel space header: the picker opens
  directly.
- Picker: a swatch or a typed hex (with or without `#`) updates the preview; Enter = Just for me;
  Esc closes. After a save the popup closes and every copy looks again at once.
- **Just for me** is disabled while the repo's `.herdr/color.json` sets the color (it would
  lose), with a note to Clear first. **Clear** is enabled only when there is a herdr color to
  clear and its files can be reached; it removes the personal entry first, then the repo's file
  in the worktree and the main checkout. If the repo sets the color but can't be reached, the
  note says so and nothing is offered that couldn't work.
- Lookup order: `.herdr/color.json` (the worktree's own, then the main checkout's), the personal
  file `~/.config/herdr-app/project-colors.json` (`{ "vscode": true, "repos": { name: hex } }`,
  names matched case- and Unicode-blind), VS Code's `titleBar.activeBackground` or
  `peacock.color` (unless `"vscode": false`), else an automatic palette color: least used first,
  ties by an FNV-1a hash of the name, remembered for repos.
- Edits in a local repo's existing `.herdr` or `.vscode` folder show within about a second;
  anything else (new folders, remote machines, containers) within a minute. Builds, installs and
  agents editing code wake nothing. An unreachable machine keeps its spaces' last colors.

## Built from

- **Five mods.** `mods/project-color` is in the repo. The other four are Herdr's own `tabs`,
  `agents`, `spaces` and `menu` with small patches; they are generated, not shipped: run
  `node tools/build-clones.mjs` (reads `$HERDR_APP_HOME`, else `~/.config/herdr-app`), which
  writes `mods/project-color-{tabs,agents,spaces,menu}`. Each patch is a regex anchor that must
  match exactly once; if Herdr changed, the script stops and writes nothing:
  - `tabs`: background, inactive tabs, icons, `+`/window buttons and Files/Changes in the space
    color; untinted strip behind macOS traffic lights.
  - `agents`: the stripe and right-click (opens the picker) on agent rows and the narrow rail; the
    dot and right-click on space headers.
  - `spaces`: machine icon tile (faded when not connected); right-click on a machine row opens
    the picker; a space's right-click opens `project-color-menu`.
  - `menu`: **Color...** in the space menu, opening the picker; `mods/project-color/palette.svg`
    as its icon.
- **Layout:** a clone of `main` (`layout.clone {name: "main", as: "colors"}`). First child of
  the `work` column:
  `{ "id": "project-color", "type": "block", "size": { "px": 0 }, "content": { "mod": "project-color", "props": { "bar": false } } }`
  (draws nothing; it looks colors up). The `tabs`, `agents` and `spaces` blocks use the
  `project-color-` copies.
- **`mods/project-color/main.js`:** per space, `exec("git", ["-C", cwd, "rev-parse",
  "--show-toplevel", "--git-common-dir"], { on: space.machine })` once per space and folder; per
  dev container machine, `hc(["machine","ls","--json"])` and `<engine> inspect` of the
  `devcontainer.config_file` label. Reads with `readTextFile` (8 s limit). Watches with
  `watchFolder` (`<repo>/.herdr`, `<repo>/.vscode`, Herdr's home for the personal file).
  Writes with `writeTextFile` (personal file) and, for `.herdr/color.json`, `exec` of
  `powershell -EncodedCommand` (Windows) or `sh -c` with base64 arguments. Publishes shared
  `space.colors`, `project-color.machines`, `project-color.targets`, `project-color.assigned`,
  `project-color.written`, `project-color.rev`. Also `setWindowTitle`, `openOverlay`,
  `closeOverlay`, `theme`, `spaces`, `panes`, `props`, `appHome`, `window`, `checking`. The
  picker is the same mod opened as a popup with `props { picker, space | machine }`
  (`mod.json`: `{ "place": "none", "title": "Project color", "overlay": { "kind": "popup",
  "width": 320, "height": 450 } }`).
- **`mods/project-color/color.js`:** all pure logic; `test/color.test.mjs` covers it and runs
  the PowerShell and sh write scripts for real.
- **Data:**
  - Palette (automatic colors and picker swatches, in this order): `#b02e26 #a8561a #6e5a10
    #4f6b1a #1e7b34 #0f7466 #156a8c #2257b8 #1d3a7a #5236a8 #80309a #a12c7a #7a2a3c #55606e`.
    A new repo takes the color with the fewest uses in `project-color.assigned`, scanning from
    `FNV-1a(lowercased NFC name) % 14`; the pick is stored under that key.
  - `.herdr/color.json`: `{ "color": "#rrggbb", "foreground"?: "#rrggbb" }`; a save keeps other
    keys and drops `foreground`. VS Code: `workbench.colorCustomizations["titleBar.activeBackground"]`
    (and `titleBar.activeForeground`), else `peacock.color`. All JSONC, a byte-order mark allowed.
  - `space.colors` merge: an entry is replaced only when missing, a theme name (Herdr's own
    pick: `ansi1..ansi6`, drawn as `#d9649a #3fae6a #e3814f #5b8def #8b7cf6 #22a99a`) or exactly
    what this mod wrote before (`project-color.written`); a closed space's entry is removed if
    it is still ours.
  - `project-color.targets`: `{ spaces: { id: { label, machine, root, mainRoot, repoAt, name,
    color, source } }, machines: { name: { ...the same, connected } } }`.
- **Timing:** watch wake-ups gathered for 500 ms; a 60 s timer re-reads files, checks repos
  and lists machines; git and docker calls time out after 5 s, reads after 8 s. The space menu
  popup is 200x300 (Herdr's is 200x260, one item more).
- **Install note:** copying the mods alone shows nothing; the four generated copies and the
  layout edit are required (README, Install).

## Watch out

- Shipped layouts don't take new blocks and `mod.json` `place` doesn't dock into them: clone.
- A junction or symlink into `mods/` was not picked up on Windows in testing; copy the folders.
- Shipped mods have CRLF line endings on Windows; normalise before matching.
- Read `props()` in `init`, not its first argument, for overlay props.
- Never put a path in a `cmd.exe` command line (`exec` quotes only arguments with spaces), and
  never in a PowerShell literal: PowerShell also treats `‘ ’ ‚ ‛` as quotes. Send paths and text
  base64 and decode them in the script. `Split-Path -LiteralPath -Parent` is not valid; use
  `[IO.Path]::GetDirectoryName`.
- Arguments to a machine reached through `docker exec ... sh -c` lose backslashes: send them
  base64 and decode with `base64 -d` (or `-D` on older macOS).
- Git before 2.31 echoes `--path-format=absolute` back instead of failing: don't use it; resolve
  a relative `--git-common-dir` against the folder git ran in (a bare `.git` against the top).
- A devcontainer label's host path may be on another computer, or any folder: trust it only if
  its config file is readable here and it is a git repo. Never read or write a network path
  (`//host/share`).
- A cloned repo can redirect `git rev-parse --show-toplevel` (a planted `core.worktree`): accept
  a top level only if it contains the folder git ran in. It can also ship `.herdr` or `.vscode`
  as links: ask `git ls-files -s` once and leave tracked links alone.
- Only plain `docker`/`podman` targets (optionally behind a bare `sudo`, run with `-n`) are
  inspected; anything else in front (ssh, wsl, env) may mean another engine.
- Herdr reports a PowerShell terminal's process folder, which doesn't follow `Set-Location`.
- On macOS, Finder can drop `.DS_Store` into `.herdr`; remove it before `rmdir`.
- From Git Bash, `hc exec` arguments starting with `/` are rewritten to Windows paths; set
  `MSYS_NO_PATHCONV=1` when testing container scripts by hand.
- `nextCommand()` carries no arguments, so the picker can't be driven by a command with a target.

## Done when

- `node --test test/color.test.mjs` passes, and `herdr-app check` passes for all five mods.
- Two spaces in repos with different `.herdr/color.json` show those two tab bar colors.
- A space in a dev container shows the color from the repo inside the container; stopping the
  container keeps it.
- Right-click → Color... on a space, and right-click on a machine and an agent, open the picker
  for that target; Just for me, Share via repo and Clear each change the colors within a second.
- In a worktree, Share via repo and Clear change the worktree's color.
- Share via repo and Clear work on folders named `R&D x`, `100% ^y`, `it's`, `a’b`; a linked
  `.herdr` is refused with a message.
- Switching spaces changes the window title (proves the 0px block runs).
