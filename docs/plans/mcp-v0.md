# Godot MCP v0

> **Superseded (2026-10-15):** v0 is replaced by [addon-mcp-v1.md](addon-mcp-v1.md). The Godot editor addon becomes the only MCP server and takes over headless run, import and build. Slices 3–5 will not be built in TypeScript. The Bun server from slices 1–2 stays usable until the addon reaches parity (v1 slice 9), then retires; `tests/editor` remains as a dev-only conformance lane.

## Goal

A local stdio MCP server, written in Bun and TypeScript, that lets Claude Code agents in `lagrange-protocol` do four things with a Godot 4.7 .NET project:

- inspect the project
- import its assets
- build its C# code, with structured diagnostics
- run a scene or script headless, with captured output, parsed errors, timeouts and cleanup

A small editor addon adds read-only live-editor inspection over a 127.0.0.1 WebSocket.

## Definition of done

- [ ] `bun run check` passes. It runs `biome ci .`, `tsc --noEmit` and `bun test tests/unit tests/godot tests/editor`.
- [ ] `bun run test:dotnet` passes against `fixtures/cs`. **v0 stays `blocked` until the operator installs the .NET 10 runtime.** Parser tests alone don't count as done.
- [ ] `lagrange-protocol/.mcp.json` registers the server, and `claude mcp list` shows `godot` as connected.
- [ ] The game lane builds and runs its thin Godot shell through `godot_build` and `godot_run`.

## Verified facts the plan relies on

| Fact | Source |
|---|---|
| `Godot.NET.Sdk/4.7.2` sets **no** `TargetFramework` | `Sdk/Sdk.props` inside `/usr/lib/godot-mono/GodotSharp/Tools/nupkgs/Godot.NET.Sdk.4.7.2.nupkg` |
| **TFM is `net8.0`**. GodotSharp 4.7.2 ships only `lib/net8.0`. Godot's project generator writes `net8.0` plus `EnableDynamicLoading`, and uses `net9.0` only for android. | GodotSharp nuspec `<group targetFramework="net8.0"/>`. The generator part comes from strings in `GodotTools.ProjectEditor.dll`; the android condition is inferred from those strings. |
| A net8.0 game assembly runs on the installed 9.0.20 runtime | `GodotPlugins.runtimeconfig.json` sets `rollForward: LatestMajor` |
| Only the `dotnet` CLI is blocked: SDK 10.0.112 needs runtime 10, and only 9.0.20 is installed | `dotnet --list-runtimes` |
| Build output goes to `<project>/.godot/mono/temp/{bin,obj}/<Config>/`. Configurations are `Debug;ExportDebug;ExportRelease`. | `Sdk.props` |
| Godot diagnostics go to **stderr** as `ERROR: msg` followed by `   at: fn (file:line)` | Probe run |
| **Exit code is 0** even when the C# class fails to instantiate | Probe run (`exit=0`) |
| `--quit-after <int>` counts iterations, and 0 disables it. `--fixed-fps` turns off real-time sync. `--import` starts the editor, imports, then quits. | `godot-mono --help` (4.7.2) |
| The SDK `@modelcontextprotocol/server` 2.3.1 supports `registerTool` with zod v4 schemas, `StdioServerTransport` and `InMemoryTransport`. Its zod requirement is `^4.2.0`. | npm and the v2.3.1 docs |
| Biome is at 2.5.15 | npm |
| The prior art `voidwake/addons/godot_ai` v2.9.0 is MIT-licensed | Its `LICENSE` file |
| There is no `GodotNuGetFallbackFolder` | `~/.local/share/godot/mono` doesn't exist |

Assumptions still to verify, each tied to a slice:

- A1: `godot --headless --editor` loads enabled editor plugins. Slice 4's first step checks this.
- A2: Bun 1.4.3 `Bun.spawn` honors `detached: true` (setsid). It is documented in `bun.d.ts` on main. Slice 2 checks it.
- A3: Godot's `TCPServer.listen(0)` together with `get_local_port()` gives an ephemeral port. Slice 4 checks it.
- A4: GDScript backtrace lines in 4.7 stderr appear after `SCRIPT ERROR`. **UNCONFIRMED**; slice 2 pins it with a fixture.

