# Project colors

Every project gets its own color, shown behind the tabs, on space tiles, machine rows and
agent rows. Right-click any of them to pick one, saved in the repo or just for you.

![Project colors](preview.png)

## What you see

- **Tab bar** (Herdr's 42px bar): background, inactive tabs and the Files/Changes buttons in
  the shown project's color; bottom border too. The active tab keeps Herdr's raised card. On
  the color, inactive tab text and tinted icons are black or white at 95% (WCAG luminance,
  threshold 0.179), `+` and window buttons at 85%.
- **Spaces sidebar:** each space's 18px letter tile in its project color. Each machine row's
  icon becomes a 16px rounded tile in the machine's color with the server glyph in black or
  white; at 45% opacity while the machine isn't connected.
- **Agents panel:** a 6x16px stripe (6x14 on the narrow rail) and a 7px dot on space headers,
  in the space's color lifted 30% toward white on dark themes so deep colors stay visible.
- **Picker** (320x430 popup): a 34px preview bar with the target's name, "Applies to repo X ·
  N spaces", "Now: ..." (repo / just for you / VS Code / automatic), the 14 palette swatches
  (28px, hex tooltip), a hex field (red border and hint while invalid), **Just for me**,
  **Share via repo** (only when a git repo is reachable), **Clear**, notes and errors.
- The OS window title becomes `<space name> - Herdr`.

## How it behaves

- Right-click a space: Herdr's menu plus **Color...** (palette icon). Right-click a machine
  row, an agent row or an agents-panel space header: the picker opens directly.
- Picker: swatch click or typed hex (with or without `#`) updates the preview; Enter = Just
  for me; Esc closes. After a save the popup closes and every copy looks again at once.
- "Just for me" is disabled when the repo's file sets the color (it would lose); a note says to
  Clear first. Clear is disabled when there is no herdr color to clear.
- Git runs once per folder (again only if the repo vanished, the folder became its own repo, it found none, or the machine didn't answer); docker inspect once per container. The `.herdr` and `.vscode` folders of local repos and Herdr's home (for the personal file) are watched, wake-ups gathered for 500 ms and only the affected repo re-read. A 60 s timer re-reads files, checks repos still exist and lists machines. A read through a machine that fails or takes over 8 s counts as unreachable: the space keeps its last color. An unreachable machine keeps its spaces'
  last colors.

## Built from

- Layout: a clone of `main` (`layout.clone {name: "main", as: "colors"}`). First child of the
  `work` column: `{ "id": "project-color", "type": "block", "size": { "px": 0 }, "content": { "mod": "project-color", "props": { "bar": false } } }`.
  The `tabs`, `agents` and `spaces` blocks use `project-color-tabs`, `-agents`, `-spaces`.
- `mods/project-color/main.js`: per space, `git rev-parse --show-toplevel --path-format=absolute --git-common-dir`
  on the space's machine, `readTextFile` of `.herdr/color.json` (worktree, then main checkout),
  the personal file and `.vscode/settings.json`. Per machine, `hc(["machine","ls","--json"])`
  and `docker inspect` of the container named in its `docker exec` target for the
  `devcontainer.config_file` label. Publishes shared `space.colors` (merged: only Herdr's
  theme-name picks and its own earlier values are replaced), `project-color.machines`,
  `project-color.targets` (picker info), `project-color.assigned` (automatic colors),
  `project-color.written`, `project-color.rev` (bumped after a save). The picker is the same
  mod opened as a popup with `props { picker, space | machine }`.
- Writes: `.herdr/color.json` via `powershell -EncodedCommand` on Windows (script and paths
  base64-encoded; PowerShell literals; refuses reparse points; temp file + move) or `sh -c`
  with paths as arguments elsewhere (refuses `-L`; temp file + `mv`). The personal file via
  `writeTextFile` with the read snapshot; refuses to write over text that doesn't parse.
- `mods/project-color/color.js`: all pure logic; `test/color.test.mjs` covers it.
- `tools/build-clones.mjs`: regex-anchored patches of Herdr's `tabs`, `agents`, `spaces` and
  `menu`; every anchor must match exactly once, and a source already mentioning
  `project-color` is refused.

## Watch out

- Shipped layouts don't take new blocks and `mod.json` `place` doesn't dock into them: clone.
- A junction or symlink into `mods/` is not picked up; copy the folder.
- Shipped mods have CRLF line endings on Windows; normalise before matching.
- Read `props()` in `init`, not its first argument, for overlay props.
- `exec` arguments reach `cmd.exe` quoted only when they contain a space: never put a path in a
  `cmd` command line.
- From Git Bash, `hc exec` arguments starting with `/` get rewritten to Windows paths; set
  `MSYS_NO_PATHCONV=1` when testing container scripts by hand.
- `nextCommand()` carries no arguments, so the picker can't be driven by a command with a target.
- PowerShell errors under `-EncodedCommand` come out as CLIXML on stderr; the scripts print
  plain messages to stdout and exit 1.
- Arguments to a machine reached through `docker exec ... sh -c` lose backslashes: send every
  argument base64 and decode it in the script (`base64 -d`, or `-D` on older macOS).
- Git before 2.31 echoes `--path-format=absolute` back as an output line instead of failing:
  don't use it; resolve a relative `--git-common-dir` against the folder git ran in.
- A devcontainer label's host path may be on another computer (remote engine): trust it only
  if the config file it names is readable here.
- On macOS, the tab bar's left padding sits under the traffic lights; keep it untinted when the
  sidebar is hidden. Finder can drop `.DS_Store` into `.herdr`; remove it before `rmdir`.

## Done when

- `herdr-app check` passes for all five mods; `node --test test/color.test.mjs` passes.
- Two spaces in repos with different `.herdr/color.json` show those two tab bar colors.
- A space in a dev container shows the color from the repo inside the container.
- Right-click → Color... on a space, a machine and an agent opens the picker for that target;
  Just for me, Share via repo and Clear each change the colors within a second.
- Share via repo and Clear work on folders named `R&D x`, `100% ^y`, `it's`; a linked `.herdr`
  is refused with a message.
- Switching spaces changes the window title (proves the 0px block runs).
