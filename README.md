# godot-mcp

A Godot 4.7 editor plugin that serves the open editor as an MCP server, so Claude Code (or any MCP client) can read and change the live project: scenes, nodes, scripts (GDScript and C#), project settings, asset imports, headless runs and .NET builds. Node edits go through the editor's undo history.

The addon in `addons/godot_mcp/` is the product. It serves Streamable HTTP at `http://127.0.0.1:<port>/mcp` and needs nothing else installed.

## Requirements

- Godot 4.7 (the .NET build for the C# tools: `create_dotnet_project`, `build_dotnet`, `.cs` scripts)
- Linux or macOS (the generated Claude Code entry uses a POSIX shell `headersHelper`)
- Claude Code with HTTP MCP servers

## Install the addon

From your Godot project's root, take the latest version from the default branch:

```sh
curl -fsSL https://github.com/voidrot/godot-mcp/archive/HEAD.tar.gz \
  | tar -xz --strip-components=1 --wildcards '*/addons/godot_mcp/*'
```

This replaces `addons/godot_mcp/`. Run it again to update. Then enable **Godot MCP** under Project > Project Settings > Plugins. On first load the addon picks a port between 6550 and 6649, saves it as `godot_mcp/server/port`, and writes an access token to `.godot/godot_mcp/headers.json` (inside `.godot/`, so it stays out of version control).

## Connect Claude Code

In the editor, run Project > Tools > **MCP: install agent skill / show config**. It installs the agent skill into `.claude/skills/godot-mcp/` and shows the `.mcp.json` entry to paste into the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "godot-editor": {
      "type": "http",
      "url": "http://127.0.0.1:6550/mcp",
      "headersHelper": "cat '/abs/path/to/project/.godot/godot_mcp/headers.json'"
    }
  }
}
```

Use the port your project shows. Accept the trust dialog when Claude Code starts, then `claude mcp list` should show `godot-editor` connected. The editor must be running for the tools to respond.

## Tools

Project: `get_project_info`, `get_project_settings`, `set_project_setting`, `install_agent_skill`. Scenes and nodes: `get_scene_tree`, `open_scene`, `create_scene`, `save_scene`, `add_node`, `delete_node`, `move_node`, `get_node_properties`, `update_property`. Scripts: `read_script`, `create_script`, `edit_script`, `validate_script`. Jobs: `run_headless`, `import_assets`, `build_dotnet`, `create_dotnet_project`. Editor: `get_editor_log`, `play_scene`, `stop_scene`. `addons/godot_mcp/SKILL.md` documents each one, its values, errors and limits.

## Development

```sh
bun install
bun run check
```

`check` runs Biome, the TypeScript check and the tests, which drive a real `godot-mono --headless --editor`. The Bun stdio server in `src/` is the earlier v0 and is kept only as a test and conformance harness. Plans and design decisions are in `docs/plans/`.

## License

MIT