## Decisions

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | `@modelcontextprotocol/server@^2.3.1` with `zod@^4.2` and `@modelcontextprotocol/client` as a dev dependency for tests | v2 is current and has everything needed, so there's no migration later | v1 `@modelcontextprotocol/sdk` 1.32: would need a v2 migration later |
| D2 | Tools return `structuredContent` with an `outputSchema`, plus a JSON text block | Agents can parse the structure, and older clients still see the text | |
| D3 | Two fixtures. `fixtures/gd` is pure GDScript. `fixtures/cs/game` is the Godot .NET project and `fixtures/cs/FixtureLib` is a class library it references. | The run and editor lanes can be verified without .NET. FixtureLib copies the brief's `Sim.*` pattern of Godot-free libraries. | One combined fixture: every run test would then depend on dotnet |
| D4 | Tests copy fixtures into a `mkdtemp` directory | `.godot/` stays out of the repo and tests can run in parallel | |
| D5 | `ok = exitCode == 0 && !timedOut && errorCount == 0` | Godot exits 0 after errors | Trusting the exit code alone |
| D6 | Diagnostics are parsed **incrementally, line by line, before output is trimmed**. `errorCount` is tracked separately from the stored list (capped at 200) and from the 64 KB output tails. | Otherwise an early error plus a lot of logging would look like success | Parsing after truncation |
| D7 | `godot_run` runs `[build] → [import] → run`. `build` defaults to true when a csproj exists. `import` defaults to true. | A stale assembly or stale imports are the most common agent mistakes, and a no-op import is cheap | Checking whether `.godot/` exists: the C# build creates it too |
| D8 | v0 exposes `frames` only. The minimum is 1 (0 would disable quitting). If `frames` is omitted, the run lasts until the script quits or `timeoutSec` expires. | `--fixed-fps` breaks the mapping between frames and wall time, so a `seconds` option would mislead | Converting `seconds` through `--fixed-fps 60` |
| D9 | Processes are spawned with arg arrays, `stdin: "ignore"`, `detached: true` (own process group) and `cwd = projectDir`. A timeout or MCP cancellation (`extra.signal`) sends SIGTERM to the whole group (`-pgid`); after 5 s a SIGKILL follows. A child registry kills all groups when the server gets SIGINT, SIGTERM or stdin EOF. | This cleans up grandchildren such as MSBuild nodes. Setting `cwd` makes `global.json` resolve from the project. | Killing only the direct PID |
| D10 | A cross-process project lock: an atomic `mkdir` of `<project>/.godot/godot_mcp/lock`, plus an `owner.json` holding the pid. A lock whose pid is dead counts as stale. The lock is taken **once** per tool call, covering build, import and run. If it isn't free within `timeoutSec`, the call fails with `project busy (pid N)`. | Each Claude session is a separate server process, so an in-process mutex can't protect it. Taking the lock once avoids nested-lock deadlock. | In-process mutex; per-phase locks |
| D11 | `projectPath` must be absolute. It is resolved with realpath and must contain `project.godot`. `scene` and `script` (`res://` or relative paths) must resolve inside the project after realpath. Extra user args go only after `--`. | Local process execution is a trust boundary | Passing through engine flags |
| D12 | `GODOT_BIN` (default `godot-mono`) and `DOTNET_BIN` (default `dotnet`) are resolved with `Bun.which`. If either is missing the call fails immediately with a named error. | Fail fast, and tests can swap in fake binaries | |
| D13 | Build command: `dotnet build <csproj> -c Debug -nologo -v:q -tl:off -clp:NoSummary -nodeReuse:false -p:UseSharedCompilation=false`, with env `DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 MSBUILDDISABLENODEREUSE=1` | These flags give stable, non-TTY, duplicate-free output and leave no lingering servers behind | |
| D14 | The MSBuild parser follows the documented canonical format: origin, then an optional `(loc)`, then `: [subcat ]error\|warning [CODE]: text`. Origin can be anything, including `MSBUILD`, `CSC` or `x.csproj` (NU errors). A nonzero exit with no parsed errors produces a synthetic `BUILD_FAILED` diagnostic. | Restore and SDK-resolution errors don't follow the compiler's format | Matching only `file(l,c)` lines |
| D15 | The csproj rule is exactly one `*.csproj` at the project root, with an error on zero or more than one. `ProjectReference`s build transitively. | Matches Godot's own layout | Discovering `.sln` files |
| D16 | **The addon is the WebSocket server.** It binds 127.0.0.1 on an ephemeral port and writes a per-instance file, `.godot/godot_mcp/bridge-<pid>.json` = `{port, token, pid, addonVersion, projectPath}`, with owner-only permissions. The MCP server connects as a short-lived client for each call, using Bun's global `WebSocket`. | The editor outlives per-session MCP servers, and several sessions don't fight over one fixed port | Prior art's design, where the addon dials into the server: one port shared by N servers |
| D17 | Bridge safety rules (list below the table) | Localhost WebSockets can be reached from any local process and from browser pages | |

