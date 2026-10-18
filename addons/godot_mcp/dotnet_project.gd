@tool
extends RefCounted

## File names and text for a new Godot .NET project, matching the editor's "Create C# solution"
## (GodotTools ProjectGenerator.GenGameProject, DotNetSolution.Save and GodotSharpDirs, 4.7.2).
## That action is private C# in GodotTools, so GDScript cannot call it.

const SOLUTION_CONFIGS := ["Debug", "ExportDebug", "ExportRelease"]
# Godot's own check is IdentifierUtils.SanitizeQualifiedIdentifier. This keeps its character rules but
# not its keyword (@-prefix) or 511-character handling.
static var _LETTER := RegEx.create_from_string("^[\\p{L}\\p{Nl}]$")
static var _CONTINUE := RegEx.create_from_string("^[\\p{Mn}\\p{Mc}\\p{Pc}\\p{Nd}]$")


# dotnet/project/assembly_name, else the project name with the characters that break assembly loading
# replaced (Path::get_csharp_project_name).
static func assembly_name() -> String:
	var name := String(ProjectSettings.get_setting("dotnet/project/assembly_name", ""))
	if name.is_empty():
		name = String(ProjectSettings.get_setting("application/config/name", "")).strip_edges()
		for bad in [":", "*", "?", "\"", "<", ">", "|", "/", "\\", ";", "'", "=", ","]:
			name = name.replace(bad, "-")
	if name.is_empty():
		name = "UnnamedProject"
	if name in ["GodotSharp", "GodotSharpEditor", "Godot.SourceGenerators"]:
		name += "_"
	return name


# The res:// folder for the .sln: dotnet/project/solution_directory, else the root. Empty when the
# setting points outside the project.
static func solution_dir() -> String:
	var dir := String(ProjectSettings.get_setting("dotnet/project/solution_directory", ""))
	if dir.is_empty():
		return "res://"
	if not dir.begins_with("res://"):
		dir = "res://" + dir
	dir = dir.simplify_path().trim_suffix("/")
	if dir.trim_prefix("res://").begins_with("..") or dir.trim_prefix("res://").contains("/.."):
		return ""
	return dir + "/" if dir != "res://" else dir


# "4.7.2", or "4.8.0-dev.5" for a numbered pre-release (build_assemblies.py).
static func sdk_version() -> String:
	var info := Engine.get_version_info()
	var version := "%d.%d.%d" % [info["major"], info["minor"], info["patch"]]
	var status: String = info["status"]
	if status == "stable":
		return version
	var digits := RegEx.create_from_string("\\d+$").search(status)
	if digits != null:
		status = status.left(digits.get_start()) + "." + digits.get_string()
	return version + "-" + status


static func csproj_text(name: String, target_framework: String) -> String:
	var text := '<Project Sdk="Godot.NET.Sdk/%s">\n' % sdk_version()
	text += "  <PropertyGroup>\n"
	text += "    <TargetFramework>%s</TargetFramework>\n" % target_framework
	# Non-gradle Android builds need .NET 9 to match the export template's jar libraries.
	text += "    <TargetFramework Condition=\" '$(GodotTargetPlatform)' == 'android' \">net9.0</TargetFramework>\n"
	text += "    <EnableDynamicLoading>true</EnableDynamicLoading>\n"
	var namespace_name := sanitized_namespace(name)
	if namespace_name != name:
		text += "    <RootNamespace>%s</RootNamespace>\n" % namespace_name
	text += "  </PropertyGroup>\n</Project>\n"
	return text


static func sanitized_namespace(name: String) -> String:
	var segments := PackedStringArray()
	for segment in name.split(".", true):
		var kept := ""
		for i in segment.length():
			var ch := segment[i]
			if _LETTER.search(ch) != null:
				kept += ch
			elif _CONTINUE.search(ch) != null and (not kept.is_empty() or ch == "_"):
				kept += ch
		segments.append(kept if not kept.is_empty() else "Empty")
	return ".".join(segments)


# `csproj_relative` is the csproj path from the solution folder, with / separators.
static func sln_text(name: String, guid: String, csproj_relative: String) -> String:
	var configs := ""
	var projects := ""
	for config: String in SOLUTION_CONFIGS:
		configs += "\t%s|Any CPU = %s|Any CPU\n" % [config, config]
		projects += "\t\t{%s}.%s|Any CPU.ActiveCfg = %s|Any CPU\n" % [guid, config, config]
		projects += "\t\t{%s}.%s|Any CPU.Build.0 = %s|Any CPU\n" % [guid, config, config]
	var text := "Microsoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio 2012\n"
	text += 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "%s", "%s", "{%s}"\nEndProject\n' % [name, csproj_relative.replace("/", "\\"), guid]
	text += "Global\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n" + configs + "\tEndGlobalSection\n"
	text += "\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\n" + projects + "\tEndGlobalSection\nEndGlobal\n"
	return text


static func new_guid() -> String:
	var bytes := Crypto.new().generate_random_bytes(16)
	# RFC 4122 version 4.
	bytes[6] = (bytes[6] & 0x0F) | 0x40
	bytes[8] = (bytes[8] & 0x3F) | 0x80
	var hex := bytes.hex_encode().to_upper()
	return "%s-%s-%s-%s-%s" % [hex.substr(0, 8), hex.substr(8, 4), hex.substr(12, 4), hex.substr(16, 4), hex.substr(20)]
