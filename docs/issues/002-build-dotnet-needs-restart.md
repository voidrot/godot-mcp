# 002: build_dotnet appears only after an editor restart

- **Project:** orbital-runtime (Godot 4.7.2 mono, .NET 10)
- **Status:** fixed (`fix(addon): always list build_dotnet so a new csproj needs no restart`)

## Goal

Add a root `.csproj` to a project with the editor open, then build it with `build_dotnet`.

## Gap

`build_dotnet` is registered once, when the tool list is built, and only if the project root holds exactly one csproj (`addons/godot_mcp/tools/job_tools.gd:67`). The server advertises `"listChanged": false` (`addons/godot_mcp/mcp_server.gd:152`). A csproj added later doesn't make the tool appear until the editor restarts, even though `get_project_info` already reports `dotnet.csproj` correctly.

## Workaround

Ran `dotnet build` from the shell. The output lands in `.godot/mono/temp/bin/Debug`, which the editor picked up.

## Proposed change

Pick one:

- **Always register `build_dotnet`** and check the csproj count when it's called. Zero gives `FILE_NOT_FOUND` and several give `AMBIGUOUS_MATCH`, as the handler already does (`job_tools.gd:119-128`). This is the smallest change.
- **Re-register on filesystem change** and send `notifications/tools/list_changed`, with `listChanged: true`. More work, and clients vary in how they handle it.

The first option is recommended.