D17 bridge safety rules:

- The token is 32 random bytes from `Crypto.generate_random_bytes`.
- The first message must be `{cmd:"hello", token}` within 2 s, or the connection closes.
- At most 4 peers.
- Inbound buffer is 1 MB.
- Results are capped at 2,000 nodes, with a `truncated` flag.
- The addon **does not start the bridge** when the command line contains `--import`, `--build-solutions` or `--export*`.
- The client picks the live pid file and errors if more than one is live.
- The addon deletes only its own file on exit.

| # | Decision | Why | Rejected |
|---|---|---|---|
| D18 | Editor tools inspect the **edited scene only**, not the running game. | Keeps scope tight | Runtime inspection, which is deferred |
| D19 | Screenshots are deferred | The headless editor can't render, so a screenshot tool would be unverifiable in v0 | |
| D20 | **The addon reaches a consumer by copy** through `godot_addon_install`. The tool replaces `addons/godot_mcp/` wholesale and merges `res://addons/godot_mcp/plugin.cfg` into `[editor_plugins] enabled`. It refuses when the target folder exists but doesn't hold our `plugin.cfg` name. | The consumer commits a pinned copy, `editor_status` reports version drift, and reinstalling upgrades it | Symlink: the Godot scanner, git and worktrees don't handle it well. Submodule: heavy for one folder. |
| D21 | No `dotnet test` wrapper. The plain .NET `Sim.*` tests use `dotnet test` directly. | This MCP's value is on the Godot side | |
| D22 | Biome handles TS and JSON. GDScript is checked by loading it in the headless editor, where a parse error shows up as `SCRIPT ERROR`. | gdtoolkit would add a Python dependency | gdlint |
| D23 | The prior art (`godot_ai`, MIT) is cited and adapted, not vendored. Worth reading: `handlers/scene_handler.gd` and `node_handler.gd` for serialization, and `connection.gd` for peer handling. | | Vendoring it, which is about 6.7k LOC of core alone |

## Repo layout

```
package.json  bun.lock  tsconfig.json  biome.json  README.md
src/server.ts                 # entrypoint: McpServer + stdio, registers tools, child cleanup on exit
src/proc.ts                   # spawn(group, cwd, timeout, abort), line-streaming capture, registry
src/lock.ts                   # cross-process project lock
src/paths.ts                  # projectPath / res:// validation
src/godot/binary.ts           # GODOT_BIN resolve + --version
src/godot/project-file.ts     # project.godot parse + [editor_plugins] merge
src/godot/output-parser.ts    # incremental Godot stderr diagnostics
src/dotnet/msbuild-parser.ts  # canonical MSBuild diagnostics
src/bridge/client.ts          # discovery + WS client
src/tools/{project,import,build,run,addon,editor}.ts
addons/godot_mcp/{plugin.cfg,plugin.gd,bridge_server.gd,inspect.gd}
fixtures/gd/{project.godot,main.tscn,diag.gd,quit_code.gd,hang.gd,icon.svg}
fixtures/cs/game/{project.godot,FixtureGame.csproj,main.tscn,Main.cs}
fixtures/cs/FixtureLib/{FixtureLib.csproj,Greeter.cs}
tests/unit/  tests/godot/  tests/dotnet/  tests/editor/  tests/fakes/  tests/fixtures/*.txt
docs/plans/mcp-v0.md
```

`fixtures/cs/game/FixtureGame.csproj`:

```xml
<Project Sdk="Godot.NET.Sdk/4.7.2">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
  </PropertyGroup>
  <ItemGroup><ProjectReference Include="../FixtureLib/FixtureLib.csproj" /></ItemGroup>
</Project>
```

FixtureLib sits outside the Godot directory on purpose. Godot's csproj globs every `**/*.cs` below it, so a library inside the Godot directory would be compiled twice. Pass this rule to the game lane.

## Tools

Every tool takes `projectPath` (absolute). The type `Diag` is `{severity: "error"|"warning", kind, message, file?, line?, column?, code?, stack?: string[]}`.

