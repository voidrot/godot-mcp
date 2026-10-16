# 004: create_script doesn't indent a .cs body

- **Project:** orbital-runtime (Godot 4.7.2 mono, .NET 10)
- **Status:** fixed (`fix(addon): indent a .cs body one level`). Four spaces per non-empty line, applied line by line, so multi-line string literals shift too; `.editorconfig` is not read.

## Goal

Create a C# script with `create_script` (`path: res://scripts/McpProbe.cs`, `extends: Node`, `content: public override void _Ready() => GD.Print("probe");`).

## Gap

The class body is written verbatim at column 0:

```csharp
public partial class McpProbe : Node
{
public override void _Ready() => GD.Print("probe");
}
```

It compiles, but it doesn't match the project's `.editorconfig` or normal C# layout. The `.gd` path has no such problem, because its body sits at the top level.

## Workaround

Pass `content` already indented by four spaces per line.

## Proposed change

For `.cs`, indent each non-empty line of `content` by one level (four spaces, or the project's `.editorconfig` `indent_size` for `*.cs`). Leave lines inside raw or verbatim string literals alone, or document that `content` is indented line by line.
