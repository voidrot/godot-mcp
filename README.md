# godot-mcp

godot-mcp is a Godot 4.7 editor addon. It runs an MCP server inside the editor, so Claude Code or another MCP client works on the project that is open in front of you. Claude can read and change the live scene tree, scripts and project settings, import assets, and run the game headless or build a .NET project. Node edits go through the editor's undo history, so you can undo them like any other edit.

## What you can ask Claude to do

- "Add a Sprite2D under Player, set its texture to res://art/player.png, and save the scene."
- "Write a script for Enemy that moves toward the player, attach it, and check that it parses."
- "Run the main scene headless and tell me about any errors it prints."
- "Show me the editor log from the last run."
- "Set the physics ticks per second to 120 in project settings."
- "This project has no C# yet. Create the .NET project, add a Player.cs script, and build it."

## Requirements

- Godot 4.7. The test suite runs against Godot 4.7.2 (mono build).
- For C#: the .NET (mono) build of Godot, and `dotnet` on your PATH. `build_dotnet` runs `dotnet build`, and `create_dotnet_project` creates the project files.
- A program named `timeout` on your PATH for `run_headless` and `build_dotnet`, which run in a separate process. (`import_assets` runs inside the editor and does not need it.) The addon looks for that exact name, so it must be GNU `timeout`. Without it those two fail with `SPAWN_FAILED`.
- Linux or macOS. Setup refuses Windows, because the `.mcp.json` entry it writes uses a POSIX shell command. macOS does not ship GNU `timeout`. Install GNU coreutils, and make its unprefixed `timeout` (for Homebrew, the `gnubin` directory of the coreutils install) visible to the editor. A `gtimeout` name is not enough.
- Claude Code with HTTP MCP server support, or another MCP client that supports Streamable HTTP and custom headers.

## Install the addon

From your Godot project's root, run:

```sh
curl -fsSL https://github.com/voidrot/godot-mcp/archive/HEAD.tar.gz \
  | tar -xz --strip-components=1 --wildcards '*/addons/godot_mcp/*'
```

This downloads the latest version from the default branch and writes it into `addons/godot_mcp/`. Files with the same names are overwritten.

GNU tar (Linux) needs `--wildcards`. macOS's bsdtar rejects that flag, so on macOS leave it out:

```sh
curl -fsSL https://github.com/voidrot/godot-mcp/archive/HEAD.tar.gz \
  | tar -xz --strip-components=1 '*/addons/godot_mcp/*'
```

Then enable the plugin: Project > Project Settings > Plugins, and turn on **Godot MCP**. On first load the addon picks the first free port from 6550 to 6649 on 127.0.0.1 and saves it as `godot_mcp/server/port` in `project.godot`. It reuses that port from then on. Each time the plugin loads, it:

- Writes a new access token to `.godot/godot_mcp/headers.json`. The folder gets a `.gitignore` that ignores everything in it, so the token stays out of version control.
- Prints `godot_mcp: serving http://127.0.0.1:<port>/mcp` in the editor's Output panel.

To update, run the install command again, then reload the plugin or restart the editor. Run the setup menu item again (see Connect Claude Code, step 1) so the agent skill matches the new version.

## Connect Claude Code

1. Open the project in the editor and choose Project > Tools > **MCP: install agent skill / show config**. The dialog writes the agent skill to `.claude/skills/godot-mcp/SKILL.md` and shows the MCP entry. The **Copy** button copies it. Setup never writes `.mcp.json` for you.

2. Paste the entry into `.mcp.json` at the project root, creating the file if it does not exist. It looks like this, with the port your project uses:

   ```json
   {
     "mcpServers": {
       "godot-editor": {
         "type": "http",
         "url": "http://127.0.0.1:6550/mcp",
         "headersHelper": "cat '/abs/path/to/project/.godot/godot_mcp/headers.json'",
         "timeout": 600000
       }
     }
   }
   ```

   The `headersHelper` reads the current token from `headers.json` each time the client connects, so you never copy the token by hand.

3. Start Claude Code in the project and approve the `godot-editor` server when it asks. Then run:

   ```sh
   claude mcp list
   ```

   `godot-editor` should be listed as connected. If it is not, approve the server when Claude Code asks, then check again. The editor must be running for the tools to respond.

### Other MCP clients

Any client that speaks Streamable HTTP and can send a custom header can connect. Use:

- URL: `http://127.0.0.1:<port>/mcp`
- Header: `Authorization: Bearer <token>`, where the token is the value in `.godot/godot_mcp/headers.json`

The server accepts protocol versions 2025-11-25, 2025-06-18 and 2025-03-26. It answers with plain JSON and keeps no session between requests.

## Tools

Every tool is listed with its arguments and errors in `addons/godot_mcp/SKILL.md`, which the setup step copies into your project.

**Project**

- `get_project_info`: Project name, main scene, features, autoloads, the root .csproj, open and unsaved scenes, and whether a job is running (`jobActive`).
- `get_project_settings`: Read settings with their defaults.
- `set_project_setting`: Write a setting to `project.godot`. Settings under `editor/`, `editor_plugins/` and `godot_mcp/` are refused.
- `install_agent_skill`: Write the agent skill into the project and return the `.mcp.json` entry.
- `create_dotnet_project`: Create the root `.csproj` and `.sln` for a Godot .NET project.