| Tool | Input | Output |
|---|---|---|
| `godot_project_info` | — | `{name, mainScene, features[], autoloads{}, dotnet: {assemblyName, csproj} \| null, godot: {path, version}}` |
| `godot_import` | `timeoutSec=120` | `RunResult` |
| `godot_build` | `configuration="Debug"`, `timeoutSec=300` | `{ok, exitCode, timedOut, durationMs, diagnostics: Diag[], errorCount, warningCount, outputTail}` |
| `godot_run` | `scene?` or `script?` (mutually exclusive; neither means the main scene), `frames?: int ≥ 1`, `build?`, `import?=true`, `userArgs?: string[]`, `timeoutSec=60` (per phase) | `RunResult` + `{phases: {build?, import?}}`. A failed phase stops the run and is reported. |
| `godot_addon_install` | — | `{installedFiles[], enabledPlugin, previousVersion?}` |
| `editor_status` | — | `{connected, pid, godotVersion, addonVersion, serverVersion, versionMismatch, editedScene \| null}` |
| `editor_open_scene` | `scenePath` | `{editedScene}` |
| `editor_scene_tree` | `rootPath?`, `maxDepth=8`, `maxNodes=2000` | `{scenePath, truncated, root: {name, type, path, script?, children[]}}`. Errors with `NO_SCENE` when no scene is open. |
| `editor_node_properties` | `nodePath`, `names?` | `{properties: {[name]: {type, value}}}`. Values that aren't JSON go through `var_to_str`. |

`RunResult` is `{ok, exitCode, timedOut, durationMs, diagnostics: Diag[], errorCount, warningCount, stdoutTail, stderrTail, truncated}`.

Godot parser rules:

- Prefixes: `ERROR:`, `WARNING:`, `SCRIPT ERROR:`, `SCRIPT WARNING:`, `USER ERROR:`, `USER WARNING:`, `USER SCRIPT ERROR:`
- `^\s+at: fn (file:line)` is the location line
- `^\s+at Ns.Type.Method(` (no colon) is a .NET stack frame
- Backtrace block lines are stack frames (A4)
- Lines are reassembled across chunk boundaries, and the last line without a newline is flushed

## Slices

Each slice is one commit. The check for every slice is `bun run check` plus the extra command listed.

### Slice 1. Scaffold and `godot_project_info` (coder)

- **Files:** `package.json`, `tsconfig.json`, `biome.json`, `src/server.ts`, `src/paths.ts`, `src/godot/{binary,project-file}.ts`, `src/tools/project.ts`, `fixtures/gd/*`, `tests/unit/{project-file,paths}.test.ts`, `tests/stdio.test.ts`
- **Depends on:** nothing
- **Acceptance criteria:**
  - `project.godot` parsing handles sections, strings and `PackedStringArray`; other values stay raw strings.
  - Path validation rejects relative paths, missing `project.godot`, and `res://../x` or symlinks that escape the project.
  - The stdio test spawns `bun src/server.ts` through the client's `StdioClientTransport`, lists the tools, and calls `godot_project_info` on `fixtures/gd`.
  - Nothing is written to stdout except protocol frames.
- **Check:** `bun install && bun run check`

### Slice 2. Runner, Godot parser, `godot_import`, `godot_run` (coder-high). **Cross-lane critical.**

- **Files:** `src/proc.ts`, `src/lock.ts`, `src/godot/output-parser.ts`, `src/tools/{import,run}.ts`, `tests/unit/output-parser.test.ts` (captured stderr in `tests/fixtures/*.txt`), `tests/godot/run.test.ts`, `tests/fakes/fake-godot.sh`
- **Depends on:** slice 1
- **First step:** verify A2 (`detached`) on Bun 1.4.3.
- **Acceptance criteria:**
  - `diag.gd` produces exactly the expected kinds, messages and locations. This also pins A4.
  - `quit_code.gd` gives `exitCode` 3 and `ok: false`.
  - With `frames: 30` on the main scene the result is `ok`.
  - `hang.gd` with `timeoutSec: 2` gives `timedOut: true`, and a grandchild that ignores SIGTERM (spawned by `fake-godot.sh` through `GODOT_BIN`) is dead afterwards.
  - An early `ERROR:` followed by more than 200 KB of stdout still gives `ok: false` and `errorCount ≥ 1`.
  - Prefixes split across chunks parse correctly.
  - Two concurrent `godot_run` calls from **two server processes** on one project serialize, and the second reports `project busy` if its timeout is shorter.
  - An MCP cancel kills the process group.
