# 001: No way to create or edit C# scripts or the csproj

- **Project:** orbital-runtime (Godot 4.7.2 mono, .NET 10)
- **Status:** fixed

## Goal

Set up a .NET Godot project through the MCP: create the root `.csproj`, write a `.cs` script, build it, and attach it to a scene.

## Gap

- `create_script`, `edit_script` and `validate_script` accept only `.gd` paths (`addons/godot_mcp/tools/script_tools.gd:46-81`). `read_script` already reads `.cs`, so C# is half supported.
- Nothing creates the root `.csproj`. The editor's own "Create C# solution" action isn't exposed either.

## Workaround

Wrote `OrbitalRuntime.csproj` and `scripts/Main.cs` directly on disk, ran `dotnet build`, then attached the script with `update_property` `script`.

## Proposed change

- Let `create_script` and `edit_script` take `.cs` paths. For `.cs`, `create_script` writes a `partial class` named after the file, in the given namespace, extending `extends`. Diagnostics come from `build_dotnet` rather than the GDScript parser, so return none and say so.
- Add `create_dotnet_project` (no arguments, or an optional `targetFramework`). It runs the editor's C# solution generation for the current `dotnet/project/assembly_name` and returns the csproj path. It refuses when a root csproj already exists (`FILE_EXISTS`).