**Scenes and nodes**

- `get_scene_tree`: List the edited scene's nodes.
- `open_scene`: Make a `.tscn` or `.scn` the edited scene.
- `create_scene`: Create a new `.tscn` with a root node of a given class, and open it.
- `save_scene`: Write the edited scene to its file.
- `add_node`: Add a node of a class, or an instance of a scene.
- `delete_node`: Delete a node and its children.
- `move_node`: Move a node under a new parent, or reorder it.
- `get_node_properties`: Read a node's editor-visible properties.
- `update_property`: Set one editor-visible property as one undoable action. `property` can also be `script` (attaches a script) or `name` (renames the node), and `rotation_degrees` sets the rotation in degrees.

**Scripts**

- `read_script`: Read a `.gd` or `.cs` file.
- `create_script`: Create a `.gd` or `.cs` file.
- `edit_script`: Replace one exact snippet, or the whole file, in a `.gd` or `.cs` file.
- `validate_script`: Check a `.gd` file for parse errors.

**Running and building**

- `run_headless`: Run the project, a scene or a script in a separate headless process, and return its output.
- `import_assets`: Rescan the project and import new or changed assets.
- `build_dotnet`: Build the project's `.csproj` with `dotnet build`.
- `play_scene`: Play a scene in the editor. Output is not captured.
- `stop_scene`: Stop the scene that is playing.
- `get_editor_log`: Read the editor's errors, warnings and printed output.

## How changes land

- Node edits change the open scene in the editor. Each one is a single undo step. They reach disk when Claude calls `save_scene`.
- `create_scene`, script writes, and `set_project_setting` write files immediately.
- `run_headless` reads files on disk, not the editor's state. Save the scene first, or the run uses the old content. Its result includes `unsavedScenes` when the editor has unsaved scenes.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Connection refused | The editor is closed, the plugin is disabled, or the URL port is wrong. Open the project, enable the plugin, and check the port in the editor's Output panel. |
| `cannot listen on 127.0.0.1:<port>` in the Output panel | Another program has the saved port. Stop that program. To pick a new port, remove `godot_mcp/server/port` from `project.godot`, reload the plugin, then run the setup menu item again and update `.mcp.json`. |
| `no free port in 6550-6649` | All 100 ports in the range are taken. Free one, or set `godot_mcp/server/port` to a port you choose. |
| 401 Unauthorized | The token changed. Each plugin load makes a new token, so a restart or reload invalidates the old one. Reconnect the client. Do not paste the token into a file by hand. |
| 403 Host not allowed, or 403 Origin not allowed | The `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. Any `Origin` header must be `http://127.0.0.1:<port>` or `http://localhost:<port>`; `https` origins are refused. Use `http://127.0.0.1:<port>/mcp` in the client URL. |
| Claude Code does not connect | The server is not approved yet. Approve it when Claude Code asks, then run `claude mcp list` to check. |
| 400 `Unsupported MCP-Protocol-Version` | The client asks for a protocol version the server does not accept. The server accepts 2025-11-25, 2025-06-18 and 2025-03-26. |
| Requests time out | Ordinary requests get 30 seconds on the server; a request that runs past that gets a 500 `execution budget` error. Long work belongs in `run_headless`, `import_assets` or `build_dotnet`, which take a `timeoutSec` argument and extend the budget to match. Setup sets the client's `timeout` to 600000 ms. |
| `PROJECT_BUSY` | A `run_headless`, `import_assets` or `build_dotnet` job is still running. Check `jobActive` in `get_project_info`, then retry. |
| `SPAWN_FAILED` mentioning `timeout` | GNU `timeout` is not on your PATH. See Requirements. |
| `UNSUPPORTED_PLATFORM` from setup | You are on Windows. Setup and `install_agent_skill` refuse it. |
| `FOREIGN_SKILL` from setup | `.claude/skills/godot-mcp/SKILL.md` exists and was not written by the addon. Delete it and run setup again, or call `install_agent_skill` with `overwrite` set to true. |
| `UNSAFE_PATH` from setup | The project path contains `${` or a control character, which the `.mcp.json` entry cannot carry. Move the project. |

## Security

The server listens only on 127.0.0.1, so other machines on your network cannot reach it. Every request must carry the bearer token from `.godot/godot_mcp/headers.json`. The token is 32 random bytes, and the plugin makes it owner-readable only.

The token is the only access control, and it is not a sandbox. Anything that can read the token can change your project and run its code. Some tools run project code directly: `run_headless` and `play_scene` run the game, `build_dotnet` runs MSBuild targets and analyzers, and `@tool` scripts run when the editor loads them. Use this server only with projects you trust, and only with clients you trust on your machine.

The script tools refuse to write or validate files under `addons/godot_mcp/` (`PROTECTED_PATH`). This guards against mistakes, not against a hostile client.

## Development

```sh
bun install
bun run check
```

`check` runs Biome, the TypeScript check, and the tests. The editor tests start a real `godot-mono --headless --editor` with the addon enabled. Set `GODOT_BIN` to use another binary. The Bun stdio server in `src/` is an earlier version kept as a test and conformance harness. Plans and design decisions are in `docs/plans/`.

## License

MIT. See [LICENSE](LICENSE).