- **Check:** `bun run check`
- **Extra measurement:** record the wall time of `frames: 60` in the slice notes.

### Slice 3. `godot_build`, MSBuild parser, `fixtures/cs`, build-before-run, registration contract (coder-high). **Cross-lane critical. Its e2e half needs the .NET runtime fix.**

- **Files:** `src/dotnet/msbuild-parser.ts`, `src/tools/build.ts`, run-tool wiring, `fixtures/cs/**`, `tests/unit/msbuild-parser.test.ts`, `tests/dotnet/build.test.ts`, README sections "Register in a consumer" and "Godot .NET project rules"
- **Depends on:** slice 2
- **Acceptance criteria, unit tests (run now):**
  - Located CS errors and warnings parse correctly.
  - `x.csproj : error NU1301` parses.
  - `MSBUILD : error MSB1009` parses.
  - Diagnostics without a code parse.
  - Duplicates are removed.
  - A nonzero exit with no diagnostics yields `BUILD_FAILED`.
  - Zero csprojs or more than one is an error.
  - The spawn `cwd` is the project directory, asserted through the fake dotnet.
- **Acceptance criteria, e2e (`bun run test:dotnet`):**
  - A preflight runs `dotnet --version` and fails with `".NET runtime missing for SDK; install dotnet-runtime (operator)"`. It never skips.
  - A clean build is `ok`, and `.godot/mono/temp/bin/Debug/FixtureGame.dll` exists.
  - A missing `;` injected into a temp copy of `Main.cs` produces a CS1002 diagnostic with file and line.
  - `godot_run` on the C# scene prints the FixtureLib marker with zero diagnostics.
  - A broken build stops the run.
- **Check:** `bun run check && bun run test:dotnet`. The second command is **blocked until the .NET 10 runtime is installed**.
- **README `.mcp.json` contract** (for `lagrange-protocol/.mcp.json`):

  ```json
  {
    "mcpServers": {
      "godot": {
        "command": "bun",
        "args": ["run", "/home/buck/Projects/voidrot/godot-mcp/src/server.ts"],
        "env": { "GODOT_BIN": "/usr/bin/godot-mono" }
      }
    }
  }
  ```

  It requires `bun install` in `godot-mcp` first. The path is absolute because the server's spawn `cwd` isn't documented; a relative `../godot-mcp` path is **UNCONFIRMED**. Verify with `claude mcp list`.

### Slice 4. Editor bridge and editor tools (coder-high)

- **Files:** `addons/godot_mcp/{plugin.cfg,plugin.gd,bridge_server.gd,inspect.gd}`, `src/bridge/client.ts`, `src/tools/editor.ts`, `tests/unit/bridge-discovery.test.ts`, `tests/editor/bridge.test.ts`
- **Depends on:** slice 2 (process runner). It does **not** depend on .NET.
- **First step:** verify A1 and A3 with the smallest possible plugin. If A1 fails, stop and report: the editor lane then has no automated test, and the user must decide.
- **Acceptance criteria:**
  - The test spawns `godot-mono --headless --editor --path <tmp fixtures/gd with addon enabled>`, waits up to 30 s for `bridge-<pid>.json`, then checks:
    - `editor_status` reports connected and matching versions
    - `editor_scene_tree` before any open gives `NO_SCENE`
    - `editor_open_scene res://main.tscn` followed by `editor_scene_tree` gives exactly the expected nodes
    - `editor_node_properties` returns the expected values
  - A wrong token closes the connection.
  - A 2 MB message is rejected.
  - A 3,000-node scene gives `truncated: true`.
  - `godot --import` on the same project writes no bridge file.
  - Stopping the editor deletes its file. Two pid files that both look live give an explicit error.
  - The addon loads with no `SCRIPT ERROR`.
- **Check:** `bun run check`

### Slice 5. `godot_addon_install` (coder)

- **Files:** `src/tools/addon.ts`, merge helper in `src/godot/project-file.ts`, `tests/godot/addon-install.test.ts`
- **Depends on:** slice 4
- **Acceptance criteria:**
  - Installing into a temp fixture twice gives one `enabled` entry, and every other `project.godot` key is byte-identical.
  - Other plugins already in `enabled` are kept.
  - A folder named `addons/godot_mcp/` that isn't ours is refused.
  - A symlinked `addons/` that escapes the project is refused.
  - Reinstalling removes files that were dropped from the addon.
- **Check:** `bun run check`

**Cross-lane sequencing:** the game lane's "thin Godot shell" waits for **slice 3 plus the operator runtime install**. Slices 4 and 5 can run in parallel with the game lane.

**Slices that need the .NET runtime fix:** only slice 3's e2e half and the v0 definition of done. Slices 1, 2, 4 and 5 don't.

## Risks and rollback

| Risk | Mitigation |
|---|---|
| A1 fails (the headless editor doesn't load plugins) | Slice 4 starts by testing it and stops to report if it fails. The fallback is a manual smoke test, and the user decides. |
| The first restore needs nuget.org for Godot.NET.Sdk and the net8.0 reference pack | Note it in the README. A fixture `nuget.config` pointing at `/usr/lib/godot-mono/GodotSharp/Tools/nupkgs` would cover the Godot packages only. |
| An open editor imports or builds outside our lock | Documented as unprotected in v0 |
| The addon copy drifts from the server version | `editor_status.versionMismatch`; fixed by reinstalling |
| Stray MSBuild or VBCSCompiler processes | `nodeReuse:false`, `UseSharedCompilation=false`, and process-group kill |
| A stale lock after a crash | Lock is reclaimed when its owner pid is dead |
| Rollback | Each slice is a single commit, so `git revert <sha>`. The consumer's only touchpoints are its `.mcp.json` entry and the copied addon folder. |

## Critique log

| # | Point (codex) | Status |
|---|---|---|
| 1 | `.godot/` existing doesn't mean imports are ready | adopted: `import` defaults to true in `godot_run` (D7) |
| 2 | Cleanup misses process trees | adopted: `detached` process group, group kill, cancel signal, TERM-resistant grandchild test (D9) |
| 3 | Truncation can hide failures | adopted: incremental parsing plus a separate error count (D6) |
| 4 | An in-process mutex can't protect multiple sessions; nested locks can deadlock | adopted: cross-process lock taken once per call. The open editor stays outside the lock, as a documented risk. |
| 5 | Editor tools lack project selection; one `bridge.json` gets overwritten | partly rejected: editor tools already took `projectPath`, which the abbreviated critique draft dropped. adopted: per-pid files and no bridge during `--import`/`--build-solutions`/`--export` (D16, D17) |
| 6 | .NET e2e must gate v0; add a referenced library; defer slices 4–5; move registration earlier | adopted: e2e gate in the definition of done, FixtureLib, registration moved into slice 3. rejected: deferring slices 4–5, because they don't depend on .NET and deferring would idle the lane |
| 7 | Build `cwd` is unspecified (`global.json`) | adopted: `cwd = projectDir`, with a test. The suggested project-SDK-pin test was skipped as unnecessary for v0. |
| 8 | `seconds` is misleading; `--quit-after 0` disables quitting | adopted: frames only, minimum 1, per-phase timeouts (D8). Confirmed against `--help`. |
| 9 | The MSBuild parser is too narrow | adopted: canonical-format parser plus `BUILD_FAILED` (D14) |
| 10 | Bridge auth and limits are underspecified | adopted: token entropy, hello deadline, peer cap, buffer cap, node cap (D17). Owner-only file permissions depend on `FileAccess.set_unix_permissions` (**UNCONFIRMED** in 4.7; check in slice 4). |
| 11 | Installer safety: staged writes, rollback | partly adopted: refuse folders that aren't ours, refuse escaping symlinks, keep unrelated settings. rejected: staged writes and rollback, because the consumer tracks the copy in git (YAGNI) |
| 12 | Editor inspection isn't runtime inspection | adopted: editor-only scope (D18), `editor_open_scene`, exact-node assertions, a `NO_SCENE` test |

Second opinion: codex gpt-6-astra/xhigh, adversarial plan critique. (agy gemini was tried first and rejected the model/effort pairing.)

## Open questions (resolved by lead with the recommended defaults; user may override)

1. **Screenshots:** deferred; the headless editor can't render, so it would be untestable in v0.
2. **If A1 fails:** ship slice 4 with a manual smoke test and record the gap.
3. **`.mcp.json` path:** absolute `/home/buck/...` path for now (single-developer setup); make it portable when a second machine appears.

## Not verified

- `dotnet build` (blocked on the runtime), A1–A4, Bun's `detached` option on 1.4.3, and how Claude Code resolves the server's working directory.
- The game lane's C# build-and-run path can't be verified until the .NET 10 runtime is installed (on the operator list).

